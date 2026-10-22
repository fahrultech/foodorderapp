/**
 * Pure decision helpers for the owner dashboard's live polling (Phase 2
 * item 4). Kept side-effect-free and out of the page component so the
 * logic is directly testable (`next build` compiles it; a standalone
 * `tsc` + node assertion run verifies behaviour).
 */

/** Poll cadence for the inbox, matching the roadmap's "every 10s". */
export const POLL_INTERVAL_MS = 10_000;

/**
 * Coalescing window for syncs triggered by SSE push events: one inbox
 * refetch per window no matter how many events arrive (a busy kitchen firing
 * 5 status moves in a second costs ONE GET, not five).
 */
export const PUSH_SYNC_DEBOUNCE_MS = 400;

/**
 * Push-channel liveness budget. The API stream emits a `ping` every 15s
 * (ORDER_STREAM_HEARTBEAT_MS in apps/api/src/orders/order-events.service.ts);
 * two missed intervals mean the connection is a zombie (a proxy quietly ate
 * it), so the page declares the stream down, resumes interval polling, and
 * rebuilds. Duplicated on purpose — web and api are separate compilation
 * units and cannot share the server constant.
 */
export const STREAM_STALL_MS = 30_000;

/**
 * EventSource cannot rotate an Authorization header, so the access token goes
 * into the stream URL as a query param. Rebuild the connection (with a fresh
 * token from the auth provider) well before the default 30m access TTL dies —
 * a reconnect storm on an expired URL token is exactly what this avoids.
 */
export const STREAM_TOKEN_REBUILD_MS = 15 * 60_000;

/** EventSource auto-reconnect delay is ~3s; after this many consecutive
 * errors the page closes and rebuilds the stream with a fresh token. */
export const STREAM_MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Full URL of a restaurant's SSE order stream. `base` is the API URL (ends in
 * /api); the token is percent-encoded because JWTs are URL-safe but the
 * encoding keeps the builder honest for any token shape.
 */
export function orderStreamUrl(
  base: string,
  restaurantId: string,
  accessToken: string,
): string {
  const trimmed = base.replace(/\/+$/, '');
  const qs = `access_token=${encodeURIComponent(accessToken)}`;
  return `${trimmed}/restaurants/${encodeURIComponent(restaurantId)}/orders/stream?${qs}`;
}

/**
 * Ids present in `next` but absent from `prev` — the rows a silent poll
 * should badge as NEW. Order of `next` is preserved.
 */
export function diffNewOrderIds(
  prevIds: readonly string[],
  nextIds: readonly string[],
): string[] {
  const seen = new Set(prevIds);
  return nextIds.filter((id) => !seen.has(id));
}

/**
 * Gate for one polling tick. A tick is skipped when live updates are
 * paused by the owner, the browser tab is hidden (no pointless traffic —
 * `visibilitychange` fires a catch-up sync the moment the tab is seen
 * again), a status action is in flight (its response already patched the
 * inbox; a racing GET could show a stale status for one interval), or the
 * SSE push channel is connected (`pushUp`) — then the server tells us the
 * moment something changes and the 10s poll goes idle as pure fallback.
 */
export function shouldPoll(opts: {
  live: boolean;
  hidden: boolean;
  busy: boolean;
  pushUp?: boolean;
}): boolean {
  return opts.live && !opts.hidden && !opts.busy && !opts.pushUp;
}

/**
 * Which transport is actually keeping the inbox live right now — drives the
 * Live pill label. `retrying` wins when the last sync attempt failed (an
 * amber hint that data may lag); otherwise the connected transport decides.
 */
export function liveMode(opts: {
  live: boolean;
  pushUp: boolean;
  syncIssue: string | null;
}): 'paused' | 'retrying' | 'push' | 'poll' {
  if (!opts.live) return 'paused';
  if (opts.syncIssue) return 'retrying';
  return opts.pushUp ? 'push' : 'poll';
}

/**
 * Stale-response guard: true when a silent poll that STARTED at
 * `fetchStartedAt` must be dropped because a status action succeeded at
 * `actionCompletedAt` AFTER the fetch was fired — the fetched page was
 * priced/read before the PATCH landed, so applying it would visibly
 * regress the card the owner just acted on.
 */
export function pollIsStaleVsAction(
  fetchStartedAt: number,
  actionCompletedAt: number,
): boolean {
  return actionCompletedAt > fetchStartedAt;
}
