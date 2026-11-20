/**
 * Session 110 — selftests for e2e/check-fixture-timings.mjs.
 *
 * Pure code: spawns the gate against synthetic Playwright-JSON reports in
 * temp dirs (report, history file and job-summary file all via env). The
 * CI e2e job runs `node --test check-fixture-timings.test.mjs` before the
 * real gate, so a corrupted trend path fails the job loudly instead of
 * silently skipping the summary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-fixture-timings.mjs');

const reportJson = (legs) => JSON.stringify({
  suites: [{
    title: 'synthetic.spec.ts',
    specs: [{
      title: 't',
      tests: [{ annotations: legs.map(([label, ms]) => ({ type: 'fixture-timing', description: `${label}: ${ms}ms` })) }],
    }],
    suites: [],
  }],
});

const rec = (runId, at, labels) => JSON.stringify({ v: 1, runId, at, labels });

/** One gate invocation in its own temp dir (or a shared dir for dedupe tests). */
function runGate(legs, { env = {}, historyContent } = {}, dir = mkdtempSync(join(tmpdir(), 'ftt-'))) {
  const report = join(dir, 'results.json');
  writeFileSync(report, reportJson(legs));
  const hist = join(dir, 'hist.jsonl');
  const summary = join(dir, 'summary.md');
  writeFileSync(summary, '');
  if (historyContent !== undefined) writeFileSync(hist, historyContent);
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      FIXTURE_TIMING_REPORT: report,
      FIXTURE_TIMING_HISTORY: hist,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
    encoding: 'utf8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  return {
    code: r.status,
    out,
    hist: existsSync(hist) ? readFileSync(hist, 'utf8') : null,
    summary: readFileSync(summary, 'utf8'),
    dir,
  };
}

test('clean run passes with the legacy contract intact', () => {
  const { code, out } = runGate([['login.demo', 800], ['warungFixture', 1200]]);
  assert.equal(code, 0);
  assert.match(out, /fixture-timing: 2 work leg\(s\), 0 limiter-wait leg\(s\)/);
  assert.match(out, /fixture-timing gate: OK/);
});

test('violation exits 1 and stamps ::error with the label', () => {
  const { code, out } = runGate([['slowFixture', 15_001]]);
  assert.equal(code, 1);
  assert.match(out, /fixture-timing VIOLATION: slowFixture took 15001ms > 15000ms ceiling/);
  assert.match(out, /::error title=fixture-timing violation::slowFixture took 15001ms > 15000ms ceiling \(100%\)/);
});

test('warning band: strictly above 60% fires ::warning, exactly 60% does not', () => {
  const warn = runGate([['crawlFixture', 9_001]]);
  assert.equal(warn.code, 0);
  assert.match(warn.out, /::warning title=fixture-timing approaching ceiling::crawlFixture max 9001ms = 60% of 15000ms ceiling/);

  const atLine = runGate([['crawlFixture', 9_000]]);
  assert.equal(atLine.code, 0);
  assert.doesNotMatch(atLine.out, /::warning/);
});

test('limiter-wait legs use the wait ceiling class', () => {
  const warn = runGate([['orders.pay.limiter-wait', 54_001]]);
  assert.equal(warn.code, 0);
  assert.match(warn.out, /::warning .*orders\.pay\.limiter-wait max 54001ms = 60% of 90000ms ceiling/);

  const vi = runGate([['orders.pay.limiter-wait', 90_001]]);
  assert.equal(vi.code, 1);
  assert.match(vi.out, /VIOLATION: orders\.pay\.limiter-wait took 90001ms > 90000ms/);
});

test('zero legs fails, ALLOW_ZERO tolerates, and neither touches history', () => {
  const strict = runGate([]);
  assert.equal(strict.code, 1);
  assert.match(strict.out, /ZERO legs found/);
  assert.equal(strict.hist, null);

  const lax = runGate([], { env: { FIXTURE_TIMING_ALLOW_ZERO: '1' } });
  assert.equal(lax.code, 0);
  assert.equal(lax.hist, null);
});

