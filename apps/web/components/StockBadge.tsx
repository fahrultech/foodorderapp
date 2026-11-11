'use client';

import { useTranslations } from 'next-intl';
import type { MenuItem } from '@/lib/api';

/**
 * Storefront stock badge (Phase 5, session 74): the API already carries
 * `menu_items.stock` (NULL = unlimited, session 71) on every menu read, so
 * this is a pure display layer over it. Two states, both derived strictly
 * from the server value — the ORDER is still validated server-side against
 * the live counter (409 INSUFFICIENT_STOCK), a stale badge can only look
 * optimistic, never oversell.
 */

/** Below this many tracked units a dish gets the "only N left" nudge. */
export const LOW_STOCK_LIMIT = 5;

/** Defensive: treats junk negatives like zero. NULL/undefined = unlimited. */
export function isSoldOut(item: Pick<MenuItem, 'stock'>): boolean {
  return item.stock !== null && item.stock !== undefined && item.stock <= 0;
}

export function isLowStock(item: Pick<MenuItem, 'stock'>): boolean {
  return (
    item.stock !== null &&
    item.stock !== undefined &&
    item.stock > 0 &&
    item.stock <= LOW_STOCK_LIMIT
  );
}

export default function StockBadge({ item }: { item: Pick<MenuItem, 'stock'> }) {
  const t = useTranslations('Menu');
  if (isSoldOut(item)) {
    return (
      <span
        data-testid="stock-sold-out"
        className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 align-middle text-[11px] font-bold uppercase tracking-wide text-rose-700"
      >
        {t('soldOutBadge')}
      </span>
    );
  }
  if (isLowStock(item)) {
    return (
      <span
        data-testid="stock-low"
        className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 align-middle text-[11px] font-bold text-amber-800"
      >
        {t('lowStockBadge', { count: item.stock as number })}
      </span>
    );
  }
  return null;
}
