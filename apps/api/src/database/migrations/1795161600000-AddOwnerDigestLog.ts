import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Owner-digest delivery ledger (docs/ROADMAP.md Phase 17, Product loop):
 * the `owner-digest` cron runner emails each restaurant owner yesterday's
 * order/revenue/top-dish figures through MailService. One row per
 * (owner, date) is the exactly-once gate; `sentAt` NULL distinguishes an
 * in-flight or crashed claim from a delivered digest, and a FAILED send
 * deletes its claim so the next tick retries.
 *
 * The numeric CHECKs mirror the entity's NOT NULL intent: aggregates are
 * known before the claim is written, and negatives are a bug, not data.
 */
export class AddOwnerDigestLog1795161600000 implements MigrationInterface {
  name = 'AddOwnerDigestLog1795161600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "owner_digest_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ownerId" uuid NOT NULL,
        "digestDate" date NOT NULL,
        "restaurantCount" integer NOT NULL,
        "orderCount" integer NOT NULL,
        "revenueCents" integer NOT NULL,
        "claimedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "sentAt" TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT "PK_owner_digest_logs_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_owner_digest_logs_owner_date" UNIQUE ("ownerId", "digestDate"),
        CONSTRAINT "CHK_owner_digest_logs_restaurant_count" CHECK ("restaurantCount" >= 0),
        CONSTRAINT "CHK_owner_digest_logs_order_count" CHECK ("orderCount" >= 0),
        CONSTRAINT "CHK_owner_digest_logs_revenue_cents" CHECK ("revenueCents" >= 0),
        CONSTRAINT "FK_owner_digest_logs_ownerId" FOREIGN KEY ("ownerId")
          REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "owner_digest_logs"`);
  }
}
