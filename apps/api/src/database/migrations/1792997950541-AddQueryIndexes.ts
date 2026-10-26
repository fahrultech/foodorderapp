import { MigrationInterface, QueryRunner } from "typeorm";

export class AddQueryIndexes1792997950541 implements MigrationInterface {
    name = 'AddQueryIndexes1792997950541'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_menu_items_restaurantId" ON "menu_items" ("restaurantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_order_items_orderId" ON "order_items" ("orderId") `);
        await queryRunner.query(`CREATE INDEX "IDX_orders_restaurantId_status" ON "orders" ("restaurantId", "status") `);
        await queryRunner.query(`CREATE INDEX "IDX_orders_restaurantId_createdAt" ON "orders" ("restaurantId", "createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_orders_userId_createdAt" ON "orders" ("userId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_orders_userId_createdAt"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_orders_restaurantId_createdAt"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_orders_restaurantId_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_order_items_orderId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_menu_items_restaurantId"`);
    }

}
