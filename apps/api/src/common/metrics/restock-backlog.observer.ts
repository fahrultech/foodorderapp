import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RestockBacklogInput } from '../../ops/alerts';
import {
  countRestockOrphans,
  resolveRestockRepairConfig,
} from '../../orders/stock-restock-repair';

/**
 * The DB-backed observation supplier for the `restock_repair_backlog`
 * alert rule (Phase 14), mirroring the session-109 doctrine: the engine
 * in ops/alerts.ts stays DI-free and takes the observation from the
 * caller. This tiny provider owns the ONE read — a whole-table count over
 * the exact session-73 orphan predicate (`countRestockOrphans`, shared
 * with the repair scan itself, so the alert number and the drained number
 * can never drift) — and never throws: a failed count lands as
 * `backlog: null + storeError: true`, which the evaluator reports honestly
 * as "unreadable" (a broken read is never a false fire and never a
 * fabricated zero).
 *
 * The cutoff mirrors the repair config (RESTOCK_REPAIR_GRACE_MINUTES), so
 * rows the repair pass can still legitimately race are NEVER counted.
 */
@Injectable()
export class RestockBacklogObserver {
  private readonly logger = new Logger(RestockBacklogObserver.name);

  constructor(private readonly dataSource: DataSource) {}

  async input(): Promise<RestockBacklogInput> {
    const cfg = resolveRestockRepairConfig();
    const cutoff = new Date(Date.now() - cfg.graceMinutes * 60_000);
    try {
      const backlog = await countRestockOrphans(this.dataSource.manager, cutoff);
      return { backlog, graceMinutes: cfg.graceMinutes };
    } catch (err) {
      this.logger.warn(
        `restock backlog count read failed: ${(err as Error)?.message ?? 'unknown error'}`,
      );
      return { backlog: null, graceMinutes: cfg.graceMinutes, storeError: true };
    }
  }
}
