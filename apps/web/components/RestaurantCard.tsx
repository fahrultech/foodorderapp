import Link from 'next/link';
import type { Restaurant } from '@/lib/api';
import { formatPrice } from '@/lib/api';

export default function RestaurantCard({ restaurant }: { restaurant: Restaurant }) {
  return (
    <Link
      href={`/restaurants/${restaurant.id}`}
      className="group overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="relative h-40 w-full overflow-hidden bg-stone-200">
        {restaurant.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={restaurant.imageUrl}
            alt={restaurant.name}
            className="h-full w-full object-cover transition group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl">🍽️</div>
        )}
        {!restaurant.isOpen && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm font-bold uppercase text-white">
            Closed
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-semibold text-lg leading-tight">{restaurant.name}</h2>
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
            ★ {restaurant.rating.toFixed(1)}
            {restaurant.ratingCount > 0 ? ` (${restaurant.ratingCount})` : ''}
          </span>
        </div>
        <p className="mt-1 text-sm text-stone-500">
          {[restaurant.cuisine, restaurant.city].filter(Boolean).join(' · ')}
        </p>
        <div className="mt-3 flex items-center gap-3 text-xs text-stone-500">
          <span>⏱ {restaurant.avgPrepMinutes} min</span>
          <span>🛵 {formatPrice(restaurant.deliveryFeeCents)} delivery</span>
          <span>Min {formatPrice(restaurant.minOrderCents)}</span>
        </div>
      </div>
    </Link>
  );
}
