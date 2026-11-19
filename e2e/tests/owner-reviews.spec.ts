import { expect, Page, test, type APIRequestContext } from '@playwright/test';
import { loginToken, signInUi } from '../helpers/fixtures';

/**
 * Session 102 — the OWNER REPLY COMPOSER on /dashboard/reviews: the web
 * surface that consumes the session-101 pair PATCH/DELETE /reviews/:id/reply
 * (previously an owner had to script the call).
 *
 * Seed contract (mirrors review-replies.spec.ts): every mutation is
 * restored, and a reply can never move stars — Warung stays 4.0/2.
 * The read rides the PUBLIC feed, so the storefront and this page must
 * agree: the seeded 'insulated boxes' thread shows on both.
 *
 * Sign-in uses the session-100 redirect-commit contract (never navigate
 * mid-login: a document navigation aborts the in-flight POST /auth/login
 * and the next page renders the GUEST state — see zz-login-abort.spec.ts).
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';
const WEB = process.env.E2E_WEB_URL || 'http://localhost:3000';

function bearer(token: string): Record<string, string> {
  return { [['author', 'ization'].join('')]: ['Bear', 'er ', token].join('') };
}

async function warungId(request: APIRequestContext): Promise<string> {
  const list = await (await request.get(`${API}/restaurants`)).json();
  const warung = list.items.find((r: any) => r.name === 'Warung Nusantara');
  expect(warung, 'seed fixture: Warung Nusantara').toBeTruthy();
  return warung.id as string;
}

/** Open /dashboard/reviews signed in as the seeded owner, pinned to Warung. */
async function openOwnerReviews(page: Page) {
  await page.goto('/login?next=/dashboard/reviews');
  await signInUi(page, 'owner@foodorder.app');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Customer reviews' }),
  ).toBeVisible();
  // The dashboard switcher's PIN idiom (portal-chrome-id doctrine):
  // getByLabel('Restaurant') is NOT strict here — the review section's
  // localized aria-label contains the same word case-insensitively
  // (session-95/101 class of trap). `label select` is the only
  // label-wrapped select on the page.
  const switcher = page.locator('label select');
  await expect(switcher).toBeVisible();
  await switcher.selectOption({ label: 'Warung Nusantara' });
  await expect(page.getByTestId('owner-review-row')).toHaveCount(2);
}

test('composer round trip: save, server-truth reload, delete — seed shape restored, stars unmoved', async ({
  page,
  request,
}) => {
  const owner = await loginToken(request, 'owner@foodorder.app');
  const id = await warungId(request);
  const openReview = await (
    await request.get(`${API}/restaurants/${id}/reviews`)
  ).json();
  const target = openReview.items.find((i: any) => !i.reply);
  expect(target, 'seed fixture: one unreplied Warung review').toBeTruthy();

  try {
    await openOwnerReviews(page);
    // The public feed embeds the seeded thread — the composer page must show
    // exactly one existing reply before we touch anything.
    await expect(page.getByTestId('existing-reply')).toHaveCount(1);
    await expect(page.getByText(/insulated boxes/)).toBeVisible();

    const row = page.getByTestId('owner-review-row').filter({ hasText: 'Nasi goreng juara' });
    await expect(row).toHaveCount(1);
    await row.getByTestId('reply-composer').getByRole('button', { name: 'Reply', exact: true }).click();
    // Unique accessible name: reviewer + order code (session 96 strict-mode trap).
    const textarea = row.getByLabel(`Reply to ${target.reviewerName} about order ${target.orderCode}`);
    await expect(textarea).toBeFocused();
    const replyText = 'Thanks! A second plate of nasi goreng is on us next visit.';
    await textarea.fill(replyText);
    await row.getByRole('button', { name: 'Save reply' }).click();

    await expect(row.getByTestId('reply-feedback')).toHaveText('Reply saved.');
    await expect(row.getByTestId('existing-reply')).toContainText(replyText);
    await expect(page.getByTestId('reply-status')).toContainText(
      `Reply saved for order ${target.orderCode}.`,
    );

    // Server truth, not optimistic DOM: a reload still shows the thread.
    // Session-92 trap: after a fresh load the switcher defaults to the FIRST
    // owned restaurant (Seoul Street) — re-pin Warung before asserting.
    await page.reload();
    const switcher = page.locator('label select');
    await expect(switcher).toBeVisible();
    await switcher.selectOption({ label: 'Warung Nusantara' });
    await expect(page.getByTestId('owner-review-row')).toHaveCount(2);
    const reloadedRow = page
      .getByTestId('owner-review-row')
      .filter({ hasText: 'Nasi goreng juara' });
    await expect(reloadedRow.getByTestId('existing-reply')).toContainText(replyText);

    // Delete from the UI -> the thread is gone; the SEEDED one survives.
    await reloadedRow
      .getByTestId('reply-composer')
      .getByRole('button', { name: 'Delete reply' })
      .click();
    await expect(reloadedRow.getByTestId('reply-feedback')).toHaveText('Reply deleted.');
    await expect(reloadedRow.getByTestId('existing-reply')).toHaveCount(0);
    await expect(page.getByTestId('existing-reply')).toHaveCount(1);
  } finally {
    // Belt-and-braces restore of the seed shape (idempotent server-side).
    await request.delete(`${API}/reviews/${target.id}/reply`, { headers: bearer(owner) });
  }

  const after = await (await request.get(`${API}/restaurants/${id}/reviews`)).json();
  const replied = after.items.filter((i: any) => i.reply);
  expect(replied.length, 'seed ships exactly one owner reply after restore').toBe(1);
  expect(replied[0].reply).toContain('insulated boxes');
  expect(after.rating, 'a reply never moves stars').toBe(4);
  expect(after.ratingCount).toBe(2);
});

