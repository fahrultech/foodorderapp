import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.entity';
import { OrderEventsService } from './order-events.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';
import { AppException } from '../common/app-exception';

/**
 * Unit-of-work (docs/ROADMAP.md Phase 5, session 71): create() must run
 * every mutation — stock decrements, the order+items rows, the promo
 * ledger row — inside ONE manager.transaction, and the stock guard must
 * answer a stable 409 INSUFFICIENT_STOCK when the conditional UPDATE
 * matches zero rows. Real DB atomicity/rollback is proven by the live
 * smoke (DEVLOG session 71); these specs pin the ORCHESTRATION: what
 * runs where, in which order, and that a rejected order writes nothing.
 */
const REST_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface FakeItem {
  id: string;
  name: string;
  priceCents: number;
  isAvailable: boolean;
  restaurantId: string;
  stock?: number | null;
}

/**
 * @param items menu items returned by the (mocked) pricing read
 * @param stockOutcome canned rows for every stock UPDATE; [] = the
 *        conditional UPDATE matched nothing (= guard trips)
 */
function buildTx(opts: {
  items: FakeItem[];
  stockOutcome?: Array<{ stock: number }>;
  recordUsage?: jest.Mock;
  promoDiscount?: number;
}) {
  const calls: string[] = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push(`stock:${String(params?.[0])}x${String(params?.[1])}`);
    // REAL driver shape this stack returns for UPDATE...RETURNING: a
    // [rows, rowCount] tuple — a 0-row MISS is [[], 0], length 2. Mocks
    // that fake a plain []/[{...}] hide guard bugs (session 71 lesson).
    const rows = opts.stockOutcome ?? [];
    return [rows, rows.length];
  });
  const emSave = jest.fn(async (x: any) => {
    calls.push('save');
    return { ...x, id: ORDER_ID };
  });
  const fakeEm = { save: emSave, query };
  const transaction = jest.fn(async (cb: any) => {
    calls.push('tx:begin');
    const out = await cb(fakeEm);
    calls.push('tx:end');
    return out;
  });
  const repo = {
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => ({ ...x, id: ORDER_ID })),
    findOne: jest.fn(async () => ({
      id: ORDER_ID,
      code: 'FO-TEST',
      restaurantId: REST_ID,
      status: OrderStatus.PENDING,
    })),
    manager: { transaction },
  } as unknown as Repository<Order> & {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  const menu = {
    findByIds: jest.fn(async () => opts.items),
  } as unknown as MenuService;
  const restaurants = {
    findOne: jest.fn(async () => ({
      id: REST_ID,
      minOrderCents: 0,
      deliveryFeeCents: 300,
    })),
  } as unknown as RestaurantsService;
  const recordUsage = opts.recordUsage ?? jest.fn(async () => ({}));
  const evaluate = jest.fn(async () => ({
    ok: true as const,
    message: 'ok',
    discountCents: opts.promoDiscount ?? 0,
    promo: { id: 'p-1' } as any,
  }));
  const promos = { evaluate, recordUsage } as unknown as PromosService;
  const publish = jest.fn();
  const events = { publish } as unknown as OrderEventsService;
  const addresses = { getOwned: jest.fn() } as unknown as AddressesService;
  const service = new OrdersService(repo, menu, restaurants, events, promos, addresses);
  return { service, repo, fakeEm, calls, query, emSave, recordUsage, publish, transaction };
}

const dto = (items: Array<{ menuItemId: string; quantity: number }>, promoCode?: string) =>
  ({
    restaurantId: REST_ID,
    customerName: 'A',
    contactPhone: '1',
    deliveryAddress: 'x',
    items,
    ...(promoCode ? { promoCode } : {}),
  }) as any;

const item = (id: string, over: Partial<FakeItem> = {}): FakeItem => ({
  id,
  name: `Dish ${id}`,
  priceCents: 500,
  isAvailable: true,
  restaurantId: REST_ID,
  ...over,
});

