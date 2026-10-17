/** Canonical uuid v1-v8 form (case-insensitive). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard before hitting Postgres: a malformed uuid in a route param would
 * otherwise raise error 22P02 inside TypeORM and surface as an opaque 500.
 * Treat "not a uuid" as "not found" at the resource level.
 */
export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
