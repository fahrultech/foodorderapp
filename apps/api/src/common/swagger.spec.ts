import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { SwaggerModule } from '@nestjs/swagger';
import { EMPTY } from 'rxjs';
import * as http from 'http';
import { AddressInfo } from 'net';

import {
  SWAGGER_JSON_PATH,
  SWAGGER_TAGS,
  SWAGGER_UI_PATH,
  buildSwaggerDocumentConfig,
} from './swagger';
import { RATE_LIMIT_CONFIG } from './rate-limit/rate-limit.config';
import { SlidingWindowLogStore } from './rate-limit/rate-limit.store';

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
import { RestaurantsController } from '../restaurants/restaurants.controller';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { RestaurantReviewsController, ReviewsController } from '../reviews/reviews.controller';
import { ReviewsService } from '../reviews/reviews.service';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { FavoritesService } from '../users/favorites.service';
import { AddressesService } from '../users/addresses.service';

/**
 * Guards the document against drifting from the actual route surface:
 * every real controller is registered on a throwaway app (services mocked —
 * only decorators matter here) and the generated OpenAPI doc is asserted to
 * cover every route, auth scheme, tag and DTO contract. This is the jest half
 * of the roadmap item; the runtime half (GET /api/docs serving Swagger UI)
 * is smoke-tested against the live server.
 */

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
];

const empty = () => ({});
const mockedProviders = [
  { provide: AuthService, useValue: empty() },
  { provide: OrdersService, useValue: empty() },
  // stream() is never called by this spec (it only asserts decorators),
  // but keep the mock shape honest so a future request-time test can reuse it.
  { provide: OrderEventsService, useValue: { stream: () => EMPTY } },
  { provide: MenuService, useValue: empty() },
  { provide: RestaurantsService, useValue: empty() },
  { provide: ReviewsService, useValue: empty() },
  { provide: UsersService, useValue: empty() },
  { provide: FavoritesService, useValue: empty() },
  { provide: AddressesService, useValue: empty() },
  { provide: PromosService, useValue: empty() },
  { provide: DataSource, useValue: { query: async () => [] } },
  { provide: JwtService, useValue: empty() },
  { provide: SlidingWindowLogStore, useValue: empty() },
  { provide: RATE_LIMIT_CONFIG, useValue: { rules: {} } },
];

type Doc = ReturnType<typeof SwaggerModule.createDocument>;

/** @nestjs/swagger 11 bakes the global prefix into the document paths. */
const P = (path: string) => `/api${path}`;

