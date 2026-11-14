'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import {
  ApiError,
  CANCELABLE_STATUSES,
  ORDER_STATUSES,
  api,
  formatPrice,
  isUnauthorized,
} from '@/lib/api';
import type { MyOrdersPage as MyOrdersData, Order, OrderStatus } from '@/lib/api';
import StatusBadge from '@/components/StatusBadge';
import { useTranslations } from 'next-intl';

const PAGE_SIZE = 10;
/** Silent background refresh cadence while the tab is open (status badges stay live). */
const POLL_MS = 30_000;

type Filter = 'all' | OrderStatus;

/** Tab order for the status filter (mirrors the dashboard's APG tab list). */
const FILTER_TABS = ['all', ...ORDER_STATUSES] as Filter[];

/** Capitalization map for the Portal.status* keys — the dashboard idiom (session 92). */
const STATUS_CAP: Record<OrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  delivering: 'Delivering',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function queryParams(filter: Filter, page: number) {
  return {
    status: filter === 'all' ? undefined : filter,
    page,
    limit: PAGE_SIZE,
  };
}

/** The head line keeps the technical `qty × name (opts)` shape; the "+N more"
 *  suffix and the empty-state dash are translated at render time. */
function itemParts(order: Order): { head: string; extra: number } | null {
  const lines = order.items ?? [];
  if (lines.length === 0) return null;
  const head = lines
    .slice(0, 2)
    .map((l) =>
      l.optionSelections && l.optionSelections.length > 0
        ? `${l.quantity} × ${l.name} (${l.optionSelections.map((x) => x.choiceName).join(', ')})`
        : `${l.quantity} × ${l.name}`,
    )
    .join(', ');
  return { head, extra: lines.length > 2 ? lines.length - 2 : 0 };
}

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

