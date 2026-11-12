import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
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

const JWT_TEST = 'admin-controller-http-test-key';

describe('AdminController HTTP', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const overview = jest.fn();
  const snapshot = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: JWT_TEST })],
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: { overview } },
        { provide: RequestMetricsService, useValue: { snapshot } },
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
      routeKeys: 2,
      overflowed: false,
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

  it('returns the snapshot verbatim to admins', async () => {
    // The fixture mirrors MetricsSnapshot exactly — a field renamed on one
    // side without the swagger model/fixture fails this round-trip.
    snapshot.mockReturnValue(METRICS_FIXTURE);
    const res = await get(`Bearer ${token(UserRole.ADMIN)}`, '/api/admin/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(METRICS_FIXTURE);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});
