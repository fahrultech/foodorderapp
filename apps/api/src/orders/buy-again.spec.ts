import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { UserRole } from '../users/user.entity';
import { OrdersService } from './orders.service';
import { MenuService } from '../menu/menu.service';
import {
  BuyAgainDish,
  BuyAgainOrderedRow,
  computeBuyAgainPlan,
} from './buy-again';

/**
 * "Buy again" server-side revalidation (Phase 17, session 149). The pure
 * core owns the whole ladder (rung-for-rung mirror of the session-107 web
 * ladder, PLUS the price-drift report the client never made); the service
 * edge pins that the receipt ladder gates BEFORE any menu read — a denied
 * caller must leave the menu repo untouched.
 */

const RID = 'r1r1r1r1-1111-4111-8111-111111111111';
const OTHER_REST = 'r2r2r2r2-2222-4222-8222-222222222222';
const DISH_A = 'aaaaaaaa-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const DISH_B = 'bbbbbbbb-1b1b-4b1b-8b1b-1b1b1b1b1b1b';
const GROUP_1 = 'g1g1g1g1-1111-4111-8111-111111111111';
const CHOICE_X = 'x1x1x1x1-1111-4111-8111-111111111111';
const CHOICE_Y = 'y1y1y1y1-1111-4111-8111-111111111111';

function dish(over: Partial<BuyAgainDish> = {}): BuyAgainDish {
  return {
    id: DISH_A,
    name: 'Nasi Goreng',
    priceCents: 1800,
    isAvailable: true,
    stock: null,
    restaurantId: RID,
    optionGroups: [],
    ...over,
  };
}

function row(over: Partial<BuyAgainOrderedRow> = {}): BuyAgainOrderedRow {
  return {
    name: 'Nasi Goreng',
    quantity: 1,
    unitPriceCents: 1800,
    menuItemId: DISH_A,
    optionSelections: null,
    ...over,
  };
}

const sizeGroup = (
  over: Partial<BuyAgainDish['optionGroups'][number]> = {},
) => ({
  id: GROUP_1,
  name: 'Size',
  minChoices: 0,
  maxChoices: 1,
  choices: [
    { id: CHOICE_X, name: 'Regular', priceDeltaCents: 0 },
    { id: CHOICE_Y, name: 'Large', priceDeltaCents: 300 },
  ],
  ...over,
});

const pickedY = [
  {
    groupId: GROUP_1,
    groupName: 'Size',
    choiceId: CHOICE_Y,
    choiceName: 'Large',
    priceDeltaCents: 300,
  },
];

// ------------------------------------------------------------------ core ----

