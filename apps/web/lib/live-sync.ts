/**
 * Pure decision helpers for the owner dashboard's live polling (Phase 2
 * item 4). Kept side-effect-free and out of the page component so the
 * logic is directly testable (`next build` compiles it; a standalone
 * `tsc` + node assertion run verifies behaviour).
 */

/** Poll cadence for the inbox, matching the roadmap's "every 10s". */
export const POLL_INTERVAL_MS = 10_000;

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
 * again), or a status action is in flight (its response already patched
 * the inbox; a racing GET could show a stale status for one interval).
 */
export function shouldPoll(opts: {
  live: boolean;
  hidden: boolean;
  busy: boolean;
}): boolean {
  return opts.live && !opts.hidden && !opts.busy;
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
