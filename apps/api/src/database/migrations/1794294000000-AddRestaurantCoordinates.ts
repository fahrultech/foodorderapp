import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Restaurant map coordinates (docs/ROADMAP.md Phase 5 "Map view of
 * restaurants (Leaflet)", session 70): WGS84 decimal-degree pair on
 * restaurants, nullable so unmapped restaurants simply stay off the map.
 * CHECK domains mirror the DTO bounds exactly (`-90..90` / `-180..180`,
 * each column checked independently so a half-written pair — blocked at
 * the API layer — still cannot produce out-of-earth geometry via raw SQL).
 * No backfill here: the SEED owns coordinates for platform restaurants,
 * owners set their own via PATCH /restaurants/:id.
 */
export class AddRestaurantCoordinates1794294000000
  implements MigrationInterface
{
  name = 'AddRestaurantCoordinates1794294000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "restaurants" ADD COLUMN "latitude" double precision NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "restaurants" ADD COLUMN "longitude" double precision NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "restaurants" ADD CONSTRAINT "CHK_restaurants_latitude_range" CHECK ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90))`,
    );
    await queryRunner.query(
      `ALTER TABLE "restaurants" ADD CONSTRAINT "CHK_restaurants_longitude_range" CHECK ("longitude" IS NULL OR ("longitude" BETWEEN -180 AND 180))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "restaurants" DROP CONSTRAINT "CHK_restaurants_longitude_range"`,
    );
    await queryRunner.query(
      `ALTER TABLE "restaurants" DROP CONSTRAINT "CHK_restaurants_latitude_range"`,
    );
    await queryRunner.query(
      `ALTER TABLE "restaurants" DROP COLUMN "longitude"`,
    );
    await queryRunner.query(
      `ALTER TABLE "restaurants" DROP COLUMN "latitude"`,
    );
  }
}
