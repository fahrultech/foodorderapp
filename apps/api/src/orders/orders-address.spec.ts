import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.entity';
import { OrderEventsService } from './order-events.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';
import { DeliveryAddress } from '../users/delivery-address.entity';

/**
 * Focused coverage of the saved-address hook inside create(): the server
 * copies its OWN stored text for name/phone/address and ignores whatever the
 * client echoed alongside `deliveryAddressId`. Book CRUD semantics themselves
 * live in addresses.service.spec.ts.
 */
const REST_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADDR_ID = '99999999-9999-4999-8999-999999999999';

function savedAddress(overrides: Partial<DeliveryAddress> = {}): DeliveryAddress {
  return {
    id: ADDR_ID,
    userId: USER_ID,
    label: 'Home',
    recipientName: 'Ada Lovelace',
    phone: '+62 811 000 1111',
    address: 'Jl. Sudirman No. 1, Jakarta',
    isDefault: true,
    ...overrides,
  } as DeliveryAddress;
}

function buildCreate(addressRow: DeliveryAddress | null) {
  const createdRows: any[] = [];
  const repo = {
    create: (x: any) => {
      createdRows.push(x);
      return x;
    },
    save: jest.fn(async (x: any) => ({ ...x, id: ORDER_ID })),
    findOne: jest.fn(async () => ({
      id: ORDER_ID,
      code: 'FO-TEST',
      restaurantId: REST_ID,
      status: OrderStatus.PENDING,
    })),
  } as unknown as Repository<Order>;
  const menu = {
    findByIds: jest.fn(async () => [
      { id: 'm1', name: 'Nasi', priceCents: 500, isAvailable: true, restaurantId: REST_ID },
    ]),
  } as unknown as MenuService;
  const restaurants = {
    findOne: jest.fn(async () => ({
      id: REST_ID,
      minOrderCents: 1000,
      deliveryFeeCents: 300,
    })),
  } as unknown as RestaurantsService;
  const promos = { evaluate: jest.fn() } as unknown as PromosService;
  const events = { publish: jest.fn() } as unknown as OrderEventsService;
  const getOwned = jest.fn(async () => {
    if (!addressRow) throw new NotFoundException('Delivery address not found');
    return addressRow;
  });
  const addresses = { getOwned } as unknown as AddressesService;
  const service = new OrdersService(repo, menu, restaurants, events, promos, addresses);
  return { service, createdRows, getOwned };
}

const dto = (over: Record<string, unknown> = {}) =>
  ({
    restaurantId: REST_ID,
    customerName: 'A',
    contactPhone: '+62 812 3456 7890',
    deliveryAddress: 'x',
    items: [{ menuItemId: 'm1', quantity: 2 }],
    ...over,
  }) as any;

describe('OrdersService.create — saved delivery address', () => {
  it('copies the SERVER-side stored text and ignores the client echo', async () => {
    const { service, createdRows, getOwned } = buildCreate(savedAddress());
    await service.create(
      dto({
        deliveryAddressId: ADDR_ID,
        // Deliberately hostile echoes — none of these may reach the order.
        customerName: 'Impostor',
        contactPhone: '+62 800 000 0000',
        deliveryAddress: 'Jl. Someone Else 666',
      }),
      USER_ID,
    );
    expect(getOwned).toHaveBeenCalledWith(USER_ID, ADDR_ID);
    expect(createdRows[0]).toMatchObject({
      customerName: 'Ada Lovelace',
      contactPhone: '+62 811 000 1111',
      deliveryAddress: 'Jl. Sudirman No. 1, Jakarta',
      userId: USER_ID,
    });
  });

  it('works when the client sends NO contact fields at all (picker-only payload)', async () => {
    const { service, createdRows } = buildCreate(savedAddress());
    await service.create(dto({ deliveryAddressId: ADDR_ID, customerName: undefined, contactPhone: undefined, deliveryAddress: undefined }), USER_ID);
    expect(createdRows[0]).toMatchObject({
      customerName: 'Ada Lovelace',
      deliveryAddress: 'Jl. Sudirman No. 1, Jakarta',
    });
  });

  it('rejects a guest (no JWT subject) that names an address id with 400', async () => {
    const { service, getOwned } = buildCreate(savedAddress());
    await expect(service.create(dto({ deliveryAddressId: ADDR_ID }), undefined)).rejects.toThrow(
      /signed-in customer/,
    );
    expect(getOwned).not.toHaveBeenCalled();
  });

  it('404s an unknown/foreign address id — restaurant is never even looked up', async () => {
    const { service } = buildCreate(null);
    await expect(service.create(dto({ deliveryAddressId: ADDR_ID }), USER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('without an address id all three contact fields stay required, listing what is missing', async () => {
    const { service } = buildCreate(savedAddress());
    await expect(service.create(dto({ customerName: undefined, deliveryAddress: '' }), undefined)).rejects.toThrow(
      /customerName, deliveryAddress/,
    );
  });

  it('the explicit contact path still works unchanged for guests', async () => {
    const { service, createdRows, getOwned } = buildCreate(savedAddress());
    await service.create(dto(), undefined);
    expect(getOwned).not.toHaveBeenCalled();
    expect(createdRows[0]).toMatchObject({
      customerName: 'A',
      contactPhone: '+62 812 3456 7890',
      deliveryAddress: 'x',
      userId: null,
    });
  });
});
