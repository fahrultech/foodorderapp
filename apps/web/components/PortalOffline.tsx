'use client';

import { useTranslations } from 'next-intl';

/**
 * Client-side twin of `components/ApiOffline.tsx` (the storefront's
 * server-rendered offline card) for the authenticated portal surfaces —
 * kitchen display, driver inbox (session 91 states audit).
 *
 * Same doctrine, same `api-offline` testid: a network drop or a 5xx says
 * nothing about the DATA, so the page must NOT fall through to its empty
 * state ("No orders", "No deliveries") — it says "we couldn't reach the
 * servers" instead (EN/ID via `PortalStates`) and offers an in-page retry
 * (re-fetch, not a full reload — the auth context stays warm).
 */
export function PortalOffline({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('PortalStates');
  return (
    <div
      data-testid="api-offline"
      role="alert"
      className="mx-auto mt-6 max-w-lg rounded-2xl border border-amber-200 bg-amber-50 p-10 text-center"
    >
      <p className="text-2xl" aria-hidden>
        📡
      </p>
      <h2 className="mt-2 text-lg font-bold text-amber-900">{t('offlineTitle')}</h2>
      <p className="mt-1 text-sm text-amber-800">{t('offlineBody')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 rounded-xl bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-amber-700"
      >
        {t('retry')}
      </button>
    </div>
  );
}

/**
 * A FAILURE THAT ISN'T DOWNNESS (4xx, rejected token etc.): same lie
 * ban as PortalOffline — the empty state never renders over a failed
 * load — but the honest message here is the API's own error, plus retry.
 */
export function PortalLoadFailed({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const t = useTranslations('PortalStates');
  return (
    <div
      data-testid="portal-load-failed"
      role="alert"
      className="mx-auto mt-6 max-w-lg rounded-2xl border border-rose-200 bg-rose-50 p-10 text-center"
    >
      <p className="text-2xl" aria-hidden>
        ⚠️
      </p>
      <h2 className="mt-2 text-lg font-bold text-rose-900">{t('loadFailedTitle')}</h2>
      <p className="mt-1 text-sm text-rose-700">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 rounded-xl bg-rose-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-800"
      >
        {t('retry')}
      </button>
    </div>
  );
}
