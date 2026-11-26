import {
  DEFAULT_ALERT_THRESHOLDS,
  evaluateAlerts,
  resolveAlertThresholds,
  summarizeAlerts,
} from './alerts';
import {
  OVERFLOW_KEY,
  RequestMetricsRegistry,
} from '../common/metrics/request-metrics';
import { MAX_HTTP_CACHE_ENTRIES } from '../common/http-cache/http-cache';

/**
 * The evaluator runs against snapshots produced by the REAL registry — a
 * field the registry renames or a status class it stops tallying fails
 * these pins too, not just the /admin/metrics round-trip.
 */
function registrySnapshot(fill: (reg: RequestMetricsRegistry) => void): ReturnType<RequestMetricsRegistry['snapshot']> {
  const reg = new RequestMetricsRegistry();
  fill(reg);
  return reg.snapshot();
}

/** fill(reg, count, status, ms) — n samples of one shape. */
const many = (key: string, n: number, status: number, ms: number) => (reg: RequestMetricsRegistry) => {
  for (let i = 0; i < n; i++) reg.record(key, status, ms);
};

const rule = (report: ReturnType<typeof evaluateAlerts>, id: string) =>
  report.rules.find((r) => r.id === id)!;

describe('resolveAlertThresholds', () => {
  it('defaults when nothing is set or values are blank', () => {
    expect(resolveAlertThresholds({})).toEqual(DEFAULT_ALERT_THRESHOLDS);
    expect(resolveAlertThresholds({ ALERT_5XX_RATE_PCT_MAX: '  ', ALERT_P95_MS_MAX: '' })).toEqual(
      DEFAULT_ALERT_THRESHOLDS,
    );
  });

  it('garbage/negative NEVER crashes — falls back per knob (observability policy)', () => {
    const t = resolveAlertThresholds({
      ALERT_5XX_RATE_PCT_MAX: 'half',
      ALERT_P95_MS_MAX: '-5',
      ALERT_MIN_REQUESTS: 'lots',
    });
    expect(t).toEqual(DEFAULT_ALERT_THRESHOLDS);
  });

  it('zero is a LEGAL tightened ceiling, negative is not', () => {
    const t = resolveAlertThresholds({
      ALERT_5XX_RATE_PCT_MAX: '0',
      ALERT_P95_MS_MAX: '0',
      ALERT_MIN_REQUESTS: '1',
      ALERT_CACHE_EVICTIONS_MAX: '0',
    });
    expect(t).toEqual({
      fiveXxRatePctMax: 0,
      p95MsMax: 0,
      minRequests: 1,
      rateLimitPctMax: 5,
      snapshotStaleAfterSec: null,
      restockBacklogMax: 0,
      emailMinAttempts: 5,
      emailFailurePctMax: 50,
      cacheEvictionsMax: 0,
    });
    expect(resolveAlertThresholds({ ALERT_5XX_RATE_PCT_MAX: '-0.1' }).fiveXxRatePctMax).toBe(0.5);
  });

  it('min sample is a positive integer (0/fractional collapses to default)', () => {
    expect(resolveAlertThresholds({ ALERT_MIN_REQUESTS: '0' }).minRequests).toBe(50);
    expect(resolveAlertThresholds({ ALERT_MIN_REQUESTS: '2.9' }).minRequests).toBe(2);
    expect(resolveAlertThresholds({ ALERT_MIN_REQUESTS: '1e3' }).minRequests).toBe(1000);
  });

  it('ALERT_SNAPSHOT_STALE_AFTER_SEC: positive integer overrides, everything else means "derive 2x interval" (null)', () => {
    expect(resolveAlertThresholds({ ALERT_SNAPSHOT_STALE_AFTER_SEC: '30' }).snapshotStaleAfterSec).toBe(30);
    expect(resolveAlertThresholds({ ALERT_SNAPSHOT_STALE_AFTER_SEC: '4.9' }).snapshotStaleAfterSec).toBe(4);
    // 0 is NOT a legal override here (a zero grace fires always) — falls back to derived.
    expect(resolveAlertThresholds({ ALERT_SNAPSHOT_STALE_AFTER_SEC: '0' }).snapshotStaleAfterSec).toBeNull();
    expect(resolveAlertThresholds({ ALERT_SNAPSHOT_STALE_AFTER_SEC: '-5' }).snapshotStaleAfterSec).toBeNull();
    expect(resolveAlertThresholds({ ALERT_SNAPSHOT_STALE_AFTER_SEC: 'soon' }).snapshotStaleAfterSec).toBeNull();
    expect(resolveAlertThresholds({ ALERT_SNAPSHOT_STALE_AFTER_SEC: '' }).snapshotStaleAfterSec).toBeNull();
    expect(resolveAlertThresholds({}).snapshotStaleAfterSec).toBeNull();
  });
});

