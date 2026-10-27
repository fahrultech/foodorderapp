import {
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import type { Subscription } from 'rxjs';

import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { isUuid } from '../common/uuid';
import { UserRole } from '../users/user.entity';
import { OrdersService } from './orders.service';
import { OrderEvent, OrderEventsService } from './order-events.service';

/**
 * Phase 5 "Realtime order feed with WebSocket gateway (Socket.IO)".
 *
 * A Socket.IO server mounted on the SAME HTTP server as the REST API, under
 * the `/orders` namespace (URL: ws://<api>/orders, default path /socket.io/).
 * It is the transport-agnostic twin of the owner SSE stream: both consume the
 * one in-process event bus (OrderEventsService), so nothing in the REST write
 * paths changes and the two streams can never drift in WHAT they announce —
 * only in HOW they deliver it.
 *
 * Contract (all payloads are TRIGGER-ONLY, same as SSE: identity + status, no
 * order data — clients refetch via the normal GET endpoints, so a dropped
 * message costs latency, never correctness; live-only, no replay):
 *
 *   connect  auth: { token: <access JWT> }        (query ?token= also accepted
 *                                                  for clients that cannot set
 *                                                  handshake auth)
 *   -> auth_error  { code: UNAUTHENTICATED, message }  + socket closed — when
 *                    the token is missing/bad/expired or is not an access JWT
 *   -> hello       { serverTime }                       — once per connection
 *
 *   client  'subscribe:restaurant' { restaurantId }  -> ack { ok:true, restaurantId }
 *                                                    -> ack { ok:false, code }
 *                    OWNER (admins bypass) must own the restaurant — the EXACT
 *                    gate as the inbox GET (`OrdersService.assertStreamAccess`,
 *                    403 foreign / 404 unknown surface as ack codes, and the
 *                    socket is NOT joined). Joining puts the socket in room
 *                    `r:<restaurantId>`; multiple restaurants = multiple
 *                    subscribes. Idempotent re-subscribe is harmless.
 *   client  'unsubscribe:restaurant' { restaurantId } -> ack { ok:true }
 *
 *   client  'subscribe:me'                          -> ack { ok:true, userId }
 *                    room `u:<sub>` — the customer-side live feed for MY orders
 *                    (the `/orders/my` timeline, no endpoint was ever built for
 *                    that before). Never joinable for another user: the room id
 *                    comes from the VERIFIED token, not from client input.
 *
 *   <- 'order.created' / 'order.updated'  { orderId, code, status }
 *        fan-out: restaurant room `r:<restaurantId>` always; the owner room
 *        additionally gets it; guest orders (userId null) have no customer room.
 *
 * Auth is handshake-level and REQUIRED: an unauthenticated socket is
 * disconnected before any event can flow, using the same secret and `typ`
 * claim rules as the REST guards. No app-level keep-alive events: Socket.IO
 * runs its own ping/pong at the transport layer (unlike SSE, which needed the
 * 15s `ping` against proxy idle timeouts).
 */

interface WsUser {
  sub: string;
  role: UserRole;
}

/** Ack envelope every subscribe/unsubscribe handler answers with. */
type Ack =
  | { ok: true; restaurantId?: string; userId?: string }
  | { ok: false; code: string; message: string };

const err = (code: string, message: string): Ack => ({ ok: false, code, message });

export const realtimeRestaurantRoom = (restaurantId: string) => `r:${restaurantId}`;
export const realtimeUserRoom = (userId: string) => `u:${userId}`;

@WebSocketGateway({ namespace: '/orders' })
export class RealtimeGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private busSub: Subscription | null = null;

  constructor(
    private readonly jwt: JwtService,
    private readonly events: OrderEventsService,
    private readonly orders: OrdersService,
  ) {}

  afterInit(): void {
    // One bus subscription for the whole namespace — fan-out is per-room.
    this.busSub = this.events.stream().subscribe((e) => this.dispatch(e));
  }

  onModuleDestroy(): void {
    this.busSub?.unsubscribe();
    this.busSub = null;
  }

  /**
   * Verified claims live on the socket (never re-read from the client, which
   * can emit whatever it likes). Returns false → connection is refused.
   */
  async handleConnection(client: Socket): Promise<void> {
    const raw = client.handshake?.auth?.token ?? client.handshake?.query?.token;
    if (typeof raw !== 'string' || !raw) {
      client.emit('auth_error', err('UNAUTHENTICATED', 'Missing access token'));
      client.disconnect(true);
      return;
    }
    let claims: any;
    try {
      claims = await this.jwt.verifyAsync(raw);
    } catch {
      client.emit('auth_error', err('UNAUTHENTICATED', 'Invalid or expired token'));
      client.disconnect(true);
      return;
    }
    if (claims?.typ !== TOKEN_TYPE_ACCESS || typeof claims.sub !== 'string') {
      client.emit('auth_error', err('UNAUTHENTICATED', 'Not an access token'));
      client.disconnect(true);
      return;
    }
    client.data.user = { sub: claims.sub, role: claims.role } as WsUser;
    client.emit('hello', { serverTime: new Date().toISOString() });
  }

  @SubscribeMessage('subscribe:restaurant')
  async subscribeRestaurant(
    client: Socket,
    data?: { restaurantId?: unknown },
  ): Promise<Ack> {
    const actor = this.actor(client);
    if (!actor) return err('UNAUTHENTICATED', 'Unverified socket');
    const restaurantId = typeof data?.restaurantId === 'string' ? data.restaurantId : '';
    if (!isUuid(restaurantId)) return err('BAD_REQUEST', 'restaurantId must be a UUID');
    try {
      const restaurant = await this.orders.assertStreamAccess(restaurantId, actor);
      client.join(realtimeRestaurantRoom(restaurant.id));
      return { ok: true, restaurantId: restaurant.id };
    } catch (e: any) {
      // Same 403/404 semantics as the inbox GET, mapped onto the ack channel.
      const status = e?.getStatus?.();
      if (status === 404) return err('NOT_FOUND', e.message ?? 'Restaurant not found');
      if (status === 403) return err('FORBIDDEN', e.message ?? 'Not your restaurant');
      throw e;
    }
  }

  @SubscribeMessage('unsubscribe:restaurant')
  unsubscribeRestaurant(
    client: Socket,
    data?: { restaurantId?: unknown },
  ): Ack {
    if (!this.actor(client)) return err('UNAUTHENTICATED', 'Unverified socket');
    const restaurantId = typeof data?.restaurantId === 'string' ? data.restaurantId : '';
    if (!isUuid(restaurantId)) return err('BAD_REQUEST', 'restaurantId must be a UUID');
    client.leave(realtimeRestaurantRoom(restaurantId));
    return { ok: true, restaurantId };
  }

  @SubscribeMessage('subscribe:me')
  subscribeMe(client: Socket): Ack {
    const actor = this.actor(client);
    if (!actor) return err('UNAUTHENTICATED', 'Unverified socket');
    // Room id comes from the verified token — impossible to eavesdrop on
    // another user's orders.
    client.join(realtimeUserRoom(actor.sub));
    return { ok: true, userId: actor.sub };
  }

  @SubscribeMessage('unsubscribe:me')
  unsubscribeMe(client: Socket): Ack {
    const actor = this.actor(client);
    if (!actor) return err('UNAUTHENTICATED', 'Unverified socket');
    client.leave(realtimeUserRoom(actor.sub));
    return { ok: true, userId: actor.sub };
  }

  private actor(client: Socket): WsUser | null {
    const u = client.data?.user as WsUser | undefined;
    return u && typeof u.sub === 'string' ? u : null;
  }

  /** Bus event -> rooms. Restaurant room always (owner side); user room too
   *  when the order belongs to an account (guest orders have no customer room). */
  private dispatch(e: OrderEvent): void {
    if (!this.server) return;
    this.server.to(realtimeRestaurantRoom(e.restaurantId)).emit(e.type, e.payload);
    if (e.userId) {
      this.server.to(realtimeUserRoom(e.userId)).emit(e.type, e.payload);
    }
  }
}
