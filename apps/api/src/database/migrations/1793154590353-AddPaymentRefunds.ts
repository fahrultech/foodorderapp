import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Refund plumbing for payments (Phase 5 "refund flow"):
 *  - `refunded` joins the status enum (terminal — full refund landed),
 *  - `refundedCents` / `refundedAt` track refunds accumulating on the SAME
 *    row (partial keeps status `succeeded`; the exact captured amount flips
 *    it to `refunded` — the money trail never rewrites history),
 *  - a CHECK pins the invariant the service enforces (0 <= refundedCents <=
 *    amountCents) at the schema level. The constraint is ALSO declared on the
 *    entity via @Check with this exact name, so future migration:generate
 *    diffs see it and do not try to drop it.
 *
 * Hand-written, not the generated diff: TypeORM generated a
 * RENAME/recreate/USING-cast dance for the enum (table rewrite, heavier
 * locks). Postgres >= 12 runs `ALTER TYPE ... ADD VALUE` inside the
 * migration transaction fine as long as the new value is not USED in the
 * same transaction — no statement here uses it.
 *
 * Down drops the columns but deliberately cannot remove the enum VALUE
 * (Postgres has no ALTER TYPE DROP VALUE): a DB that ever stored 'refunded'
 * would need a full recreate this down refuses to fake.
 */
export class AddPaymentRefunds1793154590353 implements MigrationInterface {
    name = 'AddPaymentRefunds1793154590353'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TYPE "public"."payments_status_enum" ADD VALUE IF NOT EXISTS 'refunded' AFTER 'failed'`);
        await queryRunner.query(`ALTER TABLE "payments" ADD "refundedCents" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "payments" ADD "refundedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "CHK_payments_refund_bounds" CHECK ("refundedCents" >= 0 AND "refundedCents" <= "amountCents")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "CHK_payments_refund_bounds"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "refundedAt"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "refundedCents"`);
    }

}
