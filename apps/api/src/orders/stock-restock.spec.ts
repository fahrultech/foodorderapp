import { Repository } from 'typeorm';
import {
  aggregateStockDecrements,
  restockCancelledOrder,
  StockDecrementEntry,
} from './stock-restock';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.entity';
import { OrderEventsService } from './order-events.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';
import { UserRole } from '../users/user.entity';

/**
 * Restock on cancellation (docs/ROADMAP.md Phase 5, session-71 follow-up).
 * Session 71 made create() decrement menu stock but left every path into
 * `cancelled` destroying the reserved units. These specs pin the return
 * contract: exactly the snapshot's units, exactly once, via a CAS — plus
 * the service wiring so ALL FOUR cancel paths (owner, admin, customer,
 * stale sweep) go through it. Real DB race behavior is the live smoke's
 * job (DEVLOG session 72); here we pin orchestration + SQL shape.
 *
 * Session-71 lesson applied to mocks: this TypeORM/pg stack returns
 * DML-with-RETURNING as a `[rows, rowCount]` TUPLE — every canned result
 * below uses the tuple shape.
 */

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const REST_ID = '11111111-1111-4111-8111-111111111111';

/** Manager double whose transaction() runs the callback against a recorded
 *  query mock; canned outcomes per SQL family (CAS on orders / per-dish add). */
function fakeManager(opts: {
  cas?: Array<Record<string, unknown>> | null; // rows; [] = CAS lost
  menu?: Array<Record<string, unknown>> | null; // rows for each menu_items UPDATE
  throwOn?: 'cas' | 'menu';
}) {
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('"orders"')) {
      if (opts.throwOn === 'cas') throw new Error('cas boom');
      return [opts.cas ?? [{ id: ORDER_ID }], (opts.cas ?? [{ id: ORDER_ID }]).length];
    }
    if (sql.includes('"menu_items"')) {
      if (opts.throwOn === 'menu') throw new Error('menu boom');
      const rows = opts.menu ?? [{ stock: 42 }];
      return [rows, rows.length];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const transaction = jest.fn(async (cb: any) => cb({ query }));
  return { manager: { transaction }, query, transaction };
}

const snap = (...entries: Array<[string, number]>): StockDecrementEntry[] =>
  entries.map(([menuItemId, quantity]) => ({ menuItemId, quantity }));

describe('aggregateStockDecrements — snapshot hardening', () => {
  it('returns nothing for null/undefined/non-array/malformed entries', () => {
    expect(aggregateStockDecrements(null).size).toBe(0);
    expect(aggregateStockDecrements(undefined).size).toBe(0);
    expect(aggregateStockDecrements([]).size).toBe(0);
    const junk = [
      null,
      { menuItemId: '', quantity: 1 },
      { menuItemId: 42, quantity: 1 },
      { menuItemId: 'm1', quantity: 0 },
      { menuItemId: 'm1', quantity: -2 },
      { menuItemId: 'm1', quantity: 1.5 },
      { menuItemId: 'm1', quantity: '3' },
      { menuItemId: 'm1' },
    ] as unknown as StockDecrementEntry[];
    expect(aggregateStockDecrements(junk).size).toBe(0);
  });

  it('folds duplicate dish ids into one summed total', () => {
    const totals = aggregateStockDecrements(snap(['m1', 2], ['m2', 1], ['m1', 3]));
    expect([...totals.entries()]).toEqual([['m1', 5], ['m2', 1]]);
  });
});

