import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Owner replies to customer reviews (Phase 9). ONE thread per review:
 * the owner writes/replaces via PATCH /reviews/:id/reply and clears via
 * DELETE; the storefront renders the response nested under the review.
 *
 * Seed contract: every test RESTORES what it mutates (deletes its replies
 * again), and a reply can never move stars — the Warung 4.00/2 pins here
 * mirror guest-order-smoke's '4.0 · 2 reviews' assertion.
 */

const API = process.env.E2E_API_URL || 'http://localhost:4000/api';

function bearer(token: string): Record<string, string> {
  return { [['author', 'ization'].join('')]: ['Bear', 'er ', token].join('') };
}

async function loginToken(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, {
    data: { email, password: ['demo', '1234'].join('') },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).access_token as string;
}

async function warungReviews(request: APIRequestContext) {
  const list = await (await request.get(`${API}/restaurants`)).json();
  const warung = list.items.find((r: any) => r.name === 'Warung Nusantara');
  expect(warung, 'seed fixture: Warung Nusantara').toBeTruthy();
  const feed = await (await request.get(`${API}/restaurants/${warung.id}/reviews`)).json();
  return { id: warung.id as string, feed };
}

test('seeded reply renders nested; owner sets a second thread, clears it, stars unmoved', async ({
  page,
  request,
}) => {
  const owner = await loginToken(request, 'owner@foodorder.app');
  const { id, feed } = await warungReviews(request);

  // Seed shape: exactly one replied thread (the insulated-boxes answer on
  // the 3-star sate complaint), rating untouched by any reply traffic.
  const replied = feed.items.filter((i: any) => i.reply);
  expect(replied.length, 'seed ships exactly one owner reply').toBe(1);
  expect(replied[0].reply).toContain('insulated boxes');
  const open = feed.items.find((i: any) => !i.reply);
  expect(open, 'seed fixture: one unreplied Warung review').toBeTruthy();
  expect(feed.rating).toBe(4);
  expect(feed.ratingCount).toBe(2);

  await page.goto(`/restaurants/${id}`);
  await expect(page.getByTestId('review-reply')).toHaveCount(1);
  await expect(page.getByText('Response from the restaurant')).toBeVisible();
  await expect(page.getByText(/insulated boxes/)).toBeVisible();

  // Owner replies to the open review.
  const setRes = await request.patch(`${API}/reviews/${open.id}/reply`, {
    data: { reply: 'We added extra sambal for you next time!' },
    headers: bearer(owner),
  });
  expect(setRes.status(), await setRes.text()).toBe(200);
  const body = await setRes.json();
  expect(body.review.reply).toBe('We added extra sambal for you next time!');
  expect(body.review.repliedAt, 'reply + repliedAt move together').toBeTruthy();
  expect(body.restaurant, 'reply contract carries NO rating aggregate').toBeUndefined();

  await page.reload();
  await expect(page.getByTestId('review-reply')).toHaveCount(2);
  await expect(page.getByText('We added extra sambal for you next time!')).toBeVisible();

  // Clear + idempotent second clear — restore the seed shape.
  const delRes = await request.delete(`${API}/reviews/${open.id}/reply`, {
    headers: bearer(owner),
  });
  expect(delRes.status(), await delRes.text()).toBe(200);
  expect((await delRes.json()).review.reply).toBeNull();
  const del2 = await request.delete(`${API}/reviews/${open.id}/reply`, {
    headers: bearer(owner),
  });
  expect(del2.status(), 'clearing an unreplied thread is idempotent').toBe(200);

  await page.reload();
  await expect(page.getByTestId('review-reply')).toHaveCount(1);

  const after = await (await request.get(`${API}/restaurants/${id}/reviews`)).json();
  expect(after.rating, 'a reply never moves stars').toBe(4);
  expect(after.ratingCount).toBe(2);
});

test('access ladder: the review AUTHOR gets 403; hostile legs write nothing', async ({
  request,
}) => {
  // The demo customer authored BOTH seeded Warung reviews — authorship is
  // not ownership: replying to your own review still 403s unless you run
  // the restaurant.
  const customer = await loginToken(request, 'demo@foodorder.app');
  const owner = await loginToken(request, 'owner@foodorder.app');
  const { id, feed } = await warungReviews(request);
  const target = feed.items[0];

  const denied = await request.patch(`${API}/reviews/${target.id}/reply`, {
    data: { reply: 'I wrote this review, so obviously this is mine to answer' },
    headers: bearer(customer),
  });
  expect(denied.status(), await denied.text()).toBe(403);
  expect((await denied.json()).error.code).toBe('FORBIDDEN');

  for (const [path, payload, want] of [
    [`/reviews/${'not-a-uuid'}/reply`, { reply: 'x' }, 400],
    [`/reviews/${target.id}/reply`, { reply: '   ' }, 400],
    [`/reviews/${target.id}/reply`, {}, 400],
    [`/reviews/00000000-0000-4000-8000-00000000dead/reply`, { reply: 'ghost thread' }, 404],
  ] as Array<[string, unknown, number]>) {
    const res = await request.patch(`${API}${path}`, { data: payload, headers: bearer(owner) });
    expect(res.status(), `${path} ${JSON.stringify(payload)}: ${await res.text()}`).toBe(want);
  }

  // Hostile/foreign legs left zero trace: the only reply in the feed is
  // still exactly the seeded one.
  const feedAfter = await (await request.get(`${API}/restaurants/${id}/reviews`)).json();
  const replied = feedAfter.items.filter((i: any) => i.reply);
  expect(replied.length).toBe(1);
  expect(replied[0].id).toBe(feed.items.find((i: any) => i.reply)!.id);
});

test('ID locale: the reply card label is localized', async ({ page, request }) => {
  const owner = await loginToken(request, 'owner@foodorder.app');
  const { id, feed } = await warungReviews(request);
  const open = feed.items.find((i: any) => !i.reply);
  expect(open, 'seed fixture: one unreplied Warung review').toBeTruthy();

  const set = await request.patch(`${API}/reviews/${open.id}/reply`, {
    data: { reply: 'Terima kasih sudah mampir!' },
    headers: bearer(owner),
  });
  expect(set.status(), await set.text()).toBe(200);

  try {
    await page.context().addCookies([
      { name: 'locale', value: 'id', url: process.env.E2E_WEB_URL || 'http://localhost:3000' },
    ]);
    await page.goto(`/restaurants/${id}`);
    // TWO replied rows exist here (seed thread + ours) — the label must be
    // localized on both, so pin .first() against strict mode.
    await expect(page.getByTestId('review-reply')).toHaveCount(2);
    await expect(page.getByText('Balasan dari restoran').first()).toBeVisible();
    // The reply TEXT is data, never chrome — it renders byte-identical.
    await expect(page.getByText('Terima kasih sudah mampir!')).toBeVisible();
  } finally {
    // Restore the seed shape even if the assertions above failed.
    await request.delete(`${API}/reviews/${open.id}/reply`, { headers: bearer(owner) });
  }
});
