import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

/**
 * Lifecycle events published by OrdersService after a state-changing write.
 * Two consumers: the owner inbox SSE stream (Phase 2 "live order updates via
 * SSE") and the Socket.IO realtime gateway (Phase 5, `realtime.gateway.ts`) —
 * both subscribe to the same bus, so the REST write paths never know or care
 * which transports exist.
 *
 * Scope note: the bus is INTENTIONALLY process-local (a plain rxjs Subject).
 * Single-container deployments get correct fan-out for free; a multi-container
 * one would need a shared broker (or the Socket.IO gateway on every node).
 * Consumers stay safe either way: the streams only say "something changed",
 * the truth always comes from the normal GET endpoints.
 */
export type OrderEventType = 'order.created' | 'order.updated';

export interface OrderEventPayload {
  orderId: string;
  code: string;
  status: string;
}

export interface OrderEvent {
  type: OrderEventType;
  restaurantId: string;
  /**
   * Owner of the order, `null` for guest orders. SSE consumers never needed it
   * (the stream is restaurant-scoped), but the WS gateway routes each event to
   * the customer's own room too — added as OPTIONAL so every existing event
   * literal and spec keeps compiling untouched.
   */
  userId?: string | null;
  payload: OrderEventPayload;
}

/**
 * Keep-alive cadence for the SSE stream. Long idle connections get dropped by
 * proxies/CDNs and browsers cannot notice until the next write, so the stream
 * emits a `ping` event on this interval; the dashboard also uses it as the
 * liveness signal. Exported (not a magic constant) so the controller and any
 * future consumer share one number.
 */
export const ORDER_STREAM_HEARTBEAT_MS = 15_000;

@Injectable()
export class OrderEventsService {
  private readonly bus = new Subject<OrderEvent>();

  /**
   * Fire-and-forget. Publish AFTER the DB write resolved — the consumer treats
   * an event as "refetch", so publishing a rolled-back change would at worst
   * cost one extra GET, never show wrong data.
   */
  publish(event: OrderEvent): void {
    this.bus.next(event);
  }

  /** Live-only view: subscribers see events published after they subscribe. */
  stream(): Observable<OrderEvent> {
    return this.bus.asObservable();
  }
}
