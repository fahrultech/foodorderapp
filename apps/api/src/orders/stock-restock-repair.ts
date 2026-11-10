import { EntityManager } from 'typeorm';
import {
  StockDecrementEntry,
  aggregateStockDecrements,
  restockCancelledOrder,
  rowsOfQueryResult,
} from './stock-restock';

/**
 * Restock REPAIR pass (docs/ROADMAP.md Phase 5, session-72 follow-up).
 *
 * Session 72 returns a cancelled order's reserved units from a transaction
 * that runs AFTER the status write committed. Two separate commits means a
 * narrow but real crash window: the process dies (OOM, deploy, kill) between
 * the status commit and the restock commit and the order is left `cancelled`
 * with a non-NULL `stockDecrements` snapshot and `stockRestockedAt` still
 * NULL. Nothing retried that today — the marker only made such rows
 * *identifiable*. This module drains them: find the orphans, hand each one to
 * the SAME `restockCancelledOrder`, so the units come back exactly once and
 * the normal cancel path can never double-return them either.
 *
 * Safety properties inherited from the shared restock primitive:
 * - The marker CAS (`stockRestockedAt NULL -> now()` inside its own
 *   transaction, pinned to `status = 'cancelled'`) is the exactly-once guard,
 *   so this pass is fully idempotent. Run it twice, or concurrently with a
 *   live cancel, and at most one of them moves the counters.
 * - `updatedAt < cutoff` is the grace window. A cancel that just committed
 *   its status and is (normally) about to restock inside the same request is
 *   NOT a crash yet, and the repair must not race a healthy path for the
 *   marker — an order whose units are about to be returned by its own
 *   transition looks identical to a crashed one until that transaction
 *   lands. Rows older than the grace window are genuinely orphans.
 * - The snapshot predicate mirrors the "was anything actually taken?" question
 *   exactly: a NULL or EMPTY snapshot means the order decremented NOTHING, so
 *   it is NOT an orphan (session-72's no-over-restock rule). A snapshot whose
 *   entries are ALL malformed is selected but resolves to a skipped no-op —
 *   and, since nothing marks it, it keeps showing up in every report until a
 *   human reads it. That is honest: junk in the ledger is an operator problem,
 *   not something the machine should silently paper over.
 *
 * Deliberately plain (a shared function over an EntityManager, no Nest DI),
 * same philosophy as `stock-restock.ts` / `stale-order-sweep.ts`: the HTTP
 * admin path, the in-process interval and the standalone cron script all run
 * the exact same code — one implementation, no drift.
 *
 * Session-71 trap still pinned: DML-with-RETURNING on this stack comes back as
 * a `[rows, rowCount]` TUPLE — every raw result goes through
 * `rowsOfQueryResult` before its length is trusted.
 */

/** Orphan cutoff: only orders untouched for at least this long are repaired. */
export const DEFAULT_RESTOCK_REPAIR_GRACE_MINUTES = 10;
/** Max orphans one run will repair, so a pathological backlog drains gradually. */
export const DEFAULT_RESTOCK_REPAIR_BATCH = 500;

export interface RestockRepairOptions {
  /** Clock source — injectable so tests and the caller control "now". */
  now?: Date;
  /** Overrides `RESTOCK_REPAIR_GRACE_MINUTES` for this call. */
  graceMinutes?: number;
  /** Overrides `RESTOCK_REPAIR_BATCH` for this call (max rows to repair). */
  limit?: number;
  /** Pre-resolved config (used by the service wrapper); read from env otherwise. */
  config?: { graceMinutes: number; limit: number };
  /** Report-only: select and describe the orphans, mutate nothing. */
  dryRun?: boolean;
}

export interface RestockRepairOrder {
  id: string;
  code: string;
  /** Units this repair returned (aggregated from the order's own snapshot). */
  units: number;
}

