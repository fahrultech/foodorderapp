import { notFound } from 'next/navigation';
import { api, formatPrice } from '@/lib/api';
import AddToCartButton from '@/components/AddToCartButton';

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

  const menu = restaurant.menuItems ?? [];
  const categories = [...new Set(menu.map((m) => m.category || 'Menu'))];

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

      <section className="mt-10 space-y-10">
        {categories.map((cat) => (
          <div key={cat}>
            <h2 className="mb-3 text-xl font-bold">{cat}</h2>
            <div className="divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white">
              {menu
                .filter((m) => (m.category || 'Menu') === cat)
                .map((item) => (
                  <div key={item.id} className="flex items-center gap-4 p-4">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold">{item.name}</h3>
                      {item.description && (
                        <p className="mt-0.5 truncate text-sm text-stone-500">{item.description}</p>
                      )}
                      <p className="mt-1 text-sm text-stone-400">⏱ {item.prepMinutes} min</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold">{formatPrice(item.priceCents)}</p>
                      <div className="mt-2">
                        <AddToCartButton
                          item={item}
                          restaurant={{ id: restaurant.id, name: restaurant.name }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ))}
        {menu.length === 0 && (
          <p className="text-stone-500">This restaurant has no menu items yet.</p>
        )}
      </section>
    </div>
  );
}
