import { expect, test } from '@playwright/test';

/**
 * Phase 5 "Restaurant open hours + auto isOpen" (session 68): the
 * storefront renders the SERVER-derived open status. With a weekly
 * schedule the pill follows the embedded `isOpenNow`; restaurants without
 * one fall back to the legacy manual toggle and show no schedule pill.
 *
 * Seed fixtures (apps/api/src/database/seed.ts):
 *   Warung Nusantara — 7 windows 07:00–23:00, zone Asia/Jakarta.
 *   Pasta Fresca — no schedule (manual fallback path).
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';

test('scheduled restaurant embeds its week and the pill matches the API truth', async ({
  page,
  request,
}) => {
  const list = await request.get(`${API}/restaurants?search=warung`);
  expect(list.ok()).toBeTruthy();
  const { items } = await list.json();
  const warung = items.find((r: any) => r.slug === 'warung-nusantara');
  expect(warung).toBeTruthy();
  expect(warung.hours).toHaveLength(7);
  expect(typeof warung.isOpenNow).toBe('boolean');

  const detail = await (await request.get(`${API}/restaurants/${warung.id}`)).json();
  expect(detail.timeZone).toBe('Asia/Jakarta');
  expect(detail.hours.map((h: any) => h.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(detail.hours[0]).toMatchObject({ opensAt: '07:00', closesAt: '23:00' });
  expect(detail.isOpenNow).toBe(warung.isOpenNow);

  await page.goto(`/restaurants/${warung.id}`);
  await expect(
    page.getByText(warung.isOpenNow ? 'Open now' : 'Closed right now', { exact: true }),
  ).toBeVisible();
  // Full-week schedule: the today line is always the same window.
  await expect(page.getByText('Today 07:00–23:00')).toBeVisible();
});

test('a weekday-closed restaurant says so, and unscheduled ones show no schedule UI', async ({
  page,
  request,
}) => {
  // Sushi-kan has no Monday row: on Mondays the schedule says closed today.
  const listJson = await (await request.get(`${API}/restaurants?search=sushi`)).json();
  const items = listJson.items ?? listJson;
  const sushi = items.find((r: any) => r.slug === 'sushi-kan');
  expect(sushi.hours).toHaveLength(6);
  expect(sushi.hours.map((h: any) => h.dayOfWeek)).not.toContain(1);

  // Pasta Fresca: no schedule rows at all -> legacy path, no pill rendered.
  const pastaJson = await (await request.get(`${API}/restaurants?search=pasta`)).json();
  const pastaItems = pastaJson.items ?? pastaJson;
  const pasta = pastaItems.find((r: any) => r.slug === 'pasta-fresca');
  expect(pasta.hours).toEqual([]);
  expect(pasta.isOpenNow).toBe(pasta.isOpen);

  await page.goto(`/restaurants/${pasta.id}`);
  await expect(page.getByText('Open now', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Closed right now', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Today \d{2}:/)).toHaveCount(0);
});
