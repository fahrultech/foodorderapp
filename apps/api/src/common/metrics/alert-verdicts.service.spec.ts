import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AlertVerdictRow } from './alert-verdict.entity';
import {
  AlertHistoryView,
  AlertVerdictsService,
  DEFAULT_ALERT_HISTORY_LIMIT,
  DEFAULT_ALERT_HISTORY_WINDOW_SEC,
  MAX_ALERT_HISTORY_LIMIT,
  MAX_ALERT_HISTORY_WINDOW_SEC,
  MIN_ALERT_HISTORY_WINDOW_SEC,
} from './alert-verdicts.service';
import { MetricsPersistenceService } from './metrics-persistence.service';
import { RequestMetricsService } from './request-metrics.service';
import { AlertReport, AlertRuleId } from '../../ops/alerts';

function report(status: 'ok' | 'alerting', firingRules: AlertRuleId[]): AlertReport {
  return {
    generatedAt: '2026-11-20T06:00:00.000Z',
    uptimeSec: 3600,
    status,
    firingRules,
    thresholds: {
      fiveXxRatePctMax: 0.5,
      p95MsMax: 1000,
      minRequests: 50,
      snapshotStaleAfterSec: null,
    },
    rules: [],
  };
}

function row(minuteAgo: number, status: 'ok' | 'alerting', firing: AlertRuleId[] = []) {
  return {
    id: `row-${minuteAgo}`,
    capturedAt: new Date(Date.parse('2026-11-20T06:00:00.000Z') - minuteAgo * 60_000),
    status,
    firingRules: firing,
    report: report(status, firing),
  } as unknown as AlertVerdictRow;
}

function makeFakes(
  env: Record<string, string> = {},
  opts: { liveStatus?: 'ok' | 'alerting'; liveFiring?: AlertRuleId[] } = {},
) {
  const liveReport = report(opts.liveStatus ?? 'ok', opts.liveFiring ?? []);
  const freshness = { enabled: true, intervalSec: 300, lastCapturedAtMs: Date.now() - 10_000 };
  const alerts = jest.fn(() => liveReport);
  const freshnessInput = jest.fn(async () => freshness);
  const repo = {
    create: jest.fn((partial: Partial<AlertVerdictRow>) => ({ id: 'gen', ...partial })),
    save: jest.fn(async (r: AlertVerdictRow) => r),
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, jest.Mock> = {};
      qb.delete = jest.fn(() => qb);
      qb.where = jest.fn((_clause: string, _params: { cutoff: Date }) => qb);
      qb.execute = jest.fn(async () => ({ affected: 0 }));
      return qb;
    }),
    // REAL repo API: find({ where, order, take }) — never order-only findOne
    // (session 89 TypeORM refusal, carried to every newest-row read).
    find: jest.fn(async (_q?: Record<string, unknown>) => [] as AlertVerdictRow[]),
  };
  const metrics = { alerts } as unknown as RequestMetricsService;
  const persistence = {
    freshnessInput,
    enabled: env.METRICS_SNAPSHOT_INTERVAL_SEC !== '0',
  } as unknown as MetricsPersistenceService;
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const svc = new AlertVerdictsService(config, metrics, persistence, repo as unknown as Repository<AlertVerdictRow>);
  return { svc, repo, alerts, freshnessInput, liveReport };
}

