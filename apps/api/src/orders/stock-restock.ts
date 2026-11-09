import { EntityManager } from 'typeorm';

/**
 * Restock on cancellation (docs/ROADMAP.md Phase 5, follow-up to the
 * session-71 stock guard).
 *
 * Session 71 made order creation decrement `menu_items.stock` inside its
 * unit-of-work transaction, but the counter was decrement-only: every path
 * into `cancelled` (owner portal, admin backdoor, customer self-cancel, the
 * stale-pending sweep) silently destroyed the reserved units. This module
 * returns them, exactly once per order, driven by the order's own
 * `stockDecrements` snapshot (what creation ACTUALLY took — never a guess
 * from the item rows):
 *
 * - No snapshot (NULL / empty) -> nothing was decremented -> no-op. That is
 *   the honest answer for unlimited dishes AND for legacy rows created
 *   before stock existed; restocking those would inflate the owner's
 *   counter for units that were never taken.
 * - The marker CAS (`stockRestockedAt NULL -> now()`) doubles as the
 *   exactly-once guard. Two concurrent cancels of one order — both paths
 *   validated off pre-write reads — both call this; the row-level UPDATE
 *   serializes them and only the winner returns units. The CAS also pins
 *   `status = 'cancelled'`: an order whose row was concurrently overwritten
 *   to a live status keeps its decrement (the order is alive).
 * - Per-dish adds run `WHERE stock IS NOT NULL`: an owner who cleared the
 *   dish to unlimited (or deleted it) in the meantime makes that single row
 *   a no-op — an unlimited counter has nothing to return to. Adding to a
 *   number can never violate the non-negative CHECK.
 *
 * Deliberately plain (a shared function over an EntityManager, no Nest DI)
 * so the HTTP service paths AND the standalone `cancel-stale` cron script
 * run the exact same code — same philosophy as stale-order-sweep.ts.
 *
 * Session-71 trap pinned: this TypeORM/pg stack returns DML-with-RETURNING
 * as a `[rows, rowCount]` TUPLE — a zero-row miss is `[[], 0]` (length 2!).
 * Never trust `result.length` on the raw return; normalize first.
 */

/** One aggregated line of the creation-time decrement snapshot. */
export interface StockDecrementEntry {
  menuItemId: string;
  quantity: number;
}

/** Minimal structural view of a cancellable order (no entity import, so
 *  order.entity can import StockDecrementEntry without a cycle). */
export interface RestockableOrder {
  id: string;
  stockDecrements?: StockDecrementEntry[] | null;
}

/** Normalize the `[rows, rowCount]`-tuple vs `rows` array shapes. */
export function rowsOfQueryResult(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return Array.isArray(result[0]) ? (result[0] as Array<Record<string, unknown>>) : (result as Array<Record<string, unknown>>);
  }
  return [];
}

/**
 * Sum the snapshot per dish, defensively. The snapshot is app-written
 * (create() aggregates duplicates itself), but it lives in a jsonb column a
 * human could edit raw: malformed entries are skipped, duplicate
 * menuItemIds fold into one add. Result order is NOT deterministic here —
 * callers sort (deterministic lock sequence, same as the decrement path).
 */
export function aggregateStockDecrements(
  snapshot: StockDecrementEntry[] | null | undefined,
): Map<string, number> {
  const totals = new Map<string, number>();
  if (!Array.isArray(snapshot)) return totals;
  for (const entry of snapshot) {
    if (!entry || typeof entry.menuItemId !== 'string' || entry.menuItemId === '') continue;
    const q = entry.quantity;
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 1) continue;
    totals.set(entry.menuItemId, (totals.get(entry.menuItemId) ?? 0) + q);
  }
  return totals;
}

/**
 * Return this cancelled order's reserved units. Resolves true when THIS
 * call performed the restock, false when it was a no-op (nothing was ever
 * decremented, another caller already restocked, or the order row is not
 * cancelled at this instant). Runs as ONE transaction: marker CAS + all
 * per-dish adds commit or roll back together.
 */
export async function restockCancelledOrder(
  manager: Pick<EntityManager, 'transaction'> | undefined | null,
  order: RestockableOrder,
  now: Date = new Date(),
): Promise<boolean> {
  const totals = aggregateStockDecrements(order.stockDecrements);
  if (totals.size === 0) return false; // decrement nothing at create -> return nothing
  if (!manager) return false; // defensive: unit harnesses without a real manager

  // Sorted menuItemId sequence — identical lock order as the create-side
  // decrement loop, so concurrent create+cancel on the same dishes lock in
  // the same sequence (deadlock mitigation, same rationale as session 71).
  const entries = [...totals.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );

  return manager.transaction(async (em) => {
    const cas = rowsOfQueryResult(
      await em.query(
        `UPDATE "orders" SET "stockRestockedAt" = $2
          WHERE "id" = $1 AND "stockRestockedAt" IS NULL AND "status" = 'cancelled'
          RETURNING "id"`,
        [order.id, now],
      ),
    );
    if (cas.length === 0) return false; // already restocked, or the row is not cancelled

    for (const [menuItemId, quantity] of entries) {
      // Zero rows = dish cleared to unlimited (NULL counter) or deleted —
      // an honest no-op for that row, never an error.
      await em.query(
        `UPDATE "menu_items" SET "stock" = "stock" + $2
          WHERE "id" = $1 AND "stock" IS NOT NULL
          RETURNING "stock"`,
        [menuItemId, quantity],
      );
    }
    return true;
  });
}