describe('evaluateAlerts — error_budget', () => {
  it('no traffic: not evaluable, ok', () => {
    const report = evaluateAlerts(registrySnapshot(() => undefined));
    expect(report.status).toBe('ok');
    const eb = rule(report, 'error_budget');
    expect(eb.firing).toBe(false);
    expect(eb.observed).toBeNull();
    expect(eb.detail).toMatch(/no requests/);
  });

  it('below the min sample: rate computed into detail but NOT evaluated', () => {
    // 1 of 10 requests is a 5xx = 10% — far over any SLO, but noise.
    const report = evaluateAlerts(
      registrySnapshot((reg) => {
        many('GET /api/x', 9, 200, 10)(reg);
        reg.record('GET /api/x', 503, 10);
      }),
    );
    const eb = rule(report, 'error_budget');
    expect(eb.firing).toBe(false);
    expect(eb.observed).toBeNull();
    expect(eb.detail).toMatch(/min sample/);
    expect(report.status).toBe('ok');
  });

  it('exactly AT the budget is within it (fires STRICTLY above)', () => {
    const report = evaluateAlerts(
      registrySnapshot((reg) => {
        many('GET /api/x', 995, 200, 10)(reg);
        many('GET /api/x', 5, 500, 10)(reg);
      }),
    );
    expect(rule(report, 'error_budget').observed).toBe(0.5);
    expect(rule(report, 'error_budget').firing).toBe(false);
  });

  it('one unit over fires with severity error and honest numbers', () => {
    const report = evaluateAlerts(
      registrySnapshot((reg) => {
        many('GET /api/x', 994, 200, 10)(reg);
        many('GET /api/x', 6, 500, 10)(reg);
      }),
    );
    expect(report.status).toBe('alerting');
    expect(report.firingRules).toEqual(['error_budget']);
    const eb = rule(report, 'error_budget');
    expect(eb).toMatchObject({ firing: true, severity: 'error', observed: 0.6, threshold: 0.5 });
    expect(eb.detail).toContain('6 of 1000');
  });

  it('tightened 0% budget: the SAME snapshot flips to firing', () => {
    const snap = registrySnapshot((reg) => {
      many('GET /api/x', 995, 200, 10)(reg);
      many('GET /api/x', 5, 500, 10)(reg);
    });
    // Exactly 0.5% on the default budget → quiet (pinned above); tighten to
    // 0 and the same data must alert — proves the threshold drives the rule.
    expect(rule(evaluateAlerts(snap), 'error_budget').firing).toBe(false);
    const strict = evaluateAlerts(snap, { ...DEFAULT_ALERT_THRESHOLDS, fiveXxRatePctMax: 0 });
    expect(rule(strict, 'error_budget')).toMatchObject({ firing: true, threshold: 0 });
  });

  it('0.9% over the DEFAULT budget fires (previous case, honest expectation)', () => {
    const snap = registrySnapshot((reg) => {
      many('GET /api/x', 110, 200, 10)(reg);
      reg.record('GET /api/x', 500, 10);
    });
    const report = evaluateAlerts(snap);
    expect(rule(report, 'error_budget').observed).toBeCloseTo(0.9, 1);
    expect(rule(report, 'error_budget').firing).toBe(true);
  });

  it('zero threshold + min 1: a lone 5xx out of one request is a verdict', () => {
    const snap = registrySnapshot(many('GET /api/x', 1, 500, 10));
    const report = evaluateAlerts(snap, { fiveXxRatePctMax: 0, p95MsMax: 100000, minRequests: 1, rateLimitPctMax: 5, snapshotStaleAfterSec: null, restockBacklogMax: 0, emailMinAttempts: 5, emailFailurePctMax: 50, cacheEvictionsMax: 500 });
    expect(rule(report, 'error_budget')).toMatchObject({ firing: true, observed: 100 });
  });

  it('4xx never burns the budget (client noise is not an outage)', () => {
    const snap = registrySnapshot((reg) => {
      many('GET /api/x', 50, 200, 10)(reg);
      many('GET /api/x', 50, 404, 10)(reg);
    });
    expect(rule(evaluateAlerts(snap), 'error_budget').observed).toBe(0);
    expect(evaluateAlerts(snap).status).toBe('ok');
  });
});

describe('evaluateAlerts — p95_latency', () => {
  it('no latency samples: null observed, ok (fresh boot)', () => {
    const report = evaluateAlerts(registrySnapshot(() => undefined));
    const p = rule(report, 'p95_latency');
    expect(p.firing).toBe(false);
    expect(p.observed).toBeNull();
  });

  it('healthy traffic sits under the 1000ms default', () => {
    const snap = registrySnapshot(many('GET /api/x', 100, 200, 10));
    const p = rule(evaluateAlerts(snap), 'p95_latency');
    // Nearest histogram bound reached by rank(95% of 100) samples @10ms is 10.
    expect(p).toMatchObject({ firing: false, observed: 10 });
  });

  it('bound creep fires: p95 estimate over the ceiling, severity error', () => {
    const snap = registrySnapshot(many('POST /api/orders', 100, 201, 3000));
    const report = evaluateAlerts(snap);
    const p = rule(report, 'p95_latency');
    // Nearest bound >= 3000ms in the histogram is 5000.
    expect(p).toMatchObject({ firing: true, observed: 5000, threshold: 1000 });
    expect(p.detail).toMatch(/nearest-bound/);
    expect(report.firingRules).toEqual(['p95_latency']);
  });

  it('exactly AT the ceiling does not fire; a tightened ceiling fires the floor', () => {
    const snap = registrySnapshot(many('GET /api/x', 100, 200, 10)); // p95 estimate 10
    const at = evaluateAlerts(snap, { ...DEFAULT_ALERT_THRESHOLDS, p95MsMax: 10 });
    expect(rule(at, 'p95_latency').firing).toBe(false);
    const below = evaluateAlerts(snap, { ...DEFAULT_ALERT_THRESHOLDS, p95MsMax: 5 });
    expect(rule(below, 'p95_latency').firing).toBe(true);
  });
});

