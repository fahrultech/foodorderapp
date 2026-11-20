import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alert-verdict time series (docs/ROADMAP.md Phase 11, Ops loop): the rule
 * engine in src/ops/alerts.ts evaluated only the LIVE metrics snapshot, so
 * "is this alert new or has it been firing for hours?" was unanswerable —
 * and the alert-scan cron could not tell a first fire from the third
 * consecutive one. One small row is appended per metrics-snapshot tick,
 * alongside the session-89 `metrics_snapshots` table (same cadence +
 * retention knobs, same capturedAt-index serving newest-row/window/prune).
 *
 * The status CHECK mirrors the AlertStatus union in src/ops/alerts.ts; the
 * jsonb CHECKs keep firingRules an array and report an object so a
 * hand-mangled row fails at WRITE time, not in the history reader.
 */
export class AddAlertVerdicts1794988800000 implements MigrationInterface {
  name = 'AddAlertVerdicts1794988800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "alert_verdicts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "capturedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "status" character varying(16) NOT NULL,
        "firingRules" jsonb NOT NULL,
        "report" jsonb NOT NULL,
        CONSTRAINT "PK_alert_verdicts_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_alert_verdicts_status" CHECK ("status" IN ('ok', 'alerting')),
        CONSTRAINT "CHK_alert_verdicts_firing_rules_array" CHECK (jsonb_typeof("firingRules") = 'array'),
        CONSTRAINT "CHK_alert_verdicts_report_object" CHECK (jsonb_typeof("report") = 'object')
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_alert_verdicts_capturedAt" ON "alert_verdicts" ("capturedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_alert_verdicts_capturedAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "alert_verdicts"`);
  }
}
