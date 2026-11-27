import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import { OrdersController } from './orders.controller';
import { RestaurantOrdersController } from './restaurant-orders.controller';
import { DriverOrdersController } from './driver-orders.controller';
import { Order, OrderStatus } from './order.entity';
import { OrderStatusAuditSource } from './order-status-audit.entity';
import { PaymentStatus } from '../payments/payment.entity';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/optional-jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { DriverOnlyGuard } from '../common/driver-only.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RATE_LIMIT_CONFIG } from '../common/rate-limit/rate-limit.config';
import { SlidingWindowLogStore } from '../common/rate-limit/rate-limit.store';
import { makeRng } from '../common/fuzz/fuzz-harness';

/**
 * Status-write constant-outcome sweep (Phase 17 #1): session 143's
 * write-side doctrine applied to the FOUR status-transition routes —
 *   PATCH /api/restaurants/:id/orders/:orderId/status  (owner portal)
 *   PATCH /api/orders/:id/status                       (admin backdoor)
 *   POST  /api/orders/:id/cancel                       (customer cancel)
 *   PATCH /api/driver/orders/:id/status                (driver advance)
 * Real controllers + the REAL OrdersService (status machine, payment-
 * confirm gate ON by default, audit writer, restock CAS) + the production
 * ValidationPipe set + ErrorFormatFilter over live HTTP. The write layer is
 * faked faithfully enough to make "denied request wrote NOTHING" executable:
 *   - repo.findOne returns a deep copy; NOTHING mutates state except
 *     repo.save and the restock transaction's raw-SQL emitters;
 *   - the restock fake speaks the real SQL (marker CAS + per-dish adds,
 *     `[rows, rowCount]` tuples, session-71 truth) and only flips rows the
 *     real WHERE would flip (`stockRestockedAt IS NULL AND status =
 *     'cancelled'`), so a double-cancel can restock at most once;
 *   - every denial is snapshotted byte-for-byte around the request.
 *
 * Canonical outcome sets (the roadmap sketch listed {200,400,402,404,409};
 * the swept truth is richer per route and NEVER includes 409 — the status
 * family has no conflict rung, and 429 is inert because the harness boots
 * with empty limiter rules):
 *   owner  {200,400,401,402,403,404}   admin {200,400,401,402,403,404}
 *   cancel {201,400,401,404}           driver {200,400,401,403,404}
 * (cancel answers 201 — Nest POST default; the driver path has no 402 rung
 * because no driver edge targets confirmed; the gate probe must NEVER be
 * called there — pinned with call counts.)
 *
 * Every denial: single `{ error: { code, message, details } }` envelope,
 * code in {BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, NOT_FOUND,
 * PAYMENT_REQUIRED}, and a zero write-delta across orders/audits/stock/
 * events. Every acceptance: exactly ONE audit row with the route-correct
 * source + actor snapshot, exactly ONE newly stamped status timestamp,
 * write-once timestamps unchanged, driverId untouched, and the restock
 * ledger moved only when the snapshot + marker CAS say so. The seeded
 * 320-case mutation sweep ends with a full AUDIT-CHAIN REPLAY: every row's
 * final status + timestamp set must re-derive from its appended audits.
 */

const JWT_TEST = 'status-write-sweep-http-spec';

// --- fixtures ------------------------------------------------------------

const REST_MINE = '5e500001-0000-4000-8000-000000000001'; // ownerId OWNER_ID
const REST_OTHER = '5e500002-0000-4000-8000-000000000002'; // ownerId OTHER_OWNER
const REST_UNKNOWN = '5e500003-0000-4000-8000-000000000003';

const DISH_A2 = 'd15c0002-0000-4000-8000-0000000000a2'; // stock-managed 3

const OWNER_ID = '0a0e0001-0000-4000-8000-000000000001';
const OTHER_OWNER = '0a0e0002-0000-4000-8000-000000000002';
const USER_ID = 'c0570001-0000-4000-8000-000000000001';
const OTHER_ID = 'c0570002-0000-4000-8000-000000000002';
const ADMIN_ID = 'ad410001-0000-4000-8000-000000000001';
const DRIVER_ID = 'd12e0001-0000-4000-8000-000000000001';
const DRIVER2_ID = 'd12e0002-0000-4000-8000-000000000002';

const O_PEND = '0e000001-0000-4000-8000-000000000001'; // pending, snapshot A2 x2
const O_PAID = '0e000002-0000-4000-8000-000000000002'; // pending + succeeded payment
const O_FAIL = '0e000003-0000-4000-8000-000000000003'; // pending + failed payment
const O_REFUND = '0e000004-0000-4000-8000-000000000004'; // pending + refunded payment
const O_PENDPAY = '0e000005-0000-4000-8000-000000000005'; // pending + pending payment
const O_CONF = '0e000006-0000-4000-8000-000000000006'; // confirmed
const O_PREP = '0e000007-0000-4000-8000-000000000007'; // preparing, DRIVER_ID, snapshot A2 x2
const O_PREPU = '0e000008-0000-4000-8000-000000000008'; // preparing, unassigned
const O_DELIV = '0e000009-0000-4000-8000-000000000009'; // delivering, DRIVER_ID
const O_DONE = '0e00000a-0000-4000-8000-00000000000a'; // completed (terminal)
const O_CANCEL = '0e00000b-0000-4000-8000-00000000000b'; // cancelled (terminal)
const O_GUEST = '0e00000c-0000-4000-8000-00000000000c'; // pending, userId null
const O_FOREIGN = '0e00000d-0000-4000-8000-00000000000d'; // pending under REST_OTHER

const UNKNOWN_ORDER = '0e00dead-0000-4000-8000-00000000dead';

const SEED_TS = '2026-01-01T00:00:00.000Z';

const TS_FIELDS: Array<[OrderStatus, string]> = [
  [OrderStatus.CONFIRMED, 'confirmedAt'],
  [OrderStatus.PREPARING, 'preparingAt'],
  [OrderStatus.DELIVERING, 'deliveringAt'],
  [OrderStatus.COMPLETED, 'completedAt'],
  [OrderStatus.CANCELLED, 'cancelledAt'],
];
const TS_FIELD = new Map<OrderStatus, string>(TS_FIELDS);

/** STATUS_FLOW as the service defines it — the replay oracle's edge table. */
const FLOW: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'] as unknown as OrderStatus[],
  confirmed: ['preparing', 'cancelled'] as unknown as OrderStatus[],
  preparing: ['delivering', 'cancelled'] as unknown as OrderStatus[],
  delivering: ['completed'] as OrderStatus[],
  completed: [],
  cancelled: [],
};

interface Identity {
  sub: string;
  role: UserRole;
  email: string;
}

