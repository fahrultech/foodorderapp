'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, formatPrice, type PaymentAttempt } from '@/lib/api';
import { authedCall } from '@/lib/authed-call';
import { useAuth } from '@/lib/auth';
import PayButton from './PayButton';

/**
 * Payment status card for the order receipt page (Phase 5 "web pay button":
 * "consume intent/capture endpoints; receipt shows payment status").
 *
 * The whole surface is JWT-gated server-side, so:
 * - signed-out visitors get a sign-in hint (guest orders are payable by any
 *   signed-in account — that is the API's receipt-link rule, mirrored here
 *   only as copy, not as client logic);
 * - signed-in users pull GET /orders/:id/payments and the card derives its
 *   view from THAT truth: a `succeeded` row (partial refunds ride inside)
 *   is the paid receipt; no succeeded row on a still-payable order shows
 *   the PayButton; anything else says honestly why payment is unavailable.
 *
 * Every rejection path (404 foreign order, 409 not-payable, 429 rate
 * bucket) is surfaced verbatim from the API error envelope by PayButton —
 * the client never re-implements (or second-guesses) server money rules.
 */
export default function PaymentPanel({
  orderId,
  orderStatus,
  totalCents,
  highlight = false,
}: {
  orderId: string;
  orderStatus: string;
  totalCents: number;
  /** Checkout redirected with ?pay=1 — visually elevate the pay affordance. */
  highlight?: boolean;
}) {
  const { status, getAccessToken, logout } = useAuth();
  const [rows, setRows] = useState<PaymentAttempt[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (status !== 'signedIn') return;
    let active = true;
    setRows(null);
    setLoadError(null);
    authedCall(getAccessToken, logout, (t) => api.listOrderPayments(t, orderId)).then(
      (res) => {
        if (!active) return;
        if (res.ok) setRows(res.data);
        else if (res.kind === 'error') setLoadError(res.message);
        // signedOut: authedCall already cleared the session; the signed-out
        // branch below renders as soon as `status` flips.
      },
    );
    return () => {
      active = false;
    };
  }, [status, orderId, reloadKey, getAccessToken, logout]);

  const payable = orderStatus === 'pending' || orderStatus === 'confirmed';
  const paid = rows?.find((r) => r.status === 'succeeded') ?? null;
  const fullyRefunded = rows?.some((r) => r.status === 'refunded') ?? false;
  const failedCount = rows?.filter((r) => r.status === 'failed').length ?? 0;
  const pendingAttempt = rows?.find((r) => r.status === 'pending') ?? null;

  return (
    <div
      data-testid="payment-panel"
      className={`mt-6 rounded-2xl border bg-white p-5 ${
        highlight && !paid
          ? 'border-emerald-400 ring-2 ring-emerald-100'
          : 'border-stone-200'
      }`}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="font-bold">Payment</h2>
        <span className="text-sm text-stone-500">{formatPrice(totalCents)}</span>
      </div>

      {status === 'loading' && (
        <p className="mt-2 text-sm text-stone-500" data-testid="payment-loading">
          Loading payment status…
        </p>
      )}

      {status === 'guest' && (
        <p className="mt-2 text-sm text-stone-600" data-testid="payment-signin-hint">
          {payable ? (
            <>
              <Link href="/login" className="font-semibold text-brand-600 hover:underline">
                Sign in
              </Link>{' '}
              to pay for this order — guest orders can be paid from any account.
            </>
          ) : (
            'Sign in to view this order’s payment history.'
          )}
        </p>
      )}

      {status === 'signedIn' && loadError && (
        <p
          role="alert"
          className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
          data-testid="payment-load-error"
        >
          {loadError}{' '}
          <button onClick={reload} className="underline font-semibold">
            Retry
          </button>
        </p>
      )}

      {status === 'signedIn' && !loadError && rows === null && (
        <p className="mt-2 text-sm text-stone-500" data-testid="payment-loading">
          Loading payment status…
        </p>
      )}

      {status === 'signedIn' && rows !== null && paid && (
        <div className="mt-2" data-testid="payment-paid">
          <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
            Paid — {formatPrice(paid.amountCents)} via {paid.provider}
            {paid.succeededAt ? ` · ${new Date(paid.succeededAt).toLocaleString()}` : ''}
          </p>
          {paid.refundedCents > 0 && (
            <p className="mt-1 text-xs text-stone-600" data-testid="payment-partial-refund">
              {formatPrice(paid.refundedCents)} refunded
              {paid.refundedAt ? ` on ${new Date(paid.refundedAt).toLocaleString()}` : ''} —
              {formatPrice(paid.amountCents - paid.refundedCents)} remains captured.
            </p>
          )}
        </div>
      )}

      {status === 'signedIn' && rows !== null && !paid && payable && (
        <div data-testid="payment-unpaid">
          <p className="mt-1 text-sm text-stone-600">
            {highlight
              ? 'Complete your payment to finish checkout.'
              : 'No successful payment recorded for this order yet.'}
          </p>
          {pendingAttempt && (
            <p className="mt-1 text-xs text-stone-500" data-testid="payment-pending-note">
              A previous attempt is still open ({formatPrice(pendingAttempt.amountCents)}); paying
              again resumes it — no second charge is created.
            </p>
          )}
          {failedCount > 0 && (
            <p className="mt-1 text-xs text-stone-500" data-testid="payment-failed-count">
              {failedCount} failed attempt{failedCount > 1 ? 's' : ''} on record — retrying starts a
              fresh one.
            </p>
          )}
          <PayButton orderId={orderId} totalCents={totalCents} onPaid={reload} onUnavailable={reload} />
        </div>
      )}

      {status === 'signedIn' && rows !== null && !paid && !payable && (
        <p className="mt-2 text-sm text-stone-600" data-testid="payment-unavailable">
          {fullyRefunded
            ? 'The payment for this order was fully refunded.'
            : 'This order can no longer be paid'}
          {` (status: ${orderStatus}).`}
        </p>
      )}
    </div>
  );
}
