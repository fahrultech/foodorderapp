import { clampToIntRange } from './int-range';

/**
 * Unit spec for the public numeric query clamp (session 84 fuzz gate).
 * Postgres binds LIMIT/OFFSET as BIGINT: "2.5"/NaN/Infinity reach it as
 * text and answer 22P02 — an HTTP 500 on a public GET. The ONLY safe form
 * is a finite integer inside a closed range, for EVERY input shape.
 */

describe('clampToIntRange', () => {
  it('passes ordinary in-range integers through', () => {
    expect(clampToIntRange(1, 1, 50, 20)).toBe(1);
    expect(clampToIntRange('7', 1, 50, 20)).toBe(7);
    expect(clampToIntRange(50, 1, 50, 20)).toBe(50);
  });

  it('clamps to the closed range', () => {
    expect(clampToIntRange(0, 1, 50, 20)).toBe(1);
    expect(clampToIntRange(-999999, 1, 50, 20)).toBe(1);
    expect(clampToIntRange(999999, 1, 50, 20)).toBe(50);
    expect(clampToIntRange('1e9', 1, 50, 20)).toBe(50);
  });

  it('rounds fractional values BEFORE range math (bigint-safe output)', () => {
    expect(clampToIntRange(2.5, 1, 50, 20)).toBe(3);
    expect(clampToIntRange(2.4, 1, 50, 20)).toBe(2);
    expect(clampToIntRange('0.4', 1, 50, 20)).toBe(1); // round 0 -> clamp to min
    expect(clampToIntRange(50.4, 1, 50, 20)).toBe(50);
  });

  it('collapses every non-finite and non-numeric shape to the fallback', () => {
    // NOTE ''/[] are NOT fallback cases: Number() maps them to 0, so they
    // clamp to min — JS coercion, honestly applied. The SERVICE hides the
    // blank-string case by mapping '' to undefined before calling.
    for (const junk of [
      NaN,
      Infinity,
      -Infinity,
      'NaN',
      'Infinity',
      '-Infinity',
      'abc',
      '1;DROP',
      undefined,
      null,
      {},
      true,
    ]) {
      if (clampToIntRange(junk, 1, 50, 20) !== 20) {
        throw new Error(`junk=${JSON.stringify(junk)} → ${clampToIntRange(junk, 1, 50, 20)} want 20`);
      }
    }
    // zero-coercion shapes clamp to min (documented JS behavior):
    expect(clampToIntRange('', 1, 50, 20)).toBe(1);
    expect(clampToIntRange([], 1, 50, 20)).toBe(1);
    // a single-element numeric array coerces honestly (express never builds
    // this shape for a whitelisted param, but the mapping must be no surprise):
    expect(clampToIntRange(['7'], 1, 50, 20)).toBe(7);
  });

  it('empty-string params collapse to the fallback (unset semantics)', () => {
    // The SERVICE treats raw '' as unset the same way the old `Number(x)||d`
    // guard did: only real numbers clamp. clampToIntRange('', ...) would be 1,
    // so services must pass undefined/null through their own unset branch —
    // pin that the two-call contract behaves for the empty query param.
    expect(clampToIntRange(' 7 ', 1, 50, 20)).toBe(7);
    expect(clampToIntRange(0, 1, 50, 20)).toBe(1);
  });

  it('survives the bigint-escape case: page=1e23 lands on the ceiling', () => {
    expect(clampToIntRange('1e23', 1, 100_000, 1)).toBe(100_000);
    // OFFSET math then stays a safe integer no matter the limit:
    const page = clampToIntRange('1e23', 1, 100_000, 1);
    const limit = clampToIntRange('50', 1, 50, 20);
    expect(Number.isSafeInteger((page - 1) * limit)).toBe(true);
  });

  it('output is ALWAYS a finite integer for adversarial input', () => {
    const hostile = [
      '2.5', 'NaN', 'Infinity', '-Infinity', '1e23', '1e310', '0x10',
      '99999999999999999999999999999999', ' 7 ', '', '-', '1e', 'null',
      'undefined', '1.9999999999', '-0', '1E5', '0.001',
    ];
    for (const h of hostile) {
      const out = clampToIntRange(h, 1, 50, 20);
      expect(Number.isInteger(out)).toBe(true);
      expect(out).toBeGreaterThanOrEqual(1);
      expect(out).toBeLessThanOrEqual(50);
    }
  });
});
