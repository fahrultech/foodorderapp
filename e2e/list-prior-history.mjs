#!/usr/bin/env node
/**
 * Session 110 (gen 2) — pick the LATEST prior run's fixture-timing-history
 * artifact for the official actions/download-artifact@v4 step.
 *
 * Listing is anonymous-safe (public repo, proven live) — the DOWNLOAD is
 * what no custom-code hop has ever gotten right here: job-token REST 403s
 * (scope), and undici strips Authorization on the 302 to the signed blob
 * host (empirically proven). The official action's SDK rides the runner's
 * own system auth, so we only need to tell it WHICH run. The history is a
 * rolling chain (each file already contains the merged prior ones,
 * gate-trimmed to 20), so the single newest prior artifact is enough.
 *
 * Writes GITHUB_OUTPUT: found=0|1, run_id, artifact_id. NEVER fails the
 * job: any error still emits found=0 (the gate then runs history-less —
 * a valid first-run state).
 */
import { appendFileSync } from 'node:fs';

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const REPO = process.env.GH_REPO || '';
const THIS_RUN = String(process.env.GITHUB_RUN_ID || '');
const NAME = 'fixture-timing-history';

function emit(found, runId = '', artifactId = '') {
  const out = `found=${found ? 1 : 0}\nrun_id=${found ? runId : ''}\nartifact_id=${found ? artifactId : ''}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
  console.log(`history list: found=${found ? 1 : 0} run=${found ? runId : '-'}`);
}

try {
  const res = await fetch(`${API}/repos/${REPO}/actions/artifacts?per_page=100`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'foodorder-ci' },
  });
  if (!res.ok) {
    console.log(`history list: listing HTTP ${res.status} -> no prior`);
    emit(false);
  } else {
    const body = await res.json();
    const cands = (body.artifacts || [])
      .filter((a) => a.name === NAME && String(a.workflow_run?.id ?? '') !== THIS_RUN)
      .sort((x, y) => String(y.created_at ?? '').localeCompare(String(x.created_at ?? '')));
    const top = cands[0];
    if (!top) emit(false);
    else emit(true, top.workflow_run.id, top.id);
  }
} catch (err) {
  console.log(`history list: ${err.message} -> no prior`);
  emit(false);
}
