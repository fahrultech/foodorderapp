'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { API_URL, ORDER_STATUSES, api, formatPrice } from '@/lib/api';
import { authedCall } from '@/lib/authed-call';
import type { Order, OrderStatus, Restaurant, RestaurantOrdersPage } from '@/lib/api';
import PortalTabs from '@/components/PortalTabs';
import StatusBadge from '@/components/StatusBadge';
import {
  POLL_INTERVAL_MS,
  PUSH_SYNC_DEBOUNCE_MS,
  STREAM_MAX_CONSECUTIVE_ERRORS,
  STREAM_STALL_MS,
  STREAM_TOKEN_REBUILD_MS,
  diffNewOrderIds,
  liveMode,
  orderStreamUrl,
  pollIsStaleVsAction,
  shouldPoll,
} from '@/lib/live-sync';
import { feedTransport, shouldOpenSse } from '@/lib/ws-feed';
import { useOrderFeed } from '@/lib/use-order-feed';

/**
 * Owner portal (Phase 2): orders inbox for the signed-in owner's restaurants,
 * with status actions (accept / start preparing / out for delivery / complete
 * / cancel) wired to PATCH /restaurants/:id/orders/:orderId/status — the API
 * scopes every call to the caller (JWT + owner role + ownership + flow check).
 *
 * Live updates (Phase 2 SSE + Phase 5 WS feed): the inbox keeps itself fresh
 * with THREE cooperating transports, in a strict ladder:
 *
 *  1. WS PUSH (primary): the Socket.IO `/orders` feed (useOrderFeed) joined
 *     to room `r:<restaurantId>` — trigger-only `order.created`/`order.updated`
 *     events fire a debounced SILENT refetch of the inbox (truth always comes
 *     from the normal GET, so events can never corrupt data, only accelerate
 *     it). The hook owns reconnect (backoff, fresh token) and rebuilds the
 *     handshake before the access TTL dies.
 *  2. SSE PUSH (fallback): an EventSource on GET /restaurants/:id/orders/stream
 *     — opened only while the WS feed is DOWN (shouldOpenSse), closed the
 *     moment WS recovers. Its `ping` heartbeat + stall watchdog work as before.
 *  3. POLL (last resort): the session-15 10s silent poll. Every tick checks
 *     `shouldPoll`, which goes idle while EITHER push transport is up — so the
 *     cadence is a pure safety net, never a second opinion fighting a push.
 *
 * `data-feed-transport` on the Live pill exposes which rung is live (ws/sse/
 * poll/paused) for humans, tests and future e2e assertions.
 *
 * A silent sync swaps the whole page (items + per-status tab counts) in
 * place, badges rows that newly appeared with NEW, and is skipped while the
 * tab is hidden or an action is in flight (a missed wake-up is remembered and
 * flushed the moment the gate opens again); returning to a hidden tab catches
 * up immediately. Sync failures only dim the Live pill ("retrying") — the
 * last good data and the manual refresh stay intact. The toggle pauses BOTH
 * transports (the stream connection is closed while paused).
 */

const PAGE_SIZE = 10;

type Filter = 'all' | OrderStatus;

/**
 * Owner-side action buttons per status. Mirrors STATUS_FLOW in the API, but
 * the server is the authority: anything illegal gets a 400 anyway. `kind`
 * only picks the styling (forward progression vs destructive cancel).
 */
const OWNER_ACTIONS: Record<
  OrderStatus,
  { to: OrderStatus; label: string; kind: 'primary' | 'danger' }[]
> = {
  pending: [
    { to: 'confirmed', label: '✓ Accept', kind: 'primary' },
    { to: 'cancelled', label: 'Cancel', kind: 'danger' },
  ],
  confirmed: [
    { to: 'preparing', label: 'Start preparing', kind: 'primary' },
    { to: 'cancelled', label: 'Cancel', kind: 'danger' },
  ],
  preparing: [
    { to: 'delivering', label: 'Out for delivery', kind: 'primary' },
    { to: 'cancelled', label: 'Cancel', kind: 'danger' },
  ],
  delivering: [{ to: 'completed', label: '✓ Mark completed', kind: 'primary' }],
  completed: [],
  cancelled: [],
};

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

/** HH:MM:SS label for the last successful sync (client-only value). */
function formatClock(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(ms));
  } catch {
    return '';
  }
}

