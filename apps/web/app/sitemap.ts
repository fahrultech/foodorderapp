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