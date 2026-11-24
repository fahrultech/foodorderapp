import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { UserRole } from '../users/user.entity';
import { OrdersService, normalizeContactEmail } from './orders.service';
import { RequestContext, runWithRequestContext } from '../common/logging/request-context';

/**
 * Phase 6 ownership fix for the public receipt read (`GET /orders/:id`):
 * knowing the uuid is NOT access. The ladder — ADMIN bearer, owning customer
 * bearer, exact contact-email proof — is specced here at the service edge
 * (`findOneForViewer`); the HTTP wiring (OptionalJwtAuthGuard + query param)
 * is covered live in the session smoke. Every denial must be the SAME 404
 * an unknown id produces, so the route never confirms existence.
 */

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_ID = '77777777-7777-4777-8777-777777777777';

function build(order: Partial<Order> | null) {
  const repo = {
    findOne: jest.fn(async () => (order ? { ...order } : null)),
  } as unknown as Repository<Order>;
  const noop = {} as any;
  return new OrdersService(repo, noop, noop, noop, noop, noop);
}

const owned = (over: Partial<Order> = {}): Order =>
  ({
    id: ORDER_ID,
    code: 'FO-TEST1',
    status: OrderStatus.PENDING,
    userId: OWNER_ID,
    contactEmail: 'guest@example.com',
    items: [],
    ...over,
  }) as unknown as Order;

describe('normalizeContactEmail', () => {
  it('trims + lowercases; empty-ish collapses to null', () => {
    expect(normalizeContactEmail('  Guest@Example.COM ')).toBe('guest@example.com');
    expect(normalizeContactEmail('')).toBeNull();
    expect(normalizeContactEmail('   ')).toBeNull();
    expect(normalizeContactEmail(undefined)).toBeNull();
    expect(normalizeContactEmail(null)).toBeNull();
  });
});