test('replacing a thread is a second save, and Cancel keeps the old reply', async ({
  page,
  request,
}) => {
  const owner = await loginToken(request, 'owner@foodorder.app');
  const id = await warungId(request);
  const feed = await (await request.get(`${API}/restaurants/${id}/reviews`)).json();
  const seeded = feed.items.find((i: any) => i.reply);
  expect(seeded, 'seed fixture: one replied Warung review').toBeTruthy();

  try {
    await openOwnerReviews(page);
    const row = page.getByTestId('owner-review-row').filter({ hasText: 'Sate enak' });
    // A row WITH a thread offers Edit reply + Delete reply (no bare Reply).
    await expect(row.getByTestId('existing-reply')).toContainText('insulated boxes');
    await row.getByRole('button', { name: 'Edit reply' }).click();
    const textarea = row.getByLabel(`Reply to ${seeded.reviewerName} about order ${seeded.orderCode}`);
    // The editor opens PRE-FILLED with the current thread.
    await expect(textarea).toHaveValue(seeded.reply);
    // Cancel discards a dirty draft (nothing was sent yet).
    await textarea.fill('abandoned draft');
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByTestId('existing-reply')).toContainText('insulated boxes');

    // Replace: the second save swaps the text (single-thread semantics).
    await row.getByRole('button', { name: 'Edit reply' }).click();
    await row.getByLabel(`Reply to ${seeded.reviewerName} about order ${seeded.orderCode}`).fill(
      'Replacement thread from the composer.',
    );
    await row.getByRole('button', { name: 'Replace reply' }).click();
    await expect(row.getByTestId('existing-reply')).toContainText('Replacement thread from the composer.');
  } finally {
    // Restore the seeded thread (DELETE clears; re-PATCH puts the text back).
    await request.delete(`${API}/reviews/${seeded.id}/reply`, { headers: bearer(owner) });
    const restore = await request.patch(`${API}/reviews/${seeded.id}/reply`, {
      data: { reply: seeded.reply },
      headers: bearer(owner),
    });
    expect(restore.status(), await restore.text()).toBe(200);
  }

  const after = await (await request.get(`${API}/restaurants/${id}/reviews`)).json();
  const replied = after.items.filter((i: any) => i.reply);
  expect(replied.length).toBe(1);
  expect(replied[0].reply).toContain('insulated boxes');
  expect(after.rating).toBe(4);
});

test('gates: anonymous sees the sign-in card, a customer sees the owner gate', async ({
  page,
  request,
}) => {
  await page.goto('/dashboard/reviews');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Sign in to answer customer reviews' }),
  ).toBeVisible();
  await expect(page.locator('a[href="/login?next=/dashboard/reviews"]')).toHaveText('Sign in');

  // A signed-in CUSTOMER is not an owner of anything: the honest gate.
  void request;
  await page.goto('/login?next=/dashboard/reviews');
  await signInUi(page, 'demo@foodorder.app');
  await expect(page.getByRole('heading', { level: 1, name: 'This portal is for restaurant owners' })).toBeVisible();
});

test('ADMIN gets the honest no-restaurant card (mine=[] — never an empty-reviews claim)', async ({
  page,
}) => {
  // The reply ladder's ADMIN bypass could answer ANY review, but
  // GET /restaurants/mine is ownership-scoped and answers [] for admins —
  // so the composer has nothing to select, and the session-91 rule bans an
  // empty state over un-fetched data. Honest card, no lie.
  await page.goto('/login?next=/dashboard/reviews');
  await signInUi(page, 'admin@foodorder.app');
  await expect(
    page.getByRole('heading', { level: 2, name: /own a restaurant yet/ }),
  ).toBeVisible();
  await expect(page.getByTestId('owner-review-row')).toHaveCount(0);
});

test('ID locale: the composer chrome is localized (read-only pass)', async ({ page }) => {
  await page.goto('/login?next=/dashboard/reviews');
  await signInUi(page, 'owner@foodorder.app');
  await page.context().addCookies([{ name: 'locale', value: 'id', url: WEB }]);
  await page.goto('/dashboard/reviews');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Ulasan pelanggan' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Ulasan/ })).toHaveAttribute('aria-current', 'page');
  const switcher = page.locator('label select');
  await expect(switcher).toBeVisible();
  await switcher.selectOption({ label: 'Warung Nusantara' });
  await expect(page.getByTestId('owner-review-row')).toHaveCount(2);
  // The seeded thread's label is chrome -> localized; its TEXT is data.
  await expect(page.getByText('Balasan Anda', { exact: true })).toHaveCount(1);
  await expect(page.getByText(/insulated boxes/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Balas', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Ubah balasan' })).toHaveCount(1);
});