const IDS: Record<string, Identity> = {
  owner: { sub: OWNER_ID, role: UserRole.OWNER, email: 'owner@fo.test' },
  otherOwner: { sub: OTHER_OWNER, role: UserRole.OWNER, email: 'other@fo.test' },
  customer: { sub: USER_ID, role: UserRole.CUSTOMER, email: 'ada@fo.test' },
  other: { sub: OTHER_ID, role: UserRole.CUSTOMER, email: 'bee@fo.test' },
  admin: { sub: ADMIN_ID, role: UserRole.ADMIN, email: 'admin@fo.test' },
  driver: { sub: DRIVER_ID, role: UserRole.DRIVER, email: 'dee@fo.test' },
  driver2: { sub: DRIVER2_ID, role: UserRole.DRIVER, email: 'd2@fo.test' },
};

function order(
  id: string,
  code: string,
  status: OrderStatus,
  opts: Partial<Record<string, unknown>> = {},
): any {
  return {
    id,
    code,
    restaurantId: REST_MINE,
    userId: USER_ID,
    driverId: null,
    status,
    confirmedAt: null,
    preparingAt: null,
    deliveringAt: null,
    completedAt: null,
    cancelledAt: null,
    stockDecrements: null,
    stockRestockedAt: null,
    ...opts,
  };
}

const SEED_ORDERS: any[] = [
  order(O_PEND, 'FO-PEND1', OrderStatus.PENDING, {
    stockDecrements: [{ menuItemId: DISH_A2, quantity: 2 }],
  }),
  order(O_PAID, 'FO-PAID2', OrderStatus.PENDING),
  order(O_FAIL, 'FO-FAIL3', OrderStatus.PENDING),
  order(O_REFUND, 'FO-RFD4', OrderStatus.PENDING),
  order(O_PENDPAY, 'FO-PNDP5', OrderStatus.PENDING),
  order(O_CONF, 'FO-CONF6', OrderStatus.CONFIRMED, { confirmedAt: SEED_TS }),
  order(O_PREP, 'FO-PREP7', OrderStatus.PREPARING, {
    driverId: DRIVER_ID,
    confirmedAt: SEED_TS,
    preparingAt: SEED_TS,
    stockDecrements: [{ menuItemId: DISH_A2, quantity: 2 }],
  }),
  order(O_PREPU, 'FO-PREPU8', OrderStatus.PREPARING, {
    confirmedAt: SEED_TS,
    preparingAt: SEED_TS,
  }),
  order(O_DELIV, 'FO-DELIV9', OrderStatus.DELIVERING, {
    driverId: DRIVER_ID,
    confirmedAt: SEED_TS,
    preparingAt: SEED_TS,
    deliveringAt: SEED_TS,
  }),
  order(O_DONE, 'FO-DONE10', OrderStatus.COMPLETED, {
    confirmedAt: SEED_TS,
    preparingAt: SEED_TS,
    deliveringAt: SEED_TS,
    completedAt: SEED_TS,
  }),
  order(O_CANCEL, 'FO-CANC11', OrderStatus.CANCELLED, { cancelledAt: SEED_TS }),
  order(O_GUEST, 'FO-GUEST12', OrderStatus.PENDING, { userId: null }),
  order(O_FOREIGN, 'FO-FORGN13', OrderStatus.PENDING, { restaurantId: REST_OTHER }),
];

const SEED_PAYMENTS: Array<[string, PaymentStatus[]]> = [
  [O_PAID, [PaymentStatus.SUCCEEDED]],
  [O_FAIL, [PaymentStatus.FAILED]],
  [O_REFUND, [PaymentStatus.REFUNDED]],
  [O_PENDPAY, [PaymentStatus.PENDING]],
];

const clone = (x: unknown) => JSON.parse(JSON.stringify(x ?? null));

// --- harness ---------------------------------------------------------------

type Route = 'owner' | 'admin' | 'cancel' | 'driver';

const ROUTE_SETS: Record<Route, Set<number>> = {
  owner: new Set([200, 400, 401, 402, 403, 404]),
  admin: new Set([200, 400, 401, 402, 403, 404]),
  cancel: new Set([201, 400, 401, 404]),
  driver: new Set([200, 400, 401, 403, 404]),
};
const DENIAL_CODES = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'PAYMENT_REQUIRED',
]);

function buildHarness(opts: { confirmFlag?: string | undefined } = {}) {
  const state = {
    orders: new Map<string, any>(),
    audits: [] as any[],
    stock: new Map<string, number | null>([[DISH_A2, 3]]),
    payments: new Map<string, string[]>(),
  };
  for (const s of SEED_ORDERS) state.orders.set(s.id, clone(s));
  for (const [oid, list] of SEED_PAYMENTS) state.payments.set(oid, [...list]);

  const counts = { findOne: 0, exist: 0, scope: 0, save: 0, tx: 0 };

  // Restock transaction: the SAME raw SQL shapes as stock-restock.ts, with
  // the real WHERE semantics. Journal-undo on throw mirrors the rollback.
  const transaction = jest.fn(async (cb: any) => {
    counts.tx++;
    const undo: Array<() => void> = [];
    const em = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (/UPDATE "orders" SET "stockRestockedAt"/.test(sql)) {
          const [id, now] = params as [string, unknown];
          const row = state.orders.get(id);
          // Real WHERE: id = $1 AND "stockRestockedAt" IS NULL AND status cancelled.
          if (!row || row.stockRestockedAt != null || row.status !== 'cancelled') {
            return [[], 0];
          }
          row.stockRestockedAt = new Date(now as string | number | Date).toISOString();
          undo.push(() => {
            row.stockRestockedAt = null;
          });
          return [{ id: row.id }, 1];
        }
        if (/UPDATE "menu_items" SET "stock"/.test(sql)) {
          const [dishId, qty] = params as [string, number];
          const cur = state.stock.get(dishId);
          if (typeof cur !== 'number') return [[], 0]; // cleared to unlimited: honest no-op
          state.stock.set(dishId, cur + qty);
          undo.push(() => {
            state.stock.set(dishId, cur);
          });
          return [{ stock: cur + qty }, 1];
        }
        throw new Error(`unexpected SQL reached the status sweep harness: ${sql.slice(0, 60)}`);
      }),
    };
    let committed = false;
    try {
      const out = await cb(em);
      committed = true;
      return out;
    } finally {
      if (!committed) for (const fn of undo.reverse()) fn();
    }
  });

  const ordersRepo = {
    create: (x: any) => x,
    findOne: jest.fn(async (q: any) => {
      counts.findOne++;
      const w = q?.where ?? {};
      const row = state.orders.get(w.id);
      if (!row) return null;
      if ('driverId' in w && row.driverId !== w.driverId) return null; // driver compound scope
      return clone(row);
    }),
    save: jest.fn(async (entity: any) => {
      counts.save++;
      if (!state.orders.has(entity.id)) {
        throw new Error('status sweep save() targeted an unknown row (create paths run a different fake)');
      }
      const next = clone(entity);
      state.orders.set(entity.id, next);
      return clone(next);
    }),
    manager: { transaction },
  } as unknown as Repository<Order> & { manager: { transaction: jest.Mock } };

  const restaurants = {
    findOrderScope: jest.fn(async (id: string) => {
      counts.scope++;
      if (id === REST_MINE) return { id, ownerId: OWNER_ID };
      if (id === REST_OTHER) return { id, ownerId: OTHER_OWNER };
      return null;
    }),
  } as any;

  const payments = {
    exist: jest.fn(async (q: any) => {
      counts.exist++;
      const list = state.payments.get(q?.where?.orderId) ?? [];
      return list.includes(q?.where?.status);
    }),
  } as any;

  const statusAudits = {
    create: (x: any) => ({ ...x }),
    save: jest.fn(async (x: any) => {
      state.audits.push(clone(x));
      return x;
    }),
  } as any;

  const config = {
    get: (key: string) =>
      key === 'ORDER_CONFIRM_REQUIRES_PAYMENT' ? opts.confirmFlag : undefined,
  } as any;

  const events = { publish: jest.fn() } as unknown as OrderEventsService;

  // Unused collaborators for the swept paths — loud on accidental use.
  const unused = (name: string) =>
    new Proxy({} as any, {
      get: (_t, prop) => () => {
        throw new Error(`${name}.${String(prop)} must not be reached by status routes`);
      },
    });

  const service = new OrdersService(
    ordersRepo,
    unused('menu'),
    restaurants,
    events,
    unused('promos'),
    unused('addresses'),
    payments,
    config,
    unused('users'),
    statusAudits,
    undefined,
  );

  return { service, state, counts, events, ordersRepo, restaurants, payments, transaction };
}

