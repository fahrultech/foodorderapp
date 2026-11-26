'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, formatPrice, type PaymentAttempt } from '@/lib/api';
import { authedCall } from '@/lib/authed-call';
import { fallbackMessage } from '@/lib/locale-strings';
import { useAuth } from '@/lib/auth';
import { useTranslations } from 'next-intl';
import PayButton from './PayButton';

/**
 * Payment status card for the order receipt page (Phase 5 "web pay button":
 * "consume intent/capture endpoints; receipt shows payment status").
 *
 * The money ladder (payments.service.ts) accepts a bearer OR the magic-link
 * `rt` capability (Phase 15 #3 — one-click pay from the order email, GUEST
 * orders only), so:
 * - signed-out visitors WITHOUT a receipt token get the sign-in hint;
 * - signed-out visitors who arrived through an emailed `?rt=` link transact
 *   on that same capability — the panel reads, pays and captures with no
 *   account, and the SERVER ladder is the authority: any denial (expired,
 *   foreign, owned order) surfaces as the API's own 404/401 message, never
 *   re-implemented here;
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
  receiptToken,
}: {
  orderId: string;
  orderStatus: string;
  totalCents: number;
  /** Checkout redirected with ?pay=1 — visually elevate the pay affordance. */
  highlight?: boolean;
  /** Emailed magic-link capability (Phase 15 #3): pays guest orders bearer-free. */
  receiptToken?: string;
}) {
  const { status, getAccessToken, logout } = useAuth();
  const t = useTranslations('Order');
  const th = useTranslations('Header');
  const [rows, setRows] = useState<PaymentAttempt[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [rtDenied, setRtDenied] = useState(false);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  // A 404 from the money rung is the TIER refusal (owned order / expired /
  // foreign token — the ladder's canonical shape), not a glitch: the honest
  // panel state is the session-43 sign-in hint, so the rt arm collapses to
  // no-rt on exactly that answer. Any other failure stays an error card.
  const magic = receiptToken != null && receiptToken !== '' && !rtDenied;

  useEffect(() => {
    if (status === 'signedIn') {
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
    }
    if (status === 'guest' && magic) {
      // The emailed receipt pays its own guest order: the list read rides
      // the SAME capability the page already unlocked the receipt with.
      let active = true;
      setRows(null);
      setLoadError(null);
      api
        .listOrderPayments(null, orderId, receiptToken)
        .then((r) => {
          if (active) setRows(r);
        })
        .catch((err) => {
          if (!active) return;
          if (err instanceof ApiError && err.status === 404) {
            setRtDenied(true);
            setRows(null);
            setLoadError(null);
            return;
          }
          setLoadError(
            err instanceof ApiError ? err.message : fallbackMessage('apiDown'),
          );
        });
      return () => {
        active = false;
      };
    }
    return undefined;
  }, [status, orderId, reloadKey, getAccessToken, logout, magic, receiptToken]);

  // rows-based branches render for signed-in users AND for magic-link
  // guests (the Phase 15 rung); a guest without the token keeps the hint.
  const showRows = status === 'signedIn' || (magic && status === 'guest');

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
        <h2 className="font-bold">{t('payTitle')}</h2>
        <span className="text-sm text-stone-500">{formatPrice(totalCents)}</span>
      </div>

      {status === 'loading' && (
        <p className="mt-2 text-sm text-stone-500" data-testid="payment-loading">
          {t('payLoading')}
        </p>
      )}

      {status === 'guest' && !magic && (
        <p className="mt-2 text-sm text-stone-600" data-testid="payment-signin-hint">
          {payable ? (
            <>
              <Link href="/login" className="font-semibold text-brand-600 hover:underline">
                {th('signIn')}
              </Link>{' '}
              {t('guestPayableTail')}
            </>
          ) : (
            t('guestLocked')
          )}
        </p>
      )}

      {showRows && loadError && (
        <p
          role="alert"
          className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
          data-testid="payment-load-error"
        >
          {loadError}{' '}
          <button onClick={reload} className="underline font-semibold">
            {t('retry')}
          </button>
        </p>
      )}

      {showRows && !loadError && rows === null && (
        <p className="mt-2 text-sm text-stone-500" data-testid="payment-loading">
          {t('payLoading')}
        </p>
      )}

      {showRows && rows !== null && paid && (
        <div className="mt-2" data-testid="payment-paid">
          <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
            {t('paidLine', { price: formatPrice(paid.amountCents), provider: paid.provider })}
            {paid.succeededAt ? ` · ${new Date(paid.succeededAt).toLocaleString()}` : ''}
          </p>
          {paid.refundedCents > 0 && (
            <p className="mt-1 text-xs text-stone-600" data-testid="payment-partial-refund">
              {t('refundedAmount', { price: formatPrice(paid.refundedCents) })}
              {paid.refundedAt
                ? t('refundedOn', { when: new Date(paid.refundedAt).toLocaleString() })
                : ''}
              {t('remainsCaptured', {
                price: formatPrice(paid.amountCents - paid.refundedCents),
              })}
            </p>
          )}
        </div>
      )}

      {showRows && rows !== null && !paid && payable && (
        <div data-testid="payment-unpaid">
          <p className="mt-1 text-sm text-stone-600">
            {highlight
              ? t('completePayment')
              : t('noPayment')}
          </p>
          {pendingAttempt && (
            <p className="mt-1 text-xs text-stone-500" data-testid="payment-pending-note">
              {t('pendingNote', { price: formatPrice(pendingAttempt.amountCents) })}
            </p>
          )}
          {failedCount > 0 && (
            <p className="mt-1 text-xs text-stone-500" data-testid="payment-failed-count">
              {t('failedAttempts', { count: failedCount })}
            </p>
          )}
          {magic && status === 'guest' && (
            <p className="mt-1 text-xs text-stone-500" data-testid="payment-rt-note">
              {t('rtPayNote')}
            </p>
          )}
          <PayButton
            orderId={orderId}
            totalCents={totalCents}
            onPaid={reload}
            onUnavailable={reload}
            receiptToken={status === 'guest' && magic ? receiptToken : undefined}
          />
        </div>
      )}

      {showRows && rows !== null && !paid && !payable && (
        <p className="mt-2 text-sm text-stone-600" data-testid="payment-unavailable">
          {fullyRefunded ? t('fullyRefunded') : t('noLongerPayable')}
          {t('statusSuffix', { status: orderStatus })}
        </p>
      )}
    </div>
  );
}
