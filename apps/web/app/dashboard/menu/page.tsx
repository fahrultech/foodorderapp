'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { ApiError, api, formatPrice } from '@/lib/api';
import type { MenuItem, MenuItemInput, Restaurant } from '@/lib/api';
import { authedCall } from '@/lib/authed-call';
import MenuItemForm from '@/components/MenuItemForm';
import PortalTabs from '@/components/PortalTabs';

/**
 * Owner portal — menu manager (Phase 2). CRUD against the existing owner
 * endpoints: POST /restaurants/:id/menu, PATCH /menu/items/:id,
 * PATCH /menu/items/:id/availability, DELETE /menu/items/:id. Ownership,
 * role and validation are all enforced server-side; this page keeps the
 * single-write-at-a-time + in-place-update conventions of the order inbox,
 * except create/edit saves refetch the list (the server orders by
 * category/name, so a rename can move a row between groups).
 *
 * Hydration-safety mirrors /dashboard: every auth-dependent branch renders a
 * skeleton until the session provider reports loading→signedIn/guest.
 */

type FormState = { mode: 'create' } | { mode: 'edit'; item: MenuItem } | null;

const btnGhost =
  'rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-bold text-stone-700 hover:bg-stone-100 disabled:cursor-wait disabled:opacity-50';