describe('OpenAPI document (generated from the real controllers)', () => {
  let app: INestApplication;
  let doc: Doc;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: CONTROLLERS,
      providers: mockedProviders,
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    doc = SwaggerModule.createDocument(app, buildSwaggerDocumentConfig());
    SwaggerModule.setup(SWAGGER_UI_PATH, app, doc);
    await app.listen(0); // real ephemeral port so the UI/JSON routes are fetchable
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const port = (app.getHttpServer().address() as AddressInfo).port;
      http
        .get({ port, path }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });

  it('covers every registered route', () => {
    const expected: Array<[string, string]> = [
      ['/health', 'get'],
      ['/auth/register', 'post'],
      ['/auth/login', 'post'],
      ['/auth/refresh', 'post'],
      ['/auth/logout', 'post'],
      ['/auth/me', 'get'],
      ['/users/me', 'patch'],
      ['/users/me/favorites', 'get'],
      ['/users/me/favorites', 'post'],
      ['/users/me/favorites/{menuItemId}', 'delete'],
      ['/users/me/addresses', 'get'],
      ['/users/me/addresses', 'post'],
      ['/users/me/addresses/{id}', 'patch'],
      ['/users/me/addresses/{id}', 'delete'],
      ['/users/me/addresses/{id}/default', 'post'],
      ['/restaurants', 'get'],
      ['/restaurants', 'post'],
      ['/restaurants/meta/cuisines', 'get'],
      ['/restaurants/mine', 'get'],
      ['/restaurants/{id}', 'get'],
      ['/restaurants/{id}', 'patch'],
      ['/restaurants/{restaurantId}/menu', 'get'],
      ['/restaurants/{restaurantId}/menu', 'post'],
      ['/menu/items/{id}', 'patch'],
      ['/menu/items/{id}/availability', 'patch'],
      ['/menu/items/{id}', 'delete'],
      ['/orders', 'post'],
      ['/orders/my', 'get'],
      ['/orders/{id}', 'get'],
      ['/orders/{id}/cancel', 'post'],
      ['/orders/{id}/next-statuses', 'get'],
      ['/orders/{id}/status', 'patch'],
      ['/restaurants/{id}/orders', 'get'],
      ['/restaurants/{id}/orders/{orderId}/status', 'patch'],
      ['/restaurants/{id}/orders/stream', 'get'],
      ['/restaurants/{id}/reviews', 'get'],
      ['/reviews', 'post'],
      ['/reviews/my', 'get'],
      ['/reviews/{id}', 'patch'],
      ['/reviews/{id}', 'delete'],
      ['/promos/validate', 'post'],
    ];
    for (const [path, method] of expected) {
      expect(doc.paths[P(path)]?.[method]).toBeDefined();
    }
    // Nothing on the controllers that the list above forgot: count operations.
    const opCount = Object.values(doc.paths).reduce(
      (n, item) => n + Object.keys(item).filter((m) => ['get', 'post', 'patch', 'delete'].includes(m)).length,
      0,
    );
    expect(opCount).toBe(expected.length);
  });

  it('declares the bearer scheme and applies it exactly where guards do', () => {
    expect(doc.components?.securitySchemes?.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    // Protected:
    for (const [path, method] of [
      ['/auth/me', 'get'],
      ['/auth/logout', 'post'],
      ['/users/me', 'patch'],
      ['/orders/my', 'get'],
      ['/orders/{id}/status', 'patch'],
      ['/restaurants/{id}/orders', 'get'],
      ['/restaurants/{id}/orders/stream', 'get'],
      ['/reviews', 'post'],
      ['/menu/items/{id}', 'delete'],
    ] as Array<[string, string]>) {
      const op = doc.paths[P(path)]?.[method];
      const security = op.security ?? [];
      expect(security.some((s: any) => 'bearer' in s)).toBe(true);
    }
    // Deliberately public (no Authorization required):
    for (const [path, method] of [
      ['/restaurants', 'get'],
      ['/orders', 'post'], // optional auth: guest checkout
      ['/promos/validate', 'post'],
      ['/restaurants/{id}/reviews', 'get'],
      ['/health', 'get'],
    ] as Array<[string, string]>) {
      const op = doc.paths[P(path)]?.[method];
      const security = op.security ?? [];
      expect(security.some((s: any) => 'bearer' in s)).toBe(false);
    }
  });

  it('carries DTO contracts in component schemas', () => {
    const schemas = doc.components?.schemas ?? {};
    // Required flags come from "not @IsOptional":
    expect(schemas['CreateOrderDto']).toMatchObject({
      required: expect.arrayContaining(['restaurantId', 'items']),
    });
    expect(schemas['CreateMenuItemDto']).toMatchObject({
      required: expect.arrayContaining(['name', 'priceCents']),
    });
    // Money documented as integer cents with the validator bounds:
    expect((schemas['CreateMenuItemDto'] as any)?.properties?.priceCents).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 10000000,
    });
    // The status enum is a shared component with all 6 values:
    expect(schemas['OrderStatus']).toMatchObject({
      enum: ['pending', 'confirmed', 'preparing', 'delivering', 'completed', 'cancelled'],
    });
    // Nullable string union must stay a string (would infer Object otherwise):
    expect((schemas['CreateReviewDto'] as any)?.properties?.comment).toMatchObject({
      type: 'string',
      nullable: true,
    });
    // Nested line items reference the item schema:
    expect((schemas['CreateOrderDto'] as any)?.properties?.items).toBeDefined();
  });

  it('documents query params incl. the explicit sort enum and SSE access_token', () => {
    const list = doc.paths[P('/restaurants')]?.get?.parameters ?? [];
    const byName = Object.fromEntries(list.map((p: any) => [p.name, p]));
    expect(byName['search']).toBeDefined();
    expect(byName['sort']?.schema?.enum).toEqual(['rating', 'deliveryFee', 'newest']);
    expect(byName['page']).toBeDefined();
    expect(byName['limit']).toBeDefined();

    const setStatus = doc.paths[P('/orders/{id}/status')]?.patch?.parameters ?? [];
    const statusParam = setStatus.find((p: any) => p.name === 'status');
    expect((statusParam as any)?.in).toBe('query');

    const stream = doc.paths[P('/restaurants/{id}/orders/stream')]?.get?.parameters ?? [];
    expect(stream.some((p: any) => p.name === 'access_token')).toBe(true);
  });

  it('serves the Swagger UI and the raw JSON at the roadmap contract URLs', async () => {
    const ui = await get(`/${SWAGGER_UI_PATH}`);
    expect(ui.status).toBe(200);
    expect(ui.body).toContain('swagger-ui');

    const json = await get(`/${SWAGGER_JSON_PATH}`);
    expect(json.status).toBe(200);
    const parsed = JSON.parse(json.body);
    expect(parsed.openapi).toMatch(/^3\./);
    expect(parsed.info.title).toBe('FoodOrder API');
    // No explicit servers: the served JSON carries an empty array, so the UI
    // uses the page origin - correct because document paths already start
    // with /api (any servers entry would double the prefix).
    expect(parsed.servers).toEqual([]);
    expect(parsed.paths['/api/auth/login'].post).toBeDefined();
  });

  it('groups every operation under a declared tag', () => {
    const declared = new Set((doc.tags ?? []).map((t) => t.name));
    expect([...declared].sort()).toEqual([...SWAGGER_TAGS].sort());
    for (const item of Object.values(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!['get', 'post', 'patch', 'delete'].includes(method)) continue;
        const tags = (op as any).tags;
        expect(Array.isArray(tags) && tags.length).toBeGreaterThan(0);
        for (const t of tags) expect(declared.has(t)).toBe(true);
      }
    }
  });
});