describe('restockCancelledOrder — the return contract', () => {
  it('opens NO transaction when the order decremented nothing', async () => {
    for (const snapshot of [null, undefined, [], snap()]) {
      const { manager, transaction } = fakeManager({});
      const done = await restockCancelledOrder(manager, {
        id: ORDER_ID,
        stockDecrements: snapshot as StockDecrementEntry[] | null,
      });
      expect(done).toBe(false);
      expect(transaction).not.toHaveBeenCalled();
    }
  });

  it('survives a missing manager (unit harnesses) instead of throwing', async () => {
    await expect(
      restockCancelledOrder(null, { id: ORDER_ID, stockDecrements: snap(['m1', 1]) }),
    ).resolves.toBe(false);
  });

  it('winner path: CAS the marker, then add each dish back in SORTED order', async () => {
    const { manager, query } = fakeManager({});
    const now = new Date('2026-11-09T10:00:00Z');
    const done = await restockCancelledOrder(
      manager,
      { id: ORDER_ID, stockDecrements: snap(['zz', 2], ['aa', 1]) },
      now,
    );
    expect(done).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
    const [casSql, casParams] = query.mock.calls[0];
    expect(casSql).toContain('UPDATE "orders" SET "stockRestockedAt" = $2');
    expect(casSql).toContain('"stockRestockedAt" IS NULL');
    // The CAS also pins status: an order concurrently overwritten to a live
    // status keeps its decrement — returning units for an ALIVE order is wrong.
    expect(casSql).toContain(`"status" = 'cancelled'`);
    expect(casParams).toEqual([ORDER_ID, now]);
    expect(query.mock.calls[1][0]).toContain('SET "stock" = "stock" + $2');
    expect(query.mock.calls[1][1]).toEqual(['aa', 1]); // sorted before 'zz'
    expect(query.mock.calls[2][1]).toEqual(['zz', 2]);
  });

  it('CAS loser (tuple [[],0] — the session-71 shape trap) restocks NOTHING', async () => {
    const { manager, query } = fakeManager({ cas: [] });
    const done = await restockCancelledOrder(manager, {
      id: ORDER_ID,
      stockDecrements: snap(['m1', 3]),
    });
    expect(done).toBe(false);
    expect(query).toHaveBeenCalledTimes(1); // only the marker CAS ran
  });

  it('folds duplicate snapshot lines into ONE menu UPDATE with the summed quantity', async () => {
    const { manager, query } = fakeManager({});
    await restockCancelledOrder(manager, {
      id: ORDER_ID,
      stockDecrements: snap(['m1', 2], ['m1', 3]),
    });
    expect(query.mock.calls.filter((c: any) => String(c[0]).includes('menu_items'))).toEqual([
      [expect.stringContaining('"stock" + $2'), ['m1', 5]],
    ]);
  });

  it('a dish whose stock row no longer matches (cleared to unlimited / deleted) is a silent per-row no-op', async () => {
    const { manager } = fakeManager({ menu: [] });
    const done = await restockCancelledOrder(manager, {
      id: ORDER_ID,
      stockDecrements: snap(['m1', 1]),
    });
    // The marker IS set (the order is restocked as far as it can be) — true.
    expect(done).toBe(true);
  });

  it('a transaction failure propagates (never a swallowed stock drift)', async () => {
    const { manager } = fakeManager({ throwOn: 'menu' });
    await expect(
      restockCancelledOrder(manager, { id: ORDER_ID, stockDecrements: snap(['m1', 1]) }),
    ).rejects.toThrow('menu boom');
  });
});

// ---------------------------------------------------------------------------
// Service wiring — every path into `cancelled` must run the restock.
// ---------------------------------------------------------------------------

function fakeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    code: 'FO-TEST',
    userId: USER_ID,
    restaurantId: REST_ID,
    status: OrderStatus.PENDING,
    subtotalCents: 1000,
    deliveryFeeCents: 300,
    totalCents: 1300,
    discountCents: 0,
    promoCode: null,
    items: [],
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    confirmedAt: null,
    preparingAt: null,
    deliveringAt: null,
    completedAt: null,
    cancelledAt: null,
    stockDecrements: snap(['m1', 3]),
    stockRestockedAt: null,
    ...overrides,
  } as Order;
}

