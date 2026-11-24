// perf-check ANALYZER — turns a k6 summary-export JSON (v2.x flat shape) +
// the k6 process exit code into the scheduled perf regression verdict
// (Phase 13 Test item, session 124). Mirrors the alert-scan exit-code
// doctrine: 0 green · 1 regression · 2 rig broken.
//
// WHY the verdict is computed HERE and not trusted from the k6 exit code
// alone: exit 99 DOES fire on crossed INTERNAL thresholds (measured on the
// real container this session), but the ladder's own thresholds are loose
// (p95<500 ms) — a 4x latency regression against the 120 ms baseline ceiling
// this check guards would still exit 0. So: the exit code classifies the
// RUN (completed / aborted / broken), the JSON classifies the RESULT.
//
// Summary JSON shape pinned by ops/perf-check.analyze.test.mjs (and by the
// two synthetic probes run against the real grafana/k6:2.3.0 container):
//   metrics.<counter>        { count, rate }
//   metrics.<trend>          { avg, med, min, max, "p(90)", "p(95)", ... }
//   metrics.http_req_failed  { passes, fails, value }   value = failure RATE
//   metrics.checks           { passes, fails, value }   value = PASS rate
//   per-metric "thresholds": { "<expr>": true }  — true means CROSSED
// Custom counters that were never add()-ed may be ABSENT from the export;
// absence of rate_limited_429s therefore means zero, not unknown.
//
// Usage (CLI):
//   node ops/perf-check.analyze.mjs --summary FILE --k6-rc N \
//        [--p95-max MS] [--min-iterations N] [--capture-min-ratio R] \
//        [--fail-max R] [--checks-min R]
// stdout: compact one-line JSON verdict (facts + reasons).
// exit:   0 green · 1 regression · 2 rig broken (unreadable summary,
//         invalid knobs, aborted/broken k6 run, sample too thin to judge).
'use strict';

const DEFAULTS = Object.freeze({
  p95MaxMs: 120, // ~7x the session-121 smoke-arm p95 (16.6 ms): flaky-box
  minIterations: 5, // 1 VU x 30 s lands ~29-30 iterations; below 5 the
  //                     measurement is not a measurement — rig verdict
  captureMinRatio: 0.95, // every ladder iteration captures its payment
  failMax: 0.01, // mirrors k6's own http_req_failed rate<0.01 threshold
  checksMin: 0.99, // mirrors checks rate>0.99
});

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Read metrics.<name> safely from a parsed summary. */
function metric(summary, name) {
  const m = summary?.metrics?.[name];
  return m && typeof m === 'object' ? m : null;
}

/**
 * Pure: analyze a parsed k6 summary-export object.
 * opts: { p95MaxMs, minIterations, captureMinRatio, failMax, checksMin, k6Rc }
 * Returns { verdict: 'green'|'regression'|'rig-broken', reasons: [], facts: {} }.
 * k6Rc (when provided) folds the process-level outcome in:
 *   0   completed, internal thresholds passed  -> judge the JSON
 *   99  completed, internal thresholds CROSSED -> regression by definition
 *   108 exec.test.abort (429/cache/bootstrap)  -> run invalidated: rig-broken
 *   anything else                              -> rig-broken
 */
