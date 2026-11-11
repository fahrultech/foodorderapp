import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { UserRole } from '../users/user.entity';
import { OrdersService, normalizeContactEmail } from './orders.service';

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
