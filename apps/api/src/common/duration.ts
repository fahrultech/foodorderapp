const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `<integer><s|m|h|d>` — same shape the jsonwebtoken `expiresIn` option takes. */
const DURATION_RE = /^(\d+)([smhd])$/;

/**
 * Convert a TTL string ('30m', '12h', '30d') to milliseconds, so a single
 * config value can drive both the JWT `expiresIn` (which parses the string
 * itself) and the DB-side `expiresAt` column that needs an absolute Date.
 *
 * Throws on anything else: a misconfigured TTL must fail loudly at boot /
 * first token issue rather than silently minting tokens that never expire.
 */
export function durationToMs(value: string): number {
  const match = DURATION_RE.exec((value ?? '').trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${value}" — expected an integer followed by s, m, h or d (e.g. 30m, 12h, 30d)`,
    );
  }
  const amount = parseInt(match[1], 10);
  if (amount <= 0) throw new Error(`Invalid duration "${value}" — amount must be positive`);
  return amount * UNIT_MS[match[2]];
}

/** `now + ttl` as a Date, for expiry columns. */
export function expiryFrom(now: number, value: string): Date {
  return new Date(now + durationToMs(value));
}