type Harness = ReturnType<typeof buildHarness>;

function snap(h: Harness): string {
  return JSON.stringify({
    orders: [...h.state.orders.entries()],
    audits: h.state.audits,
    stock: [...h.state.stock.entries()].sort(),
    publishes: (h.events as any).publish.mock.calls.length,
  });
}

async function boot(h: Harness) {
  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: JWT_TEST })],
    controllers: [OrdersController, RestaurantOrdersController, DriverOrdersController],
    providers: [
      JwtAuthGuard,
      OptionalJwtAuthGuard,
      RolesGuard,
      DriverOnlyGuard,
      RateLimitGuard,
      Reflector,
      { provide: OrdersService, useValue: h.service },
      { provide: OrderEventsService, useValue: h.events },
      { provide: SlidingWindowLogStore, useValue: {} },
      { provide: RATE_LIMIT_CONFIG, useValue: { rules: {} } },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  await app.listen(0);

  const jwt = app.get(JwtService);
  const sign = async (id: Identity, typ = TOKEN_TYPE_ACCESS) =>
    jwt.signAsync({ sub: id.sub, role: id.role, email: id.email, typ });

  const tokens: Record<string, string> = {
    owner: await sign(IDS.owner),
    otherOwner: await sign(IDS.otherOwner),
    customer: await sign(IDS.customer),
    other: await sign(IDS.other),
    admin: await sign(IDS.admin),
    driver: await sign(IDS.driver),
    driver2: await sign(IDS.driver2),
    refresh: await sign(IDS.customer, 'refresh' as never),
    garbage: 'not.a.jwt',
  };
  return { app, tokens };
}

function request(
  app: INestApplication,
  method: 'PATCH' | 'POST',
  path: string,
  opts: { token?: string; body?: unknown; raw?: string } = {},
): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const payload = opts.raw ?? (opts.body === undefined ? '' : JSON.stringify(opts.body));
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json: any;
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode!, json, raw });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function pathFor(route: Route, o: { restId?: string; orderId: string; query?: string | null }): string {
  const q = o.query ? `?${o.query}` : '';
  switch (route) {
    case 'owner':
      return `/api/restaurants/${o.restId ?? REST_MINE}/orders/${o.orderId}/status${q}`;
    case 'admin':
      return `/api/orders/${o.orderId}/status${q}`;
    case 'cancel':
      return `/api/orders/${o.orderId}/cancel`;
    case 'driver':
      return `/api/driver/orders/${o.orderId}/status${q}`;
  }
}

function expectedSource(route: Route, actor: Identity | null | undefined): OrderStatusAuditSource {
  if (route === 'cancel') return OrderStatusAuditSource.CUSTOMER;
  if (route === 'driver') return OrderStatusAuditSource.DRIVER;
  if (route === 'admin') return OrderStatusAuditSource.ADMIN;
  // owner portal route: an ADMIN caller passes RolesGuard and the service
  // stamps the audit ADMIN (the bypass is recorded honestly).
  return actor?.role === UserRole.ADMIN
    ? OrderStatusAuditSource.ADMIN
    : OrderStatusAuditSource.OWNER;
}

/**
 * THE doctrine gate. Every response lands in the route's canonical set;
 * every denial is a single-envelope error AND a byte-identical state; every
 * acceptance moves exactly the fields the order machine is allowed to move.
 */