export default function MyOrdersPage() {
  const t = useTranslations('Portal');
  const { status, user, getAccessToken, logout } = useAuth();
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<MyOrdersData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /** Tab elements by filter value — the keyboard handler moves focus through them. */
  const tabRefs = useRef(new Map<Filter, HTMLButtonElement>());

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      let token = await getAccessToken();
      if (!token) {
        // Session vanished between render and here (e.g. revocation sweep).
        if (!silent) {
          setLoading(false);
          setError(t('histErrSessionEnded'));
        }
        return;
      }
      const call = () => api.listMyOrders(token!, queryParams(filter, page));
      try {
        const out = await call();
        setData(out);
        if (!silent) setError(null);
      } catch (err) {
        if (isUnauthorized(err)) {
          // Token may be revoked server-side while still "fresh" locally:
          // rotate once and retry; a second 401 signs this device out.
          token = await getAccessToken();
          try {
            if (token) {
              setData(await api.listMyOrders(token, queryParams(filter, page)));
              if (!silent) setError(null);
              return;
            }
          } catch (err2) {
            if (!isUnauthorized(err2)) {
              if (!silent) setError(err2 instanceof ApiError ? err2.message : t('histErrApiShort'));
              return;
            }
            await logout(); // terminal 401 -> guest; the sign-in prompt renders
            return;
          }
          await logout();
          return;
        }
        if (!silent) {
          setError(err instanceof ApiError ? err.message : t('histErrApiQuestion'));
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filter, page, getAccessToken, logout],
  );

  function summaryText(order: Order): string {
    const parts = itemParts(order);
    if (!parts) return t('dash');
    return parts.extra > 0
      ? `${parts.head} ${t('histMoreItems', { count: parts.extra })}`
      : parts.head;
  }

  // Initial/manual load on auth, filter, page or refresh changes.
  useEffect(() => {
    if (status !== 'signedIn') return;
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, filter, page, reloadKey]);

  // Light polling keeps badges live without a full skeleton flicker.
  useEffect(() => {
    if (status !== 'signedIn') return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [status, load]);

  async function cancelOrder(order: Order) {
    if (!window.confirm(t('histConfirmCancel', { code: order.code, price: formatPrice(order.totalCents) }))) {
      return;
    }
    const token = await getAccessToken();
    if (!token) return;
    setBusyId(order.id);
    setError(null);
    try {
      await api.cancelOrder(token, order.id);
      setNotice(t('histNoticeCancelled', { code: order.code }));
      await load(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? t('histCouldNotCancel', { code: order.code, message: err.message })
          : t('histErrNotCancelled'),
      );
    } finally {
      setBusyId(null);
    }
  }

  // 'loading' renders identically on server and first client paint (hydration-safe).
  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="h-8 w-44 animate-pulse rounded-lg bg-stone-200" aria-hidden />
        <div className="mt-6 space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </div>
      </div>
    );
  }

  if (status !== 'signedIn') {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-2xl">🧾</p>
        <h1 className="mt-2 text-xl font-bold">{t('histGateTitle')}</h1>
        <p className="mt-1 text-sm text-stone-500">{t('histGateBody')}</p>
        <Link
          href="/login?next=/orders/my"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {t('signIn')}
        </Link>
      </div>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">{t('histTitle')}</h1>
          <p className="mt-1 text-sm text-stone-500">
            {user ? t('histSubEmail', { email: user.email }) : t('histSubPlain')}
          </p>
        </div>
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
        >
          {t('refresh')}
        </button>
      </div>

      {/* Status filter chips. a11y pass #2 (session 81): upgraded from bare
          role=tab buttons (the dashboard's session-78 shape was the point)
          to the full APG tabs pattern — roving tabindex, Arrow/Home/End
          move+select, aria-controls wired to the results tabpanel below. */}
      <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label={t('filterTabsAria')}>
        {FILTER_TABS.map((s, i) => (
          <button
            key={s}
            id={`orders-tab-${s}`}
            role="tab"
            aria-selected={filter === s}
            aria-controls="orders-panel"
            tabIndex={filter === s ? 0 : -1}
            ref={(el) => {
              if (el) tabRefs.current.set(s, el);
              else tabRefs.current.delete(s);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End')
                return;
              e.preventDefault();
              const last = FILTER_TABS.length - 1;
              const next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? last
                    : e.key === 'ArrowRight'
                      ? i + 1 > last
                        ? 0
                        : i + 1
                      : i - 1 < 0
                        ? last
                        : i - 1;
              const target = FILTER_TABS[next];
              setFilter(target);
              setPage(1);
              setNotice(null);
              tabRefs.current.get(target)?.focus();
            }}
            onClick={() => {
              setFilter(s);
              setPage(1);
              setNotice(null);
            }}
            className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors ${
              filter === s
                ? 'bg-stone-900 text-white'
                : 'border border-stone-300 bg-white text-stone-600 hover:bg-stone-100'
            }`}
          >
            {s === 'all' ? t('tabAll') : t(`status${STATUS_CAP[s as OrderStatus]}`)}
          </button>
        ))}
      </div>

      {notice && (
        <p role="status" className="mt-4 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-800">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-700">
          <span>{error}</span>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="shrink-0 rounded-lg border border-rose-200 bg-white px-3 py-1 text-xs font-bold text-rose-700 hover:bg-rose-50"
          >
            {t('tryAgain')}
          </button>
        </p>
      )}

      {/* The status tabs' aria-controls target (same contract as the
          dashboard inbox): one labelled panel holding skeleton, empty state,
          or the list + pagination. */}
      <div
        role="tabpanel"
        id="orders-panel"
        aria-labelledby={`orders-tab-${filter}`}
        tabIndex={-1}
      >
      {loading && !data ? (
        <div className="mt-6 space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <p className="text-2xl">🍽️</p>
          <h2 className="mt-2 text-lg font-bold">
            {filter === 'all'
              ? t('emptyAllTitle')
              : t('emptyStatusTitle', { status: t(`word${STATUS_CAP[filter as OrderStatus]}`) })}
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            {filter === 'all' ? t('histEmptyAllBody') : t('histEmptyStatusBody')}
          </p>
          <Link
            href="/"
            className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {t('histFindFood')}
          </Link>
        </div>
      ) : data ? (
        <>
          <div className="mt-6 space-y-4">
            {data.items.map((order) => {
              const cancelable = CANCELABLE_STATUSES.has(order.status as OrderStatus);
              return (
                <div
                  key={order.id}
                  className="rounded-2xl border border-stone-200 bg-white p-5"
                  data-testid={`order-card-${order.code}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="font-bold">{order.code}</span>
                      <StatusBadge status={order.status} />
                    </div>
                    <span className="text-xs text-stone-500">{formatDateTime(order.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-stone-700">
                    {order.restaurant?.name ?? t('restaurantLabel')}
                    {order.restaurant?.cuisine ? ` · ${order.restaurant.cuisine}` : ''}
                  </p>
                  <p className="mt-1 truncate text-sm text-stone-500">{summaryText(order)}</p>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-stone-100 pt-3">
                    <span className="text-sm font-extrabold">{formatPrice(order.totalCents)}</span>
                    <div className="flex items-center gap-2">
                      {cancelable && (
                        <button
                          onClick={() => void cancelOrder(order)}
                          disabled={busyId === order.id}
                          className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                        >
                          {busyId === order.id ? t('histCancelling') : t('histCancelOrder')}
                        </button>
                      )}
                      <Link
                        href={`/orders/${order.id}${order.contactEmail ? `?email=${encodeURIComponent(order.contactEmail)}` : ''}`}
                        className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-stone-700"
                      >
                        {t('details')}
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div className="mt-6 flex items-center justify-between">
            <p className="text-sm text-stone-500">
              {t('pagination', {
                page: data.page,
                totalPages,
                count: data.total,
                unit: data.total === 1 ? t('unitOrder') : t('unitOrders'),
                status: '',
              })}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={data.page <= 1}
                className="rounded-lg border border-stone-300 bg-white px-4 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-40"
              >
                {t('prevPage')}
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={data.page >= totalPages}
                className="rounded-lg border border-stone-300 bg-white px-4 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-40"
              >
                {t('nextPage')}
              </button>
            </div>
          </div>
        </>
      ) : null}
      </div>
    </div>
  );
}
