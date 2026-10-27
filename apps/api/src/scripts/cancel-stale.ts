import 'reflect-metadata';
import { AppDataSource } from '../database/data-source';
import { Order } from '../orders/order.entity';
import {
  runStaleOrderSweep,
  resolveStaleSweepConfig,
} from '../orders/stale-order-sweep';

/**
 * Standalone cron runner for the stale-pending-order sweep (roadmap Phase 5
 * "Scheduled cron: auto-cancel stale pending orders").
 *
 * This is the process a scheduler invokes (see ops/cancel-stale.sh + the
 * systemd timer under ops/systemd/). It boots the TypeORM DataSource directly
 * (migrationsRun applies any pending schema first) and runs the SAME shared
 * `runStaleOrderSweep` the admin HTTP route uses — one implementation, no
 * drift. There are no in-process SSE consumers here (separate process), so
 * live owner dashboards catch up on their next inbox poll; the DB truth is
 * cancelled immediately.
 *
 * Config comes from the environment (never inline secrets):
 *   DATABASE_URL         connection string (from apps/api/.env by the wrapper)
 *   STALE_ORDER_MINUTES  pending-abandonment window (default 45)
 *   STALE_ORDER_BATCH    max cancels per run        (default 500)
 *   DRY_RUN=1            report what WOULD be cancelled, mutate nothing
 *
 * Exit codes: 0 ok · 1 error (sweep threw or DataSource failed to connect).
 */

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const orders = AppDataSource.getRepository(Order);
  const config = resolveStaleSweepConfig();

  if (DRY_RUN) {
    // Report-only: find the candidates exactly as the sweep would, cancel none.
    // We pass an options.onCancelled that would be a no-op anyway; to avoid ANY
    // write we use a limit of 0? No — limit 0 would scan none. Instead run the
    // real query through the sweep against a save-less fake repo.
    const report = await runStaleOrderSweep({
      find: (opts: any) => orders.find(opts),
      save: async (entity: any) => entity,
    } as any, { config });
    console.log(
      JSON.stringify({
        dryRun: true,
        staleMinutes: report.staleMinutes,
        cutoff: report.cutoff,
        wouldCancel: report.cancelled,
        capped: report.capped,
        orders: report.orders,
      }),
    );
    return;
  }

  const report = await runStaleOrderSweep(orders, {
    config,
    onCancelled: (o) => console.error(`cancelled ${o.code} (${o.id})`),
  });

  // Summary to stdout as one JSON line for log scrapers; per-order detail on
  // stderr keeps stdout machine-parsable.
  console.log(
    JSON.stringify({
      dryRun: false,
      staleMinutes: report.staleMinutes,
      cutoff: report.cutoff,
      cancelled: report.cancelled,
      capped: report.capped,
    }),
  );
}

main()
  .catch((err) => {
    console.error('cancel-stale: FAILED', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Always tear the connection down so a scheduled process exits cleanly.
    if (AppDataSource.isInitialized) void AppDataSource.destroy();
  });