async function sweep(
  h: Harness,
  app: INestApplication,
  route: Route,
  c: {
    orderId: string;
    restId?: string;
    query?: string | null;
    token?: string;
    actor?: Identity | null;
    body?: unknown;
    raw?: string;
    label: string;
  },
): Promise<{ status: number; json: any; raw: string }> {
  const preRow = h.state.orders.get(c.orderId) ?? null;
  const preStock = new Map(h.state.stock);
  const before = snap(h);
  const auditBefore = h.state.audits.length;
  const res = await request(app, route === 'cancel' ? 'POST' : 'PATCH', pathFor(route, c), {
    ...(c.token ? { token: c.token } : {}),
    ...(c.body !== undefined ? { body: c.body } : {}),
    ...(c.raw !== undefined ? { raw: c.raw } : {}),
  });
  const after = snap(h);
  const ctx = `${c.label} ${route} ${res.status} ${res.raw.slice(0, 220)}`;

  if (!ROUTE_SETS[route].has(res.status)) {
    throw new Error(`NON-CANONICAL outcome — ${ctx}`);
  }

  if (res.status >= 400) {
    expect(Object.keys(res.json ?? {})).toEqual(['error']);
    expect(Object.keys(res.json.error).sort()).toEqual(['code', 'details', 'message']);
    if (!DENIAL_CODES.has(res.json.error.code)) {
      throw new Error(`NON-CANONICAL code — ${ctx}`);
    }
    if (after !== before) {
      throw new Error(`DENIAL WROTE SOMETHING — ${ctx}`);
    }
    return res;
  }

  // --- acceptance ledger ---
  expect(res.json.error).toBeUndefined();
  const target = res.json.status as OrderStatus;
  expect(typeof target).toBe('string');

  // exactly one new audit row, fully pinned against the request
  expect(h.state.audits.length).toBe(auditBefore + 1);
  const audit = h.state.audits.at(-1);
  expect(audit.orderId).toBe(c.orderId);
  expect(audit.fromStatus).toBe(preRow?.status ?? null);
  expect(audit.toStatus).toBe(target);
  expect(audit.source).toBe(expectedSource(route, c.actor));
  expect(audit.actorUserId).toBe(c.actor?.sub ?? null);
  expect(audit.actorRole).toBe(c.actor?.role ?? null);
  expect(audit.actorEmail).toBe(c.actor?.email ?? null);

  const row = h.state.orders.get(c.orderId);
  expect(row.status).toBe(target);
  expect(row.driverId).toBe(preRow?.driverId ?? null); // status routes never touch the courier

  // exactly ONE timestamp flipped null -> set, and it is the target's field;
  // every previously set timestamp is byte-identical (write-once).
  const flips: string[] = [];
  for (const [, field] of TS_FIELDS) {
    if (row[field] === preRow?.[field]) continue;
    expect(preRow?.[field]).toBeNull();
    expect(typeof row[field]).toBe('string');
    flips.push(field);
  }
  const stampField = TS_FIELD.get(target);
  expect(flips.length).toBe(stampField ? 1 : 0);
  if (stampField) expect(flips[0]).toBe(stampField);

  // restock: marker flips iff the order carries a non-empty snapshot and the
  // target is cancelled; the stock counters follow the flip exactly.
  const snapshot: Array<{ menuItemId: string; quantity: number }> = preRow?.stockDecrements ?? [];
  const unitsByDish = new Map<string, number>();
  for (const e of snapshot) {
    unitsByDish.set(e.menuItemId, (unitsByDish.get(e.menuItemId) ?? 0) + e.quantity);
  }
  const shouldRestock = target === OrderStatus.CANCELLED && unitsByDish.size > 0 && preRow?.stockRestockedAt == null;
  if (shouldRestock) {
    expect(row.stockRestockedAt).not.toBeNull();
    for (const [dish, units] of unitsByDish) {
      const cur = preStock.get(dish);
      expect(h.state.stock.get(dish)).toBe(typeof cur === 'number' ? cur + units : cur);
    }
  } else {
    expect(row.stockRestockedAt).toBe(preRow?.stockRestockedAt ?? null);
    for (const [dish, cur] of preStock) expect(h.state.stock.get(dish)).toBe(cur);
  }

  // one live-feed publish per acceptance, none spurious
  expect((h.events as any).publish.mock.calls.length).toBe(h.state.audits.length);
  return res;
}

// --- suites ------------------------------------------------------------------

