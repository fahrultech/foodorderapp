'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { api, type DriverOrdersPage, type Order, type OrderStatus } from '@/lib/api';
import { authedCall } from '@/lib/authed-call';
import { POLL_INTERVAL_MS, PUSH_SYNC_DEBOUNCE_MS, pollIsStaleVsAction } from '@/lib/live-sync';
import { useOrderFeed } from '@/lib/use-order-feed';
import { feedTransport } from '@/lib/ws-feed';
import { PortalLoadFailed, PortalOffline } from '@/components/PortalOffline';

const NEXT_STATUS: Partial<Record<OrderStatus, { to: OrderStatus; labelKey: string }>> = {
  preparing: { to: 'delivering', labelKey: 'actionStartDelivery' },
  delivering: { to: 'completed', labelKey: 'actionMarkDelivered' },
};

const STATUS_KEY: Record<OrderStatus, string> = {
  pending: 'statusPending',
  confirmed: 'statusConfirmed',
  preparing: 'driverReadyForPickup',
  delivering: 'statusDelivering',
  completed: 'driverDelivered',
  cancelled: 'statusCancelled',
};

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

export default function DriverPage() {
  const { status, user, getAccessToken, logout } = useAuth();
  const t = useTranslations('PortalStates');
  const tc = useTranslations('Portal');
  const isDriver = user?.role === 'driver';
  const [page, setPage] = useState<DriverOrdersPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Session 91 states audit: a FAILED inbox load must never render the
  // "No deliveries assigned" empty card over missing data. `loadFailed`
  // owns the whole list area until a load succeeds; `down` picks the
  // offline card (API unreachable / 5xx) vs the plain failure card.
  const [loadFailed, setLoadFailed] = useState<{ down: boolean; message: string } | null>(null);
  const [syncIssue, setSyncIssue] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const lastActionAtRef = useRef(0);
  const syncTimerRef = useRef<number | null>(null);
  const missedSyncRef = useRef(false);
  const pageRef = useRef<DriverOrdersPage | null>(null);
  pageRef.current = page;

  const fetchOrders = useCallback(
    async (mode: 'full' | 'silent') => {
      if (status !== 'signedIn' || !isDriver) return;
      const startedAt = Date.now();
      if (mode === 'full') {
        setLoading(true);
        setError(null);
      }
      const result = await authedCall(getAccessToken, logout, (token) =>
        api.listDriverOrders(token, { page: 1, limit: 50 }),
      );
      if (result.ok) {
        if (mode === 'silent' && pollIsStaleVsAction(startedAt, lastActionAtRef.current)) return;
        setPage(result.data);
        setLoadFailed(null);
        setSyncIssue(null);
      } else if (result.kind === 'error') {
        if (mode === 'silent') {
          setSyncIssue(result.message);
        } else if (pageRef.current) {
          // A manual Refresh that fails still has yesterday's list on
          // screen — keep showing it with the amber strip, don't blank.
          setSyncIssue(result.message);
        } else {
          setLoadFailed({ down: result.down, message: result.message });
        }
      }
      if (mode === 'full') setLoading(false);
    },
    [status, isDriver, getAccessToken, logout],
  );

  useEffect(() => {
    void fetchOrders('full');
  }, [fetchOrders]);

  const requestSync = useCallback(() => {
    if (syncTimerRef.current != null) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      if (document.hidden || busyOrderId) {
        missedSyncRef.current = true;
        return;
      }
      void fetchOrders('silent');
    }, PUSH_SYNC_DEBOUNCE_MS);
  }, [busyOrderId, fetchOrders]);

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
    enabled: status === 'signedIn' && !!isDriver && live,
    driver: true,
    getAccessToken,
    handlers: feedHandlers,
  });

  useEffect(() => {
    if (status !== 'signedIn' || !isDriver || !live) return;
    const interval = window.setInterval(() => {
      if (!wsUp && !document.hidden && !busyOrderId) void fetchOrders('silent');
    }, POLL_INTERVAL_MS);
    const visible = () => {
      if (!document.hidden) requestSync();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [status, isDriver, live, wsUp, busyOrderId, fetchOrders, requestSync]);

  async function advance(order: Order, next: { to: OrderStatus; labelKey: string }) {
    if (busyOrderId) return;
    setBusyOrderId(order.id);
    setError(null);
    const result = await authedCall(getAccessToken, logout, (token) =>
      api.setDriverOrderStatus(token, order.id, next.to),
    );
    if (result.ok) {
      setPage((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) => (item.id === order.id ? result.data : item)),
            }
          : current,
      );
      lastActionAtRef.current = Date.now();
    } else if (result.kind === 'error') {
      setError(tc('actionFailedPlain', { label: tc(next.labelKey), message: result.message }));
    }
    setBusyOrderId(null);
  }

  if (status === 'loading') {
    return <div className="mx-auto h-56 max-w-4xl animate-pulse rounded-2xl bg-stone-100" aria-busy="true" />;
  }

  if (status !== 'signedIn') {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-3xl" aria-hidden>🛵</p>
        <h1 className="mt-3 text-2xl font-extrabold">{tc('driverGateTitle')}</h1>
        <p className="mt-2 text-sm text-stone-500">{tc('driverGateBody')}</p>
        <Link href="/login?next=/driver" className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">{tc('signIn')}</Link>
      </div>
    );
  }

  if (!isDriver) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-3xl" aria-hidden>🔑</p>
        <h1 className="mt-3 text-2xl font-extrabold">{tc('driverAccessTitle')}</h1>
        <p className="mt-2 text-sm text-stone-500">{tc('driverAccessBody')}</p>
        <Link href="/" className="mt-6 inline-block rounded-xl border border-stone-300 px-5 py-2.5 text-sm font-semibold text-stone-700 hover:bg-stone-100">{tc('backToRestaurants')}</Link>
      </div>
    );
  }

  const transport = feedTransport({ live, wsUp, sseUp: false });
  const orders = page?.items ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">{tc('driverTitle')}</h1>
          <p className="mt-1 text-sm text-stone-500">{tc('driverSub')}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setLive((current) => !current)}
            aria-pressed={live}
            data-feed-transport={transport}
            className={`rounded-full px-3.5 py-2 text-xs font-bold ${live ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-200 text-stone-600'}`}
          >
            {live ? (wsUp ? tc('pillPush') : tc('pillPolling')) : tc('pillPaused')}
          </button>
          <button type="button" onClick={() => void fetchOrders('full')} className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100">{tc('refresh')}</button>
        </div>
      </div>

      {error && <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700" role="alert">{error}</p>}
      {syncIssue && <p className="mt-3 text-xs font-semibold text-amber-700" role="status">{t('syncIssueList', { message: syncIssue })}</p>}

      {loading && !page ? (
        <div data-testid="driver-loading" className="mt-6 space-y-3" aria-busy="true">
          {[0, 1].map((item) => <div key={item} className="h-48 animate-pulse rounded-2xl bg-stone-100" aria-hidden />)}
        </div>
      ) : loadFailed && !page ? (
        // A failed FIRST load is not an empty inbox — the empty card below
        // would claim the driver simply has nothing to do (session 91).
        loadFailed.down ? (
          <PortalOffline onRetry={() => void fetchOrders('full')} />
        ) : (
          <PortalLoadFailed message={loadFailed.message} onRetry={() => void fetchOrders('full')} />
        )
      ) : orders.length === 0 ? (
        <div data-testid="driver-empty" className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <p className="text-3xl" aria-hidden>📭</p>
          <h2 className="mt-3 text-lg font-bold">{t('driverEmptyTitle')}</h2>
          <p className="mt-1 text-sm text-stone-500">{t('driverEmptyBody')}</p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {orders.map((order) => {
            const orderStatus = order.status as OrderStatus;
            const next = NEXT_STATUS[orderStatus];
            return (
              <article key={order.id} data-testid={`driver-order-${order.code}`} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-extrabold">{order.code}</h2>
                    <p className="mt-1 text-sm font-semibold text-stone-700">{order.restaurant?.name ?? tc('restaurantLabel')}</p>
                  </div>
                  <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-bold text-stone-700">{tc(STATUS_KEY[orderStatus])}</span>
                </div>
                <time dateTime={order.createdAt} className="mt-2 block text-xs text-stone-500">{tc('assignedOrder', { time: formatTime(order.createdAt) })}</time>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl bg-stone-50 p-3">
                    <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{tc('dropOff')}</p>
                    <p className="mt-1 text-sm font-semibold text-stone-800">{order.customerName}</p>
                    <p className="mt-1 text-sm text-stone-700">{order.deliveryAddress}</p>
                    <p className="mt-1 text-sm text-stone-600">{order.contactPhone}</p>
                  </div>
                  <div className="rounded-xl bg-stone-50 p-3">
                    <p className="text-xs font-bold uppercase tracking-wide text-stone-500">{tc('itemsLabel')}</p>
                    <ul className="mt-1 space-y-1 text-sm text-stone-700">
                      {order.items.map((item) => <li key={item.id}>{item.quantity} × {item.name}</li>)}
                    </ul>
                  </div>
                </div>
                {order.note && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">{tc('notePrefix', { note: order.note })}</p>}
                {next && (
                  <button
                    type="button"
                    onClick={() => void advance(order, next)}
                    disabled={busyOrderId !== null}
                    aria-busy={busyOrderId === order.id}
                    className="mt-4 min-h-12 w-full rounded-xl bg-stone-900 px-4 py-3 text-sm font-extrabold text-white hover:bg-stone-700 disabled:cursor-wait disabled:opacity-50"
                  >
                    {busyOrderId === order.id ? tc('updatingDots') : tc(next.labelKey)}
                  </button>
                )}
              </article>
            );
          })}
          {page && page.total > page.items.length && (
            <p className="text-center text-xs font-semibold text-amber-700">{tc('driverCapped', { total: String(page.total) })}</p>
          )}
        </div>
      )}
    </div>
  );
}
