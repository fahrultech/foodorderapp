'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { POLL_INTERVAL_MS, PUSH_SYNC_DEBOUNCE_MS } from '@/lib/live-sync';
import { useOrderFeed } from '@/lib/use-order-feed';
import { isTerminalOrderStatus, type FeedEventPayload } from '@/lib/ws-feed';

/**
 * Live-updates island for the customer order tracking page (roadmap Phase 5,
 * "dashboard/order-tracking consume the WS feed"). The page itself stays a
 * server component — this client island only supplies the PUSH transport and
 * the indicator.
 *
 * How it keeps the page fresh, in the same transport ladder as the dashboard
 * (but customer-scoped, so SSE has no equivalent here — polling is the
 * fallback):
 *
 *  1. WS `u:<self>` room (useOrderFeed, `me` mode — the room id comes from the
 *     VERIFIED token, so a customer can only ever be woken by their own
 *     orders). An event whose orderId matches this page schedules a
 *     debounced router.refresh(): the server component re-runs its own GET,
 *     so the feed stays trigger-only and never carries truth.
 *  2. Fallback: while the feed is down, a 10s interval refresh (skipped for
 *     hidden tabs — the next visible moment catches up on the next tick).
 *  3. Guests and terminal orders (completed/cancelled can never change
 *     again): no transport, just the manual-reload hint — pre-existing UX.
 *
 * SSR-safety: the auth provider hydrates as 'loading' and no live state
 * exists until effects run, so the first client render emits exactly what the
 * server did. Terminal-ness is driven by the SERVER-RENDERED status prop, so
 * the island disappearing after the final transition is consistent on both
 * sides of hydration too.
 */
export default function OrderLiveFeed({
  orderId,
  orderStatus,
}: {
  orderId: string;
  orderStatus: string;
}) {
  const { status: authStatus, getAccessToken } = useAuth();
  const router = useRouter();
  // Coalescing timer: a burst of events (fast status moves) costs ONE refresh.
  const refreshTimerRef = useRef<number | null>(null);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current != null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      router.refresh();
    }, PUSH_SYNC_DEBOUNCE_MS);
  }, [router]);

  const terminal = isTerminalOrderStatus(orderStatus);
  const enabled = authStatus === 'signedIn' && !terminal;

  const onEvent = useCallback(
    (p: FeedEventPayload) => {
      if (p.orderId === orderId) scheduleRefresh();
    },
    [orderId, scheduleRefresh],
  );
  const handlers = useMemo(
    () => ({ onReady: scheduleRefresh, onEvent }),
    [scheduleRefresh, onEvent],
  );

  const { wsUp } = useOrderFeed({ enabled, me: true, getAccessToken, handlers });

  // Fallback transport: with the feed down, a signed-in customer still gets
  // 10s freshness via plain refreshes. Hidden tabs skip ticks; a push
  // transport that comes back up retires the interval immediately.
  useEffect(() => {
    if (!enabled || wsUp) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      if (refreshTimerRef.current != null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [enabled, wsUp, router]);

  if (terminal) return null;

  const live = authStatus === 'signedIn';
  const transport = live ? (wsUp ? 'ws' : 'poll') : 'none';

  return (
    <span
      role="status"
      data-feed-transport={transport}
      className="flex items-center gap-1.5 text-xs font-semibold text-stone-400"
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          live ? (wsUp ? 'animate-pulse bg-emerald-500' : 'bg-amber-400') : 'bg-stone-300'
        }`}
      />
      {!live
        ? 'Reload to check for updates'
        : wsUp
          ? 'Live — push feed connected'
          : 'Live — polling (push feed down)'}
    </span>
  );
}
