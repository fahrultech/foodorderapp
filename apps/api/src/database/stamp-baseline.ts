import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';

/**
 * Stamp the baseline migration onto an EXISTING database that was created
 * with `synchronize: true` (it already has all tables but no `migrations`
 * row). Without this, starting the app on such a DB would try to re-apply
 * InitSchema and fail with "relation already exists".
 *
 *   npm run db:stamp-baseline
 *
 * Dev databases with disposable data can instead just be wiped and reseeded:
 *   psql -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' && npm run seed
 * (seed now bootstraps the schema from migrations automatically).
 */
const BASELINE_TIMESTAMP = 1792213437047;
const BASELINE_NAME = 'InitSchema1792213437047';

async function main() {
  // Deliberately bypass AppDataSource's migrationsRun — we must NOT execute
  // any migration here, only record it.
  const dataSource = new DataSource({ ...dataSourceOptions, migrationsRun: false, migrations: [] });
  await dataSource.initialize();

  await dataSource.query(
    `CREATE TABLE IF NOT EXISTS "migrations"
       ("id" serial NOT NULL, "timestamp" bigint NOT NULL, "name" character varying NOT NULL,
        CONSTRAINT "PK_8cfa3977fb8753a14ef83cb0307" PRIMARY KEY ("id"))`,
  );
  await dataSource.query(
    `INSERT INTO "migrations" ("timestamp", "name")
     SELECT $1::bigint, $2::varchar
     WHERE NOT EXISTS (SELECT 1 FROM "migrations" WHERE "name" = $2::varchar)`,
    [BASELINE_TIMESTAMP, BASELINE_NAME],
  );
  const [{ c }] = await dataSource.query(
    `SELECT count(*)::int AS c FROM "migrations" WHERE "name" = $1`,
    [BASELINE_NAME],
  );
  console.log(
    Number(c) > 0
      ? `Baseline ${BASELINE_NAME} recorded (${c} row(s)) — pending migrations start from here.`
      : `Unexpected: baseline row missing after stamp.`,
  );
  await dataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
