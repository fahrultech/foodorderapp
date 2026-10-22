import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import { RestaurantOrdersController } from './restaurant-orders.controller';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import { UserRole } from '../users/user.entity';

const RID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ownerActor = { sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: UserRole.OWNER };

function build(opts: { access?: 'ok' | 'forbidden' | 'missing' } = {}) {
  const service = {
    assertStreamAccess: jest.fn(async () => {
      if (opts.access === 'forbidden') throw new ForbiddenException('no');
      if (opts.access === 'missing') throw new NotFoundException('no');
      return { id: RID };
    }),
  } as unknown as OrdersService;
  const events = new OrderEventsService();
  const controller = new RestaurantOrdersController(service, events);
  return { service, controller, events };
}

describe('RestaurantOrdersController.stream — SSE order stream', () => {
  it('rejects BEFORE any stream exists when the caller does not own the restaurant', async () => {
    const { controller } = build({ access: 'forbidden' });
    await expect(
      controller.stream(RID, ownerActor as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const b2 = build({ access: 'missing' });
    await expect(b2.controller.stream(RID, ownerActor as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('emits hello first, with the restaurant id', async () => {
    const { controller } = build();
    const obs = await controller.stream(RID, ownerActor as any);
    const first = await firstValueFrom(obs.pipe(take(1)));
    expect(first.type).toBe('hello');
    expect(first.data).toMatchObject({ restaurantId: RID });
  });

  it('streams order.created / order.updated ONLY for this restaurant', async () => {
    const { controller, events } = build();
    const obs = await controller.stream(RID, ownerActor as any);
    // Publish after subscribe: the bus is live-only.
    const collected: any[] = [];
    const done = new Promise<void>((resolve) => {
      const sub = obs.subscribe((m: any) => {
        collected.push(m);
        if (m.type === 'order.updated') {
          sub.unsubscribe();
          resolve();
        }
      });
      setTimeout(() => {
        events.publish({
          type: 'order.created',
          restaurantId: RID,
          payload: { orderId: 'o1', code: 'FO-A', status: 'pending' },
        });
        events.publish({
          type: 'order.updated',
          restaurantId: RID,
          payload: { orderId: 'o1', code: 'FO-A', status: 'confirmed' },
        });
        // Foreign restaurant must never reach this subscriber.
        events.publish({
          type: 'order.created',
          restaurantId: OTHER,
          payload: { orderId: 'oX', code: 'FO-X', status: 'pending' },
        });
      }, 0);
    });
    await done;
    expect(collected.map((m) => m.type)).toEqual(['hello', 'order.created', 'order.updated']);
    expect(collected[1].data).toEqual({ orderId: 'o1', code: 'FO-A', status: 'pending' });
    expect(collected.every((m) => m.type !== 'order.created' || m.data?.orderId !== 'oX')).toBe(
      true,
    );
  });
});
