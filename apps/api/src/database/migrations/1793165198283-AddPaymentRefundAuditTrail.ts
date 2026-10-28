import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Refund AUDIT TRAIL (Phase 5 follow-up): one append-only `payment_refunds`
 * row per LANDED refund — provider refund ref, this refund's cents, the
 * running refundedCents after it, and the acting admin (id FK SET NULL on
 * user delete + email snapshot from the JWT, so attribution outlives the
 * account). Written by PaymentsService.refund in the SAME transaction as the
 * compare-and-set update of the payment row it explains; declined/errored
 * attempts never appear. `providerRefundRef` is a 128-char snapshot column
 * WITHOUT a unique constraint: a schema rule must never be able to reject
 * the transaction of a refund the provider already executed. Composite index
 * matches the only read path (one payment's trail, chronological).
 *
 * Generated diff — reviewed: table + named CHECK + index + both FKs, nothing
 * else touched. CHECK declared on the entity too (@Check) so future
 * generate-diffs keep it. Down is a clean drop; the ledger has no partial
 * history to lose.
 */
export class AddPaymentRefundAuditTrail1793165198283 implements MigrationInterface {
    name = 'AddPaymentRefundAuditTrail1793165198283'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "payment_refunds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "paymentId" uuid NOT NULL, "provider" character varying(16) NOT NULL, "providerRefundRef" character varying(128), "amountCents" integer NOT NULL, "refundedAfterCents" integer NOT NULL, "actingAdminId" uuid, "actingAdminEmail" character varying(255), "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "CHK_payment_refunds_amount_positive" CHECK ("amountCents" > 0), CONSTRAINT "PK_c33fe9426d69e3d60080c7d2f06" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_payment_refunds_paymentId_createdAt" ON "payment_refunds" ("paymentId", "createdAt") `);
        await queryRunner.query(`ALTER TABLE "payment_refunds" ADD CONSTRAINT "FK_f201eeb6b580759255174f62162" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" ADD CONSTRAINT "FK_0a70f5af91d28b4af0d60c7aa9b" FOREIGN KEY ("actingAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payment_refunds" DROP CONSTRAINT "FK_0a70f5af91d28b4af0d60c7aa9b"`);
        await queryRunner.query(`ALTER TABLE "payment_refunds" DROP CONSTRAINT "FK_f201eeb6b580759255174f62162"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_payment_refunds_paymentId_createdAt"`);
        await queryRunner.query(`DROP TABLE "payment_refunds"`);
    }

}
