import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import { OrdersController } from './orders.controller';
import { OrderStatus } from './order.entity';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import { MenuOptionService } from '../menu/menu-option.service';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/optional-jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RATE_LIMIT_CONFIG } from '../common/rate-limit/rate-limit.config';
import { SlidingWindowLogStore } from '../common/rate-limit/rate-limit.store';
import { makeRng } from '../common/fuzz/fuzz-harness';

/**
 * Write-side property sweep (Phase 16): session 135's constant-outcome
 * doctrine applied to `POST /api/orders`. Real OrdersController + real
 * OrdersService + real ValidationPipe (the production option set from
 * app-config) + real ErrorFormatFilter over live HTTP, with the write
 * LAYER emulated faithfully enough to make "rejected request wrote
 * NOTHING" an executable assertion:
 *   - `manager.transaction` commits buffered rows only when the callback
 *     resolves (stock journal rewound on throw — the same rollback the DB
 *     gives), so every denial's write delta is provably 0, not assumed;
 *   - the stock UPDATE keeps this stack's `[rows, rowCount]` TUPLE truth
 *     (session 71) and its `stock IS NOT NULL AND stock >= qty` WHERE —
 *     a between-read-and-write flip to NULL matches zero rows and fails
 *     CLOSED with 409, exactly like production.
 *
 * Families swept (the roadmap names them): option-choice sets, promo
 * codes, qty/stock edges, address shapes — plus top-level body junk,
 * raw-transport bodies, and a seeded 240-case mutation sweep (determin-
 * istic, prints its seed). EVERY response must be canonical: status in
 * {201, 400, 404, 409}, error bodies carrying exactly one envelope with
 * code in {BAD_REQUEST, NOT_FOUND, INSUFFICIENT_STOCK}, ZERO 5xx, and
 * the ledger/stock/order invariants recomputed from the committed state
 * at the end. POST /orders has no 401/403 rung by design (guest checkout
 * is the feature; OptionalJwtAuthGuard degrades junk bearers to guest),
 * so any auth-status answer would itself be a drift.
 */

const JWT_TEST = 'order-create-sweep-http-spec';

// --- fixtures -------------------------------------------------------------

const REST_A = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const REST_UNKNOWN = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const DISH_A1 = 'd15c0001-0000-4000-8000-000000000001'; // 1500, unlimited, has groups
const DISH_A2 = 'd15c0002-0000-4000-8000-000000000002'; // 500, stock-managed 5
const DISH_B1 = 'd15c0b01-0000-4000-8000-000000000003'; // belongs to another restaurant
const DISH_OFF = 'd15c00ff-0000-4000-8000-000000000004'; // isAvailable: false
const DISH_UNKNOWN = 'd15cdead-0000-4000-8000-000000000005';

const CH_LARGE = 'c0a00a01-0000-4000-8000-0000000000a1'; // +200 (SIZE, 0..1)
const CH_SMALL = 'c0a00a02-0000-4000-8000-0000000000a2'; // +0
const CH_MILD = 'c0a00b01-0000-4000-8000-0000000000b1'; // +0 (SPICE, 1..2, REQUIRED)
const CH_HOT = 'c0a00b02-0000-4000-8000-0000000000b2'; // +100
const CH_FOREIGN = 'c0a00f01-0000-4000-8000-0000000000f1'; // DISH_B1's add-on

const USER_ID = '7u530000-0000-4000-8000-000000000001';
const OTHER_ID = '7u530000-0000-4000-8000-000000000002';
const ADDR_MINE = 'add50000-0000-4000-8000-000000000001';
const ADDR_FOREIGN = 'add50000-0000-4000-8000-000000000002';

const SAVEED_ROW = {
  recipientName: 'Saved Person',
  phone: '+62 811-2222-3333',
  address: 'Jl. Tersimpan 42',
};

const STATUSES = new Set([201, 400, 404, 409]);
const CODES = new Set(['BAD_REQUEST', 'NOT_FOUND', 'INSUFFICIENT_STOCK']);

// --- state / fakes ---------------------------------------------------------

interface Committed {
  orders: Map<string, any>;
  ledger: any[];
  stock: Map<string, number | null>;
}

