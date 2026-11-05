import type { MetadataRoute } from 'next';
import { absoluteSiteUrl, siteUrl } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/addresses',
        '/admin',
        '/checkout',
        '/dashboard',
        '/driver',
        '/favorites',
        '/login',
        '/orders',
        '/register',
      ],
    },
    sitemap: absoluteSiteUrl('/sitemap.xml'),
    host: siteUrl(),
  };
}