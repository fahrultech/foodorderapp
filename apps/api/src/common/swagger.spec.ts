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
  PaymentsController,
  OrderPaymentsController,
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
  { provide: PaymentsService, useValue: empty() },
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
      ['/orders/ops/cancel-stale', 'post'],
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
      ['/payments', 'post'],
      ['/payments/{id}/capture', 'post'],
      ['/orders/{orderId}/payments', 'get'],
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
      ['/orders/ops/cancel-stale', 'post'],
      ['/orders/{id}/status', 'patch'],
      ['/restaurants/{id}/orders', 'get'],
      ['/restaurants/{id}/orders/stream', 'get'],
      ['/reviews', 'post'],
      ['/menu/items/{id}', 'delete'],
      ['/payments', 'post'],
      ['/payments/{id}/capture', 'post'],
      ['/orders/{orderId}/payments', 'get'],
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

  it('types the success response of every operation', () => {
    // (path, method, http code, expected shape) — codes follow the REAL Nest
    // defaults (POST = 201 unless the controller pins @HttpCode(200)), so a
    // future status change must be an explicit decision reflected here.
    const SUCCESS: Array<[string, string, number, string]> = [
      ['/health', 'get', 200, 'ref:HealthResponse'],
      ['/auth/register', 'post', 201, 'ref:SessionResponse'],
      ['/auth/login', 'post', 201, 'ref:SessionResponse'],
      ['/auth/refresh', 'post', 200, 'ref:SessionResponse'],
      ['/auth/logout', 'post', 200, 'ref:LogoutResponse'],
      ['/auth/me', 'get', 200, 'ref:SafeUserResponse'],
      ['/users/me', 'patch', 200, 'ref:SafeUserResponse'],
      ['/users/me/favorites', 'get', 200, 'ref:FavoriteListResponse'],
      ['/users/me/favorites', 'post', 200, 'ref:FavoriteAddResponse'],
      ['/users/me/favorites/{menuItemId}', 'delete', 200, 'ref:RemovedResponse'],
      ['/users/me/addresses', 'get', 200, 'ref:AddressListResponse'],
      ['/users/me/addresses', 'post', 201, 'ref:AddressItemResponse'],
      ['/users/me/addresses/{id}', 'patch', 200, 'ref:AddressItemResponse'],
      ['/users/me/addresses/{id}', 'delete', 200, 'ref:AddressRemoveResponse'],
      ['/users/me/addresses/{id}/default', 'post', 200, 'ref:AddressDefaultResponse'],
      ['/restaurants', 'get', 200, 'ref:PaginatedRestaurantsResponse'],
      ['/restaurants', 'post', 201, 'ref:RestaurantResponse'],
      ['/restaurants/meta/cuisines', 'get', 200, 'strArray'],
      ['/restaurants/mine', 'get', 200, 'array:RestaurantResponse'],
      ['/restaurants/{id}', 'get', 200, 'ref:RestaurantWithMenuResponse'],
      ['/restaurants/{id}', 'patch', 200, 'ref:RestaurantResponse'],
      ['/restaurants/{restaurantId}/menu', 'get', 200, 'array:MenuItemResponse'],
      ['/restaurants/{restaurantId}/menu', 'post', 201, 'ref:MenuItemResponse'],
      ['/menu/items/{id}', 'patch', 200, 'ref:MenuItemResponse'],
      ['/menu/items/{id}/availability', 'patch', 200, 'ref:MenuItemResponse'],
      ['/menu/items/{id}', 'delete', 200, 'ref:MenuItemResponse'],
      ['/orders', 'post', 201, 'ref:OrderResponse'],
      ['/orders/my', 'get', 200, 'ref:PaginatedOrdersResponse'],
      ['/orders/ops/cancel-stale', 'post', 200, 'ref:CancelStaleResponse'],
      ['/orders/{id}', 'get', 200, 'ref:OrderResponse'],
      ['/orders/{id}/cancel', 'post', 201, 'ref:OrderResponse'],
      ['/orders/{id}/next-statuses', 'get', 200, 'ref:NextStatusesResponse'],
      ['/orders/{id}/status', 'patch', 200, 'ref:OrderResponse'],
      ['/restaurants/{id}/orders', 'get', 200, 'ref:OwnerInboxResponse'],
      ['/restaurants/{id}/orders/{orderId}/status', 'patch', 200, 'ref:OrderResponse'],
      ['/restaurants/{id}/orders/stream', 'get', 200, 'sse'],
      ['/restaurants/{id}/reviews', 'get', 200, 'ref:ReviewFeedResponse'],
      ['/reviews', 'post', 201, 'ref:ReviewWriteResponse'],
      ['/reviews/my', 'get', 200, 'ref:ReviewListResponse'],
      ['/reviews/{id}', 'patch', 200, 'ref:ReviewWriteResponse'],
      ['/reviews/{id}', 'delete', 200, 'ref:ReviewRemoveResponse'],
      ['/promos/validate', 'post', 201, 'oneOf2'],
      ['/payments', 'post', 201, 'ref:PaymentResponse'],
      ['/payments/{id}/capture', 'post', 200, 'ref:PaymentResponse'],
      ['/orders/{orderId}/payments', 'get', 200, 'array:PaymentResponse'],
    ];
    expect(SUCCESS.length).toBe(45);
    for (const [path, method, code, kind] of SUCCESS) {
      const res = doc.paths[P(path)]?.[method]?.responses?.[String(code)];
      if (!res) throw new Error(`${method} ${path}: no ${code} response documented`);
      const contentTypes = Object.keys(res.content ?? {});
      if (kind === 'sse') {
        expect(contentTypes).toEqual(['text/event-stream']);
        continue;
      }
      expect(contentTypes).toEqual(['application/json']);
      const schema = res.content['application/json'].schema;
      if (kind.startsWith('ref:')) {
        expect(schema?.$ref).toBe(`#/components/schemas/${kind.slice(4)}`);
      } else if (kind.startsWith('array:')) {
        expect(schema?.type).toBe('array');
        expect(schema?.items?.$ref).toBe(`#/components/schemas/${kind.slice(6)}`);
      } else if (kind === 'strArray') {
        expect(schema?.type).toBe('array');
        expect(schema?.items).toMatchObject({ type: 'string' });
      } else if (kind === 'oneOf2') {
        expect(schema?.oneOf).toHaveLength(2);
        expect(schema.oneOf.map((r: any) => r.$ref)).toEqual([
          '#/components/schemas/PromoValidResponse',
          '#/components/schemas/PromoInvalidResponse',
        ]);
      }
    }
  });

  it('documents the error envelope on the routes that actually fail with it', () => {
    // Codes mirror the service/guard code paths (see DEVLOG session 28 notes).
    const ERRORS: Array<[string, string, number[]]> = [
      ['/auth/register', 'post', [400, 409, 429]],
      ['/auth/login', 'post', [400, 401, 429]],
      ['/auth/refresh', 'post', [400, 401, 429]],
      ['/auth/logout', 'post', [401]],
      ['/auth/me', 'get', [401]],
      ['/users/me', 'patch', [400, 401, 404]],
      ['/users/me/favorites', 'get', [401]],
      ['/users/me/favorites', 'post', [400, 401, 404]],
      ['/users/me/favorites/{menuItemId}', 'delete', [400, 401]],
      ['/users/me/addresses', 'get', [401]],
      ['/users/me/addresses', 'post', [400, 401]],
      ['/users/me/addresses/{id}', 'patch', [400, 401, 404]],
      ['/users/me/addresses/{id}', 'delete', [400, 401]],
      ['/users/me/addresses/{id}/default', 'post', [400, 401, 404]],
      ['/restaurants', 'post', [400, 401, 403]],
      ['/restaurants/mine', 'get', [401, 403]],
      ['/restaurants/{id}', 'get', [400, 404]],
      ['/restaurants/{id}', 'patch', [400, 401, 403, 404]],
      ['/restaurants/{restaurantId}/menu', 'get', [400]],
      ['/restaurants/{restaurantId}/menu', 'post', [400, 401, 403, 404]],
      ['/menu/items/{id}', 'patch', [400, 401, 403, 404]],
      ['/menu/items/{id}/availability', 'patch', [400, 401, 403, 404]],
      ['/menu/items/{id}', 'delete', [400, 401, 403, 404]],
      ['/orders', 'post', [400, 404, 429]],
      ['/orders/my', 'get', [401]],
      ['/orders/ops/cancel-stale', 'post', [400, 401, 403]],
      ['/orders/{id}', 'get', [400, 404]],
      ['/orders/{id}/cancel', 'post', [400, 401, 404, 429]],
      ['/orders/{id}/next-statuses', 'get', [400, 404]],
      ['/orders/{id}/status', 'patch', [400, 401, 403, 404]],
      ['/restaurants/{id}/orders', 'get', [400, 401, 403, 404]],
      ['/restaurants/{id}/orders/{orderId}/status', 'patch', [400, 401, 403, 404]],
      ['/restaurants/{id}/orders/stream', 'get', [400, 401, 403, 404]],
      ['/restaurants/{id}/reviews', 'get', [400, 404]],
      ['/reviews', 'post', [400, 401, 404, 409]],
      ['/reviews/my', 'get', [401]],
      ['/reviews/{id}', 'patch', [400, 401, 404]],
      ['/reviews/{id}', 'delete', [400, 401]],
      ['/promos/validate', 'post', [400]],
      ['/payments', 'post', [400, 401, 404, 409, 429, 502]],
      ['/payments/{id}/capture', 'post', [400, 401, 404, 409, 429]],
      ['/orders/{orderId}/payments', 'get', [400, 401, 404]],
    ];
    for (const [path, method, codes] of ERRORS) {
      const responses = doc.paths[P(path)]?.[method]?.responses ?? {};
      for (const code of codes) {
        const res = responses[String(code)];
        if (!res) throw new Error(`${method} ${path}: must document ${code}`);
        expect(res.content['application/json'].schema?.$ref).toBe(
          '#/components/schemas/ErrorResponse',
        );
      }
    }
    // And EVERY documented non-2xx anywhere uses the same envelope component.
    for (const item of Object.values(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!['get', 'post', 'patch', 'delete'].includes(method)) continue;
        for (const [code, res] of Object.entries((op as any).responses ?? {})) {
          if (Number(code) < 400) continue;
          expect((res as any).content['application/json'].schema.$ref).toMatch(/ErrorResponse$/);
        }
      }
    }
  });

  it('shapes the response component schemas honestly (cents, nullability, no leaks)', () => {
    const schemas = doc.components?.schemas ?? {};
    const props = (n: string) => (schemas[n] as any)?.properties ?? {};
    const required = (n: string) => (schemas[n] as any)?.required ?? [];
    // @nestjs/swagger 11 wraps nested-model properties in an allOf one-liner;
    // accept both shapes so the contract (which model) is what's asserted.
    const refOf = (prop: any): string => prop?.$ref ?? prop?.allOf?.[0]?.$ref;

    // Envelope: { error: { code, message, details } } — details nullable.
    expect(required('ErrorResponse')).toContain('error');
    expect(refOf(props('ErrorResponse').error)).toBe('#/components/schemas/ErrorBodyResponse');
    expect(required('ErrorBodyResponse').sort()).toEqual(['code', 'details', 'message']);
    expect(props('ErrorBodyResponse').details.nullable).toBe(true);

    // The safe user is the ALLOWLIST — a new sensitive column must never ride
    // along, so assert the exact field set.
    expect(Object.keys(props('SafeUserResponse')).sort()).toEqual(
      ['address', 'createdAt', 'email', 'id', 'name', 'phone', 'role', 'updatedAt'].sort(),
    );
    expect(props('SafeUserResponse').role.enum).toEqual(['customer', 'owner', 'admin']);

    // Session: token pair + nested safe user; money-free integer expiry.
    expect(refOf(props('SessionResponse').user)).toBe('#/components/schemas/SafeUserResponse');
    expect(props('SessionResponse').expires_in.type).toBe('integer');
    expect(props('SessionResponse').refresh_expires_at.format).toBe('date-time');

    // Money fields are integer cents across every model that carries them.
    for (const [name, field] of [
      ['OrderResponse', 'totalCents'],
      ['OrderResponse', 'subtotalCents'],
      ['OrderResponse', 'discountCents'],
      ['OrderResponse', 'deliveryFeeCents'],
      ['OrderItemResponse', 'unitPriceCents'],
      ['MenuItemResponse', 'priceCents'],
      ['RestaurantResponse', 'deliveryFeeCents'],
      ['RestaurantResponse', 'minOrderCents'],
      ['PromoValidResponse', 'discountCents'],
      ['PaymentResponse', 'amountCents'],
    ] as Array<[string, string]>) {
      if (props(name)[field]?.type !== 'integer') throw new Error(`${name}.${field} must be integer cents`);
    }
    // Display ratings are NOT money — float by design.
    expect(props('RestaurantResponse').rating.type).toBe('number');
    expect(props('ReviewRowResponse').rating).toMatchObject({ type: 'integer', minimum: 1, maximum: 5 });

    // Nullable timestamps/strings on the order snapshot.
    for (const f of ['promoCode', 'confirmedAt', 'cancelledAt']) {
      expect(props('OrderResponse')[f].nullable).toBe(true);
      expect(props('OrderResponse')[f].type).toBe('string');
    }
    expect(props('OrderResponse').items).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/OrderItemResponse' },
    });
    // restaurant is embedded only on SOME reads, so it must stay optional.
    expect(required('OrderResponse')).not.toContain('restaurant');
    expect(refOf(props('OrderResponse').restaurant)).toBe('#/components/schemas/RestaurantResponse');

    // Paging envelopes carry the full contract; inbox adds the counts map.
    expect(required('PaginatedOrdersResponse').sort()).toEqual(['items', 'limit', 'page', 'total']);
    expect(refOf(props('OwnerInboxResponse').counts)).toBe('#/components/schemas/OrderStatusCountsResponse');
    expect(Object.keys(props('OrderStatusCountsResponse')).sort()).toEqual(
      ['cancelled', 'completed', 'confirmed', 'delivering', 'pending', 'preparing'],
    );
    // enum + isArray emits an INLINE enum array (values, not a $ref — fine
    // as long as they match the shared OrderStatus component exactly):
    expect(props('NextStatusesResponse').next.type).toBe('array');
    expect([...props('NextStatusesResponse').next.items.enum].sort()).toEqual(
      [...(schemas['OrderStatus'] as any).enum].sort(),
    );

    // Stale-order sweep report: integer counters, ISO cutoff, boolean capped flag.
    expect(required('CancelStaleResponse').sort()).toEqual(
      ['capped', 'cutoff', 'cancelled', 'orders', 'scanned', 'staleMinutes'].sort(),
    );
    expect(props('CancelStaleResponse').staleMinutes.type).toBe('integer');
    expect(props('CancelStaleResponse').cutoff.format).toBe('date-time');
    expect(props('CancelStaleResponse').capped.type).toBe('boolean');
    expect(props('CancelStaleResponse').orders.type).toBe('array');

    // Address wrappers: list vs {item} vs {removed, promotedDefaultId?}.
    expect(refOf(props('AddressItemResponse').item)).toBe('#/components/schemas/DeliveryAddressResponse');
    expect(required('AddressRemoveResponse')).toEqual(['removed']);
    expect(props('AddressRemoveResponse').promotedDefaultId).toMatchObject({
      type: 'string',
      format: 'uuid',
    });
    expect(required('AddressRemoveResponse')).not.toContain('promotedDefaultId');

    // Review writes echo the recomputed aggregate; deletes make it optional.
    expect(refOf(props('ReviewWriteResponse').restaurant)).toBe('#/components/schemas/RestaurantRatingResponse');
    expect(refOf(props('ReviewRemoveResponse').restaurant)).toBe('#/components/schemas/RestaurantRatingResponse');
    expect(required('ReviewRemoveResponse')).toEqual(['removed']);
    expect(props('ReviewFeedResponse').rating.type).toBe('number');

    // Promo verdicts: valid vs reason enum, registered via oneOf.
    expect(props('PromoInvalidResponse').reason.enum.sort()).toEqual(
      ['below_min_subtotal', 'inactive', 'not_found', 'restaurant_mismatch'],
    );
    expect(props('PromoValidResponse').discountType.enum).toEqual(['percent', 'fixed']);

    // Favorite rows carry the live dish price and the hearting timestamp.
    expect(props('FavoriteDishResponse').priceCents.type).toBe('integer');
    expect(props('FavoriteDishResponse').favoritedAt.format).toBe('date-time');
    expect(refOf(props('FavoriteAddResponse').item)).toBe('#/components/schemas/FavoriteDishResponse');

    // RestaurantWithMenu = Restaurant + embedded menuItems.
    expect(props('RestaurantWithMenuResponse').menuItems).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/MenuItemResponse' },
    });
    expect(props('RestaurantResponse').ownerId).toMatchObject({ type: 'string', format: 'uuid', nullable: true });

    // Payment rows: terminal-ish lifecycle enum, nullable gateway fields,
    // and clientSecret NOT required (only the fresh-intent 201 carries it).
    expect(props('PaymentResponse').status.enum).toEqual(['pending', 'succeeded', 'failed']);
    expect(props('PaymentResponse').providerRef.nullable).toBe(true);
    expect(props('PaymentResponse').failureReason.nullable).toBe(true);
    expect(props('PaymentResponse').succeededAt.format).toBe('date-time');
    expect(required('PaymentResponse')).not.toContain('clientSecret');
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