describe('computeBuyAgainPlan — rungs (mirror of the web ladder)', () => {
  it('happy single row rides with zero drift and honest totals', () => {
    const p = computeBuyAgainPlan([row()], [dish()], RID);
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({
      quantity: 1,
      requestedQuantity: 1,
      snapshotUnitPriceCents: 1800,
      currentUnitPriceCents: 1800,
      priceDeltaCents: 0,
    });
    expect(p.skipped).toEqual([]);
    expect(p.clamped).toEqual([]);
    expect(p.addedUnits).toBe(1);
    expect(p.plannedSubtotalCents).toBe(1800);
    expect(p.snapshotSubtotalCents).toBe(1800);
    expect(p.priceDriftCents).toBe(0);
  });

  it('rung 1: null menuItemId (hard delete) is gone; so is a missing row', () => {
    const p = computeBuyAgainPlan(
      [row({ menuItemId: null, name: 'Ghost' }), row({ name: 'Missing' })],
      [],
      RID,
    );
    expect(p.lines).toEqual([]);
    expect(p.skipped).toEqual([
      { name: 'Ghost', reason: 'gone' },
      { name: 'Missing', reason: 'gone' },
    ]);
  });

  it('rung 1: a dish moved to ANOTHER restaurant is gone for this order', () => {
    const p = computeBuyAgainPlan([row()], [dish({ restaurantId: OTHER_REST })], RID);
    expect(p.skipped).toEqual([{ name: 'Nasi Goreng', reason: 'gone' }]);
    expect(p.lines).toEqual([]);
  });

  it('rung 2: hidden dish -> unavailable', () => {
    const p = computeBuyAgainPlan([row()], [dish({ isAvailable: false })], RID);
    expect(p.skipped).toEqual([{ name: 'Nasi Goreng', reason: 'unavailable' }]);
  });

  it('rung 3: tracked stock at zero -> sold-out', () => {
    const p = computeBuyAgainPlan([row()], [dish({ stock: 0 })], RID);
    expect(p.skipped).toEqual([{ name: 'Nasi Goreng', reason: 'sold-out' }]);
  });

  it('rung 4: a frozen choice that vanished from its group -> options-changed', () => {
    const p = computeBuyAgainPlan(
      [row({ optionSelections: pickedY })],
      [dish({ optionGroups: [{ ...sizeGroup(), choices: sizeGroup().choices.slice(0, 1) }] })],
      RID,
    );
    expect(p.skipped).toEqual([
      { name: 'Nasi Goreng', reason: 'options-changed' },
    ]);
  });

  it('rung 4: a group deleted since the order -> options-changed', () => {
    const p = computeBuyAgainPlan(
      [row({ optionSelections: pickedY })],
      [dish({ optionGroups: [] })],
      RID,
    );
    expect(p.skipped).toEqual([
      { name: 'Nasi Goreng', reason: 'options-changed' },
    ]);
  });

  it('rung 4: a NEW mandatory group the frozen row cannot satisfy -> options-changed', () => {
    const p = computeBuyAgainPlan(
      [row()],
      [dish({ optionGroups: [sizeGroup({ minChoices: 1 })] })],
      RID,
    );
    expect(p.skipped).toEqual([
      { name: 'Nasi Goreng', reason: 'options-changed' },
    ]);
  });

  it('rung 4: selection above the CURRENT max -> options-changed', () => {
    const addons = [
      { groupId: GROUP_1, groupName: 'Add-ons', choiceId: CHOICE_X, choiceName: 'Egg', priceDeltaCents: 0 },
      { groupId: GROUP_1, groupName: 'Add-ons', choiceId: CHOICE_Y, choiceName: 'Kecap', priceDeltaCents: 0 },
    ];
    const p = computeBuyAgainPlan(
      [row({ optionSelections: addons })],
      [dish({ optionGroups: [sizeGroup({ maxChoices: 1 })] })],
      RID,
    );
    expect(p.skipped).toEqual([
      { name: 'Nasi Goreng', reason: 'options-changed' },
    ]);
  });

  it('rung 4 rides when today\'s rules still fit, repricED at CURRENT deltas', () => {
    const p = computeBuyAgainPlan(
      // Snapshot was taken when Large cost +200; today it costs +300.
      [row({ unitPriceCents: 2000, optionSelections: [pickedY[0]] })],
      [dish({ optionGroups: [sizeGroup()] })],
      RID,
    );
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].options[0].priceDeltaCents).toBe(300); // CURRENT, not snapshot
    expect(p.lines[0].currentUnitPriceCents).toBe(2100);
    expect(p.lines[0].snapshotUnitPriceCents).toBe(2000);
    expect(p.lines[0].priceDeltaCents).toBe(100);
  });
});

