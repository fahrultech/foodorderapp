'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart';
import { api, formatPrice } from '@/lib/api';

export default function CheckoutPage() {
  const router = useRouter();
  const { lines, subtotalCents, restaurantId, clear } = useCart();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    customerName: '',
    contactPhone: '',
    deliveryAddress: '',
    note: '',
  });

  if (lines.length === 0 || !restaurantId) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <h1 className="text-xl font-bold">Nothing to check out</h1>
        <p className="mt-1 text-sm text-stone-500">Add some dishes to your cart first.</p>
      </div>
    );
  }

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
            disabled={submitting}
            className="w-full rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-stone-300"
          >
            {submitting ? 'Placing order…' : `Place order — ${formatPrice(subtotalCents)} + delivery`}
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
            <span>calculated by the kitchen</span>
          </div>
          <div className="mt-2 flex justify-between text-base font-extrabold">
            <span>Total (≈)</span>
            <span>{formatPrice(subtotalCents)}</span>
          </div>
        </div>
      </aside>
    </div>
  );
}