function buildHarness() {
  const state: Committed = {
    orders: new Map(),
    ledger: [],
    stock: new Map([[DISH_A2, 5]]), // DISH_A1 unlimited: absent == null semantics
  };
  let seq = 0;
  // Read-vs-write flip simulator: em.query answers zero rows regardless of
  // the counter — exactly what production's `WHERE stock IS NOT NULL AND
  // stock >= qty` does when a concurrent owner write lands between the
  // pricing read and the UPDATE (session 71 fail-CLOSED contract).
  const zeroRows = { on: false };

  const txCalls: string[] = [];
  // The fake promos.recordUsage buffers its row here; the tx drains it into
  // state.ledger ONLY on commit (rollback discards it) — mirroring how the
  // real ledger row rides the same EntityManager.
  const pendingLedger: any[] = [];
  const transaction = jest.fn(async (cb: any) => {
    // One unit of work: buffers the order save + promo ledger row, applies
    // stock UPDATEs through a journal. Resolve -> commit; throw -> rewind.
    const pendingOrders: Array<[string, any]> = [];
    pendingLedger.length = 0;
    const stockUndo: Array<[string, number | null]> = [];
    let committed = false;
    const em = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (!/UPDATE "menu_items" SET "stock"/.test(sql)) {
          throw new Error(`unexpected SQL reached the sweep harness: ${sql.slice(0, 60)}`);
        }
        const [menuItemId, qty] = params as [string, number];
        const cur = state.stock.get(menuItemId);
        // Production WHERE: `stock IS NOT NULL AND stock >= qty`.
        if (typeof cur !== 'number' || cur < qty || zeroRows.on) return [[], 0];
        state.stock.set(menuItemId, cur - qty);
        stockUndo.push([menuItemId, cur]);
        txCalls.push(`stock:${menuItemId}x${qty}`);
        return [{ stock: cur - qty }, 1];
      }),
      save: jest.fn(async (x: any) => {
        const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
        // Emulate the DB column defaults production applies on INSERT
        // (order.entity.ts: status default 'pending'). The whitelist strips
        // any client-sent status, so a fresh order lands 'pending'.
        const row = { status: OrderStatus.PENDING, ...JSON.parse(JSON.stringify(x)), id };
        pendingOrders.push([id, row]);
        txCalls.push('save');
        return { ...row };
      }),
    };
    try {
      const out = await cb(em);
      for (const [id, row] of pendingOrders) state.orders.set(id, row);
      state.ledger.push(...pendingLedger);
      committed = true;
      return out;
    } finally {
      if (!committed) for (const [id, v] of stockUndo) state.stock.set(id, v);
    }
  });

  const ordersRepo = {
    create: (x: any) => x,
    findOne: jest.fn(async (opts: any) => {
      const row = state.orders.get(opts?.where?.id);
      return row ? JSON.parse(JSON.stringify(row)) : null;
    }),
    manager: { transaction },
  } as unknown as Repository<any> & { manager: { transaction: jest.Mock } };

  const menu = {
    findByIds: jest.fn(async (ids: string[]) => {
      // FAITHFUL to real MenuService.findByIds: a count-mismatch against the
      // UNIQUE requested ids throws 404 BEFORE the pricing loop sees the row
      // (menu.service.ts `items.length !== new Set(ids).size`). A mocked
      // silent-filter conflates "dish gone" (404) with "dish exists but
      // unavailable/foreign" (400) — the live smoke caught this.
      const found = new Map<string, any>();
      for (const id of ids) {
        if (found.has(id)) continue;
        if (id === DISH_A1) found.set(id, { id, name: 'Nasi Goreng', priceCents: 1500, isAvailable: true, restaurantId: REST_A, stock: null });
        if (id === DISH_A2) found.set(id, { id, name: 'Es Teh', priceCents: 500, isAvailable: true, restaurantId: REST_A, stock: state.stock.get(id) ?? null });
        if (id === DISH_B1) found.set(id, { id, name: 'Foreign Dish', priceCents: 900, isAvailable: true, restaurantId: REST_UNKNOWN, stock: null });
        if (id === DISH_OFF) found.set(id, { id, name: 'Sate (closed)', priceCents: 1200, isAvailable: false, restaurantId: REST_A, stock: null });
      }
      if (found.size !== new Set(ids).size) throw new NotFoundException('One or more menu items no longer exist');
      return [...found.values()];
    }),
  } as any;

  const restaurants = {
    findOne: jest.fn(async (id: string) =>
      id === REST_A ? { id: REST_A, minOrderCents: 1000, deliveryFeeCents: 300 } : null,
    ),
  } as any;

  const evaluate = jest.fn(async (rawCode: string) => {
    const code = String(rawCode).trim().toUpperCase();
    if (code === 'SAVE10') return { ok: true as const, message: 'ok', discountCents: 100, promo: { id: 'promo-1' } as any };
    if (code === 'EXPIRED1') return { ok: false as const, reason: 'expired' as const, message: `Promo code "${code}" has expired` };
    return { ok: false as const, reason: 'not_found' as const, message: `Promo code "${code}" is not valid` };
  });
  const promos = {
    evaluate,
    recordUsage: jest.fn(async (payload: any) => {
      // Buffer into the tx closure: committed only if the unit of work
      // resolves (same EntityManager ride as the real ledger row).
      pendingLedger.push(payload);
      return payload;
    }),
  } as any;
  const addresses = {
    getOwned: jest.fn(async (userId: string, id: string) => {
      if (userId === USER_ID && id === ADDR_MINE) return { id, ...SAVEED_ROW };
      throw new NotFoundException('Delivery address not found');
    }),
  } as any;

  // REAL option ladder: MenuOptionService.resolveSelections only reads the
  // groups repo (choices travel as the `relations: { choices: true }` embed).
  const GROUPS = [
    {
      id: 'g0000001-0000-4000-8000-000000000001', menuItemId: DISH_A1, name: 'Size',
      position: 0, minChoices: 0, maxChoices: 1,
      choices: [
        { id: CH_LARGE, name: 'Large', priceDeltaCents: 200, position: 0 },
        { id: CH_SMALL, name: 'Regular', priceDeltaCents: 0, position: 1 },
      ],
    },
    {
      id: 'g0000002-0000-4000-8000-000000000002', menuItemId: DISH_A1, name: 'Spice',
      position: 1, minChoices: 1, maxChoices: 2,
      choices: [
        { id: CH_MILD, name: 'Mild', priceDeltaCents: 0, position: 0 },
        { id: CH_HOT, name: 'Hot', priceDeltaCents: 100, position: 1 },
      ],
    },
    {
      id: 'g0000003-0000-4000-8000-000000000003', menuItemId: DISH_B1, name: 'Add-on',
      position: 0, minChoices: 0, maxChoices: 1,
      choices: [{ id: CH_FOREIGN, name: 'Telur', priceDeltaCents: 150, position: 0 }],
    },
  ];
  const groupsRepo = { find: jest.fn(async () => JSON.parse(JSON.stringify(GROUPS))) } as any;
  const optionPricing = new MenuOptionService(groupsRepo, {} as any, {} as any);

  const events = { publish: jest.fn() } as unknown as OrderEventsService;

  const service = new OrdersService(
    ordersRepo as Repository<any>,
    menu,
    restaurants,
    events,
    promos,
    addresses,
    undefined, undefined, undefined, undefined,
    optionPricing,
  );
  return { service, state, ordersRepo, transaction, promos, events, txCalls, zeroRows };
}

