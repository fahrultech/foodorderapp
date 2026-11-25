import { expect, test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { createOrder, WEB, warungFixture } from '../helpers/fixtures';

/**
 * Phase 14 #5 magic-link receipt access, through the REAL browser:
 * the `?rt=` capability minted by the order emails (receipt-access.ts,
 * HMAC of the order id + expiry under JWT_SECRET) renders the receipt for
 * a total-stranger visitor with NOTHING typed — no bearer, no proof
 * email. Garbage/tampered tokens fall back to the untouched session-76
 * OrderVerify card (the ladder's denial shape), and an unlock-by-email
 * still works on a page whose rt died.
 *
 * Fixture contract: the token is minted IN-TEST using the product's OWN
 * compiled signer (`apps/api/dist/orders/receipt-access.js`, already a
 * runtime prerequisite — Playwright boots `dist/main.js`) with the secret
 * read from `apps/api/.env` at runtime (never inlined — sanitizer
 * doctrine). That pins the browser surface + wire wiring; the crypto and
 * the HTTP rung have their own API specs (receipt-access.spec.ts,
 * receipt-magic-link.http.spec.ts) and the live smoke extracts the token
 * from a real captured email instead.
 *
 * Orders are created over the API (own fixtures, unique emails) — zero
 * seed-state mutation, green across repeat runs (order-access.spec.ts
 * precedent).
 */

const nodeRequire = createRequire(__filename);
const RA_PATH = path.join(__dirname, '..', '..', 'apps', 'api', 'dist', 'orders', 'receipt-access.js');

interface ReceiptAccess {
  issueReceiptAccessToken: (id: string, secret: string, ttl: number, now?: number) => string;
  DEFAULT_RECEIPT_TOKEN_TTL_SEC: number;
}

function signer(): ReceiptAccess {
  // Fail LOUD (not skip): if the receipt token module ever vanishes from
  // the build, this spec must say so — the feature would be silently dead.
  if (!fs.existsSync(RA_PATH)) {
    throw new Error(`missing compiled signer: ${RA_PATH} (run the api build first)`);
  }
  return nodeRequire(RA_PATH) as ReceiptAccess;
}

function apiSecret(): string {
  const env = fs.readFileSync(
    path.join(__dirname, '..', '..', 'apps', 'api', '.env'),
    'utf8',
  );
  const m = env.match(/^JWT[_]SECRET=(.+)$/m);
  if (!m || !m[1].trim()) throw new Error('apps/api/.env secret not found (e2e prerequisite)');
  return m[1].trim();
}

test('magic link: valid rt renders the guest receipt with nothing typed', async ({ page, request }) => {
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, { contactEmail: 'magic-e2e@example.com' });
  const ra = signer();
  const tok = ra.issueReceiptAccessToken(order.id, apiSecret(), ra.DEFAULT_RECEIPT_TOKEN_TTL_SEC);

  await page.goto(`/orders/${order.id}?rt=${tok}`);
  await expect(
    page.getByRole('heading', { level: 1, name: `Order ${order.code} placed!` }),
  ).toBeVisible();
  // The fallback card must NOT be mounted — this is the whole point of the rung.
  await expect(page.getByRole('heading', { name: 'Order not found' })).toHaveCount(0);
  await expect(page.locator('#order-verify-email')).toHaveCount(0);
});

test('garbage and tampered rt fall back to the untouched OrderVerify card — email still unlocks', async ({
  page,
  request,
}) => {
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, { contactEmail: 'magic-rt@example.com' });

  await page.goto(`/orders/${order.id}?rt=not-even-a-token`);
  await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Is this your order?' })).toBeVisible();

  // Flip one payload char of a REAL token: signature check denies, same card.
  const ra = signer();
  const [p, s] = ra.issueReceiptAccessToken(order.id, apiSecret(), 3600).split('.');
  const flip = (b: string) => (b[0] === 'A' ? 'B' + b.slice(1) : 'A' + b.slice(1));
  await page.goto(`/orders/${order.id}?rt=${flip(p)}.${s}`);
  await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible();

  // The rung coexists with rung 3: the typed proof still unlocks.
  await page.locator('#order-verify-email').fill('magic-rt@example.com');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: `Order ${order.code} placed!` }),
  ).toBeVisible();
});

test('a token minted for one order cannot open another', async ({ page, request }) => {
  const fx = await warungFixture(request);
  const a = await createOrder(request, fx, { contactEmail: 'magic-a@example.com' });
  const b = await createOrder(request, fx, { contactEmail: 'magic-b@example.com' });
  const ra = signer();
  const tokA = ra.issueReceiptAccessToken(a.id, apiSecret(), 3600);

  await page.goto(`/orders/${b.id}?rt=${tokA}`);
  await expect(page.getByRole('heading', { name: 'Order not found' })).toBeVisible();
});

test('magic link under the ID locale renders localized receipt chrome', async ({ page, request }) => {
  const fx = await warungFixture(request);
  const order = await createOrder(request, fx, { contactEmail: 'magic-id@example.com' });
  const ra = signer();
  const tok = ra.issueReceiptAccessToken(order.id, apiSecret(), ra.DEFAULT_RECEIPT_TOKEN_TTL_SEC);

  await page.context().addCookies([{ name: 'locale', value: 'id', url: WEB }]);
  await page.goto(`/orders/${order.id}?rt=${tok}`);
  await expect(
    page.getByRole('heading', { level: 1, name: `Pesanan ${order.code} dibuat!` }),
  ).toBeVisible();
});