export interface RestockRepairReport {
  graceMinutes: number;
  /** ISO instant; an orphan is repaired only when updatedAt < cutoff. */
  cutoff: string;
  /** Orphan candidates selected this run (<= limit). */
  scanned: number;
  /** Orders whose units THIS run moved back (marker CAS winners). */
  repaired: number;
  /**
   * Candidates this run did NOT move: the marker CAS lost (a concurrent
   * cancel already restocked), the snapshot carried no usable entry, or
   * `dryRun` kept the run from touching anything.
   */
  skipped: number;
  /** True when the run filled its whole batch — more orphans likely remain. */
  capped: boolean;
  orders: RestockRepairOrder[];
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Ops-tunable knobs without a redeploy (same style as the stale sweep). */
export function resolveRestockRepairConfig(
  env: NodeJS.ProcessEnv = process.env,
): { graceMinutes: number; limit: number } {
  return {
    graceMinutes: positiveInt(
      env.RESTOCK_REPAIR_GRACE_MINUTES,
      DEFAULT_RESTOCK_REPAIR_GRACE_MINUTES,
    ),
    limit: positiveInt(env.RESTOCK_REPAIR_BATCH, DEFAULT_RESTOCK_REPAIR_BATCH),
  };
}

/** One orphan row as the scan reads it (entity-free on purpose). */
export interface RestockOrphanRow {
  id: string;
  code: string;
  stockDecrements: StockDecrementEntry[] | null;
}

/**
 * The orphan predicate, as ONE reusable SQL fragment so the scan and the
 * dry-run count can never drift apart.
 *
 * `jsonb_array_length(...) > 0` folds "snapshot present AND non-empty" into a
 * single guard: a NULL snapshot never satisfies it (array_length over NULL is
 * NULL, i.e. not true), which is exactly the session-72 rule — an order that
 * decremented nothing must never be "restocked".
 */
const ORPHAN_WHERE =
  `WHERE "status" = 'cancelled'
     AND "stockRestockedAt" IS NULL
     AND jsonb_typeof("stockDecrements") = 'array'
     AND jsonb_array_length("stockDecrements") > 0
     AND "updatedAt" < $1`;

/** Oldest-first, bounded orphan scan. */
export async function findRestockOrphans(
  manager: Pick<EntityManager, 'query'>,
  cutoff: Date,
  limit: number,
): Promise<RestockOrphanRow[]> {
  const rows = rowsOfQueryResult(
    await manager.query(
      `SELECT "id", "code", "stockDecrements"
         FROM "orders"
        ${ORPHAN_WHERE}
        ORDER BY "updatedAt" ASC
        LIMIT $2`,
      [cutoff, limit],
    ),
  );
  return rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    stockDecrements: Array.isArray(r.stockDecrements)
      ? (r.stockDecrements as StockDecrementEntry[])
      : null,
  }));
}

/**
 * Find and repair the crashed-cancel orphans. Runs one restock transaction
 * per orphan through the shared exactly-once primitive; each report entry
 * carries the units the order's own snapshot accounts for.
 */
export async function runRestockRepair(
  manager: Pick<EntityManager, 'query' | 'transaction'> | undefined | null,
  options: RestockRepairOptions = {},
): Promise<RestockRepairReport> {
  const cfg = options.config ?? resolveRestockRepairConfig();
  const graceMinutes = options.graceMinutes ?? cfg.graceMinutes;
  const limit = options.limit ?? cfg.limit;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - graceMinutes * 60_000);

  if (!manager) {
    return {
      graceMinutes,
      cutoff: cutoff.toISOString(),
      scanned: 0,
      repaired: 0,
      skipped: 0,
      capped: false,
      orders: [],
    };
  }

  const orphans = await findRestockOrphans(manager, cutoff, limit);
  const report: RestockRepairReport = {
    graceMinutes,
    cutoff: cutoff.toISOString(),
    scanned: orphans.length,
    repaired: 0,
    skipped: 0,
    capped: orphans.length === limit && limit > 0,
    orders: [],
  };

  for (const orphan of orphans) {
    const totals = aggregateStockDecrements(orphan.stockDecrements);
    const units = [...totals.values()].reduce((sum, q) => sum + q, 0);
    if (options.dryRun) {
      // Report-only: describe what a real run would return, touch nothing.
      report.skipped += 1;
      report.orders.push({
        id: orphan.id,
        code: orphan.code,
        units,
      });
      continue;
    }
    if (totals.size === 0) {
      // Snapshot present but carries no usable entry -> nothing to return.
      report.skipped += 1;
      continue;
    }
    const restocked = await restockCancelledOrder(manager, orphan, now);
    if (!restocked) {
      // Marker CAS lost: a concurrent cancel already returned these units.
      report.skipped += 1;
      continue;
    }
    report.repaired += 1;
    report.orders.push({
      id: orphan.id,
      code: orphan.code,
      units,
    });
  }

  return report;
}