describe('OrdersService.create — unit-of-work transaction (session 71)', () => {
  it('runs the order save inside ONE manager.transaction and never via plain repo.save', async () => {
    const { service, repo, fakeEm, transaction, emSave, calls } = buildTx({
      items: [item('m1')],
    });
    await service.create(dto([{ menuItemId: 'm1', quantity: 2 }]), USER_ID);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(emSave).toHaveBeenCalledTimes(1);
    expect(repo.save).not.toHaveBeenCalled();
    // recordUsage never got called (no promo) and the emit happened AFTER
    // the transaction — publish order matters for live-feed consistency.
    expect(calls).toEqual(['tx:begin', 'save', 'tx:end']);
    expect(fakeEm.query).not.toHaveBeenCalled(); // unlimited dish → no stock SQL
  });

  it('decrements ONLY stock-managed dishes, aggregating duplicate cart lines', async () => {
    const { service, calls } = buildTx({
      items: [
        item('m-limited', { stock: 10 }),
        item('m-unlimited', { stock: null }),
        item('m-legacy' /* stock absent on the entity mock */),
      ],
      stockOutcome: [{ stock: 7 }],
    });
    await service.create(
      dto([
        { menuItemId: 'm-limited', quantity: 1 },
        { menuItemId: 'm-unlimited', quantity: 2 },
        { menuItemId: 'm-legacy', quantity: 3 },
        { menuItemId: 'm-limited', quantity: 2 }, // second line of the SAME dish
      ]),
      USER_ID,
    );
    // exactly ONE decrement for m-limited with the SUMMED quantity (1+2=3);
    // null and undefined stock never earn a SQL row lock.
    expect(calls.filter((c) => c.startsWith('stock:'))).toEqual(['stock:m-limitedx3']);
  });

  it('decrements multiple dishes in sorted-id order (deterministic lock sequence)', async () => {
    const { service, calls } = buildTx({
      items: [item('zz', { stock: 5 }), item('aa', { stock: 5 })],
      stockOutcome: [{ stock: 4 }],
    });
    await service.create(
      dto([
        { menuItemId: 'zz', quantity: 1 },
        { menuItemId: 'aa', quantity: 1 },
      ]),
      USER_ID,
    );
    expect(calls.filter((c) => c.startsWith('stock:'))).toEqual(['stock:aax1', 'stock:zzx1']);
  });

  it('the guard IS the UPDATE: stock >= requested lives in the WHERE clause', async () => {
    const { service, query } = buildTx({
      items: [item('m1', { stock: 2 })],
      stockOutcome: [{ stock: 0 }],
    });
    await service.create(dto([{ menuItemId: 'm1', quantity: 2 }]), USER_ID);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('UPDATE "menu_items" SET "stock" = "stock" - $2');
    expect(sql).toContain('"stock" IS NOT NULL AND "stock" >= $2');
    expect(sql).toContain('RETURNING');
    expect(params).toEqual(['m1', 2]);
  });

  it('zero-row UPDATE -> 409 INSUFFICIENT_STOCK and NOTHING else in the tx runs', async () => {
    const { service, repo, emSave, recordUsage, publish, calls } = buildTx({
      items: [item('m1', { stock: 2 })],
      stockOutcome: [], // conditional UPDATE matched nothing
      promoDiscount: 100,
    });
    const err = await service
      .create(dto([{ menuItemId: 'm1', quantity: 3 }], 'WELCOME10'), USER_ID)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppException);
    expect(err.getStatus()).toBe(409);
    expect(err.code).toBe('INSUFFICIENT_STOCK');
    expect(err.details).toEqual({ menuItemId: 'm1', requested: 3, stockAtRead: 2 });
    expect(emSave).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(repo.findOne).not.toHaveBeenCalled(); // no post-tx refetch
    expect(publish).not.toHaveBeenCalled(); // no live-feed event
    // tx opened, guard tripped inside the callback — the fake rethrows,
    // which is exactly how a real transaction aborts (nothing after the
    // guard runs; the DB rolls back everything the tx had done).
    expect(calls).toEqual(['tx:begin', 'stock:m1x3']);
  });

  it('a stock-0 dish is never sellable (guard trips before any money moves)', async () => {
    const { service } = buildTx({
      items: [item('m1', { stock: 0 })],
      stockOutcome: [],
    });
    await expect(service.create(dto([{ menuItemId: 'm1', quantity: 1 }]))).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('a failing ledger row propagates out of create — the tx rejects and nothing emits', async () => {
    const boom = new Error('ledger exploded');
    const { service, publish, repo } = buildTx({
      items: [item('m1')],
      recordUsage: jest.fn(async () => {
        throw boom;
      }),
    });
    await expect(
      service.create(dto([{ menuItemId: 'm1', quantity: 2 }], 'WELCOME10'), USER_ID),
    ).rejects.toBe(boom);
    expect(publish).not.toHaveBeenCalled();
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('promo ledger runs IN the same transaction as the order save', async () => {
    const { service, fakeEm, recordUsage, calls } = buildTx({
      items: [item('m1')],
      promoDiscount: 100,
    });
    await service.create(dto([{ menuItemId: 'm1', quantity: 4 }], 'WELCOME10'), USER_ID);
    expect(recordUsage).toHaveBeenCalledWith(
      { promoId: 'p-1', orderId: ORDER_ID, userId: USER_ID, discountCents: 100 },
      fakeEm,
    );
    // save BEFORE recordUsage, both INSIDE tx:begin..tx:end
    expect(calls).toEqual(['tx:begin', 'save', 'tx:end']);
  });

  it('the stock decrement runs BEFORE the order save (fail-fast, minimal lock window)', async () => {
    const { service, calls } = buildTx({
      items: [item('m1', { stock: 9 })],
      stockOutcome: [{ stock: 7 }],
    });
    await service.create(dto([{ menuItemId: 'm1', quantity: 2 }]));
    expect(calls).toEqual(['tx:begin', 'stock:m1x2', 'save', 'tx:end']);
  });
});
