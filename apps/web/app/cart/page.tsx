'use client';

import Link from 'next/link';
import { useCart } from '@/lib/cart';
import { formatPrice } from '@/lib/api';

export default function CartPage() {
  const { lines, setQty, clear, subtotalCents, restaurantName, restaurantId } = useCart();

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-2xl">🛒</p>
        <h1 className="mt-2 text-xl font-bold">Your cart is empty</h1>
        <p className="mt-1 text-sm text-stone-500">Browse restaurants and add dishes to get started.</p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
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

      <div className="mt-6 divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white">
        {lines.map((l) => (
          <div key={l.menuItemId} className="flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{l.name}</p>
              <p className="text-sm text-stone-500">{formatPrice(l.priceCents)} each</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setQty(l.menuItemId, l.quantity - 1)}
                className="h-8 w-8 rounded-lg border border-stone-300 font-bold hover:bg-stone-100"
                aria-label="Decrease quantity"
              >
                −
              </button>
              <span className="w-6 text-center font-semibold">{l.quantity}</span>
              <button
                onClick={() => setQty(l.menuItemId, l.quantity + 1)}
                className="h-8 w-8 rounded-lg border border-stone-300 font-bold hover:bg-stone-100"
                aria-label="Increase quantity"
              >
                +
              </button>
            </div>
            <p className="w-20 text-right font-bold">{formatPrice(l.priceCents * l.quantity)}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between rounded-2xl border border-stone-200 bg-white p-4">
        <p className="text-sm text-stone-500">
          Subtotal <span className="mx-1">·</span> delivery fee added at checkout
        </p>
        <p className="text-xl font-extrabold">{formatPrice(subtotalCents)}</p>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <button onClick={clear} className="text-sm font-medium text-stone-500 hover:text-red-600">
          Clear cart
        </button>
        <Link
          href={`/checkout?restaurant=${restaurantId ?? ''}`}
          className="rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Checkout →
        </Link>
      </div>
    </div>
  );
}
