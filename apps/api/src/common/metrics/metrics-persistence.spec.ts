import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { MetricsSnapshot, RequestMetricsRegistry } from './request-metrics';
import { RequestMetricsService } from './request-metrics.service';
import {
  DEFAULT_METRICS_SNAPSHOT_INTERVAL_SEC,
  DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC,
  MetricsPersistenceService,
  resolveSnapshotIntervalSec,
  resolveSnapshotRetentionSec,
} from './metrics-persistence.service';
import { MetricsSnapshotRow } from './metrics-snapshot.entity';
import { computeWindowDelta } from './metrics-window';

const BOOT = Date.parse('2026-11-12T02:00:00.000Z');
const T0 = new Date('2026-11-12T03:50:00.000Z');
const T1 = new Date('2026-11-12T04:00:00.000Z');

// Real registry output — the persisted payloads and the live snapshot are
// internally consistent cumulative pairs, exactly what production writes.
function registryPair(): { previous: MetricsSnapshot; live: MetricsSnapshot } {
  const reg = new RequestMetricsRegistry();
  reg.record('GET /a', 200, 10);
  reg.record('GET /a', 200, 20);
  const previous = reg.snapshot(T0);
  return { previous, live: reg.snapshot(T1) };
}

function makeFakes(env: Record<string, string> = {}) {
  const { previous, live } = registryPair();
  const repo = {
    create: jest.fn((partial: Partial<MetricsSnapshotRow>) => ({ id: 'gen', ...partial })),
    save: jest.fn(async (row: MetricsSnapshotRow) => row),
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, jest.Mock> = {};
      qb.delete = jest.fn(() => qb);
      qb.where = jest.fn((_clause: string, _params: { cutoff: Date }) => qb);
      qb.execute = jest.fn(async () => ({ affected: 0 }));
      return qb;
    }),
    // REAL repo API (TypeORM refuses order-only findOne — live smoke, session 89): find+take:1.
    find: jest.fn(async () => [] as MetricsSnapshotRow[]),
    count: jest.fn(async () => 0),
  };
  const metrics = {
    registry: { bootStartedAtMs: BOOT },
    snapshot: jest.fn(() => live),
  } as unknown as RequestMetricsService;
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const svc = new MetricsPersistenceService(
    config,
    metrics,
    repo as unknown as Repository<MetricsSnapshotRow>,
  );
  return { svc, repo, metrics, previous, live };
}

describe('metrics snapshot env resolution', () => {
  it('METRICS_SNAPSHOT_INTERVAL_SEC: unset/empty/garbage/negative fall back to 300; 0 disables; fractions floor', () => {
    expect(resolveSnapshotIntervalSec(undefined)).toBe(DEFAULT_METRICS_SNAPSHOT_INTERVAL_SEC);
    expect(resolveSnapshotIntervalSec('')).toBe(DEFAULT_METRICS_SNAPSHOT_INTERVAL_SEC);
    expect(resolveSnapshotIntervalSec('   ')).toBe(DEFAULT_METRICS_SNAPSHOT_INTERVAL_SEC);
    expect(resolveSnapshotIntervalSec('abc')).toBe(DEFAULT_METRICS_SNAPSHOT_INTERVAL_SEC);
    expect(resolveSnapshotIntervalSec('-2')).toBe(DEFAULT_METRICS_SNAPSHOT_INTERVAL_SEC);
    expect(resolveSnapshotIntervalSec('0')).toBe(0);
    expect(resolveSnapshotIntervalSec('12.9')).toBe(12);
  });

  it('METRICS_SNAPSHOT_RETENTION_SEC: defaults to 24h; 0 is GARBAGE (zero retention would prune its own writes)', () => {
    expect(resolveSnapshotRetentionSec(undefined)).toBe(DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC);
    expect(resolveSnapshotRetentionSec('garbage')).toBe(DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC);
    expect(resolveSnapshotRetentionSec('-1')).toBe(DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC);
    expect(resolveSnapshotRetentionSec('0')).toBe(DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC);
    expect(resolveSnapshotRetentionSec('120')).toBe(120);
    expect(resolveSnapshotRetentionSec('1.5')).toBe(1);
  });
});

