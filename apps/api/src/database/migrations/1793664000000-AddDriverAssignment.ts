import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PostgreSQL enum additions are intentionally irreversible here: removing an
 * enum value requires rebuilding the type and can corrupt rows that still use
 * it. Reverting this migration removes only the order assignment schema.
 */
export class AddDriverAssignment1793664000000 implements MigrationInterface {
  name = 'AddDriverAssignment1793664000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."users_role_enum" ADD VALUE IF NOT EXISTS 'driver'`,
    );
    await queryRunner.query(`ALTER TABLE "orders" ADD "driverId" uuid`);
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_driverId" ON "orders" ("driverId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_driverId_users_id" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_orders_driverId_users_id"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_driverId"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "driverId"`);
  }
}