function buildWired(order: Order, extra: { find?: jest.Mock } = {}) {
  const { manager, query, transaction } = fakeManager({});
  const findOne = jest.fn(async ({ where }: any) => (order.id === where.id ? order : null));
  const save = jest.fn(async (x: Order) => x);
  const repo = {
    findOne,
    save,
    find: extra.find ?? jest.fn(async () => []),
    manager,
  } as unknown as Repository<Order>;
  const events = { publish: jest.fn() } as unknown as OrderEventsService & {
    publish: jest.Mock;
  };
  const restaurants = {
    findOne: jest.fn(async () => ({ id: REST_ID, ownerId: OWNER_ID } as any)),
  } as unknown as RestaurantsService;
  const service = new OrdersService(
    repo,
    {} as MenuService,
    restaurants,
    events,
    {} as PromosService,
    {} as AddressesService,
  );
  return { service, query, transaction, events, save };
}

const menuAdds = (query: jest.Mock) =>
  query.mock.calls.filter((c: any) => String(c[0]).includes('"menu_items"'));

describe('OrdersService cancel paths — restock wiring', () => {
  it('customer self-cancel returns the units', async () => {
    const { service, transaction, query } = buildWired(fakeOrder());
    const out: any = await service.cancel(ORDER_ID, USER_ID, UserRole.CUSTOMER);
    expect(out.status).toBe(OrderStatus.CANCELLED);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(menuAdds(query)).toEqual([[expect.any(String), ['m1', 3]]]);
  });

  it('owner cancel returns the units; owner CONFIRM does not touch the ledger', async () => {
    const a = buildWired(fakeOrder());
    await a.service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CANCELLED, {
      sub: OWNER_ID,
      role: UserRole.OWNER,
    });
    expect(a.transaction).toHaveBeenCalledTimes(1);
    expect(menuAdds(a.query)).toHaveLength(1);

    const b = buildWired(fakeOrder());
    await b.service.setStatusForRestaurant(REST_ID, ORDER_ID, OrderStatus.CONFIRMED, {
      sub: OWNER_ID,
      role: UserRole.OWNER,
    });
    expect(b.transaction).not.toHaveBeenCalled();
  });

  it('admin backdoor cancel returns the units; illegal transitions do not', async () => {
    const { service, transaction, query } = buildWired(fakeOrder());
    await service.updateStatus(ORDER_ID, OrderStatus.CANCELLED, {
      sub: 'admin-1',
      role: UserRole.ADMIN,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(menuAdds(query)).toHaveLength(1);

    const delivering = buildWired(
      fakeOrder({ status: OrderStatus.DELIVERING, confirmedAt: new Date(), preparingAt: new Date() }),
    );
    await expect(
      delivering.service.updateStatus(ORDER_ID, OrderStatus.CANCELLED, {
        sub: 'admin-1',
        role: UserRole.ADMIN,
      }),
    ).rejects.toThrow();
    expect(delivering.transaction).not.toHaveBeenCalled();
  });

  it('the stale sweep returns units per cancelled order', async () => {
    const NOW = new Date('2026-11-09T12:00:00Z');
    const stale = [
      fakeOrder({
        id: 'o-1',
        code: 'A',
        createdAt: new Date(NOW.getTime() - 90 * 60_000),
        stockDecrements: snap(['m1', 2]),
      }),
      fakeOrder({
        id: 'o-2',
        code: 'B',
        createdAt: new Date(NOW.getTime() - 80 * 60_000),
        stockDecrements: snap(['m2', 1]),
      }),
    ];
    const find = jest.fn(async () => stale);
    const { service, transaction, query } = buildWired(stale[0], { find });
    const report = await service.cancelStalePending({ now: NOW, staleMinutes: 45 });
    expect(report.cancelled).toBe(2);
    // ONE transaction per cancelled order — the marker CAS keeps even a
    // concurrent second sweep from double-returning the same units.
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(menuAdds(query)).toEqual([
      [expect.any(String), ['m1', 2]],
      [expect.any(String), ['m2', 1]],
    ]);
  });

  it('cancels of orders WITHOUT a snapshot (unlimited/legacy) never open a transaction', async () => {
    const { service, transaction } = buildWired(
      fakeOrder({ stockDecrements: null }),
    );
    const out: any = await service.cancel(ORDER_ID, USER_ID);
    expect(out.status).toBe(OrderStatus.CANCELLED);
    expect(transaction).not.toHaveBeenCalled();
  });
});
