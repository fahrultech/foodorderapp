import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.entity';
import { OrderEventsService } from './order-events.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { PromosService } from '../promos/promos.service';

/**
 * Focused coverage of the promo hook inside create(): who computes the
 * discount, when it is consulted, and what lands on the order row. The
 * evaluate() math itself is covered in promos.service.spec.ts.
 */
const REST_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '55555555-5555-4555-8555-555555555555';

function buildCreate(opts: {
  minOrderCents?: number;
  priceCents?: number;
  evaluate: PromosService['evaluate'];
}) {
  const createdLines: any[] = [];
  const repo = {
    create: (x: any) => {
      createdLines.push(x);
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
      { id: 'm1', name: 'Nasi', priceCents: opts.priceCents ?? 500, isAvailable: true, restaurantId: REST_ID },
    ]),
  } as unknown as MenuService;
  const restaurants = {
    findOne: jest.fn(async () => ({
      id: REST_ID,
      minOrderCents: opts.minOrderCents ?? 1000,
      deliveryFeeCents: 300,
    })),
  } as unknown as RestaurantsService;
  const promos = { evaluate: opts.evaluate } as unknown as PromosService;
  const events = { publish: jest.fn() } as unknown as OrderEventsService;
  const service = new OrdersService(repo, menu, restaurants, events, promos);
  return { service, createdLines };
}

const baseDto = (promoCode?: string) =>
  ({
    restaurantId: REST_ID,
    customerName: 'A',
    contactPhone: '1',
    deliveryAddress: 'x',
    items: [{ menuItemId: 'm1', quantity: 2 }], // subtotal 1000
    ...(promoCode ? { promoCode } : {}),
  }) as any;

describe('OrdersService.create — promo integration', () => {
  it('without a promoCode the promo engine is never consulted', async () => {
    const evaluate = jest.fn();
    const { service, createdLines } = buildCreate({ evaluate });
    await service.create(baseDto(), undefined);
    expect(evaluate).not.toHaveBeenCalled();
    expect(createdLines[0]).toMatchObject({ subtotalCents: 1000, discountCents: 0, promoCode: null, totalCents: 1300 });
  });

  it('applies the server-computed discount and snapshots the normalized code', async () => {
    const evaluate = jest.fn(async () => ({ ok: true, message: 'ok', discountCents: 100 }));
    const { service, createdLines } = buildCreate({ evaluate });
    await service.create(baseDto('welcome10 '), undefined);
    // evaluate gets the SERVER subtotal (2×500), not anything the client claimed.
    expect(evaluate).toHaveBeenCalledWith('welcome10 ', REST_ID, 1000);
    expect(createdLines[0]).toMatchObject({
      subtotalCents: 1000,
      discountCents: 100,
      promoCode: 'WELCOME10',
      totalCents: 1200, // 1000 - 100 + 300 fee — the fee is never discounted
    });
  });

  it('rejects the WHOLE order with 400 when the promo does not apply', async () => {
    const evaluate = jest.fn(async () => ({
      ok: false as const,
      reason: 'restaurant_mismatch' as const,
      message: 'Promo code "HEMAT10" does not apply to this restaurant',
    }));
    const { service, createdLines } = buildCreate({ evaluate });
    await expect(service.create(baseDto('HEMAT10'), undefined)).rejects.toThrow(
      new BadRequestException('Promo code "HEMAT10" does not apply to this restaurant'),
    );
    expect(createdLines).toHaveLength(0);
  });

  it('min-order check beats the promo: below-minimum cart never reaches evaluate', async () => {
    const evaluate = jest.fn();
    const { service } = buildCreate({ minOrderCents: 2000, evaluate });
    await expect(service.create(baseDto('WELCOME10'), undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
});
