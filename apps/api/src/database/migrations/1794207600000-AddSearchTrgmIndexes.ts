import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fuzzy search foundation (docs/ROADMAP.md Phase 5, session 69): the
 * pg_trgm extension + GIN trigram indexes behind GET /api/search.
 *
 * - `pg_trgm` is a TRUSTED extension since PG13: a non-superuser DATABASE
 *   OWNER may CREATE EXTENSION, so the `foodorder` role runs this migration
 *   locally (DB owner) and CI's `foodorder` (initdb superuser) too.
 * - GIN + gin_trgm_ops serves BOTH the similarity operators (`%`, `%<` —
 *   thresholds are the pg_trgm GUC defaults, 0.3, never tuned elsewhere)
 *   and LIKE/ILIKE substring patterns.
 * - One index per searchable column; the relevance ranking expression is
 *   computed post-filter and needs no index of its own.
 *
 * down() drops only the indexes: other objects could grow trgm
 * dependencies over time, so the extension itself is left installed.
 */
export class AddSearchTrgmIndexes1794207600000 implements MigrationInterface {
  name = 'AddSearchTrgmIndexes1794207600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(
      `CREATE INDEX "IDX_restaurants_name_trgm" ON "restaurants" USING gin ("name" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_restaurants_description_trgm" ON "restaurants" USING gin ("description" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_menu_items_name_trgm" ON "menu_items" USING gin ("name" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_menu_items_description_trgm" ON "menu_items" USING gin ("description" gin_trgm_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_menu_items_description_trgm"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_menu_items_name_trgm"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_restaurants_description_trgm"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_restaurants_name_trgm"`);
  }
}
