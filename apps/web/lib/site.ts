const DEFAULT_SITE_URL = 'http://localhost:3000';

/** Canonical public origin used by metadata routes and absolute SEO links. */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) return DEFAULT_SITE_URL;

  try {
    const url = new URL(configured);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_SITE_URL;
    return url.origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

export function absoluteSiteUrl(path = '/'): string {
  return new URL(path, `${siteUrl()}/`).toString();
}