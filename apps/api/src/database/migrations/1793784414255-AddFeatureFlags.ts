import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFeatureFlags1793784414255 implements MigrationInterface {
    name = 'AddFeatureFlags1793784414255'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "feature_flags" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "key" character varying(80) NOT NULL, "description" text, "enabled" boolean NOT NULL DEFAULT false, "rolloutPercentage" smallint NOT NULL DEFAULT '100', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_36d0344370584b4d6a953c53a69" UNIQUE ("key"), CONSTRAINT "CHK_feature_flags_rollout_percentage" CHECK ("rolloutPercentage" >= 0 AND "rolloutPercentage" <= 100), CONSTRAINT "PK_db657d344e9caacfc9d5cf8bbac" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "feature_flags"`);
    }

}
