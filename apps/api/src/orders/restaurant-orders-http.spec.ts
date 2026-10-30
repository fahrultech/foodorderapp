import * as http from 'http';
import { AddressInfo } from 'net';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import { RestaurantOrdersController } from './restaurant-orders.controller';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { AppException } from '../common/app-exception';
import { Order, OrderStatus } from './order.entity';

/**
 * HTTP-surface integration spec for RestaurantOrdersController:
 * - GET  /restaurants/:id/orders          (owner inbox)
 * - PATCH /restaurants/:id/orders/:orderId/status  (owner status move)
 *
 * Proves over REAL HTTP: auth/role guards, DTO query validation,
 * ParseUUIDPipe on both uuid params, and — crucially — that the
 * service's AppException(402, 'PAYMENT_REQUIRED') renders through
 * ErrorFormatFilter as a standard { error: { code } } envelope.
 *
 * OrdersService is mocked; no DB or rate-limit infra required.
 */

const JWT_TEST = 'restaurant-orders-http-spec';
const REST_ID   = '11111111-1111-4111-8111-111111111111';
const ORDER_ID  = '22222222-2222-4222-8222-222222222222';
const OWNER_ID  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_ID  = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CUST_ID   = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function httpReq(
  app: INestApplication,
  method: string,
  path: string,
  opts: { token?: string } = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const headers: Record<string, string> = {};
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json: any;
        try { json = JSON.parse(raw); } catch { json = undefined; }
        resolve({ status: res.statusCode!, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const sampleOrder: Partial<Order> = {
  id: ORDER_ID,
  code: 'FO-TEST',
  restaurantId: REST_ID,
  status: OrderStatus.PENDING,
};

function buildApp(svcOverrides: Partial<Record<keyof OrdersService, jest.Mock>> = {}) {
  const svc = {
    findForRestaurant: jest.fn(async () => ({ data: [sampleOrder], total: 1 })),
    setStatusForRestaurant: jest.fn(async () => ({
      ...sampleOrder,
      status: OrderStatus.CONFIRMED,
    })),
    assertStreamAccess: jest.fn(async () => ({ id: REST_ID })),
    ...svcOverrides,
  } as unknown as OrdersService;

  return { svc };
}

async function boot(svcOverrides?: Partial<Record<keyof OrdersService, jest.Mock>>) {
  const { svc } = buildApp(svcOverrides);
  const events = new OrderEventsService();

  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: JWT_TEST })],
    controllers: [RestaurantOrdersController],
    providers: [
      JwtAuthGuard,
      RolesGuard,
      Reflector,
      { provide: OrdersService, useValue: svc },
      { provide: OrderEventsService, useValue: events },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  await app.listen(0);

  const jwt = app.get(JwtService);
  const ownerToken = await jwt.signAsync({ sub: OWNER_ID, role: UserRole.OWNER, typ: TOKEN_TYPE_ACCESS });
  const adminToken = await jwt.signAsync({ sub: ADMIN_ID, role: UserRole.ADMIN, typ: TOKEN_TYPE_ACCESS });
  const custToken  = await jwt.signAsync({ sub: CUST_ID,  role: UserRole.CUSTOMER, typ: TOKEN_TYPE_ACCESS });

  return { app, svc, ownerToken, adminToken, custToken };
}

type MockSvc = {
  findForRestaurant: jest.Mock;
  setStatusForRestaurant: jest.Mock;
  assertStreamAccess: jest.Mock;
};

// ---------------------------------------------------------------------------
// GET /api/restaurants/:id/orders — owner inbox
// ---------------------------------------------------------------------------
describe('GET /restaurants/:id/orders — owner inbox guard + uuid pipe', () => {
  let app: INestApplication;
  let svc: MockSvc;
  let ownerToken: string;
  let custToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const result = await boot();
    app = result.app;
    svc = result.svc as unknown as MockSvc;
    ownerToken = result.ownerToken;
    custToken = result.custToken;
    adminToken = result.adminToken;
  });
  afterAll(() => app.close());
  beforeEach(() => (svc.findForRestaurant as jest.Mock).mockClear());

  it('anonymous → 401 envelope, service untouched', async () => {
    const res = await httpReq(app, 'GET', `/api/restaurants/${REST_ID}/orders`);
    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(res.json.error.code).toBe('UNAUTHORIZED');
    expect(svc.findForRestaurant).not.toHaveBeenCalled();
  });

  it('CUSTOMER role → 403 envelope (RolesGuard), service untouched', async () => {
    const res = await httpReq(app, 'GET', `/api/restaurants/${REST_ID}/orders`, { token: custToken });
    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(res.json.error.code).toBe('FORBIDDEN');
    expect(svc.findForRestaurant).not.toHaveBeenCalled();
  });

  it('OWNER + valid uuid → 200 OK, service called with restaurant id + actor', async () => {
    const res = await httpReq(app, 'GET', `/api/restaurants/${REST_ID}/orders`, { token: ownerToken });
    expect(res.status).toBe(HttpStatus.OK);
    expect(svc.findForRestaurant).toHaveBeenCalledWith(
      REST_ID,
      expect.objectContaining({ sub: OWNER_ID, role: UserRole.OWNER }),
      expect.anything(),
    );
  });

  it('ADMIN bypasses the OWNER RolesGuard → 200', async () => {
    const res = await httpReq(app, 'GET', `/api/restaurants/${REST_ID}/orders`, { token: adminToken });
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('non-uuid restaurant id → 400 BAD_REQUEST, service never called', async () => {
    const res = await httpReq(app, 'GET', '/api/restaurants/not-a-uuid/orders', { token: ownerToken });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(res.json.error.message).toMatch(/uuid/i);
    expect(svc.findForRestaurant).not.toHaveBeenCalled();
  });

  it('service NotFoundException → 404 standard envelope', async () => {
    (svc.findForRestaurant as jest.Mock).mockRejectedValueOnce(
      new AppException(404, 'NOT_FOUND', 'Restaurant not found'),
    );
    const res = await httpReq(app, 'GET', `/api/restaurants/${REST_ID}/orders`, { token: ownerToken });
    expect(res.status).toBe(HttpStatus.NOT_FOUND);
    expect(res.json.error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/restaurants/:id/orders/:orderId/status — owner status move
// ---------------------------------------------------------------------------
describe('PATCH /restaurants/:id/orders/:orderId/status — status move guards + 402 envelope', () => {
  let app: INestApplication;
  let svc: MockSvc;
  let ownerToken: string;
  let adminToken: string;
  let custToken: string;

  beforeAll(async () => {
    const result = await boot();
    app = result.app;
    svc = result.svc as unknown as MockSvc;
    ownerToken = result.ownerToken;
    adminToken = result.adminToken;
    custToken = result.custToken;
  });
  afterAll(() => app.close());
  beforeEach(() => (svc.setStatusForRestaurant as jest.Mock).mockClear());

  it('anonymous → 401 envelope, service untouched', async () => {
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status?status=confirmed`);
    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(res.json.error.code).toBe('UNAUTHORIZED');
    expect(svc.setStatusForRestaurant).not.toHaveBeenCalled();
  });

  it('CUSTOMER role → 403 envelope (RolesGuard), service untouched', async () => {
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status?status=confirmed`, { token: custToken });
    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(res.json.error.code).toBe('FORBIDDEN');
    expect(svc.setStatusForRestaurant).not.toHaveBeenCalled();
  });

  it('OWNER + valid uuids + valid status → 200, actor passed to service', async () => {
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status?status=confirmed`, { token: ownerToken });
    expect(res.status).toBe(HttpStatus.OK);
    expect(svc.setStatusForRestaurant).toHaveBeenCalledWith(
      REST_ID,
      ORDER_ID,
      OrderStatus.CONFIRMED,
      expect.objectContaining({ sub: OWNER_ID, role: UserRole.OWNER }),
    );
    expect(res.json).toMatchObject({ status: 'confirmed' });
  });

  it('ADMIN bypasses OWNER RolesGuard and can move status', async () => {
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status?status=preparing`, { token: adminToken });
    expect(res.status).toBe(HttpStatus.OK);
    expect(svc.setStatusForRestaurant).toHaveBeenCalledWith(
      REST_ID,
      ORDER_ID,
      OrderStatus.PREPARING,
      expect.objectContaining({ sub: ADMIN_ID, role: UserRole.ADMIN }),
    );
  });

  it('non-uuid restaurant id → 400 BEFORE service (ParseUUIDPipe on :id)', async () => {
    const res = await httpReq(app, 'PATCH', `/api/restaurants/bad-id/orders/${ORDER_ID}/status?status=confirmed`, { token: ownerToken });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(res.json.error.message).toMatch(/uuid/i);
    expect(svc.setStatusForRestaurant).not.toHaveBeenCalled();
  });

  it('non-uuid orderId → 400 BEFORE service (ParseUUIDPipe on :orderId)', async () => {
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/bad-order-id/status?status=confirmed`, { token: ownerToken });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(res.json.error.message).toMatch(/uuid/i);
    expect(svc.setStatusForRestaurant).not.toHaveBeenCalled();
  });

  it('junk status query param → 400 BAD_REQUEST from DTO enum validation, service untouched', async () => {
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status?status=gibbering`, { token: ownerToken });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(Array.isArray(res.json.error.details)).toBe(true);
    expect(svc.setStatusForRestaurant).not.toHaveBeenCalled();
  });

  it('missing status param → 400 BAD_REQUEST, service untouched', async () => {
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status`, { token: ownerToken });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(svc.setStatusForRestaurant).not.toHaveBeenCalled();
  });

  // ---- The core integration test: 402 payment gate envelope ---------------

  it('service throws AppException(402, PAYMENT_REQUIRED) → 402 standard envelope (gate renders through ErrorFormatFilter)', async () => {
    (svc.setStatusForRestaurant as jest.Mock).mockRejectedValueOnce(
      new AppException(402, 'PAYMENT_REQUIRED', 'A succeeded payment is required to confirm this order'),
    );
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status?status=confirmed`, { token: ownerToken });
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe('PAYMENT_REQUIRED');
    expect(typeof res.json.error.message).toBe('string');
    expect(res.json.error.message).toMatch(/payment/i);
  });

  it('ADMIN backdoor confirm also receives 402 when service enforces the gate', async () => {
    (svc.setStatusForRestaurant as jest.Mock).mockRejectedValueOnce(
      new AppException(402, 'PAYMENT_REQUIRED', 'A succeeded payment is required to confirm this order'),
    );
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status?status=confirmed`, { token: adminToken });
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe('PAYMENT_REQUIRED');
  });

  it('service AppException(400, BAD_TRANSITION) surfaces as 400 envelope', async () => {
    (svc.setStatusForRestaurant as jest.Mock).mockRejectedValueOnce(
      new AppException(400, 'BAD_TRANSITION', 'Cannot move confirmed → pending'),
    );
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status?status=pending`, { token: ownerToken });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(res.json.error.code).toBe('BAD_TRANSITION');
  });

  it('service AppException(403, FORBIDDEN_OWNERSHIP) surfaces as 403 envelope', async () => {
    (svc.setStatusForRestaurant as jest.Mock).mockRejectedValueOnce(
      new AppException(403, 'FORBIDDEN', 'Restaurant not owned by this user'),
    );
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status?status=confirmed`, { token: ownerToken });
    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(res.json.error.code).toBe('FORBIDDEN');
  });

  it('service AppException(404, NOT_FOUND) surfaces as 404 envelope', async () => {
    (svc.setStatusForRestaurant as jest.Mock).mockRejectedValueOnce(
      new AppException(404, 'NOT_FOUND', 'Order not found'),
    );
    const res = await httpReq(app, 'PATCH', `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/status?status=confirmed`, { token: ownerToken });
    expect(res.status).toBe(HttpStatus.NOT_FOUND);
    expect(res.json.error.code).toBe('NOT_FOUND');
  });
});