describe('MetricsPersistenceService.persistNow', () => {
  it('writes the full snapshot stamped with capturedAt + the LIVE boot, then prunes past retention', async () => {
    const { svc, repo, live } = makeFakes();
    const before = Date.now();
    await expect(svc.persistNow()).resolves.toBe('written');

    const created = repo.create.mock.calls[0][0];
    expect(created.payload).toBe(live);
    expect(new Date(created.bootStartedAt).getTime()).toBe(BOOT);
    const captured = new Date(created.capturedAt).getTime();
    expect(captured).toBeGreaterThanOrEqual(before - 1);
    expect(captured).toBeLessThanOrEqual(Date.now() + 1000);

    const qb = repo.createQueryBuilder.mock.results[0].value;
    expect(qb.delete).toHaveBeenCalledTimes(1);
    // The clause must reference the RAW quoted column, not an alias —
    // DeleteQueryBuilder on this TypeORM drops the alias from FROM, so an
    // aliased predicate is a live 42P01 (session 89 smoke + direct probe).
    expect(qb.where.mock.calls[0][0]).toBe('"capturedAt" < :cutoff');
    const whereParams = qb.where.mock.calls[0][1] as { cutoff: Date };
    const expected = captured - DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC * 1000;
    expect(Math.abs(whereParams.cutoff.getTime() - expected)).toBeLessThan(1500);
    expect(qb.execute).toHaveBeenCalledTimes(1);
  });

  it('a database failure is a caught warn, not a crash: never throws out of the heartbeat', async () => {
    const { svc, repo } = makeFakes();
    repo.save.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(svc.persistNow()).resolves.toBe('failed');
    expect(repo.createQueryBuilder).not.toHaveBeenCalled(); // prune skipped, row NOT assumed written
  });

  it('disabled (interval 0): persistNow touches nothing', async () => {
    const { svc, repo } = makeFakes({ METRICS_SNAPSHOT_INTERVAL_SEC: '0' });
    await expect(svc.persistNow()).resolves.toBe('disabled');
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(svc.enabled).toBe(false);
  });

  it('the scheduler timer exists only while enabled and is cleared on module destroy', () => {
    const on = makeFakes();
    expect((on.svc as unknown as { timer: unknown }).timer).not.toBeNull();
    on.svc.onModuleDestroy();
    expect((on.svc as unknown as { timer: unknown }).timer).toBeNull();

    const off = makeFakes({ METRICS_SNAPSHOT_INTERVAL_SEC: '0' });
    expect((off.svc as unknown as { timer: unknown }).timer).toBeNull();
  });
});

