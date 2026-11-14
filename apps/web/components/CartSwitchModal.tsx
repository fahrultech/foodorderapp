'use client';

import { useEffect, useRef } from 'react';
import { formatPrice, optionRowLabels } from '@/lib/api';
import { useTranslations } from 'next-intl';
import { optionsDeltaCents, type SwitchRequest } from '@/lib/cart';

interface Props {
  request: SwitchRequest | null;
  currentRestaurantName: string | null;
  currentCount: number;
  currentSubtotalCents: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation modal shown when the shopper adds a dish from a *different*
 * restaurant while the cart still holds another restaurant's items. The old
 * behavior silently wiped the cart; this dialog makes the switch explicit:
 * keep the current cart, or replace it with the one new item.
 */
export default function CartSwitchDialog({
  request,
  currentRestaurantName,
  currentCount,
  currentSubtotalCents,
  onConfirm,
  onCancel,
}: Props) {
  const t = useTranslations('Cart');
  const c = useTranslations('Common');
  const keepBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    keepBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [request, onCancel]);

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-stone-900/50 p-4 sm:items-center"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-switch-title"
        aria-describedby="cart-switch-desc"
        className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="cart-switch-title" className="text-lg font-extrabold">
          {t('switchTitle')}
        </h2>
        <p id="cart-switch-desc" className="mt-2 text-sm leading-relaxed text-stone-600">
          {t('switchHolds')}{' '}
          <strong>
            {t('switchHeldItems', { count: currentCount, name: currentRestaurantName ?? '' })}
          </strong>{' '}
          {t('switchKitchen', { price: formatPrice(currentSubtotalCents) })}{' '}
          <strong>{request.item.name}</strong> {t('switchFrom')}{' '}
          <strong>{request.restaurant.name}</strong> {t('switchDiscard')}
        </p>

        <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm">
          <p className="font-semibold text-stone-700">{t('switchNewTitle')}</p>
          <p className="mt-1 flex items-center justify-between">
            <span>
              {c('qtyLine', { count: '1', name: request.item.name })}
              <span className="text-stone-400"> · {request.restaurant.name}</span>
              {request.options && request.options.length > 0 && (
                <span className="block text-xs text-stone-500">
                  {optionRowLabels(request.options).join(' · ')}
                </span>
              )}
            </span>
            <span className="font-bold">
              {formatPrice(
                request.item.priceCents + optionsDeltaCents(request.options ?? []),
              )}
            </span>
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            ref={keepBtnRef}
            onClick={onCancel}
            className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-100"
          >
            {t('keepCart')}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700"
          >
            {t('replaceCart')}
          </button>
        </div>
      </div>
    </div>
  );
}
