import { Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus } from './order.entity';
import { OrderEventsService } from './order-events.service';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { PromosService } from '../promos/promos.service';
import { AddressesService } from '../users/addresses.service';

/**
 * `OrdersService.cancelStalePending` is the thin service-side wrapper around
 * the shared `runStaleOrderSweep`: its ONLY added responsibility is emitting
 * `order.updated` per cancellation (so live owner inboxes update) and composing
 * a caller hook. The selection/stamping/capping rules are tested in
 * stale-order-sweep.spec.ts against the same function, so here we pin only the
 * emit + hook-composition + override-forwarding contract.
 */

const NOW = new Date('2026-10-27T12:00:00.000Z');
const RID = 'r0000000-0000-4000-8000-00000000000r';

function staleOrder(code: string): Order {
  return {
    id: `${code}-id`,
    code,
    status: OrderStatus.PENDING,
    restaurantId: RID,
    cancelledAt: null,
    createdAt: new Date(NOW.getTime() - 90 * 60_000),
  } as unknown as Order;
}

function build(rows: Order[]) {
  const find = jest.fn(async (opts: any) => {
    const less = opts?.where?.createdAt?._value ?? opts?.where?.createdAt?.value;
    return rows
      .filter((r) => r.status === OrderStatus.PENDING)
      .filter((r) => new Date(r.createdAt).getTime() < new Date(less).getTime())
      .sort((a, b) => +a.createdAt - +b.createdAt);
  });
  const save = jest.fn(async (x: Order) => x);
  const orders = { find, save } as unknown as Repository<Order>;
  const events = { publish: jest.fn() } as unknown as OrderEventsService & {
    publish: jest.Mock;
  };
  const service = new OrdersService(
    orders,
    {} as MenuService,
    {} as RestaurantsService,
    events,
    {} as PromosService,
    {} as AddressesService,
  );
  return { service, find, save, events };
}

describe('OrdersService.cancelStalePending', () => {
  it('emits order.updated once per cancelled order and returns the report', async () => {
    const a = staleOrder('A');
    const b = staleOrder('B');
    const { service, save, events } = build([a, b]);

    const report = await service.cancelStalePending({ now: NOW, staleMinutes: 45 });

    expect(report.cancelled).toBe(2);
    expect(save).toHaveBeenCalledTimes(2);
    expect(events.publish).toHaveBeenCalledTimes(2);
    const envelope = events.publish.mock.calls[0][0];
    expect(envelope).toMatchObject({
      type: 'order.updated',
      restaurantId: RID,
      payload: { orderId: 'A-id', code: 'A', status: OrderStatus.CANCELLED },
    });
  });

  it('composes (does not clobber) a caller-provided onCancelled hook', async () => {
    const a = staleOrder('A');
    const { service, events } = build([a]);
    const seen: string[] = [];

    await service.cancelStalePending({
      now: NOW,
      staleMinutes: 45,
      onCancelled: (o) => void seen.push(o.code),
    });

    expect(seen).toEqual(['A']); // caller hook ran
    expect(events.publish).toHaveBeenCalledTimes(1); // AND our emit ran
  });

  it('emits nothing when there are no stale orders', async () => {
    const fresh = { ...staleOrder('F'), createdAt: new Date(NOW.getTime() - 5 * 60_000) };
    const { service, events, save } = build([fresh]);
    const report = await service.cancelStalePending({ now: NOW, staleMinutes: 45 });
    expect(report.cancelled).toBe(0);
    expect(save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('forwards per-run overrides (staleMinutes/limit) past the env default', async () => {
    const a = staleOrder('A');
    const { service, find } = build([a]);
    await service.cancelStalePending({ now: NOW, staleMinutes: 10, limit: 7 });
    const opts = find.mock.calls[0][0];
    const cutoff = new Date(opts.where.createdAt._value ?? opts.where.createdAt.value);
    expect(cutoff.getTime()).toBe(NOW.getTime() - 10 * 60_000);
    expect(opts.take).toBe(7);
  });
});