type Harness = ReturnType<typeof buildHarness>;

async function boot(h: Harness) {
  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: JWT_TEST })],
    controllers: [OrdersController],
    providers: [
      JwtAuthGuard,
      OptionalJwtAuthGuard,
      RolesGuard,
      RateLimitGuard,
      Reflector,
      { provide: OrdersService, useValue: h.service },
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
  const tokens = {
    customer: await jwt.signAsync({ sub: USER_ID, role: UserRole.CUSTOMER, typ: TOKEN_TYPE_ACCESS }),
    other: await jwt.signAsync({ sub: OTHER_ID, role: UserRole.CUSTOMER, typ: TOKEN_TYPE_ACCESS }),
  };
  return { app, tokens };
}

function send(
  app: INestApplication,
  body: unknown,
  opts: { token?: string; raw?: string } = {},
): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const payload = opts.raw ?? JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/orders', headers },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json: any;
          try { json = JSON.parse(raw); } catch { json = undefined; }
          resolve({ status: res.statusCode!, json, raw });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// --- canonical-outcome gate -------------------------------------------------

function totals(h: Harness) {
  return {
    orders: h.state.orders.size,
    ledger: h.state.ledger.length,
    stockA2: h.state.stock.get(DISH_A2) ?? null,
    stockSum: [...h.state.stock.values()].reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0),
  };
}
type Totals = ReturnType<typeof totals>;

/**
 * THE doctrine: every response lands in the canonical set, every denial
 * answers the single envelope shape with an exact code, and NO denial may
 * move a committed byte (orders rows, promo ledger, stock counters).
 */
async function sweep(
  h: Harness,
  app: INestApplication,
  body: unknown,
  opts: { token?: string; raw?: string; label: string },
): Promise<{ res: { status: number; json: any; raw: string }; before: Totals; after: Totals }> {
  const before = totals(h);
  const res = await send(app, body, opts);
  const after = totals(h);
  const ctx = `${opts.label} status=${res.status} body=${res.raw.slice(0, 220)}`;
  if (!STATUSES.has(res.status)) throw new Error(`NON-CANONICAL outcome — ${ctx}`);
  if (res.status === 201) {
    expect(res.json.error).toBeUndefined();
    expect(after.orders - before.orders).toBe(1);
    expect(after.ledger).toBe(res.json.promoCode ? before.ledger + 1 : before.ledger);
    expect(after.stockSum).toBeLessThanOrEqual(before.stockSum);
  } else {
    expect(res.json?.error?.code).toEqual(expect.any(String));
    expect(CODES.has(res.json.error.code)).toBe(true);
    expect(after.orders).toBe(before.orders); // write-nothing on every denial
    expect(after.ledger).toBe(before.ledger);
    expect(after.stockA2).toBe(before.stockA2);
    expect(after.stockSum).toBe(before.stockSum);
  }
  return { res, before, after };
}

// --- body factories -----------------------------------------------------------

const validBody = (over: Record<string, unknown> = {}): any => ({
  restaurantId: REST_A,
  items: [{ menuItemId: DISH_A1, quantity: 1, optionChoiceIds: [CH_MILD] }],
  customerName: 'Ada',
  contactPhone: '+62 812-3456-7890',
  deliveryAddress: 'Jl. Test 1',
  contactEmail: 'ADA@Example.com',
  ...over,
});

const A2line = (quantity: number, extra: Record<string, unknown> = {}) =>
  ({ menuItemId: DISH_A2, quantity, ...extra });
