/**
 * Shared vocabulary for the two token kinds the API hands out.
 * Lives in `common/` so the guard can check the `typ` claim without importing
 * the auth module (which would drag TypeORM/repository decorators into it).
 */
import type { JwtSignOptions } from '@nestjs/jwt';

/** `typ` claim value on the short-lived access JWT. */
export const TOKEN_TYPE_ACCESS = 'access';

/** Defaults; override with JWT_ACCESS_TTL / JWT_REFRESH_TTL (format: `<int>[smhd]`). */
export const ACCESS_TTL_DEFAULT = '30m';
export const REFRESH_TTL_DEFAULT = '30d';

/** How jsonwebtoken types a TTL: a template-literal string (or seconds number). */
export type TokenTtl = NonNullable<JwtSignOptions['expiresIn']>;

/**
 * A TTL read from config/env is an untyped string. `durationToMs` validates the
 * shape wherever one is used (and throws at boot/issue time on garbage), so
 * this is the single place the template-literal type is satisfied by assertion
 * instead of sprinkling `as any` through the auth code.
 */
export function asTtl(value: string): TokenTtl {
  return value as TokenTtl;
}
