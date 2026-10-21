'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  ApiError,
  ORDER_STATUSES,
  api,
  formatPrice,
  isUnauthorized,
} from '@/lib/api';
import type { Order, OrderStatus, Restaurant, RestaurantOrdersPage } from '@/lib/api';
import StatusBadge from '@/components/StatusBadge';

/**
 * Owner portal (Phase 2): orders inbox for the signed-in owner's restaurants.
 * v1 is read-only — accept/start/deliver/complete actions and live updates are
 * the following roadmap items. Data comes from GET /restaurants/:id/orders,
 * which the API scopes to the caller (JWT + owner role + ownership check).
 */

const PAGE_SIZE = 10;

type Filter = 'all' | OrderStatus;

function formatDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function lineSummary(order: Order): string {
  const lines = order.items ?? [];
  if (lines.length === 0) return '—';
  return lines.map((l) => `${l.quantity} × ${l.name}`).join(', ');
}

/**
 * One authed API call with the same resilience the customer history page
 * uses: on 401 rotate once and retry; a second 401 signs this device out.
 * Returns a discriminated result so callers can tell signed-out (silent)
 * from a real error (banner).
 */
async function authedCall<T>(
  getAccessToken: () => Promise<string | null>,
  logout: () => Promise<void>,
  fn: (token: string) => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; kind: 'signedOut' } | { ok: false; kind: 'error'; message: string }> {
  const token = await getAccessToken();
  if (!token) return { ok: false, kind: 'signedOut' };
  try {
    return { ok: true, data: await fn(token) };
  } catch (err) {
    if (isUnauthorized(err)) {
      const fresh = await getAccessToken();
      try {
        if (fresh) return { ok: true, data: await fn(fresh) };
      } catch (err2) {
        if (!isUnauthorized(err2)) {
          return {
            ok: false,
            kind: 'error',
            message: err2 instanceof ApiError ? err2.message : 'Cannot reach the API.',
          };
        }
        await logout();
        return { ok: false, kind: 'signedOut' };
      }
      await logout();
      return { ok: false, kind: 'signedOut' };
    }
    return {
      ok: false,
      kind: 'error',
      message: err instanceof ApiError ? err.message : 'Cannot reach the API. Is the server running?',
    };
  }
}

