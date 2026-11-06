import { Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { OrdersService } from './orders.service';
import { MenuService } from '../menu/menu.service';
import { MenuOptionService } from '../menu/menu-option.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { OrderEventsService } from './order-events.service';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';

const REST_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = 'u1';

/**
 * Phase 5 menu-option pricing through the real order path: the option
 * service result is INDEX-ALIGNED with dto.items, its deltas fold into
 * unitPriceCents/subtotal/total server-side, and the receipt snapshot is
 * stored on the line. A fake MenuOptionService isolates the wiring; the
 * validation itself is specced in menu-option.service.spec.
 */
function buildCreate(input: {
  resolve: jest.Mock;
}) {
  let captured: any = null;
  const repo = {
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => {
      captured = x;
      return { ...x, id: ORDER_ID };
    }),
    findOne: jest.fn(async () => ({ ...captured, id: ORDER_ID, status: OrderStatus.PENDING })),
  } as unknown as Repository<Order>;
  const menu = {
    findByIds: jest.fn(async () => [
      {
        id: ITEM_ID,
        name: 'Nasi Goreng',
        priceCents: 1800,
        isAvailable: true,
        restaurantId: REST_ID,
      },
    ]),
  } as unknown as MenuService;
  const restaurants = {
    findOne: jest.fn(async () => ({
      id: REST_ID,
      ownerId: 'own',
      minOrderCents: 1000,
      deliveryFeeCents: 300,
    })),
  } as unknown as RestaurantsService;
  const events = { publish: jest.fn() } as unknown as OrderEventsService;
  const promos = {} as PromosService;
  const addresses = {} as AddressesService;
  const optionPricing = {
    resolveSelections: input.resolve,
  } as unknown as MenuOptionService;
  // Positional tail matches the constructor: payments/config/users/audits
  // undefined, optionPricing last.
  return new OrdersService(
    repo, menu, restaurants, events, promos, addresses,
    undefined, undefined, undefined, undefined, optionPricing,
  );
}

const contact = {
  restaurantId: REST_ID,
  customerName: 'A',
  contactPhone: '0812345678',
  deliveryAddress: 'Jl. Test 1',
};

describe('OrdersService.create — menu-option pricing (Phase 5)', () => {
  it('folds resolved deltas into unit price, subtotal and total, and stores the receipt', async () => {
    const snapshot = {
      groupId: 'g1',
      groupName: 'Size',
      choiceId: 'cL',
      choiceName: 'Large',
      priceDeltaCents: 350,
    };
    const resolve = jest.fn(async () => [{ extraCents: 350, selections: [snapshot] }]);
    const service = buildCreate({ resolve });
    await service.create(
      {
        ...contact,
        items: [{ menuItemId: ITEM_ID, quantity: 2, optionChoiceIds: ['cL'] }],
      } as any,
      USER_ID,
    );
    expect(resolve).toHaveBeenCalledWith([
      { menuItemId: ITEM_ID, quantity: 2, optionChoiceIds: ['cL'] },
    ]);
    // What OrdersService built for persistence:
    const repo: any = (service as any).orders;
    const saved = repo.create.mock.calls[0][0];
    expect(saved.items[0]).toEqual({
      menuItemId: ITEM_ID,
      name: 'Nasi Goreng',
      unitPriceCents: 2150, // 1800 base + 350 delta — server-side, never client-sent
      quantity: 2,
      optionSelections: [snapshot],
    });
    expect(saved.subtotalCents).toBe(4300);
    expect(saved.totalCents).toBe(4300 + 300); // discount 0 + delivery fee
  });

  it('lines without options resolve to empty selections and a null receipt', async () => {
    const resolve = jest.fn(async () => [{ extraCents: 0, selections: [] }]);
    const service = buildCreate({ resolve });
    await service.create({ ...contact, items: [{ menuItemId: ITEM_ID, quantity: 1 }] } as any, USER_ID);
    const repo: any = (service as any).orders;
    const saved = repo.create.mock.calls[0][0];
    expect(saved.items[0].unitPriceCents).toBe(1800);
    expect(saved.items[0].optionSelections).toBeNull();
  });

  it('option errors propagate — resolveSelections 400 aborts the order', async () => {
    const resolve = jest.fn(async () => {
      throw new (require('@nestjs/common').BadRequestException)(
        '"Size" requires at least 1 selection(s) on this dish',
      );
    });
    const service = buildCreate({ resolve });
    await expect(
      service.create({ ...contact, items: [{ menuItemId: ITEM_ID, quantity: 1 }] } as any, USER_ID),
    ).rejects.toThrow('requires at least 1');
    const repo: any = (service as any).orders;
    expect(repo.save).not.toHaveBeenCalled(); // nothing persisted on rejection
  });

  it('pre-options harness construction (no optionPricing arg) keeps old behavior', async () => {
    let captured: any = null;
    const repo = {
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => {
        captured = x;
        return { ...x, id: ORDER_ID };
      }),
      findOne: jest.fn(async () => ({ ...captured, id: ORDER_ID })),
    } as unknown as Repository<Order>;
    const menu = {
      findByIds: jest.fn(async () => [
        { id: ITEM_ID, name: 'Nasi', priceCents: 1800, isAvailable: true, restaurantId: REST_ID },
      ]),
    } as unknown as MenuService;
    const restaurants = {
      findOne: jest.fn(async () => ({ id: REST_ID, ownerId: 'own', minOrderCents: 1000, deliveryFeeCents: 300 })),
    } as unknown as RestaurantsService;
    const service = new OrdersService(
      repo, menu, restaurants,
      { publish: jest.fn() } as unknown as OrderEventsService,
      {} as PromosService,
      {} as AddressesService,
    );
    await service.create({ ...contact, items: [{ menuItemId: ITEM_ID, quantity: 3 }] } as any, USER_ID);
    const created: any = (repo as any).create.mock.calls[0][0];
    expect(created.items[0].unitPriceCents).toBe(1800);
    expect(created.items[0].optionSelections).toBeNull();
    expect(created.subtotalCents).toBe(5400);
  });
});