describe('evaluateAlerts — route_key_overflow', () => {
  it('under the cap: keys counted into observed, ok', () => {
    const snap = registrySnapshot((reg) => {
      many('GET /api/a', 1, 200, 10)(reg);
      many('GET /api/b', 1, 200, 10)(reg);
    });
    const o = rule(evaluateAlerts(snap), 'route_key_overflow');
    expect(o).toMatchObject({ firing: false, observed: 2 });
    expect(o.detail).toContain('cap 250');
  });

  it('folding into the overflow bucket fires a WARNING and still says alerting', () => {
    const reg = new RequestMetricsRegistry(3); // tiny cap for the test
    for (const p of ['/a', '/b', '/c', '/d', '/e']) reg.record(`GET ${p}`, 200, 10);
    const snap = reg.snapshot();
    expect(snap.totals.overflowed).toBe(true);
    const report = evaluateAlerts(snap);
    const o = rule(report, 'route_key_overflow');
    expect(o).toMatchObject({ firing: true, severity: 'warning' });
    expect(o.detail).toContain(OVERFLOW_KEY);
    expect(report.status).toBe('alerting');
    expect(report.firingRules).toEqual(['route_key_overflow']);
  });
});

describe('evaluateAlerts — snapshot_stale (session 109)', () => {
  const T = Date.parse('2026-11-20T00:00:00.000Z');
  const snap = (uptimeSec: number) => ({
    ...registrySnapshot(() => undefined),
    uptimeSec,
  });
  const fresh = (f: Record<string, unknown>) =>
    ({ enabled: true, intervalSec: 300, lastCapturedAtMs: null, ...f }) as any;

  it('no observation (the synchronous fold-line consumer): rule present, NOT firing, honest detail', () => {
    const report = evaluateAlerts(snap(999999));
    expect(report.rules).toHaveLength(8);
    const s = rule(report, 'snapshot_stale');
    expect(s).toMatchObject({ firing: false, severity: 'warning', observed: null });
    expect(s.detail).toMatch(/not evaluated/);
    expect(report.status).toBe('ok');
  });

  it('DISABLED writer is exempt — even with zero rows and huge uptime', () => {
    const report = evaluateAlerts(
      snap(100000),
      DEFAULT_ALERT_THRESHOLDS,
      fresh({ enabled: false, intervalSec: 0 }),
    );
    const s = rule(report, 'snapshot_stale');
    expect(s.firing).toBe(false);
    expect(s.detail).toMatch(/disabled .*exempt/);
    expect(report.status).toBe('ok');
  });

  it('a recent row sits inside the derived 2x-interval ceiling (600s at 300s interval)', () => {
    const report = evaluateAlerts(snap(999999), DEFAULT_ALERT_THRESHOLDS, fresh({
      lastCapturedAtMs: T - 10_000,
      nowMs: T,
    }));
    const s = rule(report, 'snapshot_stale');
    expect(s).toMatchObject({ firing: false, observed: 10, threshold: 600 });
    expect(s.detail).toMatch(/within/);
  });

  it('fires STRICTLY above the ceiling: exactly 600s old is quiet, 600.001s alerts with numbers', () => {
    const at = evaluateAlerts(snap(999999), DEFAULT_ALERT_THRESHOLDS, fresh({
      lastCapturedAtMs: T - 600_000,
      nowMs: T,
    }));
    expect(rule(at, 'snapshot_stale').firing).toBe(false);

    const over = evaluateAlerts(snap(999999), DEFAULT_ALERT_THRESHOLDS, fresh({
      lastCapturedAtMs: T - 600_001,
      nowMs: T,
    }));
    const s = rule(over, 'snapshot_stale');
    expect(s).toMatchObject({ firing: true, observed: 600, threshold: 600 });
    expect(over.status).toBe('alerting');
    expect(over.firingRules).toEqual(['snapshot_stale']);
    expect(s.detail).toMatch(/silently dead/);
  });

  it('future-dated row (clock skew) reads as age 0, never a negative fire', () => {
    const report = evaluateAlerts(snap(999999), DEFAULT_ALERT_THRESHOLDS, fresh({
      lastCapturedAtMs: T + 500_000,
      nowMs: T,
    }));
    expect(rule(report, 'snapshot_stale')).toMatchObject({ firing: false, observed: 0 });
  });

  it('ALERT_SNAPSHOT_STALE_AFTER_SEC override replaces the 2x derivation', () => {
    const snap200 = fresh({ lastCapturedAtMs: T - 200_000, nowMs: T });
    // Default (derived 600): quiet at 200s old...
    expect(rule(evaluateAlerts(snap(999999), DEFAULT_ALERT_THRESHOLDS, snap200), 'snapshot_stale').firing).toBe(false);
    // ...tightened to 120 by env: the SAME observation fires and reports the tight ceiling.
    const strict = evaluateAlerts(
      snap(999999),
      { ...DEFAULT_ALERT_THRESHOLDS, snapshotStaleAfterSec: 120 },
      snap200,
    );
    expect(rule(strict, 'snapshot_stale')).toMatchObject({ firing: true, threshold: 120, observed: 200 });
  });

  it('zero rows respect an uptime grace (boot has not reached its first tick)', () => {
    const young = evaluateAlerts(snap(50), DEFAULT_ALERT_THRESHOLDS, fresh({ intervalSec: 300 }));
    expect(rule(young, 'snapshot_stale')).toMatchObject({ firing: false, observed: 50 });
    expect(rule(young, 'snapshot_stale').detail).toMatch(/first write due/);

    const old = evaluateAlerts(snap(700), DEFAULT_ALERT_THRESHOLDS, fresh({ intervalSec: 300 }));
    const s = rule(old, 'snapshot_stale');
    expect(s.firing).toBe(true);
    expect(s.detail).toMatch(/no snapshot row within the 600s grace/);
    expect(old.firingRules).toEqual(['snapshot_stale']);
  });

  it('UNREADABLE store reports honestly as unreadable (and fires past the grace)', () => {
    const report = evaluateAlerts(snap(700), DEFAULT_ALERT_THRESHOLDS, fresh({ storeError: true }));
    const s = rule(report, 'snapshot_stale');
    expect(s.firing).toBe(true);
    expect(s.detail).toMatch(/UNREADABLE/);
    expect(s.detail).not.toMatch(/no rows/);
  });

  it('summarizeAlerts carries the firing rule into the fold-line verdict shape', () => {
    const report = evaluateAlerts(snap(700), DEFAULT_ALERT_THRESHOLDS, fresh({ intervalSec: 300 }));
    expect(summarizeAlerts(report)).toEqual({ status: 'alerting', firing: ['snapshot_stale'] });
  });
});

