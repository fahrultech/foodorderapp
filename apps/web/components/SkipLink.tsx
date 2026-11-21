'use client';

import { useTranslations } from 'next-intl';

/**
 * Session 117 (Phase 11 UX focus audit): keyboard/SR users must be able to
 * jump the header chrome in ONE Tab. The link is sr-only until it receives
 * focus (Tailwind `focus:not-sr-only`), then pins itself top-left with brand
 * contrast in both themes. Activation focuses #main-content programmatically
 * (tabIndex -1 on <main>) so document.activeElement moves deterministically —
 * fragment navigation alone is browser-dependent — and pins the scroll start
 * of the content region.
 */
export default function SkipLink() {
  const t = useTranslations('Common');

  function onActivate() {
    const main = document.getElementById('main-content');
    if (!main) return;
    main.focus();
    main.scrollIntoView({ block: 'start' });
  }

  return (
    <a
      href="#main-content"
      data-testid="skip-link"
      onClick={(event) => {
        event.preventDefault();
        onActivate();
      }}
      className="sr-only rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
    >
      {t('skipToContent')}
    </a>
  );
}
