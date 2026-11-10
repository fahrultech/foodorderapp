import 'reflect-metadata';
import { AppDataSource } from '../database/data-source';
import {
  runRestockRepair,
  resolveRestockRepairConfig,
} from '../orders/stock-restock-repair';

/**
 * Standalone cron runner for the restock REPAIR pass (roadmap Phase 5,
 * session-72 follow-up: "cancelled orders whose snapshot is non-NULL but
 * stockRestockedAt stayed NULL must get their units back").
 *
 * This is the process a scheduler invokes (see ops/restock-repair.sh + the
 * systemd timer under ops/systemd/). It boots the TypeORM DataSource directly
 * (migrationsRun applies any pending schema first) and runs the SAME shared
 * `runRestockRepair` the admin HTTP route uses — one implementation, no
 * drift. Each orphan goes through the marker CAS, so even a scheduler firing
 * on top of a live API (which may repair concurrently) returns every unit
 * exactly once.
 *
 * Config comes from the environment (never inline secrets):
 *   DATABASE_URL                   connection string (from apps/api/.env by the wrapper)
 *   RESTOCK_REPAIR_GRACE_MINUTES   crash grace window (default 10)
 *   RESTOCK_REPAIR_BATCH           max repairs per run (default 500)
 *   DRY_RUN=1                      report what WOULD be repaired, mutate nothing
 *
 * Exit codes: 0 ok · 1 error (repair threw or DataSource failed to connect).
 */

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const manager = AppDataSource.manager;
  const config = resolveRestockRepairConfig();

  const report = await runRestockRepair(manager, { config, dryRun: DRY_RUN });

  // Summary to stdout as one JSON line for log scrapers; per-order detail on
  // stderr keeps stdout machine-parsable (same contract as cancel-stale).
  for (const o of report.orders) {
    console.error(`${DRY_RUN ? 'would repair' : 'repaired'} ${o.code} (${o.id}) units=${o.units}`);
  }
  console.log(
    JSON.stringify({
      dryRun: DRY_RUN,
      graceMinutes: report.graceMinutes,
      cutoff: report.cutoff,
      scanned: report.scanned,
      repaired: report.repaired,
      skipped: report.skipped,
      capped: report.capped,
    }),
  );
}

main()
  .catch((err) => {
    console.error('restock-repair: FAILED', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Always tear the connection down so a scheduled process exits cleanly.
    if (AppDataSource.isInitialized) void AppDataSource.destroy();
  });
