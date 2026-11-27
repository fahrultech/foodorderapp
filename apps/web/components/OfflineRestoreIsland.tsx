'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { loadCachedOrder } from '@/lib/order-cache';
import CachedReceiptFallback from '@/components/CachedReceiptFallback';

/**
 * FULLY-offline receipt restore (Phase 16 #3, session 141). Session 137
 * covered "API down, web server up" (server branch -> CachedReceiptFallback).
 * This is the deeper case: the browser cannot reach the WEB SERVER either, so
 * the service worker serves the cached /offline app shell for the navigation
 * to /orders/<id> — the address bar keeps the receipt URL while this island
 * (hydrating from the pre-cached chunks — see the sw.js install precache)
 * inspects the REAL location and, when the device holds a live-sourced copy
 * of THAT order id, surfaces it through the exact same banner + receipt view.
 *
 * Honesty rules inherited, none widened:
 * - the id comes from the URL path only; `loadCachedOrder` re-validates the
 *   stored shape AND that the row's id matches its key (lib/order-cache), so
 *   an unviewed/unknown/garbage id never borrows another order's copy — it
 *   keeps today's generic offline card untouched;
 * - the mount-time pre-check means the card never flashes to a loading
 *   placeholder when there is nothing to restore;
 * - Retry here reloads the DOCUMENT (a fresh navigation): while offline the
 *   worker serves the shell again, once connectivity returns the live
 *   server-rendered receipt takes over — router.refresh() would retry the
 *   wrong route, since the client router state is the /offline tree.
 * - zero server round-trips: localStorage is the only data source (the
 *   network cannot answer anyway — that is the premise).
 */
export default function OfflineRestoreIsland({ fallback }: { fallback: ReactNode }) {
  const [orderId, setOrderId] = useState<string | null>(null);

  useEffect(() => {
    const match = window.location.pathname.match(/^\/orders\/([^/?#]{1,80})$/);
    if (match && loadCachedOrder(match[1]) !== null) setOrderId(match[1]);
  }, []);

  if (!orderId) return <>{fallback}</>;
  return (
    <CachedReceiptFallback
      orderId={orderId}
      notFound={fallback}
      onRetry={() => window.location.reload()}
    />
  );
}
