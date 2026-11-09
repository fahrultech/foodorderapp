import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restock on cancellation (docs/ROADMAP.md Phase 5 follow-up to the session-71
 * stock guard): the stock counter was decrement-only, so a cancelled order
 * silently lost its reserved units forever. Two columns make the return
 * exact-once and race-safe:
 *
 * - `orders.stockDecrements` — jsonb snapshot `[{ menuItemId, quantity }]`
 *   written INSIDE the create transaction, recording the units this order
 *   really decremented (NULL = it decremented nothing: unlimited dishes, or
 *   legacy rows created before stock existed). Cancelling only ever returns
 *   what the snapshot says was taken — an order placed before an owner
 *   switched a dish to stock-managed can never inflate that counter.
 *   The CHECK keeps the column an array, mirroring the session-71
 *   "raw SQL cannot corrupt the invariant" stance.
 * - `orders.stockRestockedAt` — the exactly-once marker. The restock flips
 *   NULL -> timestamp in a conditional UPDATE (CAS); concurrent cancels of
 *   the same order serialize on that row and only the winner returns units.
 *   Same "the UPDATE's WHERE clause is the guard" shape as the decrement
 *   itself — no read-then-write race.
 */
export class AddOrderStockRestock1794466800000 implements MigrationInterface {
  name = 'AddOrderStockRestock1794466800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN "stockDecrements" jsonb NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "CHK_orders_stockDecrements_array" CHECK ("stockDecrements" IS NULL OR jsonb_typeof("stockDecrements") = 'array')`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN "stockRestockedAt" TIMESTAMP NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "CHK_orders_stockDecrements_array"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "stockRestockedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "stockDecrements"`,
    );
  }
}
