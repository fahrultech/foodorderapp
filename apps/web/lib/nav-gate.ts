/**
 * Settle-or-cancel discipline for the post-auth redirect (Phase 8 race item).
 *
 * The race (session 93, A/B-quantified ~1/5 on cold full-suite boots):
 * login/register success applies the session — which makes the role-gated
 * header links visible on the /login page itself — and only THEN dispatches
 * `router.replace(next)`. Between that dispatch and its commit there is a
 * window where a header-link click starts a competing navigation; when the
 * redirect's commit lands after the click's, the browser is dragged back to
 * the redirect target and the click is swallowed. A route-held redirect
 * whose FETCH lands after the click's commit is correctly discarded by the
 * router, but the fetch-done→commit-done render window cannot be widened
 * with network interception — that is the window that actually bit us.
 *
 * The gate closes it by construction: from submit start until the redirect
 * commits, the header nav is INERT, so no click can begin inside the flight
 * window at all; a held click simply waits and then lands as a clean
 * navigation. Release points:
 *   - the auth form's unmount — the redirect committed (normal path),
 *   - the submit's catch path — login/register failed, no redirect is coming,
 *   - a safety timeout, for the pathological never-commits case (a crafted
 *     `?next=/login` replace resolves to the same segment and never unmounts).
 *
 * The Header consumes this via useSyncExternalStore with an always-false
 * server snapshot, so first paint and hydration stay un-gated. The `inert`
 * attribute alone stops browser interaction, but the nav also carries
 * `pointer-events: none` while gated because that is what Playwright's
 * "receives events" actionability check waits on — the regression spec
 * relies on it to turn a would-be-swallowed click into a deterministic wait.
 */

/** Must exceed any sane auth round-trip; only pathological commits trip it. */
const NAV_GATE_SAFETY_MS = 8_000;

type Listener = () => void;

let gated = false;
let safetyTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of [...listeners]) listener();
}

/** Hold the header nav inert until the pending redirect settles. Idempotent; re-arming resets the safety window. */
export function engageNavGate(): void {
  gated = true;
  if (safetyTimer) clearTimeout(safetyTimer);
  safetyTimer = setTimeout(releaseNavGate, NAV_GATE_SAFETY_MS);
  publish();
}

export function releaseNavGate(): void {
  if (safetyTimer) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }
  if (!gated) return;
  gated = false;
  publish();
}

export function subscribeNavGate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isNavGated(): boolean {
  return gated;
}