describe('evaluateAlerts — rate_limit_pressure (session 123)', () => {
  /** fill with n samples, t of them guard-marked 429s. */
  const mix = (n: number, t: number) => (reg: RequestMetricsRegistry) => {
    for (let i = 0; i < n - t; i++) reg.record('GET /api/x', 200, 10);
    for (let i = 0; i < t; i++) reg.record('GET /api/x', 429, 10, null, true);
  };

  it('rule is present FIFTH with default ceiling 5% and warning severity', () => {
    const report = evaluateAlerts(registrySnapshot(() => undefined));
    expect(report.rules).toHaveLength(8);
    expect(report.rules[4].id).toBe('rate_limit_pressure');
    expect(report.rules[4]).toMatchObject({ firing: false, severity: 'warning', threshold: 5 });
  });

  it('no requests: not evaluable, honest detail, observed null', () => {
    const rl = rule(evaluateAlerts(registrySnapshot(() => undefined)), 'rate_limit_pressure');
    expect(rl).toMatchObject({ firing: false, observed: null });
    expect(rl.detail).toMatch(/not evaluable/);
  });

  it('sample below the minRequests floor: NOT evaluated even at a 60% 429 share', () => {
    const report = evaluateAlerts(registrySnapshot(mix(10, 6)));
    const rl = rule(report, 'rate_limit_pressure');
    expect(rl.firing).toBe(false);
    expect(rl.observed).toBeNull();
    expect(rl.detail).toMatch(/min sample.*not evaluated/s);
    expect(report.status).toBe('ok');
  });

  it('exactly AT the ceiling does not fire (fires STRICTLY above)', () => {
    const report = evaluateAlerts(registrySnapshot(mix(100, 5)));
    const rl = rule(report, 'rate_limit_pressure');
    expect(rl).toMatchObject({ firing: false, observed: 5, threshold: 5 });
    expect(rl.detail).toMatch(/within/);
    expect(report.status).toBe('ok');
  });

  it('one unit over fires: warning severity, honest numbers, verdict flips', () => {
    const report = evaluateAlerts(registrySnapshot(mix(100, 6)));
    const rl = rule(report, 'rate_limit_pressure');
    expect(rl).toMatchObject({ firing: true, severity: 'warning', observed: 6, threshold: 5 });
    expect(rl.detail).toContain('6 of 100');
    expect(report.status).toBe('alerting');
    expect(report.firingRules).toEqual(['rate_limit_pressure']);
  });

  it('tightened 0% ceiling: the SAME snapshot flips to firing (knob drives the rule)', () => {
    const snap = registrySnapshot(mix(100, 1));
    expect(rule(evaluateAlerts(snap), 'rate_limit_pressure').firing).toBe(false);
    expect(
      rule(evaluateAlerts(snap, { ...DEFAULT_ALERT_THRESHOLDS, rateLimitPctMax: 0 }), 'rate_limit_pressure'),
    ).toMatchObject({ firing: true, threshold: 0, observed: 1 });
  });

  it('429s WITHOUT the guard stamp never inflate the share (limiter-exact count)', () => {
    const reg = new RequestMetricsRegistry();
    for (let i = 0; i < 90; i++) reg.record('GET /api/x', 200, 10);
    for (let i = 0; i < 10; i++) reg.record('GET /api/x', 429, 10); // same status, unmarked
    const report = evaluateAlerts(
      reg.snapshot(),
      { ...DEFAULT_ALERT_THRESHOLDS, rateLimitPctMax: 0 },
    );
    expect(reg.snapshot().totals.throttled).toBe(0);
    expect(rule(report, 'rate_limit_pressure')).toMatchObject({ firing: false, observed: 0 });
  });

  it('ALERT_RATE_LIMIT_PCT_MAX parsing: valid decimals pass, garbage/negative fall back, 0 is legal', () => {
    expect(resolveAlertThresholds({ ALERT_RATE_LIMIT_PCT_MAX: '2.5' }).rateLimitPctMax).toBe(2.5);
    expect(resolveAlertThresholds({ ALERT_RATE_LIMIT_PCT_MAX: '0' }).rateLimitPctMax).toBe(0);
    expect(resolveAlertThresholds({ ALERT_RATE_LIMIT_PCT_MAX: 'half' }).rateLimitPctMax).toBe(5);
    expect(resolveAlertThresholds({ ALERT_RATE_LIMIT_PCT_MAX: '-1' }).rateLimitPctMax).toBe(5);
    expect(resolveAlertThresholds({ ALERT_RATE_LIMIT_PCT_MAX: '' }).rateLimitPctMax).toBe(5);
  });
});

