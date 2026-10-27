import { LessThan, Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';

/**
 * Auto-cancel stale *pending* orders (roadmap Phase 5 — "Scheduled cron:
 * auto-cancel stale pending orders").
 *
 * A customer can place an order as a guest (checkout is open by design) and
 * simply walk away. Until a human acts on it, a `pending` order is not a
 * commitment — it holds no prep, no stock, and it pollutes the owner inbox
 * with phantom demand. This sweep drains that backlog: any order still in
 * `pending` after the stale window moves to `cancelled` through the single
 * legal edge the status machine allows out of `pending`.
 *
 * Only `pending` is eligible on purpose. Once an owner has confirmed/started
 * an order, cancelling is a human decision the machine must never make, and
 * the customer already has their own self-cancel path (`OrdersService.cancel`).
 *
 * The logic is deliberately plain (a shared function taking a repository, no
 * Nest DI) so BOTH the cron runner script and the service can call the exact
 * same code — one implementation, no drift.
 */

/** Minutes after which an untouched `pending` order is considered abandoned. */
export const DEFAULT_STALE_ORDER_MINUTES = 45;
/** Max orders a single sweep run will touch, so a pathological backlog drains
 *  gradually instead of one unbounded query. */
export const DEFAULT_STALE_ORDER_BATCH = 500;

export interface StaleSweepOptions {
  /** Clock source — injectable so tests and the caller control "now". */
  now?: Date;
  /** Overrides `STALE_ORDER_MINUTES` for this call. */
  staleMinutes?: number;
  /** Overrides `STALE_ORDER_BATCH` for this call (max rows to cancel). */
  limit?: number;
  /** Called once per cancelled order (live SSE emit / logging hook). */
  onCancelled?: (order: Order) => void | Promise<void>;
  /** Pre-resolved config (used by the service wrapper); read from env otherwise. */
  config?: { staleMinutes: number; limit: number };
}

export interface StaleSweepReport {
  staleMinutes: number;
  /** ISO instant; an order is stale when createdAt < cutoff. */
  cutoff: string;
  /** Candidates selected this run (=== cancelled, since every candidate is cancelled). */
  scanned: number;
  cancelled: number;
  /** True when the run filled its whole batch — more stale rows likely remain, re-run to drain. */
  capped: boolean;
  orders: { id: string; code: string }[];
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Ops-tunable knobs without a redeploy, mirroring the rate-limit config style. */
export function resolveStaleSweepConfig(
  env: NodeJS.ProcessEnv = process.env,
): { staleMinutes: number; limit: number } {
  return {
    staleMinutes: positiveInt(env.STALE_ORDER_MINUTES, DEFAULT_STALE_ORDER_MINUTES),
    limit: positiveInt(env.STALE_ORDER_BATCH, DEFAULT_STALE_ORDER_BATCH),
  };
}

/**
 * Scan and cancel abandoned pending orders. Oldest-first, bounded per run.
 * `cancelledAt` is written-once (same policy as `OrdersService.applyStatus`) so
 * the tracking timeline keeps a true, non-overwritable cancel instant.
 *
 * `repo` is narrowed to `find | save` so callers can pass a full Repository, a
 * DataSource repository, or a test double.
 */
export async function runStaleOrderSweep(
  orders: Pick<Repository<Order>, 'find' | 'save'>,
  options: StaleSweepOptions = {},
): Promise<StaleSweepReport> {
  const cfg = options.config ?? resolveStaleSweepConfig();
  const staleMinutes = options.staleMinutes ?? cfg.staleMinutes;
  const limit = options.limit ?? cfg.limit;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000);

  const candidates = await orders.find({
    where: { status: OrderStatus.PENDING, createdAt: LessThan(cutoff) },
    order: { createdAt: 'ASC' },
    take: limit,
  });

  const cancelled: { id: string; code: string }[] = [];
  for (const order of candidates) {
    order.status = OrderStatus.CANCELLED;
    if (!order.cancelledAt) order.cancelledAt = now;
    await orders.save(order);
    cancelled.push({ id: order.id, code: order.code });
    await options.onCancelled?.(order);
  }

  return {
    staleMinutes,
    cutoff: cutoff.toISOString(),
    scanned: candidates.length,
    cancelled: cancelled.length,
    capped: candidates.length === limit && limit > 0,
    orders: cancelled,
  };
}
