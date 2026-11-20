#!/usr/bin/env node
/**
 * Session 106 — the fixture-timing CI ceiling.
 * Session 110 — trend visibility: job summary table, run-over-run history,
 * ::warning annotations at 60% of ceiling.
 *
 * Every direct-API fixture leg stamps a `fixture-timing` annotation
 * ("<label>: <ms>ms", see e2e/helpers/fixtures.ts). This checker reads the
 * Playwright JSON report (playwright-report/results.json, wired into the
 * reporter list) and FAILS the e2e job when any leg exceeded its wall-clock
 * ceiling — silent slowness regressions stop being next week's flake hunt.
 *
 * The ceiling alone is binary: a leg can crawl to 99% run after run and
 * stay green. So the checker also:
 *   - aggregates per label (legs this run, max ms) and merges a run-over-run
 *     JSONL history (the CI e2e job downloads the most recent
 *     `fixture-timing-history` artifacts from previous runs and republishes
 *     the rewritten file — see .github/workflows/ci.yml);
 *   - appends a markdown table to $GITHUB_STEP_SUMMARY: slowest legs per
 *     label sorted by % of ceiling, with prior-run counts, the historical
 *     max, and the last 5 prior maxima;
 *   - emits `::warning` annotations for every label whose run max crossed
 *     WARN_FRACTION of its ceiling (a crawling leg is caught BEFORE it
 *     crosses) and `::error` annotations for the violating legs.
 *
 *   FIXTURE_TIMING_CEILING_MS       work legs            (default 15000)
 *   FIXTURE_TIMING_WAIT_CEILING_MS  .limiter-wait legs   (default 90000)
 *   FIXTURE_TIMING_REPORT           report path
 *   FIXTURE_TIMING_ALLOW_ZERO=1     tolerate a run with no legs (subset loops)
 *   FIXTURE_TIMING_WARN_FRACTION    warning line as a fraction of the
 *                                   ceiling, (0,1]       (default 0.6)
 *   FIXTURE_TIMING_HISTORY          run-over-run JSONL path
 *                                   (read, then rewritten with this run's
 *                                    record appended — never touched when
 *                                    the run has zero legs)
 *
 * A run with ZERO legs also fails: it means the instrumentation itself
 * vanished, and a silently-dead gate is exactly what this file exists to
 * prevent. The trend/cosmetic paths (summary, annotations, history) never
 * change the exit codes established in session 106.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const REPORT = process.env.FIXTURE_TIMING_REPORT || 'playwright-report/results.json';
const CEILING = Number(process.env.FIXTURE_TIMING_CEILING_MS || 15_000);
const WAIT_CEILING = Number(process.env.FIXTURE_TIMING_WAIT_CEILING_MS || 90_000);
const ALLOW_ZERO = process.env.FIXTURE_TIMING_ALLOW_ZERO === '1';
const WARN_FRACTION_RAW = Number(process.env.FIXTURE_TIMING_WARN_FRACTION || 0.6);
const WARN_FRACTION = WARN_FRACTION_RAW > 0 && WARN_FRACTION_RAW <= 1 ? WARN_FRACTION_RAW : 0.6;
const HISTORY = process.env.FIXTURE_TIMING_HISTORY || 'fixture-timing-history.jsonl';
const SUMMARY = process.env.GITHUB_STEP_SUMMARY || '';
const MAX_HISTORY_RUNS = 20;

let doc;
try {
  doc = JSON.parse(readFileSync(REPORT, 'utf8'));
} catch (err) {
  console.error(`fixture-timing gate: cannot read ${REPORT}: ${err.message}`);
  process.exit(1);
}

const legs = [];
function collect(annotations, where) {
  for (const a of annotations || []) {
    if (!a || a.type !== 'fixture-timing') continue;
    const m = /^(.*): (\d+)ms$/.exec(String(a.description));
    if (!m) {
      console.error(`fixture-timing gate: unparseable annotation ${JSON.stringify(a.description)} (${where})`);
      process.exit(1);
    }
    legs.push({ label: m[1], ms: Number(m[2]), where });
  }
}
function visitSuite(suite) {
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) collect(t.annotations, spec.title || suite.title);
  }
  for (const child of suite.suites || []) visitSuite(child);
}
for (const s of doc.suites || []) visitSuite(s);

const isWait = (l) => l.label.endsWith('.limiter-wait');
const work = legs.filter((l) => !isWait(l)).sort((a, b) => b.ms - a.ms);
const waits = legs.filter(isWait).sort((a, b) => b.ms - a.ms);

console.log(
  `fixture-timing: ${work.length} work leg(s), ${waits.length} limiter-wait leg(s) ` +
  `(ceilings ${CEILING}ms / ${WAIT_CEILING}ms) across the report`,
);
for (const l of work.slice(0, 10)) console.log(`  work  ${String(l.ms).padStart(6)}ms  ${l.label}  [${l.where}]`);
for (const l of waits.slice(0, 5)) console.log(`  wait  ${String(l.ms).padStart(6)}ms  ${l.label}  [${l.where}]`);

// --- session 110: per-label aggregation + run-over-run history ----------

const byLabel = new Map();
for (const l of legs) {
  const e = byLabel.get(l.label) || {
    label: l.label,
    ceiling: isWait(l) ? WAIT_CEILING : CEILING,
    n: 0,
    max: 0,
  };
  e.n += 1;
  if (l.ms > e.max) e.max = l.ms;
  byLabel.set(l.label, e);
}

let prior = [];
let badHistoryLines = 0;
if (existsSync(HISTORY)) {
  for (const line of readFileSync(HISTORY, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      badHistoryLines += 1;
      continue;
    }
    if (!rec || typeof rec.labels !== 'object' || rec.labels === null || Array.isArray(rec.labels)) {
      badHistoryLines += 1;
      continue;
    }
    prior.push(rec);
  }
}
const runId = process.env.GITHUB_RUN_ID || `local-${new Date().toISOString()}`;
// GITHUB_RUN_ID is constant within a run, so a re-invocation of the gate in
// one job replaces its own record instead of double-counting. The same
// dedupe by runId keeps recurring FETCH- sentinels (same kind+artifact+
// status across runs) to exactly one row.
{
  const byRun = new Map();
  for (const r of prior) {
    const key = r.runId === undefined || r.runId === null ? `anon-${Math.random()}` : String(r.runId);
    byRun.set(key, r);
  }
  prior = [...byRun.values()];
}
prior = prior
  .filter((r) => r.runId !== runId)
  .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  .slice(-MAX_HISTORY_RUNS);

const trendOf = (label) => {
  const rows = prior.filter((r) => r.labels[label] && r.labels[label].max >= 0).slice(-5);
  return {
    runs: rows.length,
    histMax: rows.length ? Math.max(...rows.map((r) => r.labels[label].max)) : null,
    recent: rows.map((r) => r.labels[label].max),
  };
};

const pctOf = (ms, ceiling) => Math.round((ms / ceiling) * 100);
const violations = [
  ...work.filter((l) => l.ms > CEILING).map((l) => ({ ...l, ceiling: CEILING })),
  ...waits.filter((l) => l.ms > WAIT_CEILING).map((l) => ({ ...l, ceiling: WAIT_CEILING })),
];

if (legs.length > 0) {
  console.log(
    `fixture-timing trend: ${byLabel.size} label(s); ${prior.length} prior run(s) merged` +
    (badHistoryLines ? `; ${badHistoryLines} malformed history line(s) skipped` : '') +
    ` (${HISTORY})`,
  );

  // Approaching-ceiling warnings: strictly above WARN_FRACTION of the
  // ceiling but still under it (violations get their own ::error below).
  const approaching = [...byLabel.values()]
    .filter((e) => e.max > e.ceiling * WARN_FRACTION && e.max <= e.ceiling)
    .sort((a, b) => b.max / b.ceiling - a.max / a.ceiling);
  for (const e of approaching) {
    const tr = trendOf(e.label);
    const hist = tr.runs ? ` (historical max ${tr.histMax}ms across ${tr.runs} prior run(s))` : '';
    console.log(
      `::warning title=fixture-timing approaching ceiling::${e.label} max ${e.max}ms` +
      ` = ${pctOf(e.max, e.ceiling)}% of ${e.ceiling}ms ceiling${hist}`,
    );
  }

  if (SUMMARY) {
    const rows = [...byLabel.values()]
      .sort((a, b) => b.max / b.ceiling - a.max / a.ceiling)
      .map((e) => {
        const tr = trendOf(e.label);
        return (
          `| \`${e.label}\` | ${e.max} | ${pctOf(e.max, e.ceiling)}% | ${e.ceiling} | ${e.n} ` +
          `| ${tr.runs} | ${tr.histMax === null ? '—' : tr.histMax} ` +
          `| ${tr.recent.length ? tr.recent.join(' → ') : '—'} |`
        );
      });
    const md = [
      '',
      `## Fixture-timing trend — ${legs.length} leg(s), ${byLabel.size} label(s), ` +
      `${prior.length} prior run(s) in history${badHistoryLines ? `, ${badHistoryLines} malformed line(s) skipped` : ''}`,
      '',
      `Ceilings: work **${CEILING}ms** · limiter-wait **${WAIT_CEILING}ms** — ` +
      `\`::warning\` annotations fire above **${Math.round(WARN_FRACTION * 100)}% of ceiling**, ` +
      `the gate fails above 100%. Recent maxes are the last ${MAX_HISTORY_RUNS > 5 ? 5 : MAX_HISTORY_RUNS} ` +
      `prior runs, oldest first.`,
      '',
      '| Label | Max ms | % of ceiling | Ceiling ms | Legs this run | Prior runs seen | Historical max ms | Recent maxes |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
      ...rows,
      '',
    ].join('\n');
    try {
      appendFileSync(SUMMARY, md);
    } catch (err) {
      console.log(`fixture-timing trend: summary write failed (${err.message}) — cosmetic only`);
    }
  }

  // Rewrite the bounded history file with this run's record appended —
  // BEFORE the exit decision, so a violating (slow) run still lands in the
  // trend. Failure here must never change the verdict.
  const record = {
    v: 1,
    runId,
    sha: (process.env.GITHUB_SHA || 'local').slice(0, 12),
    at: new Date().toISOString(),
    labels: Object.fromEntries([...byLabel.entries()].map(([k, e]) => [k, { n: e.n, max: e.max }])),
  };
  try {
    writeFileSync(HISTORY, [...prior, record].map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch (err) {
    console.log(`fixture-timing trend: history write failed (${err.message}) — cosmetic only`);
  }
}

if (legs.length === 0 && !ALLOW_ZERO) {
  console.error('fixture-timing gate: ZERO legs found — the instrumentation is gone (suite bug or wrong report path).');
  process.exit(1);
}
if (violations.length > 0) {
  for (const v of violations) {
    console.error(`fixture-timing VIOLATION: ${v.label} took ${v.ms}ms > ${v.ceiling}ms ceiling  [${v.where}]`);
    console.log(`::error title=fixture-timing violation::${v.label} took ${v.ms}ms > ${v.ceiling}ms ceiling (${pctOf(v.ms, v.ceiling)}%)`);
  }
  console.error(`fixture-timing gate: ${violations.length} violation(s).`);
  process.exit(1);
}
console.log('fixture-timing gate: OK');
