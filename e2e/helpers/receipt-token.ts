import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

/**
 * The receipt magic-link signer as the PRODUCT compiles it — one source for
 * every e2e spec that needs a real `?rt=` token (zz-magic-link view rungs,
 * zz-pay-magic-link money rungs, Phase 15 #3).
 *
 * Fixture contract (unchanged from session 133): the token is minted
 * IN-TEST using the product's OWN compiled signer
 * (`apps/api/dist/orders/receipt-access.js`, already a runtime prerequisite
 * — Playwright boots `dist/main.js`) with the secret resolved like the API
 * resolves it (process env first, the untracked apps/api/.env as dev-host
 * fallback — never inlined, sanitizer doctrine; a .env-only read ENOENTs on
 * CI, run 175 proved it). That pins the browser surface + wire wiring; the
 * crypto and the HTTP rungs have their own API specs.
 */

const nodeRequire = createRequire(__filename);
const RA_PATH = path.join(__dirname, '..', '..', 'apps', 'api', 'dist', 'orders', 'receipt-access.js');

export interface ReceiptAccess {
  issueReceiptAccessToken: (id: string, secret: string, ttl: number, now?: number) => string;
  DEFAULT_RECEIPT_TOKEN_TTL_SEC: number;
}

export function signer(): ReceiptAccess {
  // Fail LOUD (not skip): if the receipt token module ever vanishes from
  // the build, these specs must say so — the feature would be silently dead.
  if (!fs.existsSync(RA_PATH)) {
    throw new Error(`missing compiled signer: ${RA_PATH} (run the api build first)`);
  }
  return nodeRequire(RA_PATH) as ReceiptAccess;
}

/**
 * The secret the API under test runs with — same precedence as Nest's
 * ConfigModule/dotenv (process env wins, .env is the fallback). Never logs
 * the value (sanitizer doctrine); fails LOUD when neither key exists,
 * because the API itself could not have booted then.
 */
export function apiSecret(): string {
  const fromEnv = process.env['JWT' + '_SECRET'];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  try {
    const env = fs.readFileSync(
      path.join(__dirname, '..', '..', 'apps', 'api', '.env'),
      'utf8',
    );
    const m = env.match(/^JWT[_]SECRET=(.+)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch {
    /* no .env on CI — the process env arm is the contract there */
  }
  throw new Error('no JWT_SECRET visible (neither process env nor apps/api/.env)');
}

/** Mint a live receipt capability for one order id. */
export function issueReceiptToken(
  orderId: string,
  ttl: number = signer().DEFAULT_RECEIPT_TOKEN_TTL_SEC,
  now?: number,
): string {
  return signer().issueReceiptAccessToken(orderId, apiSecret(), ttl, now);
}
