'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

/**
 * The generic offline-shell card (session 141 extraction from app/offline).
 * It is what the service worker serves when EVERY network path is dead
 * (browser cannot even reach the web server), and it stays the default view
 * of /offline for any URL that has no device-stored copy to show instead.
 *
 * Client-component status is deliberate: `OfflineRestoreIsland` SSRs this
 * exact tree on the server and may swap it client-side — the hydration
 * first-paint must be byte-identical, so the card itself must render on the
 * client too (next-intl `useTranslations` mirrors the server catalog).
 */
export default function OfflineCard() {
  const t = useTranslations('Offline');
  return (
    <div
      data-testid="offline-shell-card"
      className="mx-auto max-w-lg rounded-2xl border border-stone-200 bg-white p-10 text-center"
    >
      <p className="text-3xl" aria-hidden="true">
        📡
      </p>
      <h1 className="mt-3 text-2xl font-extrabold">{t('pageTitle')}</h1>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">{t('pageBody')}</p>
      <Link
        href="/cart"
        className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
      >
        {t('pageCta')}
      </Link>
    </div>
  );
}
