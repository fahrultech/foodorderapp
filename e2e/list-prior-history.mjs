#!/usr/bin/env node
/**
 * Session 110 (gen 2) — pick the LATEST prior run's fixture-timing-history
 * artifact for the official actions/download-artifact@v4 step.
 *
 * Listing is anonymous-safe (public repo, proven live). Session 111
 * correction to the old narrative: the custom-REST DOWNLOAD actually works
 * (job token -> 302 -> SAS blob; the stripped Authorization on that hop is
 * harmless — the SAS IS the credential). What failed in every run 125-132
 * was the official SDK step lacking its token input, which made it search
 * the CURRENT run and stamp "Artifact not found" (fixed in ci.yml). The
 * listing here exists so the SDK path can do the download. The history is
 * a rolling chain (each file already contains the merged prior ones,
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