describe('evaluateAlerts — restock_repair_backlog (Phase 14)', () => {
  const snap = () => registrySnapshot(() => undefined);

  it('rule is present SIXTH with default ceiling 0 and warning severity', () => {
    const report = evaluateAlerts(snap());
    expect(report.rules).toHaveLength(8);
    expect(report.rules[5].id).toBe('restock_repair_backlog');
    expect(report.rules[5]).toMatchObject({ firing: false, severity: 'warning', threshold: 0 });
  });

  it('no observation (the synchronous fold-line consumer): NOT evaluated, honest detail', () => {
    const report = evaluateAlerts(snap(), DEFAULT_ALERT_THRESHOLDS, null);
    const rb = rule(report, 'restock_repair_backlog');
    expect(rb).toMatchObject({ firing: false, observed: null });
    expect(rb.detail).toMatch(/no repair-backlog observation supplied .*not evaluated/);
    expect(report.status).toBe('ok');
  });

  it('UNREADABLE count reports honestly as unreadable — never a false fire, never a zero', () => {
    const report = evaluateAlerts(snap(), DEFAULT_ALERT_THRESHOLDS, null, {
      backlog: null,
      graceMinutes: 10,
      storeError: true,
    });
    const rb = rule(report, 'restock_repair_backlog');
    expect(rb).toMatchObject({ firing: false, observed: null });
    expect(rb.detail).toMatch(/UNREADABLE/);
    expect(rb.detail).not.toMatch(/0 past-grace/);
    expect(report.status).toBe('ok');
  });

  it('default ceiling 0: zero orphans quiet, ONE past-grace orphan fires with numbers', () => {
    const quiet = evaluateAlerts(snap(), DEFAULT_ALERT_THRESHOLDS, null, { backlog: 0, graceMinutes: 10 });
    expect(rule(quiet, 'restock_repair_backlog')).toMatchObject({ firing: false, observed: 0 });
    expect(quiet.status).toBe('ok');

    const over = evaluateAlerts(snap(), DEFAULT_ALERT_THRESHOLDS, null, { backlog: 1, graceMinutes: 10 });
    const rb = rule(over, 'restock_repair_backlog');
    expect(rb).toMatchObject({ firing: true, severity: 'warning', observed: 1, threshold: 0 });
    expect(rb.detail).toMatch(/1 cancelled order\(s\) past the 10min repair grace/);
    expect(over.status).toBe('alerting');
    expect(over.firingRules).toEqual(['restock_repair_backlog']);
  });

  it('fires STRICTLY above the ceiling: backlog AT the ceiling stays quiet', () => {
    const at = evaluateAlerts(
      snap(),
      { ...DEFAULT_ALERT_THRESHOLDS, restockBacklogMax: 2 },
      null,
      { backlog: 2, graceMinutes: 10 },
    );
    expect(rule(at, 'restock_repair_backlog')).toMatchObject({ firing: false, observed: 2, threshold: 2 });
    const over = evaluateAlerts(
      snap(),
      { ...DEFAULT_ALERT_THRESHOLDS, restockBacklogMax: 2 },
      null,
      { backlog: 3, graceMinutes: 10 },
    );
    expect(rule(over, 'restock_repair_backlog')).toMatchObject({ firing: true, observed: 3 });
    expect(over.firingRules).toEqual(['restock_repair_backlog']);
  });

  it('a backlog LARGER than the repair batch still alerts (whole-table count, no cap)', () => {
    const report = evaluateAlerts(snap(), DEFAULT_ALERT_THRESHOLDS, null, {
      backlog: 501,
      graceMinutes: 10,
    });
    expect(rule(report, 'restock_repair_backlog')).toMatchObject({ firing: true, observed: 501 });
  });

  it('ALERT_RESTOCK_BACKLOG_MAX parsing: integers pass, garbage/negative/blank fall back to 0, 0 legal', () => {
    expect(resolveAlertThresholds({ ALERT_RESTOCK_BACKLOG_MAX: '3' }).restockBacklogMax).toBe(3);
    expect(resolveAlertThresholds({ ALERT_RESTOCK_BACKLOG_MAX: '2.9' }).restockBacklogMax).toBe(2);
    expect(resolveAlertThresholds({ ALERT_RESTOCK_BACKLOG_MAX: '0' }).restockBacklogMax).toBe(0);
    expect(resolveAlertThresholds({ ALERT_RESTOCK_BACKLOG_MAX: 'half' }).restockBacklogMax).toBe(0);
    expect(resolveAlertThresholds({ ALERT_RESTOCK_BACKLOG_MAX: '-1' }).restockBacklogMax).toBe(0);
    expect(resolveAlertThresholds({ ALERT_RESTOCK_BACKLOG_MAX: '' }).restockBacklogMax).toBe(0);
    expect(resolveAlertThresholds({}).restockBacklogMax).toBe(0);
  });

  it('summarizeAlerts carries the backlog rule into the compact verdict shape', () => {
    const report = evaluateAlerts(snap(), DEFAULT_ALERT_THRESHOLDS, null, {
      backlog: 4,
      graceMinutes: 10,
    });
    expect(summarizeAlerts(report)).toEqual({ status: 'alerting', firing: ['restock_repair_backlog'] });
  });
});

