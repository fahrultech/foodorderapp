// ops/perf-check.analyze.mjs selftests (node --test, browser-free).
// Session 124, Phase 13: the scheduled perf-regression verdict MUST not be
// a rubber stamp — every rule gets a positive pin AND a boundary/negative
// case, mirroring the check-bundle-budget.test.mjs doctrine: a dead gate is
// worse than no gate because it launders silence into confidence.
//
// Synthetic summaries below reproduce the REAL grafana/k6:2.3.0
// summary-export shape (flat values under metrics.<name>; rate metrics
// expose `value`; never-incremented custom counters are ABSENT — all four
// shapes verified against actual container output this session).
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSummary } from './perf-check.analyze.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'perf-check.analyze.mjs');

/** Session-121 smoke-arm shape: 29 iters, p95 16.6ms, 29/29 paid, clean. */
function healthySummary(overrides = {}) {
  return {
    metrics: {
      iterations: { count: 29, rate: 0.96 },
      http_reqs: { count: 147, rate: 4.86 },
      http_req_duration: { avg: 7.4, med: 6.1, min: 0.9, max: 61.2, 'p(90)': 12.4, 'p(95)': 16.6 },
      http_req_failed: { passes: 147, fails: 0, value: 0 },
      checks: { passes: 352, fails: 0, value: 1 },
      orders_placed: { count: 29, rate: 0.96 },
      payments_captured: { count: 29, rate: 0.96 },
      ...overrides,
    },
  };
}

test('healthy sample (session-121 smoke-arm shape) is green with k6Rc 0', () => {
  const r = analyzeSummary(healthySummary(), { k6Rc: 0 });
  assert.equal(r.verdict, 'green', JSON.stringify(r.reasons));
  assert.deepEqual(r.reasons, []);
  assert.equal(r.facts.ordersPlaced, 29);
  assert.equal(r.facts.p95Ms, 16.6);
});

test('absent rate_limited_429s counter means zero, not unknown', () => {
  const r = analyzeSummary(healthySummary(), {});
  assert.equal(r.facts.throttled429, 0);
  assert.equal(r.verdict, 'green');
});

test('p95 exactly AT the ceiling does not fire; one unit over does', () => {
  const at = analyzeSummary(healthySummary({
    http_req_duration: { 'p(95)': 120 },
  }), { p95MaxMs: 120 });
  assert.equal(at.verdict, 'green');
  const over = analyzeSummary(healthySummary({
    http_req_duration: { 'p(95)': 120.01 },
  }), { p95MaxMs: 120 });
  assert.equal(over.verdict, 'regression');
  assert.match(over.reasons.join(' '), /p95 120\.01 ms exceeds ceiling 120 ms/);
});

test('rate_limited_429s > 0 is a regression (limiter-shaped run)', () => {
  const r = analyzeSummary(healthySummary({
    rate_limited_429s: { count: 2, rate: 0.01 },
  }), {});
  assert.equal(r.verdict, 'regression');
  assert.match(r.reasons.join(' '), /rate_limited_429s 2/);
});

test('zero orders_placed is a regression even when everything else is green', () => {
  const r = analyzeSummary(healthySummary({
    orders_placed: { count: 0, rate: 0 },
    payments_captured: { count: 0, rate: 0 },
  }), {});
  assert.equal(r.verdict, 'regression');
  assert.match(r.reasons.join(' '), /orders_placed count is 0/);
});

test('capture ratio boundary: ceil(30*0.95)=29 ok, 28 of 30 fires', () => {
  const ok = analyzeSummary(healthySummary({
    orders_placed: { count: 30 },
    payments_captured: { count: 29 },
  }), {});
  assert.equal(ok.verdict, 'green');
  const bad = analyzeSummary(healthySummary({
    orders_placed: { count: 30 },
    payments_captured: { count: 28 },
  }), {});
  assert.equal(bad.verdict, 'regression');
  assert.match(bad.reasons.join(' '), /payments_captured 28 < 95% of orders_placed 30/);
});

test('http_req_failed rate over 1% is a regression', () => {
  const r = analyzeSummary(healthySummary({
    http_req_failed: { passes: 145, fails: 3, value: 0.02 },
  }), {});
  assert.equal(r.verdict, 'regression');
  assert.match(r.reasons.join(' '), /http_req_failed rate 0\.02/);
});

