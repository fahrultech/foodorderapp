import { getTranslations } from 'next-intl/server';

/**
 * The storefront's "our API is unreachable" card — deliberately DISTINCT
 * from the not-found page. A network drop or a 5xx says nothing about the
 * restaurant itself; answering 404 there would tell diners a perfectly
 * alive kitchen vanished (Phase 6 states audit). Localized via the
 * `Offline` namespace; `retryHref` re-runs the exact server render that
 * failed (force-dynamic pages re-fetch on every request).
 */
export default async function ApiOffline({ retryHref }: { retryHref?: string }) {
  const t = await getTranslations('Offline');
  return (
    <div
      data-testid="api-offline"
      className="mx-auto mt-10 max-w-lg rounded-2xl border border-amber-200 bg-amber-50 p-10 text-center"
    >
      <p className="text-2xl" aria-hidden>
        📡
      </p>
      <h2 className="mt-2 text-lg font-bold text-amber-900">{t('title')}</h2>
      <p className="mt-1 text-sm text-amber-800">{t('body')}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <a
          href={retryHref ?? '/'}
          className="rounded-xl bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-amber-700"
        >
          {t('retry')}
        </a>
        <a href="/" className="text-sm font-medium text-amber-800 underline-offset-2 hover:underline">
          {t('allRestaurants')}
        </a>
      </div>
    </div>
  );
}
