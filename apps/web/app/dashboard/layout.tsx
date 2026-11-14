import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

/**
 * Session 93: localized document <title> for the /dashboard inbox surface. The page
 * itself is a client component and cannot export metadata — this pass-through
 * layout (renders zero DOM) owns ONLY the <title>, per locale, via the shared
 * Portal namespace.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Portal');
  return { title: t('titleDashboard') };
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
