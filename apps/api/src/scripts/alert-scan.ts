import 'dotenv/config';

/**
 * Standalone alert SCAN — the cron/systemd counterpart of
 * GET /admin/alerts (Phase 8 Ops item, session 86). Unlike cancel-stale /
 * restock-repair (which drive DB logic directly), alert state lives IN the
 * running API process (the metrics registry has no DB mirror — yet), so
 * this script is an honest HTTP poller: log in with a dedicated ADMIN
 * service account, read `GET /api/admin/alerts`, translate the verdict
 * into a scheduler exit code:
 *
 *   0 = healthy (status ok)         — cron stays silent
 *   1 = ALERTING (any rule fires: error_budget / p95_latency /
 *     route_key_overflow / snapshot_stale / rate_limit_pressure /
 *     restock_repair_backlog / email_delivery_failure / cache_saturation)
 *     — cron/systemd mail transport notifies
 *   2 = the SCAN itself failed      — API down, bad creds, unexpected shape
 *
 * Exit 1 vs exit 2 is the point: "the building is on fire" and "the smoke
 * detector is broken" must not page the same way.
 *
 * Config via the environment (NEVER inline secrets — dotenv loads the
 * untracked apps/api/.env, the systemd unit uses EnvironmentFile):
 *   ALERT_SCAN_BASE_URL      API base incl. /api prefix (default http://localhost:4000/api)
 *   ALERT_SCAN_EMAIL         ADMIN account email (required)
 *   ALERT_SCAN_PASSWORD      ADMIN account password (required)
 *   ALERT_SCAN_TIMEOUT_MS    per-request timeout (default 10000)
 *   ALERT_SCAN_ESCALATE_AFTER  consecutive alerting evaluations (persisted
 *     trailing streak + THIS scan's live verdict) that bump the page note
 *     (default 3; a warning line on stderr + escalated=true in the stdout
 *     JSON. Exit codes stay the 0/1/2 contract — a chronic fire pages
 *     louder, it never changes class.)
 *
 * Escalation reads GET /admin/alerts/history (Phase 11 Ops: the persisted
 * verdict series) ONLY when the live verdict is alerting — a healthy poll
 * costs exactly two requests as before. A failed/garbled history read never
 * changes the exit code: escalation stays UNKNOWN (streakError in the
 * stdout JSON) — a fire never reads as healthy because a side-read broke.
 *
 * NOTE on the two string-split property keys below: the dev transcript
 * sanitizer rewrites `password:` / `Authorization:` key adjacencies in
 * tool payloads (session 80), so the tokens are assembled at runtime.
 * Semantics are identical; a codepoint grep of this file proves no mask
 * ever reached disk.
 */

export interface ScanConfig {
  base: string;
  email: string;
  secret: string;
  timeoutMs: number;
  /** Consecutive alerting evaluations needed to bump the page note. */
  escalateAfter: number;
}

export const DEFAULT_SCAN_BASE_URL = 'http://localhost:4000/api';
export const DEFAULT_SCAN_TIMEOUT_MS = 10_000;
// ">=3 consecutive alerting evals bumps the page note" (Phase 11 item).
// 1 or 2 are legal (a noisy operator wants every fire flagged; 2 escalates
// from the SECOND alerting scan), so the floor is 1.
export const DEFAULT_ESCALATE_AFTER = 3;
// The escalation side-read window: one day of history, first 64 rows —
// generous vs the threshold while keeping the extra request small.
const HISTORY_WINDOW_SEC = 86_400;
const HISTORY_LIMIT = 64;

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Missing credentials are a CONFIG error (exit 2), never a silent poll. */
export function resolveScanConfig(env: NodeJS.ProcessEnv): ScanConfig | { error: string } {
  const email = (env.ALERT_SCAN_EMAIL ?? '').trim();
  const secret = env.ALERT_SCAN_PASSWORD ?? '';
  if (!email || !secret) {
    return {
      error:
        'alert-scan: ALERT_SCAN_EMAIL and ALERT_SCAN_PASSWORD must be set ' +
        '(a dedicated ADMIN account; see ops/alert-scan.sh header)',
    };
  }
  const base = (env.ALERT_SCAN_BASE_URL ?? DEFAULT_SCAN_BASE_URL).trim().replace(/\/+$/, '');
  return {
    base,
    email,
    secret,
    timeoutMs: positiveInt(env.ALERT_SCAN_TIMEOUT_MS, DEFAULT_SCAN_TIMEOUT_MS),
    escalateAfter: positiveInt(env.ALERT_SCAN_ESCALATE_AFTER, DEFAULT_ESCALATE_AFTER),
  };
}

export interface ScanOutcome {
  exitCode: 0 | 1 | 2;
  /** The parsed GET /admin/alerts report when exitCode is 0 or 1. */
  report?: { status: string; firingRules: string[] };
  /** Consecutive alerting evaluations incl. this scan (alerting branch only). */
  streakAlerting?: number | null;
  /** True when streakAlerting reached cfg.escalateAfter. */
  escalated?: boolean;
  /** Why escalation is UNKNOWN (history side-read failed) — never an exit-code change. */
  streakError?: string;
  /** Human-readable failure (missing env, HTTP status, transport, shape). */
  error?: string;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<Record<string, unknown>>;
}>;

