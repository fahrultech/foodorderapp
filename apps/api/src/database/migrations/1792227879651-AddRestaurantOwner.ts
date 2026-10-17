import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRestaurantOwner1792227879651 implements MigrationInterface {
    name = 'AddRestaurantOwner1792227879651'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "restaurants" ADD "ownerId" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_restaurants_ownerId" ON "restaurants" ("ownerId") `);
        await queryRunner.query(`ALTER TABLE "restaurants" ADD CONSTRAINT "FK_9519e81d388514ec631d23fefca" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "restaurants" DROP CONSTRAINT "FK_9519e81d388514ec631d23fefca"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_restaurants_ownerId"`);
        await queryRunner.query(`ALTER TABLE "restaurants" DROP COLUMN "ownerId"`);
    }

}
