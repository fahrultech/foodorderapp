import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression guard for the transcript-sanitizer corruption class found in
 * session 40 (2026-10-28): the sanitizer rewrote outgoing tool arguments, so
 * credential VALUES typed into file writes landed in commits as literal
 * literal `***` / `\u2026` sequences. Dead-code fallbacks hid it for weeks — the
 * DATABASE_URL dev fallbacks in data-source.ts and app.module.ts carried a
 * masked password until session 41 repaired them from the untracked .env.
 *
 * These tests keep that from silently returning:
 *  1. no committed source file may contain a masked credential-shaped URL,
 *  2. the two DATABASE_URL fallbacks must be well-formed postgres URLs whose
 *     password segment carries no masking characters.
 *
 * They never print the credential values — assertions only.
 */

const SRC_ROOT = path.resolve(__dirname, '..');
const FALLBACK_FILES = [
  path.join(SRC_ROOT, 'database', 'data-source.ts'),
  path.join(SRC_ROOT, 'app.module.ts'),
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'migrations') continue;
      out.push(...listSourceFiles(p));
    } else if (entry.name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** A password segment containing only mask characters (`*` / `\u2026`). */
const MASKED_CREDENTIAL = /:([*\u2026]+)@/;

describe('committed credential fallbacks (sanitizer-corruption guard)', () => {
  it('no source file carries a masked postgres credential URL', () => {
    const offenders = listSourceFiles(SRC_ROOT).filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return [...text.matchAll(/'(postgresql?:\/\/[^']*)'/g)].some(
        (m) => MASKED_CREDENTIAL.test(m[1]) || m[1].includes('\u2026'),
      );
    });
    expect(offenders.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });

  it.each([
    ['data-source.ts', FALLBACK_FILES[0]],
    ['app.module.ts', FALLBACK_FILES[1]],
  ])('%s fallback is a well-formed URL with an unmasked password', (_name, file) => {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/'(postgresql:\/\/[^']*)'/);
    expect(m).not.toBeNull();
    const url = m![1];
    expect(url).toMatch(/^postgresql:\/\/[^:/@]+:[^@\u2026]+@[^/]+\/[^/]+$/);
    const password = url.slice(url.indexOf('://') + 3).split('@')[0].split(':').slice(1).join(':');
    expect(password.length).toBeGreaterThan(0);
    expect(/[*\u2026]/.test(password)).toBe(false);
  });
});
