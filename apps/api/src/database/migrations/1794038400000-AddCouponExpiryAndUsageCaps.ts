import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCouponExpiryAndUsageCaps1794038400000 implements MigrationInterface {
  name = 'AddCouponExpiryAndUsageCaps1794038400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "promo_codes" ADD "startsAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "promo_codes" ADD "expiresAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "promo_codes" ADD "maxTotalUsages" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "promo_codes" ADD "maxPerUser" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "promo_codes" ADD CONSTRAINT "CHK_promo_codes_max_total_usages" CHECK ("maxTotalUsages" IS NULL OR "maxTotalUsages" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "promo_codes" ADD CONSTRAINT "CHK_promo_codes_max_per_user" CHECK ("maxPerUser" IS NULL OR "maxPerUser" >= 0)`,
    );
    await queryRunner.query(`
      CREATE TABLE "promo_usages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "promoId" uuid NOT NULL,
        "orderId" uuid NOT NULL,
        "userId" uuid,
        "discountCents" integer NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_promo_usages_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_promo_usages_discount_cents" CHECK ("discountCents" >= 0),
        CONSTRAINT "FK_promo_usages_promoId" FOREIGN KEY ("promoId") REFERENCES "promo_codes"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_promo_usages_orderId" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_promo_usages_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_promo_usages_orderId" ON "promo_usages" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_promo_usages_promoId" ON "promo_usages" ("promoId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_promo_usages_promoId_userId" ON "promo_usages" ("promoId", "userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_promo_usages_promoId_userId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_promo_usages_promoId"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_promo_usages_orderId"`);
    await queryRunner.query(`DROP TABLE "promo_usages"`);
    await queryRunner.query(`ALTER TABLE "promo_codes" DROP CONSTRAINT "CHK_promo_codes_max_per_user"`);
    await queryRunner.query(`ALTER TABLE "promo_codes" DROP CONSTRAINT "CHK_promo_codes_max_total_usages"`);
    await queryRunner.query(`ALTER TABLE "promo_codes" DROP COLUMN "maxPerUser"`);
    await queryRunner.query(`ALTER TABLE "promo_codes" DROP COLUMN "maxTotalUsages"`);
    await queryRunner.query(`ALTER TABLE "promo_codes" DROP COLUMN "expiresAt"`);
    await queryRunner.query(`ALTER TABLE "promo_codes" DROP COLUMN "startsAt"`);
  }
}
