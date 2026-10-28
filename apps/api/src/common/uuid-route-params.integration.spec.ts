import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { EMPTY } from 'rxjs';

import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { HealthController } from '../health/health.controller';
import { MenuController } from '../menu/menu.controller';
import { MenuItemsController } from '../menu/menu-items.controller';
import { MenuService } from '../menu/menu.service';
import { OrdersController } from '../orders/orders.controller';
import { RestaurantOrdersController } from '../orders/restaurant-orders.controller';
import { OrdersService } from '../orders/orders.service';
import { OrderEventsService } from '../orders/order-events.service';
import { PromosController } from '../promos/promos.controller';
import { PromosService } from '../promos/promos.service';
import { OrderPaymentsController, PaymentsController } from '../payments/payments.controller';
import { PaymentsService } from '../payments/payments.service';
import { RestaurantsController } from '../restaurants/restaurants.controller';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { RestaurantReviewsController, ReviewsController } from '../reviews/reviews.controller';
import { ReviewsService } from '../reviews/reviews.service';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { FavoritesService } from '../users/favorites.service';
import { AddressesService } from '../users/addresses.service';

import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { SseJwtAuthGuard } from './sse-jwt-auth.guard';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { RATE_LIMIT_CONFIG } from './rate-limit/rate-limit.config';
import { SlidingWindowLogStore } from './rate-limit/rate-limit.store';
import { ErrorFormatFilter } from './error-format.filter';
import { createGlobalValidationPipe } from './app-config';

/**
 * Roadmap Phase 4 — "reject malformed uuid route params with 400".
 *
 * Every uuid-shaped path segment across the real controllers is bound with
 * `UuidParam` (ParseUUIDPipe). This spec boots the FULL controller surface on
 * a throwaway app with the PRODUCTION pipes + error filter (services mocked,
 * guards stubbed-open) and proves over real HTTP that:
 *
 *   1. a malformed route param answers 400 BAD_REQUEST in the standard
 *      envelope and the service handler is NEVER called (Postgres 22P02 can
 *      no longer surface as a 500), and
 *   2. a validly-shaped uuid passes through untouched to the handler.
 *
 * Guards run before pipes in the Nest pipeline (auth-first ordering); that
 * ordering is exercised on guarded routes by the stub-open guards below.
 */

const VALID = '22222222-2222-4222-8222-222222222222';
const BAD = 'not-a-uuid';
const BAD2 = '12345';
const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const fn = () => jest.fn(async () => ({}));

function mocks() {
  return {
    auth: { login: fn() } as unknown as AuthService,
    menu: {
      findByRestaurant: jest.fn(async () => []),
      createForRestaurant: jest.fn(async (id: string) => ({ id })),
      updateItem: jest.fn(async (id: string) => ({ id })),
      setAvailability: jest.fn(async (id: string) => ({ id })),
      remove: jest.fn(async (id: string) => ({ id })),
    } as unknown as MenuService,
    orders: {
      findOne: jest.fn(async (id: string) => ({ id })),
      nextStatuses: jest.fn(async () => ['confirmed']),
      cancel: jest.fn(async (id: string) => ({ id })),
      updateStatus: jest.fn(async () => ({ id: 'x' })),
      findForRestaurant: jest.fn(async () => ({ items: [], total: 0 })),
      setStatusForRestaurant: jest.fn(async () => ({ id: 'x' })),
      assertStreamAccess: jest.fn(async () => ({ id: 'x' })),
      create: jest.fn(async () => ({ id: 'x' })),
    } as unknown as OrdersService,
    events: { stream: () => EMPTY } as unknown as OrderEventsService,
    restaurants: {
      // null for the "valid but unknown" pass-through probes → the public
      // GET /restaurants/:id controller turns that into its documented 404.
      findOne: jest.fn(async () => null),
      updateOwned: jest.fn(async () => ({ id: 'x' })),
      findAll: jest.fn(async () => ({ items: [], total: 0 })),
      findRestaurants: jest.fn(async () => []),
      findOwned: jest.fn(async () => []),
      createForOwner: jest.fn(async () => ({ id: 'x' })),
    } as unknown as RestaurantsService,
    reviews: {
      listForRestaurant: jest.fn(async () => ({ items: [], total: 0 })),
      update: jest.fn(async (_u: string, id: string) => ({ id })),
      remove: jest.fn(async () => ({ removed: false })),
      create: jest.fn(async () => ({ id: 'x' })),
      listMine: jest.fn(async () => ({ items: [], total: 0 })),
    } as unknown as ReviewsService,
    users: { updateProfile: jest.fn(async () => ({ id: UID })) } as unknown as UsersService,
    favorites: {
      list: jest.fn(async () => ({ items: [], total: 0 })),
      add: jest.fn(async () => ({ created: true })),
      remove: jest.fn(async () => ({ removed: false })),
    } as unknown as FavoritesService,
    addresses: {
      list: jest.fn(async () => ({ items: [], total: 0 })),
      create: jest.fn(async () => ({ item: {} })),
      update: jest.fn(async (_u: string, id: string) => ({ item: { id } })),
      remove: jest.fn(async () => ({ removed: false })),
      setDefault: jest.fn(async () => ({ alreadyDefault: true, item: {} })),
    } as unknown as AddressesService,
    promos: { preview: jest.fn(async () => ({ valid: false })) } as unknown as PromosService,
    payments: {
      pay: jest.fn(async () => ({ payment: {}, clientSecret: null })),
      capture: jest.fn(async (id: string) => ({ id })),
      listForOrder: jest.fn(async () => []),
      refund: jest.fn(async (id: string) => ({ id })),
      listRefunds: jest.fn(async (id: string) => [{ paymentId: id }]),
    } as unknown as PaymentsService,
  };
}

