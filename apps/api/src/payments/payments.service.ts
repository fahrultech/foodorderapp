import {
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Payment, PaymentStatus } from './payment.entity';
import { PaymentRefund } from './payment-refund.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { verifyReceiptAccessToken } from '../orders/receipt-access';
import {
  CreatedIntent,
  PAYMENT_GATEWAY,
  PaymentGateway,
  RefundResult,
  supportsRefunds,
} from './payment-gateway.interface';
import { AppException } from '../common/app-exception';
import { attributeRequestRestaurant } from '../common/metrics/restaurant-attribution';
import { isUuid } from '../common/uuid';
import { UserRole } from '../users/user.entity';

/** What the callers of this service are allowed to be: any authenticated user. */
export interface PaymentActor {
  sub: string;
  role: UserRole;
  /** From the verified JWT; snapshotted onto refund audit rows. */
  email?: string;
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
    @InjectRepository(PaymentRefund) private readonly refunds: Repository<PaymentRefund>,
    // Magic-link rung (Phase 15 #3): optional so every pre-rung unit harness
    // keeps constructing with 4 args — with no readable secret the rung is
    // INERT (every token DENIES), the same belt-and-braces shape as
    // OrdersService.receiptSecret() (session 133). DI always provides it.
    private readonly config?: ConfigService,
  ) {}

  /**
   * JWT_SECRET as visible to THIS service — the receipt tokens are minted
   * under it (receipt-access via order-notifications). Anything that is not
   * a readable string leaves the magic-link rung inert, never a 500
   * (session-84 non-5xx doctrine; same helper shape as OrdersService).
   */
  private receiptSecret(): string | undefined {
    try {
      const raw =
        typeof this.config?.get === 'function'
          ? this.config.get<string>('JWT' + '_SECRET')
          : undefined;
      return typeof raw === 'string' && raw ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Create (or replay) a payment intent for an order.
   * Access (one ladder, shared with capture/list so they can never drift):
   * - BEARER: the order's owner, any authenticated user for GUEST orders
   *   (the session-38 receipt-link payer rule), or ADMIN. Foreign orders 404.
   * - MAGIC LINK (`?rt=`, Phase 15 #3, no bearer): a valid receipt token
   *   pays a GUEST order only (order.userId IS NULL) — the capability tier
   *   decision: the token is the email recipient's own checkout proof, and
   *   guest orders are already payable by any authenticated account, so a
   *   72h HMAC bound to this exact order is a NARROWER grant than the
   *   existing rung. Orders owned by an account stay bearer-only there:
   *   mailbox access must never become money access on an account.
   * - NEITHER: 401 'Missing bearer token' (identical guard-era baseline —
   *   anonymous callers without a presented capability are not money actors).
   * Every rt denial (junk, foreign, expired, non-guest order) is the SAME
   * 404 as an unknown order id — session 133/135's canonical no-oracle
   * baseline, extended to the money rung.
   */
  async pay(
    orderId: string,
    actor: PaymentActor | null,
    rt?: string,
  ): Promise<PaymentInitiation> {
    const order = await this.getOrderForPayment(orderId, actor, rt);
    // EXPLICIT order-centric attribution (session 125, Phase 8): POST /payments
    // addresses the restaurant one join away (order.restaurantId) and its
    // matched template has no restaurant param. Stamped once the access
    // ladder passed — foreign-order 404s (getOrderForActor throws BEFORE
    // returning) are never attributed, keeping the no-existence-leak stance
    // intact in the owner's traffic view too. The already-paid/not-payable
    // 409s below DO top up an existing bucket (minting stays 2xx-only).
    attributeRequestRestaurant(order.restaurantId);

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
      // Magic-link payments carry NO payer id — the rt token itself is the
      // authority, and capture is gated by re-presenting it (the column is
      // nullable by design: SET NULL on user deletion).
      userId: actor?.sub ?? null,
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
        customerRef: actor?.sub ?? null,
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
  async capture(
    paymentId: string,
    actor: PaymentActor | null,
    rt?: string,
  ): Promise<Payment> {
    const payment = await this.getVisiblePayment(paymentId, actor, rt);

    if (payment.status === PaymentStatus.SUCCEEDED) return payment; // idempotent
    if (payment.status === PaymentStatus.REFUNDED) {
      // The money already came back — capturing a refunded intent again
      // would be double-charging through the same row.
      throw AppException.conflict(
        'PAYMENT_ALREADY_REFUNDED',
        'This payment was fully refunded — nothing left to capture',
        { paymentId: payment.id },
      );
    }
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

    const order = await this.orders.findOne({
      where: { id: payment.orderId },
      // Session 146 (Phase 17 eager audit): the capture ladder reads ONLY
      // order scalars (status gate, restaurantId attribution); plain
      // findOne rode the eager items join as TWO statements (distinct-ids
      // + batch fetch, probe-pinned) — opt-out answers ONE scalar SELECT.
      loadEagerRelations: false,
    });
    // EXPLICIT order-centric attribution (session 125, Phase 8): the capture
    // route addresses the restaurant through the payment's ORDER — stamped on
    // the normal path where the order row is already loaded for the
    // cancelled gate. The early replay/409 branches (succeeded, refunded,
    // failed, no-intent) never load the order and are NOT attributed:
    // attribution never invents an extra DB read for telemetry.
    attributeRequestRestaurant(order?.restaurantId);
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

  /** All payment attempts for one order (same access ladder as `pay`). */
  async listForOrder(
    orderId: string,
    actor: PaymentActor | null,
    rt?: string,
  ): Promise<Payment[]> {
    const order = await this.getOrderForPayment(orderId, actor, rt);
    // Receipt-read payment list: same join-away attribution as pay() above.
    attributeRequestRestaurant(order.restaurantId);
    return this.payments.find({
      where: { orderId: order.id },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Refund (partially or fully) a SUCCEEDED payment. ADMIN-only — the route
   * pins @Roles(ADMIN), the service re-checks so direct calls cannot skip it.
   *
   * Model: refunds accumulate on the SAME row (`refundedCents` grows;
   * `amountCents` is the untouchable captured snapshot). Partial → status
   * stays `succeeded` (money moved, some came back); the exact full amount →
   * terminal `refunded`. A declined refund never mutates the row — history
   * is never rewritten, matching the failed-attempt philosophy.
   *
   * Concurrency: the row is written with a compare-and-set on `refundedCents`
   * (UPDATE ... WHERE refundedCents = <read value>) IN THE SAME TRANSACTION as
   * the `payment_refunds` audit row (per-refund amount + provider refund ref
   * + acting admin). Two racing admins refunding the same payment cannot both
   * land — the loser gets 409 REFUND_CONFLICT and re-reads reality instead of
   * double-refunding.
   */
  async refund(
    paymentId: string,
    actor: PaymentActor,
    requestedCents?: number,
  ): Promise<Payment> {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can issue refunds');
    }
    if (!isUuid(paymentId)) throw new NotFoundException('Payment not found');
    const payment = await this.payments.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');

    switch (payment.status) {
      case PaymentStatus.PENDING:
        throw AppException.conflict(
          'PAYMENT_NOT_CAPTURED',
          'Nothing was captured yet — there is no money to refund',
          { paymentId: payment.id },
        );
      case PaymentStatus.FAILED:
        throw AppException.conflict(
          'PAYMENT_ALREADY_FAILED',
          'This payment failed — nothing was charged, nothing to refund',
          { paymentId: payment.id },
        );
      case PaymentStatus.REFUNDED:
        throw AppException.conflict(
          'PAYMENT_ALREADY_REFUNDED',
          'This payment is already fully refunded',
          { paymentId: payment.id },
        );
    }

    const remainingCents = payment.amountCents - payment.refundedCents;
    const amountCents = requestedCents ?? remainingCents;
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw AppException.badRequest(
        'INVALID_REFUND_AMOUNT',
        'Refund amount must be a positive integer of cents',
        { amountCents: requestedCents ?? null },
      );
    }
    if (amountCents > remainingCents) {
      throw AppException.badRequest(
        'INVALID_REFUND_AMOUNT',
        `Refund exceeds the refundable remainder of this payment`,
        { requestedCents: amountCents, remainingCents },
      );
    }

    if (!supportsRefunds(this.gateway)) {
      // Provider selected at deployment lacks refunds — honest 501, not a
      // silent partial-success and not a row mutation.
      throw new AppException(
        HttpStatus.NOT_IMPLEMENTED,
        'REFUND_UNSUPPORTED',
        `The payment provider '${this.gateway.id}' does not support refunds`,
        { provider: this.gateway.id },
      );
    }

    let result: RefundResult;
    try {
      result = await this.gateway.refundIntent({
        paymentId: payment.id,
        providerRef: payment.providerRef ?? '',
        amountCents,
        remainingCents,
        currency: payment.currency,
      });
    } catch (err) {
      throw new AppException(
        HttpStatus.BAD_GATEWAY,
        'PAYMENT_GATEWAY_ERROR',
        'The payment provider could not process the refund — nothing changed, retry',
        { provider: this.gateway.id, paymentId: payment.id, error: (err as Error).message },
      );
    }
    if (!result.succeeded) {
      throw AppException.conflict(
        'REFUND_DECLINED',
        'The payment provider declined the refund — the payment is unchanged',
        { paymentId: payment.id, reason: result.reason ?? 'declined' },
      );
    }

    const newRefundedCents = payment.refundedCents + amountCents;
    // CAS row update + audit row in ONE transaction: the balance and the
    // trail that explains it land together or not at all. (The provider has
    // already moved the money by this point — if the DB write throws, the
    // admin gets an error and the discrepancy is reconciled against the
    // provider, exactly like the REFUND_CONFLICT path above. What is never
    // acceptable is a landed refund with no audit row.)
    await this.payments.manager.transaction(async (em) => {
      const update = await em.getRepository(Payment).update(
        { id: payment.id, refundedCents: payment.refundedCents },
        {
          refundedCents: newRefundedCents,
          refundedAt: new Date(),
          // Full refund flips the terminal status; partial keeps `succeeded`.
          ...(newRefundedCents === payment.amountCents
            ? { status: PaymentStatus.REFUNDED }
            : {}),
        },
      );
      if (!update.affected) {
        throw AppException.conflict(
          'REFUND_CONFLICT',
          'This payment changed while the refund was in flight — re-read it and retry',
          { paymentId: payment.id },
        );
      }
      await em.getRepository(PaymentRefund).insert({
        paymentId: payment.id,
        provider: this.gateway.id,
        providerRefundRef: result.providerRefundRef ?? null,
        amountCents,
        refundedAfterCents: newRefundedCents,
        actingAdminId: actor.sub,
        actingAdminEmail: actor.email ?? null,
      });
    });
    const fresh = await this.payments.findOne({ where: { id: payment.id } });
    if (!fresh) throw new NotFoundException('Payment not found');
    return fresh;
  }

  /**
   * The per-refund audit trail of one payment, oldest first — ADMIN-only,
   * same two-door stance as `refund` (route pins @Roles(ADMIN); this guards
   * direct calls). Unknown/malformed payment ids 404 (existence is not
   * leaked even to admins reading a wrong id), and a payment that has never
   * been refunded reads as an empty trail, not an error.
   */
  async listRefunds(paymentId: string, actor: PaymentActor): Promise<PaymentRefund[]> {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can read the refund audit trail');
    }
    if (!isUuid(paymentId)) throw new NotFoundException('Payment not found');
    const payment = await this.payments.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    return this.refunds.find({
      where: { paymentId: payment.id },
      order: { createdAt: 'ASC' },
    });
  }

  // -----------------------------------------------------------------------
  // Access resolution — ONE ladder per surface, so pay/capture/list can
  // never drift apart (and a magic-link grant can never exist on one rung
  // but not its sibling).
  // -----------------------------------------------------------------------

  /**
   * Order ladder for pay + payment-list. `actor` is the verified bearer
   * (null on the anonymous arms); `rt` is the RAW presented token (the
   * PaymentAccessGuard admitted presence-only — this is where it is
   * verified, against the loaded row).
   *
   * rt arm order-of-mind: verify FIRST (pure, no DB), then the guest-order
   * tier check on the loaded row. A bearer arm behaves EXACTLY as before
   * this rung existed — rt is additive, never subtractive: a valid bearer
   * beside a junk rt still rides its own ladder (session 133's receipt
   * principle, ported to the money rung).
   */
  private async getOrderForPayment(
    orderId: string,
    actor: PaymentActor | null,
    rt?: string,
  ): Promise<Order> {
    if (!isUuid(orderId)) throw new NotFoundException('Order not found');
    const order = await this.orders.findOne({
      where: { id: orderId },
      // Session 146 (Phase 17 eager audit): every rung below reads ORDER
      // SCALARS only (userId gate, totalCents amount, code for the intent
      // description); plain findOne rode the eager items join (2 stmts,
      // probe-pinned) — opt-out answers ONE scalar SELECT, same response.
      loadEagerRelations: false,
    });
    if (!order) throw new NotFoundException('Order not found');
    if (actor) {
      // Bearer rung (unchanged): guest orders are payable by any
      // authenticated user; owned orders by the owner only; ADMIN bypasses.
      // Foreign orders 404 (no existence leak).
      const allowed =
        actor.role === UserRole.ADMIN ||
        order.userId === null ||
        order.userId === actor.sub;
      if (!allowed) throw new NotFoundException('Order not found');
      return order;
    }
    if (rt === undefined || rt === null) {
      // Nothing presented: the untouched session-47 money-actor baseline.
      throw new UnauthorizedException('Missing bearer token');
    }
    // Capability rung: an INVALID token answers the SAME canonical 404 as
    // an unknown id (session 135 baseline — the money rung must not drift
    // the shape). A VALID token pays GUEST orders only (capability tier:
    // see pay()'s doc block) — an owned order is the same 404 to the
    // mailbox-holder-without-bearer as to a stranger.
    if (!verifyReceiptAccessToken(rt, orderId, this.receiptSecret())) {
      throw new NotFoundException('Order not found');
    }
    if (order.userId !== null) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * Payment-row ladder for capture. Bearer: the PAYER owns the attempt,
   * ADMIN bypasses, foreign 404 (unchanged). Capability rung: the rt must
   * verify against the payment's ORDER id AND the row must be a
   * magic-link-created one (`userId IS NULL`) — an rt can only ever capture
   * what an rt paid for, never a row a signed-in account owns.
   */
  private async getVisiblePayment(
    paymentId: string,
    actor: PaymentActor | null,
    rt?: string,
  ): Promise<Payment> {
    if (!isUuid(paymentId)) throw new NotFoundException('Payment not found');
    const payment = await this.payments.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (actor) {
      // The PAYER owns the payment attempt; ADMIN bypasses. Foreign 404.
      if (actor.role !== UserRole.ADMIN && payment.userId !== actor.sub) {
        throw new NotFoundException('Payment not found');
      }
      return payment;
    }
    if (rt === undefined || rt === null) {
      throw new UnauthorizedException('Missing bearer token');
    }
    if (
      !verifyReceiptAccessToken(rt, payment.orderId, this.receiptSecret()) ||
      payment.userId !== null
    ) {
      throw new NotFoundException('Payment not found');
    }
    return payment;
  }
}
