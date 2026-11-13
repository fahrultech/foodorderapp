/**
 * Hostile-input sanitizer for PUBLIC query strings that travel to Postgres
 * (session 79's contract gate, found by the Phase 7 fuzz suite, session 84).
 *
 * Why this exists: `?q=war%00ung` decodes to a string CONTAINING a NUL byte.
 * MinLength(1) counts code units happily and `trim()` does not consider
 * \u0000 whitespace — the junk reaches the driver and Postgres answers
 * `22021 invalid byte sequence for encoding "UTF8": 0x00`, i.e. a 500 on a
 * public GET. Same story for a LONE surrogate (`%ED%A0%80`): Node encodes
 * it CESU-8-style and Postgres rejects the malformed UTF-8 identically.
 * The public surface must answer 2xx/4xx only.
 *
 * The rule is shape-neutral BY DESIGN: illegal codepoints are DELETED, never
 * replaced with visible characters, and a fully-illegal value becomes the
 * EMPTY string — so the caller's truthiness branch (`if (q.search)`) sees
 * "absent" exactly as a blank does and the emitted statement shape can never
 * change with the input (the constant-shape half of the fuzz contract).
 *
 * Stripped: C0 control chars except \t, DEL, U+FFFD (a decoder artifact that
 * must never be searched FOR), and unpaired surrogates. Everything a user can
 * legitimately type — \t included, and every valid BMP/SMP character —
 * survives untouched. Idempotent, and returns the SAME string instance when
 * nothing was stripped (zero-cost for clean traffic).
 */
const ILLEGAL_CHARS_RE =
  /[\u0000-\u0008\u000B-\u001F\u007F\uFFFD]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** True when the string contains anything this sanitizer would strip. */
export function hasIllegalQueryChars(value: string): boolean {
  return (
    /[\u0000-\u0008\u000B-\u001F\u007F\uFFFD]/.test(value) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
  );
}

/**
 * Delete illegal codepoints. Non-strings (query objects, undefined) sanitize
 * to '' so a caller can hand `@Query()` results over unconditionally.
 */
export function stripIllegalQueryChars(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (!hasIllegalQueryChars(value)) return value;
  return value.replace(ILLEGAL_CHARS_RE, '');
}

/** Sanitize + trim — the canonical form for free-text filter values. */
export function sanitizeQueryText(value: unknown): string {
  return stripIllegalQueryChars(value).trim();
}
