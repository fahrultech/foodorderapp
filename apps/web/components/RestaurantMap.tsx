'use client';

import Link from 'next/link';
import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet';
import { useTranslations } from 'next-intl';
import 'leaflet/dist/leaflet.css';
import type { LatLngBoundsExpression } from 'leaflet';

/**
 * Storefront map (docs/ROADMAP.md Phase 5 "Map view of restaurants", session 70).
 *
 * Client-only by design: Leaflet touches `window` at import time, so this
 * module is loaded through `next/dynamic` with `ssr: false` from
 * RestaurantMapView — never rendered directly on the server.
 *
 * Pins are `CircleMarker`s (SVG paths), not default image markers: no icon
 * asset URLs to rewrite through bundlers and no extra requests — the shape
 * is also what the Playwright suite counts on. Green = open now (server
 * derived `isOpenNow`, legacy `isOpen` fallback), grey = closed.
 */
export interface PinnedRestaurant {
  id: string;
  slug: string;
  name: string;
  cuisine: string | null;
  city: string | null;
  isOpen: boolean;
  isOpenNow?: boolean;
  latitude: number;
  longitude: number;
}

const OPEN_COLOR = '#059669'; // emerald-600
const CLOSED_COLOR = '#a8a29e'; // stone-400

export default function RestaurantMap({ restaurants }: { restaurants: PinnedRestaurant[] }) {
  const t = useTranslations('Map');

  // Fit the view to the pins; a single pin (or identical coordinates)
  // needs center+zoom instead — fitBounds on a degenerate box pins the
  // zoom at max and looks broken.
  const distinct = new Set(restaurants.map((r) => `${r.latitude},${r.longitude}`));
  const lats = restaurants.map((r) => r.latitude);
  const lngs = restaurants.map((r) => r.longitude);
  const bounds: LatLngBoundsExpression = [
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ];
  const single = distinct.size < 2;

  return (
    <div>
      <div className="overflow-hidden rounded-2xl border border-stone-200 shadow-sm">
        <MapContainer
          {...(single
            ? { center: [lats[0], lngs[0]] as [number, number], zoom: 14 }
            : { bounds, boundsOptions: { padding: [48, 48] as [number, number] } })}
          scrollWheelZoom={false}
          className="h-[420px] w-full sm:h-[520px]"
          aria-label={t('ariaLabel')}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {restaurants.map((r) => {
            const open = r.isOpenNow ?? r.isOpen;
            return (
              <CircleMarker
                key={r.id}
                center={[r.latitude, r.longitude]}
                radius={9}
                pathOptions={{
                  color: '#ffffff',
                  weight: 2,
                  fillColor: open ? OPEN_COLOR : CLOSED_COLOR,
                  fillOpacity: 0.95,
                }}
              >
                <Popup>
                  <div className="space-y-1 text-sm">
                    <p className="text-base font-bold">{r.name}</p>
                    <p className="text-stone-500">
                      {[r.cuisine, r.city].filter(Boolean).join(' · ')}
                    </p>
                    <p className="font-semibold" style={{ color: open ? OPEN_COLOR : CLOSED_COLOR }}>
                      {open ? t('openNow') : t('closedNow')}
                    </p>
                    <Link
                      href={`/restaurants/${r.id}`}
                      className="inline-block font-semibold text-brand-600 hover:underline"
                    >
                      {t('viewMenu')} →
                    </Link>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: OPEN_COLOR }} aria-hidden />
          {t('legendOpen')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: CLOSED_COLOR }} aria-hidden />
          {t('legendClosed')}
        </span>
        <span className="ml-auto">{t('attributionNote')}</span>
      </p>
    </div>
  );
}
