import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Menu-item stock guard (docs/ROADMAP.md Phase 5 "Unit-of-work: wrap order
 * create in a transaction + stock guard", session 71): a nullable
 * non-negative unit count on every dish. `NULL` = unlimited, which is the
 * state of ALL existing rows — the column alone changes nothing until an
 * owner sets a number. Order creation decrements it inside its own
 * transaction with `stock >= requested` baked into the UPDATE (atomic,
 * no read-then-write race). The CHECK mirrors the DTO bound (`@Min(0)`),
 * so even raw SQL cannot store negative sellable units.
 */
export class AddMenuItemStock1794380400000 implements MigrationInterface {
  name = 'AddMenuItemStock1794380400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "menu_items" ADD COLUMN "stock" integer NULL DEFAULT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "menu_items" ADD CONSTRAINT "CHK_menu_items_stock_nonnegative" CHECK ("stock" IS NULL OR "stock" >= 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "menu_items" DROP CONSTRAINT "CHK_menu_items_stock_nonnegative"`,
    );
    await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "stock"`);
  }
}
