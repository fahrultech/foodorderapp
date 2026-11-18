import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Owner replies to customer reviews (docs/ROADMAP.md Phase 9). ONE reply
 * thread per review — the owner's public answer lives ON the review row,
 * not in a child table: there is no conversational depth to model yet, and
 * a single-column thread cannot fork, is trivially embedded by the public
 * feed (no join), and stays honest to the `reviews.orderId` uniqueness.
 *
 * `reply` + `repliedAt` are written TOGETHER (service sets/clears both in
 * one save); the CHECK pins that pairing at the DB so manual SQL drift
 * (a reply with no timestamp, or an orphan timestamp) fails loudly instead
 * of rendering a response card with no date on the storefront.
 *
 * NULL/NULL = "not replied yet" — every pre-existing row keeps exactly that,
 * so no backfill is needed.
 */
export class AddReviewReplies1794900600000 implements MigrationInterface {
  name = 'AddReviewReplies1794900600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reviews" ADD COLUMN "reply" character varying(2000) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" ADD COLUMN "repliedAt" timestamp with time zone NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" ADD CONSTRAINT "CHK_reviews_reply_pairing" CHECK ("reply" IS NULL OR "repliedAt" IS NOT NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "CHK_reviews_reply_pairing"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP COLUMN "repliedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP COLUMN "reply"`,
    );
  }
}
