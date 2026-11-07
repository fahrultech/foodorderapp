import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restaurant open hours (docs/ROADMAP.md Phase 5, session 68): a weekly
 * day-of-week schedule table + the IANA zone the windows are interpreted in.
 * CHECK domains mirror the DTO bounds exactly (see open-hours.ts), so a
 * bypassed validation can never smuggle nonsense into the schedule.
 * A restaurant WITHOUT rows keeps using the legacy manual `isOpen` column —
 * intentionally no backfill.
 */
export class AddRestaurantOpenHours1794121200000
  implements MigrationInterface
{
  name = 'AddRestaurantOpenHours1794121200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "restaurant_hours" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "restaurantId" uuid NOT NULL,
        "dayOfWeek" integer NOT NULL,
        "opensAt" character varying(5) NOT NULL,
        "closesAt" character varying(5) NOT NULL,
        CONSTRAINT "PK_restaurant_hours_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_restaurant_hours_day" CHECK ("dayOfWeek" >= 0 AND "dayOfWeek" <= 6),
        CONSTRAINT "CHK_restaurant_hours_opens" CHECK ("opensAt" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
        CONSTRAINT "CHK_restaurant_hours_closes" CHECK ("closesAt" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
        CONSTRAINT "UQ_restaurant_hours_restaurant_day" UNIQUE ("restaurantId", "dayOfWeek"),
        CONSTRAINT "FK_restaurant_hours_restaurantId" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE
      )
    `);
    // The unique index leads with restaurantId, which covers the
    // `WHERE restaurantId IN (...)` batch reads — no extra index.
    await queryRunner.query(
      `ALTER TABLE "restaurants" ADD COLUMN "timeZone" character varying(64) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "restaurants" DROP COLUMN "timeZone"`,
    );
    await queryRunner.query(`DROP TABLE "restaurant_hours"`);
  }
}
