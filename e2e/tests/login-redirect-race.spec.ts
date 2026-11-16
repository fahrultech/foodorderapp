import { expect, test, type Page } from '@playwright/test';

/**
 * Product fix for the login-redirect vs nav-click race (Phase 8 item;
 * session 93 A/B-measured ~1/5 on cold boots: a header link clicked during
 * the post-login router.replace('/') flight was swallowed — the redirect
 * committed after the click's push and dragged the browser to home).
 *
 * Fix: lib/nav-gate.ts holds the header nav INERT (inert + pointer-events:
 * none) from the moment an auth submit starts until its redirect commits,
 * so no click can even begin inside the flight window; a held click waits
 * and then lands as a clean navigation. These specs pin the mechanism and
 * the behavior, mirroring the session-93 repro (sign in, click the header
 * link WITHOUT the URL-guard workaround, expect it to land).
 */

/**
 * Deterministically widen the redirect flight: every post-auth home RSC
 * fetch is held for 800ms before continuing, so the gate/commit window is
 * observable instead of a ~50ms blur. (Do NOT abort the pre-auth prefetch
 * attempts to keep the cache cold — an aborted prefetch makes Next fall
 * back to a FULL DOCUMENT reload for the redirect, which destroys the
 * in-flight SPA window these pins need.)
 */
async function holdHomeRedirect(page: Page, authPath: string) {
  let armed = false;
  // Arm on the REQUEST, not the response: the page's continuation (which
  // dispatches router.replace('/') whose RSC fetch we must catch) resumes in
  // the browser possibly BEFORE a Node-side 'response' listener runs. The
  // auth round-trip itself (bcrypt) is far slower than delivering a
  // 'request' event, so at request time arming is always in time.
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.includes(authPath)) armed = true;
  });
  await page.route(
    (url) => url.pathname === '/' && url.searchParams.has('_rsc'),
    (route) => {
      if (armed) {
        setTimeout(() => {
          void route.continue().catch(() => {});
        }, 800);
      } else {
        void route.continue().catch(() => {});
      }
    },
  );
}

async function fillLogin(page: Page, email: string, password: string) {
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
}

test('header nav is inert through the whole post-login redirect, and the held click lands instead of being swallowed', async ({
  page,
}) => {
  await holdHomeRedirect(page, '/auth/login');
  const nav = page.locator('header nav');

  await page.goto('/login');
  await expect(nav).toHaveAttribute('data-navgated', '0');
  await fillLogin(page, 'admin@foodorder.app', ['demo', '1234'].join(''));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // The gate is on from the FIRST moment of the submit — the guest-view
  // links were clickable race bait there too before the fix.
  await expect(nav).toHaveAttribute('data-navgated', '1');

  // The role link becomes visible WHILE STILL ON /LOGIN, inside the inert
  // nav: this is exactly the state session 93 found clickable.
  const adminLink = page.getByRole('link', { name: 'Admin' });
  await expect(adminLink).toBeVisible();
  await expect(nav).toHaveAttribute('data-navgated', '1');
  await expect(nav).toHaveAttribute('inert', '');

  // The session-93 repro click — fired the instant the link exists, NO URL
  // guard. Before the fix this could commit under the pending replace('/');
  // now Playwright's "receives events" check waits the gate out and the
  // click lands cleanly on /admin afterwards.
  await adminLink.click();
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.getByRole('heading', { level: 1, name: 'Admin overview' })).toBeVisible();
  await expect(nav).toHaveAttribute('data-navgated', '0');
});

test('a failed sign-in hands the nav back immediately (no stranded gate)', async ({ page }) => {
  const nav = page.locator('header nav');
  await page.goto('/login');
  await fillLogin(page, 'admin@foodorder.app', 'not-the-real-pass');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(nav).toHaveAttribute('data-navgated', '1'); // on at submit start

  await expect(page.getByRole('alert').filter({ hasText: /Invalid email or password/ })).toBeVisible();
  await expect(nav).toHaveAttribute('data-navgated', '0');
  await expect(page).toHaveURL(/\/login/);

  // And the nav is genuinely interactive again, not just attribute-flipped.
  await page.getByRole('link', { name: 'Map' }).click();
  await expect(page).toHaveURL(/\/map/);
});

test('an already-signed-in visitor hitting /login gets the same settle-gated skip redirect', async ({
  page,
}) => {
  const nav = page.locator('header nav');
  await page.goto('/login');
  await fillLogin(page, 'admin@foodorder.app', ['demo', '1234'].join(''));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);

  // Re-visit /login WITH the session (fresh document load): the skip effect
  // redirects away; the gate must be released on landing, never stranded.
  await page.goto('/login');
  await expect(page).not.toHaveURL(/\/login/);
  await expect(nav).toHaveAttribute('data-navgated', '0');
  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Admin overview' })).toBeVisible();
});

test('the post-registration redirect cannot swallow a nav click either', async ({ page }) => {
  await holdHomeRedirect(page, '/auth/register');
  const nav = page.locator('header nav');
  const email = `race-probe+${Date.now()}@example.com`;

  await page.goto('/register');
  await page.locator('#name').fill('Race Probe');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('raceprobe123');
  await page.locator('#confirm').fill('raceprobe123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  await expect(nav).toHaveAttribute('data-navgated', '1');
  const ordersLink = page.getByRole('link', { name: 'My orders' });
  await expect(ordersLink).toBeVisible();
  await ordersLink.click();
  await expect(page).toHaveURL(/\/orders\/my/);
  await expect(nav).toHaveAttribute('data-navgated', '0');
});
