import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Payment, PaymentStatus } from './payment.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import {
  CreatedIntent,
  PAYMENT_GATEWAY,
  PaymentGateway,
} from './payment-gateway.interface';
import { AppException } from '../common/app-exception';
import { isUuid } from '../common/uuid';
import { UserRole } from '../users/user.entity';

/** What the callers of this service are allowed to be: any authenticated user. */
export interface PaymentActor {
  sub: string;
  role: UserRole;
}

/** Order statuses that accept a new payment intent. */
const PAYABLE_ORDER_STATUSES: OrderStatus[] = [OrderStatus.PENDING, OrderStatus.CONFIRMED];

export interface PaymentInitiation {
  payment: Payment;
  /** Only on a FRESH intent; null when an existing pending row was replayed. */
  clientSecret: string | null;
}

/**
 * Payments over the `PaymentGateway` abstraction. The service is provider-
 * agnostic: it never imports the mock (that lives in the module's DI factory),
 * so a Stripe/Xendit adapter drops in behind `PAYMENT_PROVIDER` untouched.
 *
 * Money rule: the captured amount is ALWAYS the snapshot taken from
 * order.totalCents at intent creation. Clients never send an amount anywhere
 * in this module — `POST /payments` carries only an order id.
 *
 * Idempotency model (one payment row per ATTEMPT, providerRef unique):
 * - `pay()` on an order with a PENDING row replays that row (no second intent,
 *   no double charge possible); with a SUCCEEDED row it 409s (already paid).
 * - A FAILED row is terminal — the customer retries by calling `pay()` again,
 *   which creates a NEW row. History is never rewritten.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  /**
   * Create (or replay) a payment intent for an order.
   * Access: the order's owner, any authenticated user for GUEST orders (the
   * receipt-link payment path — payer is recorded on the row), or ADMIN for
   * anything. Foreign orders 404, never 403 — same no-existence-leak stance
   * as customer cancellation.
   */
  async pay(orderId: string, actor: PaymentActor): Promise<PaymentInitiation> {
    const order = await this.getOrderForActor(orderId, actor);

    // Row state is consulted BEFORE the order-status gate: "already paid" or
    // "there is a live attempt" describes reality better than the status of
    // the order itself (a paid order that moved on to preparing still reads
    // ORDER_ALREADY_PAID, not a misleading ORDER_NOT_PAYABLE).
    const rows = await this.payments.find({
      where: { orderId: order.id },
      order: { createdAt: 'DESC' },
    });
    if (rows.some((p) => p.status === PaymentStatus.SUCCEEDED)) {
      throw AppException.conflict(
        'ORDER_ALREADY_PAID',
        'This order already has a succeeded payment',
        { orderId: order.id },
      );
    }
    const pending = rows.find((p) => p.status === PaymentStatus.PENDING);
    if (pending) {
      // Replay the live attempt — creating a second intent for the same
      // order would let two captures both "succeed" against one bill.
      return { payment: pending, clientSecret: null };
    }

    // Only a NEW intent passes the payable-window gate.
    if (!PAYABLE_ORDER_STATUSES.includes(order.status)) {
      throw AppException.conflict(
        'ORDER_NOT_PAYABLE',
        `Order is ${order.status} — payments are accepted while pending or confirmed only`,
        { orderId: order.id, status: order.status },
      );
    }

    // Persist FIRST so the row exists even if the gateway call then explodes
    // (the failure gets recorded on the row, not swallowed). TypeORM's uuid
    // PK is client-generated at insert, so `saved.id` is available for the
    // intent immediately.
    const draft = this.payments.create({
      orderId: order.id,
      userId: actor.sub,
      provider: this.gateway.id,
      status: PaymentStatus.PENDING,
      amountCents: order.totalCents,
      currency: 'IDR',
    });
    const saved = await this.payments.save(draft);

    let intent: CreatedIntent;
    try {
      intent = await this.gateway.createIntent({
        paymentId: saved.id,
        orderId: order.id,
        orderCode: order.code,
        amountCents: saved.amountCents,
        currency: saved.currency,
        customerRef: actor.sub,
      });
    } catch (err) {
      saved.status = PaymentStatus.FAILED;
      saved.failureReason = `gateway_create_intent_failed: ${(err as Error).message}`;
      await this.payments.save(saved);
      throw new AppException(
        HttpStatus.BAD_GATEWAY,
        'PAYMENT_GATEWAY_ERROR',
        'The payment provider could not create the intent — please retry',
        { provider: this.gateway.id, paymentId: saved.id },
      );
    }

    saved.providerRef = intent.providerRef;
    const payment = await this.payments.save(saved);
    return { payment, clientSecret: intent.clientSecret ?? null };
  }

  /**
   * Capture a PENDING payment through the gateway. Terminal outcomes only
   * move forward: succeeded stays, failed stays, pending resolves once.
   * A cancelled order can no longer be paid — capture refuses it (409) even
   * if the pending row predates the cancellation.
   */
  async capture(paymentId: string, actor: PaymentActor): Promise<Payment> {
    const payment = await this.getVisiblePayment(paymentId, actor);

    if (payment.status === PaymentStatus.SUCCEEDED) return payment; // idempotent
    if (payment.status === PaymentStatus.FAILED) {
      throw AppException.conflict(
        'PAYMENT_ALREADY_FAILED',
        'This payment attempt failed — start a new one with POST /payments',
        { paymentId: payment.id },
      );
    }
    if (!payment.providerRef) {
      // Pending with no intent id: the intent never reached the provider.
      // Capture has nothing to settle; treat like the failed row it became
      // elsewhere (defensive — the pay() error path already marks FAILED).
      throw AppException.conflict(
        'PAYMENT_NO_INTENT',
        'This payment has no provider intent — start a new one with POST /payments',
        { paymentId: payment.id },
      );
    }

    const order = await this.orders.findOne({ where: { id: payment.orderId } });
    if (order?.status === OrderStatus.CANCELLED) {
      throw AppException.conflict(
        'ORDER_CANCELLED',
        'The order was cancelled — this payment can no longer be captured',
        { orderId: order.id, paymentId: payment.id },
      );
    }

    const result = await this.gateway.capture({
      paymentId: payment.id,
      providerRef: payment.providerRef,
      amountCents: payment.amountCents,
    });

    if (result.succeeded) {
      payment.status = PaymentStatus.SUCCEEDED;
      // Write-once, mirroring the order timeline rule.
      if (!payment.succeededAt) payment.succeededAt = new Date();
      payment.failureReason = null;
    } else {
      payment.status = PaymentStatus.FAILED;
      payment.failureReason = result.reason ?? 'declined';
    }
    return this.payments.save(payment);
  }

  /** All payment attempts for one order (same access rules as `pay`). */
  async listForOrder(orderId: string, actor: PaymentActor): Promise<Payment[]> {
    const order = await this.getOrderForActor(orderId, actor);
    return this.payments.find({
      where: { orderId: order.id },
      order: { createdAt: 'DESC' },
    });
  }

  // -----------------------------------------------------------------------
  // Access resolution — one place, so pay/list can never drift apart.
  // -----------------------------------------------------------------------

  private async getOrderForActor(orderId: string, actor: PaymentActor): Promise<Order> {
    if (!isUuid(orderId)) throw new NotFoundException('Order not found');
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    // Guest orders are payable by anyone authenticated; owned orders by the
    // owner only; ADMIN bypasses. Foreign orders 404 (no existence leak).
    const allowed =
      actor.role === UserRole.ADMIN ||
      order.userId === null ||
      order.userId === actor.sub;
    if (!allowed) throw new NotFoundException('Order not found');
    return order;
  }

  private async getVisiblePayment(paymentId: string, actor: PaymentActor): Promise<Payment> {
    if (!isUuid(paymentId)) throw new NotFoundException('Payment not found');
    const payment = await this.payments.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    // The PAYER owns the payment attempt; ADMIN bypasses. Foreign 404.
    if (actor.role !== UserRole.ADMIN && payment.userId !== actor.sub) {
      throw new NotFoundException('Payment not found');
    }
    return payment;
  }
}
