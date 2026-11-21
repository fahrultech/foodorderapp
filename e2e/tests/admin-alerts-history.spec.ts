import { expect, test } from '@playwright/test';
import { signInUi, WEB } from '../helpers/fixtures';

/**
 * Alert-history panel (Phase 11 web item, consuming the session-112
 * GET /admin/alerts/history) on /admin.
 *
 * Doctrine mirrors admin-traffic.spec.ts (session 85): the LIVE tests are
 * shape-based, cross-checking the DOM against the payload the page ITSELF
 * received via waitForResponse — persisted rows and streaks depend on API
 * uptime and suite order, so absolutes are unfair. The alerting/degraded
 * branches cannot be provoked on a healthy shared API at all, so they get
 * deterministic coverage via page.route interception of the history call
 * ONLY (session-91 recipe: portal pages are client-rendered, interception
 * works) — which doubles as the independent-degradation proof: with the
 * history response fabricated, the REAL metrics traffic cards must still
 * render (history must never blank or poison the traffic section).
 */

async function signInAsAdmin(page: import('@playwright/test').Page) {
  await signInUi(page, 'admin@foodorder.app', { goto: '/login' });
  await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
}

const HISTORY_URL = '**/api/admin/alerts/history**';

test('alerts history cards mirror the live /admin/alerts/history payload', async ({ page }) => {
  await signInAsAdmin(page);

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/admin/alerts/history') && res.status() === 200,
    ),
    page.goto('/admin'),
  ]);
  const payload = await response.json();

  // Contract pin: every field the panel reads must exist on the wire.
  expect(typeof payload.enabled).toBe('boolean');
  expect(typeof payload.returned).toBe('number');
  expect(typeof payload.truncated).toBe('boolean');
  expect(typeof payload.error).toBe('boolean');
  expect(Array.isArray(payload.items)).toBe(true);
  expect(typeof payload.window.windowSec).toBe('number');
  expect(payload.streak).toEqual(
    expect.objectContaining({
      alerting: expect.any(Number),
      currentStatus: expect.stringMatching(/^(ok|alerting)$/),
      persistedTrailingAlerting: expect.any(Number),
      trailingCapped: expect.any(Boolean),
    }),
  );

  await expect(
    page.getByRole('heading', { level: 2, name: 'Alert history' }),
  ).toBeVisible();

  // Streak card rides the payload's number exactly (≥ prefix is part of the
  // value when the persisted tail hit the row cap; the digits must appear).
  await expect(page.getByTestId('alerts-card-streak')).toContainText(
    String(payload.streak.alerting),
  );
  await expect(page.getByTestId('alerts-card-status')).toContainText(
    payload.streak.currentStatus === 'alerting' ? 'ALERTING' : 'OK',
  );

  if (payload.enabled && !payload.error && payload.items.length > 0) {
    // Rail = ONE cell per persisted row, statuses in oldest-first order.
    const cells = page.getByTestId('alerts-rail-cell');
    await expect(cells).toHaveCount(payload.items.length);
    const newest = payload.items[payload.items.length - 1];
    await expect(cells.nth(payload.items.length - 1)).toHaveAttribute(
      'data-status',
      newest.status,
    );
    // Newest-first table: every visible firing row's rule chips are raw
    // ops-contract ids on the wire and in the DOM.
    const visible = payload.items
      .filter((row: { status: string }) => row.status === 'alerting')
      .slice(-15)
      .reverse();
    for (const row of visible) {
      for (const ruleId of row.firingRules) {
        await expect(
          page.getByTestId('alerts-firing-table').getByText(ruleId, { exact: true }).first(),
        ).toBeVisible();
      }
    }
  } else if (payload.enabled && !payload.error) {
    // Cold series: the honest empty copy, never a fake rail.
    await expect(page.getByTestId('alerts-rail')).toHaveCount(0);
    await expect(page.getByTestId('alerts-firing-empty')).toBeVisible();
    await expect(page.getByTestId('alerts-firing-empty')).toContainText(
      payload.returned === 0 ? 'No verdicts recorded yet' : 'No alerting evaluations',
    );
  }
});

