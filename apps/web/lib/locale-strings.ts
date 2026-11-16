/**
 * Session 95 (storefront i18n sweep #3): locale-aware fallback strings for
 * lib/ modules that run OUTSIDE React (`authedCall` et al.) and therefore
 * cannot call `useTranslations`.
 *
 * The locale source of truth on the client is the SSR'd `<html lang>`
 * attribute (root layout renders `lang={locale}` from the `locale` cookie,
 * which is also what selects the message bundle) — so this helper can never
 * disagree with the surrounding React chrome, and no second cookie copy is
 * needed. Server/SSR context falls back to `en`, matching the default locale.
 *
 * EN values are byte-identical to the literals these modules carried before
 * (e2e pins read them through `favorites-error` etc.); ID wording matches
 * the Portal namespace's established `histErrApi*` translations.
 */
export type FallbackKey = 'apiDown' | 'apiDownShort';

const MESSAGES: Record<FallbackKey, Record<'en' | 'id', string>> = {
  apiDownShort: {
    en: 'Cannot reach the API.',
    id: 'Tidak dapat menghubungi API.',
  },
  apiDown: {
    en: 'Cannot reach the API. Is the server running?',
    id: 'Tidak dapat menghubungi API. Apakah server berjalan?',
  },
};

export function appLocale(): 'en' | 'id' {
  if (typeof document === 'undefined') return 'en';
  return document.documentElement.lang.startsWith('id') ? 'id' : 'en';
}

export function fallbackMessage(key: FallbackKey): string {
  return MESSAGES[key][appLocale()];
}