describe('owner PATCH /restaurants/:id/orders/:orderId/status sweep', () => {
  let h: Harness;
  let app: INestApplication;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    h = buildHarness();
    const booted = await boot(h);
    app = booted.app;
    tokens = booted.tokens;
  });
  afterEach(async () => {
    await app.close();
  });

  const hit = (
    orderId: string,
    status: string | null,
    opts: { token?: string; actor?: Identity; restId?: string; query?: string; label?: string } = {},
  ) =>
    sweep(h, app, 'owner', {
      orderId,
      restId: opts.restId,
      query: status === null ? undefined : `status=${status}`,
      token: opts.token ?? tokens.owner,
      actor: opts.actor ?? IDS.owner,
      label: opts.label ?? `owner ${orderId} -> ${status}`,
    });

  it('legal chain on a PAID order: accept, prepare, deliver, complete — one audit + one timestamp each', async () => {
    for (const s of ['confirmed', 'preparing', 'delivering', 'completed'] as const) {
      const res = await hit(O_PAID, s, { label: `chain-${s}` });
      expect(res.status).toBe(200);
    }
    expect(h.state.audits).toHaveLength(4);
    expect(h.state.orders.get(O_PAID).completedAt).not.toBeNull();
  });

  it('confirm gate ON: pending order without a succeeded payment answers 402 PAYMENT_REQUIRED, zero writes', async () => {
    const res = await hit(O_PEND, 'confirmed', { label: 'gate-unpaid' });
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe('PAYMENT_REQUIRED');
    expect(res.json.error.details).toEqual({ orderId: O_PEND, flag: 'ORDER_CONFIRM_REQUIRES_PAYMENT' });
    expect(res.json.error.message).toContain('FO-PEND1');
    // non-succeeded payment rows never satisfy the gate (refunds included)
    for (const oid of [O_FAIL, O_REFUND, O_PENDPAY]) {
      const r = await hit(oid, 'confirmed', { label: `gate-${oid}` });
      expect(r.status).toBe(402);
    }
    const paid = await hit(O_PAID, 'confirmed', { label: 'gate-paid' });
    expect(paid.status).toBe(200);
  });

  it('illegal edges and terminal orders answer 400 with NOTHING half-written', async () => {
    for (const [oid, s] of [
      [O_PEND, 'preparing'],
      [O_PEND, 'delivering'],
      [O_PEND, 'completed'],
      [O_DELIV, 'confirmed'], // illegal transition beats the gate: no 402
      [O_DONE, 'pending'],
      [O_CANCEL, 'pending'],
      [O_CONF, 'confirmed'], // self-move is not an edge
    ] as const) {
      const res = await hit(oid, s, { label: `illegal-${oid}-${s}` });
      expect(res.status).toBe(400);
      expect(res.json.error.message).toContain('Cannot move order from');
    }
    // the illegal delivering->confirmed must not have probed the gate either
    expect(h.counts.save).toBe(0);
  });

  it('owner cancels a preparing order: units return EXACTLY once (snapshot CAS), marker flips', async () => {
    const res = await hit(O_PREP, 'cancelled', { label: 'owner-cancel-restock' });
    expect(res.status).toBe(200);
    const row = h.state.orders.get(O_PREP);
    expect(row.stockRestockedAt).not.toBeNull();
    expect(h.state.stock.get(DISH_A2)).toBe(5); // 3 + snapshot(2)
    // write-once: the seeded confirmedAt/preparingAt survive untouched
    expect(row.confirmedAt).toBe(SEED_TS);
    expect(row.preparingAt).toBe(SEED_TS);
    // a second cancel (any path) is a flow denial and cannot move the counter
    const again = await hit(O_PREP, 'cancelled', { label: 'double-cancel' });
    expect(again.status).toBe(400);
    expect(h.state.stock.get(DISH_A2)).toBe(5);
  });

  it('restaurant scoping: unknown -> 404, foreign -> 403 (order never loaded); foreign ORDER under my restaurant -> 404', async () => {
    const unknown = await hit(O_PEND, 'confirmed', { restId: REST_UNKNOWN, label: 'unknown-restaurant' });
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.message).toBe('Restaurant not found');

    const foreign = await hit(O_PEND, 'confirmed', { restId: REST_OTHER, label: 'foreign-restaurant' });
    expect(foreign.status).toBe(403);
    expect(foreign.json.error.message).toBe('You do not own this restaurant');
    expect(h.counts.findOne).toBe(0); // neither arm ever reached the order read

    // order exists but lives under another restaurant: 404 (no existence leak)
    const scoped = await hit(O_FOREIGN, 'cancelled', { label: 'foreign-order' });
    expect(scoped.status).toBe(404);
    expect(scoped.json.error.message).toBe('Order not found');
  });

  it('path/query shapes: malformed uuids 400 (pipe), junk/upper/missing enum 400, unknown order 404', async () => {
    const badOrder = await sweep(h, app, 'owner', { orderId: 'nope', query: 'status=confirmed', token: tokens.owner, actor: IDS.owner, label: 'malformed-order' });
    expect(badOrder.status).toBe(400);
    const badRest = await sweep(h, app, 'owner', { orderId: O_PEND, restId: 'zzz', query: 'status=confirmed', token: tokens.owner, actor: IDS.owner, label: 'malformed-restaurant' });
    expect(badRest.status).toBe(400);

    for (const [label, q] of [
      ['junk-status', 'status=nope'],
      ['upper-status', 'status=CONFIRMED'], // IsEnum is case-sensitive on this route
      ['empty-status', 'status='],
      ['missing-status', ''],
      ['array-status', 'status[]=confirmed'],
      ['dup-status', 'status=pending&status=confirmed'],
      ['space-status', 'status=%20confirmed'],
    ] as const) {
      const res = await sweep(h, app, 'owner', { orderId: O_PEND, query: q || undefined, token: tokens.owner, actor: IDS.owner, label });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('BAD_REQUEST');
    }
    expect(h.counts.findOne).toBe(0); // not one of them touched the DB
    const unknown = await hit(UNKNOWN_ORDER, 'cancelled', { label: 'unknown-order' });
    expect(unknown.status).toBe(404);
  });

  it('auth rung: no token, garbage token, and a refresh-typ token all answer 401 before anything else', async () => {
    for (const [label, token] of [
      ['missing', undefined],
      ['garbage', tokens.garbage],
      ['refresh-typ', tokens.refresh],
    ] as const) {
      const res = await sweep(h, app, 'owner', {
        orderId: 'nope',
        query: 'status=nope',
        ...(token ? { token } : {}),
        label,
      });
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe('UNAUTHORIZED');
    }
    expect(h.counts.findOne + h.counts.scope).toBe(0);
  });

  it('role rung: customer and driver tokens 403 on the owner route without reaching the service', async () => {
    for (const [name, token, actor] of [
      ['customer', tokens.customer, IDS.customer],
      ['driver', tokens.driver, IDS.driver],
    ] as const) {
      const res = await sweep(h, app, 'owner', { orderId: O_PEND, query: 'status=confirmed', token, actor, label: `role-${name}` });
      expect(res.status).toBe(403);
      expect(res.json.error.message).toBe('Insufficient role');
    }
    expect(h.counts.scope).toBe(0);
    expect(h.counts.findOne).toBe(0);
  });

  it('ADMIN passes the owner route on ANY restaurant and the audit records source=admin (honest bypass)', async () => {
    const res = await hit(O_FOREIGN, 'cancelled', { token: tokens.admin, actor: IDS.admin, label: 'admin-bypass' });
    // O_FOREIGN lives under REST_OTHER (owned by otherOwner) — admin bypasses
    // the restaurant gate, the order matches the PATH restaurant? NO: the
    // path is REST_MINE, the order lives under REST_OTHER -> 404 scope rung.
    // The bypass must be exercised against the foreign restaurant path:
    expect(res.status).toBe(404);

    const via = await sweep(h, app, 'owner', {
      orderId: O_FOREIGN,
      restId: REST_OTHER,
      query: 'status=cancelled',
      token: tokens.admin,
      actor: IDS.admin,
      label: 'admin-via-foreign-path',
    });
    expect(via.status).toBe(200);
    expect(h.state.audits.at(-1).source).toBe(OrderStatusAuditSource.ADMIN);
  });
});

describe('admin PATCH /orders/:id/status sweep', () => {
  let h: Harness;
  let app: INestApplication;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    h = buildHarness();
    const booted = await boot(h);
    app = booted.app;
    tokens = booted.tokens;
  });
  afterEach(async () => {
    await app.close();
  });

  const hit = (orderId: string, query?: string, opts: { token?: string; actor?: Identity; label?: string } = {}) =>
    sweep(h, app, 'admin', {
      orderId,
      query,
      token: opts.token ?? tokens.admin,
      actor: opts.actor ?? IDS.admin,
      label: opts.label ?? `admin ${orderId} ${query ?? '-'}`,
    });

  it('scope-free ops backdoor: any restaurant is reachable; audit source is admin', async () => {
    const foreign = await hit(O_FOREIGN, 'status=cancelled');
    expect(foreign.status).toBe(200);
    expect(h.state.audits.at(-1).source).toBe(OrderStatusAuditSource.ADMIN);
    const restocked = await hit(O_PEND, 'status=cancelled'); // snapshot order
    expect(restocked.status).toBe(200);
    expect(h.state.stock.get(DISH_A2)).toBe(5);
  });

  it('confirm gate rides the backdoor too: unpaid confirm 402, paid confirm 200', async () => {
    expect((await hit(O_PREP, 'status=confirmed')).status).toBe(400); // flow first
    expect((await hit(O_PENDPAY, 'status=confirmed')).status).toBe(402);
    expect((await hit(O_FAIL, 'status=confirmed')).status).toBe(402);
    expect((await hit(O_REFUND, 'status=confirmed')).status).toBe(402);
    expect((await hit(O_PAID, 'status=confirmed')).status).toBe(200);
  });

  it('NO enum DTO on this route: junk / uppercase / array / missing statuses are SERVICE-level 400s with the transition message', async () => {
    // Divergence from the owner route (pipe-level enum 400) pinned as wire
    // truth: same canonical class, different message origin.
    for (const [label, q] of [
      ['junk', 'status=nope'],
      ['upper', 'status=CONFIRMED'],
      ['empty', 'status='],
      ['missing', undefined],
      ['array', 'status[]=confirmed'],
      ['dup', 'status=pending&status=confirmed'],
    ] as const) {
      const res = await hit(O_PEND, q, { label });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('BAD_REQUEST');
      expect(res.json.error.message).toMatch(/^Cannot move order from pending to /);
    }
    // the DB read DID happen on this route (no pipe rung to stop it)
    expect(h.counts.findOne).toBeGreaterThan(0);
    expect(h.counts.save).toBe(0);
  });

  it('unknown -> 404, malformed uuid -> 400 (with valid bearer), non-admin roles -> 403', async () => {
    expect((await hit(UNKNOWN_ORDER, 'status=cancelled')).status).toBe(404);
    expect((await hit('nope', 'status=cancelled')).status).toBe(400);
    const asOwner = await hit(O_PEND, 'status=cancelled', { token: tokens.owner, actor: IDS.owner, label: 'owner-token' });
    expect(asOwner.status).toBe(403);
    const asCust = await hit(O_PEND, 'status=cancelled', { token: tokens.customer, actor: IDS.customer, label: 'customer-token' });
    expect(asCust.status).toBe(403);
    expect(h.counts.save).toBe(0);
  });
});

