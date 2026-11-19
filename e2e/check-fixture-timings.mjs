#!/usr/bin/env node
/**
 * Session 106 — the fixture-timing CI ceiling.
 *
 * Every direct-API fixture leg stamps a `fixture-timing` annotation
 * ("<label>: <ms>ms", see e2e/helpers/fixtures.ts). This checker reads the
 * Playwright JSON report (playwright-report/results.json, wired into the
 * reporter list) and FAILS the e2e job when any leg exceeded its wall-clock
 * ceiling — silent slowness regressions stop being next week's flake hunt.
 *
 *   FIXTURE_TIMING_CEILING_MS      work legs            (default 15000)
 *   FIXTURE_TIMING_WAIT_CEILING_MS .limiter-wait legs   (default 90000)
 *   FIXTURE_TIMING_REPORT          report path
 *   FIXTURE_TIMING_ALLOW_ZERO=1    tolerate a run with no legs (subset loops)
 *
 * A run with ZERO legs also fails: it means the instrumentation itself
 * vanished, and a silently-dead gate is exactly what this file exists to
 * prevent.
 */
import { readFileSync } from 'node:fs';

const REPORT = process.env.FIXTURE_TIMING_REPORT || 'playwright-report/results.json';
const CEILING = Number(process.env.FIXTURE_TIMING_CEILING_MS || 15_000);
const WAIT_CEILING = Number(process.env.FIXTURE_TIMING_WAIT_CEILING_MS || 90_000);
const ALLOW_ZERO = process.env.FIXTURE_TIMING_ALLOW_ZERO === '1';

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

const violations = [
  ...work.filter((l) => l.ms > CEILING).map((l) => ({ ...l, ceiling: CEILING })),
  ...waits.filter((l) => l.ms > WAIT_CEILING).map((l) => ({ ...l, ceiling: WAIT_CEILING })),
];
if (legs.length === 0 && !ALLOW_ZERO) {
  console.error('fixture-timing gate: ZERO legs found — the instrumentation is gone (suite bug or wrong report path).');
  process.exit(1);
}
if (violations.length > 0) {
  for (const v of violations) {
    console.error(`fixture-timing VIOLATION: ${v.label} took ${v.ms}ms > ${v.ceiling}ms ceiling  [${v.where}]`);
  }
  console.error(`fixture-timing gate: ${violations.length} violation(s).`);
  process.exit(1);
}
console.log('fixture-timing gate: OK');