function lineSummary(order: Order): string {
  const lines = order.items ?? [];
  if (lines.length === 0) return '—';
  return lines.map((l) => `${l.quantity} × ${l.name}`).join(', ');
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
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // --- live polling state (see file header) ---
  const [live, setLive] = useState(true);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [syncIssue, setSyncIssue] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(() => new Set());
  // Mirror of `data` for the silent tick (the poll closure must stay
  // identity-stable, so it reads the previous page through this ref).
  const dataRef = useRef<RestaurantOrdersPage | null>(null);
  // Wall-clock of the last successful status action; used to DROP a silent
  // poll that was fired before it but resolves after it (stale snapshot
  // would regress the card the owner just acted on).
  const lastActionAtRef = useRef(0);

  // --- SSE fallback push state (see file header) ---
  const [sseUp, setSseUp] = useState(false);
  // Coalescing timer for push-triggered syncs (PUSH_SYNC_DEBOUNCE_MS window).
  const syncTimerRef = useRef<number | null>(null);
  // A push wake-up arrived while the gate was closed (busy/hidden); flush it
  // as soon as the gate opens instead of letting the change go unnoticed
  // until the next event (which may never come) — the interval is idle while
  // the stream is up, so dropped wake-ups must be remembered.
  const missedPushRef = useRef(false);

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
  // Identity of the current view; responses that resolve after the owner
  // has switched restaurant/filter/page are DROPPED (they would otherwise
  // overwrite the fresh view with stale data — a pre-existing race the
  // polling feature must not amplify).
  const viewKey = selectedId ? `${selectedId}:${filter}:${page}` : '';
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;

  /** Single writer for the rendered inbox page + its ref mirror (diff baseline). */
  const applyPage = useCallback((next: RestaurantOrdersPage | null) => {
    dataRef.current = next;
    setData(next);
  }, []);

  /**
   * Fetch the current view once. `mode: 'full'` is the visible load
   * (skeleton + error banner) used on entry, restaurant/filter/page
   * changes and the manual refresh. `mode: 'silent'` is a polling tick:
   * the page is swapped in place (items + tab counts), NEW badges mark
   * rows that just appeared, and a failure only sets `syncIssue` — the
   * last good data stays on screen.
   */
  const fetchInbox = useCallback(
    async (mode: 'full' | 'silent') => {
      if (status !== 'signedIn' || !isOwnerish || !selectedId) return;
      if (mode === 'full') {
        setLoading(true);
        setError(null);
        setActionError(null);
      }
      const startedAt = Date.now();
      const myKey = viewKey;
      const res = await authedCall(getAccessToken, logout, (t) =>
        api.listRestaurantOrders(t, selectedId, {
          status: filter === 'all' ? undefined : filter,
          page,
          limit: PAGE_SIZE,
        }),
      );
      // The owner switched views while this was in flight — the view-change
      // effect already started a correct fetch; ignore this straggler.
      if (viewKeyRef.current !== myKey) return;
      if (res.ok) {
        if (
          mode === 'silent' &&
          pollIsStaleVsAction(startedAt, lastActionAtRef.current)
        ) {
          // An owner action landed after this poll was fired — its PATCH
          // response already updated the card. Applying the pre-action
          // snapshot would flash the old status; wait for the NEXT tick.
          return;
        }
        const prev = mode === 'silent' ? dataRef.current : null;
        setNewIds(
          prev
            ? new Set(
                diffNewOrderIds(
                  prev.items.map((o) => o.id),
                  res.data.items.map((o) => o.id),
                ),
              )
            : new Set<string>(),
        );
        applyPage(res.data);
        setLastSyncAt(Date.now());
        setSyncIssue(null);
        if (mode === 'full') setError(null);
      } else if (res.kind === 'error') {
        if (mode === 'full') setError(res.message);
        else setSyncIssue(res.message);
      }
      if (mode === 'full') setLoading(false);
    },
    [status, isOwnerish, selectedId, filter, page, viewKey, getAccessToken, logout, applyPage],
  );

  useEffect(() => {
    void fetchInbox('full');
  }, [fetchInbox, reloadKey]);

  // --- push-triggered sync (either feed wakes the inbox) ---
  // The wake-up EXECUTION always goes through syncFireRef, which the effect
  // below keeps pinned to the latest render's closures. Without this the
  // debounce timer would capture the closure of whichever render scheduled it
  // (e.g. the mount render, where selectedId is still null): a stale fire
  // guard-ours into nothing AND swallows every wake-up that arrives while the
  // zombie timer is still pending. WS makes that window easy to hit — the
  // mount catch-up and the first subscribe-ack wake-ups cluster inside one
  // 400ms debounce window (found by the live-feed e2e).
  const syncFireRef = useRef<() => void>(() => {});
  useEffect(() => {
    syncFireRef.current = () => {
      if (
        !shouldPoll({
          live,
          hidden: typeof document !== 'undefined' && document.hidden,
          busy: busyOrderId !== null,
        })
      ) {
        missedPushRef.current = true;
        return;
      }
      void fetchInbox('silent');
    };
  }, [live, busyOrderId, fetchInbox]);

  /**
   * Schedule one silent sync, coalescing bursts: any number of feed events
   * inside PUSH_SYNC_DEBOUNCE_MS costs a single inbox GET. Unlike the interval
   * tick this is NOT gated on `pushUp` — it *is* the push transports' data
   * path. When the gate is closed (hidden tab / action in flight) the
   * wake-up is remembered and flushed by the effects below once it opens.
   */
  const requestSync = useCallback(() => {
    if (syncTimerRef.current != null) return;
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      syncFireRef.current();
    }, PUSH_SYNC_DEBOUNCE_MS);
  }, []);

  // The EventSource handlers are bound once per connection; call through this
  // ref so they always see the current (filter/page/busy-aware) sync logic.
  const requestSyncRef = useRef<() => void>(() => {});
  useEffect(() => {
    requestSyncRef.current = requestSync;
  }, [requestSync]);

  // --- WS feed: the PRIMARY push transport (Phase 5) ---
  // Both feed callbacks are the same wake-up: a verified subscribe flushes
  // anything that changed while we were down, an order event requests a
  // debounced silent sync. Data truth stays exclusively in fetchInbox/GETs.
  const feedWake = useCallback(() => requestSyncRef.current(), []);
  const feedHandlers = useMemo(() => ({ onReady: feedWake, onEvent: feedWake }), [feedWake]);
  const { wsUp } = useOrderFeed({
    enabled: status === 'signedIn' && !!isOwnerish && !!selectedId && live,
    restaurantId: selectedId,
    getAccessToken,
    handlers: feedHandlers,
  });
  // "Push channel up" for the polling gate + the Live pill: WS first, SSE as
  // its fallback — while either is connected the 10s interval idles.
  const pushUp = wsUp || sseUp;

  // Flush a wake-up dropped while an action was in flight.
  useEffect(() => {
    if (busyOrderId === null && missedPushRef.current) {
      missedPushRef.current = false;
      requestSync();
    }
  }, [busyOrderId, requestSync]);

  // --- the SSE stream (FALLBACK push transport — see file header) ---
  // One EventSource per (restaurant, live toggle, WS up/down): it opens only
  // while the WS feed is down and is closed the moment WS recovers, so exactly
  // one push transport ever runs. The access token cannot go in an
  // EventSource header, so it rides the query string (server-side
  // SseJwtAuthGuard) and the connection is REBUILT with a fresh token before
  // the access TTL can expire — a stale-token reconnect loop is exactly what
  // the rebuild avoids. Liveness: any event (incl. the 15s `ping`) resets the
  // stall watchdog; two missed heartbeats = zombie stream → close, rebuild,
  // and the interval polling resumes in the meantime.
  useEffect(() => {
    if (status !== 'signedIn' || !isOwnerish || !selectedId || !shouldOpenSse({ live, wsUp })) {
      setSseUp(false);
      return;
    }
    let disposed = false;
    let es: EventSource | null = null;
    let stallTimer: number | null = null;
    let retryTimer: number | null = null;
    let errors = 0;

    const clearTimers = () => {
      if (stallTimer != null) window.clearTimeout(stallTimer);
      if (retryTimer != null) window.clearTimeout(retryTimer);
      stallTimer = retryTimer = null;
    };
    const armStallWatchdog = () => {
      if (stallTimer != null) window.clearTimeout(stallTimer);
      stallTimer = window.setTimeout(() => {
        // No event (not even a ping) for 2 heartbeat cycles: the connection
        // is a zombie. Fall back to polling and try a fresh connection.
        setSseUp(false);
        errors = 0;
        if (es) es.close();
        retryTimer = window.setTimeout(() => void connect(), POLL_INTERVAL_MS);
      }, STREAM_STALL_MS);
    };

    const connect = async () => {
      if (disposed) return;
      const token = await getAccessToken();
      if (disposed || !token) return;
      const source = new EventSource(orderStreamUrl(API_URL, selectedId, token));
      es = source;
      const mine = () => !disposed && es === source;
      const touch = () => {
        if (mine()) armStallWatchdog();
      };
      source.onopen = () => {
        if (!mine()) return;
        errors = 0;
        touch();
      };
      source.onerror = () => {
        if (!mine()) return;
        setSseUp(false);
        // readyState CLOSED = the browser gave up (4xx auth/ownership);
        // otherwise it retries internally with the SAME url token.
        if (source.readyState === EventSource.CLOSED || ++errors >= STREAM_MAX_CONSECUTIVE_ERRORS) {
          source.close();
          if (retryTimer == null) {
            retryTimer = window.setTimeout(() => {
              retryTimer = null;
              void connect();
            }, POLL_INTERVAL_MS);
          }
        }
      };
      // 'hello' = stream proven working end-to-end (headers + first write).
      source.addEventListener('hello', () => {
        if (!mine()) return;
        errors = 0;
        setSseUp(true);
        touch();
        // Catch up anything missed between the last sync and this connect.
        requestSyncRef.current();
      });
      for (const type of ['order.created', 'order.updated'] as const) {
        source.addEventListener(type, () => {
          if (!mine()) return;
          touch();
          requestSyncRef.current();
        });
      }
      source.addEventListener('ping', touch);
      armStallWatchdog();
    };

    void connect();
    // Periodic rebuild with a fresh token, long before the 30m access TTL.
    const rebuild = window.setInterval(() => void connect(), STREAM_TOKEN_REBUILD_MS);
    return () => {
      disposed = true;
      clearTimers();
      window.clearInterval(rebuild);
      if (es) es.close();
      setSseUp(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isOwnerish, selectedId, live, wsUp]);

  // --- the 10s polling tick (fallback transport) ---
  // One interval per (restaurant, live toggle); the callback it fires is
  // swapped through `tickRef` so changing filter/page/busy never re-creates
  // the interval (which would reset the 10s phase and could stack ticks).
  // While the SSE stream is up, ticks go idle — push is the live transport.
  const tick = useCallback(() => {
    if (
      !shouldPoll({
        live,
        hidden: typeof document !== 'undefined' && document.hidden,
        busy: busyOrderId !== null,
        pushUp,
      })
    ) {
      return;
    }
    void fetchInbox('silent');
  }, [live, busyOrderId, pushUp, fetchInbox]);

  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    if (status !== 'signedIn' || !isOwnerish || !selectedId || !live) return;
    const id = window.setInterval(() => tickRef.current(), POLL_INTERVAL_MS);
    // Catch up the moment the tab becomes visible again (syncs are skipped
    // while hidden, so the owner doesn't stare at a stale inbox). Route
    // through requestSync, not the interval tick: with push up, ticks idle.
    const onVisible = () => {
      if (!document.hidden) requestSyncRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, isOwnerish, selectedId, live]);

  // Immediate catch-up when Live is switched back on — after pausing, the
  // owner shouldn't have to wait a full interval for the inbox to refresh.
  // (On initial mount this is a harmless extra fetch of the same view.)
  useEffect(() => {
    if (live) requestSyncRef.current();
  }, [live]);

  // Reset paging + selection-safe filter when the restaurant changes.
  function switchRestaurant(id: string) {
    setSelectedId(id);
    setPage(1);
    setFilter('all');
    applyPage(null);
  }

  /**
   * Fire an owner status action. On success the inbox is patched IN PLACE
   * (item status + the two affected tab counts) instead of refetching — one
   * card moving between tabs is cheap to track locally, and a stale refetch
   * could flash the old state. One action at a time: every button disables
   * while a PATCH is in flight. The completion timestamp also makes any
   * silent poll that STARTED before it (and would resolve with the
   * pre-action snapshot) get dropped by `fetchInbox`.
   */
  async function act(order: Order, action: { to: OrderStatus; label: string }) {
    if (!selectedId || busyOrderId) return;
    setBusyOrderId(order.id);
    setActionError(null);
    const res = await authedCall(getAccessToken, logout, (t) =>
      api.setRestaurantOrderStatus(t, selectedId, order.id, action.to),
    );
    if (res.ok) {
      const d = dataRef.current;
      if (d) {
        const from = order.status as OrderStatus;
        applyPage({
          ...d,
          items: d.items.map((o) => (o.id === order.id ? { ...o, status: action.to } : o)),
          counts: {
            ...d.counts,
            [from]: Math.max(0, d.counts[from] - 1),
            [action.to]: d.counts[action.to] + 1,
          },
        });
      }
      lastActionAtRef.current = Date.now();
    } else if (res.kind === 'error') {
      setActionError(`"${action.label}" failed: ${res.message}`);
    }
    setBusyOrderId(null);
  }

  const selected = useMemo(
    () => (restaurants ?? []).find((r) => r.id === selectedId) ?? null,
    [restaurants, selectedId],
  );

  const inboxTotal = data
    ? Object.values(data.counts).reduce((a, b) => a + b, 0)
    : null;

  const mode = liveMode({ live, pushUp, syncIssue });
  const transport = feedTransport({ live, wsUp, sseUp });

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
        <PortalTabs />
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
            Incoming orders for {selected?.name ?? 'your restaurant'} · act on each order as it
            moves through the kitchen
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Live indicator (which transport keeps the inbox fresh) + pause. */}
          <button
            onClick={() => setLive((v) => !v)}
            aria-pressed={live}
            data-feed-transport={transport}
            title={
              live
                ? wsUp
                  ? 'Live updates on — the inbox follows the WebSocket feed (SSE/polling on standby). Click to pause.'
                  : sseUp
                    ? 'Live updates on — the WebSocket feed is down, so the SSE stream is the push transport. Click to pause.'
                    : 'Live updates on — no push transport is connected, so the inbox re-polls every 10s. Click to pause.'
                : 'Live updates paused — click to resume the WebSocket feed (SSE and 10s polling as fallbacks).'
            }
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
              mode === 'paused'
                ? 'bg-stone-200 text-stone-600 hover:bg-stone-300'
                : mode === 'retrying'
                  ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                  : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
            }`}
          >
            <span
              aria-hidden
              className={`h-2 w-2 rounded-full ${
                mode === 'paused'
                  ? 'bg-stone-400'
                  : mode === 'retrying'
                    ? 'bg-amber-500'
                    : 'animate-pulse bg-emerald-500'
              }`}
            />
            {mode === 'paused'
              ? 'Paused'
              : mode === 'retrying'
                ? 'Live · retrying'
                : mode === 'push'
                  ? 'Live · push'
                  : 'Live'}
          </button>
          {lastSyncAt != null && (
            <span className="text-xs text-stone-500" title="Last successful inbox sync">
              updated {formatClock(lastSyncAt)}
            </span>
          )}
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Portal section nav (shared with /dashboard/menu) */}
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

      {actionError && (
        <p
          className="mt-4 rounded-xl bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-800"
          role="alert"
        >
          {actionError}
        </p>
      )}

      {/* A polling tick failed but the last good inbox stays visible; the
          next tick (or ↻ Refresh) will recover. Shown via the amber Live
          pill too — this line adds the reason once. */}
      {syncIssue && data && (
        <p className="mt-4 text-xs font-semibold text-amber-700" role="status">
          Live update failed ({syncIssue}) — showing the last successful sync; the next push
          event or tick will retry.
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
                    {newIds.has(order.id) && (
                      <span
                        role="status"
                        aria-label="New order since last sync"
                        className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-sky-800"
                      >
                        New
                      </span>
                    )}
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
                  <div className="flex flex-wrap items-center gap-2">
                    {(OWNER_ACTIONS[order.status as OrderStatus] ?? []).map((a) => (
                      <button
                        key={a.to}
                        onClick={() => void act(order, a)}
                        disabled={busyOrderId !== null}
                        aria-busy={busyOrderId === order.id}
                        className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors disabled:cursor-wait disabled:opacity-50 ${
                          a.kind === 'primary'
                            ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                            : 'border border-rose-200 bg-white text-rose-700 hover:bg-rose-50'
                        }`}
                      >
                        {busyOrderId === order.id ? '…' : a.label}
                      </button>
                    ))}
                    <Link
                      href={`/orders/${order.id}`}
                      className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-stone-700"
                    >
                      Details
                    </Link>
                  </div>
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