describe('customer POST /orders/:id/cancel sweep', () => {
  let h: Harness;
  let app: INestApplication;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    h = buildHarness();
    const booted = await boot(h);
    app = booted.app;
    tokens = booted.tokens;
  });
  afterEach(async () => {
    await app.close();
  });

  const hit = (orderId: string, opts: { token?: string; actor?: Identity; body?: unknown; raw?: string; label?: string } = {}) =>
    sweep(h, app, 'cancel', {
      orderId,
      token: opts.token ?? tokens.customer,
      actor: opts.actor ?? IDS.customer,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.raw !== undefined ? { raw: opts.raw } : {}),
      label: opts.label ?? `cancel ${orderId}`,
    });

  it('owner cancels confirmed / pending orders: 201 + customer-source audit; snapshot orders restock once', async () => {
    const conf = await hit(O_CONF, { label: 'cancel-confirmed' });
    expect(conf.status).toBe(201);
    expect(conf.json.status).toBe('cancelled');
    expect(h.state.audits.at(-1)).toMatchObject({
      source: OrderStatusAuditSource.CUSTOMER,
      fromStatus: OrderStatus.CONFIRMED,
      actorEmail: 'ada@fo.test',
    });
    const pend = await hit(O_PEND, { label: 'cancel-pending-restock' });
    expect(pend.status).toBe(201);
    expect(h.state.stock.get(DISH_A2)).toBe(5);
    expect(h.state.orders.get(O_PEND).stockRestockedAt).not.toBeNull();
  });

  it('out-for-delivery / terminal orders can no longer self-cancel: 400, timestamps untouched', async () => {
    for (const oid of [O_DELIV, O_DONE, O_CANCEL]) {
      const res = await hit(oid, { label: `cancel-late-${oid}` });
      expect(res.status).toBe(400);
      expect(res.json.error.message).toContain('can no longer be cancelled');
    }
    expect(h.counts.save).toBe(0);
    expect(h.state.audits).toHaveLength(0);
  });

  it('ownership: foreign, guest, and unknown ids answer the IDENTICAL 404 (no existence leak)', async () => {
    const foreign = await hit(O_FOREIGN, { token: tokens.other, actor: IDS.other, label: 'other-user-order' });
    // O_FOREIGN belongs to USER_ID — caller OTHER gets the plain 404.
    expect(foreign.status).toBe(404);
    const guest = await hit(O_GUEST, { label: 'guest-order' });
    expect(guest.status).toBe(404);
    const unknown = await hit(UNKNOWN_ORDER, { label: 'unknown' });
    expect(unknown.status).toBe(404);
    const malformed = await hit('nope', { label: 'malformed' });
    expect(malformed.status).toBe(400); // pipe rung, distinct class by design
    // unknown / foreign / guest all answer the byte-identical envelope
    expect(foreign.json).toEqual(guest.json);
    expect(foreign.json).toEqual(unknown.json);
    expect(h.counts.save).toBe(0);
  });

  it('no ADMIN bypass on self-service cancel: an admin cancelling another user order 404s', async () => {
    const res = await hit(O_FOREIGN, { token: tokens.admin, actor: IDS.admin, label: 'admin-cancel-other' });
    expect(res.status).toBe(404);
  });

  it('the route has NO DTO: smuggled body keys cannot retarget the status; body is inert', async () => {
    const res = await hit(O_CONF, { body: { status: 'completed', userId: OTHER_ID }, label: 'smuggle' });
    expect(res.status).toBe(201);
    expect(res.json.status).toBe('cancelled'); // CANCELLED is hardcoded in the service
    expect(res.json.userId).toBe(USER_ID); // body identity injection dies
  });

  it('missing/garbage/refresh tokens all 401 before the uuid pipe', async () => {
    for (const [label, token] of [
      ['none', undefined],
      ['garbage', tokens.garbage],
      ['refresh', tokens.refresh],
    ] as const) {
      const res = await sweep(h, app, 'cancel', {
        orderId: 'nope',
        ...(token ? { token } : {}),
        label: `auth-${label}`,
      });
      expect(res.status).toBe(401);
    }
    expect(h.counts.findOne).toBe(0);
  });
});

