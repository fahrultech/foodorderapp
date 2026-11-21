/**
 * Session 115 — selftests for apps/web/scripts/check-bundle-budget.mjs.
 *
 * Pure and browser-free: synthetic app-build-manifest.json trees + tiny
 * chunk files + synthetic baseline markdown in temp dirs, gate spawned as a
 * subprocess via the documented env knobs. The CI web job runs this suite
 * BEFORE the real gate so a corrupted gate fails the job loudly instead of
 * silently skipping the budget check.
 *
 * The deliberate over-budget negative test (roadmap ask, drift-gate
 * precedent) is `over-budget route fails`: one chunk grows 1 byte past its
 * baseline and the gate must exit 1 naming the route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-bundle-budget.mjs');

const gz = (buf) => gzipSync(buf, { level: 9 }).length;

/**
 * Rig layout (returned paths):
 *   nextDir/app-build-manifest.json
 *   nextDir/<chunk files>            real bytes, gz size deterministic
 *   baseline.md                      marker-anchored table
 * chunkSpecs: [{ file, content }] — .css files are written but must be
 * IGNORED by the gate (First Load JS is JS-only).
 */
function makeRig({ routes, chunkSpecs, baselineRows, extraManifestKeys = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'bbb-'));
  const nextDir = join(dir, '.next');
  for (const { file, content } of chunkSpecs) {
    const p = join(nextDir, file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const pages = {};
  for (const [route, files] of Object.entries(routes)) {
    pages[route === '/' ? '/page' : `${route}/page`] = files;
  }
  Object.assign(pages, extraManifestKeys);
  writeFileSync(join(nextDir, 'app-build-manifest.json'), JSON.stringify({ pages }, null, 2));
  const baselinePath = join(dir, 'baseline.md');
  const header = '| Route | Baseline First Load JS (B) |\n|---|---|\n';
  const body = baselineRows.map(([r, b]) => `| \`${r}\` | ${b} |`).join('\n');
  writeFileSync(baselinePath, `# doc\n\n<!-- BUNDLE-BASELINE-START -->\n${header}${body}\n<!-- BUNDLE-BASELINE-END -->\n`);
  return { dir, nextDir, baselinePath };
}

function runGate({ nextDir, baselinePath, args = [] }) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, BUNDLE_NEXT_DIR: nextDir, BUNDLE_BASELINE_FILE: baselinePath },
    encoding: 'utf8',
  });
}

// Deterministic content: 'x' repeats compress predictably per length.
const C = (n) => Buffer.from('a'.repeat(n));
const A_JS = 'static/chunks/a.js';
const B_JS = 'static/chunks/app/x/page-1.js';
const SHARED = 'static/chunks/shared.js';
const CSS = 'static/css/style.css';

const SHARED_GZ = gz(C(4000));
const A_GZ = gz(C(1000));
const B_GZ = gz(C(2000));

const TWO_ROUTES = {
  routes: { '/': [SHARED, A_JS], '/cart': [SHARED, B_JS, CSS] },
  chunkSpecs: [
    { file: SHARED, content: C(4000) },
    { file: A_JS, content: C(1000) },
    { file: B_JS, content: C(2000) },
    { file: CSS, content: C(9000) },
  ],
};

