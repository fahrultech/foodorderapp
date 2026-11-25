import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user notification channel settings (docs/ROADMAP.md Phase 14).
 *
 * Two NOT-NULL booleans with DB-level DEFAULT TRUE: the entire existing
 * population keeps today's all-or-nothing behavior (every channel on)
 * with no backfill statement needed — the column default IS the
 * migration backfill, and a row written before the app learned about
 * the columns still reads as enabled.
 *
 * NOT NULL on purpose: the fan-out gate uses a strict `=== false` check,
 * but "unknown" should never exist in the live schema — a nullable flag
 * would let importers mint tri-state rows the settings UI can't render.
 */
export class AddUserNotificationSettings1795075200000 implements MigrationInterface {
  name = 'AddUserNotificationSettings1795075200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "orderEmailEnabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "orderPushEnabled" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "orderPushEnabled"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "orderEmailEnabled"`);
  }
}
