import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPayments1793100690706 implements MigrationInterface {
    name = 'AddPayments1793100690706'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."payments_status_enum" AS ENUM('pending', 'succeeded', 'failed')`);
        await queryRunner.query(`CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderId" uuid NOT NULL, "userId" uuid, "provider" character varying(16) NOT NULL, "status" "public"."payments_status_enum" NOT NULL DEFAULT 'pending', "amountCents" integer NOT NULL, "currency" character varying(3) NOT NULL DEFAULT 'IDR', "providerRef" character varying(64), "failureReason" text, "succeededAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_684d092a3d90f53057424fc1ec4" UNIQUE ("providerRef"), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_payments_orderId_createdAt" ON "payments" ("orderId", "createdAt") `);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_af929a5f2a400fdb6913b4967e1" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_d35cb3c13a18e1ea1705b2817b1" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "FK_d35cb3c13a18e1ea1705b2817b1"`);
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "FK_af929a5f2a400fdb6913b4967e1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_payments_orderId_createdAt"`);
        await queryRunner.query(`DROP TABLE "payments"`);
        await queryRunner.query(`DROP TYPE "public"."payments_status_enum"`);
    }

}
