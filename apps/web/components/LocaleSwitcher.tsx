'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import type { AppLocale } from '@/i18n/request';

export default function LocaleSwitcher({
  changeLocaleAction,
}: {
  changeLocaleAction: (locale: AppLocale) => Promise<void>;
}) {
  const locale = useLocale();
  const t = useTranslations('LocaleSwitcher');
  const [pending, startTransition] = useTransition();

  return (
    <div
      aria-label={t('label')}
      className="flex items-center rounded-full border border-stone-200 bg-stone-50 p-0.5 text-xs font-bold"
    >
      {(
        [
          ['en', 'EN', t('english')],
          ['id', 'ID', t('indonesian')],
        ] as const
      ).map(([value, shortLabel, accessibleLabel]) => (
        <button
          key={value}
          type="button"
          aria-label={accessibleLabel}
          aria-pressed={locale === value}
          disabled={pending || locale === value}
          onClick={() => startTransition(() => void changeLocaleAction(value))}
          className={`rounded-full px-2 py-1 transition disabled:cursor-default ${
            locale === value
              ? 'bg-white text-brand-700 shadow-sm'
              : 'text-stone-500 hover:text-stone-900 disabled:opacity-60'
          }`}
        >
          {shortLabel}
        </button>
      ))}
    </div>
  );
}
