import type { MetadataRoute } from 'next';
import { api } from '@/lib/api';
import { absoluteSiteUrl } from '@/lib/site';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [
    {
      url: absoluteSiteUrl('/'),
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      // Public storefront map (session 70) — static entry, crawlable even
      // while the API is down and the map itself renders a no-data state.
      url: absoluteSiteUrl('/map'),
      changeFrequency: 'weekly',
      priority: 0.9,
    },
  ];

  try {
    const { items } = await api.listRestaurants();
    entries.push(
      ...items.map((restaurant) => ({
        url: absoluteSiteUrl(`/restaurants/${restaurant.id}`),
        changeFrequency: 'weekly' as const,
        priority: 0.8,
      })),
    );
  } catch {
    // Keep the sitemap endpoint available during an API outage; the homepage
    // remains a valid discovery entry and a later crawl can pick up restaurants.
  }

  return entries;
}