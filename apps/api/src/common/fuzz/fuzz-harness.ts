/**
 * Deterministic property-based fuzz harness for the public query surface
 * (Phase 7: "fuzz the public search/list query params"). No external
 * fast-check dependency: a seeded xorshift32 generator + fixed hostile
 * corpus, so every run is byte-reproducible — a FAIL prints its seed and
 * replays exactly. Sessions 84+.
 */

export interface Rng {
  next(): number; // uint32
  int(maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
}

export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 0x9e3779b9; // never start at zero
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  return {
    next,
    int: (n) => next() % n,
    pick: <T>(arr: readonly T[]): T => arr[next() % arr.length],
  };
}

/**
 * Hostile corpus for free-text params (`search`/`city`/`cuisine`/`q`).
 * Everything here is what a hostile GET can actually carry after
 * percent-decoding: SQL/LIKE metacharacters, injection idioms, C0
 * controls, NUL, lone surrogates (CESU-8 invalid UTF-8 for the driver),
 * U+FFFD, bidi/format marks, unicode that MUST survive untouched, and
 * oversize strings.
 */
export const HOSTILE_TEXT: readonly string[] = [
  // NUL + control bytes — the 22021/500 class
  '\u0000',
  'war\u0000ung',
  '\u0000\u0001\u0002sambal\u000b\f\r',
  'a\tb', // TAB is legal traffic — must survive
  '\u007f',
  // Lone surrogates — pg encodes these as invalid UTF-8
  '\ud800',
  'sate\udc00',
  '\udbff\udfff', // valid surrogate PAIR (emoji) — must survive
  '🍜 ramen',
  // Replacement char — decoder artifact
  '\ufffd',
  'bakso\ufffd',
  // LIKE / SQL metacharacters (must be escaped, never interpolated)
  '50%_off\\x',
  "%' OR 1=1 --",
  "'; DROP TABLE restaurants; --",
  "' UNION SELECT password FROM users --",
  '${7*7}', // template-expression confusion attempt
  'back\\slash',
  '%',
  '_',
  '\\',
  '%%__\\\\',
  '"quoted,;()sql"',
  '$1', // named-param token confusion
  ':s', // TypeORM named-param collision attempt
  'r.name', // orderBy-expression confusion attempt
  // Bidi / format / zero-width — legitimate text, never illegal
  '\u200bwarung\u200f',
  'warõnג', // combining + RTL base
  // Whitespace families
  '   ',
  '\u00a0',
  '\u2028\u2029',
  // Oversize
  'x'.repeat(101),
  'y'.repeat(2000),
  // Empty-ish
  '',
  // Ordinary control
  'sushi',
  'jakarta',
];

/** Hostile values for numeric-coerced params (`page`/`limit`). */
export const HOSTILE_NUMERIC: readonly string[] = [
  '0',
  '-1',
  '1',
  '1e9',
  '999999999999999999999999', // > Number.MAX_SAFE_INTEGER
  'NaN',
  'Infinity',
  '-Infinity',
  '2.5',
  ' 7 ',
  '',
  'abc',
  'null',
  'undefined',
  '0x10',
  '1;DROP',
  '🍜',
];

/** Hostile values for the whitelisted enum param (`sort`). */
export const HOSTILE_SORT: readonly string[] = [
  'rating',
  'deliveryFee',
  'newest',
  'RATING',
  'deliveryFee;DROP',
  '',
  '   ',
  'createdAt',
  'id',
  'r.id',
  'name ASC, id',
  '__proto__',
  'constructor',
  'toString',
  '\u0000',
];

/** Build one fuzz RestaurantQuery-ish case (every key present, junky). */
export function fuzzListQuery(rng: Rng): Record<string, string> {
  const q: Record<string, string> = {
    search: rng.pick(HOSTILE_TEXT),
    cuisine: rng.pick(HOSTILE_TEXT),
    city: rng.pick(HOSTILE_TEXT),
    sort: rng.pick(HOSTILE_SORT),
    page: rng.pick(HOSTILE_NUMERIC),
    limit: rng.pick(HOSTILE_NUMERIC),
  };
  // Randomly drop params — "absent" is the most common shape of all.
  for (const key of Object.keys(q)) if (rng.int(4) === 0) delete q[key];
  return q;
}

/**
 * percent-encode a value for a URL query string. encodeURIComponent throws
 * URIError on LONE SURROGATES — exactly the corpus cases the wire would
 * carry as invalid-UTF-8 CESU bytes — so encode via WHATWG URLSearchParams
 * semantics (TextEncoder replacement), like a real browser does.
 */
export function encodeParam(v: string): string {
  // TextEncoder replaces unpaired surrogates with U+FFFD (WHATWG behavior,
  // same as a browser putting the value into a URL).
  return encodeURIComponent(new TextDecoder().decode(new TextEncoder().encode(v)));
}