describe('driver PATCH /driver/orders/:id/status sweep', () => {
  let h: Harness;
  let app: INestApplication;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    h = buildHarness();
    const booted = await boot(h);
    app = booted.app;
    tokens = booted.tokens;
  });
  afterEach(async () => {
    await app.close();
  });

  const hit = (orderId: string, status: string | null, opts: { token?: string; actor?: Identity; label?: string } = {}) =>
    sweep(h, app, 'driver', {
      orderId,
      query: status === null ? undefined : `status=${status}`,
      token: opts.token ?? tokens.driver,
      actor: opts.actor ?? IDS.driver,
      label: opts.label ?? `driver ${orderId} -> ${status}`,
    });

  it('owns exactly the two forward edges: preparing->delivering and delivering->completed, audit source driver', async () => {
    const a = await hit(O_PREP, 'delivering');
    expect(a.status).toBe(200);
    const b = await hit(O_DELIV, 'completed');
    expect(b.status).toBe(200);
    expect(h.state.audits.map((x) => x.source)).toEqual(['driver', 'driver']);
    expect(h.state.audits.at(-1).actorRole).toBe(UserRole.DRIVER);
  });

  it('every other edge is a driver-specific 400 (never the owner message), and NEVER probes the payment gate', async () => {
    for (const s of ['pending', 'confirmed', 'preparing', 'cancelled', 'completed'] as const) {
      const res = await hit(O_PREP, s, { label: `edge-${s}` });
      expect(res.status).toBe(400);
      expect(res.json.error.message).toContain('Cannot move assigned order');
    }
    // O_DELIV -> cancelled is the money-shaped temptation: 400, no restock,
    // no gate probe, nothing saved.
    const cancelAttempt = await hit(O_DELIV, 'cancelled', { label: 'driver-cancel' });
    expect(cancelAttempt.status).toBe(400);
    expect(h.counts.save).toBe(0);
    expect(h.counts.exist).toBe(0); // the confirm gate is unreachable by design here
  });

  it('assignment scoping: unassigned and foreign-driver orders both 404 identically', async () => {
    const unassigned = await hit(O_PREPU, 'delivering', { label: 'unassigned' });
    expect(unassigned.status).toBe(404);
    const foreign = await hit(O_PREP, 'delivering', { token: tokens.driver2, actor: IDS.driver2, label: 'other-driver' });
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(unassigned.json); // byte-identical: no existence leak
    expect(h.counts.save).toBe(0);
  });

  it('role rung: DRIVER only — ADMIN does NOT bypass; shapes 400/401 stay canonical', async () => {
    for (const [label, token, actor] of [
      ['admin', tokens.admin, IDS.admin],
      ['owner', tokens.owner, IDS.owner],
      ['customer', tokens.customer, IDS.customer],
    ] as const) {
      const res = await sweep(h, app, 'driver', { orderId: O_PREP, query: 'status=delivering', token, actor, label: `role-${label}` });
      expect(res.status).toBe(403);
      expect(res.json.error.message).toBe('Driver role required');
    }
    expect(h.counts.findOne).toBe(0);
    expect((await hit('nope', 'delivering')).status).toBe(400); // pipe after the guards
    expect((await hit(UNKNOWN_ORDER, 'delivering')).status).toBe(404);
  });

  it('enum pipe rejects junk BEFORE the order read (same DTO as the owner route)', async () => {
    for (const [label, q] of [
      ['junk', 'status=nope'],
      ['upper', 'status=DELIVERING'],
      ['missing', undefined],
      ['empty', 'status='],
    ] as const) {
      const res = await sweep(h, app, 'driver', { orderId: O_PREP, query: q, token: tokens.driver, actor: IDS.driver, label });
      expect(res.status).toBe(400);
      expect(res.json.error.message).toBe('Validation failed'); // generic top, constraints in details
      expect(res.json.error.details).toEqual(
        expect.arrayContaining([expect.stringContaining('status must be one of')]),
      );
    }
    expect(h.counts.findOne).toBe(0);
  });
});

describe('rung precedence with executable call-count evidence', () => {
  let h: Harness;
  let app: INestApplication;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    h = buildHarness();
    const booted = await boot(h);
    app = booted.app;
    tokens = booted.tokens;
  });
  afterEach(async () => {
    await app.close();
  });

  it('guard > pipe: malformed uuid + junk status + no token still answers 401', async () => {
    const res = await request(app, 'PATCH', '/api/restaurants/nope/orders/nope/status?status=nope');
    expect(res.status).toBe(401);
    expect(h.counts.findOne + h.counts.scope + h.counts.exist + h.counts.save).toBe(0);
  });

  it('role guard > enum pipe: customer + junk status 403s, the enum never runs', async () => {
    const res = await request(app, 'PATCH', `/api/restaurants/${REST_MINE}/orders/${O_PEND}/status?status=nope`, {
      token: tokens.customer,
    });
    expect(res.status).toBe(403);
    expect(h.counts.findOne).toBe(0);
  });

  it('pipe > service: junk enum with a valid owner token never touches the restaurant gate either', async () => {
    const res = await request(app, 'PATCH', `/api/restaurants/${REST_UNKNOWN}/orders/${O_PEND}/status?status=nope`, {
      token: tokens.owner,
    });
    expect(res.status).toBe(400); // enum rung beats even a 404 restaurant
    expect(h.counts.scope).toBe(0);
    expect(h.counts.findOne).toBe(0);
  });

  it('flow > gate: illegal transition on an unpaid order answers 400 and never asks the payments repo', async () => {
    const res = await request(app, 'PATCH', `/api/restaurants/${REST_MINE}/orders/${O_DELIV}/status?status=confirmed`, {
      token: tokens.owner,
    });
    expect(res.status).toBe(400);
    expect(h.counts.exist).toBe(0);
    expect(h.counts.save).toBe(0);
  });

  it('gate probe happens ONLY for target=confirmed: cancel and advance edges skip it', async () => {
    await request(app, 'PATCH', `/api/restaurants/${REST_MINE}/orders/${O_PREP}/status?status=cancelled`, {
      token: tokens.owner,
    });
    await request(app, 'PATCH', `/api/orders/${O_PREPU}/status?status=delivering`, { token: tokens.admin });
    expect(h.counts.exist).toBe(0);
    expect(h.state.audits).toHaveLength(2); // both accepted, gate never consulted
  });
});

describe('payment-confirm gate flag arms', () => {
  let open: Array<INestApplication> = [];

  async function bootWith(confirmFlag: string | undefined) {
    const h = buildHarness({ confirmFlag });
    const booted = await boot(h);
    open.push(booted.app);
    return { h, ...booted };
  }

  afterEach(async () => {
    for (const a of open) await a.close();
    open = [];
  });

  it('explicit opt-out (0) opens the door: confirm lands 200 with ZERO payments probes', async () => {
    const b = await bootWith('0');
    const res = await sweep(b.h, b.app, 'owner', {
      orderId: O_PEND,
      query: 'status=confirmed',
      token: b.tokens.owner,
      actor: IDS.owner,
      label: 'gate-off-optout',
    });
    expect(res.status).toBe(200);
    expect(b.h.counts.exist).toBe(0);
  });

  it('garbage opt-out spelling (flase) keeps the gate ON — fail-CLOSED decision (session 44)', async () => {
    const b = await bootWith('flase');
    const res = await sweep(b.h, b.app, 'owner', {
      orderId: O_PEND,
      query: 'status=confirmed',
      token: b.tokens.owner,
      actor: IDS.owner,
      label: 'gate-garbage-flag',
    });
    expect(res.status).toBe(402);
    expect(b.h.counts.save).toBe(0);
  });
});

describe('raw transport bodies on status routes', () => {
  let h: Harness;
  let app: INestApplication;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    h = buildHarness();
    const booted = await boot(h);
    app = booted.app;
    tokens = booted.tokens;
  });
  afterEach(async () => {
    await app.close();
  });

  it('malformed JSON body is a parser-rung 400 — and it BEATS the auth guard', async () => {
    const withToken = await request(app, 'PATCH', `/api/restaurants/${REST_MINE}/orders/${O_PEND}/status?status=confirmed`, {
      token: tokens.owner,
      raw: '{"status": "confirmed",}',
    });
    expect(withToken.status).toBe(400);
    expect(withToken.json.error.code).toBe('BAD_REQUEST');
    // the parser runs as middleware, BEFORE guards: an anonymous caller with
    // a broken body sees 400, not 401 (pinned wire truth, not folklore)
    const anon = await request(app, 'PATCH', `/api/orders/${O_PEND}/status?status=confirmed`, {
      raw: '{oops',
    });
    expect(anon.status).toBe(400);
    expect(h.counts.save).toBe(0);
  });

  it('oversize body answers 413 PAYLOAD_TOO_LARGE as the standard envelope, zero writes', async () => {
    const before = snap(h);
    const res = await request(app, 'PATCH', `/api/restaurants/${REST_MINE}/orders/${O_PEND}/status?status=confirmed`, {
      token: tokens.owner,
      body: { smuggle: 'x'.repeat(150_000) },
    });
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(snap(h)).toBe(before);
  });

  it('query-key smuggling cannot add capabilities: body status ignored when query drives', async () => {
    const res = await request(app, 'PATCH', `/api/restaurants/${REST_MINE}/orders/${O_DELIV}/status?status=completed`, {
      token: tokens.owner,
      body: { status: 'confirmed', forceRefund: true },
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('completed'); // the QUERY target won
  });
});

