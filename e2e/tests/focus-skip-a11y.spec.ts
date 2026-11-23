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
 * sign-ins and navigation only, no ORDER submits, seed-safe.
 *
 * Session 120 (Phase 12 UX) extended this file with the two halves the
 * audit named: (1) the DARK-theme swap — the `theme` cookie renders
 * html[data-theme='dark'] server-side and the same ring walk must then
 * read brand-500 rgb(249,115,22); (2) the mobile-only compact bottom bars
 * (use-compact-viewport furniture on /cart and /checkout) get a real
 * tab-order walk at 360x800: bar controls are the LAST stops before the
 * cycle wraps, adjacent in DOM order, and wear the ring; the bar surface
 * itself inverts under the dark theme (globals.css maps bg-white/90).
 *
 * Accounts: owner@foodorder.app / driver@foodorder.app (pw demo1234),
 * admin@foodorder.app.
 */

const RING_LIGHT = {
  style: 'solid',
  width: 2,
  color: 'rgb(234, 88, 12)', // brand-600 (light theme = suite default)
  offset: 2,
} as const;

const RING_DARK = {
  style: 'solid',
  width: 2,
  color: 'rgb(249, 115, 22)', // brand-500 on the dark canvas
  offset: 2,
} as const;

const RING = RING_LIGHT; // kept for the session-117 test bodies below

/** The server layout reads the `theme` cookie — set it context-side so
 *  even the first navigation SSRs html[data-theme]. */
async function setTheme(page: Page, value: 'light' | 'dark'): Promise<void> {
  await page.context().addCookies([{ name: 'theme', value, url: WEB }]);
}

/** Walk EXACTLY ONE full Tab cycle: land on the skip link first (it has a
 *  data-testid AND is `a[href="#main-content"]`, so it is named before any
 *  testid branch can mask it), keep pressing until focus cycles back to
 *  it, return the stops in order. Headless Chrome inserts a phantom `body`
 *  stop at the document edge (last focusable -> body -> skip link), so
 *  callers filter 'body' to read the real DOM tail. */
async function tabStopsCycle(page: Page, cap = 120): Promise<string[]> {
  await pressUntilFocused(page, 'a[href="#main-content"]');
  const stops: string[] = ['skip-link'];
  for (let i = 0; i < cap; i += 1) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return 'body';
      if (el.matches('a[href="#main-content"]')) return 'skip-link';
      const testid = el.getAttribute('data-testid');
      if (testid) return `testid:${testid}`;
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      return `${tag}${id}`;
    });
    if (name === 'skip-link') return stops;
    stops.push(name);
  }
  throw new Error(
    `Tab walk never wrapped back to the skip link within ${cap} presses; saw: ${stops
      .map((s, i) => `${i}:${s}`)
      .join(' ')}`,
  );
}

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

