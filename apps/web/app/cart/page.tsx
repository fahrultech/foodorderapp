'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCart } from '@/lib/cart';
import { useIsCompactViewport } from '@/lib/use-compact-viewport';
import { formatPrice, optionRowLabels } from '@/lib/api';

/** Stepper buttons target 44×44 (WCAG 2.5.5 mobile minimum). */
const STEP_BTN =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-stone-300 text-lg font-bold leading-none hover:bg-stone-100';

export default function CartPage() {
  const { lines, setQty, clear, subtotalCents, restaurantName, restaurantId } = useCart();
  const [online, setOnline] = useState(true);
  // Phone-width only: a sticky bottom bar owns the subtotal + checkout CTA
  // so the primary action never scrolls away on a long cart (session 83).
  const compact = useIsCompactViewport();

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  const checkoutHref = `/checkout?restaurant=${restaurantId ?? ''}`;

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-2xl">🛒</p>
        <h1 className="mt-2 text-xl font-bold">Your cart is empty</h1>
        <p className="mt-1 text-sm text-stone-500">Browse restaurants and add dishes to get started.</p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Find food
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-extrabold">Your cart</h1>
      {restaurantName && <p className="mt-1 text-sm text-stone-500">From {restaurantName}</p>}
      {!online && (
        <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
          You are offline. Cart changes stay on this device; checkout needs a connection.
        </p>
      )}

      <div className="mt-6 divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white">
        {lines.map((l) => (
          // Stacked rows: at 360px a single flex row would leave ~56px for
          // the dish name once the steppers and price take their fixed
          // widths. Name+price share the top line; steppers get their own.
          <div key={l.lineKey} className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{l.name}</p>
                {l.options.length > 0 && (
                  <p className="mt-0.5 text-xs text-stone-500">
                    {optionRowLabels(l.options).join(' · ')}
                  </p>
                )}
                <p className="mt-0.5 text-sm text-stone-500">
                  {formatPrice(l.priceCents)} each
                  {l.options.length > 0 && (
                    <span className="text-stone-400"> · incl. options</span>
                  )}
                </p>
              </div>
              <p className="shrink-0 text-right font-bold">{formatPrice(l.priceCents * l.quantity)}</p>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => setQty(l.lineKey, l.quantity - 1)}
                className={STEP_BTN}
                aria-label="Decrease quantity"
              >
                −
              </button>
              <span className="w-8 text-center font-semibold">{l.quantity}</span>
              <button
                onClick={() => setQty(l.lineKey, l.quantity + 1)}
                className={STEP_BTN}
                aria-label="Increase quantity"
              >
                +
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop/tablet keeps the inline summary + actions; phones get the
          sticky bar below instead (rendered only when matchMedia says so,
          never hidden-but-present — see use-compact-viewport). */}
      <div className="mt-6 hidden items-center justify-between rounded-2xl border border-stone-200 bg-white p-4 sm:flex">
        <p className="text-sm text-stone-500">
          Subtotal <span className="mx-1">·</span> delivery fee added at checkout
        </p>
        <p className="text-xl font-extrabold">{formatPrice(subtotalCents)}</p>
      </div>

      <div className="mt-6 hidden items-center justify-between sm:flex">
        <button
          onClick={clear}
          className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-stone-500 hover:text-red-600"
        >
          Clear cart
        </button>
        <Link
          href={checkoutHref}
          className="inline-flex min-h-11 items-center rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Checkout →
        </Link>
      </div>

      {compact && (
        <div
          data-testid="mobile-cart-bar"
          className="sticky bottom-0 z-10 -mx-4 mt-6 flex items-center gap-3 border-t border-stone-200 bg-white/90 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur"
        >
          <button
            onClick={clear}
            className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-sm font-medium text-stone-500 hover:text-red-600"
          >
            Clear cart
          </button>
          <div className="ml-auto text-right">
            <p className="text-xs text-stone-500">Subtotal · fee at checkout</p>
            <p data-testid="mobile-cart-subtotal" className="text-lg font-extrabold leading-tight">
              {formatPrice(subtotalCents)}
            </p>
          </div>
          <Link
            href={checkoutHref}
            data-testid="mobile-checkout-cta"
            className="inline-flex min-h-11 shrink-0 items-center rounded-xl bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Checkout →
          </Link>
        </div>
      )}
    </div>
  );
}
