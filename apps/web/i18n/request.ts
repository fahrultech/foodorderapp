import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

export const locales = ['en', 'id'] as const;
export type AppLocale = (typeof locales)[number];
export const defaultLocale: AppLocale = 'en';

export function isAppLocale(value: string | undefined): value is AppLocale {
  return locales.includes(value as AppLocale);
}

export default getRequestConfig(async () => {
  const store = await cookies();
  const requested = store.get('locale')?.value;
  const locale = isAppLocale(requested) ? requested : defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
