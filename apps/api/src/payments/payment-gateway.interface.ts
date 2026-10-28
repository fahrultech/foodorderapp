/**
 * The one interface every payment provider hides behind (Phase 5 "payment
 * abstraction"). `PaymentsService` depends ONLY on this shape + the DI token
 * below; it never knows or cares which adapter is installed. Swapping the
 * concrete gateway is a config decision (`PAYMENT_PROVIDER`), not a code
 * decision — see `PaymentsModule`'s factory.
 *
 * Two verbs because that is the minimal honest round-trip every real provider
 * needs (create an intent, then capture it):
 *   - Stripe: PaymentIntent create → confirm/capture.
 *   - Xendit: invoice/charge create → charge status settle.
 * Adapters landing later may ADD methods (webhook signature verification,
 * refunds) as separate optional interfaces — never by widening this one and
 * forcing every implementation to grow the same code.
 *
 * Amounts are integer cents end-to-end; the currency rides along because a
 * provider needs it at intent time, not because multi-currency ships today.
 */

export const PAYMENT_GATEWAY = 'PAYMENT_GATEWAY' as const;

export interface CreateIntentInput {
  /** Our row id — stable correlation key handed to the provider. */
  paymentId: string;
  orderId: string;
  orderCode: string;
  amountCents: number;
  currency: string;
  /** The authenticated payer's user id (audit/metadata only). */
  customerRef: string | null;
}

export interface CreatedIntent {
  /** Globally unique provider-side id for the intent/charge/invoice. */
  providerRef: string;
  /**
   * Opaque string a client-side SDK confirmation would need later (Stripe's
   * `client_secret`). The mock returns a deterministic stand-in — it carries
   * NO security meaning and exists to keep the response shape honest.
   */
  clientSecret?: string;
}

export interface CaptureInput {
  paymentId: string;
  providerRef: string;
  /** The recorded snapshot amount — the client never supplies an amount. */
  amountCents: number;
}

export interface CaptureResult {
  succeeded: boolean;
  /** Machine-readable decline reason when `succeeded` is false. */
  reason?: string;
}

export interface PaymentGateway {
  /** Adapter id; snapshotted onto every payment row (`payment.provider`). */
  readonly id: string;
  createIntent(input: CreateIntentInput): Promise<CreatedIntent>;
  capture(input: CaptureInput): Promise<CaptureResult>;
}

// ---------------------------------------------------------------------------
// REFUNDS — deliberately an ADD-ON interface, not part of `PaymentGateway`.
// Stripe/Xendit refund APIs are shaped differently and arrive later; forcing
// every adapter to stub `refundIntent` would be the "widen the core interface"
// mistake this file's header comment warns about. The service probes for the
// capability with `supportsRefunds()` and answers 501 when absent.
// ---------------------------------------------------------------------------

export interface RefundInput {
  paymentId: string;
  /** The captured provider intent being refunded (NOT a fresh id). */
  providerRef: string;
  /** This refund's amount — partial refunds repeat against one intent. */
  amountCents: number;
  /** What is left refundable on the intent (adapter-side sanity). */
  remainingCents: number;
  currency: string;
}

export interface RefundResult {
  succeeded: boolean;
  /** Provider-side refund id (Stripe `re_…`) when the refund landed. */
  providerRefundRef?: string;
  /** Machine-readable decline reason when `succeeded` is false. */
  reason?: string;
}

export interface PaymentRefundGateway {
  refundIntent(input: RefundInput): Promise<RefundResult>;
}

/** Capability probe — keeps `instanceof` out of DI-constructed singletons. */
export function supportsRefunds(
  gateway: PaymentGateway,
): gateway is PaymentGateway & PaymentRefundGateway {
  return typeof (gateway as Partial<PaymentRefundGateway>).refundIntent === 'function';
}
