import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { io, Socket } from 'socket.io-client';

import { RealtimeGateway } from './realtime.gateway';
import { OrdersService } from './orders.service';
import { OrderEventsService, OrderEvent } from './order-events.service';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';

/**
 * Phase 5 "Realtime order feed with WebSocket gateway (Socket.IO)" — the
 * gateway exercised END TO END: a real Nest app listening on an ephemeral
 * port, real socket.io-client handshakes, real room fan-out off the shared
 * OrderEventsService bus. OrdersService is mocked at its single touchpoint
 * (assertStreamAccess) so auth/room semantics are proven without a DB; the
 * ownership rule itself is the inbox GET's, already covered by REST specs.
 */

const JWT_TEST = 'realtime-jwt-test-key';
const OWNER_ID = 'b0000000-0000-4000-8000-00000000000b';
const CUSTOMER_ID = 'c0000000-0000-4000-8000-00000000000c';
const OTHER_ID = 'd0000000-0000-4000-8000-00000000000d';
const RESTAURANT_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_RESTAURANT = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_RESTAURANT = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Waits for one socket lifecycle event once (rejects after `ms`). */
function next(socket: Socket, event: string, ms = 4000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for '${event}'`)), ms);
    socket.once(event, (...args: any[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

/** Buffer of named-data events until stopped — used for "no delivery" checks. */
function record(socket: Socket, events: string[], sink: Array<{ name: string; data: any }>): void {
  for (const name of events) socket.on(name, (data: any) => sink.push({ name, data }));
}

describe('RealtimeGateway — Socket.IO realtime order feed (/orders namespace)', () => {
  let app: INestApplication;
  let port: number;
  let jwt: JwtService;
  let events: OrderEventsService;
  let assertStreamAccess: jest.Mock;
  const sockets: Socket[] = [];

  function connect(opts: { token?: string | null } = {}): Socket {
    const socket = io(`http://127.0.0.1:${port}/orders`, {
      transports: ['websocket'],
      auth: opts.token === null ? undefined : { token: opts.token },
    });
    sockets.push(socket);
    return socket;
  }

  /** Authenticated, hello-received socket for a role. */
  async function authedSocket(sub: string, role: UserRole): Promise<Socket> {
    const token = await jwt.signAsync({ sub, role, typ: TOKEN_TYPE_ACCESS });
    const socket = connect({ token });
    const [hello] = await next(socket, 'hello');
    expect(hello.serverTime).toMatch(/T.*Z/);
    return socket;
  }

  beforeAll(async () => {
    assertStreamAccess = jest.fn(async (id: string, actor: any) => {
      if (id === UNKNOWN_RESTAURANT) throw new NotFoundException('Restaurant not found');
      if (id === FOREIGN_RESTAURANT && actor?.role !== UserRole.ADMIN) {
        throw new ForbiddenException('You do not own this restaurant');
      }
      return { id };
    });
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: JWT_TEST })],
      providers: [
        RealtimeGateway,
        OrderEventsService,
        { provide: OrdersService, useValue: { assertStreamAccess } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    jwt = app.get(JwtService);
    events = app.get(OrderEventsService);
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await app.close();
  });

  // ---------- handshake auth ----------

  it('refuses a socket with no token: auth_error then disconnect', async () => {
    const socket = connect({ token: undefined });
    // Register the disconnect waiter BEFORE awaiting auth_error: the server
    // emits + closes back-to-back, so the close can land first.
    const gone = next(socket, 'disconnect');
    const [payload] = await next(socket, 'auth_error');
    expect(payload).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
    await gone;
    expect(socket.connected).toBe(false);
  });

  it('refuses a garbage token (bad signature)', async () => {
    const socket = connect({ token: 'not.a.jwt' });
    const [payload] = await next(socket, 'auth_error');
    expect(payload.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a validly-signed NON-access token (refresh typ)', async () => {
    const token = await jwt.signAsync({ sub: CUSTOMER_ID, role: UserRole.CUSTOMER, typ: 'refresh' }, { secret: JWT_TEST });
    const socket = connect({ token });
    const [payload] = await next(socket, 'auth_error');
    expect(payload.code).toBe('UNAUTHENTICATED');
  });

  it('accepts an access token with a hello frame', async () => {
    const socket = await authedSocket(CUSTOMER_ID, UserRole.CUSTOMER);
    expect(socket.connected).toBe(true);
  });

  // ---------- subscribe:restaurant ----------

  it('rejects a malformed / absent restaurantId with a BAD_REQUEST ack (no DB touched)', async () => {
    const socket = await authedSocket(OWNER_ID, UserRole.OWNER);
    assertStreamAccess.mockClear();
    for (const bad of ['not-a-uuid', '', undefined]) {
      const ack = await socket.emitWithAck('subscribe:restaurant', { restaurantId: bad });
      expect(ack).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    }
    const bare = await socket.emitWithAck('subscribe:restaurant');
    expect(bare.ok).toBe(false);
    expect(assertStreamAccess).not.toHaveBeenCalled();
  });

  it('maps the inbox ownership gate onto ack codes (404 unknown, 403 foreign)', async () => {
    const socket = await authedSocket(OWNER_ID, UserRole.OWNER);
    const missing = await socket.emitWithAck('subscribe:restaurant', { restaurantId: UNKNOWN_RESTAURANT });
    expect(missing).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const foreign = await socket.emitWithAck('subscribe:restaurant', { restaurantId: FOREIGN_RESTAURANT });
    expect(foreign).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    // Verified claims (not client input) reach the service gate.
    expect(assertStreamAccess).toHaveBeenCalledWith(FOREIGN_RESTAURANT, { sub: OWNER_ID, role: UserRole.OWNER });
  });

  it('delivers bus events to subscribed restaurant rooms, nothing to others', async () => {
    const mine = await authedSocket(OWNER_ID, UserRole.OWNER);
    const other = await authedSocket(OWNER_ID, UserRole.OWNER);
    expect(await mine.emitWithAck('subscribe:restaurant', { restaurantId: RESTAURANT_ID })).toMatchObject({
      ok: true,
      restaurantId: RESTAURANT_ID,
    });

    const inbox: Array<{ name: string; data: any }> = [];
    record(mine, ['order.created', 'order.updated'], inbox);
    const deaf: Array<{ name: string; data: any }> = [];
    record(other, ['order.created', 'order.updated'], deaf);

    const payload = { orderId: ORDER_ID, code: 'FO-TEST', status: 'pending' };
    events.publish({ type: 'order.created', restaurantId: RESTAURANT_ID, userId: null, payload });
    await wait(250);
    expect(inbox).toEqual([{ name: 'order.created', data: payload }]);
    expect(deaf).toEqual([]); // never subscribed -> room fan-out misses it

    events.publish({ type: 'order.updated', restaurantId: RESTAURANT_ID, userId: null, payload: { ...payload, status: 'confirmed' } });
    await wait(250);
    expect(inbox[1]).toEqual({ name: 'order.updated', data: { ...payload, status: 'confirmed' } });

    // unsubscribe stops the feed
    expect(await mine.emitWithAck('unsubscribe:restaurant', { restaurantId: RESTAURANT_ID })).toMatchObject({ ok: true });
    const before = inbox.length;
    events.publish({ type: 'order.updated', restaurantId: RESTAURANT_ID, userId: null, payload: { ...payload, status: 'preparing' } });
    await wait(250);
    expect(inbox.length).toBe(before);
  });

  // ---------- subscribe:me ----------

  it('subscribe:me joins ONLY the token holder room; guest orders get no user fan-out', async () => {
    const customer = await authedSocket(CUSTOMER_ID, UserRole.CUSTOMER);
    const nosy = await authedSocket(OTHER_ID, UserRole.CUSTOMER);
    expect(await customer.emitWithAck('subscribe:me')).toMatchObject({ ok: true, userId: CUSTOMER_ID });

    const mine: OrderEvent['payload'][] = [];
    customer.on('order.created', (d: any) => mine.push(d));
    const nosySeen: any[] = [];
    nosy.on('order.created', (d: any) => nosySeen.push(d));

    const payload = { orderId: ORDER_ID, code: 'FO-MINE1', status: 'pending' };
    events.publish({ type: 'order.created', restaurantId: RESTAURANT_ID, userId: CUSTOMER_ID, payload });
    await wait(250);
    expect(mine).toEqual([payload]);
    expect(nosySeen).toEqual([]); // room id comes from the verified token, not the client

    // unsubscribe:me + a guest order (userId null) — neither fans out to users.
    expect(await customer.emitWithAck('unsubscribe:me')).toMatchObject({ ok: true, userId: CUSTOMER_ID });
    events.publish({ type: 'order.created', restaurantId: RESTAURANT_ID, userId: null, payload: { ...payload, code: 'FO-GUEST' } });
    events.publish({ type: 'order.created', restaurantId: RESTAURANT_ID, userId: CUSTOMER_ID, payload: { ...payload, code: 'FO-AFTER' } });
    await wait(250);
    expect(mine.length).toBe(1);
  });

  it('admin bypasses the ownership gate exactly like the inbox GET', async () => {
    const admin = await authedSocket('e0000000-0000-4000-8000-00000000000e', UserRole.ADMIN);
    const ack = await admin.emitWithAck('subscribe:restaurant', { restaurantId: FOREIGN_RESTAURANT });
    expect(ack).toMatchObject({ ok: true, restaurantId: FOREIGN_RESTAURANT });
    expect(assertStreamAccess).toHaveBeenLastCalledWith(FOREIGN_RESTAURANT, {
      sub: 'e0000000-0000-4000-8000-00000000000e',
      role: UserRole.ADMIN,
    });
    const sink: any[] = [];
    admin.on('order.created', (d: any) => sink.push(d));
    const payload = { orderId: ORDER_ID, code: 'FO-ADMIN', status: 'pending' };
    events.publish({ type: 'order.created', restaurantId: FOREIGN_RESTAURANT, userId: null, payload });
    await wait(250);
    expect(sink).toEqual([payload]);
  });
});
