/**
 * Magic-link receipt access tokens (Phase 14 #5).
 *
 * The confirmation / status-step emails link the receipt, and a bare link
 * used to demand the typed contact-email proof (session 76). This module
 * mints a SHORT-LIVED SIGNED CAPABILITY instead: `?rt=<token>` on
 * `GET /orders/:id` unlocks exactly the ONE order it was minted for —
 * the bearer ladder is unchanged, the email-proof ladder is unchanged.
 *
 * DI-free pure crypto (same doctrine as payment-confirm-gate /
 * delivery-eta): the service wires secret + TTL inputs, unit specs pin
 * the ladder. HMAC-SHA256 over an explicit purpose prefix, NOT a Nest
 * JWT — an access token and a receipt token are structurally unable to
 * impersonate each other (the auth module never sees this format and
 * this verifier never accepts a `typ: access` JWT payload shape).
 *
 * ONE-TIME semantics, honest reading: the roadmap asked for a "one-time
 * query rung". Tokens are TIME-BOUNDED, not nonce-consumed: the receipt
 * page makes several reads over seconds (reloads, the payment panel
 * retry) and an email can be opened on two devices, so consuming the
 * token on first use would break legitimate viewing while adding no
 * real security (a wire sniffing your token can also sniff the email
 * itself). Revocation is the expiry. Default TTL 72h; the env knob
 * `RECEIPT_TOKEN_TTL_SEC` adjusts it (garbage/non-positive -> default).
 *
 * Format (URL-safe end to end, no percent-encoding needed):
 *   base64url("<orderId>|<expiryEpochSec>") + "." + base64url(hmac)
 */
import { createHmac, timingSafeEqual } from 'crypto';

/** Purpose domain-separation — rotating it invalidates every issued token. */
const PURPOSE = 'foodorder:receipt-access:v1';

/** 72h: covers the full order lifecycle + a lazy email open the next day. */
export const DEFAULT_RECEIPT_TOKEN_TTL_SEC = 72 * 60 * 60;

/** Hard ceiling so a mistyped knob cannot mint near-permanent capabilities. */
export const MAX_RECEIPT_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

/** Cheap guard before touching HMAC on attacker-controlled query strings. */
export const MAX_RECEIPT_TOKEN_LEN = 4096;

/**
 * Parse RECEIPT_TOKEN_TTL_SEC: unset/empty/garbage/<=0 -> the 72h default;
 * valid values clamp to the 30-day ceiling. STRICT numeric (Number(), not
 * parseInt) so '1.9x9'-style junk follows the repo-wide garbage->default
 * doctrine rather than silently minting a 1-second capability. Never
 * throws, never zero.
 */
export function receiptTokenTtlSec(raw: string | undefined | null): number {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_RECEIPT_TOKEN_TTL_SEC;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RECEIPT_TOKEN_TTL_SEC;
  return Math.min(Math.floor(n), MAX_RECEIPT_TOKEN_TTL_SEC);
}

function signPayload(payloadB64: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`${PURPOSE}|${payloadB64}`).digest();
}

/**
 * Mint the capability token for one order id. `now` is injectable for
 * deterministic specs. An empty/missing secret throws (callers must not
 * ask for a link they cannot protect — the notifications service probes
 * the secret BEFORE calling).
 */
export function issueReceiptAccessToken(
  orderId: string,
  secret: string,
  ttlSec: number,
  now: number = Date.now(),
): string {
  if (!secret) throw new Error('receipt access tokens need a non-empty secret');
  const expSec = Math.floor(now / 1000) + Math.max(1, Math.floor(ttlSec));
  const payloadB64 = Buffer.from(`${orderId}|${expSec}`, 'utf8').toString('base64url');
  const sigB64 = signPayload(payloadB64, secret).toString('base64url');
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a presented token against the order it is presented on. ANY
 * problem (non-string wire shape, empty, oversize, bad structure, foreign
 * orderId, expired, tampered sig, missing secret) is a plain FALSE — the
 * ladder turns that into the SAME 404 as an unknown id (session 76's
 * no-oracle doctrine) and it can never throw a 500 (session 84).
 */
export function verifyReceiptAccessToken(
  token: string | undefined | null,
  orderId: string,
  secret: string | undefined | null,
  now: number = Date.now(),
): boolean {
  // typeof guard: a repeated `?rt=a&rt=b` arrives as an array before the
  // global pipe String()-coerces it (session-132 wire truth); direct
  // callers must still see DENY, never a crash.
  if (typeof token !== 'string' || !token || token.length > MAX_RECEIPT_TOKEN_LEN) return false;
  if (typeof secret !== 'string' || !secret) return false;

  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const presented = Buffer.from(sigB64, 'base64url');
  const computed = signPayload(payloadB64, secret);
  if (presented.length !== computed.length) return false;
  if (!timingSafeEqual(presented, computed)) return false;

  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  const sep = payload.lastIndexOf('|');
  if (sep <= 0 || sep === payload.length - 1) return false;
  const boundOrderId = payload.slice(0, sep);
  const expSec = Number.parseInt(payload.slice(sep + 1), 10);
  if (!Number.isFinite(expSec) || expSec <= 0) return false;

  // Exact capability match — the token unlocks ITS order, nothing else.
  if (boundOrderId !== orderId) return false;
  return expSec * 1000 > now;
}