describe('OrdersService.findOneForViewer — receipt access ladder', () => {
  it('ladder 1: ADMIN bearer reads any owned order without a proof', async () => {
    const svc = build(owned());
    const order = await svc.findOneForViewer(ORDER_ID, { sub: OTHER_ID, role: UserRole.ADMIN });
    expect(order.id).toBe(ORDER_ID);
  });

  it('ladder 2: the owning customer bearer reads their order without a proof', async () => {
    const svc = build(owned());
    const order = await svc.findOneForViewer(ORDER_ID, { sub: OWNER_ID, role: UserRole.CUSTOMER });
    expect(order.id).toBe(ORDER_ID);
  });

  it('ladder 3: a guest presenting the stored email (any case/whitespace) gets it', async () => {
    const svc = build(owned());
    const order = await svc.findOneForViewer(ORDER_ID, undefined, '  GUEST@example.COM ');
    expect(order.id).toBe(ORDER_ID);
  });

  it('ladder 3 also works alongside an unrelated bearer (OWNER-role oversight link)', async () => {
    const svc = build(owned());
    const order = await svc.findOneForViewer(
      ORDER_ID,
      { sub: OTHER_ID, role: UserRole.OWNER },
      'guest@example.com',
    );
    expect(order.id).toBe(ORDER_ID);
  });

  it('foreign bearer WITHOUT proof is the same 404 as an unknown id', async () => {
    const svc = build(owned());
    await expect(
      svc.findOneForViewer(ORDER_ID, { sub: OTHER_ID, role: UserRole.CUSTOMER }),
    ).rejects.toThrow(NotFoundException);
    const missing = build(null);
    const e1: NotFoundException = await svc
      .findOneForViewer(ORDER_ID, { sub: OTHER_ID, role: UserRole.CUSTOMER })
      .catch((e) => e);
    const e2: NotFoundException = await missing.findOneForViewer(ORDER_ID).catch((e) => e);
    expect(e1.message).toBe(e2.message); // no existence oracle
  });

  it('wrong proof email is 404; the stored value itself is never echoed in the error', async () => {
    const svc = build(owned());
    const err: NotFoundException = await svc
      .findOneForViewer(ORDER_ID, undefined, 'intruder@example.com')
      .catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('Order not found');
  });

  it('legacy order with NULL stored email has no guest rung — proof attempts 404', async () => {
    const svc = build(owned({ contactEmail: null }));
    await expect(svc.findOneForViewer(ORDER_ID, undefined, 'guest@example.com')).rejects.toThrow(
      NotFoundException,
    );
    await expect(svc.findOneForViewer(ORDER_ID, undefined, '')).rejects.toThrow(
      NotFoundException,
    );
    // …while the owner bearer still reads it.
    const order = await svc.findOneForViewer(ORDER_ID, { sub: OWNER_ID });
    expect(order.id).toBe(ORDER_ID);
  });

  it('guest order (userId NULL) is owner-token-inert and proof-gated', async () => {
    const svc = build(owned({ userId: null }));
    await expect(
      svc.findOneForViewer(ORDER_ID, { sub: OWNER_ID, role: UserRole.CUSTOMER }),
    ).rejects.toThrow(NotFoundException);
    const order = await svc.findOneForViewer(ORDER_ID, undefined, 'guest@example.com');
    expect(order.id).toBe(ORDER_ID);
  });

  it('a malformed id 404s before the ladder is consulted', async () => {
    const svc = build(owned());
    await expect(svc.findOneForViewer('not-a-uuid', undefined, 'guest@example.com')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('never touches the repo twice or on a second order', async () => {
    const repo = { findOne: jest.fn(async () => owned()) } as unknown as Repository<Order>;
    const noop = {} as any;
    const svc = new OrdersService(repo, noop, noop, noop, noop, noop);
    await svc.findOneForViewer(ORDER_ID, undefined, 'guest@example.com');
    expect(repo.findOne).toHaveBeenCalledTimes(1);
    expect((repo.findOne as jest.Mock).mock.calls[0][0]).toEqual({
      where: { id: ORDER_ID },
      relations: { items: true, restaurant: true },
    });
  });
});

/**
 * Order-centric metrics attribution (Phase 8, session 125): the receipt
 * read addresses the restaurant one join away (order.restaurantId), so the
 * AUTHORIZED rungs stamp it explicitly for the finish-time fold — while a
 * denied viewer (the same 404 as an unknown id) must stamp NOTHING, so
 * the no-existence-oracle doctrine holds inside the owner's traffic view.
 */
describe('OrdersService.findOneForViewer — order-centric attribution stamp (session 125)', () => {
  const ATTR_RID = '12121212-1212-4121-8121-121212121212';

  it('every authorized rung stamps the loaded restaurant', async () => {
    let ctx: RequestContext = { reqId: 'own-1' };
    await runWithRequestContext(ctx, () =>
      build(owned({ restaurantId: ATTR_RID })).findOneForViewer(ORDER_ID, {
        sub: OTHER_ID,
        role: UserRole.ADMIN,
      }),
    );
    expect(ctx.attributedRestaurantId).toBe(ATTR_RID);

    ctx = { reqId: 'own-2' };
    await runWithRequestContext(ctx, () =>
      build(owned({ restaurantId: ATTR_RID })).findOneForViewer(ORDER_ID, {
        sub: OWNER_ID,
        role: UserRole.CUSTOMER,
      }),
    );
    expect(ctx.attributedRestaurantId).toBe(ATTR_RID);

    ctx = { reqId: 'own-3' };
    await runWithRequestContext(ctx, () =>
      build(owned({ restaurantId: ATTR_RID })).findOneForViewer(ORDER_ID, undefined, 'GUEST@example.com '),
    );
    expect(ctx.attributedRestaurantId).toBe(ATTR_RID);
  });

  it('a denied viewer 404s and stamps NOTHING (probes cannot even top up the owner 4xx row)', async () => {
    const ctx: RequestContext = { reqId: 'own-deny' };
    await expect(
      runWithRequestContext(ctx, () =>
        build(owned({ restaurantId: ATTR_RID })).findOneForViewer(ORDER_ID, {
          sub: OTHER_ID,
          role: UserRole.CUSTOMER,
        }),
      ),
    ).rejects.toThrow(NotFoundException);
    expect(ctx.attributedRestaurantId).toBeUndefined();
  });

  it('an order without a restaurant id (legacy null) stays inert, never a junk bucket', async () => {
    const ctx: RequestContext = { reqId: 'own-null' };
    await runWithRequestContext(ctx, () =>
      build(owned({ restaurantId: null })).findOneForViewer(ORDER_ID, {
        sub: OWNER_ID,
        role: UserRole.CUSTOMER,
      }),
    );
    expect(ctx.attributedRestaurantId).toBeUndefined();
  });
});

/**
 * Tracking-page delivery polish (Phase 12, session 119). The `delivery`
 * embed rides ONLY the viewer read and ONLY `delivering` orders; every
 * degraded sub-read answers inside the view, never a 500 receipt.
 */
describe('OrdersService.findOneForViewer — delivery embed', () => {
  const RID = '88888888-8888-4888-8888-888888888888';
  const DRIVER_ID = '99999999-9999-4999-8999-999999999999';

  const delivering = (over: Partial<Order> = {}): Order =>
    ({
      id: ORDER_ID,
      code: 'FO-TEST2',
      status: OrderStatus.DELIVERING,
      userId: OWNER_ID,
      restaurantId: RID,
      driverId: DRIVER_ID,
      contactEmail: 'guest@example.com',
      confirmedAt: new Date('2026-11-23T07:50:00.000Z'),
      createdAt: new Date('2026-11-23T07:30:00.000Z'),
      restaurant: { id: RID, avgPrepMinutes: 25 },
      items: [],
      ...over,
    }) as unknown as Order;

  function buildRich(order: Order, queryImpl?: jest.Mock, driverName?: string | null) {
    const query =
      queryImpl ??
      jest.fn(async () => [{ rid: RID, samples: '9', median_seconds: '1200' }]);
    const repo = {
      findOne: jest.fn(async () => order),
      query,
    } as unknown as Repository<Order>;
    const noop = {} as any;
    const users =
      driverName === undefined
        ? undefined
        : ({ findById: jest.fn(async () => ({ name: driverName })) } as any);
    // 6 legacy noops + payments + config + users (constructor positional order).
    const svc = new OrdersService(repo as any, noop, noop, noop, noop, noop, noop, noop, users);
    return { svc, query };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-23T08:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('delivering order via the proof rung carries the full honest view', async () => {
    const { svc, query } = buildRich(delivering(), undefined, 'Demo Driver');
    const order = await svc.findOneForViewer(ORDER_ID, undefined, 'guest@example.com');
    expect(query).toHaveBeenCalledWith(expect.any(String), [[RID]]);
    expect((order as any).delivery).toEqual({
      driverFirstName: 'Demo',
      etaSource: 'observed',
      sampleCount: 9,
      remainingMinutes: 10, // median 1200s - 600s elapsed -> 600s -> ceil 10
    });
  });

  it('bearer-owner rung embeds identically (single attach point)', async () => {
    const { svc } = buildRich(delivering(), undefined, 'Demo Driver');
    const order = await svc.findOneForViewer(ORDER_ID, { sub: OWNER_ID, role: UserRole.CUSTOMER });
    expect((order as any).delivery.driverFirstName).toBe('Demo');
  });

  it('every NON-delivering status ships byte-identical: no query, no key', async () => {
    for (const status of [
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      OrderStatus.PREPARING,
      OrderStatus.COMPLETED,
      OrderStatus.CANCELLED,
    ]) {
      const { svc, query } = buildRich(delivering({ status }), undefined, 'Demo Driver');
      const order = await svc.findOneForViewer(ORDER_ID, { sub: OWNER_ID, role: UserRole.CUSTOMER });
      expect(query).not.toHaveBeenCalled();
      expect('delivery' in order).toBe(false);
    }
  });

  it('failed aggregate read degrades INSIDE the view (driver line survives, route stays 200)', async () => {
    const boom = jest.fn(async () => {
      throw new Error('db down');
    });
    const { svc } = buildRich(delivering(), boom, 'Rudi Santoso');
    const order = await svc.findOneForViewer(ORDER_ID, { sub: OWNER_ID, role: UserRole.CUSTOMER });
    expect((order as any).delivery).toEqual({
      driverFirstName: 'Rudi',
      etaSource: null,
      sampleCount: 0,
      remainingMinutes: null,
    });
  });

  it('unassigned order still gets a view: eta without a name', async () => {
    const { svc } = buildRich(delivering({ driverId: null }), undefined, 'Demo Driver');
    const order = await svc.findOneForViewer(ORDER_ID, { sub: OWNER_ID, role: UserRole.CUSTOMER });
    expect((order as any).delivery.driverFirstName).toBeNull();
    expect((order as any).delivery.etaSource).toBe('observed');
  });

  it('no users service injected (harness shape): name null, ETA still derived', async () => {
    const { svc } = buildRich(delivering());
    const order = await svc.findOneForViewer(ORDER_ID, { sub: OWNER_ID, role: UserRole.CUSTOMER });
    expect((order as any).delivery).toEqual({
      driverFirstName: null,
      etaSource: 'observed',
      sampleCount: 9,
      remainingMinutes: 10,
    });
  });

  it('a DENIED viewer never runs the embed reads', async () => {
    const query = jest.fn(async () => []);
    const { svc } = buildRich(delivering(), query, 'Demo Driver');
    await expect(
      svc.findOneForViewer(ORDER_ID, { sub: OTHER_ID, role: UserRole.CUSTOMER }),
    ).rejects.toThrow(NotFoundException);
    expect(query).not.toHaveBeenCalled();
  });
});
