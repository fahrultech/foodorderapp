import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCities1793434169250 implements MigrationInterface {
    name = 'AddCities1793434169250'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "cities" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "slug" character varying(80) NOT NULL, "name" character varying(120) NOT NULL, "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_8ef722e770798e37b3205370bfd" UNIQUE ("slug"), CONSTRAINT "UQ_a0ae8d83b7d32359578c486e7f6" UNIQUE ("name"), CONSTRAINT "PK_4762ffb6e5d198cfec5606bc11e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "restaurants" ADD "cityId" uuid`);
        await queryRunner.query(`
          WITH source AS (
            SELECT MIN(BTRIM(city)) AS name,
              COALESCE(NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(BTRIM(city)), '[^a-z0-9]+', '-', 'g')), ''), 'city') AS base
            FROM restaurants
            WHERE city IS NOT NULL AND BTRIM(city) <> ''
            GROUP BY LOWER(BTRIM(city))
          ), ranked AS (
            SELECT name, base, ROW_NUMBER() OVER (PARTITION BY base ORDER BY name) AS n
            FROM source
          )
          INSERT INTO cities (name, slug)
          SELECT name,
            CASE WHEN n = 1 THEN LEFT(base, 80)
                 ELSE LEFT(base, 71) || '-' || n::text END
          FROM ranked
        `);
        await queryRunner.query(`
          UPDATE restaurants r
          SET "cityId" = c.id
          FROM cities c
          WHERE LOWER(c.name) = LOWER(BTRIM(r.city))
        `);
        await queryRunner.query(`CREATE INDEX "IDX_restaurants_cityId" ON "restaurants" ("cityId") `);
        await queryRunner.query(`ALTER TABLE "restaurants" ADD CONSTRAINT "FK_4264fec2a186dd2fcf82e00ff1d" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "restaurants" DROP CONSTRAINT "FK_4264fec2a186dd2fcf82e00ff1d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_restaurants_cityId"`);
        await queryRunner.query(`ALTER TABLE "restaurants" DROP COLUMN "cityId"`);
        await queryRunner.query(`DROP TABLE "cities"`);
    }

}