export default function MenuManagerPage() {
  const { status, user, getAccessToken, logout } = useAuth();
  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const isOwnerish = user?.role === 'owner' || user?.role === 'admin';

  // --- the owner's restaurants (same gate + pattern as the order inbox) ---
  useEffect(() => {
    if (status !== 'signedIn' || !isOwnerish) return;
    let alive = true;
    void (async () => {
      const res = await authedCall(getAccessToken, logout, (t) => api.listMyRestaurants(t));
      if (!alive) return;
      if (res.ok) {
        setRestaurants(res.data);
        setSelectedId((cur) => cur ?? res.data[0]?.id ?? null);
        setError(null);
      } else if (res.kind === 'error') {
        setError(`Could not load your restaurants: ${res.message}`);
        setRestaurants([]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isOwnerish, reloadKey]);

  // --- FULL menu for the selected restaurant (drafts included) ---
  const loadMenu = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await api.listRestaurantMenu(selectedId));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `Could not load the menu: ${err.message}`
          : 'Could not load the menu: cannot reach the API. Is the server running?',
      );
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void loadMenu();
  }, [loadMenu, reloadKey]);

  /** Switching restaurants tears down every per-restaurant view state. */
  function switchRestaurant(id: string) {
    setSelectedId(id);
    setItems(null);
    setForm(null);
    setConfirmDeleteId(null);
    setActionError(null);
    setError(null);
  }

  async function toggleAvailability(item: MenuItem) {
    if (busyId) return;
    setBusyId(item.id);
    setActionError(null);
    const res = await authedCall(getAccessToken, logout, (t) =>
      api.setMenuItemAvailability(t, item.id, !item.isAvailable),
    );
    if (res.ok) {
      setItems((cur) => cur?.map((m) => (m.id === item.id ? res.data : m)) ?? cur);
    } else if (res.kind === 'error') {
      setActionError(`Could not change “${item.name}”: ${res.message}`);
    }
    setBusyId(null);
  }

  async function remove(item: MenuItem) {
    if (busyId) return;
    setBusyId(item.id);
    setActionError(null);
    setConfirmDeleteId(null);
    const res = await authedCall(getAccessToken, logout, (t) => api.deleteMenuItem(t, item.id));
    if (res.ok) {
      // Drop the row in place — history is safe: order_items snapshots keep
      // name/price (the FK is ON DELETE SET NULL server-side).
      setItems((cur) => cur?.filter((m) => m.id !== item.id) ?? cur);
    } else if (res.kind === 'error') {
      setActionError(`Could not delete “${item.name}”: ${res.message}`);
    }
    setBusyId(null);
  }

  /**
   * Create/edit submit for the dialog. Returns null on success (dialog
   * closes + list refetches in server order) or an error string the dialog
   * displays with the typed values intact.
   */
  async function submitForm(input: MenuItemInput): Promise<string | null> {
    if (!selectedId) return 'Pick a restaurant first.';
    const editing = form?.mode === 'edit' ? form.item : null;
    const res = await authedCall(getAccessToken, logout, (t) =>
      editing
        ? api.updateMenuItem(t, editing.id, input)
        : api.createMenuItem(t, selectedId, input),
    );
    if (res.ok) {
      setForm(null);
      setActionError(null);
      await loadMenu();
      return null;
    }
    if (res.kind === 'signedOut') {
      return 'Your session expired — sign in again, then re-try the save.';
    }
    return res.message;
  }

  /** Grouped like the storefront: server sorts category/name, so runs are adjacent. */
  const grouped = useMemo(() => {
    const out: { category: string; items: MenuItem[] }[] = [];
    for (const m of items ?? []) {
      const cat = m.category ?? 'Uncategorized';
      const last = out[out.length - 1];
      if (last && last.category === cat) last.items.push(m);
      else out.push({ category: cat, items: [m] });
    }
    return out;
  }, [items]);

  const categories = useMemo(
    () => [...new Set((items ?? []).map((m) => m.category).filter(Boolean) as string[])].sort(),
    [items],
  );

  const selected = useMemo(
    () => (restaurants ?? []).find((r) => r.id === selectedId) ?? null,
    [restaurants, selectedId],
  );
  const hiddenCount = (items ?? []).filter((m) => !m.isAvailable).length;

  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="h-8 w-52 animate-pulse rounded-lg bg-stone-200" aria-hidden />
        <div className="mt-6 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </div>
      </div>
    );
  }

  if (status !== 'signedIn') {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-2xl">🍳</p>
        <h1 className="mt-2 text-xl font-bold">Sign in to manage your menu</h1>
        <p className="mt-1 text-sm text-stone-500">
          The menu manager adds, edits, hides and deletes dishes for restaurants you own.
        </p>
        <Link
          href="/login?next=/dashboard/menu"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (!isOwnerish) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-2xl">🔑</p>
        <h1 className="mt-2 text-xl font-bold">This portal is for restaurant owners</h1>
        <p className="mt-1 text-sm text-stone-500">
          You are signed in as <span className="font-semibold">{user?.email}</span>, a customer
          account. Owner accounts can manage their restaurants’ menus.
        </p>
        <Link
          href="/orders/my"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          View my orders instead
        </Link>
      </div>
    );
  }

  if (restaurants && restaurants.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-extrabold">Menu manager</h1>
        <PortalTabs />
        <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <p className="text-2xl">🍽️</p>
          <h2 className="mt-2 text-lg font-bold">You don’t own a restaurant yet</h2>
          <p className="mt-1 text-sm text-stone-500">
            Once a restaurant is linked to your account, you can manage its dishes here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Menu manager</h1>
          <p className="mt-1 text-sm text-stone-500">
            Dishes for {selected?.name ?? 'your restaurant'}
            {items ? ` · ${items.length} dish${items.length === 1 ? '' : 'e'}` : ''}
            {items && hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selected && (
            <Link
              href={`/restaurants/${selected.id}`}
              className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
            >
              Storefront ↗
            </Link>
          )}
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
          >
            ↻ Refresh
          </button>
          <button
            onClick={() => setForm({ mode: 'create' })}
            disabled={!selectedId}
            className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            + Add dish
          </button>
        </div>
      </div>

      <PortalTabs />

      {/* Restaurant switcher — only when the owner has more than one */}
      {restaurants && restaurants.length > 1 && (
        <label className="mt-4 flex items-center gap-2 text-sm font-semibold text-stone-700">
          Restaurant
          <select
            value={selectedId ?? ''}
            onChange={(e) => switchRestaurant(e.target.value)}
            className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
          >
            {restaurants.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && (
        <p className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700">
          <span>{error}</span>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="shrink-0 rounded-lg border border-rose-200 bg-white px-3 py-1 text-xs font-bold text-rose-700 hover:bg-rose-50"
          >
            Try again
          </button>
        </p>
      )}

      {actionError && (
        <p
          className="mt-4 rounded-xl bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-800"
          role="alert"
        >
          {actionError}
        </p>
      )}

      {loading && !items ? (
        <div className="mt-6 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </div>
      ) : items && items.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <p className="text-2xl">🥣</p>
          <h2 className="mt-2 text-lg font-bold">No dishes yet</h2>
          <p className="mt-1 text-sm text-stone-500">
            Add your first dish and customers will see it on the storefront right away.
          </p>
          <button
            onClick={() => setForm({ mode: 'create' })}
            disabled={!selectedId}
            className="mt-6 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            + Add the first dish
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {grouped.map((group) => (
            <section key={group.category} aria-label={group.category}>
              <h2 className="text-xs font-bold uppercase tracking-wider text-stone-400">
                {group.category} <span className="text-stone-300">· {group.items.length}</span>
              </h2>
              <div className="mt-2 divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white">
                {group.items.map((m) => (
                  <div
                    key={m.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
                    data-testid={`menu-row-${m.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-stone-800">
                        {m.name}
                        {!m.isAvailable && (
                          <span className="ml-2 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-500">
                            hidden
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-stone-500">
                        {formatPrice(m.priceCents)} · {m.prepMinutes} min
                        {m.description ? (
                          <span className="hidden sm:inline"> · {m.description.slice(0, 60)}{m.description.length > 60 ? '…' : ''}</span>
                        ) : null}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        onClick={() => void toggleAvailability(m)}
                        disabled={busyId !== null}
                        aria-busy={busyId === m.id}
                        title={m.isAvailable ? 'Hide from the storefront' : 'Show on the storefront'}
                        className={
                          m.isAvailable
                            ? btnGhost
                            : 'rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:cursor-wait disabled:opacity-50'
                        }
                      >
                        {busyId === m.id ? '…' : m.isAvailable ? 'Hide' : 'Show'}
                      </button>
                      <button
                        onClick={() => {
                          setActionError(null);
                          setConfirmDeleteId(null);
                          setForm({ mode: 'edit', item: m });
                        }}
                        disabled={busyId !== null}
                        className={btnGhost}
                      >
                        Edit
                      </button>
                      {confirmDeleteId === m.id ? (
                        <>
                          <button
                            onClick={() => void remove(m)}
                            disabled={busyId !== null}
                            className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-700 disabled:cursor-wait disabled:opacity-50"
                          >
                            Confirm delete
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className={btnGhost}
                          >
                            Keep
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(m.id)}
                          disabled={busyId !== null}
                          className="rounded-lg px-2 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50 disabled:cursor-wait disabled:opacity-50"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {form && (
        <MenuItemForm
          item={form.mode === 'edit' ? form.item : null}
          categories={categories}
          onSubmit={submitForm}
          onCancel={() => setForm(null)}
        />
      )}
    </div>
  );
}
