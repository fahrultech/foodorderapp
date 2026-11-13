/**
 * Integer-range coercion for public query numbers (session 84 fuzz gate).
 *
 * Why this exists: the `GET /restaurants` list route has NO DTO in front —
 * raw `page`/`limit` strings reach the service, which previously only did
 * `Math.min(50, Math.max(1, Number(q.limit) || 20))`. That guard is not
 * INTEGER-safe: `limit=2.5` survives Math.max/min, TypeORM binds it, and
 * Postgres answers `22P02 invalid input syntax for type bigint: "2.5"` →
 * HTTP 500 on a public GET (fuzz-proven against the real driver). Same for
 * `NaN`/`Infinity` (Math.min/max propagate NaN) and a page so huge the
 * computed OFFSET escapes bigint.
 *
 * The rule: a public numeric query param is ALWAYS clamped into a closed
 * integer range — fractional values are rounded toward the nearer bound
 * (like Postgres would), non-finite values collapse to the fallback — and
 * that single integer is the ONLY thing that reaches the query. Callers
 * echo the clamped value in their response so clients see what was applied.
 */
export function clampToIntRange(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null) return fallback; // unset shapes
  // Booleans are NOT numeric input on any wire (query params arrive as
  // strings), but JS would coerce `true` to 1 — silently rewriting a junk
  // param into a valid-looking bound. Treat the shape as unset, honestly.
  if (typeof raw === 'boolean') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return Math.min(max, Math.max(min, rounded));
}