describe('computeBuyAgainPlan — merge, clamp, cap, drift math', () => {
  it('same dish + same selection merges into ONE line; different choice stays split', () => {
    const p = computeBuyAgainPlan(
      [
        row({ quantity: 2 }),
        row({ quantity: 3 }),
        row({
          quantity: 1,
          unitPriceCents: 2100,
          optionSelections: pickedY,
        }),
      ],
      [dish({ optionGroups: [sizeGroup()] })],
      RID,
    );
    expect(p.lines).toHaveLength(2);
    expect(p.lines[0].quantity).toBe(5); // merged plain rows
    expect(p.lines[0].requestedQuantity).toBe(5);
    expect(p.lines[1].options).toHaveLength(1); // the Large line stays separate
    expect(p.addedUnits).toBe(6);
  });

  it('merged lines ride under the 50-unit ceiling', () => {
    const p = computeBuyAgainPlan(
      [row({ quantity: 30 }), row({ quantity: 30 })],
      [dish()],
      RID,
    );
    expect(p.lines[0].quantity).toBe(50);
    expect(p.lines[0].requestedQuantity).toBe(50);
  });

  it('stock shortfall clamps AFTER merging and reports from/to', () => {
    const p = computeBuyAgainPlan(
      [row({ quantity: 2 }), row({ quantity: 2 })],
      [dish({ stock: 3 })],
      RID,
    );
    expect(p.lines[0].quantity).toBe(3);
    expect(p.lines[0].requestedQuantity).toBe(4);
    expect(p.clamped).toEqual([{ name: 'Nasi Goreng', from: 4, to: 3 }]);
    // Drift math follows the CLAMPED quantity.
    expect(p.plannedSubtotalCents).toBe(3 * 1800);
    expect(p.snapshotSubtotalCents).toBe(3 * 1800);
  });

  it('a frozen qty above stock clamps to stock even without merges', () => {
    const p = computeBuyAgainPlan([row({ quantity: 5 })], [dish({ stock: 2 })], RID);
    expect(p.lines[0].quantity).toBe(2);
    expect(p.clamped).toEqual([{ name: 'Nasi Goreng', from: 5, to: 2 }]);
  });

  it('junk quantities collapse honestly (NaN->1, 0->1, 7.9->7, 999->50)', () => {
    const p = computeBuyAgainPlan(
      [
        row({ quantity: NaN }),
        row({ quantity: 0 }),
        row({ quantity: 7.9 }),
        row({ quantity: 999 }),
      ],
      [dish()],
      RID,
    );
    // All four merge into ONE plain line; each requested value lands per rule:
    // 1 + 1 + 7 + 50, capped by LINE_CAP.
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].quantity).toBe(50);
  });

  it('a receipt that repeats one choice is de-duplicated (defensive)', () => {
    const p = computeBuyAgainPlan(
      [row({ optionSelections: [pickedY[0], pickedY[0]] })],
      [dish({ optionGroups: [sizeGroup()] })],
      RID,
    );
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].options).toHaveLength(1);
  });

  it('price drift totals per line x quantity and can go NEGATIVE', () => {
    const p = computeBuyAgainPlan(
      [
        row({ quantity: 2, unitPriceCents: 1800 }),
        row({ name: 'Teh', menuItemId: DISH_B, quantity: 1, unitPriceCents: 700 }),
      ],
      [dish({ priceCents: 2000 }), dish({ id: DISH_B, name: 'Teh', priceCents: 500 })],
      RID,
    );
    expect(p.lines[0].priceDeltaCents).toBe(200); // +100 x 2 folded in totals
    expect(p.lines[1].priceDeltaCents).toBe(-200);
    expect(p.plannedSubtotalCents).toBe(2 * 2000 + 500);
    expect(p.snapshotSubtotalCents).toBe(2 * 1800 + 700);
    expect(p.priceDriftCents).toBe(2 * 2000 + 500 - (2 * 1800 + 700));
  });

  it('non-finite snapshot prices degrade to the current unit price (zero drift, never NaN)', () => {
    const p = computeBuyAgainPlan([row({ unitPriceCents: undefined as unknown as number })], [dish()], RID);
    expect(p.lines[0].snapshotUnitPriceCents).toBe(1800);
    expect(p.lines[0].priceDeltaCents).toBe(0);
    expect(p.priceDriftCents).toBe(0);
  });

  it('empty orders answer an empty plan with zero totals', () => {
    const p = computeBuyAgainPlan([], [dish()], RID);
    expect(p).toMatchObject({
      lines: [],
      skipped: [],
      clamped: [],
      addedUnits: 0,
      plannedSubtotalCents: 0,
      snapshotSubtotalCents: 0,
      priceDriftCents: 0,
    });
  });

  it('lines keep snapshot row order (first-appearance), skips too', () => {
    const p = computeBuyAgainPlan(
      [
        row({ name: 'Second', menuItemId: DISH_B }),
        row({ name: 'Gone', menuItemId: 'missing-id' }),
        row({ name: 'First', menuItemId: DISH_A }),
        row({ name: 'Second again', menuItemId: DISH_B, quantity: 2 }),
      ],
      [dish(), dish({ id: DISH_B, name: 'Second' })],
      RID,
    );
    expect(p.lines.map((l) => l.dish.id)).toEqual([DISH_B, DISH_A]);
    expect(p.lines[0].quantity).toBe(3); // merged into the FIRST appearance
    expect(p.skipped.map((s) => s.name)).toEqual(['Gone']);
  });
});

