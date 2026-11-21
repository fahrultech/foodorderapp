#!/usr/bin/env node
/**
 * Session 115 — First Load JS budget gate (Phase 11 Perf item).
 *
 * The CI web job FAILS when a core storefront route's exact First Load JS
 * (gzip-9 sum of every .js chunk listed for that route's entry in
 * .next/app-build-manifest.json — the session-90 method) exceeds the
 * committed baseline table in docs/PERFORMANCE.md. Zero tolerance: the
 * build is lockfile-pinned, so a regression is a regression, and lowering
 * a budget is a deliberate documented re-measure (record + update the
 * table + commit — same doctrine as the schema-drift gate).
 *
 * Why exact bytes instead of the route table: `next build` rounds First
 * Load JS to 1 kB and HIDES small deltas (session 90: a 266 B gz win was
 * invisible in the table). The manifest sums reproduce the table's
 * arithmetic EXACTLY (pinned in the selftest doctrine comments; live A/B
 * at ship: `/` 106,936 B -> "107 kB", `/admin` -> "126 kB", `/orders/[id]`
 * -> "145 kB"), so this gate sees what the table cannot.
 *
 * A dead gate is worse than no gate (session 106 doctrine), so the script
 * fails loudly on: missing manifest, missing/unparseable/empty baseline
 * table, a baseline route with no matching manifest entry (renamed or
 * deleted route — the table would freeze silently otherwise), and a listed
 * chunk file that is absent from .next.
 *
 * Env knobs (tests + local experiments only — CI uses the defaults):
 *   BUNDLE_NEXT_DIR       default: apps/web/.next (resolved from THIS file,
 *                         so cwd never matters)
 *   BUNDLE_BASELINE_FILE  default: docs/PERFORMANCE.md at the repo root
 */
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts
const NEXT_DIR = process.env.BUNDLE_NEXT_DIR || resolve(HERE, '..', '.next');
const BASELINE_FILE = process.env.BUNDLE_BASELINE_FILE || resolve(HERE, '..', '..', '..', 'docs', 'PERFORMANCE.md');

const TABLE_START = '<!-- BUNDLE-BASELINE-START -->';
const TABLE_END = '<!-- BUNDLE-BASELINE-END -->';

const fail = (msg) => { console.error(`bundle-budget gate: ${msg}`); process.exit(1); };

/** Parse the committed baseline table between the HTML-comment markers. */
export function parseBaseline(md) {
  const s = md.indexOf(TABLE_START);
  const e = md.indexOf(TABLE_END);
  if (s === -1 || e === -1 || e < s) {
    fail(`baseline markers ${TABLE_START}/${TABLE_END} not found in ${BASELINE_FILE} — the gate would be measuring nothing`);
  }
  const rows = [];
  for (const line of md.slice(s + TABLE_START.length, e).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    // markdown separator rows (---, :---:, etc.) are structural, not data
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const route = cells[0].replace(/`/g, '');
    // bytes may carry thousands separators / underscores in prose tables
    const bytes = Number(cells[1].replace(/[,_\s]/g, ''));
    if (route.toLowerCase() === 'route' || !route) continue; // header row
    if (!Number.isInteger(bytes) || bytes <= 0) fail(`baseline row for "${route}" has non-integer bytes: "${cells[1]}"`);
    if (!route.startsWith('/')) fail(`baseline row route "${route}" must start with /`);
    rows.push({ route, baselineBytes: bytes });
  }
  if (rows.length === 0) fail(`baseline table found but has zero route rows in ${BASELINE_FILE}`);
  const dupes = rows.map((r) => r.route).filter((r, i) => rows.findIndex((x) => x.route === r) !== i);
  if (dupes.length) fail(`duplicate baseline rows for: ${[...new Set(dupes)].join(', ')}`);
  return rows;
}

/**
 * Exact First Load JS for one route entry: sum of gzip-9 sizes of every .js
 * file listed in app-build-manifest.json for that entry (session-90 method;
 * CSS and non-JS assets excluded — the metric is First Load JS).
 */
export function firstLoadBytes(pages, route, nextDir) {
  const key = route === '/' ? '/page' : `${route}/page`;
  const alt = route === '/' ? null : `${route}/route`;
  const entryKey = pages[key] ? key : (alt && pages[alt] ? alt : null);
  if (!entryKey) return { error: `manifest entry for route "${route}" is missing (expected key ${key})` };
  let total = 0;
  for (const file of pages[entryKey]) {
    if (!file.endsWith('.js')) continue; // css/fonts are not First Load JS
    const p = join(nextDir, file);
    if (!existsSync(p)) return { error: `chunk ${file} listed for "${route}" does not exist on disk` };
    total += gzipSync(readFileSync(p), { level: 9 }).length;
  }
  return { bytes: total, entryKey, chunkCount: pages[entryKey].filter((f) => f.endsWith('.js')).length };
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const manifestPath = join(NEXT_DIR, 'app-build-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(`cannot read ${manifestPath}: ${err.message} (was \`next build\` run?)`);
  }
  const pages = manifest.pages || {};
  let md;
  try {
    md = readFileSync(BASELINE_FILE, 'utf8');
  } catch (err) {
    fail(`cannot read ${BASELINE_FILE}: ${err.message}`);
  }

  const rows = parseBaseline(md);

  if (process.argv.includes('--print')) {
    // Re-measure mode: emit current exact bytes as ready markdown rows for
    // the baseline table (same route set — numbers only, no silent additions).
    for (const { route } of rows) {
      const r = firstLoadBytes(pages, route, NEXT_DIR);
      if (r.error) fail(r.error);
      console.log(`| \`${route}\` | ${r.bytes} |`);
    }
    process.exit(0);
  }

  const violations = [];
  console.log(`First Load JS budget gate — ${NEXT_DIR} vs ${rows.length} baseline routes (gzip-9 exact, session-90 method)`);
  for (const { route, baselineBytes } of rows) {
    const r = firstLoadBytes(pages, route, NEXT_DIR);
    if (r.error) { violations.push(`${route}: ${r.error}`); console.log(`  ${route.padEnd(22)} ERROR  ${r.error}`); continue; }
    const margin = baselineBytes - r.bytes;
    const ok = margin >= 0;
    if (!ok) violations.push(`${route}: ${r.bytes} B > baseline ${baselineBytes} B (+${-margin} B)`);
    console.log(
      `  ${route.padEnd(22)} ${String(r.bytes).padStart(7)} B / budget ${String(baselineBytes).padStart(7)} B  ` +
      `${ok ? `margin +${margin} B` : `OVER by ${-margin} B`}  (${r.chunkCount} chunks)`,
    );
  }
  if (violations.length) {
    console.error(`\nbundle-budget gate FAILED (${violations.length} route(s)):`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error('\nEither shrink the route, or — if the growth is intended — re-measure');
    console.error('(`node scripts/check-bundle-budget.mjs --print` after a cold build), update');
    console.error('the BUNDLE-BASELINE table in docs/PERFORMANCE.md and commit it as part of the change.');
    process.exit(1);
  }
  console.log(`\nbundle-budget gate OK — all ${rows.length} core storefront routes within budget.`);
}
