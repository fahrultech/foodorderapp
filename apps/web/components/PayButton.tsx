'use client';

import { useCallback, useState } from 'react';
import { api, ApiError, formatPrice } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * Pay button for a payable order (Phase 5 "web pay button").
 * One click = intent (POST /payments) + capture (POST /payments/:id/capture).
 * The mock gateway settles capture synchronously; a real provider adapter
 * drops in behind the same two endpoints without changing this component.
 *
 * Server rules the UI defers to (never re-implemented client-side):
 * amounts are order snapshots; a pending attempt is REPLAYED by POST
 * /payments (idempotent — no second intent, no double-charge); a failed row
 * is terminal and the next click starts a NEW attempt (that is exactly what
 * "Retry" does here); `ORDER_ALREADY_PAID` (409) means someone else settled
 * it — the parent refreshes history and the paid receipt replaces the
 * button.
 */
export default function PayButton({
  orderId,
  totalCents,
  onPaid,
  onUnavailable,
}: {
  orderId: string;
  totalCents: number;
  /** A succeeded capture landed — parent should refresh the order's payment history. */
  onPaid: () => void;
  /** Server says the order can never be paid from here (409 not-payable/cancelled): refresh or hide. */
  onUnavailable?: () => void;
}) {
  const { getAccessToken } = useAuth();
  const [stage, setStage] = useState<'idle' | 'intent' | 'capture'>('idle');
  const [error, setError] = useState<string | null>(null);

  const pay = useCallback(async () => {
    setError(null);
    const token = await getAccessToken();
    if (!token) {
      setError('Your session expired — sign in again to pay.');
      return;
    }
    try {
      setStage('intent');
      const intent = await api.createPayment(token, orderId);
      setStage('capture');
      if (intent.status === 'succeeded') {
        // Replay race: the attempt settled server-side already.
        onPaid();
        return;
      }
      const captured = await api.capturePayment(token, intent.id);
      if (captured.status === 'succeeded') {
        onPaid();
        return;
      }
      // pending (provider not settled — cannot happen with the mock) or a
      // status we don't render as paid: show the truth, keep retry available.
      setStage('idle');
      setError(
        captured.failureReason ??
          'The payment is not settled yet. Try again in a moment.',
      );
    } catch (err) {
      setStage('idle');
      if (err instanceof ApiError) {
        if (err.status === 409 && err.code === 'ORDER_ALREADY_PAID') {
          onPaid();
          return;
        }
        if (
          err.status === 409 &&
          (err.code === 'ORDER_NOT_PAYABLE' || err.code === 'ORDER_CANCELLED')
        ) {
          setError(err.message);
          onUnavailable?.();
          return;
        }
        if (err.status === 429) {
          setError('Too many payment attempts — wait a minute and retry.');
          return;
        }
        if (err.status === 502) {
          setError('The payment gateway refused the charge. You can retry.');
          return;
        }
        if (err.status === 404) {
          setError('This order cannot be paid from this account.');
          return;
        }
        setError(err.message);
      } else {
        setError('Cannot reach the API. Is the server running?');
      }
    }
  }, [getAccessToken, orderId, onPaid, onUnavailable]);

  return (
    <div className="mt-3" data-testid="pay-button-wrap">
      <button
        onClick={pay}
        disabled={stage !== 'idle'}
        data-testid="pay-button"
        className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:bg-stone-300"
      >
        {stage === 'intent'
          ? 'Contacting the payment gateway…'
          : stage === 'capture'
            ? 'Capturing payment…'
            : `Pay ${formatPrice(totalCents)}`}
      </button>
      {error && (
        <p
          role="alert"
          data-testid="pay-error"
          className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
        >
          {error}
        </p>
      )}
    </div>
  );
}
