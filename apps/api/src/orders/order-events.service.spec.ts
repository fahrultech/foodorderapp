import {
  ORDER_STREAM_HEARTBEAT_MS,
  OrderEvent,
  OrderEventsService,
} from './order-events.service';

const RID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function event(overrides: Partial<OrderEvent> = {}): OrderEvent {
  return {
    type: 'order.created',
    restaurantId: RID,
    payload: { orderId: 'o1', code: 'FO-A', status: 'pending' },
    ...overrides,
  };
}

describe('OrderEventsService — live-only in-process bus', () => {
  it('delivers published events to current subscribers', () => {
    const bus = new OrderEventsService();
    const seen: OrderEvent[] = [];
    const sub = bus.stream().subscribe((e) => seen.push(e));
    bus.publish(event());
    bus.publish(event({ type: 'order.updated', payload: { orderId: 'o1', code: 'FO-A', status: 'confirmed' } }));
    expect(seen.map((e) => e.type)).toEqual(['order.created', 'order.updated']);
    sub.unsubscribe();
  });

  it('is live-only: a subscriber that joins later does NOT replay earlier events', () => {
    const bus = new OrderEventsService();
    bus.publish(event());
    const seen: OrderEvent[] = [];
    const sub = bus.stream().subscribe((e) => seen.push(e));
    expect(seen.length).toBe(0);
    bus.publish(event({ restaurantId: OTHER }));
    expect(seen.length).toBe(1);
    sub.unsubscribe();
  });

  it('every subscriber gets every event (fan-out, not round-robin)', () => {
    const bus = new OrderEventsService();
    const a: OrderEvent[] = [];
    const b: OrderEvent[] = [];
    const s1 = bus.stream().subscribe((e) => a.push(e));
    const s2 = bus.stream().subscribe((e) => b.push(e));
    bus.publish(event());
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    s1.unsubscribe();
    s2.unsubscribe();
  });

  it('unsubscribed observers stop receiving', () => {
    const bus = new OrderEventsService();
    const seen: OrderEvent[] = [];
    const sub = bus.stream().subscribe((e) => seen.push(e));
    bus.publish(event());
    sub.unsubscribe();
    bus.publish(event());
    expect(seen.length).toBe(1);
  });

  it('heartbeat cadence is a sane positive interval', () => {
    expect(ORDER_STREAM_HEARTBEAT_MS).toBeGreaterThan(0);
    expect(ORDER_STREAM_HEARTBEAT_MS).toBeLessThanOrEqual(30_000);
  });
});
