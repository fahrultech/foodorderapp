import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Mobile polish pass (Phase 7, session 83): the cart + checkout flow at
 * 360×800 (small-phone width). Pins the three promises of the item:
 *   1. no horizontal scroll anywhere in the flow (shared header included),
 *   2. 44×44 tap targets on cart/checkout controls (WCAG 2.5.5),
 *   3. sticky bottom bars own the cart CTA and the order submit — and the
 *      bars are rendered by matchMedia, so they exist ONLY on compact
 *      viewports (the desktop specs' strict text locators rely on that).
 *
 * Seed fixtures used: Warung Nusantara (fee $3.00, min $10.00); Es Teh Manis
 * $5.00 with Size (Large +$2.00, Jumbo +$3.50); Nasi Goreng Spesial $18.00
 * with Add-ons (Extra egg +$2.00, Chicken satay +$5.00).
 */

test.use({ viewport: { width: 360, height: 800 } });

async function openWarungMenu(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: /Warung Nusantara/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Warung Nusantara' })).toBeVisible();
}

function dishRow(page: Page, name: string) {
  return page
    .locator('div.divide-y > div', { has: page.getByRole('heading', { level: 3, name }) })
    .first();
}

/** Select option chips (if any), then hit the dish's Add button. The label
 *  stays /^Add/ even when it carries the in-cart count. */
async function addToCart(page: Page, dish: string, choices: RegExp[] = []) {
  const row = dishRow(page, dish);
  for (const choice of choices) await row.getByRole('button', { name: choice }).click();
  await row.getByRole('button', { name: /^Add( |$)/ }).click();
}

async function expectNoHorizontalScroll(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      { message: 'document must not scroll horizontally at 360px' },
    )
    .toBeLessThanOrEqual(1);
}

/** Viewport-pinned: the bar's bottom edge sits at the viewport bottom. */
async function expectPinnedToBottom(bar: Locator) {
  const box = await bar.boundingBox();
  expect(box, 'sticky bar must have a bounding box').not.toBeNull();
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(796);
  expect(box!.y + box!.height).toBeLessThanOrEqual(801);
}

async function expectTapTarget(locator: Locator, min = 44) {
  const box = await locator.boundingBox();
  expect(box, 'control must have a bounding box').not.toBeNull();
  expect(box!.width, `tap target width ${box!.width} < ${min}`).toBeGreaterThanOrEqual(min);
  expect(box!.height, `tap target height ${box!.height} < ${min}`).toBeGreaterThanOrEqual(min);
}

test('empty cart and dead-checkout states fit 360px', async ({ page }) => {
  await page.goto('/cart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart is empty' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectTapTarget(page.getByRole('link', { name: 'Find food' }));
  // No sticky bar without lines.
  await expect(page.getByTestId('mobile-cart-bar')).toHaveCount(0);

  await page.goto('/checkout');
  await expect(page.getByRole('heading', { level: 1, name: 'Nothing to check out' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expect(page.getByTestId('mobile-submit-bar')).toHaveCount(0);
});

test('cart at 360px: stacked rows, 44px steppers, sticky checkout bar', async ({ page }) => {
  await openWarungMenu(page);
  // Six distinct cart lines (same dishes, different selections — the
  // line-per-selection rule from session 66).
  await addToCart(page, 'Es Teh Manis');
  await addToCart(page, 'Es Teh Manis', [/Large/]);
  await addToCart(page, 'Es Teh Manis', [/Jumbo/]);
  await addToCart(page, 'Nasi Goreng Spesial');
  await addToCart(page, 'Nasi Goreng Spesial', [/Extra egg/]);
  await addToCart(page, 'Nasi Goreng Spesial', [/Extra egg/, /satay/]);

  await page.getByRole('link', { name: /Cart/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible();
  await expect(page.locator('div.divide-y > div')).toHaveCount(6);

  await expectNoHorizontalScroll(page);

  // Steppers meet the 44px target after the h-8 → h-11 bump.
  await expectTapTarget(page.getByRole('button', { name: 'Increase quantity' }).first());
  await expectTapTarget(page.getByRole('button', { name: 'Decrease quantity' }).first());

  // The long cart scrolls, and the bar stays pinned at the viewport bottom
  // (position sticky, not just "somewhere below the fold").
  const bar = page.getByTestId('mobile-cart-bar');
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight))
    .toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectPinnedToBottom(bar);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(bar).toBeInViewport();

  await expect(page.getByTestId('mobile-cart-subtotal')).toHaveText(/\$\d+\.\d{2}/);

  // The sticky CTA is a real 44px target and carries the restaurant param.
  const cta = page.getByTestId('mobile-checkout-cta');
  await expectTapTarget(cta);
  await expect(cta).toHaveAttribute('href', /\/checkout\?restaurant=[0-9a-f-]{36}/);
  await cta.click();
  await expect(page).toHaveURL(/\/checkout\?restaurant=/);
});

test('checkout at 360px: no input zoom, sticky submit places the guest order', async ({ page }) => {
  await openWarungMenu(page);
  await addToCart(page, 'Nasi Goreng Spesial'); // $18 — above the $10 min
  await addToCart(page, 'Es Teh Manis', [/Large/]); // $7
  await page.getByRole('link', { name: /Cart/ }).click();
  await page.getByTestId('mobile-checkout-cta').click();

  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // 16px minimum on text inputs (iOS auto-zooms below that on focus).
  for (const id of ['checkout-name', 'checkout-phone', 'checkout-email', 'checkout-address', 'checkout-promo-code']) {
    const size = await page.locator(`#${id}`).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, `#${id} font-size ${size}px would trigger iOS focus zoom`).toBeGreaterThanOrEqual(16);
  }

  // Sticky submit bar with the live server total, pinned while the tall
  // stacked form scrolls underneath.
  const bar = page.getByTestId('mobile-submit-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/\$\d+\.\d{2}/);
  await expectPinnedToBottom(bar);

  const submit = page.getByTestId('mobile-submit-cta');
  await expect(submit).toHaveText('Place order');
  await expectTapTarget(submit);

  // The promo Apply button grew from 36px to a 44px target too (it is
  // disabled until text is typed — boundingBox still measures it).
  await expectTapTarget(page.getByRole('button', { name: 'Apply', exact: true }));

  // Autofill plumbing the mobile keyboard/credential managers expect.
  await expect(page.locator('#checkout-phone')).toHaveAttribute('autocomplete', 'tel');
  await expect(page.locator('#checkout-name')).toHaveAttribute('autocomplete', 'name');

  // Fill the form and submit via the STICKY button — `form="checkout-form"`
  // must route it into the real submit handler (one flow, two handles).
  await page.getByPlaceholder('Jane Doe').fill('Mobile E2E');
  await page.getByPlaceholder('+62 812 3456 7890').fill('+62 812 0000 9999');
  await page.getByPlaceholder('you@example.com').fill('mobile-e2e@example.com');
  await page.getByPlaceholder('Street, number, city, landmarks…').fill('99 Test Street, Jakarta');
  await submit.click();

  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}\?code=FO-/);
  // Cart emptied behind us (router.push history would go BACK to the now
  // empty checkout, so navigate explicitly to the cart).
  await page.goto('/cart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart is empty' })).toBeVisible();
});
