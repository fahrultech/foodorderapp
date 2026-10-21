'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { MenuItem, MenuItemInput } from '@/lib/api';
import { centsToInput, parseMoneyToCents } from '@/lib/api';

/**
 * Create/edit dish dialog for the owner menu page. Mirrors the API's
 * CreateMenuItemDto/UpdateMenuItemDto bounds client-side (name 120,
 * description 2000, category 60, imageUrl 500, prep 1..240, price in integer
 * cents via `parseMoneyToCents`), but the server is the authority: a rejected
 * submit comes back as an error string from `onSubmit` and stays visible.
 *
 * Availability is deliberately NOT an edit field — the API treats it as a
 * first-class route (PATCH /menu/items/:id/availability) and the list row
 * exposes the toggle; create mode offers a "start hidden" draft checkbox.
 */
interface FieldState {
  name: string;
  price: string;
  category: string;
  description: string;
  imageUrl: string;
  prepMinutes: string;
  isAvailable: boolean;
}

function initial(item: MenuItem | null): FieldState {
  return {
    name: item?.name ?? '',
    price: item ? centsToInput(item.priceCents) : '',
    category: item?.category ?? '',
    description: item?.description ?? '',
    imageUrl: item?.imageUrl ?? '',
    prepMinutes: item ? String(item.prepMinutes) : '',
    isAvailable: true,
  };
}

interface Props {
  /** null => create mode; otherwise edit mode, prefilled. */
  item: MenuItem | null;
  /** Existing categories, offered via <datalist>. */
  categories: string[];
  /** Returns null on success (parent unmounts us) or an error message to show. */
  onSubmit: (input: MenuItemInput) => Promise<string | null>;
  onCancel: () => void;
}

const labelCls = 'block text-xs font-bold uppercase tracking-wide text-stone-500';
const inputCls =
  'mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

export default function MenuItemForm({ item, categories, onSubmit, onCancel }: Props) {
  const [f, setF] = useState<FieldState>(() => initial(item));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = item !== null;

  // Escape closes (backdrop click does too via the container handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function set<K extends keyof FieldState>(key: K, value: FieldState[K]) {
    setF((cur) => ({ ...cur, [key]: value }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    const name = f.name.trim();
    if (!name) return setError('Name is required.');
    const priceCents = parseMoneyToCents(f.price);
    if (priceCents === null) {
      return setError('Price must be a positive amount up to $100,000.00 (e.g. 12.50).');
    }
    const prepRaw = f.prepMinutes.trim();
    let prepMinutes: number | undefined;
    if (prepRaw !== '') {
      if (!/^\d+$/.test(prepRaw) || Number(prepRaw) < 1 || Number(prepRaw) > 240) {
        return setError('Prep time must be a whole number of minutes between 1 and 240.');
      }
      prepMinutes = Number(prepRaw);
    }

    setBusy(true);
    const input: MenuItemInput = {
      name,
      priceCents,
      description: f.description.trim() || null,
      category: f.category.trim() || null,
      imageUrl: f.imageUrl.trim() || null,
      ...(prepMinutes !== undefined ? { prepMinutes } : {}),
      ...(editing ? {} : { isAvailable: f.isAvailable }),
    };
    const err = await onSubmit(input);
    if (err) {
      // Failure keeps the dialog open with the typed values intact.
      setError(err);
      setBusy(false);
    }
    // Success: the parent closes this dialog (we may unmount mid-await of the refetch).
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-12 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="menu-form-title"
        onSubmit={submit}
        className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
      >
        <h2 id="menu-form-title" className="text-lg font-extrabold">
          {editing ? `Edit “${item.name}”` : 'Add a dish'}
        </h2>
        {editing && (
          <p className="mt-1 text-xs text-stone-500">
            Dishes stay in this restaurant — a dish never moves between restaurants.
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700"
          >
            {error}
          </p>
        )}

        <div className="mt-4 space-y-4">
          <div>
            <label className={labelCls} htmlFor="mi-name">
              Name *
            </label>
            <input
              id="mi-name"
              className={inputCls}
              value={f.name}
              onChange={(e) => set('name', e.target.value)}
              maxLength={120}
              placeholder="Kimchi ramen"
              autoFocus
              disabled={busy}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls} htmlFor="mi-price">
                Price (USD) *
              </label>
              <input
                id="mi-price"
                className={inputCls}
                value={f.price}
                onChange={(e) => set('price', e.target.value)}
                inputMode="decimal"
                placeholder="12.50"
                disabled={busy}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="mi-prep">
                Prep min
              </label>
              <input
                id="mi-prep"
                className={inputCls}
                value={f.prepMinutes}
                onChange={(e) => set('prepMinutes', e.target.value)}
                inputMode="numeric"
                placeholder="15"
                disabled={busy}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="mi-category">
                Category
              </label>
              <input
                id="mi-category"
                className={inputCls}
                value={f.category}
                onChange={(e) => set('category', e.target.value)}
                list="mi-categories"
                maxLength={60}
                placeholder="Mains"
                disabled={busy}
              />
              <datalist id="mi-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
          </div>

          <div>
            <label className={labelCls} htmlFor="mi-desc">
              Description
            </label>
            <textarea
              id="mi-desc"
              className={`${inputCls} min-h-[72px]`}
              value={f.description}
              onChange={(e) => set('description', e.target.value)}
              maxLength={2000}
              placeholder="Rich gochujang broth, soft egg, spring onion."
              disabled={busy}
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="mi-image">
              Image URL
            </label>
            <input
              id="mi-image"
              className={inputCls}
              value={f.imageUrl}
              onChange={(e) => set('imageUrl', e.target.value)}
              maxLength={500}
              placeholder="https://… (optional)"
              disabled={busy}
            />
          </div>

          {!editing && (
            <label className="flex items-center gap-2 text-sm font-semibold text-stone-700">
              <input
                type="checkbox"
                checked={f.isAvailable}
                onChange={(e) => set('isAvailable', e.target.checked)}
                className="h-4 w-4 rounded border-stone-300"
                disabled={busy}
              />
              Show on the storefront right away
              <span className="font-normal text-stone-400">(uncheck to save as a hidden draft)</span>
            </label>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-bold text-white hover:bg-brand-700 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add dish'}
          </button>
        </div>
      </form>
    </div>
  );
}
