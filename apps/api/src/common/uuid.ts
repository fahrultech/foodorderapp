import { Param, ParseUUIDPipe } from '@nestjs/common';

/** Canonical uuid v1-v8 form (case-insensitive). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Route-param decorator for every uuid-shaped path segment. Rejects a
 * malformed id with 400 BAD_REQUEST (Nest's ParseUUIDPipe, default `all`
 * version — same regex as `isUuid` below) BEFORE the guard/controller/service
 * chain runs, so Postgres never sees a junk uuid as a query parameter
 * (error 22P02 surfaced as an opaque 500 before this pipe was swept in).
 * Unknown-but-valid ids keep their existing per-route semantics (404 or
 * idempotent 2xx) — the pipe only checks SHAPE, never existence.
 *
 * Guards run before pipes in the Nest pipeline, so on authenticated routes
 * a missing/invalid token still answers 401 first; 400 for a malformed uuid
 * is only reachable with a valid caller (documented per route in Swagger).
 */
export const UuidParam = (name: string) => Param(name, ParseUUIDPipe);

/**
 * Guard before hitting Postgres: a malformed uuid in a route param would
 * otherwise raise error 22P02 inside TypeORM and surface as an opaque 500.
 * Treat "not a uuid" as "not found" at the resource level.
 */
export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
