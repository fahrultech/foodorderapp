// Order-code collision hardening (session 121). The k6 write ladder caught a
// REAL 500 in production code: `orders.code` is UNIQUE while generateCode()
// drew 4 chars from a 31-char alphabet (31^4 ≈ 924k) — birthday-paradox
// collisions every ~1.6k orders surfaced as duplicate-key QueryFailedErrors
// inside the create transaction. Fix: 6-char CSPRNG draws (31^6 ≈ 887M) plus
// a bounded retry that re-runs the ENTIRE unit of work with a fresh code —
// safe because the failed INSERT rolled the transaction (stock decrements
// included) and em.save re-mints the PK per attempt.
import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.entity';
import { OrderEventsService } from './order-events.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REST_ID = '11111111-1111-4111-8111-111111111111';
const CODE_RE = /^FO-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

function uniqueViolation(attempt: number): Error & { code: string } {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "UQ_orders_code" (#${attempt})`),
    { code: '23505' },
  );
}

interface Harness {
  service: OrdersService;
  transaction: jest.Mock;
  recordUsage: jest.Mock;
  publish: jest.Mock;
  attemptCodes: string[];
}

/**
 * Full create() path. `failFirst` attempts of manager.transaction throw a
 * 23505 BEFORE running the callback (mirroring the driver rejecting the
 * INSERT at commit time — the tx callback's writes were rolled back);
 * every surviving attempt records the order draft's code + calls em.save.
 */
function buildHarness(opts: { failFirst?: number } = {}): Harness {
  const attemptCodes: string[] = [];
  let draft: any = null;
  const transaction = jest.fn(async (cb: any) => {
    attemptCodes.push(draft.code);
    if (transaction.mock.calls.length <= (opts.failFirst ?? 0)) {
      throw uniqueViolation(transaction.mock.calls.length);
    }
    return cb({
      save: async (x: any) => ({ ...x, id: ORDER_ID }),
      query: async () => [[{ stock: 99 }], 1],
    });
  });
  const recordUsage = jest.fn(async () => undefined);
  const repo = {
    create: (x: any) => {
      draft = x;
      return x;
    },
    save: jest.fn(),
    findOne: jest.fn(async ({ where }: any) => ({
      id: where.id,
      code: draft.code,
      status: OrderStatus.PENDING,
      restaurantId: REST_ID,
      items: [],
    })),
    manager: { transaction },
  } as unknown as Repository<Order>;
  const menu = {
    findByIds: jest.fn(async () => [
      { id: 'm1', name: 'Nasi', priceCents: 500, isAvailable: true, restaurantId: REST_ID },
    ]),
  } as unknown as MenuService;
  const restaurants = {
    findOrderScope: jest.fn(async () => ({
      id: REST_ID,
      ownerId: OWNER_ID,
      minOrderCents: 1000,
      deliveryFeeCents: 300,
    })),
  } as unknown as RestaurantsService;
  const publish = jest.fn();
  const events = { publish } as unknown as OrderEventsService;
  const promos = {
    evaluate: jest.fn(async () => ({ ok: true, discountCents: 200, promo: { id: 'p1' } })),
    recordUsage,
  } as unknown as PromosService;
  const addresses = {} as unknown as AddressesService;
  const service = new OrdersService(repo, menu, restaurants, events, promos, addresses);
  return { service, transaction, recordUsage, publish, attemptCodes };
}

const dto = {
  restaurantId: REST_ID,
  customerName: 'A',
  contactPhone: '1',
  deliveryAddress: 'x',
  items: [{ menuItemId: 'm1', quantity: 2 }],
} as any;

describe('OrdersService.create — order-code collision retry (session 121)', () => {
  it('draws a 6-char code from the unambiguous alphabet', async () => {
    const h = buildHarness();
    await h.service.create(dto, OWNER_ID);
    expect(h.attemptCodes).toHaveLength(1);
    expect(h.attemptCodes[0]).toMatch(CODE_RE);
  });

  it('retries the whole unit of work with a FRESH code on 23505', async () => {
    const h = buildHarness({ failFirst: 2 });
    const created = await h.service.create(dto, OWNER_ID);
    expect(h.transaction).toHaveBeenCalledTimes(3);
    // fresh draw per attempt (collision of two 31^6-space draws is 1e-12,
    // and duplicates would defeat the retry — set size proves the redraw)
    expect(new Set(h.attemptCodes).size).toBe(3);
    h.attemptCodes.forEach((code) => expect(code).toMatch(CODE_RE));
    // success path unchanged: exactly ONE created-event, the saved order back
    expect(created).toMatchObject({ id: ORDER_ID });
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('gives up after the bounded attempts and RE-THROWS the violation', async () => {
    const h = buildHarness({ failFirst: 10 });
    await expect(h.service.create(dto, OWNER_ID)).rejects.toThrow(/duplicate key/);
    expect(h.transaction).toHaveBeenCalledTimes(3);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('does NOT retry non-unique failures (INSUFFICIENT_STOCK class)', async () => {
    const h = buildHarness();
    h.transaction.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(h.service.create(dto, OWNER_ID)).rejects.toThrow('deadlock');
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('still writes the promo ledger row inside the SAME (retried) tx', async () => {
    const h = buildHarness({ failFirst: 1 });
    await h.service.create({ ...dto, promoCode: 'SAVE10' }, OWNER_ID);
    expect(h.transaction).toHaveBeenCalledTimes(2);
    expect(h.recordUsage).toHaveBeenCalledTimes(1);
    expect(h.recordUsage.mock.calls[0][0]).toMatchObject({
      promoId: 'p1',
      orderId: ORDER_ID,
      userId: OWNER_ID,
      discountCents: 200,
    });
  });
});
