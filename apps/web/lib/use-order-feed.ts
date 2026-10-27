'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { API_URL } from '@/lib/api';
import { STREAM_TOKEN_REBUILD_MS } from '@/lib/live-sync';
import {
  WS_SUBSCRIBE_ACK_MS,
  wsFeedUrl,
  wsReconnectDelayMs,
  type FeedEventPayload,
} from '@/lib/ws-feed';

/**
 * React hook wrapping the API's Socket.IO order feed (`/orders` namespace,
 * apps/api/src/orders/realtime.gateway.ts) — the PRIMARY push transport for
 * the owner dashboard (`restaurantId` mode) and customer order tracking
 * (`me` mode). Consumers treat it as pure wake-up: `onEvent` says "something
 * changed", the data path stays the normal authenticated GETs.
 *
 * Connection lifecycle is owned HERE (not by socket.io's auto-reconnect),
 * exactly like the dashboard owns the EventSource rebuild:
 *
 *  - handshake auth with a FRESH token from the auth provider;
 *  - `reconnection: false` + `transports: ['websocket']` — polling would
 *    need engine.io CORS dance, the WS upgrade is exempt, and if WS is
 *    unreachable we WANT the fallback ladder (SSE / interval poll) instead;
 *  - any failure path (connect_error / auth_error / disconnect / missing or
 *    negative subscribe ack / ack silence) closes and retries with a NEW
 *    token after capped exponential backoff — a rejected handshake (rotated
 *    or expired token) must never loop against the old one;
 *  - full rebuild every STREAM_TOKEN_REBUILD_MS (15m), long before the 30m
 *    access TTL, same rule as the SSE stream;
 *  - `wsUp` flips true only on a POSITIVE subscribe ack (room actually
 *    joined) — that is the gate consumers use to idle their fallbacks.
 *
 * `enabled` gates the whole thing (signed-in / not paused / not terminal
 * order): when false no socket exists and `wsUp` is false.
 */

export interface OrderFeedHandlers {
  /** Fired once per verified subscribe (incl. rebuilds): flush any catch-up sync. */
  onReady?: () => void;
  /** Trigger-only order event for a room this client is in. */
  onEvent?: (payload: FeedEventPayload) => void;
}

export interface OrderFeedOptions {
  enabled: boolean;
  /** Owner inbox mode: join room `r:<restaurantId>` (server verifies ownership). */
  restaurantId?: string | null;
  /** Customer mode: join room `u:<userId>` — id comes from the VERIFIED token. */
  me?: boolean;
  getAccessToken: () => Promise<string | null>;
  handlers: OrderFeedHandlers;
}

type SubscribeAck = { ok: true; restaurantId?: string; userId?: string } | { ok: false; code: string };

export function useOrderFeed(opts: OrderFeedOptions): { wsUp: boolean } {
  const { enabled, restaurantId = null, me = false, getAccessToken } = opts;
  // Handlers called through a ref: consumers pass fresh closures every
  // render (state-dependent sync logic) but must never tear down/rebuild the
  // socket because of it.
  const handlersRef = useRef(opts.handlers);
  useEffect(() => {
    handlersRef.current = opts.handlers;
  }, [opts.handlers]);

  const [wsUp, setWsUp] = useState(false);

  useEffect(() => {
    if (!enabled || (!restaurantId && !me)) {
      setWsUp(false);
      return;
    }
    let disposed = false;
    let socket: Socket | null = null;
    let retryTimer: number | null = null;
    let ackTimer: number | null = null;
    let attempt = 0;

    const closeSocket = () => {
      if (ackTimer != null) window.clearTimeout(ackTimer);
      ackTimer = null;
      if (socket) {
        const s = socket;
        socket = null; // detach before closing: our own close must not retry
        s.removeAllListeners();
        s.close();
      }
      setWsUp(false);
    };

    const scheduleRetry = () => {
      closeSocket();
      if (disposed || retryTimer != null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void connect();
      }, wsReconnectDelayMs(attempt++));
    };

    const connect = async () => {
      if (disposed) return;
      const token = await getAccessToken();
      if (disposed) return;
      if (!token) {
        // Signed out mid-flight (doRefresh 401 clears the session) — stay
        // down and let `enabled` flip; retry slowly in case of a transient.
        scheduleRetry();
        return;
      }
      const s = io(wsFeedUrl(API_URL), {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        timeout: 8_000,
      });
      socket = s;
      // Guards every handler against events from a socket we already replaced
      // (rebuild, retry, unmount) — the same `mine()` discipline as the SSE
      // effect on the dashboard.
      const mine = () => !disposed && socket === s;

      s.on('connect', () => {
        if (!mine()) return;
        ackTimer = window.setTimeout(scheduleRetry, WS_SUBSCRIBE_ACK_MS);
        let pending = 0;
        let failed = false;
        const onAck = (ack?: SubscribeAck) => {
          pending -= 1;
          if (!mine()) return;
          if (!ack || ack.ok !== true) failed = true;
          if (failed && pending <= 0) {
            // Foreign/unknown restaurant or malformed id: the room will never
            // join on THIS connection. Go down; a fresh-token retry either
            // succeeds (transient auth) or keeps backing off (real 403).
            scheduleRetry();
            return;
          }
          if (!failed && pending <= 0) {
            if (ackTimer != null) window.clearTimeout(ackTimer);
            ackTimer = null;
            attempt = 0;
            setWsUp(true);
            handlersRef.current.onReady?.();
          }
        };
        if (restaurantId) {
          pending += 1;
          s.emit('subscribe:restaurant', { restaurantId }, onAck);
        }
        if (me) {
          pending += 1;
          s.emit('subscribe:me', onAck);
        }
      });

      const forward = (payload: FeedEventPayload) => {
        if (mine()) handlersRef.current.onEvent?.(payload);
      };
      s.on('order.created', forward);
      s.on('order.updated', forward);

      s.on('auth_error', scheduleRetry); // gateway refused this token, will disconnect
      s.on('connect_error', scheduleRetry); // api down / unreachable
      s.on('disconnect', scheduleRetry); // gone down on its own (server restart, network)
    };

    void connect();
    // Proactive full rebuild with a fresh token, well before the access TTL.
    const rebuild = window.setInterval(() => {
      if (disposed) return;
      closeSocket();
      void connect();
    }, STREAM_TOKEN_REBUILD_MS);

    return () => {
      disposed = true;
      window.clearInterval(rebuild);
      if (retryTimer != null) window.clearTimeout(retryTimer);
      closeSocket();
    };
    // getAccessToken is referentially stable inside the auth provider
    // (memoised on a stable doRefresh), so this never churns the connection.
  }, [enabled, restaurantId, me, getAccessToken]);

  return { wsUp };
}
