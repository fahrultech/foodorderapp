import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrderStatusTimestamps1792719166289 implements MigrationInterface {
    name = 'AddOrderStatusTimestamps1792719166289'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" ADD "confirmedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "orders" ADD "preparingAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "orders" ADD "deliveringAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "orders" ADD "completedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "orders" ADD "cancelledAt" TIMESTAMP`);
        // Backfill orders already past 'pending': the step the order sits in
        // right now gets updatedAt (that write IS the transition), earlier
        // steps get createdAt as a true lower bound, pending orders untouched.
        await queryRunner.query(`
          UPDATE "orders" SET
            "confirmedAt"  = CASE WHEN "status" = 'confirmed'                THEN "updatedAt"
                                   WHEN "status" IN ('preparing','delivering','completed') THEN "createdAt" END,
            "preparingAt"  = CASE WHEN "status" = 'preparing'                 THEN "updatedAt"
                                   WHEN "status" IN ('delivering','completed') THEN "createdAt" END,
            "deliveringAt" = CASE WHEN "status" = 'delivering'                THEN "updatedAt"
                                   WHEN "status" = 'completed'                 THEN "createdAt" END,
            "completedAt"  = CASE WHEN "status" = 'completed'                  THEN "updatedAt" END,
            "cancelledAt"  = CASE WHEN "status" = 'cancelled'                  THEN "updatedAt" END
          WHERE "status" <> 'pending'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "cancelledAt"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "completedAt"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "deliveringAt"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "preparingAt"`);
        await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "confirmedAt"`);
    }

}