test('history merges prior runs, is rewritten bounded, and summary shows the trend', () => {
  const prior = [
    rec('r1', '2026-11-01T00:00:00.000Z', { loginDemo: { n: 2, max: 812 } }),
    rec('r2', '2026-11-02T00:00:00.000Z', { loginDemo: { n: 2, max: 903 } }),
  ].join('\n') + '\n';
  const { code, out, hist, summary } = runGate(
    [['loginDemo', 9_500], ['loginDemo', 100]],
    { env: { GITHUB_RUN_ID: 'cur' }, historyContent: prior },
  );
  assert.equal(code, 0);
  assert.match(out, /fixture-timing trend: 1 label\(s\); 2 prior run\(s\) merged/);

  const lines = hist.trim().split('\n');
  assert.equal(lines.length, 3);
  const mine = JSON.parse(lines[2]);
  assert.equal(mine.runId, 'cur');
  assert.deepEqual(mine.labels.loginDemo, { n: 2, max: 9500 });

  assert.match(summary, /## Fixture-timing trend — 2 leg\(s\), 1 label\(s\), 2 prior run\(s\) in history/);
  assert.match(summary, /\| `loginDemo` \| 9500 \| 63% \| 15000 \| 2 \| 2 \| 903 \| 812 → 903 \|/);
});

test('same GITHUB_RUN_ID twice replaces its own record (re-invocation idempotence)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftt-dedup-'));
  const first = runGate([['a', 100]], { env: { GITHUB_RUN_ID: 'cur' } }, dir);
  assert.equal(first.code, 0);
  const second = runGate([['a', 200]], { env: { GITHUB_RUN_ID: 'cur' }, historyContent: first.hist }, dir);
  assert.equal(second.code, 0);
  const lines = second.hist.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).labels.a.max, 200);
});

test('malformed history lines are counted and skipped, verdict unchanged', () => {
  const mixed = [
    'not json at all',
    rec('r1', '2026-11-01T00:00:00.000Z', { a: { n: 1, max: 10 } }),
    JSON.stringify({ v: 1, runId: 'r2', labels: 'garbage' }),
  ].join('\n') + '\n';
  const { code, out, summary } = runGate([['a', 100]], { historyContent: mixed });
  assert.equal(code, 0);
  assert.match(out, /1 label\(s\); 1 prior run\(s\) merged; 2 malformed history line\(s\) skipped/);
  assert.match(summary, /2 malformed line\(s\) skipped/);
});

test('summary rows sort by % of ceiling across ceiling classes', () => {
  const { summary } = runGate([['workLeg', 10_000], ['w.limiter-wait', 20_000]]);
  const wi = summary.indexOf('`workLeg`');
  const wt = summary.indexOf('`w.limiter-wait`');
  assert.ok(wi !== -1 && wt !== -1);
  assert.ok(wi < wt, '67%-of-15000 must precede 22%-of-90000');
});

test('WARN_FRACTION override moves the warning line', () => {
  const hi = runGate([['a', 13_000]], { env: { FIXTURE_TIMING_WARN_FRACTION: '0.9' } });
  assert.equal(hi.code, 0);
  assert.doesNotMatch(hi.out, /::warning/);

  const over = runGate([['a', 13_600]], { env: { FIXTURE_TIMING_WARN_FRACTION: '0.9' } });
  assert.match(over.out, /::warning .*max 13600ms = 91% of 15000ms ceiling/);

  const garbage = runGate([['a', 13_000]], { env: { FIXTURE_TIMING_WARN_FRACTION: 'abc' } });
  assert.match(garbage.out, /::warning .*max 13000ms = 87% of 15000ms ceiling/);
});

test('legacy guards still fire: unparseable annotation and unreadable report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftt-legacy-'));
  const report = join(dir, 'results.json');
  writeFileSync(report, JSON.stringify({
    suites: [{ specs: [{ tests: [{ annotations: [{ type: 'fixture-timing', description: 'no-ms-suffix' }] }], title: 't' }] }],
  }));
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, FIXTURE_TIMING_REPORT: report, FIXTURE_TIMING_HISTORY: join(dir, 'h.jsonl') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match((r.stdout || '') + (r.stderr || ''), /unparseable annotation/);

  const missing = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, FIXTURE_TIMING_REPORT: join(dir, 'nope.json'), FIXTURE_TIMING_HISTORY: join(dir, 'h.jsonl') },
    encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
});
