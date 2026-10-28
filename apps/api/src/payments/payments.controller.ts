import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { UuidParam } from '../common/uuid';
import {
  ApiError,
  PaymentResponse,
  PaymentRefundResponse,
} from '../common/swagger-response-models';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { UserRole } from '../users/user.entity';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator';
import { CurrentUser } from '../common/current-user.decorator';

/**
 * Payments REST surface (Phase 5 "payment abstraction"). Every route is
 * JWT-only — payment is by definition an authenticated action — and rides
 * the `payments` rate-limit bucket. The whole client input for paying is
 * an order id; amounts are server-snapshotted, never accepted.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Post()
  @RateLimit('payments')
  @UseGuards(RateLimitGuard, JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create (or replay) a payment intent for an order', description: 'Snapshots order.totalCents server-side and asks the configured gateway for an intent. Idempotent while an attempt is pending (the same row is returned, no second intent); a succeeded attempt makes this 409. A failed row is terminal — calling again starts a NEW attempt. Guest orders can be paid by any signed-in user; owned orders only by their owner (admins bypass, foreign orders 404).' })
  @ApiCreatedResponse({ type: PaymentResponse, description: 'Fresh intent: row + provider clientSecret. Replay of a live pending attempt: clientSecret null.' })
  @ApiError(400, 'orderId missing/not a UUID, or malformed body.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(404, 'Unknown order id, or an order belonging to someone else (existence not leaked).')
  @ApiError(409, 'ORDER_ALREADY_PAID / ORDER_NOT_PAYABLE (order past pending/confirmed) / ORDER_CANCELLED.')
  @ApiError(429, 'Payments rate limit exceeded; Retry-After header says when to retry.')
  @ApiError(502, 'PAYMENT_GATEWAY_ERROR — provider refused to create the intent (the row is recorded as failed).')
  async pay(@Body() dto: CreatePaymentDto, @CurrentUser() user: any) {
    const { payment, clientSecret } = await this.service.pay(dto.orderId, user);
    return { ...payment, clientSecret };
  }

  @Post(':id/capture')
  @HttpCode(200)
  @RateLimit('payments')
  @UseGuards(RateLimitGuard, JwtAuthGuard)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Capture a pending payment through the gateway', description: 'The mock settles synchronously (succeeded unless MOCK_PAY_GATEWAY_MODE=fail). Terminal states are idempotent-or-409: succeeded replays, failed answers PAYMENT_ALREADY_FAILED (start a new attempt), a cancelled order refuses capture. Amount comes from the snapshot — nothing capturable is client-supplied.' })
  @ApiOkResponse({ type: PaymentResponse })
  @ApiError(400, 'Malformed (non-UUID) payment id.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(404, 'Unknown payment id, or one paid by another user (existence not leaked).')
  @ApiError(409, 'PAYMENT_ALREADY_FAILED / ORDER_CANCELLED.')
  @ApiError(429, 'Payments rate limit exceeded.')
  capture(@UuidParam('id') id: string, @CurrentUser() user: any) {
    return this.service.capture(id, user);
  }

  @Post(':id/refund')
  @HttpCode(200)
  @RateLimit('payments')
  @UseGuards(RateLimitGuard, JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Refund a succeeded payment (ADMIN)', description: 'Partial or full. Omit amountCents to refund the remaining captured amount; partial refunds accumulate on the row (refundedCents) while the status stays succeeded — the exact full amount flips it to the terminal refunded. Pending/failed rows 409 (nothing to refund), a fully refunded row 409, an over-large amount 400, a provider without refund support 501, a provider decline 409 REFUND_DECLINED with the row untouched. Guarded by compare-and-set: two racing refunds cannot both land. Order status does NOT gate refunds — refunding the payment of a cancelled order is the normal case.' })
  @ApiOkResponse({ type: PaymentResponse, description: 'The payment row after the refund landed (refundedCents / refundedAt / status updated).' })
  @ApiError(400, 'Malformed (non-UUID) payment id, or INVALID_REFUND_AMOUNT (non-positive / over the refundable remainder).')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Caller is not ADMIN — refunds are an admin action.')
  @ApiError(404, 'Unknown payment id.')
  @ApiError(409, 'PAYMENT_NOT_CAPTURED / PAYMENT_ALREADY_FAILED / PAYMENT_ALREADY_REFUNDED / REFUND_DECLINED / REFUND_CONFLICT.')
  @ApiError(429, 'Payments rate limit exceeded.')
  @ApiError(501, 'REFUND_UNSUPPORTED — the configured gateway adapter cannot refund.')
  @ApiError(502, 'PAYMENT_GATEWAY_ERROR — the provider errored the refund; the row is unchanged.')
  refund(@UuidParam('id') id: string, @Body() dto: RefundPaymentDto, @CurrentUser() user: any) {
    return this.service.refund(id, user, dto.amountCents);
  }

  @Get(':id/refunds')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'Per-refund audit trail of a payment (ADMIN)', description: 'One row per LANDED refund, oldest first: amount, provider refund ref, running refundedCents after the row, and the acting admin (id + email snapshot from the token). Declined/errored attempts never appear — the trail records money that came back, and each row was written in the SAME transaction as the balance update it explains. Never-refunded payments read as an empty array.' })
  @ApiOkResponse({ type: [PaymentRefundResponse], description: 'Audit rows, oldest first. Empty for a payment that was never refunded.' })
  @ApiError(400, 'Malformed (non-UUID) payment id.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(403, 'Caller is not ADMIN — the refund audit trail is an admin view.')
  @ApiError(404, 'Unknown payment id.')
  listRefunds(@UuidParam('id') id: string, @CurrentUser() user: any) {
    return this.service.listRefunds(id, user);
  }
}

/**
 * Order-scoped payment history, mounted under /orders/{orderId}/… — kept in
 * its own controller so OrdersController (and its module wiring) stays
 * untouched; distinct path arity means no route shadowing.
 */
@ApiTags('payments')
@Controller('orders/:orderId/payments')
export class OrderPaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Get('')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiParam({ name: 'orderId', schema: { type: 'string', format: 'uuid' } })
  @ApiOperation({ summary: 'All payment attempts for one order (newest first)', description: 'Full history per order: failed retries included, amounts as snapped. Same access rules as POST /payments — owner, any authenticated user for guest orders, admin; foreign orders 404.' })
  @ApiOkResponse({ type: [PaymentResponse], description: 'All attempts for the order, newest first.' })
  @ApiError(400, 'Malformed (non-UUID) order id.')
  @ApiError(401, 'Missing/invalid/expired access token.')
  @ApiError(404, 'Unknown order id or an order belonging to another customer.')
  list(@UuidParam('orderId') orderId: string, @CurrentUser() user: any) {
    return this.service.listForOrder(orderId, user);
  }
}
