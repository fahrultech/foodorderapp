import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function OfflinePage() {
  const t = await getTranslations('Offline');
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-stone-200 bg-white p-10 text-center">
      <p className="text-3xl" aria-hidden="true">
        📡
      </p>
      <h1 className="mt-3 text-2xl font-extrabold">{t('pageTitle')}</h1>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">
        {t('pageBody')}
      </p>
      <Link
        href="/cart"
        className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
      >
        {t('pageCta')}
      </Link>
    </div>
  );
}