// --------------------------------------------------------------- service ----

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_ID = '77777777-7777-4777-8777-777777777777';

function entityDish(over: Record<string, unknown> = {}) {
  // Shaped like the MenuItem ENTITY row (extra columns present) to prove the
  // response projection strips them.
  return {
    id: DISH_A,
    name: 'Nasi Goreng',
    description: 'Classic',
    priceCents: 2000,
    category: 'Mains',
    imageUrl: null,
    isAvailable: true,
    prepMinutes: 15,
    restaurantId: RID,
    stock: null,
    optionGroups: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  };
}

function buildService(
  order: Partial<Order> | null,
  dishes: Array<Record<string, unknown>>,
) {
  const repo = {
    findOne: jest.fn(async () => (order ? { ...order } : null)),
  } as unknown as Repository<Order>;
  const findExistingByIds = jest.fn(async (_ids: string[]) => dishes);
  const menu = { findExistingByIds } as unknown as MenuService;
  const noop = {} as any;
  const svc = new OrdersService(repo, menu, noop, noop, noop, noop);
  return { svc, repo, findExistingByIds };
}

const orderFixture = (items: Array<Record<string, unknown>>) =>
  ({
    id: ORDER_ID,
    code: 'FO-TEST1',
    status: OrderStatus.COMPLETED,
    userId: OWNER_ID,
    restaurantId: RID,
    contactEmail: 'guest@example.com',
    restaurant: { id: RID, name: 'Warung', minOrderCents: 1000 },
    items,
  }) as unknown as Order;