describe('evaluateAlerts — email_delivery_failure (session 134)', () => {
  // Snapshots are built through the REAL registry so the mail tallies ride
  // the same shape /admin/metrics and the fold line emit.
  const mailSnap = (fill: (reg: RequestMetricsRegistry) => void) =>
    registrySnapshot((reg) => {
      // Keep the request-derived rules cold: one 200 sample never touches
      // the budget/p95 rules and stays under every requests floor.
      reg.record('GET /api/x', 200, 1);
      fill(reg);
    });

  it('rule is present SEVENTH with error severity and the default knobs', () => {
    const report = evaluateAlerts(mailSnap(() => undefined));
    expect(report.rules).toHaveLength(8); // session 139 added the EIGHTH rule
    expect(report.rules[6].id).toBe('email_delivery_failure');
    expect(report.rules[6]).toMatchObject({ firing: false, severity: 'error', threshold: 50 });
  });

  it('zero attempts: not evaluable (a disabled/never-used channel must not look healthy OR broken)', () => {
    const report = evaluateAlerts(mailSnap(() => undefined));
    const md = rule(report, 'email_delivery_failure');
    expect(md).toMatchObject({ firing: false, observed: null });
    expect(md.detail).toMatch(/no email sends attempted/);
  });

  it('hand-built snapshot WITHOUT totals.mail (pre-134 shape): honest not-evaluated, never a false fire', () => {
    const snap = registrySnapshot(() => undefined);
    const legacy = { ...snap, totals: { ...snap.totals } } as ReturnType<RequestMetricsRegistry['snapshot']>;
    delete (legacy.totals as { mail?: unknown }).mail;
    const report = evaluateAlerts(legacy);
    const md = rule(report, 'email_delivery_failure');
    expect(md).toMatchObject({ firing: false, observed: null });
    expect(md.detail).toMatch(/not evaluated/);
  });

  it('BELOW the attempts floor: verdict withheld even at a 100% failure share', () => {
    const report = evaluateAlerts(
      mailSnap((reg) => {
        reg.recordMail('confirmation', false);
        reg.recordMail('confirmation', false);
      }),
    );
    const md = rule(report, 'email_delivery_failure');
    expect(md).toMatchObject({ firing: false, observed: null, threshold: 50 });
    expect(md.detail).toMatch(/over only 2 sends.*not evaluated/);
  });

  it('at/under the ceiling stays quiet: 3 of 6 failed = 50% is NOT strictly above 50%', () => {
    const report = evaluateAlerts(
      mailSnap((reg) => {
        reg.recordMail('status', false);
        reg.recordMail('status', false);
        reg.recordMail('status', true);
        reg.recordMail('confirmation', false);
        reg.recordMail('confirmation', true);
        reg.recordMail('general', true);
      }),
    );
    expect(rule(report, 'email_delivery_failure')).toMatchObject({ firing: false, observed: 50 });
    expect(report.firingRules).not.toContain('email_delivery_failure');
  });

  it('STRICTLY above the ceiling fires with numbers and flips the verdict ALONE', () => {
    const report = evaluateAlerts(
      mailSnap((reg) => {
        reg.recordMail('confirmation', false);
        reg.recordMail('confirmation', false);
        reg.recordMail('confirmation', false);
        reg.recordMail('status', true);
        reg.recordMail('status', true);
      }),
    );
    const md = rule(report, 'email_delivery_failure');
    expect(md).toMatchObject({ firing: true, observed: 60, severity: 'error' });
    expect(md.detail).toMatch(/3 of 5 email sends failed \(60%\)/);
    expect(report.status).toBe('alerting');
    expect(report.firingRules).toEqual(['email_delivery_failure']);
    expect(summarizeAlerts(report)).toEqual({ status: 'alerting', firing: ['email_delivery_failure'] });
  });

  it('failures SUM across channels (dead relay fails every channel, not just one)', () => {
    const report = evaluateAlerts(
      mailSnap((reg) => {
        reg.recordMail('confirmation', false);
        reg.recordMail('status', false);
        reg.recordMail('general', false);
        reg.recordMail('confirmation', true);
        reg.recordMail('status', true);
      }),
    );
    expect(rule(report, 'email_delivery_failure')).toMatchObject({ firing: true, observed: 60 });
  });

  it('tightened knobs drive the rule: min-attempts 5 + ceiling 0 makes a single failure among five fire', () => {
    const reg = new RequestMetricsRegistry();
    reg.record('GET /api/x', 200, 1);
    reg.recordMail('status', true);
    reg.recordMail('status', true);
    reg.recordMail('status', true);
    reg.recordMail('status', true);
    reg.recordMail('status', false);
    const report = evaluateAlerts(
      reg.snapshot(),
      { ...DEFAULT_ALERT_THRESHOLDS, emailMinAttempts: 5, emailFailurePctMax: 0 },
    );
    expect(rule(report, 'email_delivery_failure')).toMatchObject({ firing: true, observed: 20, threshold: 0 });
  });

  it('ALERT_EMAIL_* parsing: valid values pass, garbage/negative/blank fall back; pct 0 is LEGAL, floor 0 is not', () => {
    expect(resolveAlertThresholds({ ALERT_EMAIL_MIN_ATTEMPTS: '3' }).emailMinAttempts).toBe(3);
    expect(resolveAlertThresholds({ ALERT_EMAIL_MIN_ATTEMPTS: '2.9' }).emailMinAttempts).toBe(2);
    expect(resolveAlertThresholds({ ALERT_EMAIL_MIN_ATTEMPTS: '0' }).emailMinAttempts).toBe(5);
    expect(resolveAlertThresholds({ ALERT_EMAIL_MIN_ATTEMPTS: '-2' }).emailMinAttempts).toBe(5);
    expect(resolveAlertThresholds({ ALERT_EMAIL_MIN_ATTEMPTS: 'soon' }).emailMinAttempts).toBe(5);
    expect(resolveAlertThresholds({ ALERT_EMAIL_MIN_ATTEMPTS: '' }).emailMinAttempts).toBe(5);
    expect(resolveAlertThresholds({ ALERT_EMAIL_FAILURE_PCT_MAX: '10' }).emailFailurePctMax).toBe(10);
    expect(resolveAlertThresholds({ ALERT_EMAIL_FAILURE_PCT_MAX: '0' }).emailFailurePctMax).toBe(0);
    expect(resolveAlertThresholds({ ALERT_EMAIL_FAILURE_PCT_MAX: '-1' }).emailFailurePctMax).toBe(50);
    expect(resolveAlertThresholds({ ALERT_EMAIL_FAILURE_PCT_MAX: 'half' }).emailFailurePctMax).toBe(50);
    expect(resolveAlertThresholds({}).emailFailurePctMax).toBe(50);
  });
});

