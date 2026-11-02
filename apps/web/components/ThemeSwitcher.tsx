'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';

export type AppTheme = 'light' | 'dark';

export default function ThemeSwitcher({
  theme,
  changeThemeAction,
}: {
  theme: AppTheme;
  changeThemeAction: (theme: AppTheme) => Promise<void>;
}) {
  const t = useTranslations('ThemeSwitcher');
  const [pending, startTransition] = useTransition();
  const nextTheme: AppTheme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      aria-label={theme === 'dark' ? t('useLight') : t('useDark')}
      aria-pressed={theme === 'dark'}
      disabled={pending}
      onClick={() => startTransition(() => void changeThemeAction(nextTheme))}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-base transition hover:border-brand-500 disabled:cursor-wait disabled:opacity-60"
    >
      <span aria-hidden>{theme === 'dark' ? '☀️' : '🌙'}</span>
    </button>
  );
}