export default function DashboardPage() {
  const { status, user, getAccessToken, logout } = useAuth();
  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RestaurantOrdersPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const isOwnerish = user?.role === 'owner' || user?.role === 'admin';

  // --- load the owner's restaurants once per session ---
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

  // --- orders inbox for the selected restaurant ---
  const loadOrders = useCallback(async () => {
    if (status !== 'signedIn' || !isOwnerish || !selectedId) return;
    setLoading(true);
    setError(null);
    const res = await authedCall(getAccessToken, logout, (t) =>
      api.listRestaurantOrders(t, selectedId, {
        status: filter === 'all' ? undefined : filter,
        page,
        limit: PAGE_SIZE,
      }),
    );
    if (res.ok) {
      setData(res.data);
    } else if (res.kind === 'error') {
      setError(res.message);
    }
    setLoading(false);
  }, [status, isOwnerish, selectedId, filter, page, getAccessToken, logout]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders, reloadKey]);

  // Reset paging + selection-safe filter when the restaurant changes.
  function switchRestaurant(id: string) {
    setSelectedId(id);
    setPage(1);
    setFilter('all');
    setData(null);
  }

  const selected = useMemo(
    () => (restaurants ?? []).find((r) => r.id === selectedId) ?? null,
    [restaurants, selectedId],
  );

  const inboxTotal = data
    ? Object.values(data.counts).reduce((a, b) => a + b, 0)
    : null;

  // Hydration-safe: 'loading' renders identically on server and first client paint.
  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="h-8 w-52 animate-pulse rounded-lg bg-stone-200" aria-hidden />
        <div className="mt-6 space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </div>
      </div>
    );
  }

  if (status !== 'signedIn') {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-2xl">🏪</p>
        <h1 className="mt-2 text-xl font-bold">Sign in to open your restaurant portal</h1>
        <p className="mt-1 text-sm text-stone-500">
          The dashboard shows incoming orders for restaurants you own.
        </p>
        <Link
          href="/login?next=/dashboard"
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
          account. Owner accounts get an order inbox for their restaurants.
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

  // Owner with no restaurants: portal empty state (creation UI comes with later portal items).
  if (restaurants && restaurants.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-extrabold">Restaurant dashboard</h1>
        <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <p className="text-2xl">🍳</p>
          <h2 className="mt-2 text-lg font-bold">You don’t own a restaurant yet</h2>
          <p className="mt-1 text-sm text-stone-500">
            Once a restaurant is linked to your account, its incoming orders will show up here.
          </p>
        </div>
      </div>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Restaurant dashboard</h1>
          <p className="mt-1 text-sm text-stone-500">
            Incoming orders for {selected?.name ?? 'your restaurant'} · read-only inbox (status
            actions coming next)
          </p>
        </div>
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
        >
          ↻ Refresh
        </button>
      </div>

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

      {/* Status inbox tabs with per-status counts (counts always cover ALL statuses) */}
      <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Filter orders by status">
        {(['all', ...ORDER_STATUSES] as Filter[]).map((s) => {
          const count =
            data == null ? null : s === 'all' ? inboxTotal : data.counts[s as OrderStatus];
          return (
            <button
              key={s}
              role="tab"
              aria-selected={filter === s}
              onClick={() => {
                setFilter(s);
                setPage(1);
              }}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors ${
                filter === s
                  ? 'bg-stone-900 text-white'
                  : 'border border-stone-300 bg-white text-stone-600 hover:bg-stone-100'
              }`}
            >
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              {count != null && (
                <span
                  className={`rounded-full px-1.5 text-xs tabular-nums ${
                    filter === s ? 'bg-white/20' : 'bg-stone-100 text-stone-500'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

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

      {loading && !data ? (
        <div className="mt-6 space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <p className="text-2xl">📭</p>
          <h2 className="mt-2 text-lg font-bold">
            {filter === 'all' ? 'No orders yet' : `No ${filter} orders`}
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            {filter === 'all'
              ? 'Customer orders for this restaurant will appear here as they arrive.'
              : 'Try another status tab or check all orders.'}
          </p>
        </div>
      ) : data ? (
        <>
          <div className="mt-6 space-y-4">
            {data.items.map((order) => (
              <div
                key={order.id}
                className="rounded-2xl border border-stone-200 bg-white p-5"
                data-testid={`inbox-card-${order.code}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="font-bold">{order.code}</span>
                    <StatusBadge status={order.status} />
                  </div>
                  <span className="text-xs text-stone-500">{formatDateTime(order.createdAt)}</span>
                </div>

                <p className="mt-2 text-sm text-stone-700">{lineSummary(order)}</p>

                <div className="mt-3 grid gap-1 rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-600">
                  <p>
                    <span className="font-semibold text-stone-700">{order.customerName}</span>
                    {order.contactPhone ? ` · ${order.contactPhone}` : ''}
                  </p>
                  <p className="break-words">📍 {order.deliveryAddress}</p>
                  {order.note && <p className="italic">“{order.note}”</p>}
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 pt-3">
                  <span className="text-sm font-extrabold">
                    {formatPrice(order.totalCents)}
                    <span className="ml-2 text-xs font-medium text-stone-500">
                      incl. {formatPrice(order.deliveryFeeCents)} delivery
                    </span>
                  </span>
                  <Link
                    href={`/orders/${order.id}`}
                    className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-stone-700"
                  >
                    Details
                  </Link>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          <div className="mt-6 flex items-center justify-between">
            <p className="text-sm text-stone-500">
              Page {data.page} of {totalPages} · {data.total} order{data.total === 1 ? '' : 's'}
              {filter !== 'all' ? ` ${filter}` : ''}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={data.page <= 1}
                className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-40"
              >
                ← Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={data.page >= totalPages}
                className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