describe('evaluateAlerts — cache_saturation (session 139)', () => {
  // Snapshots ride the REAL registry so totals.cache is the exact shape
  // /admin/metrics and the fold line emit (session-138 wiring).
  const cacheSnap = (fill: (reg: RequestMetricsRegistry) => void) =>
    registrySnapshot((reg) => {
      // Keep the request-derived rules cold: one 200 sample never touches
      // the budget/p95 rules and stays under every requests floor.
      reg.record('GET /api/x', 200, 1);
      fill(reg);
    });

  const evict = (n: number) => (reg: RequestMetricsRegistry) => {
    for (let i = 0; i < n; i++) reg.recordCache('evictions');
  };

  it('rule is present EIGHTH with default ceiling = store capacity and warning severity', () => {
    const report = evaluateAlerts(cacheSnap(() => undefined));
    expect(report.rules).toHaveLength(8);
    expect(report.rules[7].id).toBe('cache_saturation');
    expect(report.rules[7]).toMatchObject({
      firing: false,
      severity: 'warning',
      threshold: MAX_HTTP_CACHE_ENTRIES,
    });
  });

  it('zero evictions: quiet with honest numbers (a store that fits is NOT saturation)', () => {
    const report = evaluateAlerts(
      cacheSnap((reg) => {
        reg.recordCache('hits');
        reg.recordCache('stores');
        reg.recordCache('revalidations');
      }),
    );
    const cs = rule(report, 'cache_saturation');
    expect(cs).toMatchObject({ firing: false, observed: 0 });
    expect(cs.detail).toMatch(/0 cache-store evictions within the 500 ceiling/);
  });

  it('ONLY evictions move the number: a store full of hits never fires', () => {
    const report = evaluateAlerts(cacheSnap((reg) => {
      for (let i = 0; i < 600; i++) reg.recordCache('hits');
      for (let i = 0; i < 600; i++) reg.recordCache('stores');
    }));
    expect(rule(report, 'cache_saturation')).toMatchObject({ firing: false, observed: 0 });
  });

  it('fires STRICTLY above the ceiling: evictions AT the ceiling stay quiet', () => {
    const at = evaluateAlerts(cacheSnap(evict(3)), { ...DEFAULT_ALERT_THRESHOLDS, cacheEvictionsMax: 3 });
    expect(rule(at, 'cache_saturation')).toMatchObject({ firing: false, observed: 3, threshold: 3 });
    const over = evaluateAlerts(cacheSnap(evict(4)), {
      ...DEFAULT_ALERT_THRESHOLDS,
      cacheEvictionsMax: 3,
    });
    const cs = rule(over, 'cache_saturation');
    expect(cs).toMatchObject({ firing: true, observed: 4, severity: 'warning' });
    expect(cs.detail).toMatch(/4 cache-store evictions exceed the 3 ceiling \(store cap 500\)/);
    expect(over.status).toBe('alerting');
    expect(over.firingRules).toEqual(['cache_saturation']);
  });

  it('tightened 0 ceiling: the FIRST eviction fires ALONE (proving the chain)', () => {
    const report = evaluateAlerts(cacheSnap(evict(1)), {
      ...DEFAULT_ALERT_THRESHOLDS,
      cacheEvictionsMax: 0,
    });
    expect(rule(report, 'cache_saturation')).toMatchObject({ firing: true, observed: 1, threshold: 0 });
    expect(summarizeAlerts(report)).toEqual({ status: 'alerting', firing: ['cache_saturation'] });
  });

  it('a default-ceiling store pinned at 1000 distinct URLs overflows FULL capacity and fires', () => {
    // 500 fill with zero evictions; the next 501 spill as pure overflow.
    const report = evaluateAlerts(cacheSnap(evict(501)));
    expect(rule(report, 'cache_saturation')).toMatchObject({ firing: true, observed: 501 });
  });

  it('hand-built snapshot WITHOUT totals.cache (pre-138 shape): honest not-evaluated, never a false fire', () => {
    const snap = registrySnapshot(() => undefined);
    const legacy = { ...snap, totals: { ...snap.totals } } as ReturnType<RequestMetricsRegistry['snapshot']>;
    delete (legacy.totals as { cache?: unknown }).cache;
    const report = evaluateAlerts(legacy);
    const cs = rule(report, 'cache_saturation');
    expect(cs).toMatchObject({ firing: false, observed: null });
    expect(cs.detail).toMatch(/no cache tallies in this snapshot — rule not evaluated/);
  });

  it('ALERT_CACHE_EVICTIONS_MAX parsing: integers pass, 2.9 floors, garbage/negative/blank fall back to the store cap, 0 is LEGAL', () => {
    expect(resolveAlertThresholds({ ALERT_CACHE_EVICTIONS_MAX: '7' }).cacheEvictionsMax).toBe(7);
    expect(resolveAlertThresholds({ ALERT_CACHE_EVICTIONS_MAX: '2.9' }).cacheEvictionsMax).toBe(2);
    expect(resolveAlertThresholds({ ALERT_CACHE_EVICTIONS_MAX: '0' }).cacheEvictionsMax).toBe(0);
    expect(resolveAlertThresholds({ ALERT_CACHE_EVICTIONS_MAX: 'half' }).cacheEvictionsMax).toBe(
      MAX_HTTP_CACHE_ENTRIES,
    );
    expect(resolveAlertThresholds({ ALERT_CACHE_EVICTIONS_MAX: '-1' }).cacheEvictionsMax).toBe(
      MAX_HTTP_CACHE_ENTRIES,
    );
    expect(resolveAlertThresholds({ ALERT_CACHE_EVICTIONS_MAX: '' }).cacheEvictionsMax).toBe(
      MAX_HTTP_CACHE_ENTRIES,
    );
    expect(resolveAlertThresholds({}).cacheEvictionsMax).toBe(MAX_HTTP_CACHE_ENTRIES);
  });
});