test('intercepted alerting series renders rail, streak bound and firing table', async ({ page }) => {
  await signInAsAdmin(page);
  // Deterministic alerting branch: fabricate the HISTORY response only —
  // overview + metrics still hit the real API (shared-booted scratch/dev DB).
  await page.route(HISTORY_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: '2026-11-21T06:00:00.000Z',
        enabled: true,
        snapshotIntervalSec: 300,
        retentionSec: 2592000,
        window: { windowSec: 86400, from: '2026-11-20T06:00:00.000Z', to: '2026-11-21T06:00:00.000Z' },
        returned: 3,
        truncated: true,
        lastCapturedAt: '2026-11-21T05:55:00.000Z',
        error: false,
        items: [
          {
            capturedAt: '2026-11-21T05:45:00.000Z',
            status: 'ok',
            firingRules: [],
            report: {
              generatedAt: '2026-11-21T05:45:00.000Z',
              uptimeSec: 7200,
              status: 'ok',
              firingRules: [],
              rules: [
                { id: 'error_budget', firing: false, severity: 'error', observed: 0, threshold: 0.5, detail: '5xx rate 0.00% within 0.5% budget' },
              ],
            },
          },
          {
            capturedAt: '2026-11-21T05:50:00.000Z',
            status: 'alerting',
            firingRules: ['p95_latency'],
            report: {
              generatedAt: '2026-11-21T05:50:00.000Z',
              uptimeSec: 7500,
              status: 'alerting',
              firingRules: ['p95_latency'],
              rules: [
                { id: 'p95_latency', firing: true, severity: 'error', observed: 1200, threshold: 1000, detail: 'p95 1200ms over 1000ms ceiling' },
              ],
            },
          },
          {
            capturedAt: '2026-11-21T05:55:00.000Z',
            status: 'alerting',
            firingRules: ['error_budget', 'snapshot_stale'],
            report: {
              generatedAt: '2026-11-21T05:55:00.000Z',
              uptimeSec: 7800,
              status: 'alerting',
              firingRules: ['error_budget', 'snapshot_stale'],
              rules: [
                { id: 'error_budget', firing: true, severity: 'error', observed: 1.5, threshold: 0.5, detail: '5xx rate 1.50% over 0.5% budget' },
                { id: 'snapshot_stale', firing: true, severity: 'error', observed: 900, threshold: 600, detail: 'no snapshot row for 900s' },
              ],
            },
          },
        ],
        streak: {
          persistedTrailingAlerting: 4,
          trailingCapped: true,
          currentStatus: 'alerting',
          alerting: 5,
        },
      }),
    }),
  );

  await page.goto('/admin');
  const panel = page.getByTestId('alerts-history-panel');
  await expect(panel).toBeVisible();

  // Streak: capped run renders as a lower bound with the ≥ prefix.
  await expect(page.getByTestId('alerts-card-streak')).toContainText('≥5');
  await expect(page.getByTestId('alerts-card-streak')).toContainText('lower bound');
  // Live verdict card.
  await expect(page.getByTestId('alerts-card-status')).toContainText('ALERTING');
  // Series card: 3 rows, 67% alerting (2/3 rounded).
  await expect(page.getByTestId('alerts-card-series')).toContainText('67%');
  // Truncation honesty note must appear because truncated=true.
  await expect(page.getByTestId('alerts-truncated-note')).toBeVisible();

  // Rail: ONE cell per persisted row oldest-first; tail two rows alerting.
  const cells = page.getByTestId('alerts-rail-cell');
  await expect(cells).toHaveCount(3);
  await expect(cells.nth(0)).toHaveAttribute('data-status', 'ok');
  await expect(cells.nth(2)).toHaveAttribute('data-status', 'alerting');

  // Firing table newest-first: top row carries BOTH rule chips and the
  // raw detail strings from the stored report (ops ids stay untranslated).
  const table = page.getByTestId('alerts-firing-table');
  await expect(table.getByText('error_budget', { exact: true }).first()).toBeVisible();
  await expect(table.getByText('snapshot_stale', { exact: true }).first()).toBeVisible();
  await expect(table.getByText('p95_latency', { exact: true }).first()).toBeVisible();
  const firstRow = table.getByRole('row').nth(1);
  await expect(firstRow).toContainText('error_budget');
  await expect(firstRow).toContainText('snapshot_stale');
  await expect(firstRow).toContainText('5xx rate 1.50% over 0.5% budget');
  // 3 alerting rows < the 15-row cap: no hidden-rows note.
  await expect(page.getByTestId('alerts-hidden-note')).toHaveCount(0);

  // Independent degradation: the history response was fabricated, but the
  // REAL metrics round-trip still rendered the traffic cards.
  await expect(page.getByTestId('traffic-card-budget')).toBeVisible();
});

test('intercepted series-read failure degrades to the live verdict honestly', async ({ page }) => {
  await signInAsAdmin(page);
  await page.route(HISTORY_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: '2026-11-21T06:00:00.000Z',
        enabled: true,
        snapshotIntervalSec: 300,
        retentionSec: 2592000,
        window: { windowSec: 86400, from: '2026-11-20T06:00:00.000Z', to: '2026-11-21T06:00:00.000Z' },
        returned: 0,
        truncated: false,
        lastCapturedAt: null,
        error: true,
        items: [],
        streak: {
          persistedTrailingAlerting: 0,
          trailingCapped: false,
          currentStatus: 'ok',
          alerting: 0,
        },
      }),
    }),
  );

  await page.goto('/admin');
  await expect(page.getByTestId('alerts-history-panel')).toBeVisible();
  // role=alert degrade banner — NOT the empty-series copy a blank list lies with.
  await expect(page.getByTestId('alerts-history-degraded')).toBeVisible();
  await expect(page.getByTestId('alerts-firing-empty')).toHaveCount(0);
  await expect(page.getByTestId('alerts-rail')).toHaveCount(0);
  // Live verdict still renders (the streak's live half survives the read).
  await expect(page.getByTestId('alerts-card-status')).toContainText('OK');
});

test('ID locale renders the localized alert-history chrome', async ({ page }) => {
  await signInAsAdmin(page);
  await page.context().addCookies([{ name: 'locale', value: 'id', url: 'http://localhost:3000' }]);
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/admin/alerts/history') && res.status() === 200,
    ),
    page.goto('/admin'),
  ]);
  const payload = await response.json();

  await expect(
    page.getByRole('heading', { level: 2, name: 'Riwayat peringatan' }),
  ).toBeVisible();
  await expect(page.getByTestId('alerts-card-streak')).toContainText(
    String(payload.streak.alerting),
  );
  // Status tokens stay raw contract words under ID too.
  await expect(page.getByTestId('alerts-card-status')).toContainText(
    payload.streak.currentStatus === 'alerting' ? 'ALERTING' : 'OK',
  );
});
