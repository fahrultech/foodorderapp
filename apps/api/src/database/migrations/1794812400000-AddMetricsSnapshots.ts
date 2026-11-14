import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Metrics durability (docs/ROADMAP.md Phase 8): the request-metrics registry
 * is cumulative-since-boot by design, so every restart silently zeroes the
 * error budget. This table stores periodic full-snapshot copies (jsonb) plus
 * the producing registry's boot timestamp, so `GET /admin/metrics` can
 * expose window deltas and the history survives restarts. The capturedAt
 * index serves both the newest-row lookup (ORDER BY capturedAt DESC LIMIT 1)
 * and the retention prune (range delete on the same column).
 */
export class AddMetricsSnapshots1794812400000 implements MigrationInterface {
  name = 'AddMetricsSnapshots1794812400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "metrics_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "capturedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "bootStartedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "payload" jsonb NOT NULL,
        CONSTRAINT "PK_metrics_snapshots_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_metrics_snapshots_payload_object" CHECK (jsonb_typeof("payload") = 'object')
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_metrics_snapshots_capturedAt" ON "metrics_snapshots" ("capturedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_metrics_snapshots_capturedAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "metrics_snapshots"`);
  }
}
