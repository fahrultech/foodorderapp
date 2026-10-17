import { MigrationInterface, QueryRunner } from "typeorm";

export class InitSchema1792213437047 implements MigrationInterface {
    name = 'InitSchema1792213437047'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Pinned explicitly so a fresh database (e.g. official postgres:16 image,
        // where template1 has only plpgsql) does not depend on driver magic.
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('customer', 'owner', 'admin')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "name" character varying NOT NULL, "passwordHash" character varying NOT NULL, "phone" character varying, "address" character varying, "role" "public"."users_role_enum" NOT NULL DEFAULT 'customer', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "menu_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "description" text, "priceCents" integer NOT NULL, "category" character varying, "imageUrl" character varying, "isAvailable" boolean NOT NULL DEFAULT true, "prepMinutes" integer NOT NULL DEFAULT '15', "restaurantId" uuid NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_57e6188f929e5dc6919168620c8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "restaurants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "slug" character varying NOT NULL, "name" character varying NOT NULL, "description" text, "cuisine" character varying, "city" character varying, "address" character varying, "imageUrl" character varying, "rating" double precision NOT NULL DEFAULT '4.5', "deliveryFeeCents" integer NOT NULL DEFAULT '0', "minOrderCents" integer NOT NULL DEFAULT '0', "avgPrepMinutes" integer NOT NULL DEFAULT '30', "isOpen" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_afb6330c019768b4c3f9a65303c" UNIQUE ("slug"), CONSTRAINT "PK_e2133a72eb1cc8f588f7b503e68" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "order_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderId" uuid NOT NULL, "menuItemId" uuid, "name" character varying NOT NULL, "quantity" integer NOT NULL, "unitPriceCents" integer NOT NULL, CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."orders_status_enum" AS ENUM('pending', 'confirmed', 'preparing', 'delivering', 'completed', 'cancelled')`);
        await queryRunner.query(`CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying NOT NULL, "userId" uuid, "restaurantId" uuid NOT NULL, "status" "public"."orders_status_enum" NOT NULL DEFAULT 'pending', "subtotalCents" integer NOT NULL DEFAULT '0', "deliveryFeeCents" integer NOT NULL DEFAULT '0', "totalCents" integer NOT NULL DEFAULT '0', "customerName" character varying NOT NULL, "contactPhone" character varying NOT NULL, "deliveryAddress" text NOT NULL, "note" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_3e413c10c595c04c6c70e58a4dc" UNIQUE ("code"), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "menu_items" ADD CONSTRAINT "FK_a8ff5699334d3ca7b07421af0a9" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "FK_d8453d5a71e525d9b406c35aab8" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_151b79a83ba240b0cb31b2302d1" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_2312cd07a04f50ba29d76c9564e" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_2312cd07a04f50ba29d76c9564e"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_151b79a83ba240b0cb31b2302d1"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "FK_d8453d5a71e525d9b406c35aab8"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d"`);
        await queryRunner.query(`ALTER TABLE "menu_items" DROP CONSTRAINT "FK_a8ff5699334d3ca7b07421af0a9"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        await queryRunner.query(`DROP TYPE "public"."orders_status_enum"`);
        await queryRunner.query(`DROP TABLE "order_items"`);
        await queryRunner.query(`DROP TABLE "restaurants"`);
        await queryRunner.query(`DROP TABLE "menu_items"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
    }

}
