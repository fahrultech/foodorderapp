import {
  hasIllegalQueryChars,
  sanitizeQueryText,
  stripIllegalQueryChars,
} from './query-sanitizer';
import { HOSTILE_TEXT, HOSTILE_NUMERIC, HOSTILE_SORT, makeRng } from './fuzz/fuzz-harness';

/**
 * Unit spec for the public query sanitizer (session 84). The rule is
 * DELETE-only: illegal wire content (NUL, C0 controls except TAB, DEL,
 * U+FFFD, unpaired surrogates) is removed, everything a user can legitimately
 * type survives BYTE-IDENTICAL, and non-strings collapse to '' — so callers
 * branch on presence exactly as before (constant statement shape).
 */

const LEGAL_SAMPLES = [
  '',
  'warung',
  '50%_off\\x',
  "' OR 1=1 --",
  '\u0009', // TAB survives
  '\u00e9\u1b00\u4e2d\u6587', // accents / combining / CJK survive
  '\u{1f35c} ramen', // surrogate PAIR (valid) survives
  '\u200b\u2028\u00a0', // zero-width / line separators / NBSP survive
];

describe('stripIllegalQueryChars — deletion rule', () => {
  it.each(LEGAL_SAMPLES)('passes legal text through byte-identical: %j', (s) => {
    expect(stripIllegalQueryChars(s)).toBe(s);
    expect(hasIllegalQueryChars(s)).toBe(false);
  });

  it('deletes NUL bytes wherever they sit', () => {
    expect(stripIllegalQueryChars('war\u0000ung')).toBe('warung');
    expect(stripIllegalQueryChars('\u0000')).toBe('');
  });

  it('deletes other C0 controls and DEL but keeps TAB', () => {
    expect(stripIllegalQueryChars('a\u0001\u0002b\u000bc\u001fd\u007fe')).toBe('abcde');
    expect(stripIllegalQueryChars('a\tb')).toBe('a\tb');
  });

  it('deletes U+FFFD (decoder artifacts must never be searched FOR)', () => {
    expect(stripIllegalQueryChars('bakso\ufffd')).toBe('bakso');
  });

  it('deletes UNPAIRED surrogates but keeps valid pairs', () => {
    expect(stripIllegalQueryChars('\ud800')).toBe('');
    expect(stripIllegalQueryChars('sate\udc00')).toBe('sate');
    expect(stripIllegalQueryChars('\ud83d\ude00')).toBe('\ud83d\ude00'); // 😀 intact
    expect(stripIllegalQueryChars('x\ud800y')).toBe('xy'); // high orphan
    expect(stripIllegalQueryChars('x\udc00y')).toBe('xy'); // low orphan
    expect(stripIllegalQueryChars('ok\ud83d\ude00!')).toBe('ok\ud83d\ude00!'); // intact, surrounded
  });

  it('collapses non-strings to empty (query objects, undefined, arrays)', () => {
    for (const junk of [undefined, null, 42, {}, ['a', 'b'], new Set()]) {
      expect(stripIllegalQueryChars(junk as any)).toBe('');
    }
  });
});

describe('sanitizeQueryText — sanitize + trim, property checks', () => {
  it('trims AFTER deletion: junk that leaves only whitespace is empty', () => {
    expect(sanitizeQueryText('\u0000   ')).toBe('');
    expect(sanitizeQueryText('  warung ')).toBe('warung');
  });

  const rng = makeRng(0x840001);
  it.each(HOSTILE_TEXT.map((s, i) => [i, s] as const))(
    'corpus[%i] output is legal and idempotent: %j',
    (_i, s) => {
      const once = sanitizeQueryText(s);
      expect(hasIllegalQueryChars(once)).toBe(false);
      expect(sanitizeQueryText(once)).toBe(once); // idempotent
      expect(once.trim()).toBe(once); // canonical form carries no outer whitespace
    },
  );

  it('never grows a string: pure deletion, composition-safe over concatenation', () => {
    for (let i = 0; i < 300; i++) {
      const a = HOSTILE_TEXT[rng.int(HOSTILE_TEXT.length)];
      const b = HOSTILE_TEXT[rng.int(HOSTILE_TEXT.length)];
      const joined = sanitizeQueryText(a + b);
      expect(joined.length).toBeLessThanOrEqual((a + b).length);
      // Deletion-only semantics: sanitizing a concatenation equals sanitizing
      // the parts and trimming the seam (no substitution can "bridge" junk).
      expect(joined).toBe((stripIllegalQueryChars(a) + stripIllegalQueryChars(b)).trim());
    }
  });
});
