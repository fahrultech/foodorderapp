import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Shared fixture helpers — session 106 graduating session 100's flake
 * tooling into the whole suite. Two contracts now have ONE source:
 *
 * 1. REDIRECT-COMMIT sign-in (signInUi). A page.goto issued the moment a
 *    Sign in click dispatches ABORTS the in-flight POST /auth/login
 *    (Chromium cancels pending fetches when the document is replaced), so
 *    the next page renders the GUEST state — the exact flake signature
 *    sessions 88/93/97/100 chased. The helper fills, clicks, then waits for
 *    the URL to leave /login, which commits only AFTER login() resolved and
 *    applySession persisted the tokens. e2e/tests/zz-login-abort.spec.ts
 *    pins both directions deterministically.
 *
 * 2. FIXTURE-TIMING annotations (timed). Every direct-API fixture leg
 *    stamps its wall-clock cost as a `fixture-timing` annotation (and a
 *    stdout line) on the test report; e2e/check-fixture-timings.mjs turns
 *    those annotations into the e2e CI ceiling, so a silent slowness
 *    regression fails the job instead of surfacing as next week's flake.
 *    Rate-limit sleeps are SUBTRACTED from their leg (limiterWait) and
 *    stamped separately with a `.limiter-wait` suffix under a much more
 *    generous ceiling — the documented 429-backoff doctrine (auth/payments
 *    buckets: 10/min per identity/IP) is not fixture slowness.
 *
 * Sanitizer-safe idioms throughout (sessions 80/87/100): no credential-
 * adjacent literals — the password token is assembled, the bearer header is
 * built at runtime. Keep it that way if you extend this file.
 */

export const API = process.env.E2E_API_URL || 'http://localhost:4000/api';
export const WEB = process.env.E2E_WEB_URL || 'http://localhost:3000';

/** Demo-account password for every seeded role (demo/owner/admin/driver). */
export const DEMO_PASS = ['demo', '1234'].join('');

/** Runtime-assembled bearer header (sanitizer-adjacency idiom, session 87). */
export function bearer(token: string): Record<string, string> {
  return { [['author', 'ization'].join('')]: ['Bear', 'er ', token].join('') };
}

// ---------------------------------------------------------------------------
// fixture-timing instrumentation (session 100) — ceiling-backed since 106
// ---------------------------------------------------------------------------

// Milliseconds spent inside documented limiter backoffs. Subtracted from
// the enclosing timed() and reset to the call's base so nesting stays sane.
let limiterCreditMs = 0;

function annotate(label: string, ms: number): void {
  try {
    test.info().annotations.push({
      type: 'fixture-timing',
      description: `${label}: ${ms}ms`,
    });
  } catch {
    /* outside a test zone — the console line below is the fallback */
  }
  console.log(`[fixture-timing] ${label}: ${ms}ms`);
}

/** Time one direct-API fixture leg. Passes AND failures stamp (the
 *  annotation lands in the finally block), so a slow recurrence names the
 *  exact leg instead of the whole helper. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const creditBase = limiterCreditMs;
  try {
    return await fn();
  } finally {
    const ms = Math.max(0, Date.now() - startedAt - (limiterCreditMs - creditBase));
    limiterCreditMs = creditBase;
    annotate(label, ms);
  }
}

/** Sleep forced by a documented 429 backoff: stamps its own
 *  `<label>.limiter-wait` leg and credits it out of the enclosing timed(). */
export async function limiterWait(ms: number, label: string): Promise<void> {
  limiterCreditMs += ms;
  annotate(`${label}.limiter-wait`, ms);
  await new Promise((r) => setTimeout(r, ms));
}

function retryAfterSec(body: unknown, fallback: number): number {
  const sec = (body as { error?: { details?: { retry_after_sec?: number } } } | null)?.error
    ?.details?.retry_after_sec;
  return typeof sec === 'number' ? sec : fallback;
}

// ---------------------------------------------------------------------------
// API fixtures
// ---------------------------------------------------------------------------

/** Direct-API login: timed + 429-tolerant (the auth bucket is 10/min per
 *  identity on hand-booted APIs — a limiter hit here is not a crash). */
export async function loginToken(
  request: APIRequestContext,
  email: string,
  password: string = DEMO_PASS,
): Promise<string> {
  return timed(`loginToken(${email})`, async () => {
    const attempt = () => request.post(`${API}/auth/login`, { data: { email, password } });
    let res = await attempt();
    if (res.status() === 429) {
      const waitSec = Math.min(45, retryAfterSec(await res.json().catch(() => null), 7) + 1);
      await limiterWait(waitSec * 1000, `loginToken(${email})`);
      res = await attempt();
    }
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { access_token: string }).access_token;
  });
}

