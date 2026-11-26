import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { RequestMetricsService } from '../common/metrics/request-metrics.service';
import { MetricsPersistenceService } from '../common/metrics/metrics-persistence.service';
import { MetricsSnapshotRow } from '../common/metrics/metrics-snapshot.entity';
import { AlertVerdictRow } from '../common/metrics/alert-verdict.entity';
import { AlertVerdictsService } from '../common/metrics/alert-verdicts.service';
import { RestockBacklogObserver } from '../common/metrics/restock-backlog.observer';
import { RequestMetricsRegistry } from '../common/metrics/request-metrics';
import { DEFAULT_ALERT_THRESHOLDS, evaluateAlerts } from '../ops/alerts';

const JWT_TEST = 'admin-controller-http-test-key';

// Registry boot anchor for the durability fixtures (session 89).
const BOOT_ISO = '2026-11-12T02:00:00.000Z';
const BOOT_MS = Date.parse(BOOT_ISO);

// Phase 14: the fake RestockBacklogObserver's canned observation — an
// EMPTY backlog (healthy repair chain). The route call pin below proves
// the observation actually reaches the evaluator.
const RESTOCK_BACKLOG_FIXTURE = { backlog: 0, graceMinutes: 10 };

describe('AdminController HTTP', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const overview = jest.fn();
  const snapshot = jest.fn();
  const alerts = jest.fn();
  // Fake snapshot STORE — the real MetricsPersistenceService runs over it,
  // so the route's durability/window fields are the PRODUCTION arithmetic.
  const repo = {
    create: jest.fn((p: Record<string, unknown>) => p),
    save: jest.fn(async (r: Record<string, unknown>) => r),
    createQueryBuilder: jest.fn(),
    find: jest.fn(async () => [] as unknown[]),
    count: jest.fn(async () => 0 as number),
  };
  // Fake `alert_verdicts` store (Phase 11): history()'s repo reads land here.
  const verdictRepo = {
    create: jest.fn((p: Record<string, unknown>) => p),
    save: jest.fn(async (r: Record<string, unknown>) => r),
    createQueryBuilder: jest.fn(),
    find: jest.fn(async (_q?: Record<string, unknown>) => [] as unknown[]),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: JWT_TEST })],
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: { overview } },
        {
          provide: RequestMetricsService,
          useValue: { snapshot, alerts, registry: { bootStartedAtMs: BOOT_MS } },
        },
        { provide: getRepositoryToken(MetricsSnapshotRow), useValue: repo },
        // Fake ALERT series store — the real AlertVerdictsService runs over
        // it, so history's window/streak arithmetic is PRODUCTION code
        // (same fake-store style as the metrics repo above).
        { provide: getRepositoryToken(AlertVerdictRow), useValue: verdictRepo },
        { provide: ConfigService, useValue: { get: () => undefined } }, // defaults: interval 300, retention 24h
        // Phase 14 fake: the route's backlog observation (empty backlog —
        // the call-shape pin below proves the route PASSES it through).
        { provide: RestockBacklogObserver, useValue: { input: async () => RESTOCK_BACKLOG_FIXTURE } },
        MetricsPersistenceService,
        AlertVerdictsService,
        JwtAuthGuard,
        RolesGuard,
        Reflector,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new ErrorFormatFilter());
    await app.listen(0);
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    overview.mockResolvedValue({ counts: {}, recentUsers: [], recentRestaurants: [], recentOrders: [] });
    alerts.mockReturnValue(ALERTS_FIXTURE);
    // Default store state: ONE same-boot baseline row (set up below the
    // metrics fixtures) — individual tests override as needed.
    repo.find.mockImplementation(async () => [BASE_ROW]);
    repo.count.mockResolvedValue(2);
    // Default: EMPTY verdict series (no persisted rows) — history tests
    // override per case.
    verdictRepo.find.mockResolvedValue([]);
  });

  const token = (role: UserRole) =>
    jwt.sign({ sub: '11111111-1111-4111-8111-111111111111', role, typ: TOKEN_TYPE_ACCESS });

  const get = (authorization?: string, path = '/api/admin/overview'): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const port = (app.getHttpServer().address() as AddressInfo).port;
      http
        .get(
          {
            port,
            path,
            headers: authorization ? { Authorization: authorization } : undefined,
          },
          (res) => {
            let raw = '';
            res.on('data', (chunk) => (raw += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }),
            );
          },
        )
        .on('error', reject);
    });

  it('rejects anonymous callers before the service', async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(overview).not.toHaveBeenCalled();
  });

  it('rejects non-admin callers before the service', async () => {
    const res = await get(`Bearer ${token(UserRole.OWNER)}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(overview).not.toHaveBeenCalled();
  });

  it('returns the overview to admins', async () => {
    const payload = {
      counts: { users: { total: 3 } },
      recentUsers: [],
      recentRestaurants: [],
      recentOrders: [],
    };
    overview.mockResolvedValue(payload);

    const res = await get(`Bearer ${token(UserRole.ADMIN)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(overview).toHaveBeenCalledTimes(1);
  });

  // --- GET /admin/metrics (request-metrics snapshot route) ---

  const METRICS_FIXTURE = {
    generatedAt: '2026-11-12T04:00:00.000Z',
    uptimeSec: 3600,
    boundsMs: [5, 10],
    totals: {
      requests: 3,
      byStatus: { '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 0 },
      throttled: 1,
      mail: {
        confirmation: { attempts: 2, failures: 1 },
        status: { attempts: 1, failures: 0 },
        general: { attempts: 0, failures: 0 },
      },
      // Session 138: additive cache dimension (ADMIN global view only —
      // PREV_FIXTURE deliberately lacks it to prove window math ignores
      // unknown tally keys on legacy stored rows). Session 140 adds the
      // fifth counter `eligible` (>= stores: every capture rode a handler pass).
      cache: { hits: 2, stores: 3, evictions: 0, revalidations: 1, eligible: 3 },
      routeKeys: 2,
      overflowed: false,
      restaurantKeys: 0,
      restaurantOverflowed: false,
      avgMs: 12.5,
      p50Ms: 10,
      p95Ms: 10,
      p99Ms: 10,
      maxMs: 20,
    },
    routes: [
      {
        route: 'GET /api/orders/:id',
        requests: 3,
        byStatus: { '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 0 },
        throttled: 1,
        sumMs: 38,
        avgMs: 12.5,
        minMs: 5,
        maxMs: 20,
        p50Ms: 10,
        p95Ms: 10,
        p99Ms: 10,
        histogram: [
          { leMs: 5, count: 1 },
          { leMs: 10, count: 2 },
          { leMs: null, count: 3 },
        ],
      },
    ],
  };

  it('rejects anonymous + non-admin callers of /admin/metrics before the registry', async () => {
    const anon = await get(undefined, '/api/admin/metrics');
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('UNAUTHORIZED');

    const customer = await get(`Bearer ${token(UserRole.CUSTOMER)}`, '/api/admin/metrics');
    expect(customer.status).toBe(403);
    expect(customer.body.error.code).toBe('FORBIDDEN');
    expect(snapshot).not.toHaveBeenCalled();
  });

  // Baseline snapshot row as the scheduler would have persisted it at
  // 03:50 — a strict SUBSET of METRICS_FIXTURE's cumulative tallies, so the
  // window arithmetic below is hand-pinnable to exact numbers.
  const PREV_FIXTURE = {
    generatedAt: '2026-11-12T03:50:00.000Z',
    uptimeSec: 3000,
    boundsMs: [5, 10],
    totals: {
      requests: 1,
      byStatus: { '2xx': 1, '3xx': 0, '4xx': 0, '5xx': 0 },
      throttled: 0,
      routeKeys: 1,
      overflowed: false,
      restaurantKeys: 0,
      restaurantOverflowed: false,
      avgMs: 8,
      p50Ms: 5,
      p95Ms: 5,
      p99Ms: 5,
      maxMs: 8,
    },
    routes: [
      {
        route: 'GET /api/orders/:id',
        requests: 1,
        byStatus: { '2xx': 1, '3xx': 0, '4xx': 0, '5xx': 0 },
        throttled: 0,
        sumMs: 8,
        avgMs: 8,
        minMs: 8,
        maxMs: 8,
        p50Ms: 5,
        p95Ms: 5,
        p99Ms: 5,
        histogram: [
          { leMs: 5, count: 1 },
          { leMs: 10, count: 1 },
          { leMs: null, count: 1 },
        ],
      },
    ],
  };
  const BASE_ROW = {
    id: 'row-baseline',
    capturedAt: new Date('2026-11-12T03:50:30.000Z'),
    bootStartedAt: new Date(BOOT_MS),
    payload: PREV_FIXTURE,
  };

  const EXPECTED_DURABILITY = {
    enabled: true,
    snapshotIntervalSec: 300,
    retentionSec: 86400,
    bootStartedAt: BOOT_ISO,
    stored: 2,
    lastCapturedAt: '2026-11-12T03:50:30.000Z',
    bootAligned: true,
    error: false,
  };
  // Hand-computed from the fixture pair: totals 3-1=2 requests, status
  // {2xx:2-1, 4xx:1-0}; histogram {5:1-1=0, 10:2-1=1, +Inf:3-1=2}; p50 rank
  // 1 -> leMs 10 is the first bucket >=1; p95/p99 rank 2 -> only +Inf
  // reaches it -> honest nulls; avg (38-8)/2 = 15; span 04:00-03:50 = 600s.
  const EXPECTED_WINDOW = {
    fromCapturedAt: '2026-11-12T03:50:00.000Z',
    toCapturedAt: '2026-11-12T04:00:00.000Z',
    spanSec: 600,
    requests: 2,
    byStatus: { '2xx': 1, '3xx': 0, '4xx': 1, '5xx': 0 },
    fiveXxRatePct: 0,
    avgMs: 15,
    p50Ms: 10,
    p95Ms: null,
    p99Ms: null,
    histogram: [
      { leMs: 5, count: 0 },
      { leMs: 10, count: 1 },
      { leMs: null, count: 2 },
    ],
    routes: [
      {
        route: 'GET /api/orders/:id',
        requests: 2,
        byStatus: { '2xx': 1, '3xx': 0, '4xx': 1, '5xx': 0 },
        avgMs: 15,
      },
    ],
  };

  it('returns the snapshot verbatim to admins', async () => {
    // The fixture mirrors MetricsSnapshot exactly — a field renamed on one
    // side without the swagger model/fixture fails this round-trip. The
    // durability + window extras are REAL production arithmetic over the
    // baseline row (hand-pinned EXPECTED_WINDOW below).
    snapshot.mockReturnValue(METRICS_FIXTURE);
    const res = await get(`Bearer ${token(UserRole.ADMIN)}`, '/api/admin/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...METRICS_FIXTURE,
      durability: EXPECTED_DURABILITY,
      window: EXPECTED_WINDOW,
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('nulls the window but keeps history when the newest row predates this boot (restart)', async () => {
    snapshot.mockReturnValue(METRICS_FIXTURE);
    repo.find.mockImplementation(async () => [
      {
        ...BASE_ROW,
        id: 'row-old-boot',
        bootStartedAt: new Date(BOOT_MS - 3_600_000), // a DIFFERENT process wrote it
      },
    ]);

    const res = await get(`Bearer ${token(UserRole.ADMIN)}`, '/api/admin/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...METRICS_FIXTURE,
      durability: { ...EXPECTED_DURABILITY, bootAligned: false },
      window: null,
    });
  });

  it('a broken snapshot store degrades the extras but never the route (dead smoke detector doctrine)', async () => {
    snapshot.mockReturnValue(METRICS_FIXTURE);
    repo.find.mockRejectedValueOnce(new Error('connection terminated'));

    const res = await get(`Bearer ${token(UserRole.ADMIN)}`, '/api/admin/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...METRICS_FIXTURE,
      durability: {
        ...EXPECTED_DURABILITY,
        stored: null,
        lastCapturedAt: null,
        bootAligned: null,
        error: true,
      },
      window: null,
    });
    // The LIVE snapshot is fully intact — observability survives its own store dying.
    expect(res.body.totals.requests).toBe(3);
  });

  // --- GET /admin/alerts (ops/alerts rule engine route, session 86) ---

  // Mirrors AlertReport from src/ops/alerts.ts EXACTLY — same round-trip
  // contract style as METRICS_FIXTURE above. Session 109 added the 4th
  // rule (snapshot_stale) and the thresholds.snapshotStaleAfterSec field;
  // the mirror pin below re-derives rule ids + threshold keys from the
  // REAL engine so the fixture cannot silently lag a rename.
  const ALERTS_FIXTURE = {
    generatedAt: '2026-11-13T06:00:00.000Z',
    uptimeSec: 3600,
    status: 'alerting',
    firingRules: ['error_budget'],
    thresholds: {
      fiveXxRatePctMax: 0.5,
      p95MsMax: 1000,
      minRequests: 50,
      rateLimitPctMax: 5,
      snapshotStaleAfterSec: null,
      restockBacklogMax: 0,
      emailMinAttempts: 5,
      emailFailurePctMax: 50,
      cacheEvictionsMax: 500,
    },
    rules: [
      {
        id: 'error_budget',
        firing: true,
        severity: 'error',
        observed: 1.25,
        threshold: 0.5,
        detail: '5xx rate 1.25% exceeds the 0.5% budget (10 of 800 requests)',
      },
      {
        id: 'p95_latency',
        firing: false,
        severity: 'error',
        observed: 25,
        threshold: 1000,
        detail: 'p95 estimate 25ms within the 1000ms ceiling',
      },
      {
        id: 'route_key_overflow',
        firing: false,
        severity: 'warning',
        observed: 12,
        threshold: 250,
        detail: '12 distinct route keys, cap 250',
      },
      {
        id: 'snapshot_stale',
        firing: false,
        severity: 'warning',
        observed: 30,
        threshold: 600,
        detail: 'newest snapshot row 30s old within the 600s ceiling (writer every 300s)',
      },
      {
        id: 'rate_limit_pressure',
        firing: false,
        severity: 'warning',
        observed: 0.8,
        threshold: 5,
        detail: '4 guard-throttled 429s (0.8%) within the 5% ceiling',
      },
      {
        id: 'restock_repair_backlog',
        firing: false,
        severity: 'warning',
        observed: 0,
        threshold: 0,
        detail: '0 past-grace orphans within the 0 ceiling (grace 10min)',
      },
      // Session 134 added the SEVENTH rule + the two email knobs above —
      // the mirror pin re-derives ids/severities/keys from the real engine.
      {
        id: 'email_delivery_failure',
        firing: false,
        severity: 'error',
        observed: null,
        threshold: 50,
        detail: 'no email sends attempted yet — rule not evaluable',
      },
      // Session 139 added the EIGHTH rule + the cache ceiling knob above.
      {
        id: 'cache_saturation',
        firing: false,
        severity: 'warning',
        observed: 0,
        threshold: 500,
        detail: '0 cache-store evictions within the 500 ceiling (store cap 500)',
      },
    ],
  };

  it('fixture mirrors the REAL engine: rule ids in order + thresholds keys', () => {
    const live = new RequestMetricsRegistry().snapshot();
    const real = evaluateAlerts(live, DEFAULT_ALERT_THRESHOLDS, {
      enabled: true,
      intervalSec: 300,
      lastCapturedAtMs: Date.now() - 30_000,
    });
    expect(ALERTS_FIXTURE.rules.map((r) => r.id)).toEqual(real.rules.map((r) => r.id));
    expect(Object.keys(ALERTS_FIXTURE.thresholds).sort()).toEqual(
      Object.keys(DEFAULT_ALERT_THRESHOLDS).sort(),
    );
    expect(real.rules.map((r) => r.severity)).toEqual(ALERTS_FIXTURE.rules.map((r) => r.severity));
  });

  it('rejects anonymous + non-admin callers of /admin/alerts before the evaluator', async () => {
    const anon = await get(undefined, '/api/admin/alerts');
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('UNAUTHORIZED');

    const customer = await get(`Bearer ${token(UserRole.CUSTOMER)}`, '/api/admin/alerts');
    expect(customer.status).toBe(403);
    expect(customer.body.error.code).toBe('FORBIDDEN');
    expect(alerts).not.toHaveBeenCalled();
  });

  it('returns the full alert report verbatim to admins', async () => {
    const res = await get(`Bearer ${token(UserRole.ADMIN)}`, '/api/admin/alerts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ALERTS_FIXTURE);
    expect(alerts).toHaveBeenCalledTimes(1);
    // Session 109 wiring: the route supplies the DB-backed freshness
    // observation (BASE_ROW via the real persistence service) — without
    // this pin the snapshot_stale rule could silently un-wire itself.
    expect(alerts).toHaveBeenCalledWith(
      {
        enabled: true,
        intervalSec: 300,
        lastCapturedAtMs: BASE_ROW.capturedAt.getTime(),
      },
      RESTOCK_BACKLOG_FIXTURE,
    );
  });

  // --- GET /admin/alerts/history (Phase 11 Ops: the persisted series) ---

  function verdictRow(minutesAgo: number, status: 'ok' | 'alerting') {
    return {
      id: `v-${minutesAgo}`,
      capturedAt: new Date(Date.now() - minutesAgo * 60_000),
      status,
      firingRules: status === 'alerting' ? ['error_budget'] : [],
      // Stored verbatim from the engine — the round-trip below proves the
      // route never reshapes history rows.
      report: { ...ALERTS_FIXTURE, status, firingRules: status === 'alerting' ? ['error_budget'] : [] },
    };
  }

  it('rejects anonymous + non-admin callers of /admin/alerts/history before the store', async () => {
    const anon = await get(undefined, '/api/admin/alerts/history');
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('UNAUTHORIZED');

    const customer = await get(`Bearer ${token(UserRole.CUSTOMER)}`, '/api/admin/alerts/history');
    expect(customer.status).toBe(403);
    expect(customer.body.error.code).toBe('FORBIDDEN');
    expect(verdictRepo.find).not.toHaveBeenCalled();
    expect(alerts).not.toHaveBeenCalled();
  });

  it('answers 400 for out-of-range / non-integer params — the store is never touched', async () => {
    const admin = `Bearer ${token(UserRole.ADMIN)}`;
    for (const q of ['windowSec=5', 'windowSec=abc', 'windowSec=99999999', 'limit=1.5', 'limit=99999']) {
      const res = await get(admin, `/api/admin/alerts/history?${q}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    }
    expect(verdictRepo.find).not.toHaveBeenCalled();
  });

  it('blank params mean the DEFAULTS (unset, not the minimum — the DTO Transform owns it)', async () => {
    const admin = `Bearer ${token(UserRole.ADMIN)}`;
    const res = await get(admin, '/api/admin/alerts/history?windowSec=&limit=');
    expect(res.status).toBe(200);
    expect(res.body.window.windowSec).toBe(86_400);
    const findArg = verdictRepo.find.mock.calls[0][0] as Record<string, any>;
    expect(findArg.take).toBe(288);
    expect(findArg.order).toEqual({ capturedAt: 'DESC' });
    expect(findArg.where.capturedAt._type).toBe('moreThanOrEqual');
  });

  it('serves the windowed series oldest-first with the streak counting this read\'s live verdict', async () => {
    const admin = `Bearer ${token(UserRole.ADMIN)}`;
    // DESC store order: newest first — alerting 1m ago, ok 2m ago, alerting 3m ago.
    const rows = [verdictRow(1, 'alerting'), verdictRow(2, 'ok'), verdictRow(3, 'alerting')];
    verdictRepo.find.mockResolvedValue(rows);
    const res = await get(admin, '/api/admin/alerts/history?limit=10');
    expect(res.status).toBe(200);
    const body = res.body;

    expect((verdictRepo.find.mock.calls[0][0] as Record<string, any>).take).toBe(10);
    expect(body.enabled).toBe(true);
    expect(body.snapshotIntervalSec).toBe(300);
    expect(body.retentionSec).toBe(86_400);
    expect(body.window.windowSec).toBe(86_400);
    expect(Date.parse(body.window.to) - Date.parse(body.window.from)).toBe(86_400_000);
    expect(body.returned).toBe(3);
    expect(body.truncated).toBe(false);
    expect(body.error).toBe(false);
    expect(body.lastCapturedAt).toBe(rows[0].capturedAt.toISOString());

    // Oldest-first out; stored reports ride VERBATIM (contract round-trip).
    expect(body.items.map((i: { status: string }) => i.status)).toEqual([
      'alerting',
      'ok',
      'alerting',
    ]);
    expect(body.items[2].report).toEqual(rows[0].report);

    // Streak: persisted run from the newest = 1 (stops at the ok row);
    // the LIVE ALERTS_FIXTURE verdict is 'alerting' => +1 => 2 consecutive
    // alerting evaluations. trailingCapped false (3 rows < limit 10).
    expect(body.streak).toEqual({
      persistedTrailingAlerting: 1,
      trailingCapped: false,
      currentStatus: 'alerting',
      alerting: 2,
    });
  });
});