export function analyzeSummary(summary, opts = {}) {
  const p95MaxMs = num(opts.p95MaxMs) ?? DEFAULTS.p95MaxMs;
  const minIterations = num(opts.minIterations) ?? DEFAULTS.minIterations;
  const captureMinRatio = num(opts.captureMinRatio) ?? DEFAULTS.captureMinRatio;
  const failMax = num(opts.failMax) ?? DEFAULTS.failMax;
  const checksMin = num(opts.checksMin) ?? DEFAULTS.checksMin;
  const k6Rc = num(opts.k6Rc);
  const reasons = [];

  const metricsOk = summary && typeof summary === 'object' && summary.metrics;
  if (!metricsOk) {
    return {
      verdict: 'rig-broken',
      reasons: ['summary JSON unreadable or missing "metrics" — the k6 run never produced a result'],
      facts: {},
    };
  }

  const dur = metric(summary, 'http_req_duration');
  const iters = num(metric(summary, 'iterations')?.count);
  const reqs = num(metric(summary, 'http_reqs')?.count);
  const p95 = num(dur?.['p(95)']);
  const avg = num(dur?.avg);
  const ordersPlaced = num(metric(summary, 'orders_placed')?.count) ?? 0;
  const paymentsCaptured = num(metric(summary, 'payments_captured')?.count) ?? 0;
  const throttled = num(metric(summary, 'rate_limited_429s')?.count) ?? 0;
  const failedRate = num(metric(summary, 'http_req_failed')?.value);
  const checksRate = num(metric(summary, 'checks')?.value);

  const facts = {
    k6Rc,
    iterations: iters,
    requests: reqs,
    p95Ms: p95,
    avgMs: avg,
    ordersPlaced,
    paymentsCaptured,
    throttled429: throttled,
    failedRate,
    checksPassRate: checksRate,
  };

  // ---- run-level classification from the k6 exit code -------------------
  if (k6Rc === 99) {
    reasons.push(
      'k6 internal thresholds crossed (exit 99) — one of: http_req_failed rate<0.01 / p95<500 / checks rate>0.99 / orders>0 / zero-429',
    );
  } else if (k6Rc !== null && k6Rc !== 0) {
    reasons.push(
      `k6 run did not complete normally (exit ${k6Rc})` +
        (k6Rc === 108
          ? ' — the profile ABORTED (zero-429 / cache-contract / bootstrap guard fired): the sample is invalid, not the app'
          : ' — script/config error'),
    );
    return { verdict: 'rig-broken', reasons, facts };
  }

  // ---- sample must be thick enough to judge -----------------------------
  if (iters === null || iters < minIterations) {
    reasons.push(
      `iterations ${iters ?? 'missing'} < min ${minIterations} — no meaningful sample (dead API? VU starvation?)`,
    );
    return { verdict: 'rig-broken', reasons, facts };
  }
  if (p95 === null) {
    reasons.push('http_req_duration p(95) missing from the summary — unreadable k6 shape');
    return { verdict: 'rig-broken', reasons, facts };
  }

  // ---- regression rules (ordered: latency first — the drift this catches) --
  if (p95 > p95MaxMs) {
    reasons.push(`http_req_duration p95 ${p95.toFixed(2)} ms exceeds ceiling ${p95MaxMs} ms`);
  }
  if (throttled > 0) {
    reasons.push(`rate_limited_429s ${throttled} > 0 — the limiter shaped this run (boot-rate knobs drifted?)`);
  }
  if (ordersPlaced === 0) {
    reasons.push('orders_placed count is 0 — the write ladder never wrote');
  }
  if (ordersPlaced > 0 && paymentsCaptured < Math.ceil(ordersPlaced * captureMinRatio)) {
    reasons.push(
      `payments_captured ${paymentsCaptured} < ${captureMinRatio * 100}% of orders_placed ${ordersPlaced}`,
    );
  }
  if (failedRate !== null && failedRate > failMax) {
    reasons.push(`http_req_failed rate ${failedRate} exceeds ${failMax}`);
  }
  if (checksRate !== null && checksRate < checksMin) {
    reasons.push(`checks pass rate ${checksRate} below ${checksMin}`);
  }

  const verdict = reasons.length ? 'regression' : 'green';
  return { verdict, reasons, facts };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const NUMERIC_KNOBS = Object.freeze({
  '--p95-max': 'p95MaxMs',
  '--min-iterations': 'minIterations',
  '--capture-min-ratio': 'captureMinRatio',
  '--fail-max': 'failMax',
  '--checks-min': 'checksMin',
  '--k6-rc': 'k6Rc',
});

export function parseArgs(argv) {
  const out = { summaryPath: null, opts: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--summary') {
      out.summaryPath = argv[(i += 1)] ?? null;
    } else if (NUMERIC_KNOBS[flag]) {
      const raw = argv[(i += 1)];
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`${flag} expects a number, got ${JSON.stringify(raw)}`);
      }
      out.opts[NUMERIC_KNOBS[flag]] = value;
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!out.summaryPath) throw new Error('--summary FILE is required');
  return out;
}

async function main() {
  const fs = await import('node:fs');
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
    const raw = fs.readFileSync(parsed.summaryPath, 'utf8');
    parsed.summary = JSON.parse(raw);
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ verdict: 'rig-broken', reasons: [`analyzer input invalid: ${error.message}`], facts: {} }) + '\n',
    );
    process.exit(2);
  }
  const result = analyzeSummary(parsed.summary, parsed.opts);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.verdict === 'green' ? 0 : result.verdict === 'regression' ? 1 : 2);
}

if (process.argv[1] && process.argv[1].endsWith('perf-check.analyze.mjs')) {
  main().catch((error) => {
    process.stderr.write(`perf-check.analyze: unexpected failure: ${error.stack}\n`);
    process.exit(2);
  });
}
