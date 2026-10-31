import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import './globals.css';
import { CartProvider } from '@/lib/cart';
import { AuthProvider } from '@/lib/auth';
import { FavoritesProvider } from '@/lib/favorites';
import { PushNotificationsProvider } from '@/lib/push-notifications';
import Header from '@/components/Header';
import type { AppLocale } from '@/i18n/request';
import { isAppLocale } from '@/i18n/request';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Metadata');
  return { title: t('title'), description: t('description') };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations('Footer');

  async function changeLocaleAction(nextLocale: AppLocale) {
    'use server';
    if (!isAppLocale(nextLocale)) return;
    const store = await cookies();
    store.set('locale', nextLocale, {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      httpOnly: true,
    });
  }

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <AuthProvider>
            <PushNotificationsProvider>
              <CartProvider>
                <FavoritesProvider>
                  <Header changeLocaleAction={changeLocaleAction} />
                  <main className="mx-auto max-w-6xl px-4 pb-24 pt-6">{children}</main>
                  <footer className="border-t border-stone-200 py-8 text-center text-sm text-stone-500">
                    {t('tagline')}
                  </footer>
                </FavoritesProvider>
              </CartProvider>
            </PushNotificationsProvider>
          </AuthProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
