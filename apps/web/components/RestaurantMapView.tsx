'use client';

import dynamic from 'next/dynamic';
import type { PinnedRestaurant } from './RestaurantMap';

export type { PinnedRestaurant };

/**
 * Client boundary for the Leaflet map (session 70). Leaflet reads `window`
 * while its module is evaluated, so the real component must never be part of
 * the server render — `ssr: false` is only legal inside a Client Component,
 * hence this two-file split (page = server data fetch, this = lazy mount).
 * The skeleton keeps the layout stable while the map chunk streams in.
 */
const RestaurantMap = dynamic(() => import('./RestaurantMap'), {
  ssr: false,
  loading: () => (
    <div
      className="h-[420px] w-full animate-pulse rounded-2xl border border-stone-200 bg-stone-100 sm:h-[520px]"
      role="status"
      aria-busy="true"
    />
  ),
});

export default function RestaurantMapView(props: { restaurants: PinnedRestaurant[] }) {
  return <RestaurantMap {...props} />;
}