describe('AlertVerdictsService.persistNow', () => {
  it('disabled writer: no evaluation, no repo touch', async () => {
    const { svc, repo, alerts, freshnessInput } = makeFakes({ METRICS_SNAPSHOT_INTERVAL_SEC: '0' });
    await expect(svc.persistNow()).resolves.toBe('disabled');
    expect(alerts).not.toHaveBeenCalled();
    expect(freshnessInput).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('appends the verdict row with the LIVE engine output verbatim, then prunes past retention', async () => {
    const { svc, repo, liveReport, freshnessInput, alerts } = makeFakes(
      { METRICS_SNAPSHOT_RETENTION_SEC: '3600' },
      { liveStatus: 'alerting', liveFiring: ['p95_latency'] },
    );
    const before = Date.now();
    await expect(svc.persistNow()).resolves.toBe('written');

    // The DB-backed freshness observation is supplied, exactly like the
    // GET /admin/alerts route does (one engine, no second path).
    expect(freshnessInput).toHaveBeenCalled();
    expect(alerts).toHaveBeenCalledWith(await freshnessInput());

    const created = repo.create.mock.calls[0][0];
    expect(created.status).toBe('alerting');
    expect(created.firingRules).toEqual(['p95_latency']);
    expect(created.report).toBe(liveReport);
    const captured = new Date(created.capturedAt as unknown as Date).getTime();
    expect(captured).toBeGreaterThanOrEqual(before - 1);

    // Session-89 DELETE idiom, pinned for THIS table too: raw quoted column,
    // never the alias (DeleteQueryBuilder drops the alias from FROM but
    // keeps it in WHERE => Postgres 42P01, a silently dead prune).
    const qb = repo.createQueryBuilder.mock.results[0].value;
    expect(qb.delete).toHaveBeenCalled();
    const [clause, params] = qb.where.mock.calls[0];
    expect(clause).toBe('"capturedAt" < :cutoff');
    expect(qb.execute).toHaveBeenCalled();
    const cutoff = new Date(params.cutoff).getTime();
    expect(cutoff).toBe(captured - 3600 * 1000);
  });

  it('a store failure is caught + reported — never throws (dead smoke detector doctrine)', async () => {
    const { svc, repo } = makeFakes();
    repo.save.mockRejectedValueOnce(new Error('relation "alert_verdicts" does not exist'));
    await expect(svc.persistNow()).resolves.toBe('failed');
  });

  it('constructor with interval 0 creates no timer', () => {
    const { svc } = makeFakes({ METRICS_SNAPSHOT_INTERVAL_SEC: '0' });
    expect(svc.enabled).toBe(false);
    expect(() => svc.onModuleDestroy()).not.toThrow();
  });
});

describe('AlertVerdictsService.history', () => {
  it('clamps bounds: out-of-range/absent fall into the closed ranges', async () => {
    const { svc } = makeFakes();
    const view = await svc.history({ windowSec: 5, limit: 999_999 });
    expect(view.window.windowSec).toBe(MIN_ALERT_HISTORY_WINDOW_SEC);
    const view2 = await svc.history({});
    expect(view2.window.windowSec).toBe(DEFAULT_ALERT_HISTORY_WINDOW_SEC);
    const view3 = await svc.history({ windowSec: 1e9 });
    expect(view3.window.windowSec).toBe(MAX_ALERT_HISTORY_WINDOW_SEC);
    // The take: the CLAMPED limit reaches the repo, never the raw value.
    const { svc: svc4, repo: repo4 } = makeFakes();
    await svc4.history({ limit: 999_999 });
    expect((repo4.find.mock.calls[0][0] as Record<string, any>).take).toBe(MAX_ALERT_HISTORY_LIMIT);
    await svc4.history({ limit: -5 });
    expect((repo4.find.mock.calls[1][0] as Record<string, any>).take).toBe(1);
    await svc4.history({ windowSec: '   ' as unknown as number });
    expect((repo4.find.mock.calls[2][0] as Record<string, any>).take).toBe(DEFAULT_ALERT_HISTORY_LIMIT);
    expect(view2.returned).toBe(0);
  });

  it('window arithmetic: from = to - windowSec', async () => {
    const { svc } = makeFakes();
    const view = await svc.history({ windowSec: 600 });
    const from = Date.parse(view.window.from);
    const to = Date.parse(view.window.to);
    expect(to - from).toBe(600_000);
    expect(view.window.windowSec).toBe(600);
  });

  it('disabled writer: honest empty series, streak = the live verdict alone', async () => {
    const { svc, repo } = makeFakes(
      { METRICS_SNAPSHOT_INTERVAL_SEC: '0' },
      { liveStatus: 'alerting', liveFiring: ['error_budget'] },
    );
    const view = await svc.history({});
    expect(view.enabled).toBe(false);
    expect(repo.find).not.toHaveBeenCalled();
    expect(view.items).toEqual([]);
    expect(view.lastCapturedAt).toBeNull();
    expect(view.streak).toEqual({
      persistedTrailingAlerting: 0,
      trailingCapped: false,
      currentStatus: 'alerting',
      alerting: 1,
    });
  });

  it('trailing streak counts back from the newest row and STOPS at the first ok', async () => {
    // DESC input: alerting, alerting, ok, alerting (the old fire ended).
    const { svc, repo } = makeFakes({}, { liveStatus: 'alerting', liveFiring: ['error_budget'] });
    repo.find.mockResolvedValue([row(1, 'alerting', ['error_budget']), row(2, 'alerting'), row(3, 'ok'), row(4, 'alerting')]);
    const view = await svc.history({ limit: 4 });
    expect(view.streak.persistedTrailingAlerting).toBe(2);
    expect(view.streak.trailingCapped).toBe(false);
    // +1 for THIS read's live verdict: three consecutive alerting evaluations.
    expect(view.streak.alerting).toBe(3);
    expect(view.streak.currentStatus).toBe('alerting');
    expect(view.returned).toBe(4);
    // Oldest-first out: row(4) lands first.
    expect(view.items.map((i) => i.status)).toEqual(['alerting', 'ok', 'alerting', 'alerting']);
    expect(view.lastCapturedAt).toBe(row(1, 'alerting').capturedAt.toISOString());
  });

  it('an ok LIVE verdict resets the streak to 0 even over an alerting tail', async () => {
    const { svc, repo } = makeFakes({}, { liveStatus: 'ok' });
    repo.find.mockResolvedValue([row(1, 'alerting'), row(2, 'alerting')]);
    const view = await svc.history({ limit: 2 });
    expect(view.streak.persistedTrailingAlerting).toBe(2);
    expect(view.streak.alerting).toBe(0);
  });

  it('a fully alerting page reports the streak as a LOWER BOUND (trailingCapped)', async () => {
    const { svc, repo } = makeFakes({}, { liveStatus: 'alerting' });
    repo.find.mockResolvedValue([row(1, 'alerting'), row(2, 'alerting')]);
    const view = await svc.history({ limit: 2 });
    expect(view.truncated).toBe(true);
    expect(view.streak.trailingCapped).toBe(true);
    expect(view.streak.alerting).toBe(3);
  });

  it('a failed series read degrades the payload — never 5xx, live streak stays honest', async () => {
    const { svc, repo } = makeFakes({}, { liveStatus: 'alerting', liveFiring: ['snapshot_stale'] });
    repo.find.mockRejectedValue(new Error('permission denied'));
    const view: AlertHistoryView = await svc.history({});
    expect(view.error).toBe(true);
    expect(view.items).toEqual([]);
    expect(view.streak.persistedTrailingAlerting).toBe(0);
    expect(view.streak.alerting).toBe(1);
  });

  it('rows are embedded verbatim: full stored report with rules + detail strings', async () => {
    const { svc, repo } = makeFakes();
    const r = row(1, 'alerting', ['error_budget']);
    repo.find.mockResolvedValue([r]);
    const view = await svc.history({});
    expect(view.items[0].report).toBe(r.report);
    expect(view.items[0].firingRules).toEqual(['error_budget']);
  });
});
