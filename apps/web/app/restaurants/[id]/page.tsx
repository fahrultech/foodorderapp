import { notFound } from 'next/navigation';
import { api, formatPrice } from '@/lib/api';
import MenuBrowser from '@/components/MenuBrowser';

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
    </div>
  );
}
