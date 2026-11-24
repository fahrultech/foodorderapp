import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import {
  MIXED_LEGS,
  isStrongEtag,
  mixSearchUrl,
  mixedLegKind,
  mixedProfile,
  thresholds,
} from './load-test.lib.mjs';

/**
 * Mixed hit/miss RATIO workload (session 128, Phase 14 #1 — closes session
 * 104's "intermediates" leftover). Companion of load-test.js (near-all-
 * capture fleet) and load-test-conditional.js (capture + revalidation):
 * this profile cycles THREE request classes per iteration on the SAME
 * freshly-discovered URL, giving a long-run 1 miss : 1 revalidation : 1
 * served composition:
 *
 *   capture    — unconditional GET on a per-(VU,iteration) UNIQUE
 *                `/search?q=` URL. Always a real miss: the handler runs,
 *                the bytes are captured, the store gains one entry.
 *                MUST answer 200 with a strong ETag + Cache-Control.
 *   revalidate — If-None-Match with the just-captured tag. Within the
 *                resident window the handler NEVER runs: MUST be 304 with
 *                an empty body and the echoed tag. A 200 here is not a
 *                failure — it is the honest eviction/TTL-edge signal,
 *                counted in revalidate_answered_200 (never hidden).
 *   recycle    — the SAME URL again, unconditionally. The store entry is
 *                fresh: 200 served with the full bytes, ZERO SQL. This is
 *                the class the browse profile only visits by accident
 *                (fixed-pool repeats) and the conditional profile skips.
 *
 * Expected server cost (the statement-window cross-check pins this):
 * ~2 statements per ITERATION (the capture leg of a non-matching q —
 * session 126's flood truth) and ~0 for the other two legs, so
 * stmt/req ≈ (statements per capture) / 3. The store is bounded (500
 * entries, evict-oldest): at plateau insert rates a just-captured key
 * stays resident for seconds, so the revalidate/recycle legs ride the
 * entry — the whole point of session 126's KEEP decision, now measured
 * at load shape.
 *
 * RUN_TAG is REQUIRED (lowercase alphanumeric): it keys the unique q so
 * reruns never share store entries with an earlier arm. Forgetting it is
 * a loud abort, never a silent warm-cache lie.
 *
 * Like the conditional profile, all legs send `Accept-Encoding: gzip`
 * (session 108: k6 defaults to identity — browser-shaped traffic is what
 * this fleet is modeling). k6 answers header names CANONICALIZED over the
 * JS bridge: read res.headers['Etag'], not 'ETag' (session 104 trap).
 */

const baseUrl = (__ENV.BASE_URL || 'http://localhost:4000/api').replace(/\/$/, '');
const profile = __ENV.PROFILE || 'smoke';
const runTag = __ENV.RUN_TAG || '';

export const options = {
  scenarios: mixedProfile(profile),
  thresholds,
  discardResponseBodies: false,
  userAgent: 'foodorder-k6-mixed',
};

// Per-class latency splits (same doctrine as capture_ms/replay_ms, session 108).
export const miss_ms = new Trend('miss_ms', true);
export const revalidate_ms = new Trend('revalidate_ms', true);
export const served_ms = new Trend('served_ms', true);

// Response-class counters — summary-export exposes them under `.count`
// (session 126 correction), never `.value`.
export const captured = new Counter('captured');
export const revalidate_304 = new Counter('revalidate_304');
export const revalidate_answered_200 = new Counter('revalidate_answered_200');
export const served_200 = new Counter('served_200');

export function setup() {
  if (!/^[a-z0-9]+$/.test(runTag)) {
    exec.test.abort(
      `RUN_TAG must be set to a lowercase alphanumeric token (got "${runTag}") — ` +
        'unique q keys depend on it; reruns on one store must not share entries',
    );
  }
  // Loud target sanity: the bootstrap list read must answer 200 JSON.
  const response = http.get(`${baseUrl}/restaurants?sort=rating&limit=20`, {
    tags: { endpoint: 'restaurants-bootstrap' },
  });
  const ok = check(response, {
    'bootstrap status is 200': (res) => res.status === 200,
  });
  if (!ok) exec.test.abort(`Bootstrap failed with HTTP ${response.status}`);
  return {};
}

