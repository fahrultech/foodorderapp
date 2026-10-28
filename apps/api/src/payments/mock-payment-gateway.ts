import { Injectable } from '@nestjs/common';
import {
  CaptureInput,
  CaptureResult,
  CreatedIntent,
  CreateIntentInput,
  PaymentGateway,
  PaymentRefundGateway,
  RefundInput,
  RefundResult,
} from './payment-gateway.interface';

export const MOCK_GATEWAY_ID = 'mock';

/**
 * Pure env read: MOCK_PAY_GATEWAY_MODE=fail forces every capture to DECLINE.
 * The only failure knob the mock has — it exists so the full failed-payment
 * path (row → failed → retry creates a NEW row) can be exercised against a
 * live server, not just in unit tests. Anything else (unset, garbage, 'FAIL'
 * casing) means succeed: default-allowing is right for a dev-only adapter.
 */
export function resolveMockMode(env: NodeJS.ProcessEnv = process.env): 'succeed' | 'fail' {
  return String(env.MOCK_PAY_GATEWAY_MODE ?? '').toLowerCase() === 'fail' ? 'fail' : 'succeed';
}

/**
 * Refund-specific sibling of `resolveMockMode` (a SEPARATE knob on purpose:
 * the live smoke needs capture to succeed *and then* a declined refund —
 * one switch can drive both). Same default-allow semantics.
 */
export function resolveMockRefundMode(env: NodeJS.ProcessEnv = process.env): 'succeed' | 'fail' {
  return String(env.MOCK_REFUND_GATEWAY_MODE ?? '').toLowerCase() === 'fail' ? 'fail' : 'succeed';
}

/**
 * The default adapter — no network, no secrets, deterministic. It is a
 * faithful implementation of `PaymentGateway`, so anything written against
 * the interface works identically when a real Stripe/Xendit adapter is
 * swapped in via `PAYMENT_PROVIDER`. Refunds are implemented HERE (as the
 * optional `PaymentRefundGateway` add-on) so the refund path is exercisable
 * end-to-end before any real provider adapter exists.
 */
@Injectable()
export class MockPaymentGateway implements PaymentGateway, PaymentRefundGateway {
  readonly id = MOCK_GATEWAY_ID;

  async createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
    // Contract guard (the service already checks its copy of it): a real
    // provider rejects non-positive/float amounts too — adapters must not
    // silently normalize money, they must refuse it.
    assertPositiveCents(input.amountCents);
    return {
      // Deterministic and derived from OUR payment id: greppable in logs,
      // stable across retries of the same row, obviously fake in receipts.
      providerRef: `mock_pi_${input.paymentId}`,
      clientSecret: `mock_secret_${input.paymentId}`,
    };
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    assertPositiveCents(input.amountCents);
    if (resolveMockMode() === 'fail') {
      return { succeeded: false, reason: 'mock_declined' };
    }
    return { succeeded: true };
  }

  async refundIntent(input: RefundInput): Promise<RefundResult> {
    // Same money contract as the other verbs — refuse, never normalize.
    assertPositiveCents(input.amountCents);
    if (input.remainingCents < 0) {
      throw new TypeError(
        `MockPaymentGateway: remainingCents must never be negative, got ${input.remainingCents}`,
      );
    }
    if (resolveMockRefundMode() === 'fail') {
      return { succeeded: false, reason: 'mock_refund_declined' };
    }
    // Derived from paymentId + the refundable remainder BEFORE the refund +
    // the split size. The remainder makes EVERY refund of one intent distinct
    // — including two equal partials, which the old payment+size format
    // collided on. Collisions matter now that refs land in the audit ledger:
    // one landed refund must have exactly one provider refund id.
    return {
      succeeded: true,
      providerRefundRef: `mock_re_${input.paymentId}_${input.remainingCents}_${input.amountCents}`,
    };
  }
}

function assertPositiveCents(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new TypeError(
      `MockPaymentGateway: amountCents must be a positive integer of cents, got ${amountCents}`,
    );
  }
}
