import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import exec from 'k6/execution';
import {
  REPLAYS_PER_ITERATION,
  cacheBrowsePath,
  isStrongEtag,
  revalidateProfile,
  restaurantIds,
  thresholds,
} from './load-test.lib.mjs';

/**
 * Conditional-GET replay workload (session 104). Companion of load-test.js
 * for PERFORMANCE.md recommendation 6: measure the session-103 304 path
 * head-on instead of only inferring it from the server. Read-only like the
 * public browse profile — never mixes into the auth write scenario.
 *
 * Each iteration:
 *  1. ONE unconditional GET on a whitelisted path. Always 200: within the
 *     TTL it is served from the in-process store (zero SQL), after expiry
 *     it re-reads. Captures the strong ETag.
 *  2. REPLAYS_PER_ITERATION replays of that ETag via If-None-Match. Every
 *     replay MUST be a 304: within the TTL the handler never runs, after
 *     expiry the re-read recomputes the same bytes (the fixture is read-
 *     only) and the stale revalidation still ends 304 without a body.
 *
 * Session 108: BOTH legs now send `Accept-Encoding: gzip` (browser-shaped
 * requests — k6 sends identity by default and would otherwise measure a
 * wire the profile ships no compression for). k6 decompresses at the JS
 * layer, so every existing check keeps reading decoded JSON; the raw
 * Content-Length header is the wire-size signal. capture_ms/replay_ms
 * trends split latency per leg (the gzip cost belongs to capture only).
 *
 * Run against the SAME scratch instance as the browse baseline, with
 * HTTP_CACHE_TTL_SEC set (the default 15 s is the shipped behavior). With
 * TTL=0 the replays would honestly 200 — the checks fail loudly, which is
 * the correct reading of "cache off", never a silent pass.
 */

const baseUrl = (__ENV.BASE_URL || 'http://localhost:4000/api').replace(/\/$/, '');
const profile = __ENV.PROFILE || 'smoke';

export const options = {
  scenarios: revalidateProfile(profile),
  thresholds,
  discardResponseBodies: false,
  userAgent: 'foodorder-k6',
};

// session 108: split latency by leg so the gzip cost lands on the ONE
// capture request per iteration, never smeared across the 304 replays.
export const capture_ms = new Trend('capture_ms', true);
export const replay_ms = new Trend('replay_ms', true);

export function setup() {
  const response = http.get(`${baseUrl}/restaurants?sort=rating&limit=20`, {
    tags: { endpoint: 'restaurants-bootstrap' },
  });
  const ok = check(response, {
    'bootstrap status is 200': (res) => res.status === 200,
  });
  if (!ok) exec.test.abort(`Bootstrap failed with HTTP ${response.status}`);

  let payload;
  try {
    payload = response.json();
  } catch (error) {
    exec.test.abort(`Bootstrap returned invalid JSON: ${error.message}`);
  }

  let ids;
  try {
    ids = restaurantIds(payload);
  } catch (error) {
    exec.test.abort(error.message);
  }
  return { restaurantIds: ids };
}

export default function revalidate(data) {
  const iteration = exec.scenario.iterationInTest;
  const ids = data.restaurantIds;
  const restaurantId = ids[iteration % ids.length];
  const path = cacheBrowsePath(iteration, restaurantId);
  const url = `${baseUrl}${path}`;
  const detail = path.startsWith('/restaurants/')
    ? 'restaurant-detail'
    : path.startsWith('/search')
      ? 'search'
      : 'restaurants-list';

  const capture = http.get(url, {
    headers: { 'Accept-Encoding': 'gzip' },
    tags: { endpoint: detail, mode: 'capture' },
  });
  capture_ms.add(capture.timings.duration);
  const captureOk = check(capture, {
    'capture status is 200': (res) => res.status === 200,
    'capture is JSON': (res) => String(res.headers['Content-Type'] || '').includes('application/json'),
    // k6 runs on Go: response header names arrive CANONICALIZED over the
    // JS bridge — 'ETag' surfaces as 'Etag' (harness trap, session 104).
    'capture carries a strong ETag': (res) => isStrongEtag(res.headers['Etag']),
    'capture declares Cache-Control public': (res) =>
      /^public, max-age=\d+$/.test(String(res.headers['Cache-Control'] || '')),
    'capture declares a numeric Content-Length (wire size)': (res) =>
      /^[0-9]+$/.test(String(res.headers['Content-Length'] || '')),
  });
  if (!captureOk) {
    // Fixture drift or the cache is off — replaying anyway would measure
    // nothing. Abort loudly instead of quietly reporting a bogus 304 rate.
    exec.test.abort(
      `Capture of ${path} answered ${capture.status} without a cacheable strong ETag — ` +
        'check HTTP_CACHE_TTL_SEC and that the path is still session-103 whitelisted',
    );
  }

  const etag = capture.headers['Etag'];
  for (let i = 0; i < REPLAYS_PER_ITERATION; i += 1) {
    const replay = http.get(url, {
      headers: { 'If-None-Match': etag, 'Accept-Encoding': 'gzip' },
      tags: { endpoint: detail, mode: 'replay' },
    });
    replay_ms.add(replay.timings.duration);
    check(replay, {
      'replay status is 304': (res) => res.status === 304,
      'replay echoes the same ETag': (res) => res.headers['Etag'] === etag,
      'replay sends no body': (res) => !res.body || res.body.length === 0,
    });
  }
  sleep(0.2);
}
