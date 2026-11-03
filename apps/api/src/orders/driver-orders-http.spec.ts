import * as http from 'http';
import { AddressInfo } from 'net';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { RestaurantOrdersController } from './restaurant-orders.controller';
import { DriverOrdersController } from './driver-orders.controller';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { OrderStatus } from './order.entity';

const JWT_TEST = 'driver-orders-http-spec';
const REST_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DRIVER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ADMIN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function request(
  app: INestApplication,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        let json: any;
        try { json = JSON.parse(raw); } catch { json = undefined; }
        resolve({ status: res.statusCode!, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function boot() {
  const service = {
    assignDriverForRestaurant: jest.fn(async (_restaurantId, orderId, driverId) => ({
      id: orderId,
      driverId,
      status: OrderStatus.PREPARING,
    })),
    findForDriver: jest.fn(async () => ({ items: [], total: 0, page: 1, limit: 20 })),
    setStatusForDriver: jest.fn(async (id, status) => ({ id, status })),
    assertStreamAccess: jest.fn(),
  } as unknown as OrdersService;
  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: JWT_TEST })],
    controllers: [RestaurantOrdersController, DriverOrdersController],
    providers: [
      JwtAuthGuard,
      RolesGuard,
      Reflector,
      { provide: OrdersService, useValue: service },
      { provide: OrderEventsService, useValue: new OrderEventsService() },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  await app.listen(0);
  const jwt = app.get(JwtService);
  const token = (sub: string, role: UserRole) =>
    jwt.signAsync({ sub, role, typ: TOKEN_TYPE_ACCESS });
  return {
    app,
    service: service as unknown as {
      assignDriverForRestaurant: jest.Mock;
      findForDriver: jest.Mock;
      setStatusForDriver: jest.Mock;
    },
    owner: await token(OWNER_ID, UserRole.OWNER),
    driver: await token(DRIVER_ID, UserRole.DRIVER),
    admin: await token(ADMIN_ID, UserRole.ADMIN),
    customer: await token(CUSTOMER_ID, UserRole.CUSTOMER),
  };
}

describe('driver assignment + driver order HTTP surface', () => {
  let h: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => { h = await boot(); });
  afterAll(async () => h.app.close());
  beforeEach(() => jest.clearAllMocks());

  it('OWNER assigns and unassigns with a validated body; ADMIN bypasses owner role gate', async () => {
    for (const [token, driverId] of [[h.owner, DRIVER_ID], [h.admin, null]] as const) {
      const res = await request(
        h.app,
        'PATCH',
        `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/driver`,
        token,
        { driverId },
      );
      expect(res.status).toBe(HttpStatus.OK);
      expect(h.service.assignDriverForRestaurant).toHaveBeenLastCalledWith(
        REST_ID,
        ORDER_ID,
        driverId,
        expect.objectContaining({ role: token === h.owner ? UserRole.OWNER : UserRole.ADMIN }),
      );
    }
  });

  it.each([{}, { driverId: 'bad-id' }, { driverId: 12 }])(
    'rejects malformed assignment body before service: %p',
    async (body) => {
      const res = await request(
        h.app,
        'PATCH',
        `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/driver`,
        h.owner,
        body,
      );
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(h.service.assignDriverForRestaurant).not.toHaveBeenCalled();
    },
  );

  it('rejects anonymous/customer/driver assignment attempts', async () => {
    for (const token of [undefined, h.customer, h.driver]) {
      const res = await request(
        h.app,
        'PATCH',
        `/api/restaurants/${REST_ID}/orders/${ORDER_ID}/driver`,
        token,
        { driverId: DRIVER_ID },
      );
      expect(res.status).toBe(token ? HttpStatus.FORBIDDEN : HttpStatus.UNAUTHORIZED);
    }
    expect(h.service.assignDriverForRestaurant).not.toHaveBeenCalled();
  });

  it('driver lists only their own assignments using ListMyOrdersDto', async () => {
    const res = await request(
      h.app,
      'GET',
      '/api/driver/orders?status=preparing&page=2&limit=5',
      h.driver,
    );
    expect(res.status).toBe(HttpStatus.OK);
    expect(h.service.findForDriver).toHaveBeenCalledWith(DRIVER_ID, {
      status: OrderStatus.PREPARING,
      page: 2,
      limit: 5,
    });
  });

  it('driver updates an assigned order using the existing validated status query DTO', async () => {
    const res = await request(
      h.app,
      'PATCH',
      `/api/driver/orders/${ORDER_ID}/status?status=delivering`,
      h.driver,
    );
    expect(res.status).toBe(HttpStatus.OK);
    expect(h.service.setStatusForDriver).toHaveBeenCalledWith(
      ORDER_ID,
      OrderStatus.DELIVERING,
      DRIVER_ID,
    );
  });

  it('driver routes reject non-driver roles, malformed UUIDs, and junk statuses before service', async () => {
    for (const token of [h.owner, h.admin, h.customer]) {
      expect((await request(h.app, 'GET', '/api/driver/orders', token)).status).toBe(HttpStatus.FORBIDDEN);
    }
    expect((await request(h.app, 'PATCH', '/api/driver/orders/bad/status?status=delivering', h.driver)).status).toBe(HttpStatus.BAD_REQUEST);
    expect((await request(h.app, 'PATCH', `/api/driver/orders/${ORDER_ID}/status?status=junk`, h.driver)).status).toBe(HttpStatus.BAD_REQUEST);
    expect(h.service.findForDriver).not.toHaveBeenCalled();
    expect(h.service.setStatusForDriver).not.toHaveBeenCalled();
  });
});
