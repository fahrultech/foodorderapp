'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError, api, type DeliveryAddress, type DeliveryAddressInput } from '@/lib/api';

/** Mirrors the API's DTO bounds — fast client feedback, server stays the authority. */
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const emptyForm: DeliveryAddressInput = {
  label: '',
  recipientName: '',
  phone: '',
  address: '',
  isDefault: false,
};

function validate(f: DeliveryAddressInput): string | null {
  if (!f.label.trim()) return 'Give the address a short label (e.g. Home).';
  if (f.label.trim().length > 40) return 'Label is too long (max 40 characters).';
  if (!f.recipientName.trim()) return 'Recipient name is required.';
  if (f.recipientName.trim().length > 120) return 'Recipient name is too long.';
  if (!PHONE_RE.test(f.phone.trim())) return 'Phone looks invalid — digits, +, spaces, dashes.';
  if (!f.address.trim()) return 'Street address is required.';
  if (f.address.trim().length > 500) return 'Address is too long (max 500 characters).';
  return null;
}

export default function AddressesPage() {
  const { status, getAccessToken } = useAuth();
  const [rows, setRows] = useState<DeliveryAddress[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 'new' = add form open; a row id = that row in edit mode; null = read-only list.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<DeliveryAddressInput>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const tok = await getAccessToken();
    if (!tok) return;
    try {
      const res = await api.listMyAddresses(tok);
      setRows(res.items);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load your addresses.');
    } finally {
      setLoaded(true);
    }
  }, [getAccessToken]);

  useEffect(() => {
    if (status === 'signedIn') void refresh();
  }, [status, refresh]);

  function openAdd() {
    setEditing('new');
    setForm(emptyForm);
    setFormError(null);
  }

  function openEdit(row: DeliveryAddress) {
    setEditing(row.id);
    setForm({
      label: row.label,
      recipientName: row.recipientName,
      phone: row.phone,
      address: row.address,
      isDefault: false,
    });
    setFormError(null);
  }

  async function submitForm() {
    if (!editing) return;
    const problem = validate(form);
    if (problem) {
      setFormError(problem);
      return;
    }
    const tok = await getAccessToken();
    if (!tok) return;
    setSaving(true);
    setFormError(null);
    const trimmed: DeliveryAddressInput = {
      label: form.label.trim(),
      recipientName: form.recipientName.trim(),
      phone: form.phone.trim(),
      address: form.address.trim(),
    };
    try {
      if (editing === 'new') {
        await api.createAddress(tok, { ...trimmed, isDefault: form.isDefault === true });
      } else {
        await api.updateAddress(tok, editing, trimmed);
      }
      setEditing(null);
      await refresh();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not save the address.');
    } finally {
      setSaving(false);
    }
  }

  async function act(id: string, fn: (tok: string) => Promise<unknown>) {
    const tok = await getAccessToken();
    if (!tok) return;
    setBusyId(id);
    try {
      await fn(tok);
      await refresh();
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'That action failed.');
    } finally {
      setBusyId(null);
    }
  }

  const pending = status === 'loading' || (status === 'signedIn' && !loaded);

  return (
    <section>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Delivery addresses</h1>
        {status === 'signedIn' && rows.length > 0 && editing === null && (
          <button
            onClick={openAdd}
            className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Add address
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-stone-500">
        Saved addresses speed up checkout — the one marked default is pre-selected, and the server
        always delivers to its own stored copy, never a client-echoed text.
      </p>

      {status === 'guest' && (
        <div className="mt-8 rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-10 text-center">
          <p className="text-lg font-semibold text-stone-700">Sign in to save addresses.</p>
          <p className="mt-1 text-sm text-stone-500">
            Keep home, office and every other drop-off point one tap away at checkout.
          </p>
          <Link
            href="/login?next=%2Faddresses"
            className="mt-4 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Sign in
          </Link>
        </div>
      )}

      {pending && (
        <ul className="mt-8 space-y-3" aria-busy="true" aria-label="Loading addresses">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-28 rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </ul>
      )}

      {loadError && (
        <p role="alert" className="mt-6 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {loadError}
        </p>
      )}

      {status === 'signedIn' && !pending && rows.length === 0 && editing !== 'new' && (
        <div className="mt-8 rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-10 text-center">
          <p className="text-lg font-semibold text-stone-700">No saved addresses yet.</p>
          <p className="mt-1 text-sm text-stone-500">
            Add one now and checkout becomes a two-tap affair.
          </p>
          <button
            onClick={openAdd}
            className="mt-4 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Add your first address
          </button>
        </div>
      )}

      {status === 'signedIn' && !pending && rows.length > 0 && (
        <ul className="mt-8 space-y-3">
          {rows.map((row) =>
            editing === row.id ? (
              <li key={row.id} className="rounded-2xl border border-brand-200 bg-white p-5">
                <h2 className="font-bold">Edit “{row.label}”</h2>
                <AddressFields form={form} setForm={setForm} isEdit />
                {formError && (
                  <p role="alert" className="mt-2 text-sm font-medium text-red-600">{formError}</p>
                )}
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={submitForm}
                    disabled={saving}
                    className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-stone-300"
                  >
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                  <button
                    onClick={() => setEditing(null)}
                    className="rounded-xl border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-600 hover:bg-stone-50"
                  >
                    Cancel
                  </button>
                </div>
              </li>
            ) : (
              <li
                key={row.id}
                className="flex items-start justify-between gap-4 rounded-2xl border border-stone-200 bg-white p-5"
              >
                <div className="min-w-0">
                  <h2 className="font-semibold">
                    {row.label}
                    {row.isDefault && (
                      <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">
                        Default
                      </span>
                    )}
                  </h2>
                  <p className="mt-1 text-sm text-stone-600">
                    {row.recipientName} · {row.phone}
                  </p>
                  <p className="mt-0.5 text-sm text-stone-500">{row.address}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-start">
                  <button
                    onClick={() => openEdit(row)}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100"
                  >
                    Edit
                  </button>
                  {!row.isDefault && (
                    <button
                      onClick={() => act(row.id, (tok) => api.setDefaultAddress(tok, row.id))}
                      disabled={busyId === row.id}
                      className="rounded-lg px-3 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:text-stone-400"
                    >
                      Make default
                    </button>
                  )}
                  <button
                    onClick={() => act(row.id, (tok) => api.deleteAddress(tok, row.id))}
                    disabled={busyId === row.id}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:text-stone-400"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {status === 'signedIn' && editing === 'new' && (
        <div className="mt-6 rounded-2xl border border-brand-200 bg-white p-5">
          <h2 className="font-bold">New address</h2>
          <AddressFields form={form} setForm={setForm} isEdit={false} />
          {formError && (
            <p role="alert" className="mt-2 text-sm font-medium text-red-600">{formError}</p>
          )}
          <div className="mt-4 flex gap-2">
            <button
              onClick={submitForm}
              disabled={saving}
              className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-stone-300"
            >
              {saving ? 'Saving…' : 'Save address'}
            </button>
            <button
              onClick={() => setEditing(null)}
              className="rounded-xl border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-600 hover:bg-stone-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Shared add/edit form body. `isEdit` hides the create-only default checkbox. */
function AddressFields({
  form,
  setForm,
  isEdit,
}: {
  form: DeliveryAddressInput;
  setForm: (f: DeliveryAddressInput) => void;
  isEdit: boolean;
}) {
  const field =
    'w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium">Label</label>
          <input
            className={field}
            value={form.label}
            maxLength={40}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            placeholder="Home, Office, Mum's place…"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Recipient name</label>
          <input
            className={field}
            value={form.recipientName}
            maxLength={120}
            onChange={(e) => setForm({ ...form, recipientName: e.target.value })}
            placeholder="Who receives the food"
          />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium">Phone for this address</label>
        <input
          className={field}
          value={form.phone}
          maxLength={32}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          placeholder="+62 812 3456 7890"
        />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium">Street address</label>
        <textarea
          rows={3}
          className={field}
          value={form.address}
          maxLength={500}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
          placeholder="Street, number, city, landmarks…"
        />
      </div>
      {!isEdit && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isDefault === true}
            onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
            className="h-4 w-4 rounded border-stone-300"
          />
          Set as my default address
        </label>
      )}
    </div>
  );
}
