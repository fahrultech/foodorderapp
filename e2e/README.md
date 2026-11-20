# E2E smoke suite (Playwright)

Browser-level smoke of the customer path: **browse → cart → checkout → order
page**, plus checkout guardrails, signed-in account flows, owner/driver realtime,
analytics and kitchen paths, and the ADMIN-only platform overview.

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

## Fixture contracts & the timing gate (session 106)

- Every sign-in flows through `helpers/fixtures.ts::signInUi` — it returns
  ONLY once the post-login redirect has committed (a mid-login `page.goto`
  aborts the in-flight `POST /auth/login` and the next page renders guest;
  `tests/zz-login-abort.spec.ts` pins both directions). Specs that OWN the
  login surface (login-redirect-race, zz-login-abort, storefront-i18n-*)
  keep their own sequences on purpose.
- Direct-API fixture legs (`loginToken`, `payOrder`, `createOrder`,
  `warungFixture`) stamp `fixture-timing` annotations into the JSON report
  (`playwright-report/results.json`). `node check-fixture-timings.mjs` —
  wired into the CI e2e job — fails the run when a leg crosses the ceiling
  (default 15 s; documented 429 backoffs count separately against a 90 s
  ceiling via the `.limiter-wait` suffix; a ZERO-leg report also fails, so
  the gate cannot rot silently — `FIXTURE_TIMING_ALLOW_ZERO=1` for local
  subset loops).
- Session 110 trend visibility: the same gate aggregates per label and
  merges a run-over-run JSONL history (`FIXTURE_TIMING_HISTORY`, default
  `fixture-timing-history.jsonl`) that each CI e2e run publishes as the
  `fixture-timing-history` artifact. Chain transport (VERIFIED ROUND TRIP
  session 111): `list-prior-history.mjs` anonymously picks the newest
  prior artifact, the official download-artifact step fetches it (needs
  its `token:` input SET — without it v4.3.0 searches the CURRENT run and
  always "fails"; fixed in ci.yml), and `fetch-fixture-timing-history.mjs`
  merges the directory, falling back to custom REST when the dir is empty.
  The REST fallback is the PROVEN workhorse: live artifact sizes
  467→553→633→721→761→827→887 B across runs 125→132 equal one ~700 B
  real record line per run (sentinel lines would add only ~12 B), so
  every run from 126 on merged the real chain — zero sentinels published.
  A download failure self-attests as a fixed-120-byte sentinel record,
  so the PUBLIC artifact size alone tells you whether the chain is alive.
  A label whose
  max crosses 60% of its ceiling (`FIXTURE_TIMING_WARN_FRACTION`) gets a
  `::warning` annotation — a crawling leg is caught BEFORE it crosses;
  violations additionally stamp `::error`. The run's job summary gains a
  markdown table: slowest legs per label with this-run counts, prior-runs
  seen, historical max and the last 5 prior maxima.
  Selftests: `node --test check-fixture-timings.test.mjs` (CI runs them
  before the real gate; they must stay browser-free).

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
- `tests/admin.spec.ts` — seeded admin login exposes `/admin`, where the three
  platform totals and recent users/restaurants/orders render from the guarded
  overview API; the owner account gets neither the admin nav entry nor page
  access.
- `tests/owner-analytics.spec.ts` — owner login opens
  `/dashboard/analytics`, selects the seeded Warung restaurant, renders the
  completed-order gross revenue/count and busiest UTC hour, and exposes all 24
  hourly demand rows in an accessible table. The same owner session then opens
  the menu edit dialog, requests a presigned upload with the exact MIME
  type/byte size, PUTs the file bytes and required header directly to intercepted
  object storage, and saves the returned public URL through the existing
  menu-item PATCH. That same owner session then opens the 1024×768 prep board:
  a guest order is created, paid and accepted through the real API, arrives
  over the restaurant WebSocket room, shows item quantities and its kitchen
  note, then moves Queued → Preparing → Out for delivery → completed through
  the large board actions. Lane totals move with the card and completion
  removes it; a second order arriving while the first action response is held
  proves that busy-period push wake-ups are flushed after the action.
- `tests/live-feed.spec.ts` — the realtime ladder (Socket.IO → SSE → poll):
  tracking page follows an owner status change over the feed, and the
  dashboard falls back to SSE when the WebSocket is sabotaged. The customer
  pays the order over the API ladder (intent → capture) before the owner
  accepts — the order-machine gate is ON by default, so an unpaid confirm
  would 402.

- `tests/pay-order.spec.ts` — the web pay button: a signed-in customer
  pays at the receipt (intent → capture, mock settles synchronously), the
  paid badge survives a reload (server truth from
  `GET /orders/:orderId/payments`), and a guest receipt shows the sign-in
  hint with no dead pay button. Rate note: the `payments` bucket is
  10/min/IP — keep ≥60 s between full-suite runs or the second run can
  spuriously 429 (observed session 43).
- `tests/map.spec.ts` — the Leaflet storefront `/map`: marker count equals the
  restaurants whose API rows carry a valid latitude/longitude pair (5 of the 6
  seeded pins; off-map Bowl House appears only in the counted note), the pinned
  list mirrors the pins, and Warung's marker opens a popup whose menu link
  reaches its detail page.
- `tests/push-notifications.spec.ts` — browser push opt-in/out with mocked
  PushManager + permission APIs and intercepted notification endpoints:
  permission is untouched before the explicit bell click, subscribe sends the
  endpoint/keys contract, opt-out unsubscribes locally, and sign-out detaches
  an active shared-browser endpoint before the auth session is cleared.
- `tests/pwa.spec.ts` — install metadata exposes standalone mode plus 192/512
  icons; after the worker controls a visited cart, Chromium is taken fully
  offline and the persisted cart still renders, announces offline mode, and
  accepts quantity edits without a network request.
- `tests/seo.spec.ts` — `robots.txt` advertises the sitemap and excludes private
  workflow routes; `sitemap.xml` contains the homepage plus every restaurant
  returned by the API; a live restaurant page emits its server-derived title,
  description, canonical URL, Open Graph URL/title, and image card.
- `tests/storefront-i18n.spec.ts` — English defaults, switching to Indonesian
  updates `<html lang>` plus home/header copy, the cookie survives reload and
  navigation to a restaurant/menu, and switching back restores English.
- `tests/dark-mode.spec.ts` — light defaults, the accessible header toggle
  switches the server-rendered root and visible storefront palette, the theme
  survives navigation/reload through its cookie, and switching back restores
  the light palette.
- `tests/zz-driver-portal.spec.ts` — the seeded DRIVER opens `/driver`, sees the
  exact-role header entry and assigned FO-SEED3 pickup, reaches the driver WS
  room, receives an externally-issued preparing→delivering update without a
  reload, then completes the delivery through the portal action.

Tests share the single dev database and one rate-limit identity per IP, so the
suite runs serially (`workers: 1`). Guest smoke runs add real `pending` orders
to the dev DB — that is expected scratch state for a seeded disposable database.
The Playwright-owned API process raises only the auth bucket to 100/min because
the suite intentionally signs in as many roles in one minute; rate-limit behavior
remains covered by the API integration specs and production defaults are unchanged.

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
