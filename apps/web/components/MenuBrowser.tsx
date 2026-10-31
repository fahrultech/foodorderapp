'use client';

import { useMemo, useState } from 'react';
import type { MenuItem, Restaurant } from '@/lib/api';
import { formatPrice } from '@/lib/api';
import AddToCartButton from '@/components/AddToCartButton';
import FavoriteButton from '@/components/FavoriteButton';
import { useTranslations } from 'next-intl';

interface DishGroup {
  /** Original category position — keeps anchor ids stable while filtering. */
  anchorId: string;
  name: string;
  items: MenuItem[];
}

/** Case-insensitive match on dish name, description, and category. */
function matches(item: MenuItem, q: string): boolean {
  return (
    item.name.toLowerCase().includes(q) ||
    (item.description ?? '').toLowerCase().includes(q) ||
    (item.category ?? '').toLowerCase().includes(q)
  );
}

export default function MenuBrowser({ restaurant }: { restaurant: Restaurant }) {
  const t = useTranslations('Menu');
  const common = useTranslations('Common');
  const menu = useMemo(() => restaurant.menuItems ?? [], [restaurant]);
  const [query, setQuery] = useState('');

  // Group once by category (preserving menu order); filtering just hides items.
  const groups = useMemo<DishGroup[]>(() => {
    const byName = new Map<string, MenuItem[]>();
    for (const item of menu) {
      const cat = item.category || t('fallbackCategory');
      const bucket = byName.get(cat);
      if (bucket) bucket.push(item);
      else byName.set(cat, [item]);
    }
    return [...byName.entries()].map(([name, items], i) => ({
      anchorId: `cat-${i}`,
      name,
      items,
    }));
  }, [menu, t]);

  const q = query.trim().toLowerCase();
  const visible = q
    ? groups
        .map((g) => ({ ...g, items: g.items.filter((it) => matches(it, q)) }))
        .filter((g) => g.items.length > 0)
    : groups;
  const matchCount = q ? visible.reduce((n, g) => n + g.items.length, 0) : menu.length;

  return (
    <section className="mt-10">
      <div className="sticky top-[63px] z-10 -mx-4 mb-6 border-b border-stone-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="relative">
          <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400">
            🔍
          </span>
          <input
            id="menu-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchLabel')}
            className="w-full max-w-md rounded-xl border border-stone-300 bg-white py-2 pl-9 pr-16 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          {q && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs font-semibold text-stone-500 hover:bg-stone-100 hover:text-stone-800"
            >
              {t('clear')}
            </button>
          )}
        </div>
        <p aria-live="polite" className="mt-1 text-xs text-stone-500">
          {q
            ? t('matchCount', { count: matchCount, total: menu.length, query: query.trim() })
            : t('dishCount', { count: menu.length })}
        </p>
        {visible.length > 1 && (
          <nav aria-label={t('categoriesLabel')} className="mt-2 flex flex-wrap gap-2">
            {visible.map((g) => (
              <a
                key={g.anchorId}
                href={`#${g.anchorId}`}
                className="rounded-full border border-stone-300 bg-white px-3 py-1 text-xs font-medium text-stone-600 transition hover:border-brand-500 hover:text-brand-600"
              >
                {g.name}
              </a>
            ))}
          </nav>
        )}
      </div>

      {menu.length === 0 && (
        <p className="text-stone-500">{t('empty')}</p>
      )}
      {menu.length > 0 && visible.length === 0 && (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-10 text-center">
          <p className="text-lg font-semibold text-stone-700">{t('noMatchesTitle')}</p>
          <p className="mt-1 text-sm text-stone-500">
            {t('noMatchesBody')}
          </p>
          <button
            onClick={() => setQuery('')}
            className="mt-4 rounded-xl bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-stone-700"
          >
            {t('clearSearch')}
          </button>
        </div>
      )}

      <div className="space-y-10">
        {visible.map((g) => (
          <div key={g.anchorId} id={g.anchorId} className="scroll-mt-[172px]">
            <h2 className="mb-3 text-xl font-bold">{g.name}</h2>
            <div className="divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white">
              {g.items.map((item) => (
                <div key={item.id} className="flex items-center gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold">{item.name}</h3>
                    {item.description && (
                      <p className="mt-0.5 truncate text-sm text-stone-500">{item.description}</p>
                    )}
                    <p className="mt-1 text-sm text-stone-400">⏱ {common('minutes', { count: item.prepMinutes })}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold">{formatPrice(item.priceCents)}</p>
                    <div className="mt-2 flex items-center justify-end gap-1">
                      <FavoriteButton menuItemId={item.id} />
                      <AddToCartButton
                        item={item}
                        restaurant={{ id: restaurant.id, name: restaurant.name }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