async function expectRing(
  page: Page,
  selector: string,
  ring: { style: string; width: number; color: string; offset: number } = RING,
): Promise<void> {
  await pressUntilFocused(page, selector);
  expect(await ringOfFocused(page)).toEqual(ring);
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

test('dark theme cookie swaps the ring to brand-500 on the storefront', async ({ page }) => {
  await setTheme(page, 'dark');
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // The first stop wears the swapped ring too, and so does the header.
  await pressUntilFocused(page, 'a[href="#main-content"]');
  expect(await ringOfFocused(page)).toEqual(RING_DARK);
  await expectRing(page, 'header button', RING_DARK);
});

test('dark theme ring holds on owner dashboard controls', async ({ page }) => {
  await setTheme(page, 'dark');
  await signInUi(page, 'owner@foodorder.app', { goto: '/login?next=/dashboard' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectRing(page, 'main label select', RING_DARK);
  await expectRing(page, 'main #status-tab-all', RING_DARK);
});

test('mobile cart bar closes the tab order, rings both controls, inverts under dark', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  await page.getByRole('link', { name: /Warung Nusantara/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Warung Nusantara' })).toBeVisible();

  const dishRow = (name: string) =>
    page
      .locator('div.divide-y > div', { has: page.getByRole('heading', { level: 3, name }) })
      .first();
  // Same six-line recipe as mobile-cart-checkout: guarantees the document
  // scrolls, which is what makes "pinned" mean anything for the sticky bar.
  await dishRow('Es Teh Manis').getByRole('button', { name: /^Add( |$)/ }).click();
  const teh = dishRow('Es Teh Manis');
  await teh.getByRole('button', { name: /Large/ }).click();
  await teh.getByRole('button', { name: /^Add( |$)/ }).click();
  const teh2 = dishRow('Es Teh Manis');
  await teh2.getByRole('button', { name: /Jumbo/ }).click();
  await teh2.getByRole('button', { name: /^Add( |$)/ }).click();
  await dishRow('Nasi Goreng Spesial').getByRole('button', { name: /^Add( |$)/ }).click();
  const nasi = dishRow('Nasi Goreng Spesial');
  await nasi.getByRole('button', { name: /Extra egg/ }).click();
  await nasi.getByRole('button', { name: /^Add( |$)/ }).click();
  const nasi2 = dishRow('Nasi Goreng Spesial');
  await nasi2.getByRole('button', { name: /Extra egg/ }).click();
  await nasi2.getByRole('button', { name: /satay/ }).click();
  await nasi2.getByRole('button', { name: /^Add( |$)/ }).click();

  await page.getByRole('link', { name: /Cart/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible();
  await expect(page.getByTestId('mobile-cart-bar')).toBeVisible();

  // Full-document cycle: starts at the skip link, ends where the DOM ends
  // (the footer ships no focusables; the desktop action row is
  // display:none at 360px so it contributes zero stops). Headless Chrome
  // inserts a phantom 'body' at the document edge — filtered out.
  const stops = (await tabStopsCycle(page)).filter((s) => s !== 'body');
  expect(stops[0], `cycle starts at the skip link: ${stops.join(' > ')}`).toBe('skip-link');
  expect(stops.slice(-2), `the bar must close the tab order: ${stops.join(' > ')}`).toEqual([
    'testid:mobile-cart-clear',
    'testid:mobile-checkout-cta',
  ]);

  // Both wear the light ring; one more Tab from clear lands exactly on the CTA.
  await expectRing(page, 'main [data-testid="mobile-cart-clear"]', RING_LIGHT);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
    'mobile-checkout-cta',
  );
  expect(await ringOfFocused(page)).toEqual(RING_LIGHT);

  // Focusing into the bar never un-sticks it: scrolled back to top, its
  // bottom edge still rides the viewport bottom.
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await page.getByTestId('mobile-cart-bar').boundingBox();
  expect(box, 'sticky bar must have a bounding box').not.toBeNull();
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(796);
  expect(box!.y + box!.height).toBeLessThanOrEqual(801);

  // Dark half of the audit: the bar SURFACE inverts (globals.css maps
  // bg-white/90 to rgb(41,37,36)) and the ring follows --focus-ring.
  // Cart lines survive the reload in this context's localStorage.
  await setTheme(page, 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bar = page.getByTestId('mobile-cart-bar');
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(41, 37, 36)');
  await expectRing(page, 'main [data-testid="mobile-checkout-cta"]', RING_DARK);
});

test('mobile checkout: the sticky submit is the final tab stop, ringed, no submit pressed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/');
  await page.getByRole('link', { name: /Warung Nusantara/ }).first().click();
  const dishRow = (name: string) =>
    page
      .locator('div.divide-y > div', { has: page.getByRole('heading', { level: 3, name }) })
      .first();
  await dishRow('Nasi Goreng Spesial').getByRole('button', { name: /^Add( |$)/ }).click(); // $18
  const teh = dishRow('Es Teh Manis');
  await teh.getByRole('button', { name: /Large/ }).click();
  await teh.getByRole('button', { name: /^Add( |$)/ }).click(); // +$7 ≥ $10 min

  await page.getByRole('link', { name: /Cart/ }).click();
  await page.getByTestId('mobile-checkout-cta').click();
  await expect(page.getByTestId('mobile-submit-bar')).toBeVisible();
  // Pricing settled → the bar CTA is ENABLED (canSubmit mirrors the in-form
  // button; a disabled button would silently drop out of the tab order).
  await expect(page.getByTestId('checkout-total')).not.toHaveText('—');
  await expect(page.getByTestId('mobile-submit-cta')).toBeEnabled();

  const stops = (await tabStopsCycle(page)).filter((s) => s !== 'body');
  const idx = stops.indexOf('testid:mobile-submit-cta');
  expect(idx, `sticky submit present in the tab order: ${stops.join(' > ')}`).toBe(
    stops.length - 1,
  );
  // DOM truth: the in-form handle (checkout-submit) and the sticky handle
  // are the form's last two handles, separated only by the promo input of
  // the summary aside. The EMPTY promo keeps Apply disabled, and a
  // disabled button contributes NO stop. One flow, two handles, honest
  // order — keyboard users reach the sticky CTA last, exactly where it
  // sits visually.
  expect(stops.slice(-3), `tab order tail: ${stops.join(' > ')}`).toEqual([
    'testid:checkout-submit',
    'testid:checkout-promo-input',
    'testid:mobile-submit-cta',
  ]);

  await expectRing(page, 'main [data-testid="mobile-submit-cta"]', RING_LIGHT);
});
