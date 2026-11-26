import type { Order } from './api';

/**
 * Receipt offline cache (Phase 15): every SUCCESSFUL receipt render stores the
 * order row per id in localStorage, so a receipt re-opened while the API is
 * unreachable restores from the device instead of vanishing. Same device
 * persistence doctrine as the offline cart (session 59): data is display-only
 * (prices/statuses are re-read live whenever the API answers; this copy can
 * never author a mutation) and lives ONLY on the browser that legitimately
 * viewed the receipt.
 *
 * Traps owned here:
 * - stored shape is UNTRUSTED (another tab, an older build, or a hostile page
 *   in the same origin can put anything in localStorage) — `loadCachedOrder`
 *   re-validates a minimum receipt shape AND that the row's own id matches
 *   the requested one, so a stale key can never render another order.
 * - the store is capped (MAX_ENTRIES, oldest-savedAt pruned) — receipts are
 *   PII-adjacent (address, phone, email) and must not pile up forever.
 * - GDPR hygiene: successful account deletion clears the whole store
 *   (`clearOrderCache`, wired in /account) — the server anonymizes its rows,
 *   the browser drops its copies.
 */

const STORAGE_KEY = ['foodorder', 'receipts', 'v1'].join('.');
const MAX_ENTRIES = 10;

export interface CachedReceipt {
  order: Order;
  /** ISO timestamp of when this copy was last (re)loaded live. */
  savedAt: string;
}

type Store = Record<string, CachedReceipt>;

/** Minimum structural guard for a cached row — enough to render the receipt
 *  body without re-deriving the full API DTO. Anything else is dropped. */
function isCachedReceipt(value: unknown): value is CachedReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<CachedReceipt>;
  if (typeof entry.savedAt !== 'string') return false;
  const order = entry.order as Record<string, unknown> | undefined | null;
  if (typeof order !== 'object' || order === null) return false;
  return (
    typeof order.id === 'string' &&
    typeof order.code === 'string' &&
    typeof order.status === 'string' &&
    typeof order.totalCents === 'number' &&
    Array.isArray(order.items)
  );
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Store = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (isCachedReceipt(entry) && entry.order.id === id) out[id] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota/privacy mode: the cache is an enhancement, never a dependency */
  }
}

/** Persist (or refresh) the live-sourced copy of `order` for its own id. */
export function saveCachedOrder(order: Order): void {
  if (typeof window === 'undefined' || typeof order?.id !== 'string') return;
  const store = readStore();
  store[order.id] = { order, savedAt: new Date().toISOString() };
  const ids = Object.keys(store);
  if (ids.length > MAX_ENTRIES) {
    ids
      .sort((a, b) => (store[a].savedAt < store[b].savedAt ? -1 : 1))
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((id) => delete store[id]);
  }
  writeStore(store);
}

/** The last successfully-fetched row for `id`, or null (missing/corrupt/
 *  id-mismatched). Never throws. */
export function loadCachedOrder(id: string): CachedReceipt | null {
  if (typeof window === 'undefined') return null;
  const entry = readStore()[id];
  return entry ?? null;
}

/** GDPR path: drop every stored receipt copy on this device. */
export function clearOrderCache(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* same enhancement-only contract */
  }
}

/** Test/diagnostic surface: the exported key so specs pin the exact slot. */
export const ORDER_CACHE_KEY = STORAGE_KEY;
