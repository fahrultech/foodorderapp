'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth';
import { useFavorites } from '@/lib/favorites';
import { formatPrice } from '@/lib/api';
import type { FavoriteDish, MenuItem } from '@/lib/api';
import AddToCartButton from '@/components/AddToCartButton';
import FavoriteButton from '@/components/FavoriteButton';

/** Reshape an API favorite row into the cart component's MenuItem props. */
function toMenuItem(f: FavoriteDish): MenuItem {
  return {
    id: f.menuItemId,
    name: f.name,
    description: f.description,
    priceCents: f.priceCents,
    category: f.category,
    imageUrl: f.imageUrl,
    isAvailable: f.isAvailable,
    prepMinutes: f.prepMinutes,
    restaurantId: f.restaurantId,
    stock: f.stock ?? null,
  };
}

export default function FavoritesPage() {
  const { status, user } = useAuth();
  const { items, loaded, error, refresh } = useFavorites();
  const t = useTranslations('Favorites');
  const c = useTranslations('Common');
  const th = useTranslations('Header');
  const locale = useLocale();

  const pending = status === 'loading' || (status === 'signedIn' && !loaded);

  return (
    <section>
      <h1 className="text-2xl font-bold">
        {t('title')} <span aria-hidden>♥</span>
      </h1>

      {/* A failed load is NOT an empty list: tell the user why instead of
          rendering the "Nothing saved" card over stale/absent data. */}
      {status === 'signedIn' && !pending && error && (
        <div
          role="alert"
          data-testid="favorites-error"
          className="mt-8 rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center"
        >
          <p className="text-lg font-semibold text-rose-800">{t('loadError')}</p>
          <p className="mt-1 text-sm text-rose-700">{error}</p>
          <button
            onClick={() => void refresh()}
            className="mt-4 rounded-xl bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-800"
          >
            {c('retry')}
          </button>
        </div>
      )}

      {status === 'guest' && (
        <div className="mt-8 rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-10 text-center">
          <p className="text-lg font-semibold text-stone-700">{t('gateTitle')}</p>
          <p className="mt-1 text-sm text-stone-500">
            {t('gateBody')}
          </p>
          <Link
            href="/login?next=%2Ffavorites"
            className="mt-4 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {th('signIn')}
          </Link>
        </div>
      )}

      {pending && (
        <ul className="mt-8 space-y-3" aria-busy="true" aria-label={t('loadingAria')}>
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-24 rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </ul>
      )}

      {status === 'signedIn' && !pending && !error && items.length === 0 && (
        <div className="mt-8 rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-10 text-center">
          <p className="text-lg font-semibold text-stone-700">
            {user ? t('emptyWithName', { name: user.name }) : t('emptyNoName')}
          </p>
          <p className="mt-1 text-sm text-stone-500">
            {t('emptyBody')}
          </p>
          <Link
            href="/"
            className="mt-4 inline-block rounded-xl bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-700"
          >
            {t('browseCta')}
          </Link>
        </div>
      )}

      {status === 'signedIn' && !pending && items.length > 0 && (
        <ul className="mt-8 divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white">
          {items.map((f) => (
            <li key={f.menuItemId} className="flex items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold">{f.name}</h2>
                {f.description && (
                  <p className="mt-0.5 truncate text-sm text-stone-500">{f.description}</p>
                )}
                <p className="mt-1 text-sm">
                  <Link
                    href={`/restaurants/${f.restaurantId}`}
                    className="font-medium text-brand-600 hover:underline"
                  >
                    {f.restaurantName}
                  </Link>
                  <span className="text-stone-400">
                    {' '}
                    {t('savedOn', { date: new Date(f.favoritedAt).toLocaleDateString(locale) })}
                    {f.isAvailable ? '' : ` ${t('unavailable')}`}
                  </span>
                </p>
              </div>
              <div className="text-right">
                <p className="font-bold">{formatPrice(f.priceCents)}</p>
                <div className="mt-2 flex items-center justify-end gap-1">
                  <FavoriteButton menuItemId={f.menuItemId} />
                  <AddToCartButton
                    item={toMenuItem(f)}
                    restaurant={{ id: f.restaurantId, name: f.restaurantName }}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
