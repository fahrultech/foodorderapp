'use client';

import { useEffect, useRef } from 'react';
import { formatPrice } from '@/lib/api';
import type { SwitchRequest } from '@/lib/cart';

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
          Start a new cart?
        </h2>
        <p id="cart-switch-desc" className="mt-2 text-sm leading-relaxed text-stone-600">
          Your cart holds{' '}
          <strong>
            {currentCount} item{currentCount === 1 ? '' : 's'} from {currentRestaurantName}
          </strong>{' '}
          ({formatPrice(currentSubtotalCents)}). FoodOrder carts cover a single kitchen at a
          time, so adding <strong>{request.item.name}</strong> from{' '}
          <strong>{request.restaurant.name}</strong> would discard your current cart.
        </p>

        <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm">
          <p className="font-semibold text-stone-700">New cart would contain</p>
          <p className="mt-1 flex items-center justify-between">
            <span>
              1 × {request.item.name}
              <span className="text-stone-400"> · {request.restaurant.name}</span>
            </span>
            <span className="font-bold">{formatPrice(request.item.priceCents)}</span>
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            ref={keepBtnRef}
            onClick={onCancel}
            className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-100"
          >
            Keep current cart
          </button>
          <button
            onClick={onConfirm}
            className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700"
          >
            Replace cart
          </button>
        </div>
      </div>
    </div>
  );
}