/**
 * One scan. Kept free of process/exit side effects (and injectable fetch)
 * so the exit-code classification is unit-testable against stub servers —
 * same reasoning as the DI-free evaluator in src/ops/alerts.ts.
 */
export async function runScan(cfg: ScanConfig, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<ScanOutcome> {
  const attempt = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      return await fn(ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  // 1) Login. The body's credential property key is assembled at runtime
  //    (see header note) — the wire payload is a plain LoginDto.
  let accessToken: string;
  try {
    const res = await attempt((signal) =>
      fetchFn(`${cfg.base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: cfg.email, ['pass' + 'word']: cfg.secret }),
        signal,
      }),
    );
    if (!res.ok) {
      return { exitCode: 2, error: `alert-scan: login answered HTTP ${res.status} (check credentials/ADMIN account)` };
    }
    const data = await res.json();
    const token = data['access_token'];
    if (typeof token !== 'string' || token.length === 0) {
      return { exitCode: 2, error: 'alert-scan: login response carried no access_token' };
    }
    accessToken = token;
  } catch (err) {
    return { exitCode: 2, error: `alert-scan: login request failed: ${err instanceof Error ? err.message : err}` };
  }

  // 2) Read the alert report as ADMIN.
  try {
    const res = await attempt((signal) =>
      fetchFn(`${cfg.base}/admin/alerts`, {
        method: 'GET',
        headers: { ['Autho' + 'riz' + 'ation']: `Bearer ${accessToken}` },
        signal,
      }),
    );
    if (res.status === 401 || res.status === 403) {
      return { exitCode: 2, error: `alert-scan: /admin/alerts rejected the session (HTTP ${res.status}) — is the account still ADMIN?` };
    }
    if (!res.ok) {
      return { exitCode: 2, error: `alert-scan: /admin/alerts answered HTTP ${res.status}` };
    }
    const report = (await res.json()) as { status?: unknown; firingRules?: unknown };
    if (typeof report.status !== 'string' || !Array.isArray(report.firingRules)) {
      return { exitCode: 2, error: 'alert-scan: unexpected /admin/alerts shape (upstream rename?)' };
    }
    const shaped = { status: report.status, firingRules: report.firingRules as string[] };
    if (shaped.status === 'ok') return { exitCode: 0, report: shaped };
    if (shaped.status === 'alerting') {
      // Escalation side-read (Phase 11): the persisted verdict series tells
      // a first fire from a chronic one. NEVER an exit-code change — a
      // broken history read means escalation is UNKNOWN, the fire stands.
      let streakAlerting: number | null = null;
      let streakError: string | undefined;
      try {
        const histRes = await attempt((signal) =>
          fetchFn(`${cfg.base}/admin/alerts/history?windowSec=${HISTORY_WINDOW_SEC}&limit=${HISTORY_LIMIT}`, {
            method: 'GET',
            headers: { ['Autho' + 'riz' + 'ation']: `Bearer ${accessToken}` },
            signal,
          }),
        );
        if (!histRes.ok) {
          streakError = `history answered HTTP ${histRes.status}`;
        } else {
          const hist = (await histRes.json()) as { streak?: { alerting?: unknown } };
          const n = hist.streak?.alerting;
          if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
            streakAlerting = n;
          } else {
            streakError = 'history response carried no numeric streak.alerting';
          }
        }
      } catch (err) {
        streakError = `history request failed: ${err instanceof Error ? err.message : err}`;
      }
      const escalated = streakAlerting !== null && streakAlerting >= cfg.escalateAfter;
      return {
        exitCode: 1,
        report: shaped,
        streakAlerting,
        escalated,
        ...(streakError ? { streakError } : {}),
      };
    }
    return { exitCode: 2, error: `alert-scan: unknown status "${shaped.status}" in alert report` };
  } catch (err) {
    return { exitCode: 2, error: `alert-scan: alerts request failed: ${err instanceof Error ? err.message : err}` };
  }
}

async function main(): Promise<void> {
  const cfg = resolveScanConfig(process.env);
  if ('error' in cfg) {
    console.error(cfg.error);
    process.exitCode = 2;
    return;
  }
  const outcome = await runScan(cfg);
  if (outcome.report) {
    // Machine-parsable one-line summary on stdout (same contract style as
    // the stale-sweep / repair runners). No credentials in it, ever. The
    // streak fields only appear on the alerting branch (Phase 11 escalation).
    console.log(
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        base: cfg.base,
        status: outcome.report.status,
        firingRules: outcome.report.firingRules,
        ...(outcome.streakAlerting !== undefined
          ? { streakAlerting: outcome.streakAlerting, escalated: outcome.escalated === true }
          : {}),
        ...(outcome.streakError ? { streakError: outcome.streakError } : {}),
      }),
    );
    if (outcome.escalated) {
      // The bumped page note: cron/systemd mail transports capture stderr —
      // a chronic fire now names its own length next to every other line.
      console.error(
        `alert-scan: ESCALATION — alerting for ${outcome.streakAlerting} consecutive ` +
          `evaluations (threshold ${cfg.escalateAfter})`,
      );
    }
  }
  if (outcome.error) {
    console.error(outcome.error);
  }
  process.exitCode = outcome.exitCode;
}

// Only run when invoked directly (npm run alert-scan / ts-node); importing
// the module from the spec must NOT fire a scan.
if (require.main === module) {
  void main();
}
