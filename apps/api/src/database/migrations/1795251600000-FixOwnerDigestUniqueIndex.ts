import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema-drift repair (session 149, caught by the CI fresh-Postgres drift
 * gate on runs #200/#201): session 147 created `owner_digest_logs`'s
 * (ownerId, digestDate) guard as a UNIQUE TABLE CONSTRAINT, while the
 * entity declares `@Index('UQ_owner_digest_logs_owner_date', ..., {unique})`
 * — Postgres introspection distinguishes the two backing objects, so the
 * entity-vs-chain diff was REAL drift (constraint drop + index create),
 * not one of the gate's known introspection-noise classes.
 *
 * The transform is semantics-identical: the same uniqueness guarantee and
 * the same name stay in place across the two statements (a dropped
 * constraint frees its index name; Postgres rejects nothing in between
 * because both DDLs run in the migration's single transaction). The digest
 * runner holds no constraint-name-referencing SQL (no named ON CONFLICT
 * arbiter anywhere — verified), so 23505 handling is column-list based and
 * keeps working untouched. Migrations are immutable once applied anywhere
 * (dev + CI + smoke DBs carry the constraint shape), so 147's file is NOT
 * edited — this migration converts instead.
 */
export class FixOwnerDigestUniqueIndex1795251600000 implements MigrationInterface {
  name = 'FixOwnerDigestUniqueIndex1795251600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "owner_digest_logs" DROP CONSTRAINT "UQ_owner_digest_logs_owner_date"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_owner_digest_logs_owner_date" ON "owner_digest_logs" ("ownerId", "digestDate")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_owner_digest_logs_owner_date"`,
    );
    await queryRunner.query(
      `ALTER TABLE "owner_digest_logs" ADD CONSTRAINT "UQ_owner_digest_logs_owner_date" UNIQUE ("ownerId", "digestDate")`,
    );
  }
}