describe('status-write property sweep (seeded, deterministic)', () => {
  let h: Harness;
  let app: INestApplication;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    h = buildHarness();
    const booted = await boot(h);
    app = booted.app;
    tokens = booted.tokens;
  });
  afterEach(async () => {
    await app.close();
  });

  it('320 mutated requests across all four routes: outcomes canonical, denials write nothing, audit chains replay', async () => {
    const rng = makeRng(0x57a7);
    const ORDER_IDS = [
      O_PEND, O_PAID, O_FAIL, O_REFUND, O_PENDPAY, O_CONF, O_PREP, O_PREPU,
      O_DELIV, O_DONE, O_CANCEL, O_GUEST, O_FOREIGN, UNKNOWN_ORDER, 'nope',
    ];
    const TARGETS = ['pending', 'confirmed', 'preparing', 'delivering', 'completed', 'cancelled', 'nope', 'CONFIRMED', ''];
    const TOKEN_NAMES = ['owner', 'admin', 'customer', 'other', 'driver', 'driver2', 'none', 'garbage', 'refresh'];
    const ROUTES: Route[] = ['owner', 'admin', 'cancel', 'driver'];

    const counts: Record<number, number> = {};
    const routeCounts: Record<Route, number> = { owner: 0, admin: 0, cancel: 0, driver: 0 };
    let accepts = 0;

    for (let n = 0; n < 320; n++) {
      const route = ROUTES[n % ROUTES.length]; // even route coverage first, then randomness
      const orderPick = rng.int(10);
      const orderId = orderPick < 2 ? rng.pick(['nope', UNKNOWN_ORDER]) : rng.pick(ORDER_IDS);
      const tok = rng.int(4) === 0 ? rng.pick(TOKEN_NAMES) : rng.pick(['owner', 'admin', 'customer', 'driver']);
      const useToken = tok !== 'none';
      const actor = useToken && tok !== 'garbage' && tok !== 'refresh' ? IDS[tok] : null;

      let query: string | undefined;
      if (route !== 'cancel') {
        if (rng.int(6) === 0) {
          query = rng.pick(['', 'status[]=confirmed', 'status=a&status=b', 'status=%20confirmed']);
        } else {
          const t = rng.int(3) === 0 ? 'confirmed' : rng.pick(TARGETS);
          query = `status=${encodeURIComponent(t)}`;
        }
      }
      const body = rng.int(8) === 0 ? { status: 'completed', totalCents: 1 } : undefined;

      const res = await sweep(h, app, route, {
        orderId,
        ...(query !== undefined ? { query } : {}),
        ...(useToken ? { token: tokens[tok] } : {}),
        actor,
        ...(body !== undefined ? { body } : {}),
        label: `seed=0x57a7 n=${n}`,
      });
      routeCounts[route]++;
      counts[res.status] = (counts[res.status] ?? 0) + 1;
      if (res.status < 400) accepts++;
    }

    // every route exercised, every canonical outcome class actually landed
    for (const r of ROUTES) expect(routeCounts[r]).toBeGreaterThan(30);
    expect(counts[200] ?? 0).toBeGreaterThan(0);
    expect(counts[201] ?? 0).toBeGreaterThan(0);
    expect(counts[400] ?? 0).toBeGreaterThan(10);
    expect(counts[401] ?? 0).toBeGreaterThan(0);
    expect(counts[402] ?? 0).toBeGreaterThan(0);
    expect(counts[403] ?? 0).toBeGreaterThan(0);
    expect(counts[404] ?? 0).toBeGreaterThan(0);
    expect(counts[409] ?? 0).toBe(0); // the roadmap 409 rung genuinely does not exist here
    for (const code of Object.keys(counts)) {
      expect(Number(code) < 500).toBe(true); // zero 5xx, doctrine
    }

    // --- full audit-chain replay against the committed rows ---
    const seedById = new Map(SEED_ORDERS.map((o) => [o.id, o]));
    const chains = new Map<string, any[]>();
    for (const a of h.state.audits) {
      if (!chains.has(a.orderId)) chains.set(a.orderId, []);
      chains.get(a.orderId)!.push(a);
    }
    expect(h.state.audits.length).toBe(accepts); // one audit per acceptance, none else

    for (const [id, row] of h.state.orders) {
      const seed = seedById.get(id)!;
      const chain = chains.get(id) ?? [];
      let s = seed.status as OrderStatus;
      const reached = new Set<OrderStatus>([s]);
      // A row seeded past PENDING already carries the timestamps of every
      // upstream step — those statuses count as reached before this sweep.
      for (const [st, field] of TS_FIELDS) if (seed[field]) reached.add(st);
      for (const a of chain) {
        expect(a.fromStatus).toBe(s); // contiguous chain
        expect(FLOW[s]).toContain(a.toStatus); // legal edge (driver edges are a subset)
        s = a.toStatus;
        reached.add(s);
      }
      expect(row.status).toBe(s);
      for (const [st, field] of TS_FIELDS) {
        expect(row[field] != null).toBe(reached.has(st)); // stamped iff reached
        if (seed[field]) expect(row[field]).toBe(seed[field]); // write-once value
      }
      // restock marker: only cancelled orders with a non-empty snapshot may carry it
      if (row.stockRestockedAt != null) {
        expect(row.status).toBe(OrderStatus.CANCELLED);
        expect((seed.stockDecrements ?? []).length).toBeGreaterThan(0);
      }
    }

    // stock ledger: 3 + returned units of every restocked snapshot order
    let returned = 0;
    for (const [, row] of h.state.orders) {
      if (row.stockRestockedAt != null) {
        const seed = seedById.get(row.id)!;
        returned += (seed.stockDecrements ?? []).reduce((t: number, e: any) => t + e.quantity, 0);
      }
    }
    expect(h.state.stock.get(DISH_A2)).toBe(3 + returned);
    // one live-feed event per acceptance
    expect((h.events as any).publish.mock.calls.length).toBe(accepts);
  });
});
