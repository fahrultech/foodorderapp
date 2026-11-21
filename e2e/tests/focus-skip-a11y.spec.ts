import { expect, test, type Page } from '@playwright/test';
import { signInUi, WEB } from '../helpers/fixtures';

/**
 * Session 117 (Phase 11 UX): focus-visibility + skip-link audit.
 *
 * The product contract lives in ONE global CSS rule (app/globals.css):
 * every keyboard-reachable control gets a 2px solid brand outline with a
 * 2px offset under `:focus-visible` (light: brand-600 rgb(234,88,12),
 * dark: brand-500), and the root layout ships a `Common.skipToContent`
 * link that is sr-only until focused and moves document focus to
 * #main-content.
 *
 * These specs PIN that contract the keyboard way: every ring assertion is
 * earned by real Tab presses (never `.focus()` — programmatic focus does
 * not reliably match :focus-visible), walking tab order until the target
 * is active, then reading its computed outline. The suite stays read-only:
 * sign-ins and navigation only, no orders, seed-safe.
 *
 * Accounts: owner@foodorder.app / driver@foodorder.app (pw demo1234),
 * admin@foodorder.app.
 */

const RING = {
  style: 'solid',
  width: 2,
  color: 'rgb(234, 88, 12)', // brand-600 (light theme = suite default)
  offset: 2,
} as const;

async function pressUntilFocused(page: Page, selector: string, cap = 80): Promise<void> {
  for (let i = 0; i < cap; i += 1) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(
      (sel) => document.activeElement instanceof Element && document.activeElement.matches(sel),
      selector,
    );
    if (hit) return;
  }
  throw new Error(`Tab-walk never focused "${selector}" within ${cap} presses`);
}

async function ringOfFocused(page: Page) {
  return page.evaluate(() => {
    const s = getComputedStyle(document.activeElement as Element);
    return {
      style: s.outlineStyle,
      width: parseFloat(s.outlineWidth),
      color: s.outlineColor,
      offset: parseFloat(s.outlineOffset),
    };
  });
}

async function expectRing(page: Page, selector: string): Promise<void> {
  await pressUntilFocused(page, selector);
  expect(await ringOfFocused(page)).toEqual(RING);
}

test('storefront ships a keyboard-discoverable skip link that moves focus to the content', async ({
  page,
}) => {
  await page.goto('/');

  // Tab #1 lands on the skip link and reveals it (sr-only -> visible chip).
  const link = page.locator('a[href="#main-content"]');
  await pressUntilFocused(page, 'a[href="#main-content"]');
  await expect(link).toBeVisible();
  await expect(link).toHaveText('Skip to content');
  // It is itself a control, so the same global ring applies to it.
  expect(await ringOfFocused(page)).toEqual(RING);

  // Enter hands document focus to <main id="main-content">, which must NOT
  // wear a ring of its own (it is the jump target, not a control).
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id))
    .toBe('main-content');
  const mainOutline = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById('main-content') as Element);
    return s.outlineStyle;
  });
  expect(['none', 'auto']).toContain(mainOutline);

});

test('skip link label follows the locale (ID)', async ({ page }) => {
  await page.context().addCookies([{ name: 'locale', value: 'id', url: WEB }]);
  await page.goto('/');
  await pressUntilFocused(page, 'a[href="#main-content"]');
  await expect(page.locator('a[href="#main-content"]')).toHaveText('Lewati ke konten');
});

test('owner dashboard controls get the visible keyboard ring', async ({ page }) => {
  await signInUi(page, 'owner@foodorder.app', { goto: '/login?next=/dashboard' });
  await expect(page.getByRole('heading', { level: 1, name: 'Restaurant dashboard' })).toBeVisible();

  // Tab order runs header -> content; walk it once and ring-check three
  // distinct control kinds on this surface.
  await expectRing(page, 'header button'); // theme/locale switch buttons
  await expectRing(page, 'main label select'); // restaurant switcher
  await expectRing(page, 'main #status-tab-all'); // roving-tabindex ARIA tab
});

test('kitchen display controls get the visible keyboard ring', async ({ page }) => {
  await signInUi(page, 'owner@foodorder.app', { goto: '/login?next=/dashboard/kitchen' });
  await page.locator('[data-testid="kitchen-refresh"]').waitFor();
  await expectRing(page, 'main [data-testid="kitchen-refresh"]');
});

test('driver portal controls get the visible keyboard ring', async ({ page }) => {
  await signInUi(page, 'driver@foodorder.app', { goto: '/login?next=/driver' });
  await page.locator('[data-testid="driver-refresh"]').waitFor();
  await expectRing(page, 'main [data-testid="driver-refresh"]');
});

test('admin portal controls get the visible keyboard ring', async ({ page }) => {
  await signInUi(page, 'admin@foodorder.app', { goto: '/login?next=/admin' });
  await page.locator('main button').first().waitFor();
  await expectRing(page, 'main button');
});
