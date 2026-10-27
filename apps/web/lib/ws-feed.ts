/**
 * Pure decision helpers for the Socket.IO order feed (roadmap Phase 5:
 * "Web: dashboard/order-tracking consume the WS feed — SSE stays the
 * fallback"). Kept side-effect-free and OUT of the hook so the logic is
 * directly testable (`next build` compiles it; a standalone tsc + node
 * assertion run verifies behaviour — same pattern as live-sync.ts).
 *
 * The server contract lives in apps/api/src/orders/realtime.gateway.ts:
 * namespace `/orders` on the SAME HTTP server as the REST API, handshake
 * auth `{ token }`, trigger-only `order.created`/`order.updated` payloads,
 * subscribe acks `{ ok }`.
 */

/** Socket.IO namespace the API mounts on its HTTP server. */
export const WS_FEED_NAMESPACE = '/orders';

/** Reconnect backoff: 1.5s doubling per failed attempt, capped. */
export const WS_RECONNECT_BASE_MS = 1_500;
export const WS_RECONNECT_CAP_MS = 15_000;

/**
 * How long to wait for a subscribe ACK after the socket connects before
 * declaring the connection useless and rebuilding it. The gateway answers
 * every subscribe synchronously after its checks; silence means a middlebox
 * ate the connection or the server died mid-handshake.
 */
export const WS_SUBSCRIBE_ACK_MS = 5_000;

/** Trigger-only event payload (identity + status — never trusted as truth). */
export interface FeedEventPayload {
  orderId: string;
  code: string;
  status: string;
}

/**
 * Connection URL for the feed: the API's ORIGIN plus the namespace. API_URL
 * ends in `/api`; Socket.IO resolves `origin/orders` against the default
 * `/socket.io/` path on that same HTTP server.
 */
export function wsFeedUrl(apiUrl: string): string {
  const u = new URL(apiUrl);
  return `${u.origin}${WS_FEED_NAMESPACE}`;
}

/** Exponential reconnect delay for failed attempt `attempt` (0-based). */
export function wsReconnectDelayMs(attempt: number): number {
  const exp = Math.max(0, Math.min(Number.isFinite(attempt) ? attempt : 0, 10));
  return Math.min(WS_RECONNECT_BASE_MS * 2 ** exp, WS_RECONNECT_CAP_MS);
}

/**
 * Gate for the SSE stream on the dashboard: it is now the FALLBACK push
 * transport — it only opens while live updates are wanted AND the WS feed is
 * down (paused closes both, matching the pre-existing pause semantics).
 */
export function shouldOpenSse(opts: { live: boolean; wsUp: boolean }): boolean {
  return opts.live && !opts.wsUp;
}

/**
 * Which transport is actually keeping the view live right now — rendered as
 * `data-feed-transport` (and the basis of the Live pill copy). Precedence is
 * the transport ladder: WS push > SSE fallback > 10s polling. `paused` means
 * the owner toggled live updates off (WS and SSE both closed; the interval
 * tick is gated too).
 */
export type FeedTransport = 'ws' | 'sse' | 'poll' | 'paused';

export function feedTransport(opts: {
  live: boolean;
  wsUp: boolean;
  sseUp: boolean;
}): FeedTransport {
  if (!opts.live) return 'paused';
  if (opts.wsUp) return 'ws';
  if (opts.sseUp) return 'sse';
  return 'poll';
}

/** Statuses after which an order can never change again. */
export const TERMINAL_ORDER_STATUSES: readonly string[] = ['completed', 'cancelled'];

export function isTerminalOrderStatus(status: string): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}