const A1line = (quantity: number, opts?: string[]) =>
  ({ menuItemId: DISH_A1, quantity, ...(opts ? { optionChoiceIds: opts } : {}) });

describe('POST /orders write sweep — canonical outcomes, zero writes on denial', () => {
  let h: Harness;
  let app: INestApplication;
  let tokens: { customer: string; other: string };

  beforeEach(async () => {
    h = buildHarness();
    const booted = await boot(h);
    app = booted.app;
    tokens = booted.tokens;
  });
  afterEach(async () => { await app.close(); });

  it('baseline valid guest order: 201, server-priced, one committed row', async () => {
    const { res } = await sweep(h, app, validBody(), { label: 'baseline' });
    expect(res.status).toBe(201);
    // 1500 unit (MILD +0) + 300 fee = 1800 — client sends no prices at all.
    expect(res.json.totalCents).toBe(1800);
    expect(res.json.subtotalCents).toBe(1500);
    expect(res.json.code).toMatch(/^FO-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(res.json.contactEmail).toBe('ada@example.com'); // normalizeContactEmail on write
    expect(res.json.userId).toBeNull();
    const row = [...h.state.orders.values()].at(-1);
    expect(row.items[0].optionSelections[0].groupId).toBeDefined(); // option snapshot stored
  });

  it('whitelist strips money-shaped junk keys: payload-identical to the clean body', async () => {
    const clean = validBody();
    const dirty = validBody({ totalCents: 1, priceCents: 1, isAdmin: true, userId: OTHER_ID, status: 'completed' });
    const a = await sweep(h, app, clean, { label: 'clean' });
    const b = await sweep(h, app, dirty, { label: 'junk-keys' });
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);
    expect(b.res.json.totalCents).toBe(a.res.json.totalCents);
    expect(b.res.json.userId).toBeNull(); // injected identity never sticks
    expect(b.res.json.status).toBe('pending'); // injected status never sticks
  });

  it('empty body / non-object bodies answer 400 BAD_REQUEST, never 500', async () => {
    for (const [label, body] of [
      ['empty-object', {}],
      ['array-body', [1, 2, 3]],
      ['string-body', 'hello'],
      ['null-body', null],
    ] as const) {
      const { res } = await sweep(h, app, body, { label });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('BAD_REQUEST');
    }
  });

  it('restaurantId family: unknown -> 404, junk-string 404 (no uuid pipe on this field), empty -> 400', async () => {
    const unknown = await sweep(h, app, validBody({ restaurantId: REST_UNKNOWN }), { label: 'unknown-restaurant' });
    expect(unknown.res.status).toBe(404);
    expect(unknown.res.json.error.code).toBe('NOT_FOUND');
    // PROVEN wire truth: restaurantId is @IsString @IsNotEmpty only — a
    // junk-but-present id sails past the pipe and dies on the row lookup.
    const junk = await sweep(h, app, validBody({ restaurantId: 'abc' }), { label: 'junk-restaurant' });
    expect(junk.res.status).toBe(404);
    expect(junk.res.json.error.code).toBe('NOT_FOUND');
    const empty = await sweep(h, app, validBody({ restaurantId: '' }), { label: 'empty-restaurant' });
    expect(empty.res.status).toBe(400);
    expect(empty.res.json.error.code).toBe('BAD_REQUEST');
    const shaped = await sweep(h, app, validBody({ restaurantId: {} }), { label: 'object-restaurant' });
    expect(shaped.res.status).toBe(400);
  });

  it('items family: missing/[]/junk-line canonical 400s; unknown dish 404 (findByIds count guard); unavailable/foreign 400', async () => {
    const cases400: Array<[string, unknown]> = [
      ['missing-items', validBody({ items: undefined })],
      ['empty-items', validBody({ items: [] })], // passes pipe, dies on min-order
      ['string-items', validBody({ items: 'x' })],
      ['line-strings', validBody({ items: ['x'] })],
      ['line-empty-object', validBody({ items: [{}] })],
      ['line-unavailable', validBody({ items: [{ menuItemId: DISH_OFF, quantity: 1 }] })],
      ['line-foreign-dish', validBody({ items: [A1line(1), { menuItemId: DISH_B1, quantity: 1 }] })],
    ];
    for (const [label, body] of cases400) {
      const { res } = await sweep(h, app, body, { label });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('BAD_REQUEST');
    }
    // A GONE dish is not a cart-shape error: MenuService.findByIds answers
    // the canonical 404 BEFORE the pricing loop runs (live-proven: the
    // same-not-found dish id 404s on the scratch DB too). The zero-write
    // invariant holds either way (nothing started inside the lookup).
    const gone = await sweep(h, app, validBody({ items: [A2line(2, { menuItemId: DISH_UNKNOWN })] }), { label: 'line-unknown-dish' });
    expect(gone.res.status).toBe(404);
    expect(gone.res.json.error.code).toBe('NOT_FOUND');
    expect(gone.res.json.error.message).toBe('One or more menu items no longer exist');
    // NON-uuid ids die at the pipe rung (the sweep's second finding: the
    // real DB turned In(['nope']) on the uuid PK into a pg 22P02 500).
    const nonuuid = await sweep(h, app, validBody({ items: [{ menuItemId: 'nope', quantity: 1 }] }), { label: 'line-nonuuid-dish' });
    expect(nonuuid.res.status).toBe(400);
    expect(nonuuid.res.json.error.details).toEqual(
      expect.arrayContaining([expect.stringContaining('menuItemId must be a valid dish id')]),
    );
  });

  it('quantity edges: 0/51/2.5/junk/null -> 400; numeric-string 2 -> 201; boolean -> 201 coercion', async () => {
    // The DTO carries @Type(() => Number) + @IsInt @Min(1) @Max(50).
    for (const bad of [0, 51, -3, 2.5, 'x', null, '', {}]) {
      const { res } = await sweep(h, app, validBody({ items: [{ ...A1line(1), quantity: bad as any }] }), { label: `qty-${String(bad)}` });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('BAD_REQUEST');
    }
    // Wire-coerced variants: the pipe Number()-s BEFORE the service, and
    // Number(true) IS 1 — both land as valid qty-1 lines. (Pinned, not folklore.)
    const str = await sweep(h, app, validBody({ items: [{ menuItemId: DISH_A1, quantity: '1' as any, optionChoiceIds: [CH_MILD] }] }), { label: 'qty-string' });
    expect(str.res.status).toBe(201);
    const bool = await sweep(h, app, validBody({ items: [{ menuItemId: DISH_A1, quantity: true as any, optionChoiceIds: [CH_MILD] }] }), { label: 'qty-bool' });
    expect(bool.res.status).toBe(201);
  });

  it('contact family: partial trios 400 the service, phone pattern 400 the pipe, email edges 400', async () => {
    const missing = await sweep(h, app, validBody({ deliveryAddress: undefined }), { label: 'missing-address' });
    expect(missing.res.status).toBe(400);
    expect(missing.res.json.error.message).toContain('Missing required field(s): deliveryAddress');
    const phone = await sweep(h, app, validBody({ contactPhone: 'call me' }), { label: 'junk-phone' });
    expect(phone.res.status).toBe(400);
    const phoneLen = await sweep(h, app, validBody({ contactPhone: '+123456789012345678901' }), { label: 'long-phone' });
    expect(phoneLen.res.status).toBe(400);
    const email = await sweep(h, app, validBody({ contactEmail: 'not-an-email' }), { label: 'junk-email' });
    expect(email.res.status).toBe(400);
    const emailLen = await sweep(h, app, validBody({ contactEmail: `${'x'.repeat(300)}@example.com` }), { label: 'long-email' });
    expect(emailLen.res.status).toBe(400); // MaxLength(254) fires BEFORE IsEmail
    const noEmail = await sweep(h, app, validBody({ contactEmail: undefined }), { label: 'no-email' });
    expect(noEmail.res.status).toBe(201); // API-optional, but no guest rung exists then
    expect(noEmail.res.json.contactEmail).toBeNull();
  });

  it('saved-address rung: guest 400, bad uuid 400, foreign id 404, own id 201 server-copied', async () => {
    const guest = await sweep(h, app, validBody({ deliveryAddressId: ADDR_MINE }), { label: 'guest-addr-id' });
    expect(guest.res.status).toBe(400);
    expect(guest.res.json.error.message).toContain('signed-in');
    const bad = await sweep(h, app, validBody({ deliveryAddressId: 'nope' }), { label: 'bad-addr-id' });
    expect(bad.res.status).toBe(400);
    const foreign = await sweep(h, app, validBody({ deliveryAddressId: ADDR_FOREIGN }), { label: 'foreign-addr', token: tokens.customer });
    expect(foreign.res.status).toBe(404);
    expect(foreign.res.json.error.code).toBe('NOT_FOUND');
    const own = await sweep(h, app, validBody({ deliveryAddressId: ADDR_MINE, customerName: 'HACKED' }), { label: 'own-addr', token: tokens.customer });
    expect(own.res.status).toBe(201);
    expect(own.res.json.customerName).toBe(SAVEED_ROW.recipientName); // client echo IGNORED
    expect(own.res.json.contactPhone).toBe(SAVEED_ROW.phone);
    expect(own.res.json.deliveryAddress).toBe(SAVEED_ROW.address);
    expect(own.res.json.userId).toBe(USER_ID);
  });

  it('option-choice sets: missing-required/min/max/duplicate/foreign/unknown/non-uuid all canonical 400s; valid combos price server-side', async () => {
    const noSpice = await sweep(h, app, validBody({ items: [A1line(1)] }), { label: 'opt-missing-required' });
    expect(noSpice.res.status).toBe(400);
    expect(noSpice.res.json.error.message).toContain('at least');
    const twoSizes = await sweep(h, app, validBody({ items: [A1line(1, [CH_MILD, CH_LARGE, CH_SMALL])] }), { label: 'opt-over-max' });
    expect(twoSizes.res.status).toBe(400);
    expect(twoSizes.res.json.error.message).toContain('at most');
    const dup = await sweep(h, app, validBody({ items: [A1line(1, [CH_MILD, CH_MILD])] }), { label: 'opt-duplicate' });
    expect(dup.res.status).toBe(400);
    expect(dup.res.json.error.message).toContain('Duplicate');
    const foreign = await sweep(h, app, validBody({ items: [A1line(1, [CH_MILD, CH_FOREIGN])] }), { label: 'opt-foreign' });
    expect(foreign.res.status).toBe(400);
    const unknown = await sweep(h, app, validBody({ items: [A1line(1, [CH_MILD, '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d'])] }), { label: 'opt-unknown' });
    expect(unknown.res.status).toBe(400);
    const nonUuid = await sweep(h, app, validBody({ items: [A1line(1, ['not-a-uuid'])] }), { label: 'opt-nonuuid' });
    expect(nonUuid.res.status).toBe(400);
    expect(nonUuid.res.json.error.details).toEqual(
      expect.arrayContaining([expect.stringContaining('optionChoiceIds must be valid choice ids')]),
    );
    const tooMany = await sweep(h, app, validBody({ items: [A1line(1, Array.from({ length: 21 }, (_, i) => `c0a0000${i}-0000-4000-8000-000000000000`))] }), { label: 'opt-arraymax' });
    expect(tooMany.res.status).toBe(400);
    const notArray = await sweep(h, app, validBody({ items: [{ menuItemId: DISH_A1, quantity: 1, optionChoiceIds: CH_MILD }] }), { label: 'opt-string' });
    expect(notArray.res.status).toBe(400);
    const optionsOnPlainDish = await sweep(h, app, validBody({ items: [A1line(1, [CH_MILD]), A2line(2, { optionChoiceIds: [CH_LARGE] })] }), { label: 'opt-wrong-dish' });
    expect(optionsOnPlainDish.res.status).toBe(400);
    // valid two-spice combo: 1500 + 0 + 100 = 1600 unit
    const valid2 = await sweep(h, app, validBody({ items: [A1line(1, [CH_MILD, CH_HOT])] }), { label: 'opt-both-spices' });
    expect(valid2.res.status).toBe(201);
    expect(valid2.res.json.subtotalCents).toBe(1600);
  });

  it('promo family: valid -> 201 + ledger row, pattern-invalid -> 400 pipe, rejected codes -> 400 service zero-ledger', async () => {
    const ok = await sweep(h, app, validBody({ promoCode: 'save10' }), { label: 'promo-valid' });
    expect(ok.res.status).toBe(201);
    expect(ok.res.json.promoCode).toBe('SAVE10'); // normalizePromoCode stores uppercase
    expect(ok.res.json.discountCents).toBe(100);
    expect(ok.res.json.totalCents).toBe(1500 - 100 + 300);
    // min-order is checked BEFORE evaluate: a promo can never smuggle a
    // below-minimum cart (subtotal 500 with Es Teh qty 1 even discounted).
    const belowMin = await sweep(h, app, validBody({ items: [A2line(1)], promoCode: 'SAVE10' }), { label: 'promo-below-min' });
    expect(belowMin.res.status).toBe(400);
    expect(belowMin.res.json.error.message).toContain('minimum');
    const expired = await sweep(h, app, validBody({ promoCode: 'EXPIRED1' }), { label: 'promo-expired' });
    expect(expired.res.status).toBe(400);
    expect(expired.res.json.error.message).toContain('expired');
    const nope = await sweep(h, app, validBody({ promoCode: 'NOPE' }), { label: 'promo-unknown' });
    expect(nope.res.status).toBe(400);
    const shape = await sweep(h, app, validBody({ promoCode: 'bad code!' }), { label: 'promo-pattern' });
    expect(shape.res.status).toBe(400);
    expect(h.state.ledger.length).toBe(1); // ONLY the valid order booked
  });

  it('stock edges: over-stock 409 zero-write, duplicate lines aggregate, null-flip fails CLOSED, unlimited dish never decrements', async () => {
    const over = await sweep(h, app, validBody({ items: [A2line(6)] }), { label: 'stock-over' });
    expect(over.res.status).toBe(409);
    expect(over.res.json.error.code).toBe('INSUFFICIENT_STOCK');
    expect(over.res.json.error.details).toEqual({ menuItemId: DISH_A2, requested: 6, stockAtRead: 5 });
    expect(h.state.stock.get(DISH_A2)).toBe(5);
    const dupLines = await sweep(h, app, validBody({ items: [A2line(3), A2line(3)] }), { label: 'stock-agg-over' });
    expect(dupLines.res.status).toBe(409);
    expect(h.state.stock.get(DISH_A2)).toBe(5); // aggregated 3+3=6 > 5, nothing taken
    const exact = await sweep(h, app, validBody({ items: [A2line(2), A2line(3)] }), { label: 'stock-agg-exact' });
    expect(exact.res.status).toBe(201);
    expect(h.state.stock.get(DISH_A2)).toBe(0);
    // one aggregated UPDATE per dish (not per line) — session 71 contract
    const stockCalls = h.txCalls.filter((c) => c.startsWith(`stock:${DISH_A2}`));
    expect(stockCalls).toEqual([`stock:${DISH_A2}x5`]);
    const afterZero = await sweep(h, app, validBody({ items: [A2line(2)] }), { label: 'stock-zero-left' });
    expect(afterZero.res.status).toBe(409);
    // read-vs-write flip: pricing read says 5, the UPDATE matches zero rows
    // (concurrent owner flipped the column to NULL) -> the guard must fail
    // CLOSED with 409, never sell units the counter says nothing about.
    h.zeroRows.on = true;
    const flipped = await sweep(h, app, validBody({ items: [A2line(2)] }), { label: 'stock-flip-zero-rows' });
    h.zeroRows.on = false;
    expect(flipped.res.status).toBe(409);
    expect(flipped.res.json.error.code).toBe('INSUFFICIENT_STOCK');
    expect(h.state.stock.get(DISH_A2)).toBe(0); // untouched by the failed attempt
    // unlimited dish: order it 200 times, counter must stay absent/untouched
    const before = totals(h);
    const unlimited = await sweep(h, app, validBody({ items: [A1line(1, [CH_MILD]), A1line(1, [CH_MILD])] }), { label: 'unlimited' });
    expect(unlimited.res.status).toBe(201);
    expect(totals(h).stockA2).toBe(before.stockA2);
    expect(h.txCalls.some((c) => c.startsWith('stock:' + DISH_A1))).toBe(false);
  });

  it('junk bearer degrades to guest (OptionalJwtAuthGuard) — never 401 on this route', async () => {
    const res = await sweep(h, app, validBody(), { label: 'junk-token', token: 'not.a.jwt' });
    expect(res.res.status).toBe(201);
    expect(res.res.json.userId).toBeNull();
  });
});

