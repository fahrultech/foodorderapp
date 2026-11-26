'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { loadCachedOrder, type CachedReceipt } from '@/lib/order-cache';
import ReceiptBody from '@/components/ReceiptBody';
import { PortalOffline } from '@/components/PortalOffline';

/**
 * Receipt offline restore (Phase 15). The server page renders this ONLY when
 * its own order read failed DOWN (network drop / 5xx) — a 4xx answer keeps
 * today's not-found card untouched, so the no-existence-oracle contract
 * (session 76) is preserved for denials.
 *
 * Two honest states, decided client-side (localStorage is invisible to SSR):
 * - a saved copy of THIS order id exists (persisted by the last live view via
 *   ReceiptBody) -> render the real receipt body plus an amber "saved copy"
 *   banner carrying the save time; never a silent stale lie.
 * - nothing saved -> the PortalOffline card (shared `api-offline` testid —
 *   the session-91 furniture: downness is never an empty state).
 *
 * Retry in both states is `router.refresh()`: the page is force-dynamic, so
 * refresh re-runs the exact server read that failed (same doctrine as the
 * storefront ApiOffline retryHref, in-page because auth/locale context must
 * stay warm). When the API answers again the server branch takes over and
 * this island is gone — the fresh read re-persists via ReceiptBody.
 */

function formatSavedAt(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'id' ? 'id-ID' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function CachedReceiptFallback({ orderId }: { orderId: string }) {
  const t = useTranslations('Order');
  const locale = useLocale();
  const router = useRouter();
  // SSR paints the honest "API unreachable, checking the device" card (NOT
  // the not-found title — the server branch already split down from denial);
  // the cache read is mount-only, so hydration cannot mismatch.
  const [receipt, setReceipt] = useState<CachedReceipt | null | undefined>(undefined);

  useEffect(() => {
    setReceipt(loadCachedOrder(orderId));
  }, [orderId]);

  if (receipt === undefined) {
    return (
      <div
        data-testid="receipt-offline-island"
        className="mx-auto mt-10 max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center"
      >
        <p className="text-3xl" aria-hidden="true">
          📡
        </p>
        <h1 className="mt-3 text-xl font-bold">{t('apiUnreachable')}</h1>
        <p className="mt-1 text-sm text-stone-500">{t('loading')}</p>
      </div>
    );
  }

  if (receipt === null) {
    return <PortalOffline onRetry={() => router.refresh()} />;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div
        role="status"
        data-testid="receipt-cached-banner"
        className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4"
      >
        <p className="text-sm font-bold text-amber-900">{t('cachedTitle')}</p>
        <p className="mt-1 text-sm text-amber-800">
          {t('cachedBody', { date: formatSavedAt(receipt.savedAt, locale) })}
        </p>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="mt-3 rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
        >
          {t('cachedRetry')}
        </button>
      </div>
      <div className="mt-6">
        <ReceiptBody order={receipt.order} offline />
      </div>
    </div>
  );
}
