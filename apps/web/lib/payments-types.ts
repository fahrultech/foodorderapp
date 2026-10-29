/**
 * Web mirror of the API's PaymentStatus enum (apps/api/src/payments/
 * payment.entity.ts). `failed` is terminal for the row — a retry is a NEW
 * intent; `refunded` means the FULL captured amount came back (partial
 * refunds stay `succeeded` and carry `refundedCents` underneath).
 */
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';

/**
 * One payment attempt against an order, as `POST /payments`,
 * `POST /payments/:id/capture` and `GET /orders/:orderId/payments` return
 * it. Amounts are integer cents (server-snapshots of order.totalCents —
 * never client input). `clientSecret` only exists on the create response.
 */
export interface PaymentAttempt {
  id: string;
  orderId: string;
  /** Gateway adapter that handled it ('mock' today; 'stripe'/'xendit' later). */
  provider: string;
  status: PaymentStatus;
  amountCents: number;
  /** ISO 4217 code of the snapshot (single-currency deployment: IDR). */
  currency: string;
  providerRef: string | null;
  failureReason: string | null;
  succeededAt: string | null;
  /** Cumulative cents refunded against this row (0 while nothing came back). */
  refundedCents: number;
  refundedAt: string | null;
  createdAt: string;
}
