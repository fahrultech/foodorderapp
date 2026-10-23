import { MigrationInterface, QueryRunner } from "typeorm";

export class AddReviews1792727031487 implements MigrationInterface {
    name = 'AddReviews1792727031487'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "reviews" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderId" uuid NOT NULL, "restaurantId" uuid NOT NULL, "userId" uuid NOT NULL, "rating" integer NOT NULL, "comment" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_reviews_orderId" UNIQUE ("orderId"), CONSTRAINT "PK_231ae565c273ee700b283f15c1d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_reviews_restaurantId" ON "reviews" ("restaurantId") `);
        await queryRunner.query(`CREATE INDEX "IDX_reviews_userId" ON "reviews" ("userId") `);
        await queryRunner.query(`ALTER TABLE "restaurants" ADD "ratingCount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "reviews" ADD CONSTRAINT "FK_53a68dc905777554b7f702791fa" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "reviews" ADD CONSTRAINT "FK_92ad8cd051c76d10e284bbc3283" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "reviews" ADD CONSTRAINT "FK_7ed5659e7139fc8bc039198cc1f" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "reviews" DROP CONSTRAINT "FK_7ed5659e7139fc8bc039198cc1f"`);
        await queryRunner.query(`ALTER TABLE "reviews" DROP CONSTRAINT "FK_92ad8cd051c76d10e284bbc3283"`);
        await queryRunner.query(`ALTER TABLE "reviews" DROP CONSTRAINT "FK_53a68dc905777554b7f702791fa"`);
        await queryRunner.query(`ALTER TABLE "restaurants" DROP COLUMN "ratingCount"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_reviews_userId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_reviews_restaurantId"`);
        await queryRunner.query(`DROP TABLE "reviews"`);
    }

}
