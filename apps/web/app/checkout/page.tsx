'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart';
import { useAuth } from '@/lib/auth';
import { api, formatPrice, DeliveryAddress, PromoPreview, Restaurant } from '@/lib/api';

/** A validated promo from the soft-200 /promos/validate endpoint. */
type AppliedPromo = Extract<PromoPreview, { valid: true }>;

/**
 * Live pricing pulled from GET /restaurants/:id — the same source the server
 * prices the order from (integer cents). Until it resolves we know the fee is
 * real, so "Place order" stays disabled; if the fetch fails we allow submit
 * and let the server-side validation be the authority.
 */
type PricingState = 'loading' | 'ready' | 'unavailable';

export default function CheckoutPage() {
  const router = useRouter();
  const { status, getAccessToken } = useAuth();
  const { lines, subtotalCents, restaurantId, restaurantName, clear } = useCart();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [pricing, setPricing] = useState<PricingState>('loading');
  const [promoInput, setPromoInput] = useState('');
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);
  const [form, setForm] = useState({
    customerName: '',
    contactPhone: '',
    deliveryAddress: '',
    note: '',
  });
  // Saved-address picker state (signed-in only). `selectedAddressId` is what
  // we send as deliveryAddressId — the SERVER then copies its own stored text
  // onto the order, so the visible fields are a convenience echo. Selecting a
  // row prefills them; editing any of them falls back to manual ("none").
  const [addresses, setAddresses] = useState<DeliveryAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'signedIn') return;
    let active = true;
    (async () => {
      const tok = await getAccessToken();
      if (!tok) return;
      try {
        const res = await api.listMyAddresses(tok);
        if (!active) return;
        setAddresses(res.items);
        // Pre-select the default row (API keeps exactly one while non-empty)
        // and prefill the form so the guest-style required fields also match.
        const def = res.items.find((a) => a.isDefault);
        if (def) {
          setSelectedAddressId(def.id);
          setForm((f) => ({
            ...f,
            customerName: def.recipientName,
            contactPhone: def.phone,
            deliveryAddress: def.address,
          }));
        }
      } catch {
        if (active) setAddresses([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [status, getAccessToken]);

  /** Any hand-edit of a contact field disclaims the saved-address selection. */
  function setContactField(key: 'customerName' | 'contactPhone' | 'deliveryAddress', value: string) {
    setSelectedAddressId(null);
    setForm((f) => ({ ...f, [key]: value }));
  }

  function chooseAddress(addr: DeliveryAddress) {
    setSelectedAddressId(addr.id);
    setForm((f) => ({
      ...f,
      customerName: addr.recipientName,
      contactPhone: addr.phone,
      deliveryAddress: addr.address,
    }));
  }

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

  // A promo was previewed against ONE cart at ONE restaurant; if either moves,
  // the cached verdict is stale — drop it and let the customer re-apply.
  useEffect(() => {
    setAppliedPromo(null);
    setPromoError(null);
  }, [subtotalCents, restaurantId]);

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
  // The server clamps discounts to the subtotal, so mirroring it here only ever
  // reproduces the same number — this display is a preview, never the authority.
  const discountCents = appliedPromo ? appliedPromo.discountCents : 0;
  const totalCents =
    deliveryFeeCents === null
      ? null
      : subtotalCents - discountCents + deliveryFeeCents;
  const belowMinimum = minOrderCents !== null && subtotalCents < minOrderCents;
  const missingCents = minOrderCents === null ? 0 : minOrderCents - subtotalCents;
  const pricingLoading = pricing === 'loading';
  // Gate submit on real pricing: loading blocks, unavailable (fetch failed)
  // falls through to server-side validation, below-minimum always blocks.
  const canSubmit = !pricingLoading && !belowMinimum && !submitting;

  async function applyPromo() {
    const code = promoInput.trim();
    if (!code || !restaurantId) return;
    setPromoChecking(true);
    setPromoError(null);
    setAppliedPromo(null);
    try {
      const res = await api.validatePromo({ code, restaurantId, subtotalCents });
      if (res.valid) setAppliedPromo(res);
      else setPromoError(res.message);
    } catch {
      // Endpoint unreachable — the order itself will still server-check the
      // code on submit, but right now we can only offer the honest message.
      setPromoError('Could not check the promo code right now.');
    } finally {
      setPromoChecking(false);
    }
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
        // When a saved row is selected we send its id: the server ignores the
        // echoed fields above and copies its own stored text onto the order.
        ...(selectedAddressId ? { deliveryAddressId: selectedAddressId } : {}),
        // Only codes that PASSED the preview are sent; the server re-evaluates
        // it against its own subtotal either way — this is a claim, not trust.
        ...(appliedPromo ? { promoCode: appliedPromo.code } : {}),
      });
      clear();
      // ?pay=1: the order page elevates the payment card. Only meaningful for
      // signed-in customers — payment is JWT-gated server-side, so guests land
      // on the panel's "sign in to pay" hint instead of a dead button.
      router.push(
        `/orders/${order.id}?code=${order.code}${status === 'signedIn' ? '&pay=1' : ''}`,
      );
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
          {status === 'signedIn' && addresses.length > 0 && (
            <fieldset className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
              <legend className="px-1 text-sm font-semibold text-stone-700">
                Deliver to a saved address
              </legend>
              <div className="space-y-2" data-testid="checkout-address-picker">
                {addresses.map((a) => (
                  <label
                    key={a.id}
                    className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm ${
                      selectedAddressId === a.id
                        ? 'border-brand-500 bg-white ring-2 ring-brand-100'
                        : 'border-stone-200 bg-white hover:border-stone-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="saved-address"
                      className="mt-1"
                      checked={selectedAddressId === a.id}
                      onChange={() => chooseAddress(a)}
                      data-testid={`checkout-address-${a.id}`}
                    />
                    <span className="min-w-0">
                      <span className="font-semibold">
                        {a.label}
                        {a.isDefault && (
                          <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">
                            Default
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-stone-500">
                        {a.recipientName} · {a.address}
                      </span>
                    </span>
                  </label>
                ))}
                <button
                  type="button"
                  onClick={() => setSelectedAddressId(null)}
                  className={`text-xs font-medium underline ${
                    selectedAddressId === null ? 'text-brand-600' : 'text-stone-500'
                  }`}
                >
                  Enter details manually instead
                </button>
              </div>
              <p className="mt-2 text-xs text-stone-500">
                Managing the book?{' '}
                <Link href="/addresses" className="font-medium text-brand-600 hover:underline">
                  Edit saved addresses
                </Link>
              </p>
            </fieldset>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium">Your name</label>
            <input
              required
              className={field}
              value={form.customerName}
              onChange={(e) => setContactField('customerName', e.target.value)}
              placeholder="Jane Doe"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Phone</label>
            <input
              required
              className={field}
              value={form.contactPhone}
              onChange={(e) => setContactField('contactPhone', e.target.value)}
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
              onChange={(e) => setContactField('deliveryAddress', e.target.value)}
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
          {discountCents > 0 && (
            <div className="mt-1 flex justify-between font-medium text-emerald-600">
              <span data-testid="checkout-promo-label">Promo ({appliedPromo!.code})</span>
              <span data-testid="checkout-promo">-{formatPrice(discountCents)}</span>
            </div>
          )}
          <div className="mt-3 space-y-1 border-t border-dashed border-stone-200 pt-3">
            <label className="block text-xs font-medium uppercase tracking-wide text-stone-500">
              Promo code
            </label>
            <div className="flex gap-2">
              <input
                className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm uppercase outline-none focus:border-brand-500"
                value={promoInput}
                onChange={(e) => {
                  setPromoInput(e.target.value);
                  setAppliedPromo(null);
                  setPromoError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyPromo();
                  }
                }}
                placeholder="e.g. WELCOME10"
                maxLength={24}
                data-testid="checkout-promo-input"
              />
              <button
                type="button"
                onClick={applyPromo}
                disabled={!promoInput.trim() || promoChecking}
                className="shrink-0 rounded-xl border border-brand-600 px-3 py-2 text-sm font-semibold text-brand-600 hover:bg-brand-50 disabled:border-stone-300 disabled:text-stone-400"
              >
                {promoChecking ? 'Checking…' : appliedPromo ? 'Applied' : 'Apply'}
              </button>
            </div>
            {appliedPromo && (
              <p className="text-xs text-emerald-600">{appliedPromo.description}</p>
            )}
            {promoError && (
              <p role="alert" className="text-xs font-medium text-red-600" data-testid="checkout-promo-error">
                {promoError}
              </p>
            )}
          </div>
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
