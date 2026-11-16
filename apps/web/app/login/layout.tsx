import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

/**
 * Session 95: localized document <title> for the /login surface. The page
 * itself is a client component and cannot export metadata — this
 * pass-through layout (renders zero DOM) owns ONLY the <title>, per locale
 * (same pattern as session 93's portal title layouts).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Auth');
  return { title: t('titleSignIn') };
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
