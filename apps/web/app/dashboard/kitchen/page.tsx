'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PortalTabs from '@/components/PortalTabs';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import type { Order, OrderStatus, Restaurant, RestaurantOrdersPage } from '@/lib/api';
import { authedCall } from '@/lib/authed-call';
import { POLL_INTERVAL_MS, PUSH_SYNC_DEBOUNCE_MS, pollIsStaleVsAction } from '@/lib/live-sync';
import { useOrderFeed } from '@/lib/use-order-feed';
import { feedTransport } from '@/lib/ws-feed';

const ACTIVE_STATUSES = ['confirmed', 'preparing', 'delivering'] as const;
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

type Lane = {
  status: ActiveStatus;
  title: string;
  hint: string;
  action: { to: OrderStatus; label: string };
  accent: string;
};

const LANES: readonly Lane[] = [
  {
    status: 'confirmed',
    title: 'Queued',
    hint: 'Paid and accepted — ready to start',
    action: { to: 'preparing', label: 'Start preparing' },
    accent: 'border-sky-300 bg-sky-50',
  },
  {
    status: 'preparing',
    title: 'Preparing',
    hint: 'Currently being cooked or packed',
    action: { to: 'delivering', label: 'Out for delivery' },
    accent: 'border-amber-300 bg-amber-50',
  },
  {
    status: 'delivering',
    title: 'Out for delivery',
    hint: 'Handed off and on the way',
    action: { to: 'completed', label: 'Complete order' },
    accent: 'border-emerald-300 bg-emerald-50',
  },
];

const EMPTY_LANES: Record<ActiveStatus, RestaurantOrdersPage | null> = {
  confirmed: null,
  preparing: null,
  delivering: null,
};

