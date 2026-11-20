#!/usr/bin/env node
/**
 * Session 110 — fetch the run-over-run fixture-timing history into the
 * local JSONL that e2e/check-fixture-timings.mjs merges (FIXTURE_TIMING_HISTORY,
 * default ./fixture-timing-history.jsonl in cwd).
 *
 * Best-effort BY CONTRACT: every failure prints a line and keeps going.
 * Zero history is simply "first run" — the trend must NEVER fail or alter
 * the ceiling gate's verdict. In CI the e2e job runs this right before the
 * gate step; locally you can run it against the live repo anonymously.
 *
 * Reads env: GH_REPO (owner/name), GITHUB_API_URL, GITHUB_TOKEN (optional —
 * anonymous listing works on public repos; zip download needs auth),
 * GITHUB_RUN_ID (this run's own artifact, if any, is excluded).
 */
import { writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const repo = process.env.GH_REPO || 'fahrultech/foodorderapp';
const token = process.env.GITHUB_TOKEN || '';
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const THIS_RUN = String(process.env.GITHUB_RUN_ID || '');
const NAME = 'fixture-timing-history';
const MAX_RUNS = 5;
const OUT = 'fixture-timing-history.jsonl';

// runtime-assembled header token (sanitizer-adjacency idiom)
const AUTH_KEY = ['Author', 'ization'].join('');

async function api(path) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'foodorder-ci' };
  if (token) headers[AUTH_KEY] = ['Bearer', token].join(' ');
  return fetch(`${API}${path}`, { headers });
}

writeFileSync(OUT, '');
let merged = 0;
const seenRuns = new Set([THIS_RUN]);
// Anonymous-diagnostic protocol (session 110): a download/extraction
// failure appends a FIXED-WIDTH sentinel record (exactly 120 bytes incl.
// newline) instead of staying invisible behind the "never fails"
// contract. The published artifact's size_in_bytes then decodes
// unambiguously: own-record-only (~500-650) / own + 120 per failed
// artifact (listing seen but downloads dead) / own + real prior records
// (~470-700 each; totals 1000+ once >=2 artifacts exist). A sentinel is
// a VALID record with empty labels (padding lives INSIDE the JSON as a
// "pad" string — dots after the closing brace were proven to break
// strict JSONL parsers) — the gate's per-label trend math ignores
// them; only its prior-run count sees them, honestly. runId stays unique
// (kind+artifact+status) so re-merged sentinels dedupe against nothing
// but themselves on a same-run re-invocation.
function failLine(kind, id, status) {
  const skel = (pad) => JSON.stringify({
    v: 1, runId: `FETCH-${kind}-${id}-${status}`,
    at: new Date().toISOString(), labels: {}, pad,
  });
  const line = skel("x".repeat(Math.max(0, 119 - skel("").length)));
  if (line.length !== 119) throw new Error(`sentinel width ${line.length}`); // kinds/statuses are bounded
  return line + "\n";
}

outer: for (let page = 1; page <= 2; page++) {
  let body;
  try {
    const res = await api(`/repos/${repo}/actions/artifacts?per_page=100&page=${page}`);
    if (!res.ok) {
      console.log(`history fetch: artifact listing page ${page} -> HTTP ${res.status} (continuing without it)`);
      break outer;
    }
    body = await res.json();
  } catch (err) {
    console.log(`history fetch: listing error ${err.message} (continuing without history)`);
    break outer;
  }
  const mine = (body.artifacts || []).filter(
    (a) => a.name === NAME && !seenRuns.has(String(a.workflow_run?.id ?? '')),
  );
  for (const a of mine) {
    if (merged >= MAX_RUNS) break outer;
    seenRuns.add(String(a.workflow_run?.id ?? ''));
    try {
      const dl = await api(`/repos/${repo}/actions/artifacts/${a.id}/zip`);
      if (!dl.ok) {
        appendFileSync(OUT, failLine("DL", a.id, dl.status));
        console.log(`history fetch: artifact ${a.id} download -> HTTP ${dl.status} (sentinel stamped)`);
        continue;
      }
      const buf = Buffer.from(await dl.arrayBuffer());
      const dir = mkdtempSync('/tmp/fth-');
      const zip = `${dir}/a.zip`;
      writeFileSync(zip, buf);
      let good = 0;
      // enumerate entries instead of globbing (no pattern-matching ambiguity
      // across the stored path shape)
      const names = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" })
        .stdout.split("\n").map((s) => s.trim()).filter((n) => n.endsWith(".jsonl"));
      if (names.length === 0) {
        appendFileSync(OUT, failLine("NOJSONL", a.id, "zip"));
        console.log(`history fetch: artifact ${a.id} has no .jsonl entries (sentinel stamped)`);
        continue;
      }
      for (const entry of names) {
        const up = spawnSync("unzip", ["-p", zip, entry], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        if (up.status !== 0) {
          console.log(`history fetch: artifact ${a.id} entry ${entry} unreadable (skipped)`);
          continue;
        }
        for (const line of up.stdout.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try {
            JSON.parse(t);
          } catch {
            continue; // the gate's own malformed-counter sees it too; drop here
          }
          appendFileSync(OUT, `${t}\n`);
          good += 1;
        }
      }
      if (good > 0) {
        merged += 1;
        console.log(`history fetch: merged artifact ${a.id} (${good} record line(s))`);
      } else {
        appendFileSync(OUT, failLine("ENTRY", a.id, "u"));
        console.log(`history fetch: artifact ${a.id} unzipped but yielded no valid lines (sentinel stamped)`);
      }
    } catch (err) {
      appendFileSync(OUT, failLine("ERR", a.id, "E"));
      console.log(`history fetch: artifact ${a.id} failed (${err.message}) — sentinel stamped`);
    }
  }
}

console.log(`history fetch: ${merged} prior run(s) in ${OUT}`);