const CONTROLLERS = [
  AuthController,
  HealthController,
  MenuController,
  MenuItemsController,
  OrdersController,
  RestaurantOrdersController,
  PromosController,
  RestaurantsController,
  RestaurantReviewsController,
  ReviewsController,
  UsersController,
  PaymentsController,
  OrderPaymentsController,
];

/** Stub-open every guard the routes use; also attaches a fake JWT user. */
const openGuard = {
  canActivate: (ctx: any) => {
    ctx.switchToHttp().getRequest().user = { sub: UID, role: 'OWNER' };
    return true;
  },
};

function request(
  app: INestApplication,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let json: any;
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode!, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Mocks are created at module scope: the route table below references them
// during describe-collection, BEFORE any hook runs. One set is reused by the
// app built in beforeAll; tests mockClear() per case.
const m = mocks();

describe('uuid route params — ParseUUIDPipe sweep (live HTTP, production pipes+filter)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: CONTROLLERS,
      providers: [
        { provide: AuthService, useValue: m.auth },
        { provide: MenuService, useValue: m.menu },
        { provide: OrdersService, useValue: m.orders },
        { provide: OrderEventsService, useValue: m.events },
        { provide: RestaurantsService, useValue: m.restaurants },
        { provide: ReviewsService, useValue: m.reviews },
        { provide: UsersService, useValue: m.users },
        { provide: FavoritesService, useValue: m.favorites },
        { provide: AddressesService, useValue: m.addresses },
        { provide: PromosService, useValue: m.promos },
        { provide: PaymentsService, useValue: m.payments },
        { provide: DataSource, useValue: { query: async () => [] } },
        { provide: JwtService, useValue: {} },
        { provide: SlidingWindowLogStore, useValue: {} },
        { provide: RATE_LIMIT_CONFIG, useValue: { rules: {} } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(openGuard)
      .overrideGuard(RolesGuard)
      .useValue(openGuard)
      .overrideGuard(OptionalJwtAuthGuard)
      .useValue(openGuard)
      .overrideGuard(SseJwtAuthGuard)
      .useValue(openGuard)
      .overrideGuard(RateLimitGuard)
      .useValue(openGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    app.useGlobalFilters(new ErrorFormatFilter());
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  // [method, path built from a param slot, service mock that must NOT run]
  const uuidRoutes: Array<[string, (id: string) => string, jest.Mock, unknown?]> = [
    ['GET', (id) => `/api/restaurants/${id}/menu`, m.menu.findByRestaurant as jest.Mock],
    ['POST', (id) => `/api/restaurants/${id}/menu`, m.menu.createForRestaurant as jest.Mock,
      { name: 'Rice', priceCents: 1000 }],
    ['PATCH', (id) => `/api/menu/items/${id}`, m.menu.updateItem as jest.Mock, { name: 'X' }],
    ['PATCH', (id) => `/api/menu/items/${id}/availability`, m.menu.setAvailability as jest.Mock,
      { isAvailable: false }],
    ['DELETE', (id) => `/api/menu/items/${id}`, m.menu.remove as jest.Mock],
    ['GET', (id) => `/api/restaurants/${id}`, m.restaurants.findOne as jest.Mock],
    ['PATCH', (id) => `/api/restaurants/${id}`, m.restaurants.updateOwned as jest.Mock,
      { name: 'X' }],
    ['GET', (id) => `/api/orders/${id}`, m.orders.findOne as jest.Mock],
    ['GET', (id) => `/api/orders/${id}/next-statuses`, m.orders.nextStatuses as jest.Mock],
    ['POST', (id) => `/api/orders/${id}/cancel`, m.orders.cancel as jest.Mock],
    ['PATCH', (id) => `/api/orders/${id}/status?status=confirmed`, m.orders.updateStatus as jest.Mock],
    ['GET', (id) => `/api/restaurants/${id}/orders`, m.orders.findForRestaurant as jest.Mock],
    ['GET', (id) => `/api/restaurants/${id}/orders/stream`, m.orders.assertStreamAccess as jest.Mock],
    ['GET', (id) => `/api/restaurants/${id}/reviews`, m.reviews.listForRestaurant as jest.Mock],
    ['PATCH', (id) => `/api/reviews/${id}`, m.reviews.update as jest.Mock, { rating: 5 }],
    ['DELETE', (id) => `/api/reviews/${id}`, m.reviews.remove as jest.Mock],
    ['DELETE', (id) => `/api/users/me/favorites/${id}`, m.favorites.remove as jest.Mock],
    ['PATCH', (id) => `/api/users/me/addresses/${id}`, m.addresses.update as jest.Mock,
      { label: 'Home' }],
    ['DELETE', (id) => `/api/users/me/addresses/${id}`, m.addresses.remove as jest.Mock],
    ['POST', (id) => `/api/users/me/addresses/${id}/default`, m.addresses.setDefault as jest.Mock],
    ['GET', (id) => `/api/orders/${id}/payments`, m.payments.listForOrder as jest.Mock],
    ['POST', (id) => `/api/payments/${id}/capture`, m.payments.capture as jest.Mock],
    ['POST', (id) => `/api/payments/${id}/refund`, m.payments.refund as jest.Mock, { amountCents: 100 }],
    ['GET', (id) => `/api/payments/${id}/refunds`, m.payments.listRefunds as jest.Mock],
  ];

  it.each(uuidRoutes)(
    'malformed id → 400 envelope before the service (%s %s)',
    async (method, path, svcMock, body = undefined) => {
      svcMock.mockClear();
      const res = await request(app, method, path(BAD), body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('BAD_REQUEST');
      expect(res.json.error.message).toMatch(/uuid/i);
      expect(svcMock).not.toHaveBeenCalled();
      // No stack trace leaks in the envelope.
      expect(JSON.stringify(res.json)).not.toMatch(/QueryFailedError|22P02|at .*\.ts\d+/);
    },
  );

  it('rejects a numeric junk id and an overlong string too (two shapes of malformed)', async () => {
    const numeric = await request(app, 'GET', `/api/orders/${BAD2}`);
    expect(numeric.status).toBe(400);
    const overlong = await request(app, 'GET', '/api/orders/zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzzz');
    expect(overlong.status).toBe(400);
  });

  it('checks BOTH portal ids (restaurant and order) on the status route', async () => {
    (m.orders.setStatusForRestaurant as jest.Mock).mockClear();
    const badRest = await request(
      app, 'PATCH', `/api/restaurants/${BAD}/orders/${VALID}/status?status=confirmed`);
    expect(badRest.status).toBe(400);
    const badOrder = await request(
      app, 'PATCH', `/api/restaurants/${VALID}/orders/${BAD}/status?status=confirmed`);
    expect(badOrder.status).toBe(400);
    expect(m.orders.setStatusForRestaurant).not.toHaveBeenCalled();
  });

  // SSE is excluded from pass-through on purpose: a successful @Sse response
  // stays open (15s heartbeats), which a request/response spec must not wait
  // on. Its malformed 400 (above) is exactly what the sweep must prove; the
  // stream's valid-id semantics live in restaurant-orders.controller.spec.ts.
  const passThroughRoutes = uuidRoutes.filter(
    ([, path]) => !path(VALID).endsWith('/stream'),
  );

  it.each(passThroughRoutes)(
    'valid uuid still passes through to the handler (%s %s)',
    async (method, path, svcMock, body = undefined) => {
      svcMock.mockClear();
      const res = await request(app, method, path(VALID), body);
      // The pipe never rejects a shaped uuid: whatever the mock/controller
      // answers, it is NOT the pipe's 400 and the handler HAS run.
      expect(res.status).not.toBe(400);
      expect(svcMock).toHaveBeenCalledTimes(1);
      expect(svcMock.mock.calls[0].some((a: unknown) => a === VALID)).toBe(true);
    },
  );

  it('keeps valid-but-unknown restaurant ids at 404 (pipe checks shape, never existence)', async () => {
    // restaurants.findOne mock resolves null — the controller's own contract.
    const res = await request(app, 'GET', `/api/restaurants/${VALID}`);
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('NOT_FOUND');
  });
});