describe('POST /orders write sweep — raw transport bodies', () => {
  let h: Harness;
  let app: INestApplication;

  beforeEach(async () => {
    h = buildHarness();
    const booted = await boot(h);
    app = booted.app;
  });
  afterEach(async () => { await app.close(); });

  it('duplicate JSON keys: last-wins parse still lands a canonical outcome', async () => {
    const raw = JSON.stringify(validBody()).replace('"customerName":"Ada"', '"customerName":"Ada","customerName":"Bee"');
    const { res } = await sweep(h, app, undefined, { raw, label: 'dup-key-body' });
    // last-wins JSON.parse: 'Bee' is the stored name, not a 4xx.
    expect(res.status).toBe(201);
    expect(res.json.customerName).toBe('Bee');
  });

  it('prototype-pollution key is stripped by the pipe — no 5xx, no polluted row', async () => {
    const raw = `{"restaurantId":"${REST_A}","items":[{"menuItemId":"${DISH_A1}","quantity":1,"optionChoiceIds":["${CH_MILD}"]}],"customerName":"Ada","contactPhone":"+628123456789","deliveryAddress":"Jl. Test 1","__proto__":{"polluted":true}}`;
    const { res } = await sweep(h, app, undefined, { raw, label: 'proto-body' });
    expect(res.status).toBe(201);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('malformed JSON body: canonical non-5xx envelope (session-84 doctrine)', async () => {
    const { res } = await sweep(h, app, undefined, { raw: '{"restaurantId": "x",}', label: 'trailing-comma' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('BAD_REQUEST');
  });

  it('oversize body: transport answers 413 PAYLOAD_TOO_LARGE, still an envelope, zero writes', async () => {
    const before = totals(h);
    const big = validBody({ note: 'x'.repeat(150_000) });
    const res = await send(app, big);
    expect(res.status).toBe(413);
    expect(res.json?.error?.code).toBe('PAYLOAD_TOO_LARGE');
    expect(totals(h).orders).toBe(before.orders);
  });

  it('non-JSON content type reaches the pipe as an empty body -> 400', async () => {
    const res = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const port = (app.getHttpServer().address() as AddressInfo).port;
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/orders', headers: { 'content-type': 'text/plain' } },
        (r) => {
          let raw = '';
          r.setEncoding('utf8');
          r.on('data', (c) => (raw += c));
          r.on('end', () => {
            let json: any; try { json = JSON.parse(raw); } catch { json = undefined; }
            resolve({ status: r.statusCode!, json });
          });
        },
      );
      req.on('error', reject);
      req.end('restaurantId=' + REST_A);
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /orders write sweep — seeded property mutation (deterministic)', () => {
  let h: Harness;
  let app: INestApplication;
  let tokens: { customer: string; other: string };

  beforeEach(async () => {
    h = buildHarness();
    const booted = await boot(h);
    app = booted.app;
    tokens = booted.tokens;
  });
  afterEach(async () => { await app.close(); });

  it('240 mutated bodies: every outcome canonical, denials write nothing, state invariants hold at the end', async () => {
    const rng = makeRng(0x09D5);
    const JUNK = [null, 42, true, '', {}, [], 'x'.repeat(300), 'nope'];
    const OPT_SETS: Array<string[] | string | number> = [
      [CH_MILD], [CH_MILD, CH_HOT], [CH_LARGE, CH_MILD], [CH_SMALL, CH_MILD, CH_HOT],
      [CH_FOREIGN], [CH_MILD, CH_MILD], [], ['not-a-uuid'], CH_MILD, 42,
    ];
    const QUANTS: unknown[] = [0, 1, 2, 3, 6, 51, '2', 'x', null, 2.5, true, {}];
    const TOP_JUNK_KEYS = ['totalCents', 'discountCents', 'status', 'userId', 'stockDecrements'];

    type Case = { body: any; token?: string; label: string };
    let count201 = 0;
    let count400 = 0;
    let count404 = 0;
    let count409 = 0;
    const seenCodes = new Set<string>();

    for (let n = 0; n < 240; n++) {
      const body = validBody();
      const muts = 1 + rng.int(2);
      for (let m = 0; m < muts; m++) {
        const op = rng.int(14);
        if (op === 0) { const k = rng.pick(['customerName', 'contactPhone', 'deliveryAddress', 'contactEmail', 'items', 'restaurantId', 'note', 'promoCode']); delete body[k]; }
        else if (op === 1) body[rng.pick(TOP_JUNK_KEYS)] = rng.pick(JUNK);
        else if (op === 2 && Array.isArray(body.items)) body.items = [...body.items, rng.pick([A2line(1 + rng.int(8)), A1line(1 + rng.int(2), rng.pick([CH_MILD, [CH_MILD, CH_HOT] as never]) as never), { menuItemId: DISH_B1, quantity: 1 }, { menuItemId: DISH_OFF, quantity: 1 }])];
        else if (op === 3 && Array.isArray(body.items) && body.items.length) body.items[0] = { ...body.items[0], quantity: rng.pick(QUANTS) };
        else if (op === 4 && Array.isArray(body.items) && body.items.length) body.items[0] = { ...body.items[0], optionChoiceIds: rng.pick(OPT_SETS) as any };
        else if (op === 5) body.items = rng.pick([[], 'x', null, [{}], [validBody().items[0], validBody().items[0]]]);
        else if (op === 6) body.restaurantId = rng.pick([REST_A, REST_UNKNOWN, 'abc', '']);
        else if (op === 7) body.contactPhone = rng.pick(['abc', '+1', '', '+62 812-3456-7890', 'x'.repeat(30)]);
        else if (op === 8) body.contactEmail = rng.pick(['not-an-email', '', 'a@b.co', 'x'.repeat(300) + '@e.com']);
        else if (op === 9) body.promoCode = rng.pick(['SAVE10', 'save10', 'EXPIRED1', 'NOPE', 'x', 'bad code!']);
        else if (op === 10) body.customerName = rng.pick(['', null, 42, 'Ada']);
        else if (op === 11) body.deliveryAddressId = rng.pick([ADDR_MINE, ADDR_FOREIGN, 'nope', {}]);
        else if (op === 12) body.note = rng.pick(['', 'no salt please', 'x'.repeat(500)]);
        else if (op === 13 && Array.isArray(body.items) && body.items.length) body.items[0] = { ...body.items[0], menuItemId: rng.pick([DISH_A1, DISH_A2, DISH_UNKNOWN, DISH_OFF, DISH_B1, 'nope']) };
      }
      const useToken = body.deliveryAddressId === ADDR_MINE || (rng.int(4) === 0);
      const c: Case = {
        body,
        label: `seed=0x09D5 n=${n}`,
        ...(useToken ? { token: rng.int(2) === 0 ? tokens.customer : tokens.other } : {}),
      };
      const { res } = await sweep(h, app, c.body, { label: c.label, ...(c.token ? { token: c.token } : {}) });
      if (res.status === 201) count201++;
      else if (res.status === 400) count400++;
      else if (res.status === 404) count404++;
      else { count409++; }
      if (res.status >= 400) seenCodes.add(res.json.error.code);
    }

    // coverage: every canonical outcome actually occurred
    expect(count201).toBeGreaterThan(0);
    expect(count400).toBeGreaterThan(10);
    expect(count404).toBeGreaterThan(0);
    expect(count409).toBeGreaterThan(0);

    // end-state invariants derived from the COMMITTED rows only
    const committed = [...h.state.orders.values()];
    expect(committed.length).toBe(count201); // every 201 wrote exactly one row; nothing else did
    const a2Units = committed.reduce(
      (acc, row: any) => acc + row.items.filter((i: any) => i.menuItemId === DISH_A2).reduce((s: number, i: any) => s + i.quantity, 0),
      0,
    );
    expect(5 - a2Units).toBe(h.state.stock.get(DISH_A2)); // decrements == committed units, never below
    const booked = committed.filter((row: any) => row.promoCode).length;
    expect(booked).toBe(h.state.ledger.length); // ledger row per promo-bearing committed order
    expect([...seenCodes].sort()).toEqual(['BAD_REQUEST', 'INSUFFICIENT_STOCK', 'NOT_FOUND']);
  });
});
