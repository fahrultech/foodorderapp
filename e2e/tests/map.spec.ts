import { expect, test } from '@playwright/test';

/**
 * Phase 5 "Map view of restaurants (Leaflet)" (session 70): /map pins exactly
 * the restaurants whose API rows carry a VALID coordinate pair — an unmapped
 * restaurant is never a marker, only a counted note. Pins are CircleMarkers
 * (SVG `<path class="leaflet-interactive">`), so the DOM is countable without
 * tile/network dependencies.
 *
 * Seed fixtures (apps/api/src/database/seed.ts): 5 of 6 restaurants pinned;
 * Bowl House is the deliberate N/N pair (off the map).
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';

async function loadRestaurants(request: any) {
  const res = await request.get(`${API}/restaurants?limit=50`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).items as any[];
}

test('map pins exactly the coordinate-carrying restaurants and lists the off-map count', async ({
  page,
  request,
}) => {
  const items = await loadRestaurants(request);
  const pinned = items.filter(
    (r) => typeof r.latitude === 'number' && typeof r.longitude === 'number',
  );
  expect(pinned).toHaveLength(5);
  expect(items.filter((r) => r.latitude == null).map((r) => r.slug)).toEqual(['bowl-house']);

  await page.goto('/map');
  await expect(page.getByRole('heading', { name: 'Restaurants on the map' })).toBeVisible();
  await expect(page.getByText('5 places pinned on the map')).toBeVisible();

  const markers = page.locator('path.leaflet-interactive');
  await expect(markers).toHaveCount(5);

  // The accessible fallback list mirrors the pins...
  for (const r of pinned) {
    await expect(page.getByRole('link', { name: new RegExp(`^${r.name}`) })).toBeVisible();
  }
  // ...and contains NO off-map restaurant.
  await expect(page.getByRole('link', { name: /^Bowl House/ })).toHaveCount(0);
  await expect(
    page.getByText('1 more restaurant without a location (off the map)'),
  ).toBeVisible();
});

test('clicking Warung Nusantara\'s pin opens its popup and View menu reaches the detail page', async ({
  page,
  request,
}) => {
  const items = await loadRestaurants(request);
  const warung = items.find((r) => r.slug === 'warung-nusantara')!;
  expect(warung.latitude).not.toBeNull();

  await page.goto('/map');
  const markers = page.locator('path.leaflet-interactive');
  await expect(markers).toHaveCount(5);

  // DOM order == render order == the API's rating-DESC list FILTERED to
  // pinned restaurants, so the index within the pinned array is the marker
  // index. A dispatched bubbling DOM click resolves to the path element
  // itself (Leaflet maps e.target to its layer), unlike pointer hit-testing
  // which would land on whichever overlapping pin is topmost — the seeded
  // pins span three cities, so Jakarta's cluster overlaps px.
  const idx = items
    .filter((r: any) => typeof r.latitude === 'number' && typeof r.longitude === 'number')
    .findIndex((r: any) => r.slug === 'warung-nusantara');
  expect(idx).toBeGreaterThanOrEqual(0);
  await markers.nth(idx).evaluate((el) => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });

  const popup = page.locator('.leaflet-popup-content');
  await expect(popup).toBeVisible();
  await expect(popup.getByText('Warung Nusantara')).toBeVisible();
  await expect(popup.getByText(/Open now|Closed/)).toBeVisible();
  await popup.getByRole('link', { name: /View menu/ }).click();
  await expect(page).toHaveURL(new RegExp(`/restaurants/${warung.id}$`));
});
