import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import RestaurantMapView, { type PinnedRestaurant } from '@/components/RestaurantMapView';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Map');
  return { title: t('metaTitle'), description: t('metaDescription') };
}

/** The storefront map cap — the server page pulls one big page of restaurants. */
const MAP_LIMIT = 50;

export default async function MapPage() {
  const t = await getTranslations('Map');

  let items: Awaited<ReturnType<typeof api.listRestaurants>>['items'] = [];
  let total = 0;
  let apiDown = false;
  try {
    const list = await api.listRestaurants({ limit: MAP_LIMIT });
    items = list.items;
    total = list.total;
  } catch {
    apiDown = true;
  }

  // Only a VALID, COMPLETE pair earns a pin. The API guarantees the pair
  // rule, but the storefront map defends the render for legacy rows, raw
  // SQL writes and any future schema drift.
  const pinned: PinnedRestaurant[] = items
    .filter(
      (r): r is typeof r & { latitude: number; longitude: number } =>
        typeof r.latitude === 'number' &&
        Number.isFinite(r.latitude) &&
        typeof r.longitude === 'number' &&
        Number.isFinite(r.longitude) &&
        r.latitude >= -90 &&
        r.latitude <= 90 &&
        r.longitude >= -180 &&
        r.longitude <= 180,
    )
    .map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      cuisine: r.cuisine,
      city: r.city,
      isOpen: r.isOpen,
      isOpenNow: r.isOpenNow,
      latitude: r.latitude,
      longitude: r.longitude,
    }));

  return (
    <div>
      <section className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight">{t('title')}</h1>
        <p className="mt-2 text-stone-500">{t('subtitle')}</p>
      </section>

      {apiDown ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
          <p className="text-lg font-bold text-red-700">{t('apiDownTitle')}</p>
          <p className="mt-2 text-sm text-red-600">{t('apiDownBody')}</p>
        </div>
      ) : pinned.length === 0 ? (
        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-8 text-center text-stone-500">
          {t('noneMapped')}
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-stone-500">
            {t('placesOnMap', { count: pinned.length })}
            {total > items.length ? ` · ${t('showingFirst', { count: items.length, total })}` : ''}
          </p>
          <RestaurantMapView restaurants={pinned} />

          <section className="mt-8" aria-label={t('listAriaLabel')}>
            <h2 className="mb-3 text-lg font-bold">{t('listTitle')}</h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {pinned.map((r) => (
                <li key={r.id}>
                  <a
                    href={`/restaurants/${r.id}`}
                    className="flex items-center justify-between rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm shadow-sm transition hover:border-brand-300"
                  >
                    <span>
                      <span className="font-semibold">{r.name}</span>
                      <span className="ml-2 text-stone-500">{[r.cuisine, r.city].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span
                      className={`ml-3 shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        (r.isOpenNow ?? r.isOpen)
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-stone-100 text-stone-500'
                      }`}
                    >
                      {(r.isOpenNow ?? r.isOpen) ? t('openNow') : t('closedNow')}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            {items.length > pinned.length && (
              <p className="mt-3 text-xs text-stone-400">
                {t('unmappedHidden', { count: items.length - pinned.length })}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
