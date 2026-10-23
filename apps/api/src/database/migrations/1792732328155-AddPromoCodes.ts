import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPromoCodes1792732328155 implements MigrationInterface {
    name = 'AddPromoCodes1792732328155'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."promo_codes_discounttype_enum" AS ENUM('percent', 'fixed')`);
        await queryRunner.query(`CREATE TABLE "promo_codes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying(24) NOT NULL, "description" text, "discountType" "public"."promo_codes_discounttype_enum" NOT NULL, "valueCents" integer NOT NULL, "maxDiscountCents" integer, "minSubtotalCents" integer NOT NULL DEFAULT '0', "restaurantId" uuid, "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c7b4f01710fda5afa056a2b4a35" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_promo_codes_code" ON "promo_codes" ("code") `);
        await queryRunner.query(`CREATE INDEX "IDX_promo_codes_restaurantId" ON "promo_codes" ("restaurantId") `);
        await queryRunner.query(`ALTER TABLE "orders" ADD "discountCents" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "orders" ADD "promoCode" character varying(24)`);
        await queryRunner.query(`ALTER TABLE "promo_codes" ADD CONSTRAINT "FK_1c60dfd812f76c38b00b4717b50" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "promo_codes" DROP CONSTRAINT "FK_1c60dfd812f76c38b00b4717b50"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "promoCode"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "discountCents"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_promo_codes_restaurantId"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_promo_codes_code"`);
        await queryRunner.query(`DROP TABLE "promo_codes"`);
        await queryRunner.query(`DROP TYPE "public"."promo_codes_discounttype_enum"`);
    }

}
