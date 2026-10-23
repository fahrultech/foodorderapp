import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDeliveryAddresses1792738602853 implements MigrationInterface {
    name = 'AddDeliveryAddresses1792738602853'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "delivery_addresses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "label" character varying(40) NOT NULL, "recipientName" character varying(120) NOT NULL, "phone" character varying(32) NOT NULL, "address" text NOT NULL, "isDefault" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_138238d6ec62ef07449c2a8fb11" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_delivery_addresses_userId" ON "delivery_addresses" ("userId") `);
        await queryRunner.query(`ALTER TABLE "delivery_addresses" ADD CONSTRAINT "FK_3d7fbb314ae1c5612cefb73742c" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "delivery_addresses" DROP CONSTRAINT "FK_3d7fbb314ae1c5612cefb73742c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_delivery_addresses_userId"`);
        await queryRunner.query(`DROP TABLE "delivery_addresses"`);
    }

}
