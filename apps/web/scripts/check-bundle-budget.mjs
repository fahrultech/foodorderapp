#!/usr/bin/env node
/**
 * Session 115 — First Load budget gate (Phase 11 Perf item).
 * Session 118 — undercount fixed: the FULL ANCESTOR CHAIN is summed.
 *
 * The CI web job FAILS when a core storefront route's exact first-load
 * payload exceeds the committed baseline table in docs/PERFORMANCE.md.
 * Zero tolerance: the build is lockfile-pinned, so a regression is a
 * regression, and lowering a budget is a deliberate documented re-measure
 * (record + update the table + commit — same doctrine as the schema-drift
 * gate).
 *
 * Metric (session-118 method): gzip-9 sum of EVERY chunk (.js AND .css)
 * listed for the route's own manifest entry PLUS every ancestor layout
 * entry (`/layout` down to `${route}/layout`) in .next/app-build-manifest.json,
 * deduplicated across those entries. The browser really loads the union of
 * the whole chain on first paint; the old session-90 method summed only the
 * route's OWN chunks, which made the root layout chunk and the global CSS
 * chunk INVISIBLE to every route (session 117 caught it live: the SkipLink
 * +209 B gz into app/layout-*.js landed at margin +0 on all 7 routes).
 * First Load JS alone no longer reproduces Next's printed kB table — the
 * sum is deliberately BROADER than it (that is the point); Next's own
 * per-page column omits the same chunks, which is why its table hid the
 * layout growth too.
 *
 * Why exact bytes instead of the route table: `next build` rounds First
 * Load JS to 1 kB and HIDES small deltas (session 90: a 266 B gz win was
 * invisible in the table; session 117: a 209 B layout loss too).
 *
 * A dead gate is worse than no gate (session-106 doctrine), so the script
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
 * Manifest keys of the route's ancestor layout chain, root-first:
 * `/a/b` -> ['/layout', '/a/layout', '/a/b/layout']. Only keys actually
 * present in the manifest count (a segment without a layout.tsx simply
 * contributes nothing). Derived by segment-stripping, never by a listing
 * heuristic — a layout lives at a URL-path prefix by App Router contract.
 */
export function ancestorLayoutKeys(route, pages) {
  const segs = route.split('/').filter(Boolean);
  const keys = [];
  if (pages['/layout']) keys.push('/layout');
  for (let i = 1; i <= segs.length; i++) {
    const k = `/${segs.slice(0, i).join('/')}/layout`;
    if (pages[k]) keys.push(k);
  }
  return keys;
}

/**
 * Exact first-load payload for one route (session-118 method): gzip-9 sum
 * of every .js AND .css file listed for the route's own entry plus its
 * ancestor layout entries, each file counted ONCE (shared chunks appear
 * in many entries; the browser downloads them once). Non-js/css assets
 * are excluded — the metric is First Load JS + CSS.
 */
export function firstLoadBytes(pages, route, nextDir) {
  const key = route === '/' ? '/page' : `${route}/page`;
  const alt = route === '/' ? null : `${route}/route`;
  const entryKey = pages[key] ? key : (alt && pages[alt] ? alt : null);
  if (!entryKey) return { error: `manifest entry for route "${route}" is missing (expected key ${key})` };
  const layoutKeys = ancestorLayoutKeys(route, pages);
  const files = new Set();
  for (const k of [...layoutKeys, entryKey]) for (const f of pages[k]) files.add(f);
  let total = 0;
  let jsCount = 0;
  let cssCount = 0;
  for (const file of files) {
    const isJs = file.endsWith('.js');
    const isCss = file.endsWith('.css');
    if (!isJs && !isCss) continue; // fonts/other assets are not First Load JS+CSS
    const p = join(nextDir, file);
    if (!existsSync(p)) return { error: `chunk ${file} listed for "${route}" does not exist on disk` };
    total += gzipSync(readFileSync(p), { level: 9 }).length;
    if (isCss) cssCount++; else jsCount++;
  }
  return { bytes: total, entryKey, layoutKeys, chunkCount: jsCount + cssCount, jsCount, cssCount };
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
  console.log(`First Load JS+CSS budget gate — ${NEXT_DIR} vs ${rows.length} baseline routes (gzip-9 exact, full ancestor chain — session-118 method)`);
  for (const { route, baselineBytes } of rows) {
    const r = firstLoadBytes(pages, route, NEXT_DIR);
    if (r.error) { violations.push(`${route}: ${r.error}`); console.log(`  ${route.padEnd(22)} ERROR  ${r.error}`); continue; }
    const margin = baselineBytes - r.bytes;
    const ok = margin >= 0;
    if (!ok) violations.push(`${route}: ${r.bytes} B > baseline ${baselineBytes} B (+${-margin} B)`);
    console.log(
      `  ${route.padEnd(22)} ${String(r.bytes).padStart(7)} B / budget ${String(baselineBytes).padStart(7)} B  ` +
      `${ok ? `margin +${margin} B` : `OVER by ${-margin} B`}  (${r.jsCount} js + ${r.cssCount} css, chain: ${[...r.layoutKeys, r.entryKey].length} entries)`,
    );
  }
  if (violations.length) {
    console.error(`\nbundle-budget gate FAILED (${violations.length} route(s)):`);
    for (const v of violations) console.error(`  - ${v}`);
    // CI observability (session 118): Actions job logs need repo admin, but
    // check-run annotations are readable anonymously — mirror the full
    // measured-vs-budget table into ::error annotations when running in CI.
    if (process.env.GITHUB_ACTIONS === 'true') {
      for (const { route, baselineBytes } of rows) {
        const r = firstLoadBytes(pages, route, NEXT_DIR);
        console.error(`::error title=bundle-budget ${route}::measured=${r.bytes ?? r.error} budget=${baselineBytes}`);
        // Session 118 drift hunt: the same Node/zlib still lands +5 B on CI
        // for every route - dump the per-file chain breakdown so the CI
        // listing can be diffed against a local build byte for byte.
        if (r.bytes !== undefined) {
          const files = [...new Set([...r.layoutKeys, r.entryKey].flatMap((k) => pages[k]))]
            .filter((f) => /\.(js|css)$/.test(f))
            .map((f) => `${f}=${gzipSync(readFileSync(join(NEXT_DIR, f)), { level: 9 }).length}`)
            .join(',');
          console.error(`::error title=bundle-chain ${route}::${files}`);
        }
      }
    }
    console.error('\nEither shrink the route, or — if the growth is intended — re-measure');
    console.error('(`node scripts/check-bundle-budget.mjs --print` after a cold build), update');
    console.error('the BUNDLE-BASELINE table in docs/PERFORMANCE.md and commit it as part of the change.');
    process.exit(1);
  }
  console.log(`\nbundle-budget gate OK — all ${rows.length} core storefront routes within budget.`);
}
