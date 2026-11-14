import { ApiError, isApiDown, isUnauthorized } from './api';

/**
 * Discriminated result of `authedCall`: callers branch on `ok` and, on
 * failure, on `kind` — `signedOut` failures are silent (the session provider
 * already cleared itself), `error` failures show a banner.
 *
 * Error failures carry `down` (session 91): network-level unreachable or a
 * 5xx answer says NOTHING about the data, so portal pages render the offline
 * card (ApiOffline parity) instead of a generic failure — and NEVER the
 * empty state a blank list would imply.
 */
export type AuthedResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'signedOut' }
  | { ok: false; kind: 'error'; message: string; down: boolean };

/**
 * One authed API call with the session-resilience both portal pages use:
 * on 401 rotate the refresh token once and retry; a second 401 signs this
 * device out. Extracted from `/dashboard` (session 12) so `/dashboard/menu`
 * shares the exact same behaviour.
 */
export async function authedCall<T>(
  getAccessToken: () => Promise<string | null>,
  logout: () => Promise<void>,
  fn: (token: string) => Promise<T>,
): Promise<AuthedResult<T>> {
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
            down: isApiDown(err2),
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
      down: isApiDown(err),
    };
  }
}