describe('OrdersService.buyAgainPlan — ladder-first wiring', () => {
  it('denied access (unknown id) answers the canonical 404 and reads NO menu row', async () => {
    const { svc, findExistingByIds } = buildService(null, []);
    await expect(svc.buyAgainPlan(ORDER_ID)).rejects.toThrow(NotFoundException);
    expect(findExistingByIds).not.toHaveBeenCalled();
  });

  it('wrong bearer + wrong proof 404s BEFORE any menu read (no oracle, no reads)', async () => {
    const order = orderFixture([]);
    const { svc, findExistingByIds } = buildService(order, []);
    await expect(
      svc.buyAgainPlan(ORDER_ID, { sub: OTHER_ID, role: UserRole.CUSTOMER }, 'nope@example.com'),
    ).rejects.toThrow(NotFoundException);
    expect(findExistingByIds).not.toHaveBeenCalled();
  });

  it('owner bearer gets the plan; dishes load with DEDUPED ids; response is complete', async () => {
    const order = orderFixture([
      { name: 'Nasi Goreng', quantity: 2, unitPriceCents: 1800, menuItemId: DISH_A, optionSelections: null },
      { name: 'Nasi Goreng', quantity: 1, unitPriceCents: 1800, menuItemId: DISH_A, optionSelections: null },
    ]);
    const { svc, findExistingByIds } = buildService(order, [entityDish()]);
    const plan = await svc.buyAgainPlan(ORDER_ID, { sub: OWNER_ID, role: UserRole.CUSTOMER });
    expect(findExistingByIds).toHaveBeenCalledTimes(1);
    expect(findExistingByIds.mock.calls[0][0]).toEqual([DISH_A]); // deduped, nulls dropped
    expect(plan).toMatchObject({
      orderId: ORDER_ID,
      orderCode: 'FO-TEST1',
      restaurant: { id: RID, name: 'Warung', minOrderCents: 1000 },
      addedUnits: 3,
      plannedSubtotalCents: 3 * 2000,
      snapshotSubtotalCents: 3 * 1800,
      priceDriftCents: 3 * 200,
    });
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].dish).toEqual({
      id: DISH_A,
      name: 'Nasi Goreng',
      description: 'Classic',
      priceCents: 2000,
      category: 'Mains',
      imageUrl: null,
      isAvailable: true,
      prepMinutes: 15,
      restaurantId: RID,
      stock: null,
      optionGroups: [],
    }); // entity timestamps STRIPPED
  });

  it('an order with no menu ids reads NOTHING from the menu repo and reports all gone', async () => {
    const order = orderFixture([
      { name: 'Ghost', quantity: 1, unitPriceCents: 900, menuItemId: null, optionSelections: null },
    ]);
    const { svc, findExistingByIds } = buildService(order, []);
    const plan = await svc.buyAgainPlan(ORDER_ID, { sub: OWNER_ID, role: UserRole.CUSTOMER });
    expect(findExistingByIds).toHaveBeenCalledWith([]);
    expect(plan.lines).toEqual([]);
    expect(plan.skipped).toEqual([{ name: 'Ghost', reason: 'gone' }]);
    expect(plan.addedUnits).toBe(0);
  });

  it('contact-email proof unlocks (rung 3) and option groups ride the projection', async () => {
    const order = orderFixture([
      {
        name: 'Nasi Goreng',
        quantity: 1,
        unitPriceCents: 2100,
        menuItemId: DISH_A,
        optionSelections: pickedY,
      },
    ]);
    const groups = [
      {
        id: GROUP_1,
        name: 'Size',
        minChoices: 0,
        maxChoices: 1,
        position: 0,
        choices: [
          { id: CHOICE_X, name: 'Regular', priceDeltaCents: 0, position: 0 },
          { id: CHOICE_Y, name: 'Large', priceDeltaCents: 300, position: 1 },
        ],
      },
    ];
    const { svc } = buildService(order, [entityDish({ priceCents: 1800, optionGroups: groups })]);
    const plan = await svc.buyAgainPlan(ORDER_ID, undefined, ' Guest@Example.com ');
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({
      currentUnitPriceCents: 2100,
      snapshotUnitPriceCents: 2100,
      priceDeltaCents: 0,
    });
    expect(plan.lines[0].options).toEqual([
      { groupId: GROUP_1, groupName: 'Size', choiceId: CHOICE_Y, choiceName: 'Large', priceDeltaCents: 300 },
    ]);
    expect(plan.lines[0].dish.optionGroups).toEqual(groups); // full public shape
  });

  it('a null restaurant edge degrades honestly (name null, min 0) instead of 500', async () => {
    const order = orderFixture([]);
    (order as any).restaurant = null;
    const { svc } = buildService(order, []);
    const plan = await svc.buyAgainPlan(ORDER_ID, { sub: OWNER_ID, role: UserRole.CUSTOMER });
    expect(plan.restaurant).toEqual({ id: RID, name: null, minOrderCents: 0 });
  });
});
