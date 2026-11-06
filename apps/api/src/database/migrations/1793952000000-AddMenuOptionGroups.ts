import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Menu options/variants (docs/ROADMAP.md Phase 5, session 65): option
 * groups + choices per dish, and an immutable jsonb receipt column on
 * order lines. CHECK domains mirror the DTO bounds exactly so a bypassed
 * validation can never smuggle nonsense into money-adjacent columns.
 */
export class AddMenuOptionGroups1793952000000 implements MigrationInterface {
  name = 'AddMenuOptionGroups1793952000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "menu_option_groups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "menuItemId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "minChoices" integer NOT NULL DEFAULT 0,
        "maxChoices" integer NOT NULL DEFAULT 1,
        "position" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_menu_option_groups_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_menu_option_groups_name" CHECK (length(btrim("name")) > 0),
        CONSTRAINT "CHK_menu_option_groups_min_choices" CHECK ("minChoices" >= 0 AND "minChoices" <= 20),
        CONSTRAINT "CHK_menu_option_groups_max_choices" CHECK ("maxChoices" >= 1 AND "maxChoices" <= 20 AND "maxChoices" >= "minChoices"),
        CONSTRAINT "FK_menu_option_groups_menuItemId" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_menu_option_groups_menuItemId" ON "menu_option_groups" ("menuItemId")`,
    );
    await queryRunner.query(`
      CREATE TABLE "menu_option_choices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "groupId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "priceDeltaCents" integer NOT NULL DEFAULT 0,
        "position" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_menu_option_choices_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_menu_option_choices_name" CHECK (length(btrim("name")) > 0),
        CONSTRAINT "CHK_menu_option_choices_delta" CHECK ("priceDeltaCents" >= 0 AND "priceDeltaCents" <= 10000000),
        CONSTRAINT "FK_menu_option_choices_groupId" FOREIGN KEY ("groupId") REFERENCES "menu_option_groups"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_menu_option_choices_groupId" ON "menu_option_choices" ("groupId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD COLUMN "optionSelections" jsonb NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN "optionSelections"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_menu_option_choices_groupId"`,
    );
    await queryRunner.query(`DROP TABLE "menu_option_choices"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_menu_option_groups_menuItemId"`,
    );
    await queryRunner.query(`DROP TABLE "menu_option_groups"`);
  }
}
