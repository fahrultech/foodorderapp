import {
  DEFAULT_RECEIPT_TOKEN_TTL_SEC,
  MAX_RECEIPT_TOKEN_LEN,
  MAX_RECEIPT_TOKEN_TTL_SEC,
  issueReceiptAccessToken,
  receiptTokenTtlSec,
  verifyReceiptAccessToken,
} from './receipt-access';

/**
 * Pure crypto contract for the Phase 14 magic-link receipt capability.
 * The HTTP ladder wiring is specced in receipt-magic-link.http.spec.ts;
 * orders-ownership / receipt-proof-sweep pin the rungs around it.
 */

const ID = '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d';
const OTHER = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const SECRET = 'unit-receipt-secret-0123456789';
const NOW = 1_764_000_000_000; // fixed ms clock — deterministic expiry

describe('receiptTokenTtlSec (env knob)', () => {
  it('garbage/empty/non-positive -> 72h default, never 0 or NaN', () => {
    for (const raw of [undefined, null, '', '   ', 'abc', '0', '-5', '1.9x9', 'NaN']) {
      expect(receiptTokenTtlSec(raw as string)).toBe(DEFAULT_RECEIPT_TOKEN_TTL_SEC);
    }
  });
  it('valid values pass through; oversized clamps to the 30d ceiling', () => {
    expect(receiptTokenTtlSec('60')).toBe(60);
    expect(receiptTokenTtlSec(' 120 ')).toBe(120);
    expect(receiptTokenTtlSec('999999999999')).toBe(MAX_RECEIPT_TOKEN_TTL_SEC);
  });
});

describe('issue/verify round trip', () => {
  it('a freshly minted token verifies on its own order', () => {
    const tok = issueReceiptAccessToken(ID, SECRET, 60, NOW);
    expect(verifyReceiptAccessToken(tok, ID, SECRET, NOW)).toBe(true);
    expect(verifyReceiptAccessToken(tok, ID, SECRET, NOW + 59_000)).toBe(true);
  });
  it('token is URL-safe: only base64url alphabet plus one dot', () => {
    const tok = issueReceiptAccessToken(ID, SECRET, 60, NOW);
    expect(tok).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
  it('mints are stable within one expiry second (same id+ttl+clock)', () => {
    const a = issueReceiptAccessToken(ID, SECRET, 60, NOW);
    const b = issueReceiptAccessToken(ID, SECRET, 60, NOW);
    expect(a).toBe(b);
  });
});

describe('verify denies everything that is not a live capability', () => {
  const tok = issueReceiptAccessToken(ID, SECRET, 60, NOW);

  it('expired exactly at the boundary: exp must be strictly in the future', () => {
    expect(verifyReceiptAccessToken(tok, ID, SECRET, NOW + 60_000)).toBe(false);
    expect(verifyReceiptAccessToken(tok, ID, SECRET, NOW + 60_001)).toBe(false);
  });
  it('foreign order id denies (token is bound to ITS order)', () => {
    expect(verifyReceiptAccessToken(tok, OTHER, SECRET, NOW)).toBe(false);
  });
  it('wrong secret denies; empty/undefined secret denies anything', () => {
    expect(verifyReceiptAccessToken(tok, ID, SECRET + 'x', NOW)).toBe(false);
    expect(verifyReceiptAccessToken(tok, ID, '', NOW)).toBe(false);
    expect(verifyReceiptAccessToken(tok, ID, undefined, NOW)).toBe(false);
    expect(verifyReceiptAccessToken(tok, ID, null, NOW)).toBe(false);
  });
  it('tampered payload or signature denies', () => {
    const [p, s] = tok.split('.');
    const flip = (b: string) => (b[0] === 'A' ? 'B' + b.slice(1) : 'A' + b.slice(1));
    expect(verifyReceiptAccessToken(`${flip(p)}.${s}`, ID, SECRET, NOW)).toBe(false);
    expect(verifyReceiptAccessToken(`${p}.${flip(s)}`, ID, SECRET, NOW)).toBe(false);
    // signature swapped onto a different payload (the classic cut-and-paste)
    const tok2 = issueReceiptAccessToken(OTHER, SECRET, 60, NOW);
    const [p2, s2] = tok2.split('.');
    expect(verifyReceiptAccessToken(`${p}.${s2}`, ID, SECRET, NOW)).toBe(false);
    expect(verifyReceiptAccessToken(`${p2}.${s}`, OTHER, SECRET, NOW)).toBe(false);
  });
  it('structural junk denies without throwing (session-84 non-5xx doctrine)', () => {
    for (const junk of [
      '', '.', 'a', 'a.b', '..', '.b', 'a..b', '!!!.$$$',
      'x'.repeat(MAX_RECEIPT_TOKEN_LEN + 1),
      // base64url of "no-pipe", of "id|" and of "|123" payloads
      Buffer.from('no-pipe').toString('base64url') + '.' + s(tok),
      Buffer.from(ID + '|').toString('base64url') + '.' + s(tok),
      Buffer.from('|123').toString('base64url') + '.' + s(tok),
      Buffer.from(ID + '|abc').toString('base64url') + '.' + s(tok),
      Buffer.from(ID + '|0').toString('base64url') + '.' + s(tok),
      Buffer.from(ID + '|-5').toString('base64url') + '.' + s(tok),
    ]) {
      expect(verifyReceiptAccessToken(junk, ID, SECRET, NOW)).toBe(false);
    }
    function s(t: string) { return t.split('.')[1]; }
  });
  it('non-string wire shapes deny (repeated-key arrays, objects, null)', () => {
    expect(verifyReceiptAccessToken(undefined, ID, SECRET, NOW)).toBe(false);
    expect(verifyReceiptAccessToken(null, ID, SECRET, NOW)).toBe(false);
    expect(verifyReceiptAccessToken([tok, tok] as unknown as string, ID, SECRET, NOW)).toBe(false);
    expect(verifyReceiptAccessToken({ toString: () => tok } as unknown as string, ID, SECRET, NOW)).toBe(false);
    expect(verifyReceiptAccessToken(42 as unknown as string, ID, SECRET, NOW)).toBe(false);
  });
  it('an auth-module JWT is structurally NOT accepted (purpose-separated)', () => {
    // header.payload.signature has TWO dots — the verifier's lastIndexOf
    // would treat "sig" as base64url of the JWT signature and fail the HMAC
    // compare; pinned so a future format slip cannot cross the boundary.
    const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh';
    expect(verifyReceiptAccessToken(jwtLike, ID, SECRET, NOW)).toBe(false);
  });
});

describe('issue guards', () => {
  it('empty secret throws (a caller must never mint an unprotected link)', () => {
    expect(() => issueReceiptAccessToken(ID, '', 60, NOW)).toThrow(/secret/);
  });
  it('ttl is floored to at least 1s of life (never a born-expired token)', () => {
    const tok = issueReceiptAccessToken(ID, SECRET, 0, NOW);
    expect(verifyReceiptAccessToken(tok, ID, SECRET, NOW)).toBe(true);
    expect(verifyReceiptAccessToken(tok, ID, SECRET, NOW + 1_000)).toBe(false);
  });
});
