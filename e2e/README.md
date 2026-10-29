# E2E smoke suite (Playwright)

Browser-level smoke of the customer path: **browse → cart → checkout → order
page**, plus the checkout guardrails and the signed-in order history.

## Prerequisites

1. Postgres running locally with the **seeded** dev database:
   `service postgresql start && cd apps/api && npm run seed`
2. `apps/api/.env` present (untracked, holds `DATABASE_URL`) — the API build
   reads it at runtime.
3. Both apps built: `cd apps/api && npm run build` and `cd apps/web && npm run build`.

The API (`:4000`) and web (`:3000`) may already be running — Playwright reuses
them; otherwise `playwright.config.ts` boots `node dist/main.js` and
`npm run start` itself (the web entry builds Next.js first on a cold tree).

## Run

```bash
cd e2e
npm ci               # or: npm install
npx playwright install chromium   # only on a fresh machine
npm test
```

Version note: `@playwright/test` is pinned to **1.63.0** because that release
bundles Chromium build 1243, which is the browser already cached on the dev
host. A `package.json` bump to a version wanting a different build forces a
browser download.

## What the suite asserts

- `tests/guest-order-smoke.spec.ts` — the whole happy path, including exact
  server-side money math from the seed (2×$18.00 + $5.00 − $5.00 WARUNGHEMAT
  + $3.00 fee = **$39.00**) and the confirmation page (FO- code, pending
  status, timeline, snapshots, cleared cart).
- `tests/checkout-guards.spec.ts` — below-minimum blocks submit (Seoul
  Street: $6.00 item vs $10.00 min, "Add $4.00 more") and empty cart/checkout
  states.
- `tests/account.spec.ts` — demo login, authenticated header nav, seeded
  `FO-SEED*` orders on `/orders/my`.
- `tests/live-feed.spec.ts` — the realtime ladder (Socket.IO → SSE → poll):
  tracking page follows an owner status change over the feed, and the
  dashboard falls back to SSE when the WebSocket is sabotaged.
- `tests/pay-order.spec.ts` — the web pay button: a signed-in customer
  pays at the receipt (intent → capture, mock settles synchronously), the
  paid badge survives a reload (server truth from
  `GET /orders/:orderId/payments`), and a guest receipt shows the sign-in
  hint with no dead pay button. Rate note: the `payments` bucket is
  10/min/IP — keep ≥60 s between full-suite runs or the second run can
  spuriously 429 (observed session 43).

Tests share the single dev database and one rate-limit identity per IP, so the
suite runs serially (`workers: 1`). Guest smoke runs add real `pending` orders
to the dev DB — that is expected scratch state for a seeded disposable database.

## In CI

`.github/workflows/ci.yml` runs this suite on every push/PR in the `e2e` job:
an empty Postgres 16 service container, API + web installed and built, then
`npm run seed` (which applies the whole migration chain first), then Playwright
with `npx playwright install --with-deps chromium` — the runner downloads the
Chromium build pinned by `@playwright/test@1.63.0` (this host's cached build
1243 is the same pair). On failure the HTML report is uploaded as an artifact.
The lockfile's `resolved` URLs point at `registry.npmjs.org` (the dev host's
`~/.npmrc` mirror is unreachable from runners — keep them that way, see
DEVLOG 2026-10-24 session 26).
