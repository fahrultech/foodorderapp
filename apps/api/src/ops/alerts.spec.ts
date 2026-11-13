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
    });
    expect(t).toEqual({ fiveXxRatePctMax: 0, p95MsMax: 0, minRequests: 1 });
    expect(resolveAlertThresholds({ ALERT_5XX_RATE_PCT_MAX: '-0.1' }).fiveXxRatePctMax).toBe(0.5);
  });

  it('min sample is a positive integer (0/fractional collapses to default)', () => {
    expect(resolveAlertThresholds({ ALERT_MIN_REQUESTS: '0' }).minRequests).toBe(50);
    expect(resolveAlertThresholds({ ALERT_MIN_REQUESTS: '2.9' }).minRequests).toBe(2);
    expect(resolveAlertThresholds({ ALERT_MIN_REQUESTS: '1e3' }).minRequests).toBe(1000);
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
    const report = evaluateAlerts(snap, { fiveXxRatePctMax: 0, p95MsMax: 100000, minRequests: 1 });
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

describe('evaluateAlerts — combinations', () => {
  it('multiple simultaneous breaches list every firing rule in rule order', () => {
    const reg = new RequestMetricsRegistry(3);
    for (const p of ['/a', '/b', '/c', '/d']) reg.record(`GET ${p}`, 500, 3000);
    // min sample 1: this is a tiny synthetic registry, the budget rule is
    // otherwise (correctly) gated for n=4.
    const report = evaluateAlerts(reg.snapshot(), { fiveXxRatePctMax: 0.5, p95MsMax: 1000, minRequests: 1 });
    expect(report.status).toBe('alerting');
    expect(report.firingRules).toEqual(['error_budget', 'p95_latency', 'route_key_overflow']);
    expect(report.rules).toHaveLength(3);
    expect(summarizeAlerts(report)).toEqual({
      status: 'alerting',
      firing: ['error_budget', 'p95_latency', 'route_key_overflow'],
    });
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