test('within budget passes', () => {
  const rig = makeRig({
    ...TWO_ROUTES,
    baselineRows: [['/', SHARED_GZ + A_GZ], ['/cart', SHARED_GZ + B_GZ]],
  });
  const r = runGate(rig);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /margin \+0 B/); // exact-at-budget is allowed (>= 0)
  assert.match(r.stdout, /gate OK/);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('DELIBERATE over-budget negative test: 1 byte over fails and names the route', () => {
  const rig = makeRig({
    ...TWO_ROUTES,
    baselineRows: [['/', SHARED_GZ + A_GZ - 1], ['/cart', SHARED_GZ + B_GZ + 500]],
  });
  const r = runGate(rig);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gate FAILED \(1 route/);
  assert.match(r.stderr, /- \/: \d+ B > baseline \d+ B \(\+1 B\)/);
  assert.match(r.stdout, /OVER by 1 B/);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('comma-formatted baselines parse', () => {
  const rig = makeRig({
    ...TWO_ROUTES,
    baselineRows: [],
  });
  // rewrite the baseline with separators, bypassing makeRig row formatting
  writeFileSync(rig.baselinePath, `<!-- BUNDLE-BASELINE-START -->
| Route | Baseline First Load JS (B) |
|---|---|
| \`/\` | ${(SHARED_GZ + A_GZ).toString().replace(/\d(?=(\d{3})+$)/g, '$&,')} |
| \`/cart\` | ${(SHARED_GZ + B_GZ + 1).toString().replace(/\d(?=(\d{3})+$)/g, '$&,')} |
<!-- BUNDLE-BASELINE-END -->
`);
  const r = runGate(rig);
  assert.equal(r.status, 0, r.stderr);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('css chunks are excluded from First Load JS', () => {
  // /cart entry contains a 9 KB css file; a baseline of exactly the JS sum
  // still passes — had CSS counted, it would be ~2 KB gz OVER.
  const rig = makeRig({ ...TWO_ROUTES, baselineRows: [['/cart', SHARED_GZ + B_GZ]] });
  const r = runGate(rig);
  assert.equal(r.status, 0, r.stderr);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('baseline route missing from the manifest fails (stale/renamed route)', () => {
  const rig = makeRig({
    ...TWO_ROUTES,
    baselineRows: [['/', SHARED_GZ + A_GZ], ['/cart', SHARED_GZ + B_GZ], ['/gone', 200000]],
  });
  const r = runGate(rig);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /manifest entry for route "\/gone" is missing/);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('missing chunk file on disk fails (dead manifest)', () => {
  const rig = makeRig({ ...TWO_ROUTES, baselineRows: [['/', SHARED_GZ + A_GZ]] });
  rmSync(join(rig.nextDir, A_JS));
  const r = runGate(rig);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist on disk/);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('baseline markers missing fails loudly (a dead gate is a failed gate)', () => {
  const rig = makeRig({ ...TWO_ROUTES, baselineRows: [['/', 1]] });
  writeFileSync(rig.baselinePath, '# no table here\n');
  const r = runGate(rig);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /baseline markers .* not found/);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('empty baseline table fails', () => {
  const rig = makeRig({ ...TWO_ROUTES, baselineRows: [] });
  const r = runGate(rig);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /zero route rows/);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('duplicate baseline rows fail', () => {
  const rig = makeRig({ ...TWO_ROUTES, baselineRows: [['/', 999999], ['/', 999999]] });
  const r = runGate(rig);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /duplicate baseline rows/);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('non-integer baseline bytes fail (no silent NaN passes)', () => {
  const rig = makeRig({ ...TWO_ROUTES, baselineRows: [] });
  writeFileSync(rig.baselinePath, `<!-- BUNDLE-BASELINE-START -->
| Route | Baseline |
|---|---|
| \`/\` | 12.5 kB |
<!-- BUNDLE-BASELINE-END -->
`);
  const r = runGate(rig);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /non-integer bytes/);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('unparseable manifest JSON fails with the build hint', () => {
  const rig = makeRig({ ...TWO_ROUTES, baselineRows: [['/', 1]] });
  writeFileSync(join(rig.nextDir, 'app-build-manifest.json'), '{not json');
  const r = runGate(rig);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /was `next build` run\?/);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('--print emits current rows without comparing', () => {
  const rig = makeRig({ ...TWO_ROUTES, baselineRows: [['/', 1]] }); // absurd baseline would fail the gate.
  const gate = runGate(rig);
  assert.equal(gate.status, 1); // confirmed
  const r = runGate({ ...rig, args: ['--print'] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`| \`/\` | ${SHARED_GZ + A_GZ} |`), r.stdout);
  // the route set is the table's: /cart is in the build but not budgeted,
  // so print must NOT invent a row for it
  assert.ok(!r.stdout.includes('/cart'), r.stdout);
  rmSync(rig.dir, { recursive: true, force: true });
});

test('route set beyond the table is ignored (only the committed set is budgeted)', () => {
  const rig = makeRig({
    ...TWO_ROUTES,
    baselineRows: [['/', SHARED_GZ + A_GZ]],
  });
  const r = runGate(rig); // /cart exists in the build but has no baseline row
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /vs 1 baseline routes/);
  rmSync(rig.dir, { recursive: true, force: true });
});