function oldestFirst(items: Order[]): Order[] {
  return [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function formatTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

function itemSummary(order: Order): string[] {
  return (order.items ?? []).map((item) => `${item.quantity} × ${item.name}`);
}

export default function KitchenDisplayPage() {
  const { status, user, getAccessToken, logout } = useAuth();
  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lanes, setLanes] = useState<Record<ActiveStatus, RestaurantOrdersPage | null>>(EMPTY_LANES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncIssue, setSyncIssue] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [live, setLive] = useState(true);
  const lastActionAtRef = useRef(0);
  const syncTimerRef = useRef<number | null>(null);
  const missedSyncRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const isOwnerish = user?.role === 'owner' || user?.role === 'admin';

  useEffect(() => {
    if (status !== 'signedIn' || !isOwnerish) return;
    let alive = true;
    void (async () => {
      const res = await authedCall(getAccessToken, logout, (token) =>
        api.listMyRestaurants(token),
      );
      if (!alive) return;
      if (res.ok) {
        setRestaurants(res.data);
        setSelectedId((current) =>
          current && res.data.some((restaurant) => restaurant.id === current)
            ? current
            : res.data[0]?.id ?? null,
        );
        setError(null);
      } else if (res.kind === 'error') {
        setRestaurants([]);
        setError(`Could not load your restaurants: ${res.message}`);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [status, isOwnerish, reloadKey, getAccessToken, logout]);

  const fetchBoard = useCallback(
    async (mode: 'full' | 'silent') => {
      if (status !== 'signedIn' || !isOwnerish || !selectedId) return;
      const restaurantId = selectedId;
      const startedAt = Date.now();
      if (mode === 'full') {
        setLoading(true);
        setError(null);
      }
      const res = await authedCall(getAccessToken, logout, async (token) => {
        const pages = await Promise.all(
          ACTIVE_STATUSES.map((activeStatus) =>
            api.listRestaurantOrders(token, restaurantId, {
              status: activeStatus,
              page: 1,
              limit: 50,
            }),
          ),
        );
        return Object.fromEntries(
          ACTIVE_STATUSES.map((activeStatus, index) => [
            activeStatus,
            { ...pages[index], items: oldestFirst(pages[index].items) },
          ]),
        ) as Record<ActiveStatus, RestaurantOrdersPage>;
      });
      if (selectedRef.current !== restaurantId) return;
      if (res.ok) {
        if (mode === 'silent' && pollIsStaleVsAction(startedAt, lastActionAtRef.current)) return;
        setLanes(res.data);
        setSyncIssue(null);
      } else if (res.kind === 'error') {
        if (mode === 'full') setError(`Could not load the kitchen board: ${res.message}`);
        else setSyncIssue(res.message);
      }
      if (mode === 'full') setLoading(false);
    },
    [status, isOwnerish, selectedId, getAccessToken, logout],
  );

  useEffect(() => {
    void fetchBoard('full');
  }, [fetchBoard, reloadKey]);

  const requestSync = useCallback(() => {
    // Trailing debounce: a push that lands while the initial/onReady timer is
    // pending must replace that timer, not disappear behind a stale fetch.
    if (syncTimerRef.current != null) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      if (document.hidden || busyOrderId) {
        missedSyncRef.current = true;
        return;
      }
      void fetchBoard('silent');
    }, PUSH_SYNC_DEBOUNCE_MS);
  }, [busyOrderId, fetchBoard]);

  useEffect(() => {
    if (!busyOrderId && missedSyncRef.current && !document.hidden) {
      missedSyncRef.current = false;
      requestSync();
    }
  }, [busyOrderId, requestSync]);

  useEffect(
    () => () => {
      if (syncTimerRef.current != null) window.clearTimeout(syncTimerRef.current);
    },
    [],
  );

  const feedHandlers = useMemo(
    () => ({ onReady: requestSync, onEvent: requestSync }),
    [requestSync],
  );
  const { wsUp } = useOrderFeed({
    enabled: status === 'signedIn' && !!isOwnerish && !!selectedId && live,
    restaurantId: selectedId,
    getAccessToken,
    handlers: feedHandlers,
  });

  useEffect(() => {
    if (status !== 'signedIn' || !isOwnerish || !selectedId || !live) return;
    const interval = window.setInterval(() => {
      if (!wsUp && !document.hidden && !busyOrderId) void fetchBoard('silent');
    }, POLL_INTERVAL_MS);
    const visible = () => {
      if (!document.hidden) requestSync();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [status, isOwnerish, selectedId, live, wsUp, busyOrderId, fetchBoard, requestSync]);

  async function advance(order: Order, lane: Lane) {
    if (!selectedId || busyOrderId) return;
    setBusyOrderId(order.id);
    setError(null);
    const res = await authedCall(getAccessToken, logout, (token) =>
      api.setRestaurantOrderStatus(token, selectedId, order.id, lane.action.to),
    );
    if (res.ok) {
      setLanes((current) => {
        const next = { ...current };
        for (const activeStatus of ACTIVE_STATUSES) {
          const page = next[activeStatus];
          if (page) {
            const items = page.items.filter((item) => item.id !== order.id);
            const removed = page.items.length - items.length;
            next[activeStatus] = {
              ...page,
              items,
              total: Math.max(0, page.total - removed),
            };
          }
        }
        if (ACTIVE_STATUSES.includes(lane.action.to as ActiveStatus)) {
          const target = lane.action.to as ActiveStatus;
          const page = next[target];
          if (page) {
            next[target] = {
              ...page,
              items: oldestFirst([...page.items, res.data]),
              total: page.total + 1,
            };
          }
        }
        return next;
      });
      lastActionAtRef.current = Date.now();
    } else if (res.kind === 'error') {
      setError(`${lane.action.label} failed: ${res.message}`);
    }
    setBusyOrderId(null);
  }

  const selected = useMemo(
    () => (restaurants ?? []).find((restaurant) => restaurant.id === selectedId) ?? null,
    [restaurants, selectedId],
  );
  const transport = feedTransport({ live, wsUp, sseUp: false });

  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-7xl" aria-busy="true">
        <div className="h-8 w-56 animate-pulse rounded-lg bg-stone-200" aria-hidden />
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-80 animate-pulse rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </div>
      </div>
    );
  }

  if (status !== 'signedIn') {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-2xl">👨‍🍳</p>
        <h1 className="mt-2 text-xl font-bold">Sign in to open the kitchen display</h1>
        <p className="mt-1 text-sm text-stone-500">The prep board is available to restaurant owners.</p>
        <Link href="/login?next=/dashboard/kitchen" className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">
          Sign in
        </Link>
      </div>
    );
  }

  if (!isOwnerish) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-2xl">🔑</p>
        <h1 className="mt-2 text-xl font-bold">This display is for restaurant teams</h1>
        <p className="mt-1 text-sm text-stone-500">Customer accounts cannot access kitchen orders.</p>
        <Link href="/orders/my" className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">
          View my orders instead
        </Link>
      </div>
    );
  }

  if (restaurants && restaurants.length === 0 && !error) {
    return (
      <div className="mx-auto max-w-7xl">
        <h1 className="text-2xl font-extrabold">Kitchen display</h1>
        <PortalTabs />
        <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <p className="text-2xl">🍽️</p>
          <h2 className="mt-2 text-lg font-bold">You don’t own a restaurant yet</h2>
          <p className="mt-1 text-sm text-stone-500">Active prep orders will appear after a restaurant is linked to your account.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Kitchen display</h1>
          <p className="mt-1 text-sm text-stone-500">Active prep flow for {selected?.name ?? 'your restaurant'} · oldest orders first</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLive((current) => !current)}
            aria-pressed={live}
            data-feed-transport={transport}
            className={`rounded-full px-3.5 py-2 text-xs font-bold ${live ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-200 text-stone-600'}`}
          >
            {live ? (wsUp ? 'Live · push' : 'Live · polling') : 'Paused'}
          </button>
          <button type="button" onClick={() => setReloadKey((key) => key + 1)} className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100">
            ↻ Refresh
          </button>
        </div>
      </div>

      <PortalTabs />

      {restaurants && restaurants.length > 0 && (
        <label className="mt-4 flex items-center gap-2 text-sm font-semibold text-stone-700">
          Restaurant
          <select
            aria-label="Restaurant"
            value={selectedId ?? ''}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setLanes(EMPTY_LANES);
              setSyncIssue(null);
            }}
            className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
          >
            {restaurants.map((restaurant) => (
              <option key={restaurant.id} value={restaurant.id}>{restaurant.name}</option>
            ))}
          </select>
        </label>
      )}

      {error && <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700" role="alert">{error}</p>}
      {syncIssue && <p className="mt-3 text-xs font-semibold text-amber-700" role="status">Live refresh failed ({syncIssue}); showing the last good board.</p>}

      <div data-testid="kitchen-board" className="mt-6 grid min-w-0 gap-4 md:grid-cols-3">
        {LANES.map((lane) => {
          const page = lanes[lane.status];
          const items = page?.items ?? [];
          return (
            <section key={lane.status} data-testid={`kitchen-lane-${lane.status}`} className={`min-w-0 rounded-2xl border-t-4 p-3 ${lane.accent}`} aria-labelledby={`kitchen-${lane.status}`}>
              <div className="flex items-start justify-between gap-2 px-1 pb-3">
                <div>
                  <h2 id={`kitchen-${lane.status}`} className="text-lg font-extrabold">{lane.title}</h2>
                  <p className="text-xs text-stone-600">{lane.hint}</p>
                </div>
                <span data-testid={`kitchen-count-${lane.status}`} className="rounded-full bg-white px-2.5 py-1 text-sm font-extrabold tabular-nums text-stone-700">{page?.total ?? 0}</span>
              </div>

              {loading && !page ? (
                <div className="space-y-3" aria-busy="true">
                  {[0, 1].map((item) => <div key={item} className="h-40 animate-pulse rounded-xl bg-white/70" aria-hidden />)}
                </div>
              ) : items.length === 0 ? (
                <div className="rounded-xl border border-dashed border-stone-300 bg-white/70 px-4 py-10 text-center text-sm font-semibold text-stone-500">No orders in this lane</div>
              ) : (
                <div className="space-y-3">
                  {items.map((order) => (
                    <article key={order.id} data-testid={`kitchen-card-${order.code}`} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-base font-extrabold">{order.code}</h3>
                        <time dateTime={order.createdAt} className="text-xs font-semibold text-stone-500">{formatTime(order.createdAt)}</time>
                      </div>
                      <p className="mt-1 text-sm font-semibold text-stone-700">{order.customerName}</p>
                      <ul className="mt-3 space-y-1.5 border-y border-stone-100 py-3 text-sm text-stone-800">
                        {itemSummary(order).map((line) => <li key={line}>{line}</li>)}
                      </ul>
                      {order.note && <p className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-sm font-bold text-amber-950">Note: {order.note}</p>}
                      <button
                        type="button"
                        onClick={() => void advance(order, lane)}
                        disabled={busyOrderId !== null}
                        aria-busy={busyOrderId === order.id}
                        className="mt-4 min-h-12 w-full rounded-xl bg-stone-900 px-4 py-3 text-sm font-extrabold text-white hover:bg-stone-700 disabled:cursor-wait disabled:opacity-50"
                      >
                        {busyOrderId === order.id ? 'Updating…' : lane.action.label}
                      </button>
                    </article>
                  ))}
                </div>
              )}
              {page && page.total > page.items.length && <p className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-xs font-semibold text-amber-800">Showing the oldest 50 of {page.total}. Use Orders for the full queue.</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