describe('evaluateAlerts — combinations', () => {
  it('multiple simultaneous breaches list every firing rule in rule order', () => {
    const reg = new RequestMetricsRegistry(3);
    for (const p of ['/a', '/b', '/c', '/d']) reg.record(`GET ${p}`, 500, 3000);
    // min sample 1: this is a tiny synthetic registry, the budget rule is
    // otherwise (correctly) gated for n=4.
    const report = evaluateAlerts(reg.snapshot(), { fiveXxRatePctMax: 0.5, p95MsMax: 1000, minRequests: 1, rateLimitPctMax: 5, snapshotStaleAfterSec: null, restockBacklogMax: 0, emailMinAttempts: 5, emailFailurePctMax: 50, cacheEvictionsMax: 500 });
    expect(report.status).toBe('alerting');
    expect(report.firingRules).toEqual(['error_budget', 'p95_latency', 'route_key_overflow']);
    expect(report.rules).toHaveLength(8);
    expect(summarizeAlerts(report)).toEqual({
      status: 'alerting',
      firing: ['error_budget', 'p95_latency', 'route_key_overflow'],
    });
  });

  it('all EIGHT rules can fire and the list stays in rule order', () => {
    const reg = new RequestMetricsRegistry(3);
    for (const p of ['/a', '/b', '/c', '/d']) reg.record(`GET ${p}`, 500, 3000);
    // One guard-marked 429 (folds into `other` past the cap — the throttle
    // tally rides the fold) lifts the 429 share to 20% > 5%.
    reg.record('GET /throttled', 429, 10, null, true);
    // One FAILED email send past a tightened attempts floor (1) lights the
    // session-134 mail rule too.
    reg.recordMail('status', false);
    // One eviction past a tightened cache ceiling (0) lights the
    // session-139 cache-saturation rule.
    reg.recordCache('evictions');
    const report = evaluateAlerts(
      { ...reg.snapshot(), uptimeSec: 999999 },
      { fiveXxRatePctMax: 0.5, p95MsMax: 1000, minRequests: 1, rateLimitPctMax: 5, snapshotStaleAfterSec: null, restockBacklogMax: 0, emailMinAttempts: 1, emailFailurePctMax: 0, cacheEvictionsMax: 0 },
      { enabled: true, intervalSec: 300, lastCapturedAtMs: null },
      { backlog: 1, graceMinutes: 10 },
    );
    expect(report.firingRules).toEqual([
      'error_budget',
      'p95_latency',
      'route_key_overflow',
      'snapshot_stale',
      'rate_limit_pressure',
      'restock_repair_backlog',
      'email_delivery_failure',
      'cache_saturation',
    ]);
  });

  it('report echoes snapshot identity + resolved thresholds for auditors', () => {
    const snap = registrySnapshot(many('GET /api/x', 60, 200, 5));
    const report = evaluateAlerts(snap, DEFAULT_ALERT_THRESHOLDS);
    expect(report.generatedAt).toBe(snap.generatedAt);
    expect(report.uptimeSec).toBe(snap.uptimeSec);
    expect(report.thresholds).toEqual(DEFAULT_ALERT_THRESHOLDS);
    expect(summarizeAlerts(report)).toEqual({ status: 'ok', firing: [] });
  });
});
