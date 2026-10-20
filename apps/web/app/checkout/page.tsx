'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart';
import { api, formatPrice, Restaurant } from '@/lib/api';

/**
 * Live pricing pulled from GET /restaurants/:id — the same source the server
 * prices the order from (integer cents). Until it resolves we know the fee is
 * real, so "Place order" stays disabled; if the fetch fails we allow submit
 * and let the server-side validation be the authority.
 */
type PricingState = 'loading' | 'ready' | 'unavailable';

export default function CheckoutPage() {
  const router = useRouter();
  const { lines, subtotalCents, restaurantId, restaurantName, clear } = useCart();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [pricing, setPricing] = useState<PricingState>('loading');
  const [form, setForm] = useState({
    customerName: '',
    contactPhone: '',
    deliveryAddress: '',
    note: '',
  });

  useEffect(() => {
    if (!restaurantId) return;
    let active = true;
    setPricing('loading');
    api
      .getRestaurant(restaurantId)
      .then((r) => {
        if (!active) return;
        setRestaurant(r);
        setPricing('ready');
      })
      .catch(() => {
        if (active) setPricing('unavailable');
      });
    return () => {
      active = false;
    };
  }, [restaurantId]);

  if (lines.length === 0 || !restaurantId) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <h1 className="text-xl font-bold">Nothing to check out</h1>
        <p className="mt-1 text-sm text-stone-500">Add some dishes to your cart first.</p>
      </div>
    );
  }

  const deliveryFeeCents = pricing === 'ready' && restaurant ? restaurant.deliveryFeeCents : null;
  const minOrderCents = pricing === 'ready' && restaurant ? restaurant.minOrderCents : null;
  const totalCents = deliveryFeeCents === null ? null : subtotalCents + deliveryFeeCents;
  const belowMinimum = minOrderCents !== null && subtotalCents < minOrderCents;
  const missingCents = minOrderCents === null ? 0 : minOrderCents - subtotalCents;
  const pricingLoading = pricing === 'loading';
  // Gate submit on real pricing: loading blocks, unavailable (fetch failed)
  // falls through to server-side validation, below-minimum always blocks.
  const canSubmit = !pricingLoading && !belowMinimum && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!restaurantId || lines.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const order = await api.createOrder({
        restaurantId,
        items: lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })),
        customerName: form.customerName,
        contactPhone: form.contactPhone,
        deliveryAddress: form.deliveryAddress,
        note: form.note || undefined,
      });
      clear();
      router.push(`/orders/${order.id}?code=${order.code}`);
    } catch (err: any) {
      setError(err.message || 'Could not place the order');
      setSubmitting(false);
    }
  }

  const field =
    'w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  return (
    <div className="mx-auto grid max-w-4xl gap-8 md:grid-cols-2">
      <div>
        <h1 className="text-2xl font-extrabold">Checkout</h1>
        <form onSubmit={submit} className="mt-6 space-y-4">
          {belowMinimum && (
            <div
              role="alert"
              className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
            >
              {restaurantName ?? 'This restaurant'} has a minimum order of{' '}
              {formatPrice(minOrderCents!)}. Add {formatPrice(missingCents)} more to your cart to
              check out —{' '}
              <a className="underline" href="/cart">
                back to cart
              </a>
              .
            </div>
          )}
          {pricing === 'unavailable' && (
            <p className="rounded-xl bg-stone-100 px-4 py-3 text-sm text-stone-600">
              Couldn&apos;t load the delivery fee for this restaurant right now. You can still
              place the order — the fee and minimum will be applied server-side.
            </p>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium">Your name</label>
            <input
              required
              className={field}
              value={form.customerName}
              onChange={(e) => setForm({ ...form, customerName: e.target.value })}
              placeholder="Jane Doe"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Phone</label>
            <input
              required
              className={field}
              value={form.contactPhone}
              onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
              placeholder="+62 812 3456 7890"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Delivery address</label>
            <textarea
              required
              rows={3}
              className={field}
              value={form.deliveryAddress}
              onChange={(e) => setForm({ ...form, deliveryAddress: e.target.value })}
              placeholder="Street, number, city, landmarks…"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Note for the restaurant</label>
            <textarea
              rows={2}
              className={field}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="e.g. no chili, gate code 1234"
            />
          </div>
          {error && (
            <p className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</p>
          )}
          <button
            disabled={!canSubmit}
            className="w-full rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-stone-300"
          >
            {submitting
              ? 'Placing order…'
              : pricingLoading
                ? 'Loading delivery fee…'
                : belowMinimum
                  ? 'Below minimum order'
                  : `Place order — ${formatPrice(totalCents ?? subtotalCents)}`}
          </button>
        </form>
      </div>

      <aside className="h-fit rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-bold">Order summary</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {lines.map((l) => (
            <li key={l.menuItemId} className="flex justify-between">
              <span>
                {l.quantity} × {l.name}
              </span>
              <span>{formatPrice(l.priceCents * l.quantity)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 border-t border-stone-200 pt-3 text-sm">
          <div className="flex justify-between text-stone-500">
            <span>Subtotal</span>
            <span>{formatPrice(subtotalCents)}</span>
          </div>
          <div className="mt-1 flex justify-between text-stone-500">
            <span>Delivery</span>
            <span data-testid="checkout-delivery">
              {pricingLoading
                ? 'loading…'
                : deliveryFeeCents === null
                  ? 'calculated by the kitchen'
                  : deliveryFeeCents === 0
                    ? 'free'
                    : formatPrice(deliveryFeeCents)}
            </span>
          </div>
          {minOrderCents !== null && (
            <div className="mt-1 flex justify-between text-stone-500">
              <span>Minimum order</span>
              <span>{formatPrice(minOrderCents)}</span>
            </div>
          )}
          <div className="mt-2 flex justify-between text-base font-extrabold">
            <span>Total</span>
            <span data-testid="checkout-total">
              {totalCents === null ? '—' : formatPrice(totalCents)}
            </span>
          </div>
        </div>
      </aside>
    </div>
  );
}
