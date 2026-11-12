import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Perf sweep on GET /restaurants (docs/ROADMAP.md Phase 6, session 79):
 * the `search=` substring filter moved from `LOWER(col) LIKE` (a
 * function call on the column — never indexable) to plain `col ILIKE`
 * (case-insensitive substring, IDENTICAL match semantics), which the
 * session-69 `gin_trgm_ops` indexes serve directly. `name` was already
 * covered; `cuisine` — the other arm of the search OR — was not, and an
 * OR can only bitmap when EVERY arm has an index, so this adds the
 * missing partner. Same CREATE EXTENSION IF NOT EXISTS guard keeps the
 * migration order-independent on fresh databases.
 *
 * down() drops only the index.
 */
export class AddRestaurantCuisineTrgmIndex1794639600000 implements MigrationInterface {
  name = 'AddRestaurantCuisineTrgmIndex1794639600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(
      `CREATE INDEX "IDX_restaurants_cuisine_trgm" ON "restaurants" USING gin ("cuisine" gin_trgm_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_restaurants_cuisine_trgm"`);
  }
}
