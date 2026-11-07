import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { api, formatPrice } from '@/lib/api';
import type { RestaurantReviewsPage } from '@/lib/api';
import { todayWindow } from '@/lib/open-hours';
import MenuBrowser from '@/components/MenuBrowser';
import Stars from '@/components/Stars';
import { getTranslations } from 'next-intl/server';
import { absoluteSiteUrl } from '@/lib/site';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;

  try {
    const restaurant = await api.getRestaurant(id);
    const title = `${restaurant.name} — FoodOrder`;
    const description =
      restaurant.description ||
      `Order ${restaurant.cuisine ? `${restaurant.cuisine} food` : 'food'} from ${restaurant.name}${
        restaurant.city ? ` in ${restaurant.city}` : ''
      }.`;
    const url = absoluteSiteUrl(`/restaurants/${restaurant.id}`);

    return {
      title,
      description,
      alternates: { canonical: url },
      openGraph: {
        type: 'website',
        title,
        description,
        url,
        siteName: 'FoodOrder',
        images: restaurant.imageUrl
          ? [{ url: restaurant.imageUrl, alt: restaurant.name }]
          : undefined,
      },
      twitter: {
        card: restaurant.imageUrl ? 'summary_large_image' : 'summary',
        title,
        description,
        images: restaurant.imageUrl ? [restaurant.imageUrl] : undefined,
      },
    };
  } catch {
    return {
      title: 'Restaurant not found — FoodOrder',
      robots: { index: false, follow: false },
    };
  }
}

export default async function RestaurantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations('Restaurant');
  const common = await getTranslations('Common');
  let restaurant;
  try {
    restaurant = await api.getRestaurant(id);
  } catch {
    notFound();
  }
  // Review feed is best-effort: a page without reviews still renders (and the
  // rating shown is the server-recomputed one from the restaurant row).
  let reviews: RestaurantReviewsPage | null = null;
  try {
    reviews = await api.listRestaurantReviews(id, { limit: 10 });
  } catch {
    reviews = null;
  }

  // Open-hours display (session 68): the open/closed SIGNAL is the
  // server-derived `isOpenNow` (schedule when rows exist, legacy manual
  // toggle otherwise). Only the "today HH:MM-HH:MM" line is derived
  // client-side from the embedded schedule, in the restaurant's zone.
  const schedule = restaurant.hours ?? [];
  const hasSchedule = schedule.length > 0;
  const closedNow = (restaurant.isOpenNow ?? restaurant.isOpen) === false;
  const today = todayWindow(schedule, restaurant.timeZone);

  return (
    <div>
      <a href="/" className="text-sm font-medium text-brand-600 hover:underline">
        {t('allRestaurants')}
      </a>

      <section className="mt-4 flex flex-col gap-6 md:flex-row md:items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <div className="h-44 w-full shrink-0 overflow-hidden rounded-2xl bg-stone-200 md:w-72">
          {restaurant.imageUrl ? (
            <img src={restaurant.imageUrl} alt={restaurant.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-5xl">🍽️</div>
          )}
        </div>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">{restaurant.name}</h1>
          <p className="mt-1 text-sm text-stone-500">
            {[restaurant.cuisine, restaurant.city, restaurant.address].filter(Boolean).join(' · ')}
          </p>
          <p className="mt-3 max-w-xl text-sm text-stone-600">{restaurant.description}</p>
          <div className="mt-4 flex flex-wrap gap-4 text-sm">
            <span className="rounded-full bg-amber-100 px-3 py-1 font-bold text-amber-800">
              ★ {restaurant.rating.toFixed(1)}
              {restaurant.ratingCount > 0 ? ` · ${t('reviews', { count: restaurant.ratingCount })}` : ''}
            </span>
            {hasSchedule && (
              <span
                className={`rounded-full px-3 py-1 font-bold ${
                  closedNow
                    ? 'bg-red-100 text-red-800'
                    : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                {closedNow ? t('closedNow') : t('openNow')}
              </span>
            )}
            {today && (
              <span className="rounded-full bg-stone-100 px-3 py-1">
                🕐 {t('todayHours', { opensAt: today.opensAt, closesAt: today.closesAt })}
              </span>
            )}
            {hasSchedule && !today && (
              <span className="rounded-full bg-stone-100 px-3 py-1">🕐 {t('closedToday')}</span>
            )}
            <span className="rounded-full bg-stone-100 px-3 py-1">⏱ ~{common('minutes', { count: restaurant.avgPrepMinutes })}</span>
            <span className="rounded-full bg-stone-100 px-3 py-1">
              🛵 {common('delivery', { price: formatPrice(restaurant.deliveryFeeCents) })}
            </span>
            <span className="rounded-full bg-stone-100 px-3 py-1">
              {common('minimumOrder', { price: formatPrice(restaurant.minOrderCents) })}
            </span>
          </div>
        </div>
      </section>

      <MenuBrowser restaurant={restaurant} />

      <section className="mt-8 rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-bold">{t('recentReviews')}</h2>
        {!reviews || reviews.total === 0 ? (
          <p className="mt-2 text-sm text-stone-500">
            {t('noReviews', { rating: restaurant.rating.toFixed(1) })}
          </p>
        ) : (
          <>
            <ul className="mt-3 space-y-4">
              {reviews.items.map((r) => (
                <li key={r.id} className="border-b border-stone-100 pb-4 last:border-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-bold">{r.reviewerName}</span>
                    <time className="text-xs text-stone-400" dateTime={r.createdAt}>
                      {r.createdAt.slice(0, 10)}
                    </time>
                  </div>
                  <Stars rating={r.rating} className="text-sm" />
                  {r.comment && <p className="mt-1 text-sm text-stone-600">{r.comment}</p>}
                </li>
              ))}
            </ul>
            {reviews.total > reviews.items.length && (
              <p className="mt-3 text-xs text-stone-400">
                {t('showingReviews', { shown: reviews.items.length, total: reviews.total })}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
