import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

/**
 * Session 96: localized document <title> for the /favorites surface. The page
 * itself is a client component and cannot export metadata — this
 * pass-through layout (renders zero DOM) owns ONLY the <title>, per locale
 * (same pattern as session 93's portal title layouts).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Favorites');
  return { title: t('pageTitle') };
}

export default function FavoritesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