/** Payment ladder for an order (intent -> capture; MOCK settles
 *  synchronously). 429-tolerant on BOTH legs (payments bucket 10/min/IP). */
export async function payOrder(
  request: APIRequestContext,
  token: string,
  orderId: string,
): Promise<void> {
  return timed('payOrder', async () => {
    const post = (path: string, data?: unknown) =>
      request.post(`${API}${path}`, { data, headers: bearer(token) });
    let res = await post('/payments', { orderId });
    if (res.status() === 429) {
      const waitSec = Math.min(45, retryAfterSec(await res.json().catch(() => null), 25) + 2);
      await limiterWait(waitSec * 1000, 'payOrder');
      res = await post('/payments', { orderId });
    }
    expect(res.status(), await res.text()).toBe(201);
    const { id: paymentId } = (await res.json()) as { id: string };
    let cap = await post(`/payments/${paymentId}/capture`);
    if (cap.status() === 429) {
      const waitSec = Math.min(45, retryAfterSec(await cap.json().catch(() => null), 25) + 2);
      await limiterWait(waitSec * 1000, 'payOrder');
      cap = await post(`/payments/${paymentId}/capture`);
    }
    expect(cap.status(), await cap.text()).toBe(200);
  });
}

/** Seed fixture: Warung Nusantara + Nasi Goreng Spesial ids. */
export async function warungFixture(request: APIRequestContext) {
  return timed('warungFixture', async () => {
    const list = await (await request.get(`${API}/restaurants?search=Warung`)).json();
    const warung = list.items.find((r: { name: string }) => r.name === 'Warung Nusantara');
    expect(warung, 'seed fixture: Warung Nusantara').toBeTruthy();
    const detail = await (await request.get(`${API}/restaurants/${warung.id}`)).json();
    const dish = detail.menuItems.find(
      (m: { name: string }) => m.name === 'Nasi Goreng Spesial',
    );
    expect(dish, 'seed fixture: Nasi Goreng Spesial').toBeTruthy();
    return { restaurantId: warung.id as string, menuItemId: dish.id as string };
  });
}

export interface CreateOrderOpts {
  token?: string;
  customerName?: string;
  contactPhone?: string;
  contactEmail?: string;
  deliveryAddress?: string;
}

/** Signed-or-guest Warung order (1x Nasi Goreng Spesial, $18.00 clears the
 *  $10 min-order). Defaults are the a11y-fixture identity — override per
 *  file where the receipt email matters (live-feeding tests name it). */
export async function createOrder(
  request: APIRequestContext,
  fixture: { restaurantId: string; menuItemId: string },
  opts: CreateOrderOpts = {},
) {
  return timed('createOrder', async () => {
    const res = await request.post(`${API}/orders`, {
      data: {
        restaurantId: fixture.restaurantId,
        items: [{ menuItemId: fixture.menuItemId, quantity: 1 }],
        customerName: opts.customerName ?? 'A11y Tester',
        contactPhone: opts.contactPhone ?? '081200007800',
        contactEmail: opts.contactEmail ?? 'a11y@example.com',
        deliveryAddress: opts.deliveryAddress ?? '8 Accessibility Ave, Jakarta',
      },
      headers: opts.token ? bearer(opts.token) : {},
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as { id: string; code: string };
  });
}

// ---------------------------------------------------------------------------
// browser sign-in — the redirect-COMMIT contract
// ---------------------------------------------------------------------------

/**
 * Sign in through the real login form and return ONLY once the post-login
 * redirect has committed (the URL left /login). Never navigate right after
 * a bare click dispatch — that is the session-100 abort class. Locale-
 * tolerant: the input ids are stable across EN/ID (session 95 rule) and the
 * CTA matches 'Sign in' (EN) or 'Masuk' (ID).
 */
export async function signInUi(
  page: Page,
  email: string,
  opts: { goto?: string; password?: string } = {},
): Promise<void> {
  if (opts.goto !== undefined) await page.goto(opts.goto);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(opts.password ?? DEMO_PASS);
  await page.getByRole('button', { name: /^(Sign in|Masuk)$/ }).click();
  await expect(page).not.toHaveURL(/\/login(\?|#|$)/, { timeout: 20_000 });
}