export default function mixed() {
  const vu = exec.vu.idInTest;
  const iteration = exec.scenario.iterationInInstance;
  const url = `${baseUrl}${mixSearchUrl(runTag, vu, iteration)}`;
  let captureEtag = null; // set by the 'capture' leg before any other leg reads it

  // The leg ORDER and identity come from the pure helper (the contract
  // test pins 'capture' first), so this loop and the library can never
  // silently drift apart.
  for (let leg = 0; leg < MIXED_LEGS.length; leg += 1) {
    const kind = mixedLegKind(leg);

    if (kind === 'capture') {
      // --- true miss: handler runs, bytes get captured -------------------
      const capture = http.get(url, {
        headers: { 'Accept-Encoding': 'gzip' },
        tags: { endpoint: 'search', mode: 'capture' },
      });
      miss_ms.add(capture.timings.duration);
      captured.add(1);
      const captureOk = check(capture, {
        'capture status is 200': (res) => res.status === 200,
        'capture is JSON': (res) => String(res.headers['Content-Type'] || '').includes('application/json'),
        'capture carries a strong ETag': (res) => isStrongEtag(res.headers['Etag']),
        'capture declares Cache-Control public': (res) =>
          /^public, max-age=\d+$/.test(String(res.headers['Cache-Control'] || '')),
      });
      if (!captureOk) {
        exec.test.abort(
          `Capture of ${url} answered ${capture.status} without a cacheable strong ETag — ` +
            'check HTTP_CACHE_TTL_SEC and that /api/search is still session-103 whitelisted',
        );
      }
      captureEtag = capture.headers['Etag'];
    } else if (kind === 'revalidate') {
      // --- resident hit -> 304, empty body --------------------------------
      const revalidate = http.get(url, {
        headers: { 'If-None-Match': captureEtag, 'Accept-Encoding': 'gzip' },
        tags: { endpoint: 'search', mode: 'revalidate' },
      });
      revalidate_ms.add(revalidate.timings.duration);
      const revalOk = check(revalidate, {
        'revalidate is 304 or 200 (edge re-read)': (res) => res.status === 304 || res.status === 200,
        'revalidate echoes the same ETag': (res) => res.headers['Etag'] === captureEtag,
        '304 sends no body': (res) => res.status !== 304 || !res.body || res.body.length === 0,
      });
      if (!revalOk) {
        exec.test.abort(`Revalidation of ${url} answered ${revalidate.status} — contract violated`);
      }
      if (revalidate.status === 304) revalidate_304.add(1);
      else revalidate_answered_200.add(1);
    } else if (kind === 'recycle') {
      // --- unconditional repeat -> served 200 (zero SQL when resident) ----
      const recycle = http.get(url, {
        headers: { 'Accept-Encoding': 'gzip' },
        tags: { endpoint: 'search', mode: 'recycle' },
      });
      served_ms.add(recycle.timings.duration);
      const recycleOk = check(recycle, {
        'recycle status is 200 (never revalidated)': (res) => res.status === 200,
        'recycle is JSON': (res) => String(res.headers['Content-Type'] || '').includes('application/json'),
        'recycle carries the same strong ETag': (res) =>
          isStrongEtag(res.headers['Etag']) && res.headers['Etag'] === captureEtag,
        'recycle declares Cache-Control public': (res) =>
          /^public, max-age=\d+$/.test(String(res.headers['Cache-Control'] || '')),
      });
      if (!recycleOk) {
        exec.test.abort(`Recycle of ${url} answered ${recycle.status} — contract violated`);
      }
      served_200.add(1);
    } else {
      exec.test.abort(`Unknown mixed leg kind '${kind}' — library drift`);
    }
  }

  sleep(0.2);
}