describe('MetricsPersistenceService.describe (the additive /admin/metrics fields)', () => {
  it('disabled: reports enabled=false and touches NO database', async () => {
    const { svc, repo, live } = makeFakes({ METRICS_SNAPSHOT_INTERVAL_SEC: '0' });
    const { durability, window } = await svc.describe(live);
    expect(durability).toEqual({
      enabled: false,
      snapshotIntervalSec: 0,
      retentionSec: DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC,
      bootStartedAt: new Date(BOOT).toISOString(),
      stored: null,
      lastCapturedAt: null,
      bootAligned: null,
      error: false,
    });
    expect(window).toBeNull();
    expect(repo.find).not.toHaveBeenCalled();
    expect(repo.count).not.toHaveBeenCalled();
  });

  it('aligned same-boot row -> window equals the exact delta arithmetic', async () => {
    const { svc, repo, previous, live } = makeFakes();
    repo.find.mockImplementation(async () => [{
      id: 'row-1',
      capturedAt: new Date(T0.getTime() + 5000),
      bootStartedAt: new Date(BOOT),
      payload: previous,
    }]);
    repo.count.mockResolvedValue(7 as never);

    const { durability, window } = await svc.describe(live);
    expect(durability).toEqual({
      enabled: true,
      snapshotIntervalSec: DEFAULT_METRICS_SNAPSHOT_INTERVAL_SEC,
      retentionSec: DEFAULT_METRICS_SNAPSHOT_RETENTION_SEC,
      bootStartedAt: new Date(BOOT).toISOString(),
      stored: 7,
      lastCapturedAt: new Date(T0.getTime() + 5000).toISOString(),
      bootAligned: true,
      error: false,
    });
    expect(window).toEqual(computeWindowDelta(previous, live));
    expect(window!.requests).toBe(0); // baseline IS the live state (no new traffic)
  });

  it('the window grows EXACTLY with the traffic arriving after the newest stored row', async () => {
    const { svc, repo, metrics } = makeFakes();
    const reg = new RequestMetricsRegistry();
    reg.record('GET /a', 200, 10);
    reg.record('GET /a', 200, 20);
    const base = reg.snapshot(T0);
    for (let i = 0; i < 3; i++) reg.record('GET /b', 500, 90);
    const cur = reg.snapshot(T1);
    (metrics.snapshot as jest.Mock).mockReturnValue(cur);
    repo.find.mockImplementation(async () => [{
      id: 'row-1',
      capturedAt: T0,
      bootStartedAt: new Date(BOOT),
      payload: base,
    }]);
    repo.count.mockResolvedValue(1 as never);

    const { window } = await svc.describe(cur);
    expect(window).not.toBeNull();
    expect(window!.requests).toBe(3);
    expect(window!.byStatus['5xx']).toBe(3);
    expect(window!.fiveXxRatePct).toBe(100);
    expect(window!.avgMs).toBe(90);
    // Three 90ms samples land in the leMs=100 bucket — nearest-bound estimates.
    expect(window!.p50Ms).toBe(100);
    expect(window!.p95Ms).toBe(100);
    expect(window!.fromCapturedAt).toBe(base.generatedAt);
    expect(window!.routes).toEqual([
      { route: 'GET /b', requests: 3, byStatus: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 3 }, avgMs: 90 },
    ]);
  });

  it('a previous-BOOT row (fresh restart) -> bootAligned=false, window=null, NO cross-boot subtraction', async () => {
    const { svc, repo, live } = makeFakes();
    repo.find.mockImplementation(async () => [{
      id: 'row-old',
      capturedAt: T1,
      bootStartedAt: new Date(BOOT - 86_400_000), // yesterday's process
      payload: live, // even a "perfect" payload must never be trusted cross-boot
    }]);
    repo.count.mockResolvedValue(40 as never);

    const { durability, window } = await svc.describe(live);
    expect(durability.bootAligned).toBe(false);
    expect(durability.stored).toBe(40); // durability survives the restart — the whole point
    expect(window).toBeNull();
  });

  it('operator-corrupted payload jsonb: aligned boot but the shape guard yields window=null', async () => {
    const { svc, repo, live } = makeFakes();
    repo.find.mockImplementation(async () => [{
      id: 'row-junk',
      capturedAt: T0,
      bootStartedAt: new Date(BOOT),
      payload: { totals: 'nonsense' } as unknown as MetricsSnapshot,
    }]);
    const { durability, window } = await svc.describe(live);
    expect(durability.bootAligned).toBe(true);
    expect(window).toBeNull();
    expect(durability.error).toBe(false);
  });

  it('store errors degrade the extras, NEVER the route: error=true, window=null, no throw', async () => {
    const { svc, repo, live } = makeFakes();
    repo.find.mockRejectedValueOnce(new Error('db down'));
    const { durability, window } = await svc.describe(live);
    expect(durability.error).toBe(true);
    expect(durability.stored).toBeNull();
    expect(durability.lastCapturedAt).toBeNull();
    expect(durability.bootAligned).toBeNull();
    expect(window).toBeNull();
  });

  it('empty table: bootAligned=null, stored=0, window=null', async () => {
    const { svc, repo, live } = makeFakes();
    const { durability, window } = await svc.describe(live);
    expect(durability.stored).toBe(0);
    expect(durability.bootAligned).toBeNull();
    expect(durability.lastCapturedAt).toBeNull();
    expect(window).toBeNull();
  });

  it('decorate merges the live snapshot with the extras', async () => {
    const { svc, repo, live } = makeFakes();
    repo.find.mockRejectedValueOnce(new Error('db down'));
    const out = await svc.decorate(live);
    expect(out.generatedAt).toBe(live.generatedAt);
    expect(out.totals).toBe(live.totals);
    expect(out.durability.error).toBe(true);
    expect(out.window).toBeNull();
  });
});