test('checks pass rate under 0.99 is a regression; exactly 0.99 is not', () => {
  const bad = analyzeSummary(healthySummary({
    checks: { passes: 348, fails: 5, value: 0.985 },
  }), {});
  assert.equal(bad.verdict, 'regression');
  const edge = analyzeSummary(healthySummary({
    checks: { passes: 297, fails: 3, value: 0.99 },
  }), {});
  assert.equal(edge.verdict, 'green');
});

test('k6 exit 99 (crossed internal thresholds) is a regression', () => {
  const r = analyzeSummary(healthySummary(), { k6Rc: 99 });
  assert.equal(r.verdict, 'regression');
  assert.match(r.reasons.join(' '), /exit 99/);
});

test('k6 exit 108 (exec.test.abort) invalidates the run: rig-broken, not green', () => {
  // A profile abort can leave a THIN summary that would otherwise pass the
  // JSON rules; the run-level classification must veto before the result
  // rules judge (29 iters would be "enough", but the sample is not real).
  const r = analyzeSummary(healthySummary(), { k6Rc: 108 });
  assert.equal(r.verdict, 'rig-broken');
  assert.match(r.reasons.join(' '), /ABORTED/);
});

test('unknown k6 exit code is rig-broken', () => {
  const r = analyzeSummary(healthySummary(), { k6Rc: 7 });
  assert.equal(r.verdict, 'rig-broken');
  assert.match(r.reasons.join(' '), /exit 7/);
});

test('thin sample (< min iterations) is rig-broken, not a false green', () => {
  const r = analyzeSummary(healthySummary({
    iterations: { count: 2, rate: 0.1 },
  }), { k6Rc: 0 });
  assert.equal(r.verdict, 'rig-broken');
  assert.match(r.reasons.join(' '), /iterations 2 < min 5/);
});

test('garbage summaries are rig-broken, never a silent green', () => {
  for (const junk of [null, undefined, {}, { metrics: null }, { metrics: { iterations: { count: 50 } } }]) {
    const r = analyzeSummary(junk, { k6Rc: 0 });
    assert.ok(r.verdict === 'rig-broken', `junk ${JSON.stringify(junk)} -> ${r.verdict}`);
  }
});

test('missing p(95) on an otherwise fat sample is rig-broken', () => {
  const r = analyzeSummary(healthySummary({
    http_req_duration: { avg: 5 },
  }), { k6Rc: 0 });
  assert.equal(r.verdict, 'rig-broken');
  assert.match(r.reasons.join(' '), /p\(95\) missing/);
});

// ---------------------------------------------------------------------------
// CLI contract: exit codes + stdout JSON (what ops/perf-check.sh consumes).
// ---------------------------------------------------------------------------

function runCli(args, input) {
  const dir = mkdtempSync(join(tmpdir(), 'perfcheck-'));
  const file = join(dir, 'summary.json');
  writeFileSync(file, typeof input === 'string' ? input : JSON.stringify(input));
  try {
    const out = execFileSync(process.execPath, [CLI, '--summary', file, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: out.trim() };
  } catch (error) {
    return { code: error.status, out: String(error.stdout || '').trim() };
  }
}

test('CLI exits 0 + green JSON on a healthy summary', () => {
  const r = runCli(['--k6-rc', '0'], healthySummary());
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.out).verdict, 'green');
});

test('CLI exits 1 + names the regression when the ceiling is tightened', () => {
  const r = runCli(['--k6-rc', '0', '--p95-max', '10'], healthySummary());
  assert.equal(r.code, 1, r.out);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.verdict, 'regression');
  assert.match(parsed.reasons.join(' '), /p95 16\.60 ms exceeds ceiling 10 ms/);
});

test('CLI exits 2 on unparseable summary content (rig-broken)', () => {
  const r = runCli(['--k6-rc', '0'], 'this is not json {{{');
  assert.equal(r.code, 2, r.out);
  assert.equal(JSON.parse(r.out).verdict, 'rig-broken');
});

test('CLI exits 2 on a garbage knob value (rig-broken input)', () => {
  const r = runCli(['--p95-max', 'banana'], healthySummary());
  assert.equal(r.code, 2, r.out);
  assert.match(JSON.parse(r.out).reasons.join(' '), /--p95-max expects a number/);
});
