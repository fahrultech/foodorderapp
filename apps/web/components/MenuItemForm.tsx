'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { MenuItem, MenuItemInput } from '@/lib/api';
import { centsToInput, parseMoneyToCents } from '@/lib/api';
import { useTranslations } from 'next-intl';

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
  /** Stock tracker: OFF = unlimited (null/omitted), ON = a whole number >= 0. */
  trackStock: boolean;
  stock: string;
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
    trackStock: item ? item.stock !== null && item.stock !== undefined : false,
    stock: item?.stock != null ? String(item.stock) : '',
  };
}

interface Props {
  /** null => create mode; otherwise edit mode, prefilled. */
  item: MenuItem | null;
  /** Existing categories, offered via <datalist>. */
  categories: string[];
  /** Returns null on success (parent unmounts us) or an error message to show. */
  onSubmit: (input: MenuItemInput) => Promise<string | null>;
  /** Uploads bytes directly to object storage and returns the public URL. */
  onUpload: (file: File) => Promise<string>;
  onCancel: () => void;
}

const labelCls = 'block text-xs font-bold uppercase tracking-wide text-stone-500';
const inputCls =
  'mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export default function MenuItemForm({ item, categories, onSubmit, onUpload, onCancel }: Props) {
  const t = useTranslations('Portal');
  const [f, setF] = useState<FieldState>(() => initial(item));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const editing = item !== null;
  const formRef = useRef<HTMLFormElement>(null);
  // Phase 6 a11y — dialog focus choreography. The OPENER is captured during
  // render, before the DOM commit applies `autoFocus` (a mount effect would
  // see the name input as activeElement, not the button that opened us), and
  // restored on unmount so keyboard users are not stranded at <body>.
  const openerRef = useRef<Element | null>(null);
  if (openerRef.current === null && typeof document !== 'undefined') {
    openerRef.current = document.activeElement;
  }

  useEffect(() => {
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // Escape closes (backdrop click does too via the container handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !uploading) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel, uploading]);

  function set<K extends keyof FieldState>(key: K, value: FieldState[K]) {
    setF((cur) => ({ ...cur, [key]: value }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);

    const name = f.name.trim();
    if (!name) return setError(t('mfErrName'));
    const priceCents = parseMoneyToCents(f.price);
    if (priceCents === null) {
      return setError(t('mfErrPrice'));
    }
    const prepRaw = f.prepMinutes.trim();
    let prepMinutes: number | undefined;
    if (prepRaw !== '') {
      if (!/^\d+$/.test(prepRaw) || Number(prepRaw) < 1 || Number(prepRaw) > 240) {
        return setError(t('mfErrPrep'));
      }
      prepMinutes = Number(prepRaw);
    }
    // Stock mirrors CreateMenuItemDto (@IsInt @Min(0)) — no upper bound.
    const stockRaw = f.stock.trim();
    let stockValue: number | null | undefined; // undefined = leave untouched
    if (f.trackStock) {
      if (!/^\d+$/.test(stockRaw)) {
        return setError(t('mfErrStock'));
      }
      stockValue = Number(stockRaw);
    } else if (editing && item.stock !== null) {
      stockValue = null; // explicit clear back to unlimited
    }

    setBusy(true);
    const input: MenuItemInput = {
      name,
      priceCents,
      description: f.description.trim() || null,
      category: f.category.trim() || null,
      imageUrl: f.imageUrl.trim() || null,
      ...(prepMinutes !== undefined ? { prepMinutes } : {}),
      ...(stockValue !== undefined ? { stock: stockValue } : {}),
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

  async function uploadImage() {
    if (!imageFile || uploading || busy) return;
    setError(null);
    setUploadNotice(null);
    if (!IMAGE_TYPES.includes(imageFile.type)) {
      return setError(t('mfErrImageType'));
    }
    if (imageFile.size < 1 || imageFile.size > IMAGE_MAX_BYTES) {
      return setError(t('mfErrImageSize'));
    }
    setUploading(true);
    try {
      const imageUrl = await onUpload(imageFile);
      set('imageUrl', imageUrl);
      setUploadNotice(t('mfUploaded'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('mfUploadFailed'));
    } finally {
      setUploading(false);
    }
  }

  // Tab trap (Phase 6 a11y): a role=dialog whose Tab key escapes to the
  // background page is a keyboard quicksand — every focus stop behind the
  // overlay stays reachable. Cycle forward/backward at the boundaries.
  function trapTab(e: ReactKeyboardEvent<HTMLFormElement>) {
    if (e.key !== 'Tab') return;
    const nodes = formRef.current?.querySelectorAll<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes);
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === formRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-12 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy && !uploading) onCancel();
      }}
    >
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="menu-form-title"
        onSubmit={submit}
        onKeyDown={trapTab}
        className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
      >
        <h2 id="menu-form-title" className="text-lg font-extrabold">
          {editing ? t('mfTitleEdit', { name: item.name }) : t('mfTitleAdd')}
        </h2>
        {editing && (
          <p className="mt-1 text-xs text-stone-500">{t('mfEditNote')}</p>
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
              {t('mfNameLabel')}
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
                {t('mfPriceLabel')}
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
                {t('mfPrepLabel')}
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
                {t('mfCategoryLabel')}
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

          <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50 p-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-stone-700">
              <input
                type="checkbox"
                checked={f.trackStock}
                onChange={(e) => set('trackStock', e.target.checked)}
                className="h-4 w-4 rounded border-stone-300"
                disabled={busy}
                data-testid="mi-track-stock"
              />
              {t('mfStockToggle')}
              <span className="font-normal text-stone-400">{t('mfStockToggleHint')}</span>
            </label>
            {f.trackStock && (
              <div className="mt-2">
                <label className={labelCls} htmlFor="mi-stock">
                  {t('mfUnitsLabel')}
                </label>
                <input
                  id="mi-stock"
                  className={inputCls}
                  value={f.stock}
                  onChange={(e) => set('stock', e.target.value)}
                  inputMode="numeric"
                  placeholder="e.g. 12 (0 = sold out)"
                  disabled={busy}
                  data-testid="mi-stock"
                />
              </div>
            )}
          </div>

          <div>
            <label className={labelCls} htmlFor="mi-desc">
              {t('mfDescLabel')}
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
              {t('mfImageUrlLabel')}
            </label>
            <input
              id="mi-image"
              className={inputCls}
              value={f.imageUrl}
              onChange={(e) => set('imageUrl', e.target.value)}
              maxLength={500}
              placeholder="https://… (optional)"
              disabled={busy || uploading}
            />
            {editing ? (
              <div className="mt-3 rounded-xl border border-dashed border-stone-300 bg-stone-50 p-3">
                <label className={labelCls} htmlFor="mi-image-file">
                  {t('mfImageFileLabel')}
                </label>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input
                    id="mi-image-file"
                    type="file"
                    accept={IMAGE_TYPES.join(',')}
                    onChange={(e) => {
                      setImageFile(e.target.files?.[0] ?? null);
                      setUploadNotice(null);
                    }}
                    disabled={busy || uploading}
                    className="min-w-0 flex-1 text-xs text-stone-600 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-stone-700"
                  />
                  <button
                    type="button"
                    onClick={() => void uploadImage()}
                    disabled={!imageFile || busy || uploading}
                    className="rounded-lg bg-stone-800 px-3 py-2 text-xs font-bold text-white hover:bg-stone-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {uploading ? t('mfUploading') : t('mfUploadImage')}
                  </button>
                </div>
                <p className="mt-2 text-xs text-stone-500">{t('mfImageHint')}</p>
                {uploadNotice && (
                  <p className="mt-2 text-xs font-semibold text-emerald-700" role="status">
                    {uploadNotice}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-2 text-xs text-stone-500">{t('mfSaveFirstHint')}</p>
            )}
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
              {t('mfShowNow')}
              <span className="font-normal text-stone-400">{t('mfShowNowHint')}</span>
            </label>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy || uploading}
            className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            {t('actionCancel')}
          </button>
          <button
            type="submit"
            disabled={busy || uploading}
            className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-bold text-white hover:bg-brand-700 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? t('mfSaving') : editing ? t('mfSaveChanges') : t('mfAddDishSubmit')}
          </button>
        </div>
      </form>
    </div>
  );
}
