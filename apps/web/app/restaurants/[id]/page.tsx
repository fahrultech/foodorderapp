import { notFound } from 'next/navigation';
import { api, formatPrice } from '@/lib/api';
import type { RestaurantReviewsPage } from '@/lib/api';
import MenuBrowser from '@/components/MenuBrowser';
import Stars from '@/components/Stars';

export const dynamic = 'force-dynamic';

export default async function RestaurantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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

  return (
    <div>
      <a href="/" className="text-sm font-medium text-brand-600 hover:underline">
        ← All restaurants
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
              {restaurant.ratingCount > 0 ? ` · ${restaurant.ratingCount} review${restaurant.ratingCount === 1 ? '' : 's'}` : ''}
            </span>
            <span className="rounded-full bg-stone-100 px-3 py-1">⏱ ~{restaurant.avgPrepMinutes} min</span>
            <span className="rounded-full bg-stone-100 px-3 py-1">
              🛵 {formatPrice(restaurant.deliveryFeeCents)} delivery
            </span>
            <span className="rounded-full bg-stone-100 px-3 py-1">
              Min order {formatPrice(restaurant.minOrderCents)}
            </span>
          </div>
        </div>
      </section>

      <MenuBrowser restaurant={restaurant} />

      <section className="mt-8 rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-bold">Recent reviews</h2>
        {!reviews || reviews.total === 0 ? (
          <p className="mt-2 text-sm text-stone-500">
            No reviews yet — the {restaurant.rating.toFixed(1)}★ score is our platform baseline
            until diners rate their orders.
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
                Showing {reviews.items.length} of {reviews.total} reviews.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
