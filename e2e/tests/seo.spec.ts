import { expect, test } from '@playwright/test';

const SITE_ORIGIN = 'http://localhost:3000';
const API_ORIGIN = 'http://localhost:4000/api';

test('publishes crawl controls, a restaurant sitemap, and restaurant-specific metadata', async ({
  page,
  request,
}) => {
  const listResponse = await request.get(`${API_ORIGIN}/restaurants`);
  expect(listResponse.ok()).toBeTruthy();
  const list = (await listResponse.json()) as {
    items: Array<{
      id: string;
      name: string;
      description: string | null;
      imageUrl: string | null;
    }>;
  };
  expect(list.items.length).toBeGreaterThan(0);

  const robotsResponse = await request.get('/robots.txt');
  expect(robotsResponse.ok()).toBeTruthy();
  const robots = await robotsResponse.text();
  expect(robots).toContain('User-Agent: *');
  expect(robots).toContain('Allow: /');
  expect(robots).toContain('Disallow: /dashboard');
  expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);

  const sitemapResponse = await request.get('/sitemap.xml');
  expect(sitemapResponse.ok()).toBeTruthy();
  const sitemap = await sitemapResponse.text();
  expect(sitemap).toContain(`<loc>${SITE_ORIGIN}/</loc>`);
  for (const restaurant of list.items) {
    expect(sitemap).toContain(
      `<loc>${SITE_ORIGIN}/restaurants/${restaurant.id}</loc>`,
    );
  }

  const restaurant = list.items[0];
  const restaurantUrl = `/restaurants/${restaurant.id}`;
  await page.goto(restaurantUrl);

  await expect(page).toHaveTitle(new RegExp(`^${restaurant.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (?:—|\\|) FoodOrder$`));
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    restaurant.description || /.+/,
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `${SITE_ORIGIN}${restaurantUrl}`,
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    new RegExp(restaurant.name),
  );
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    `${SITE_ORIGIN}${restaurantUrl}`,
  );
  if (restaurant.imageUrl) {
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      restaurant.imageUrl,
    );
  }
});
