# ROADMAP — evergreen backlog

> Rules: work top-down, one item per session, mark done by checking `- [x]`.
> 🔒 = depends on earlier items. When every box is checked, expand a new phase
> from the Evergreen loops in docs/WORKFLOW.md. **The backlog never empties.**

## Phase 0 — Foundation (day 1) ✅ done in initial commits

## Phase 1 — Core ordering, hardened ✅ complete 2026-10-21
- [x] API: replace `synchronize: true` with TypeORM migrations (baseline migration from current schema)
- [x] API: owner role on restaurants (`ownerId`), restaurants CRUD for owners (create/update own restaurant)
- [x] API: menu item CRUD for owners (add/edit/available toggle) + validation tests
- [x] API: auth refresh tokens + `PATCH /users/me` profile update (jest coverage for all auth paths)
- [x] API: orders — filter by status, pagination on `/orders/my`, order cancellation by customer
- [x] API: error-format middleware (consistent `{ error: { code, message, details } }`) + tests
- [x] Web: login & register pages wired to auth API, token stored, header shows user
- [x] Web: order-history page (`/orders/my`) with status badges, pulls live
- [x] Web: checkout — show real delivery fee + min-order warning from restaurant before submit
- [x] Web: cart persistence across restaurant switches (confirm-modal UX)

## Phase 2 — Restaurant portal ✅ complete 2026-10-22
- [x] Portal: owner dashboard route (`/dashboard`) — orders inbox by status
- [x] Portal: owner can accept (pending→confirmed), start, deliver, complete, cancel
- [x] Portal: menu management UI (CRUD against owner endpoints)
- [x] Portal: live order updates via polling every 10s (NEW badges, pause/resume, visibility catch-up)
- [x] Portal: live order updates via SSE (server push replacing the 10s poll)
- [x] API: `/restaurants/:id/orders` scoped to owner with JWT role guard

## Phase 3 — Customer experience
- [x] Dish search within restaurant page + category anchors
- [x] Favorites (heart on dishes, `/users/me/favorites` API)
- [x] Order tracking timeline UI (status steps with timestamps on order entity)
- [x] Reviews: customers rate completed orders; restaurant rating recomputed server-side
- [x] Promo codes & discount engine (server-side validation, order integration)
- [x] Delivery addresses book (multiple saved addresses, pick at checkout)

## Phase 4 — Ops & quality ✅ complete 2026-10-28

- [x] GitHub Actions CI: build + test both apps per push
- [x] GitHub Actions CD workflow stub (build images, push to registry)
- [x] API: structured logging (pino) + request-id middleware
- [x] API: rate limiting on auth + order endpoints
- [x] Swagger/OpenAPI docs auto-generated at `/api/docs`
- [x] Swagger response schemas: typed `@ApiOkResponse`/`@ApiError` models for all 41 operations (2026-10-24, both sides done)
- [x] E2E smoke suite (Playwright: browse → cart → checkout → order page) (2026-10-26, `e2e/`, 4 tests, green x2 cold)
- [x] CI: run the e2e suite in GitHub Actions (registry-rewrite e2e lockfile first, then Playwright job with browser download + services) (2026-10-26, `e2e` job; local cold-path 4/4 green)
- [x] Auth: login bad credentials should answer 401 UNAUTHORIZED (today `AuthService.login` throws 409 CONFLICT and its jest tests pin it — change code+tests+docs in one go; web client is status-agnostic except reviews' 409) (2026-10-26, session 31)
- [x] DB indexes migration (slug, restaurantId, status, createdAt) + EXPLAIN check (2026-10-26, session 32; slug already covered by its UNIQUE index)
- [x] Backups: pg_dump scheduled script + restore doc (2026-10-26, session 33; `ops/backup-db.sh` + `ops/restore-db.sh` + `ops/systemd/` timer + `docs/BACKUP.md`, full restore drill green)
- [x] API: reject malformed uuid route params with 400 via `UuidParam` (ParseUUIDPipe) on all 22 uuid params; service-layer guards kept for direct calls (2026-10-27, session 34; 42-case HTTP spec + live smoke, menu 500→400)
- [x] API: repair the sanitizer-corrupted fallback `DATABASE_URL` defaults — `src/database/data-source.ts` + `src/app.module.ts` carry a committed literal `***` as the dev password (discovered 2026-10-28 session 40 via codepoint readback; display had always shown it masked, so it survived review). Dead code in practice (`.env`/compose/CI always provide the URL) but a loud trap when unset. Fix WITHOUT typing the secret into a tool call: a python step that reads the real value from the untracked `.env` at write time and rewrites the two fallbacks; verify by booting the API with DATABASE_URL temporarily unset. (2026-10-28, session 41; rewrote both fallbacks from `.env` via python, sha256-verified vs the real URL, fallback boot green with DATABASE_URL unset + no `.env` in cwd; regression guard spec `committed-credentials.spec.ts` fails CI on any masked credential literal in `src/`)

## Phase 5 — Scale-out ideas (seed list, expand freely)
- [x] Realtime order feed with WebSocket gateway (Socket.IO) (2026-10-27, session 36; `RealtimeGateway` on /orders namespace, JWT handshake auth, restaurant+user rooms off the shared SSE bus; 9-case socket integration spec + live smoke. Follow-up below: web-side consumer)
- [x] Web: dashboard/order-tracking consume the WS feed (SSE stays the fallback) (2026-10-27, session 37; `useOrderFeed` hook + transport ladder WS→SSE→poll, tracking page got its first live path; stale-debounce-closure bug found+fixed; 3 new e2e specs incl. WS-sabotage SSE-fallback test, suite 7/7 green x2)
- [ ] Payment abstraction (mock gateway → Stripe/Xendit adapters behind one interface)
  - [x] API core: `PaymentGateway` interface + `MockPaymentGateway` behind DI (PAYMENT_PROVIDER, boot fail-fast) + `payments` entity/migration + `POST /payments`, `POST /payments/:id/capture`, `GET /orders/:orderId/payments` + `payments` rate bucket + 46 new specs; live smokes incl. fail-mode and cancelled-order branches (2026-10-27, session 38)
  - [ ] 🔒 Stripe adapter implementing `PaymentGateway` (+ webhook verification endpoint, clientSecret-driven confirm) — needs API keys; keep mock as CI/dev default
  - [ ] 🔒 Xendit adapter (same interface + registry entry) — needs API keys
  - [x] Refund flow: `refunded` status + gateway `refundIntent` + ADMIN route + partial amounts — API: `PaymentRefundGateway` optional add-on + `supportsRefunds()` probe (mock implements it, independent `MOCK_REFUND_GATEWAY_MODE=fail` knob) + `refundedCents`/`refundedAt` + `refunded` status (migration w/ CHECK) + `POST /payments/:id/refund` ADMIN route w/ CAS on `refundedCents` (partial accumulates, full → terminal; capture refuses refunded rows; repay-after-refund opens a NEW attempt) + 36 new tests (524→560) + live smoke 28/28 incl. declined-refund branch (2026-10-28, session 39)
    - [x] Refund audit trail: per-refund rows (provider refund refs + amounts + acting admin) instead of a single accumulated `refundedCents` — `payment_refunds` append-only ledger (migration + CHECK + composite index; `refundedAfterCents` running balance; acting admin id FK SET NULL + JWT email snapshot) written in the SAME transaction as the CAS balance update + `GET /payments/:id/refunds` ADMIN route + mock refs made collision-free (`mock_re_<pid>_<remaining>_<cents>` — equal partials now get distinct provider ids) + 13 new specs (560→573) + live smoke 35/35 incl. equal-partial and DB constraint probes (2026-10-28, session 40)
  - [x] Order-machine gate: owner confirm requires a succeeded payment (API flag + spec/live-smoke 2026-10-28 session 42; enable-by-default decision shipped 2026-10-29 session 44 — see sub-items)
    - [x] API: `ORDER_CONFIRM_REQUIRES_PAYMENT` flag (default off, fail-open) gating EVERY path into `confirmed` (owner portal `setStatusForRestaurant` + ADMIN `updateStatus`) on a `succeeded` payments row → 402 `PAYMENT_REQUIRED`; existence probe on the `payments` repo (no cross-module service coupling, no status write from the payment side); 22 new specs (576→598) + live smoke 12/12 with flag ON (gated confirm, pay+capture→confirm, admin-backdoor gated, cancel/flow untouched) + flag-OFF regression 200 unpaid (2026-10-28, session 42)
    - [x] Enable-by-default decision: `ORDER_CONFIRM_REQUIRES_PAYMENT` flipped to default-ON — unset/garbage keeps the gate on, only the explicit opt-out `0/false/no/off` takes it out (inverted failure mode: a typo'd opt-out must not silently disable a money-integrity gate); live-feed e2e fixture now pays (intent→capture) before the owner confirm so the suite exercises the shipped default (CI included); gate spec re-pinned (598→604) + live smoke 19/19 default-on & 6/6 opt-out + full e2e 9/9 green x2 on fresh seed (2026-10-29, session 44)
  - [x] Web: pay button on `/checkout` + `/orders/[id]` (consume intent/capture endpoints; receipt shows payment status) (2026-10-29, session 43; `PaymentPanel` + `PayButton` on the receipt page — intent→capture ladder, paid state server-derived via `GET /orders/:id/payments`, `?pay=1` checkout handoff for signed-in, sign-in hint for guests; e2e `pay-order.spec.ts` 2 tests, suite 9/9 green x2)
- [x] Notifications: email confirmations (nodemailer) then push (web-push) (2026-10-31, session 49; API delivery + browser opt-in complete)
  - [x] Email: `MailService` (nodemailer, SMTP_HOST-gated) + `OrderNotificationsService` (order-placed + status-step emails for authenticated users; guest orders silently skip — no contactEmail on Order entity yet) + 20 specs (2026-10-29, session 45)
  - [x] Push API foundation: `PushService` (VAPID-gated web-push adapter), multi-device `push_subscriptions` table, JWT-scoped subscribe/unsubscribe routes, stale-endpoint cleanup, and order-created/status fan-out from the shared event bus (2026-10-31, session 48)
  - [x] Web: service worker + signed-in notification opt-in/out control (permission only after user gesture) (2026-10-31, session 49; logout detaches the browser endpoint)
- [x] Multi-city rollout config (cities as entities, restaurant scoping by city) (2026-10-31, session 50; city registry + migration/backfill + public API + owner writes + slug/name filtering)
- [x] i18n: English + Indonesian locale on storefront (next-intl) (2026-10-31, session 51; cookie-persisted EN/ID switch, localized home + restaurant/menu surfaces, metadata/header/footer, Playwright persistence coverage)
- [x] Dark mode (2026-11-02, session 52; server-rendered cookie preference, accessible localized toggle, full storefront palette + Playwright persistence coverage)
- [x] Admin panel (users, restaurants, orders oversight) (2026-11-02, session 53; ADMIN-only read-only overview API + web tables, safe-user mapping, aggregate/status counts, seeded admin fixture, 14-test E2E suite)
- [x] Analytics dashboard for owners (revenue, peak hours — SQL aggregates) (2026-11-02, session 54; OWNER/ADMIN-scoped completed-order aggregates, 24 UTC demand buckets, `/dashboard/analytics`, 15-test E2E suite)
- [x] Image upload for menu items (S3-compatible, presigned PUT) (2026-11-03, session 55; owner-scoped 5-minute presigns, 5 MiB MIME validation, direct browser PUT + menu PATCH, 15-test E2E suite)
- [x] Kitchen display system view (tablet-friendly prep board) (2026-11-03, session 56; live three-lane owner board, oldest-first cards, touch status actions, 15-test E2E suite)
- [x] Driver/courier role + assignment flow (2026-11-04, session 58; API foundation + live driver portal complete)
  - [x] API foundation: DRIVER role + nullable indexed order assignment (FK SET NULL), owner/admin assign/unassign endpoint, exact-driver inbox/status routes, migration/OpenAPI/seed/tests (2026-11-03, session 57)
  - [x] Web: driver portal + live assignment/status feed (2026-11-04, session 58; `/driver`, exact-role nav/access states, WS driver rooms with previous+next assignment wake-ups, polling fallback, 16-test E2E suite)
- [x] Scheduled cron: auto-cancel stale pending orders (2026-10-27, session 35; shared `stale-order-sweep` + ADMIN HTTP route + `ops/cancel-stale.sh` systemd/cron runner, STALE_ORDER_MINUTES/BATCH env, DRY_RUN; 469 tests green + live smoke)
- [x] PWA: installable storefront + offline cart (2026-11-04, session 59; manifest/icons + shared push/cache worker, offline app shell and editable persisted cart, 17-test E2E suite)
- [x] A/B-friendly feature flags table + helper (2026-11-04, session 60; DB-backed boolean flags with deterministic percentage cohorts)
- [x] Load testing script (k6) + tuning report in docs/ (2026-11-04, session 61; read-only public browse profile, 25-VU baseline: 15,027 requests, 0 failures, p95 4.06 ms)
- [x] SEO: metadata per restaurant page, sitemap.xml, robots.txt (2026-11-05, session 62; canonical/OG/Twitter metadata, dynamic restaurant sitemap, private-route crawl exclusions, 18-test E2E suite)
- [x] GDPR-ish data export & account deletion endpoints (2026-11-05, session 63; allowlisted full-account export + transactional password-confirmed deletion, retained-history anonymization, operational guards, Swagger/tests/live smoke)
- [x] Audit log table for status changes (2026-11-06, session 64; append-only `order_status_audits` with from/to/source + actor userId/role/email snapshot, wired into owner/driver/admin/customer/both stale-sweep paths, CHECK-constrained + indexed migration, live smoke: 7 rows across all 5 sources, rejected edges silent)
- [x] Menu item options/variants (size, spice level, extras) — cart line options (complete 2026-11-06, session 66)
  - [x] API: option groups/choices entities + migration, owner CRUD routes under `/menu/items/:id/options`, public menu read embeds `optionGroups`, order lines accept `optionChoiceIds` with server-side validation + integer-cents delta folding + jsonb receipt snapshot (2026-11-06, session 65; 68 suites/782 tests, live smoke 40/40 incl. cascade, snapshot immutability, 403/404/400 branches)
  - [x] Web: cart line option picker (render groups from menu read, enforce min/max in UI, send `optionChoiceIds`, show receipt on order history) (2026-11-06, session 66; `GET /restaurants/:id` embeds the same `optionGroups` as the menu route, cart lines keyed by dish+selection with lineKey, radio/multi chips with cap enforcement + live unit-price, grouped receipt rows on cart/checkout/receipt/history; 68 suites/785 tests, live smoke 22/22, e2e 20/20 green x2 incl. new `menu-options.spec.ts`)
- [x] Coupons expiry + usage caps (2026-11-06, session 67; redemption window + ledger-backed caps — `startsAt`/`expiresAt` + `maxTotalUsages`/`maxPerUser` on the code, append-only `promo_usages` table (unique per order, cents snapshot, guest/erasure-safe userId), enforced in `evaluate()` for BOTH preview and order create (4 new reasons incl. expired/total/per-user cap; guests skip per-user only), `POST /promos/validate` now reads the optional bearer identity, ADMIN CRUD + ledger read at `/admin/promos*`, seed demo codes for every gate + honest ledger for seeded promo orders, migration 19th; 69 suites/823 tests, live smoke 54/54, e2e 20/20 green x2)
- [x] Restaurant open hours (day-of-week schedule entity) + auto isOpen (2026-11-07, session 68; `restaurant_hours` weekly windows w/ midnight wrap + IANA `timeZone`, batched `hours`/`isOpenNow` embed on storefront reads, owner PUT-semantics `PATCH /restaurants/:id/hours`, legacy manual `isOpen` stays the no-schedule fallback; 71 suites/851 tests, 47/47 live smoke, e2e 22/22)
- [x] Search: fuzzy name/description match with pg_trgm (2026-11-07, session 69; public `GET /api/search` — trigram `%` + word-containment `<%` + escaped-ILIKE over restaurant name/description/cuisine and AVAILABLE dish name/description, server-relevance-ranked, 4 GIN `gin_trgm_ops` indexes + trusted-extension migration, hits embed the shared `hours`/`isOpenNow`; +6 missing menu-options ops registered into the OpenAPI contract; 73 suites/870 tests, live smoke 41/41 incl. typo-vs-substring contrast and EXPLAIN index proofs)
- [x] Map view of restaurants (Leaflet) (2026-11-09, session 70; `restaurants.latitude/longitude` migration with range CHECKs + must-travel-together partner guard on owner create/update (both-null clears) + seed pins (Bowl House deliberately off-map) + public storefront `/map` — client-only Leaflet chunk, `CircleMarker` pins colored by server-derived `isOpenNow`, popups + accessible pinned-list mirror, EN/ID, header nav + sitemap entry; 74 suites/883 tests, live smoke 39/39, e2e 24/24 green ×2)
- [x] Unit-of-work: wrap order create in a transaction + stock guard (2026-11-09, session 71; single `manager.transaction` now owns stock decrement → order+items → promo ledger (a rejected/failed order writes NOTHING); `menu_items.stock` nullable int + CHECK migration (NULL = unlimited, every seeded row stays NULL); guard = conditional `UPDATE ... WHERE stock >= requested RETURNING stock` with duplicate-line aggregation, sorted lock order, 409 `INSUFFICIENT_STOCK`; `recordUsage` locks the promo row FOR UPDATE + re-checks caps inside the tx — the session-67 "last redemption" race is CLOSED (live-proven: 2 true-concurrent cap-1 orders → one 201 + one 400, exactly one ledger row); owner DTO three-way stock patch (number/null-clear/absent); `em.query` UPDATE-RETURNING `[rows,rowCount]` tuple trap caught+fixed+mocked; 75 suites/900 tests, live smoke 49/49, e2e 24/24)
  - [x] Restock repair pass — cancelled orders whose snapshot is non-NULL but `stockRestockedAt` stayed NULL (crash window between the status commit and the restock commit) must get their units back; today only the marker makes such rows identifiable (session 72 DEVLOG "Left for next sessions") (2026-11-10, session 73; shared DI-free `runRestockRepair` selects exactly cancelled + non-empty-array snapshot + marker NULL + older than `RESTOCK_REPAIR_GRACE_MINUTES` (default 10, so a healthy in-flight cancel is never raced), oldest-first bounded batch (500, `capped` flag), and hands each orphan to the SAME marker-CAS primitive — repairs idempotent, TRUE-concurrent double-repair live-proven to move units exactly once; junk-entry snapshots honestly resurface until operator-fixed; ADMIN `POST /orders/ops/restock-repair` + `restock-repair` cron script + `ops/restock-repair.sh` + systemd timer examples, dryRun script-only (HTTP strips it, pinned); no migration; 79 suites/948 tests, live smoke 58/58, e2e 24/24; also repaired a session-35-era `***`-masked test secret committed in `cancel-stale.admin.spec.ts`)
  - [x] Stock restock on cancel — owner/admin/customer cancels and the stale-sweep must return reserved units (ledger is decrement-only today) (2026-11-09, session 72; `orders.stockDecrements` jsonb snapshot frozen inside the create transaction — restock returns exactly what was ACTUALLY taken, NULL = nothing, so late stock-on can't be inflated — + `stockRestockedAt` CAS marker flipping inside one shared DI-free transaction per dish (`stock + units WHERE stock IS NOT NULL`, sorted-id lock order); wired into ALL four cancel paths incl. the standalone `cancel-stale` cron script; CHECK-constrained migration 24th; 76 suites/916 tests, live smoke 63/63 with TRUE-concurrent double-cancel proving exactly-once, e2e 24/24)
  - [x] Web: storefront "only N left" badge + dashboard stock editor (API + DTOs are ready) (2026-11-11, session 74; StockBadge pill (<=5 amber "Only N left" / 0 red "Sold out" + disabled Add) on MenuBrowser, favorites mirror `FavoriteDish.stock`, dashboard inline stock line + MenuItemForm "Limit sellable units" tracker mirroring three-way PATCH (number sets, uncheck clears to null, omitted untouched), EN/ID; 79 suites/949 tests, live smoke 16/16 incl. sold-out 409 writes-nothing, e2e 26/26)
- [x] CI matrix: postgres 15/16 compatibility (2026-11-11, session 75; db-bootstrap now a 15/16 service-container matrix — full chain proven green locally on PG15.19 incl. a 9/9 API runtime probe — and the schema-drift gate was found vacuously green (timestamp-prefixed filename vs '^DriftCheck' anchor + permanent 31-statement introspection-noise diff, byte-identical on both majors) and rewritten to filter the three known noise classes and fail on anything else, live-proven with an injected-drift negative test)

## Phase 6 — Hardening & polish ✅ complete 2026-11-12 (opened 2026-10-28, Phase 4 closed; from the Ops/UX evergreen loops)
- [x] API: boot-time config validation (env.schema via class-validator; fail fast on missing JWT_SECRET/DATABASE_URL instead of silent dev fallbacks) (2026-10-29, session 46)
- [x] API: supertest-based integration specs for the payments + refunds routes (today covered by service-unit specs + live smoke only) (2026-10-30, session 47; 19-case HTTP spec for RestaurantOrdersController incl. the 402 payment-gate envelope)
- [x] API: `GET /orders/:id` ownership fix — guests must prove contact-email match, not just know the uuid (id enumeration risk) (2026-11-11, session 76; `orders.contactEmail` proof column + shared trim/lowercase normalizer; `findOneForViewer` ladder ADMIN-bearer → owner-bearer → exact proof presenter, every denial the SAME 404 as an unknown id (no existence oracle); route moved to OptionalJwtAuthGuard + `?contactEmail=`; checkout collects the email (account-prefilled when signed in), redirect/history/dashboard/admin links carry the proof; new OrderVerify island auto-unlocks bare links via the bearer rung or a typed email; GDPR export/erasure parity; seeded proof emails; 80 suites/960 tests, live smoke 30/30 on a 25-migration from-empty DB, e2e 28/28 green ×2 incl. 2 new order-access specs)
- [x] Web: storefront empty/loading/error states audit (no-results search, dead restaurant links, offline API banner) (2026-11-11, session 77; dead-link/offline split — `isApiDown` + localized `ApiOffline` card + metadata no longer noindexes transient outages; home no-results names its filters with a clear-filters CTA EN/ID; favorites shows its load failure + retry instead of lying "Nothing saved"; audit verdict: ZERO route-level loading boundaries — proven to soft-404 `notFound()` statuses and duplicate boundary DOM; live SSR curl smoke 14/14 incl. kill-the-API branches, e2e 31/31 green ×2 with 3 new `empty-states.spec.ts` tests)
- [x] Web: accessibility pass on checkout + dashboard (labels, focus order, aria-live on order status) (2026-11-11, session 78; checkout's 5 orphan labels wired htmlFor+ids (+aria-describedby email hint, role=alert submit error); dashboard status strip made into REAL ARIA tabs (roving tabindex, Arrow/Home/End auto-activate, aria-controls→tabpanel); silent push-sync diff + owner actions mirrored into a polite sr-only live region ("FO-X is a new order…/moved from pending to confirmed"), tracking island announces orderStatus transitions incl. the final one (region stays mounted when the transport UI retires); dish dialog Tab-trap + opener focus restore (captured during render — mount effects see autoFocus's target, not the button); inbox cards/menu rows role=group named, Details links per-order labels; e2e 36/36 green ×2 with 5 new portal-a11y specs incl. getByLabel-every-field and a 429-tolerant payOrder helper)
- [x] Perf: N+1 sweep on `/restaurants` list (menuItemCount subqueries) + verify with query logger + EXPLAIN (2026-11-12, session 79; query-logger verdict: NO N+1 — constant 3 statements at any limit, hint was stale; what the logger caught instead: `search=` rewritten from un-indexable `LOWER() LIKE` to escaped-metacharacter `ILIKE` bitmap-scanning the session-69 GIN trgm indexes + new cuisine partner-index migration (26th), `city=` leftJoin→EXISTS semi-join (4th DISTINCT-ids statement eliminated), `meta/cuisines` full-table entity load → single `SELECT DISTINCT cuisine`; selective search 10 vs 374 buffers; sort-index overfitting deliberately avoided; +5 perf-contract specs (80 suites/965 tests), full migration chain green from empty, e2e 36/36, findings in docs/PERFORMANCE.md)

## Phase 7 — Metrics, mobile & remaining polish ✅ complete 2026-11-13 (opened 2026-11-12, Phase 6 closed; from the Ops / UX / Test evergreen loops)

- [x] Ops: lightweight request-metrics middleware (per-route count + duration histogram + status class, folded into the existing pino structured log) + ADMIN `GET /admin/metrics` snapshot route + specs — the alerts loop needs data before it can fire. (2026-11-12, session 80; DI-free registry keyed on the MATCHED route template — live-proven uuid collapse (2 ids → 1 `GET /api/restaurants/:id` row), unmatched-path normalization + 250-key overflow cap; cumulative 5ms–10s+Inf histogram with nearest-bound p50/p95/p99 estimates; `finish`-listener ordering decorates the pino ACCESS line with `{bucket, status_class}` — one stream, no second log; periodic `event:"request_metrics"` fold via `METRICS_LOG_INTERVAL_SEC` (default 60, `0` off, garbage→default never crash-boot); ADMIN `GET /admin/metrics` typed swagger contract; `/api/health` invisible to both; +2 suites/+29 tests (82/994), live smoke 28/28 on a 26-migration from-empty DB incl. fold-line grep, e2e 36/36)
- [x] UX: accessibility pass #2 — the forms session 78 listed as leftovers (login, register, saved-addresses, order-history filters, receipt OrderVerify + rating card): real label associations, inline `role=alert` errors, focus order + restore; e2e `getByLabel` specs mirroring the portal-a11y pattern. (2026-11-12, session 81; register: aggregated error list → inline per-field role=alert + aria-invalid/describedby + focus-first-invalid + `noValidate`; addresses: the four orphan labels → real htmlFor/id + focus into the opened form; order-history chips: bare role=tab → full APG tabs (roving tabindex, Arrow/Home/End, aria-controls tabpanel) + alert/status banners; rate card: nameless sr-only star radios → "N star(s)" names + labelled comment box + alert errors; OrderVerify hint → input description; e2e `zz-forms-a11y` 6 tests, full suite 42/42 green on fresh seed — the first run's 5 failures were all spec-side harness lessons, now pinned as comments: Next ships an always-present empty `role=alert` route-announcer div, "(optional)" spans are part of accessible names, and `check()` on clipped sr-only inputs needs the wrapping label instead)
- [x] Perf: k6 authenticated scenario (signup → browse → cart → order → pay MOCK) against isolated test accounts + a disposable database, reported as a NEW baseline in docs/PERFORMANCE.md (rec 5) — never mixed into the public browse baseline. (2026-11-12, session 82; `ops/load-test-auth.js` — 7-request iterations (auth detail browse, order 201, payment intent 201, capture 200 succeeded, receipt via bearer rung, history) with 1 signup per VU and a pure cents-exact cart planner pinned by the ops contract test; ran on a 26-migration scratch DB with boot-time relaxed rate buckets; smoke 29 iters + load 992 iters / 5,963 req / 42.4 req/s / ~7.05 order-creates/s, 0 failed requests, 8,170/8,170 checks, p95 13.7 ms; post-run DB cross-check EXACT: 992 orders all pending each with exactly one succeeded payment, 10 signup users; 82 jest suites/994 tests unchanged — no API source touched)
- [x] UX: mobile polish pass on storefront cart/checkout (tap-target sizes, sticky submit bar, no horizontal scroll at 360px) + Playwright viewport coverage. (2026-11-12, session 83; cart rows stacked (the 360px flex row left ~56px for a dish name), steppers 32→44px, `useIsCompactViewport` matchMedia hook renders the sticky cart/submit bars ONLY under 640px — CSS-hidden duplicates would poison the desktop suite's strict text locators; checkout inputs text-sm→text-base (iOS focus zoom) + autofill/inputMode attrs; sticky submit re-targets the one form via `form=`; the shared header was the real horizontal-overflow culprit on every phone page → flex-wrap; e2e `mobile-cart-checkout` 3 tests at 360×800 — pinning, tap boxes, no-zoom, guest order placed through the sticky CTA; suite 45/45 green ×2 on fresh seed)
- [x] Test: error-budget dashboard stub — traffic & error-budget cards wired to `GET /api/admin/metrics` (scope corrected from the owner analytics page: the route is ADMIN-only global telemetry) — `TrafficPanel` on `/admin`: requests / latency-p95 / 5xx / error-budget (99.5% availability SLO, 4xx-exempt) cards + top-15 route table + "Cumulative since API boot" honesty (no implied time window); metrics-only failure degrades just that section, never blanks the tables; e2e `admin-traffic` cross-checks the DOM against the payload the page itself received via waitForResponse (shape-based — boot-cumulative counts make absolutes impossible); curl smoke proved the :id row tallies 4xx, health probes + raw uuids never appear, 401 unauthenticated (2026-11-13, session 85; e2e 45→47 green ×2, API untouched)
- [x] Test: fuzz the public search/list query params (property-based over `search`/`city`/`cuisine`/`sort`/`page`/`limit`) asserting constant statement shape + 4xx-or-2xx only, no 5xx — a hostile-input regression gate for session 79's contract. (2026-11-13, session 84; seeded xorshift harness + 3 hostile corpora, unit sweeps (1800 cases) asserting presence-only predicate sets + illegal-codepoint-free bound params, HTTP sweeps over both real controllers behind the real pipe+filter (2xx/4xx only), and the two fixes it proved: delete-only `query-sanitizer` (NUL/lone-surrogate → driver 22021 → 500 class, gated in the search DTO Transform + service edge + the DTO-less restaurants list service) and `clampToIntRange` (2.5/NaN/Infinity/1e23 → bigint 22P02/overflow class, page capped 1..100k, limit 1..50); suite 86/1064 (+4/+70), live smoke 29/29 on real driver incl. driver-level reproduction of both error codes and 75-case wire sweep, 0 API-log errors)

## Phase 8 — Alerts, persistence & remaining surfaces (opened 2026-11-13, Phase 7 closed; from the Ops / Test / UX / Perf evergreen loops)

- [x] Ops: alert RULE on top of the metrics data + viewer — evaluate the snapshot against thresholds (5xx rate vs the 99.5% SLO, p95 bound creep, route-key overflow) into a named `ops/alerts` evaluator + ADMIN `GET /admin/alerts` current state + a `request_metrics`-fold line carrying the verdict; systemd/cron runner like the stale-sweep precedents. (2026-11-13, session 86; DI-free `src/ops/alerts.ts` — error_budget (strictly >0.5% over a min-50 sample floor), p95_latency (histogram estimate vs 1000ms), route_key_overflow (warning); env knobs read once at boot, garbage→default never crash, 0 legal to prove the chain; ONE engine for the ADMIN pull route (typed swagger contract + round-trip pin, OpenAPI 73→74), the compact fold verdict, and `ops/alert-scan.sh`/systemd timer with exit codes 0 healthy · 1 alerting · 2 scan-broken so a dead smoke detector never pages like a fire; 88 suites/1097 tests (+2/+33), live smoke 41/41 on a 26-migration from-empty DB across 3 boots incl. a GENUINE 500 (DROP DATABASE WITH (FORCE) under the live pool) flipping the budget rule + fold + scan exit 1 on a recovered DB, and a 260-path flood firing overflow alone)
- [x] Test: sanitizer sweep for the remaining public free-text params (session 84 leftover) — audit every route reading raw query strings (dish-search `q` on restaurant reads and any future additions) for the delete-only sanitizer gap; regression spec pinning "no controller takes an unsanitized public string to the driver". (2026-11-13, session 87; audit verdict: NO raw text param escaped — dish search lives at the guarded `/api/search`, the only remaining free-text query param (`?contactEmail=`) is compared in JS memory and never bound into SQL — but the sweep caught the numeric sibling of the 500 class: `reviews` (PUBLIC), `orders` lists ×3 and `promos usages` bound unbounded `Number(page)` math into OFFSET (live-PROVEN 500s on `?page=1e30`, pre-fix dist) — now closed-range clamped via shared `MAX_PUBLIC_PAGE`/`blankToUndefined` + `query-surface-audit.spec.ts` static gate (TS-AST discovery of every @Query site, registry + mechanical source evidence, DTO decorator completeness — a new unregistered site fails CI); 89 suites/1117 tests (+1/+20), live smoke 18/18 on a 26-migration from-empty DB, 0 driver errors in the API log)
- [x] Test: e2e coverage for GDPR export & account deletion (session 63 shipped API+smoke only) — **web surface + e2e shipped session 88**: new `/account` page (browser blob download of the allowlisted JSON, password + exact-`DELETE` double-confirmed deletion forcing sign-out, guest sign-in card, robots-disallowed); `zz-gdpr-account` 3 tests prove the real download content (leak sweep over every payload key), both rejection guards keep the account alive, the live refresh token cascade-dies, re-login 401s, and the anonymized order still renders for the owner — fresh-seed-safe (throwaway customer + own order, no absolute counts). Web build green, API jest delta 0 (89/1117), e2e 47→50 green ×2 (2026-11-13, session 88).
- [x] Ops: metrics durability — the registry is cumulative-since-boot by design, so every restart silently zeroes the error budget; persist periodic snapshots (jsonb row or file) and have `/admin/metrics` expose `sinceBoot` + windowed deltas as additive fields. (2026-11-14, session 89; `metrics_snapshots` table (jsonb payload + capturedAt + bootStartedAt, 27th migration, indexed prune+lookup) — `MetricsPersistenceService` writes full snapshots every `METRICS_SNAPSHOT_INTERVAL_SEC` (default 300, 0 off, garbage→default) and prunes past `METRICS_SNAPSHOT_RETENTION_SEC` (default 24h, 0=garbage); `GET /admin/metrics` gains additive `durability` (enabled/stored/lastCapturedAt/bootAligned/error) + `window` (EXACT subtraction of the newest SAME-BOOT row from live totals: requests, byStatus, fiveXxRatePct, avg, delta-histogram percentiles with honest nulls, top-10 route deltas); cross-boot rows are REFUSED as a baseline (restart → window null until the new boot's first row — no false error budget); store errors degrade the extras, route always 200s with the live snapshot; two live-driver bugs caught+fixed by the smoke: order-only `findOne` is rejected by this TypeORM (→ find+take:1) and the aliased DELETE clause produced 42P01 (→ raw quoted column); +2 suites/+25 tests (91/1142), live smoke 30/30 on a 27-migration from-empty DB incl. restart durability + retention prune + disabled path)
- [x] Perf: admin panel bundle trim — the `/admin` route now ships tables + charts-adjacent DOM to every admin visit; measure First Load JS for the route, code-split TrafficPanel behind the metrics fetch, and record the delta in docs/PERFORMANCE.md. (2026-11-14, session 90; `next/dynamic` + `ssr: false` on TrafficPanel — the existing `metrics != null` render gate makes the chunk fetch STRICTLY behind the metrics round-trip, so outage/401 visits download zero panel bytes; exact manifest-gz A/B: first-load 113,561 → 113,295 B (−266 gz / −2,194 raw, the table's rounding hid it), deferred chunk 5,818 raw / 1,962 gz; honest verdict recorded: SMALL trim, pure-DOM panel with no chart library, no further split warranted — the remaining 16 kB IS the tables; served-HTML probe proves the async hash absent from first payload; admin-traffic 2/2 + full e2e 50/50 green, API delta 0)
- [x] UX: kitchen display + driver portal empty/loading states pass (session 77 audited the storefront only) — first-order board, no-assignment driver inbox, offline banner parity, localized where the storefront is. (2026-11-14, session 91; the audit found two real liars — a failed driver-inbox load rendered the "No deliveries assigned" empty card over missing data, and a failed restaurant-LIST load in kitchen fell through to three "No orders in this lane" cards — both fixed by a `loadFailed{down}` area owner so empty states only render after a successful load; `authedCall` errors carry `down` (client twin of `isApiDown`); new localized `PortalOffline`/`PortalLoadFailed` cards (shared `api-offline` testid parity with the storefront); only a LOADED lane may claim quiet; all-quiet board = one ALL CLEAR banner; failing Refresh keeps the last good data + amber strip on both surfaces; `PortalStates` EN/ID namespace (state furniture only — chrome tracked as a new item below); 13 e2e testids new; 7 new `portal-states` specs (read-only route-interception, seed-safe), full suite 50→57 green ×2 consecutive)
- [x] UX: portal chrome localization — dashboard, kitchen, driver and admin page titles, gate cards, action labels and transport pills are still English-only (session 91 localized the state furniture of kitchen/driver; the chrome of all four surfaces is next). (2026-11-14, session 92; new `Portal` namespace 142 keys × EN/ID covering all four surfaces + the shared PortalTabs nav + StatusBadge; EN values byte-pinned against the untouched 57-test EN suite — dashboard announcements/action errors key-based via labelKey, kitchen/driver run a second `tc` translator beside `PortalStates`, admin detail templates interpolate numbers as strings; 4 new `portal-chrome-id` e2e tests incl. an intercepted synthetic driver card (read-only, seed-safe); the ID==EN value audit caught the one missed translation; ARCHITECTURE rule added; full e2e 57→61 green ×2, API delta 0)
- [x] UX: localization leftovers — portal document `<title>`s (client pages export no metadata), `TrafficPanel` internals + the module-scope spinner aria, `/dashboard/menu` + `/dashboard/analytics` chrome, and the still-English `/orders/my` history chrome (session 92 scoped these out of the portal chrome item on purpose). (2026-11-14, session 93; 132 new Portal keys × EN/ID across all five surfaces incl. the whole MenuItemForm dialog, six zero-DOM title-owning server layouts, shared-key reuse + `String(n)` ICU doctrine; 5 new e2e tests 61→66 green ×2 fresh-seed with every EN pin byte-identical; API delta 0; also A/B-quantified and harness-hardened a PRE-EXISTING login-redirect-vs-nav-click race in admin.spec — product fix filed below)
- [x] UX: storefront i18n sweep #2 — checkout labels/hints, cart-page chrome and the receipt surface still carry English literals outside the badge/tab reuse sessions 74–92 delivered (from the Evergreen UX loop; session 92's storefront-leftover note). (2026-11-14, session 94; 153 new keys × EN/ID — `Cart`/`Checkout`/`Order` namespaces + shared `Common` words + the offline shell page: cart page, cart-switch dialog, the whole checkout form incl. promo ladder and both submit buttons, SSR receipt (status pills, timeline, live-feed announcement, payment panel/button every state, OrderVerify, rate card); EN values byte-identical (42-string pin dict asserted on disk, zero EN spec assertions edited), ID placeholders localized, timeline timestamps locale-aware; 3 new `storefront-i18n-checkout-id` e2e tests (ID cart→checkout chrome through a real add flow, ID receipt on a self-created order, ID OrderVerify denial); 69/69 green ×2 consecutive fresh-seed, API delta 0 (91/1142))
- [x] UX: storefront i18n sweep #3 (session 94 leftover) — the saved-address book page, login/register chrome, and the receipt/checkout document `<title>`s; also decide the locale-aware helper for the `lib/` fallback error strings (authed-call/api "Cannot reach the API…" literals shared by portal + storefront). (2026-11-16, session 95; 80 new keys × EN/ID — `Auth` 24 + `Addresses` 33 + `Common` +10 shared words + 3 titles + `Checkout`/`Order.pageTitle` — full login/register/addresses surfaces incl. validation ladders (module-scope `validate()` receives the translated set), four zero-DOM title layouts + `generateMetadata` on the SSR receipt; DECISION for lib fallbacks: `lib/locale-strings.ts` reads the locale off the SSR'd `<html lang>` (cookie is httpOnly), EN values byte-identical, ID wording = Portal `histErrApi*` pair; `API error ${status}` stays technical English; session-92's "login page is English chrome" e2e assumption updated in `portal-chrome-id`; 5 new e2e tests, suite 69→74 green ×2 fresh-seed, API delta 0)
- [x] UX: storefront i18n sweep #4 (session 95 leftover) — the `/favorites` page and the `/account` GDPR page chrome are still English-only (found while sweeping auth surfaces; both have localized sibling surfaces to reuse wording from: gate cards, `Header` links, status words). (2026-11-16, session 96; 43 new keys × EN/ID — `Favorites` 15 + `Account` 27 + `Common.retry`, gate CTAs reuse `Header.signIn`; whole /favorites + /account surfaces incl. the SHARED FavoriteButton heart (aria + guest title — restaurant-menu mirror), row date via `toLocaleDateString(locale)`, ICU plural + suffix keys replacing the hand-rolled delete-summary, both delete client guards localized while the mono-`DELETE` server phrase stays exact; 2 zero-DOM title layouts; EN values byte-pinned against the untouched suite; SSR curl titles EN+ID; 6 new e2e tests 74→80 green ×2 consecutive fresh-seed, API delta 0 (91 suites/1142 tests)).
- [x] Test: product fix for the login-redirect vs nav-click race — the auth forms now ENGAGE a settle-gate from submit start until their redirect commits (lib/nav-gate.ts store + Header `inert`/`pointer-events:none`/`data-navgated`, login & register skip-effect and submit paths, failed submits release immediately, 8s safety timer for never-committing redirects); a click can no longer START inside the flight window, so it waits and lands instead of being dragged back home; 4 new e2e pins (deterministic held-click repro via 800ms home-RSC hold, inert-window attributes, error-path release, signed-in skip redirect, registration mirror), 5x stable + full suite 80→84 green ×2 fresh-seed; honest A/B note: the router already discards a late-landing pending replace (route holds cannot widen the fetch-done→commit render window — session 93's cold ~1/5 stays the empirical defect evidence); API delta 0 (91 suites/1142 tests), ARCHITECTURE rule rewritten from suite-side workaround to product-side gate (2026-11-16, session 97).
- [x] 🔒 Per-restaurant traffic for owners — explicit registry dimension (session 85 decision: never expose the global snapshot on an OWNER rung). (2026-11-16, session 98; DI-free restaurant dimension in `RequestMetricsRegistry` — attribution ONLY via matched route templates `/api/restaurants/:id/*` + the `:restaurantId` menu variant (dish-ids can't masquerade), uuid-gated lowercased, buckets MINTED ONLY BY 2xx/3xx so random-uuid 404 probes never grow the key space while 4xx/5xx top up existing buckets, 250-bucket cap REFUSES (never folds — no shared "other" leak), metrics reads EXEMPT (polling never inflates your own view), additive `restaurantKeys`/`restaurantOverflowed` on the admin snapshot; OWNER + admin-bypass `GET /api/restaurants/:id/metrics` built EXCLUSIVELY from that restaurant's bucket (zero global fields, honest zeros, shared `getOwned` ladder extracted for updateOwned so 404/403 semantics cannot diverge), typed swagger contract ops 74→75; +2 suites/+23 tests (93/1165) incl. a finish-time attribution pin through the real middleware chain on a nested-param controller, live smoke 48/48 on a 27-migration from-empty DB with exact per-bucket arithmetic)
  - [x] Web: owner traffic panel consuming `GET /restaurants/:id/metrics` — requests / latency-p95 / status classes / top template rows on `/dashboard/analytics` (or a tab) + the "cumulative since API boot" honesty label; e2e via session 85's shape-based waitForResponse cross-check (boot-cumulative counts forbid absolute pins); EN/ID. (2026-11-18, session 99; shared `TrafficPanel` generalized to a structural `TrafficView` Pick + optional scoped heading — ONE component for both rungs, no global field can ride onto the OWNER rung even at the type level; independent metrics fetch beside analytics so neither failure blanks the other, `dynamic ssr:false` chunk strictly behind the `traffic != null` data-presence gate (session 90), amber role=alert degrade strip + localized `traffic-panel-loading` skeleton; `Portal.ownerTrafficHeading` EN/ID + all traffic chrome reused; 3 new e2e `owner-traffic` tests (wire↔DOM cross-check with deterministic bucket-mint + exact OWNER key-set pin + observer-exemption sweep, abort-proven degradation, ID byte strings); e2e 84→87 green ×2 consecutive fresh-seed, web build green, API delta 0)
  - [x] 🔒 Per-restaurant durability: buckets are live-only (a restart silently zeroes them — session 89 fixed exactly this for the global view); persist the restaurant dimension and serve windowed deltas per restaurant. (2026-11-21, session 116; the restaurant map rides the SAME `metrics_snapshots` payload rows (one capture instant per tick, no new table/migration), and `GET /restaurants/:id/metrics` gains exactly ONE additive key `durability` with the bucket-local `window` delta nested under it — no `stored` global row count, the session-85 ADMIN-only rule extended to durability metadata; honest zero baseline at the row instant when the bucket minted after the newest row, honest null for cross-boot/pre-116/corrupted pairs, never a clamp; +15 tests (98/1294), live smoke 48/48 on a 29-migration from-empty DB incl. restart + disabled-writer phases, e2e 114/114 ×2.)
  - [x] 🔒 Order-centric attribution: `POST /orders`, payments and receipt reads concern a restaurant but carry no restaurant path param — needs an explicit service-side opt-in hook (never a url heuristic). (2026-11-24, session 125; `attributeRequestRestaurant` — a DI-free AsyncLocalStorage hook stamping the RESOLVED row id onto the request-id context; the metrics middleware captures the context reference at entry (synchronous, inside the storage.run scope) and folds `restaurantScopeOf(req) ?? stamped` at finish — template ALWAYS wins (wire-pinned), denials and foreign 404s stamp NOTHING (no-oracle doctrine extended to the owner's traffic view), attribution never invents an extra DB read (replayed-SUCCEEDED capture stays unattributed), minting stays 2xx-only through the unchanged record() gate; five call sites: create (restaurant resolution), pay, capture (normal path), listForOrder, findOneForViewer (authorized rungs only); +1 suite/+19 tests (102/1380) incl. REAL-chain integration pins, live smoke 22/22 on a 29-migration from-empty DB with exact per-bucket row arithmetic and global-vs-bucket denial tallies.)
## Phase 9 — Evergreen: test reliability, product depth & speed (opened 2026-11-18; Phase 8 keeps only its two 🔒 items — the ACTIVE top-down queue starts here; from the Test / Product / Perf / UX loops)

- [x] Test: kill the recurring `zz-forms-a11y` "receipt: bare link…" flake at the ROOT (sessions 91/99 both filed an "instrument the fixture timings" follow-up — it was due twice) — root cause found by code: the receipt test's `page.goto` the moment after the sign-in click ABORTS the in-flight `POST /auth/login` (document-navigation fetch cancellation; the sibling zz-gdpr spec documented the same class in a comment). Hardened `signInUi` in BOTH specs to the redirect-COMMIT contract, instrumented every direct-API fixture leg with `fixture-timing` annotations, made `loginToken` 429-tolerant, and pinned the hazard AND the fix deterministically in new `e2e/tests/zz-login-abort.spec.ts` (held login response — old sequence renders GUEST + null session, hardened contract rides out the same hold); full suite 87→89 green ×2 consecutive on fresh seeds, targeted 8/8 ×3, API delta 0 (2026-11-18, session 100).
- [x] Product: owner replies to customer reviews — one reply thread per review (single `reply` + repliedAt on the review, owner PATCH/DELETE route, storefront renders the reply nested under the review) + EN/ID + e2e. (2026-11-18, session 101; migration 28th — `reply`/`repliedAt` ON the review row with a CHECK pairing them (single thread: a second PATCH REPLACES, no history); `PATCH`/`DELETE /reviews/:id/reply` on the `getOwned` ladder of the review's restaurant — authorship does NOT grant it (author-customer 403), ADMIN bypass; blank 400 never a silent clear, clear idempotent without writes; reply NEVER recomputes stars and the reply contract carries no rating aggregate; GDPR export allowlist deliberately excludes owner reply text; feed + `/reviews/my` embed the thread; nested response card on the restaurant page EN/ID; seed ships one deterministic reply; 93 suites/1187 tests (+22), live smoke 41/41 on a 28-migration from-empty DB incl. the CHECK drift probe, e2e 89->92 green x2 fresh-seed).
  - [x] Web: owner reply composer UI — a dashboard reviews surface consuming `PATCH`/`DELETE /reviews/:id/reply` (API + nested storefront rendering + seeded thread shipped session 101; today an owner must script the call). (2026-11-18, session 102; `/dashboard/reviews` + shared `PortalTabs` Reviews tab + `ReviewReplyComposer` (pre-filled edit, replace = second save, delete only when a thread exists, failed save keeps the draft) + `api.setReviewReply`/`clearReviewReply`; reads ride the PUBLIC feed so the owner sees the storefront's rows, only writes carry the bearer; session-91 honesty: empty card only after a successful load, offline vs 4xx split, ADMIN `mine=[]` gets the honest no-restaurant card; 30 new Portal keys × EN/ID (ICU plural count passed as number); web build green, API delta 0, live curl ladder incl. whitespace-400, e2e `owner-reviews` 5 new tests, full suite 92→97 green ×2 consecutive fresh-seed.)
- [x] Perf: HTTP caching for public reads — short-TTL `Cache-Control` + ETag revalidation on `GET /restaurants`, `GET /restaurants/:id`, `GET /search`; prove 304s with curl AND with the query logger (a revalidation must not fake a fresh DB read), and check what it does to the per-restaurant metrics buckets (3xx tops up existing rows only — cold observers never mint a bucket via a 304). (2026-11-18, session 103; DI-free `common/http-cache/` — URL-keyed in-process store (500 cap, evict-oldest), anonymous-only whitelist of the THREE exact paths (strict uuid match; sub-paths/bearer/HEAD/POST byte-transparent), strong sha256 ETag + `Cache-Control: public, max-age=N` + `Vary: Authorization`, `HTTP_CACHE_TTL_SEC` (default 15, 0 off, garbage→default); fresh hits are served WITHOUT routing (the zero-SQL claim, live-proven per-window with the query logger: 0 statements in revalidation windows vs 2–8 in capture windows), and because routing was skipped the middleware stamps the whitelisted route PATH template onto `req.route` so finish-time attribution composes the exact template key (live dev boot: `GET /api/restaurants` row `{2xx:3, 3xx:1}` under the real controller); middleware registered LAST so served hits keep metrics samples + access lines; restaurant buckets re-ruled to 2xx-only mint (cold 304 can never mint, 3xx tops up — keys stable live); express's own `res.send` freshness owns the cold `INM: *` case (pinned in specs, store never sees it); TTL expiry revalidation still 304s but the re-read honestly happens (documented boundary); e2e boots with TTL=0 for suite-state honesty; 95 suites/1206 tests (+2/+19), live smoke 51/51 x2 on a 28-migration from-empty DB, e2e 97/97 x2.)
- [x] Perf: k6 public-browse re-baseline under the session-103 cache (PERFORMANCE.md recommendation 6) — expect statements-per-request to collapse; record as a NEW baseline, optionally with an `If-None-Match` replay profile for the 304 path. (2026-11-18, session 104; NEW baseline section in PERFORMANCE.md — same rig, A/B vs a TTL=0 control on one build: browse p95 5.07→2.52 ms at identical iteration rate (83.2 vs 83.9 req/s; k6 sends no If-None-Match, so this is pure server-side served-200), query-logger stmt/req 2.000→0.262 (7.6×); new shipped `ops/load-test-conditional.js` replay profile (1 capture + 2 forced-304 replays per iteration, loud abort without a cacheable strong ETag — it caught the k6 `Etag` canonicalization harness bug live): 45,145 reqs @ 250.7 req/s, p95 1.29 ms, 30,096/30,096 replays 304, stmt/req 0.003 (~625× below control); pure helpers + profiles pinned in the ops contract test; product code untouched (API jest delta 0, web delta 0), 28-migration from-empty rig, scratch DB dropped after.)
- [x] UX: `/favorites` + `/addresses` loading/skeleton pass (both pages flip empty→content in one frame today; evergreen loading-states loop). (2026-11-19, session 105; AUDIT: the flip hint was STALE — pulse skeletons gated on `loaded` shipped sessions 95/96 — but the pass caught the REAL violation: `/addresses` rendered the "No saved addresses yet" empty card over a FAILED load (no `!loadError` gate; favorites had it). Gate fixed; addresses error banner → `addresses-error` retry card with localized Try again (zero new copy); its error KIND raised to the isApiDown doctrine (shared EN/ID apiDown fallback names a network drop — caught by the first targeted e2e run, product-side); both skeletons gained the established `animate-pulse` + stable skeleton testids; new `loading-skeletons` spec 4 tests (900ms-held loads prove skeleton-only mid-fetch, failed loads prove NEVER-empty, retry ends honest; intercepted payloads, read-only + seed-safe); web build green, targeted 4/4, full e2e 97→101 green ×2 fresh-seed, API delta 0, message bundles untouched.)
- [x] Test: graduate the session-100 flake tooling — sweep the REMAINING inline sign-in helpers (admin, live-feed, portal-a11y, account each keep their own click sequence) onto the redirect-commit contract, and fail the e2e CI job when any `fixture-timing` annotation exceeds a wall-clock ceiling. (2026-11-19, session 106; new `e2e/helpers/fixtures.ts` = ONE source for signInUi (redirect-commit, locale-tolerant), timed+429-tolerant loginToken/payOrder, createOrder/warungFixture/timed/bearer — 19 specs migrated, 16 inline click-sequences replaced (several had NO redirect guard: admin-2, owner-analytics, pay-order), 9 helper copies deleted, 7 sign-in functions now delegate; the 4 login-surface-owner specs keep their sequences on purpose; raw `headers: { authorization: ... }` literals eliminated suite-wide (runtime-assembled bearer); ceiling gate `e2e/check-fixture-timings.mjs` on the new json-reporter artifact (15s work / 90s `.limiter-wait` — 429 backoffs credited OUT of work legs), zero-leg report fails too, wired after the run in the CI e2e job; measured: 101/101 green ×2 fresh-seed (inventory byte-identical), max work leg 121 ms, live 9–10 s limiter waits classified correctly; gate negative-tested (tight ceiling → 19 violations, zero legs → fail, allow-zero → pass, synthetic work/wait split ×3); API delta 0 95/1206, web delta 0.)

## Phase 10 — Order velocity, payload size & gate telemetry (opened 2026-11-19, Phase 9 exhausted; from the Product / Perf / Ops / Test evergreen loops)

- [x] Product: "Order again" — one click on a COMPLETED order (history card +
  receipt) refills the cart from the ORDERED snapshot (menu items that were
  deleted/disabled since are reported honestly and skipped; option choices
  ride the jsonb snapshot), then routes to the restaurant page. API read
  helpers already exist; the interesting part is the option-choice
  availability ladder + the min-order/cart-switch interplay. EN/ID + e2e.
  (2026-11-19, session 107; pure `lib/order-again.ts` ladder — first failing
  rung skips-and-names: gone/unavailable/sold-out/options-changed, stock
  clamps ride with a report, prices ALWAYS current not the snapshot;
  `CartProvider.applyOrderAgain` batch writer with the documented
  merge-by-lineKey vs confirmed-replace split; ONE island on history cards
  AND the SSR receipt (guest cart works); clean plan auto-routes, any
  report keeps the shopper with a result panel + continue CTA; 18 OrderAgain
  keys × EN/ID; web build green, new 5-test `zz-order-again` spec, full e2e
  101→106 green ×2 fresh-seed + timing gate OK, API delta 0 (95/1206).)
- [x] Perf: response compression on the API's public browse payloads
  (`GET /restaurants`, `/:id`, `/search` — the session-103 cache stores
  UNCOMPRESSED bodies, so gzip layers on top of the 200 path; prove the
  content-encoding + cache-correctness interaction with curl AND make sure
  the ETag still matches what was hashed), then re-measure with the k6
  conditional profile — record as a new row in docs/PERFORMANCE.md.
  (2026-11-19, session 108; hand-rolled DI-free `browse-compression.ts`
  registered BEFORE the cache so store-served hits flow through the SAME
  res.end wrapper (order = contract, pinned in the live chain suite) —
  same `cacheTargetOf` whitelist, GET/json-2xx/>=`HTTP_COMPRESS_MIN_BYTES`
  (default 1024, 0 off), identity/HEAD/POST/sub-path/4xx clients never
  get their res patched; store stays uncompressed and the strong ETag
  stays sha256 of the DECODED bytes — identical across variants,
  curl+smoke-proven on all three paths (sha256first32(gunzip(wire)) ==
  ETag), Vary gains Accept-Encoding ONLY on encoded responses, 304s stay
  bodiless, zero-SQL revalidation survives the layer (query-logger 0
  statements), bearer'd rows encode (orthogonal to the cache opt-out);
  no new dependency, no lockfile churn; conditional profile updated to
  browser-shaped Accept-Encoding + per-leg capture_ms/replay_ms trends
  (k6 defaults to identity — a naive A/B would have sampled an
  unencoded wire): throughput holds 250.3 vs 250.6 req/s, wire
  62.0→28.5 MB (list capture 6,914→1,924 B, −72%), capture p95 +0.32 ms
  gzip CPU, replay unchanged, 100% checks both arms; 96 suites/1224
  tests (+1/+18), live smoke 38/38 on a 28-migration from-empty DB,
  e2e 106/106 green ×2 with the layer ON, web delta 0.)
- [x] Ops: alert rule for METRICS-SNAPSHOT staleness (session 89's durability
  rows are the error-budget's memory — a silent writer death zeroes history):
  `ops/alerts.ts` gains a `snapshot_stale` rule (no row newer than 2x the
  snapshot interval while the writer is enabled) + the alert-scan script +
  unit/live coverage of the fire and the disabled-writer exemption.
  (2026-11-20, session 109; DI-free 4th rule over an optional caller-supplied
  `SnapshotFreshnessInput` — disabled writer EXEMPT by design, zero-rows grace
  from API uptime, UNREADABLE store reported honestly, ceiling =
  `ALERT_SNAPSHOT_STALE_AFTER_SEC` or derived 2x interval (miss-two-ticks rule),
  warning severity still flips `alerting` so exit codes page; route wires
  `MetricsPersistenceService.freshnessInput()` so admin AND the unchanged
  alert-scan inherit it, fold line reports honest not-evaluated; +17 tests
  96/1241 incl. mirror pin re-deriving rule ids from the real engine; live
  smoke 32/32 three boot arms — healthy/exit-0, DROP-TABLE dead writer firing
  with the REAL scan exit 1, disabled exemption + knob echo exit-0; all 4
  smoke FAILs were harness bugs.)
- [x] Test: fixture-timing trend visibility — the ceiling fails CI but the
  distribution is invisible: have check-fixture-timings.mjs also emit a
  GitHub job summary table (slowest legs by label + run-over-run counts) and
  a ::warning annotation at 60% of the ceiling, so a crawling leg is caught
  BEFORE it crosses (from the Test loop).
  (2026-11-20, session 110; per-label aggregation + bounded 20-run JSONL
  history transported via CI artifact publish/best-effort refetch, summary
  table with historical + last-5 maxes, ::warning strictly above 60%
  (knob) / ::error on violations, legacy exit codes untouched; 11
  browser-free node:test selftests run first in the gate step; local proof:
  full e2e 106/106 real report, gate x2 with merged history, fetch script
  live against the real API anonymous.)

## Phase 11 — Alert history, delivery ETAs & budget gates (opened 2026-11-20, Phase 10 exhausted; from the Test / Ops / Product / Perf / UX evergreen loops)

- [x] Test: verify the fixture-timing trend round trip — over the next two
  CI runs after 57020d7 confirm the fetch step merges >=1 prior run, the
  summary's historical-max column reflects CI-side legs, and history stays
  bounded (~20 records); if the anonymous artifacts listing proves
  unordered, switch the fetch script to sort by workflow-run id and note
  it in e2e/README.md. Record the outcome in the DEVLOG either way.
  (2026-11-20, session 111 — VERIFIED via artifact-size decode (real
  records merge since run 126; zero sentinels shipped; listing proved
  ordered so no sort change) AND the one genuine bug it exposed fixed:
  download-artifact@v4 needs `github-token:` for cross-run search —
  run 134 is the first with zero error annotations.)
- [x] Ops: persist alert verdicts — capture the alerts engine's evaluation
  (verdict, firingRules, ages) into a small time series alongside the
  session-89 metrics snapshots (reuse the writer pattern + a migration),
  serve a windowed `GET /admin/alerts/history`, render an error-budget
  style panel on the admin dashboard, and make alert-scan escalate
  repeated fires (>=3 consecutive alerting evals bumps the page note).
  (2026-11-20, session 112; API side — `alert_verdicts` table (29th
  migration; status CHECK + jsonb type CHECKs + capturedAt index) written
  ONE ROW PER METRICS SNAPSHOT TICK by `AlertVerdictsService` reusing the
  same interval/retention knobs and the SAME engine call the route makes
  (full report stored verbatim; reads never write); `GET
  /admin/alerts/history` (ops 75→76) windowed rows oldest-first + the
  consecutive-alerting streak counting this read's live verdict on top of
  the persisted tail run (trailingCapped = honest lower bound); DTO-
  validated + service-clamped bounds registered in the query-surface
  audit; alert-scan escalates at `ALERT_SCAN_ESCALATE_AFTER` (default 3)
  with an stderr ESCALATION note + escalated/streakAlerting stdout fields
  — exit-code class UNCHANGED, a broken history read leaves escalation
  UNKNOWN; 97 suites/1263 tests (+1/+22), live smoke 58/58 on a
  29-migration from-empty DB across two boot arms incl. SIGSTOP-frozen
  API↔SQL exact cross-checks and the REAL scan escalating on a chronic
  fire; web delta 0.)
  - [x] 🔒 Web: error-budget-style alert-history panel on `/admin`
    consuming `GET /admin/alerts/history` — streak + firingRules over
    time, degrade-on-metrics-failure parity with TrafficPanel, e2e via
    the session-85 waitForResponse cross-check (absolute streak numbers
    are boot-dependent, pin shapes). EN/ID. (2026-11-21, session 114;
    four cards incl. the ≥ lower-bound streak honesty + per-tick rail +
    newest-first firing-rule table with RAW rule ids; rail/table render
    ONLY on a usable series — an `error:true` read shows the honest
    degrade banner, never the empty-list lie; history-only failure
    degrades ONLY its section, traffic cards independent; dynamic()-
    behind-success code-split parity with TrafficPanel; 29 Portal keys
    × EN/ID; live curl ladder 200/400/401; e2e 110→114 green ×2
    fresh-seed — 1 live payload cross-check + 2 deterministic
    intercepted branches (alerting render, error degrade) + ID locale;
    API delta 0 98/1279.)
- [x] Product: delivery ETA honesty — compute per-restaurant recent real
  duration (confirmed→completed, median of last 20, fallback to the
  seeded estimate when <5 samples), expose it on the restaurant payload,
  and surface it on the restaurant page + checkout ("usually ~25 min"),
  EN/ID + unit + e2e. Money stays integer cents; durations integer seconds.
  (2026-11-21, session 113; read-time derivation in DI-free
  `restaurants/delivery-eta.ts` — ONE batched percentile SQL attached ONLY
  on `GET /restaurants/:id` (list/search keep session 79's shape), garbage
  exclusion (both stamps + positive duration), full-eligible sampleCount
  vs newest-20 window, estimate fallback keeps the old pill byte-identical,
  failed read degrades to null never a 500, no migration/env churn;
  DeliveryEtaResponse swagger component; 98 suites/1279 tests (+1/+16),
  live smoke 18/18 on a 29-migration from-empty DB incl. the exact
  4→5→6-sample ladder and 26-vs-20 windowing proof, e2e 110/110 green ×2
  fresh-seed with 4 new tests incl. a REAL paid+owner-ladder observed flip
  + ID locale shapes.)
- [x] Perf: First Load JS budget gate — a zero-dep node script reads the
  gzip chunk sums (session-90 method) from apps/web/.next and FAILS the
  CI web job when a core storefront route exceeds a committed baseline
  table (docs/PERFORMANCE.md, measured at ship). Include a deliberate
  over-budget negative test like the drift gate does.
  (2026-11-21, session 115; `apps/web/scripts/check-bundle-budget.mjs` —
  exact gzip-9 manifest-entry sums proven to reproduce Next's table
  arithmetic at kB rounding; 7-route baseline committed in
  PERFORMANCE.md between BUNDLE-BASELINE markers, zero tolerance with a
  documented `--print` re-measure ritual; dead-gate guards on manifest/
  table/stale-route/missing-chunk; CI web job = selftests (13 browser-free
  node:test cases incl. the 1-byte-over negative) BEFORE the real gate;
  live negative on the real build: 1-byte baselines -> exit 1 naming all
  7 routes, missing table -> marker-not-found exit 1; cold build green,
  gate +0 B margin on every route; the FIRST CI run went RED and caught
  a local .env.local-polluted baseline (+39 B on 5 routes -> re-measured
  CI-clean, doctrine now written into PERFORMANCE.md); API delta 0, web
  app-code delta 0.)
- [x] UX: focus-visibility + skip-link audit — every portal control gets a
  visible `:focus-visible` state, storefront gains a skip-to-content link,
  and the keyboard-driven spec pattern (portal-a11y) pins both; EN/ID
  chrome covered via existing message keys. (2026-11-21, session 117; ONE
  global `:focus-visible` contract in globals.css (2px solid brand ring +
  2px offset, theme-switched --focus-ring) — declared after
  @tailwind utilities so it ties-and-wins against bare `.outline-none`;
  the only suppressor outlier (ReviewReplyComposer's `focus:outline-none`)
  normalized; SkipLink sr-only-until-focused with programmatic #main-content
  focus hand-off (1 genuinely new key Common.skipToContent EN/ID — every
  other ring needed no copy); kitchen/driver refresh testids for locale-
  proof pins; 6 new e2e tests that earn EVERY ring via real Tab-walks +
  exact computed-style equality (never .focus()); web build green, full
  e2e 114→120 green ×2 fresh-seed, timing gate OK, API delta 0 (98/1294);
  bundle gate proven unaffected via IN-PATH HEAD-vs-tree A/B — and the
  reason (layout chunks invisible to per-route sums) filed as Phase 12 #1.)

## Phase 12 — Bundle truth, tracking polish & dark-ring verification (opened 2026-11-21, Phase 11 exhausted; from the Perf / Product / UX / Test evergreen loops)

- [x] Perf: fix the bundle-gate undercount (session 117 finding) — the gate
  sums only each route's OWN app-build-manifest chunks, so shared ROOT
  LAYOUT and CSS chunks are invisible to every pinned budget (SkipLink's
  +209 B gz landed at margins +0 on all 7 routes). Sum the full ancestor
  chain (layout + css) per route, re-measure the committed table CI-clean
  (in-place builds — path-absolute sums are not comparable across
  worktrees), and prove a layout-only change now trips the gate via a new
  node:test selftest. (2026-11-23, session 118; per-route metric = UNION
  of the page entry + every ancestor `/layout` manifest key, `.js` AND
  `.css`, each file deduped to one count — for `/` that closes a real
  28,805 B blind spot (6,749 CSS + 18,352 layout-only client chunks +
  3,704 layout module); table = CI-MEASURED sums (`/` 135,773) after the
  first CI run went RED +5 B and the full three-run diagnosis pinned the
  cause to PATH-embedded module ids in main-app/app-layout chunks
  (Node/zlib explicitly exonerated by pin A/B; the old own-entry sums
  had matched across environments only by size coincidence); selftests
  13 -> 15 incl. the LAYOUT-only negative
  (SkipLink repro shape) + nested-chain dedupe test, the CSS rule
  reversed; live 1-byte-under negative on the real build exit-1 naming
  all 7; gate now self-reports per-file chain breakdown via CI
  annotations for anonymous postmortems; PERFORMANCE.md + CI step
  comments rewritten; API delta 0
  (98/1294), web app-code delta 0.)
- [x] Product: tracking-page delivery polish — once an order is
  `delivering`, show the assigned driver's first name and a
  "usually ~N min" remaining estimate derived from session 113's
  per-restaurant ETA (read-side embed only, no migration; EN/ID + e2e).
  (2026-11-23, session 119; pure `orders/delivery-view.ts` builder —
  remainingMinutes = ceil((session-113 ETA seconds − confirmedAt→now)/60),
  clamp 0 = arriving-soon, createdAt fallback anchor, etaSource null only
  on aggregate-read failure; attached ONLY by `findOneForViewer` (receipt)
  and ONLY while `delivering` — every other status/read byte-identical,
  live-proven zero extra SQL on preparing reads via the query-logger
  window; 99 suites/1313 tests (+1/+19), live smoke 26/26, SSR card +
  Order ns 84→89 keys EN/ID, e2e 120→122 green ×2 fresh-seed, bundle
  gate zero client delta.)
- [x] UX: dark-theme focus-ring verification + mobile bottom-bar keyboard
  pass — session 117 pins the ring on the light canvas only; extend the
  spec to the dark theme cookie (rgb(249,115,22)) and audit the
  mobile-only compact bottom bar (use-compact-viewport furniture) for
  focus order and ring visibility. (2026-11-23, session 120; AUDIT VERDICT
  zero product bugs — dark `theme` cookie swaps the ring exactly to
  brand-500 on skip link + header + owner dashboard (cookie-anchored SSR
  walk); one-full-cycle Tab walks at 360x800 pin the compact bars as the
  FINAL tab stops: /cart clear→CTA adjacent, ringed, still sticky-pinned
  when focused, surface inverts to rgb(41,37,36) under dark with the
  swapped ring; /checkout tail `checkout-submit → checkout-promo-input →
  mobile-submit-cta` with the sticky handle LAST and asserted ENABLED
  before the walk (disabled buttons contribute no stop); +4 tests, suite
  122→126 green ×2 fresh-seed, bundle gate OK (+41..50 margins), web
  delta = one `data-testid="mobile-cart-clear"`; ARCHITECTURE gained the
  consolidated Keyboard-focus-contract bullet; harness truths: Chrome
  keeps a sequential-nav start point across blur(), cycle walks must
  anchor ON the skip link, and the skip link's own testid must lose to
  its href pattern in element naming.)
- [x] Test: k6 WRITE profile against the cached+compressed stack — a
  checkout ladder (auth → create → pay) at modest VUs with
  HTTP_CACHE_TTL_SEC default and compression ON, asserting
  statements-per-request and zero 429s in a new docs/PERFORMANCE.md
  section (session 104's conditional profile never exercised writes).
  (2026-11-23, session 121; `ops/load-test-write.js` — anonymous
  CACHEABLE browse (bearer-free, both sides of the 1024 B gzip threshold
  pinned) → signup → create → intent → capture → not-cache-marked
  receipt, per-leg trends, loud abort on ANY 429 or missing cache
  contract; FIRST load run caught a real product bug — `orders.code`
  birthday-collision 500 (4-char Math.random draws into a UNIQUE
  column) — fixed same session: 6-char crypto.randomInt draws +
  bounded 23505 retry of the whole create unit-of-work with a fresh
  code (+1 suite/+5 tests, 100/1318; live smoke 13/13 with a
  trigger-forced deterministic collision via nextval counter); load
  arms: cached 506 iters/2,536 reqs p95 12.71 ms 6,076/6,076 checks
  vs TTL=0 control 505/2,531 — stmt/req 8.00→7.11 (honest: writes
  dominate), browse leg 5.22→1.53 ms on zero SQL in-TTL, 0×429 both
  arms, exact DB cross-check (1,011 orders, one succeeded payment
  each); targeted e2e 14/14, web delta 0.)

## Phase 13 — Guest reach, limiter telemetry & baseline durability ✅ complete 2026-11-24 (opened 2026-11-23, Phase 12 exhausted; from the Product / Ops / Test / Perf / UX evergreen loops)

- [x] Product: guest order notification emails — the session-45 fan-out
  skips guest orders silently ("no contactEmail on Order entity yet"),
  and the session-76 proof column finally IS on the entity: deliver
  placed + status-step emails to `orders.contactEmail` (normalized,
  trim/lowercase) for orders with NO userId, keeping the bearer-only
  suppression rules intact. Unit + live smoke (send-capture transport
  like session 45's), EN/ID copy via the existing email templates.
  (2026-11-23, session 122; `resolveEmail` ladder — authed mail stays
  user.email ONLY (contactEmail never a verified fallback), guests get the
  re-normalized proof address, addressless guests stay silent, push remains
  bearer-only. Templates extracted into DI-free `notifications/email-copy.ts`
  with a `locales` array: authed renders EN byte-identical (spec-pinned vs
  the session-45 builders), guests one bilingual EN+ID email (no recipient
  locale is stored server-side — honest compromise + extension point). New
  `SMTP_JSON_CAPTURE` rig (jsonTransport + single-line MAIL_CAPTURED log,
  precedence over SMTP_HOST, garbage inert) enabled the live smoke: 27/27
  on a 29-migration from-empty DB incl. on-the-wire bearer suppression and
  a disabled ARM2; 101 suites/1344 tests (+1/+26) with the two legacy
  guest-skip pins flipped to the new contract; API surface untouched —
  swagger/query-surface/e2e deltas 0.)
- [x] Ops: rate-limit pressure telemetry — the metrics registry counts
  status CLASSES, so a store silently shedding 429s is invisible between
  the limiter's own headers and a customer complaint. Add an additive
  per-route `429` counter (only when the guard actually throttles),
  surface it on the ADMIN snapshot, and give `ops/alerts.ts` a
  `rate_limit_pressure` rule (429 share over a sample floor, env knob)
  that rides the fold line + alert-scan exit codes like the other four.
  (2026-11-23, session 123; `RateLimitGuard` stamps the bucket on a
  blocked request BEFORE throwing (new DI-free `rate-limit.marker.ts`)
  and the metrics middleware counts ONLY stamp+finish-429 — an unmarked
  429 can never inflate it; additive `throttled` on GLOBAL route rows +
  totals (4xx-subset, overflow-fold carries it), restaurant view never
  emits the key so the pinned OWNER-rung shape stays byte-identical
  (unit+integration+HTTP pins); 5th rule `rate_limit_pressure` — share
  STRICTLY above `ALERT_RATE_LIMIT_PCT_MAX` (default 5, 0 legal,
  garbage→default) over the shared `ALERT_MIN_REQUESTS` floor, warning
  severity (the 429 means the limiter WORKED; sustained pressure =
  customers turned away); fold verdict + persisted `alert_verdicts` +
  real alert-scan exit 1 all inherit with zero consumer changes; typed
  contracts registered (ops still 78); +17 tests (101 suites/1361),
  live smoke 38/38 on a 29-migration from-empty DB with a real orders
  bucket 2/600s flood, e2e 126/126 green ×2 fresh-seed, web delta 0.)
- [x] Test: make the k6 write ladder a SCHEDULED perf regression — an
  `ops/perf-check.sh` (scratch DB + boot + smoke-arm ladder + threshold
  grep, cleanup trap) mirroring the alert-scan exit-code doctrine
  (0 green / 1 regression / 2 broken rig), so "baselines drift" is caught
  by a runner, not by memory. docs/PERFORMANCE.md run section + a
  systemd timer example.
  (2026-11-24, session 124; runner = preflight+lock → scratch DB →
  optional fresh build → seed + post-seed window anchor → boot :4110
  relaxed-bucket → k6 smoke arm in container → `perf-check.analyze.mjs`
  (k6 exit class 0/99/108/other + summary-JSON rules: p95 ceiling
  default 120 ms, 429>0, zero orders, capture<95%, failed>1%, checks
  <0.99, thin/garbage = rig) → EXACT DB cross-check + zero-level-50 log
  gate → one JSON verdict line, trap drops DB+kills API. All three exit
  codes proven LIVE on the host (green 29 iters/p95 17.99 ms/crosscheck
  29/29·29/29·0; regression via tightened ceiling; rig-broken via busy
  port and held flock); first live run caught+fixed the harness's own
  seeded-window and jq empty-generator bugs. 18 node:test selftests +
  CLI exit contract, wired into the CI api job alongside the previously
  CI-orphaned k6 contract test; `ops/systemd/foodorder-perf-check.{service,
  timer}` daily 04:20 with TimeoutStartSec=20min; PERFORMANCE.md run
  section + repaired session-82 recipe line that had carried a
  sanitizer-swallowed secret export. API/web delta 0 — jest 101/1361
  green, app source untouched.)
- [x] Perf: finish the cache whitelist decision for `GET /api/search` —
  session 103's item text proposed it but the shipped whitelist is the
  THREE list/detail paths; either add search to the store (per-query URL
  key + bounds on the store cap + metrics attribution like the three) or
  record WHY NOT (query-parameter fan-out makes hit rates worthless) in
  ARCHITECTURE.md — an explicit decision either way, plus the k6 browse
  profile extended to whichever shape ships.
  (2026-11-24, session 126; ground-truth verdict: session 103 SHIPPED
  search in the whitelist already — the open half was the explicit
  decision record and session 104's leftover that NO k6 profile ever
  rode the search route. Decision recorded: KEEP — fan-out is real but
  the full-URL key + shared 500-entry evict-oldest cap bound the worst
  case to exactly one honest re-read (live-proven: newest-flood replay
  0 statements vs evicted-oldest re-read 3; metrics row closed 510
  requests with 2xx+3xx == total). Both rotations gained
  `/search?q=nasi&limit=10` (browse 5 shapes, replay 4) + a
  cacheTargetOf-mirror pin in the ops contract test so a slipped
  transparent path fails at test time; ARCHITECTURE.md DECISION
  paragraph + PERFORMANCE.md statement-window section. Live smoke
  44/44 on a 29-migration from-empty DB (first iteration 42/2 — both
  harness arithmetic, reconciled on the wire), k6 smoke arms 74/223
  and 75/76 at 100% checks; app source untouched — jest delta 0
  (102/1380), web delta 0.)
- [x] UX: "Order again" from CANCELLED orders — session 107's ladder is
  COMPLETED-only; a cancelled order is exactly when a customer wants to
  retry. Same `applyOrderAgain` path (no restock semantics needed — the
  ladder reads the snapshot), honest skip reporting, EN/ID; e2e pinning
  the cancelled card gains the button.
  (2026-11-24, session 127; pure condition widening `completed ||
  cancelled` on BOTH surfaces (history card + SSR receipt mount) —
  ladder/island/cart-writer/messages untouched, zero new copy; new 6th
  e2e test pins cancelled-tab pill → clean auto-route badge 1 → bare-URL
  receipt mirror merges badge 2 → ID `Pesan lagi`; live curl smoke
  cancelled=1 / pending=0 / completed=1 on the warm boot; IN-PATH bundle
  A/B +0 B `/orders/[id]`, +7 B `/orders/my`, other five routes
  byte-identical; full e2e 126→127 green ×2 fresh-seed + timing gate OK;
  API delta 0 — sources untouched.)

## Phase 14 — Load truth, repair telemetry & receipt reach (opened 2026-11-24, Phase 13 exhausted; from the Perf / Ops / UX / Test / Product evergreen loops)

- [x] Perf: full k6 LOAD arms for the session-126 5-shape browse rotation
  (smoke-arm numbers were recorded instead of a load table) PLUS the
  session-104 leftover mixed hit/miss RATIO profile — real fleets
  interleave capture and revalidation; record both as new rows in
  docs/PERFORMANCE.md with the statement-window cross-check like
  session 126's table. (2026-11-24, session 128; three load arms on one
  29-migration scratch DB — control 2.400 / cached 0.229 / mixed 0.667
  stmt/req, ALL closing arithmetically (per-shape probe constants 2/1/5/1/3
  reconstruct the control window to the statement); new shipped
  `ops/load-test-mixed.js` 1:1:1 capture:revalidate:recycle profile on
  unique /search q keys, RUN_TAG fail-loud, contract-pinned helpers;
  mixed arm: 44,239 reqs @ 245.7 req/s, every revalidation resident-304,
  zero 5xx; ops+docs only — API/web delta 0.)
- [x] Ops: `restock_repair_backlog` alert rule — orphaned cancelled
  orders (non-NULL snapshot + NULL `stockRestockedAt` past the repair
  grace, session 73's own predicate) are invisible between cron runs;
  count them, feed a 6th DI-free rule into `ops/alerts.ts` (env
  threshold, warning severity), ride the fold line + persisted verdicts
  + alert-scan exit codes like the other five. Unit + live smoke.
  (2026-11-24, session 129; whole-table `countRestockOrphans` sharing the
  ORPHAN_WHERE fragment (no batch cap by design), `RestockBacklogObserver`
  caller-supplied observation on the pull route + verdict tick (fold line
  honestly not-evaluated), `ALERT_RESTOCK_BACKLOG_MAX` default 0 fires
  strictly above; 103 suites / 1393 tests (+13) + live smoke 34/34 incl.
  grace boundary, NULL-snapshot exclusion, persisted-row fire, scan
  exit 1 -> repair drain -> exit 0.)
- [x] Product: per-user notification channel settings — the email ladder
  is all-or-nothing today (authed orders get status emails whenever SMTP
  is configured; session 122's guest path has no opt-out at all) while
  push is per-device only (sessions 48/49); add user-level toggles
  (order_email / order_push, defaults preserve current behavior)
  consulted in `OrderNotificationsService`, an `/account` settings
  section on web, GDPR export parity, unit + SMTP-capture live smoke +
  e2e. (2026-11-25, sessions 130–131; API + web + e2e closed — see
  sub-items.)
  - [x] API: `users.orderEmailEnabled`/`orderPushEnabled` boolean columns
    (NOT NULL DEFAULT true — migration 30, no backfill), GET/PATCH
    `/users/me/notification-settings` (JwtAuthGuard, strict-boolean DTO —
    `null`/`0`/`"false"` all 400, empty patch 400, entity-named key
    stripped), `resolveChannels` single user read gates BOTH send paths
    (confirmation + status steps) with strict `=== false` (unwritten rows
    read ON), guest ladder untouched, GDPR export embeds
    `notificationSettings`, toggles deliberately outside `SafeUser`;
    swagger ops 78→80 + bearer/SUCCESS/ERRORS pins; +1 suite/+20 tests
    (104/1413) incl. the IsOptional-swallowed-`null` 500-class caught at
    unit time, live smoke 26/26 on a 30-migration from-empty DB with
    SMTP-capture email ladder + persistence + guest-untouched phases
    (2026-11-25, session 130).
  - [x] 🔒 Web: `/account` notification settings section consuming
    GET/PATCH `/users/me/notification-settings` (two toggles, EN/ID,
    degrade-on-failure parity with the GDPR card) + e2e pinning the
    flip-and-persist round trip through the real UI; push-side gating is
    unit-proven only (live rig has no VAPID) — leave the honest note.
    (2026-11-25, session 131; checkboxes render ONLY from the last
    re-read persisted answer — no optimistic write, so a failed PATCH
    self-reverts; failed GET degrades to error+retry, never fabricated
    toggles; 10 EN/ID keys with parity+ICU-token asserts before merge;
    full e2e 130/130 fresh-seed incl. 3 new specs (throwaway user: flip
    -> reload -> API wire -> GDPR export byte-exact; aborted PATCH writes
    nothing; aborted GET recovers) + read-only ID chrome pin; live curl
    smoke defaults/PATCH/export/401 all-exact with demo state restored;
    named zz-* after a first-run admin.spec ordering catch — its
    no-separator card text pin silently depends on seed user totals.)
- [x] Test: receipt proof-param sweep — property tests over
  `?email=`/`?contactEmail=` normalization edges pinned against the real
  presenter ladder (trim, case folding incl. non-ASCII, the raw-`+`
  wire-decodes-to-space trap, already-known dot-address fixtures),
  asserting the SAME 404 shape for every denial (no oracle drift).
  (2026-11-25, session 132; new HTTP wire-level suite (real controller +
  real service + real pipe + live sockets): raw-plus trap, double-encode,
  full JS trim-class padding, NUL/oversize, NULL-stored rows, non-ASCII
  fold edges (i+U+0307 round trip, Turkish dotless asymmetry, ß is not
  'ss', homoglyphs distinct), 9-family byte-exact no-drift denial sweep,
  160-case normalizer-agreement + 60-case write-chain seeded property
  sweeps; probe-established truth that the String-metatype pipe coercion
  (not the service) is what flattens repeated-key arrays today — the
  typeof guard now pins the same collapse at the helper; 105 suites /
  1442 tests (+29) + live smoke 24/24, e2e untouched by design.)
- [x] Product: magic-link receipt access — the order-confirmation emails
  (session 122 now reaches guests too) link the order page, but a bare
  link still demands a typed proof email; embed a short-lived signed
  access token in the email link that unlocks the receipt via a
  one-time query rung (bearer ladder unchanged). API + email copy +
  live smoke + e2e.
  (2026-11-25, session 133; ground truth first: the emails shipped NO
  link at all (push carried the bare `/orders/:id`), so the increment is
  the link + the rung. `orders/receipt-access.ts` DI-free HMAC-SHA256
  capability (purpose-separated from auth JWTs; `?rt=` rung 4 on
  `findOneForViewer`, bearer + typed-proof rungs byte-unchanged; foreign/
  tampered/expired/junk all answer the ONE canonical 404, no-oracle
  sweep included; TIME-BOUNDED not nonce-consumed — documented decision);
  `RECEIPT_TOKEN_TTL_SEC` (72h default, strict Number parse, 30d clamp) +
  `WEB_PUBLIC_URL` envs; both order emails gained the localized
  View-your-order line (absent URL renders zero extra bytes — session-45
  pins survive; fail-open builder, guest bilingual gets EN+ID lines,
  authed stays EN-only); web receipt page + `api.getOrder` ride `rt`
  (URLSearchParams wire, percent-safety pinned); query-surface registry +
  swagger @ApiQuery updated; +2 suites/+37 tests (107/1479) incl. the
  stub-config inert-rung class caught at test time, live smoke 29/29 on a
  30-migration from-empty DB driving the REAL captured-email tokens
  through the ladder (expiry via a ttl=1 mint, status-email fresh-token
  unlock, ADMIN rung untouched), e2e `zz-magic-link` 4 new tests, full
  suite 130→134 green ×2 fresh-seed + timing gate OK.)

## Phase 15 — Mail truth, magic-link hardening & cache visibility (opened 2026-11-25, Phase 14 exhausted; from the Ops / Test / UX / Perf / Product evergreen loops)

- [x] Ops: mail delivery telemetry — `MailService.send` failures today vanish
  into a log line and a `best-effort` comment, so a dead SMTP relay is
  invisible between a support ticket and the log tail. Count per-channel
  attempts + failures in the metrics registry (additive `mail` totals on
  the ADMIN snapshot, like session 123's `throttled` shape), add an
  `email_delivery_failure` alert rule (failure share over a floor, env
  knob) riding the fold line + alert-scan exit codes, and extend the
  `SMTP_JSON_CAPTURE` rig so a live smoke can force the failing-transport
  arm. Unit + live smoke. (2026-11-25, session 134; registry mail
  dimension — confirmation/status/general attempts+failures GLOBAL-only
  like `throttled` (restaurant key-set pins untouched), MailService
  channel arg + `MAIL_FAILED {json}` structured rejection marker,
  disabled transport counts NOTHING; ALERT_EMAIL_MIN_ATTEMPTS=5 floor +
  ALERT_EMAIL_FAILURE_PCT_MAX=50 ceiling (0 legal), rule 7 SEVENTH
  ERROR-severity and fully SNAPSHOT-DERIVED so the fold line + the real
  alert-scan ride it with ZERO extra wiring; `SMTP_JSON_CAPTURE=fail`
  failing-transport rig arm; 107 suites/1504 tests (+25), live smoke
  32/32 on a 30-migration from-empty DB across THREE boots — fail arm
  fires the rule ALONE with exact per-channel arithmetic + scan exit 1,
  success arm quiet at observed 0 + scan exit 0, disabled arm all-zeros
  "not evaluable".)
- [x] Test: magic-link token-structure fuzz sweep — session 132's proof-param
  doctrine applied to `?rt=`: property sweep (seeded rng + the existing
  fuzz harness) over structural mutations of a real token (charset, bit
  flips, truncations, segment swaps, expiry tampering) asserting constant
  outcomes — the valid token ALWAYS unlocks, EVERY mutation answers the
  byte-identical canonical 404, and nothing 5xxes through the real pipe
  + filter (extending receipt-magic-link.http.spec.ts).
  (2026-11-25, session 135; six seeded families × 40 mutations over the
  REAL HTTP ladder, verdicts pinned to AGREEMENT with the pure verifier
  oracle — probe-established truth is that Node's lenient base64url
  decoding admits EQUIVALENT ENCODINGS of the same digest (trailing `=`,
  skipped non-alphabet injections in the SIG segment, an exactly-4
  last-char malleability group over the 2 unused bits) which live 200,
  while payload-side never does (HMAC over the raw string) and the
  raw-vs-encoded `+` mirror splits both ways — the blanket "every
  mutation 404s" claim is honestly FALSE and the spec now says so;
  structurally-dead families (bitflip/truncation/segment-swap/
  unresigned-expiry) pin ZERO unlocks; every denial byte-identical
  canonical 404, zero 5xx; deterministic pins for dot-boundary shapes,
  the wire-invisible 4096 guard (4096/4097 indistinguishable) and
  clock-bound expiry; 107 suites/1516 tests (+12, spec-only) + live
  smoke 21/21 on a 30-migration from-empty DB driving the REAL
  captured-email token through the full app incl. equivalence arms;
  web/e2e delta 0 — evidence-only increment.)
- [x] Product: one-click pay from the magic link — session 133 made guests
  VIEW the receipt from their email, but payment stays bearer-only by
  design (session 43's sign-in hint): an unauthenticated email recipient
  still cannot pay. Decide explicitly: either extend `POST /payments` +
  capture reads to ride the `rt` rung (the token is the customer's own
  checkout capability — the ladder question is whether a VIEW capability
  may transact), or record the refusal in ARCHITECTURE with the reason
  (capability tiers: read vs write). Whichever ships: specs + live smoke
  + e2e + EN/ID copy for any new panel state.
  (2026-11-26, session 136; DECISION = SHIP with a tier: rt pays GUEST
  orders only (strictly narrower than the session-38 "any signed-in user
  may pay a guest order" rung), owned orders keep rt at VIEW — mailbox
  access never becomes money access on an account (ARCHITECTURE decision
  paragraph). `PaymentAccessGuard` (bearer attempt never downgraded;
  presence-only admission; anonymous-without-rt keeps the byte-identical
  401), service ladder verifies the HMAC against the LOADED row in memory
  (never a SQL predicate), rt rows carry no payer id, capture settles only
  rt-created rows, every denial the canonical 404 (session-135 baseline
  preserved); swagger ops move to the optional-bearer list; +2 suites/+36
  tests (109/1552) incl. a wire suite proving the money POSTs carry no
  Authorization header, live smoke 37/37 driving REAL captured-email
  tokens with the confirm-gate flip pinned both ways (402 unpaid → 200
  after magic-link payment); web panel pays guest orders off the same
  token (tier denial collapses honestly to the sign-in hint), one new
  `Order.rtPayNote` EN/ID key; e2e 134→137 green ×2 fresh-seed + timing
  gate OK; bundle: +42 B uniform shared-chunk class +195 B page-local,
  all seven rows re-adopted IN-PATH A/B.)
- [x] UX: receipt offline resilience — the PWA worker (session 59) caches
  the app shell but a placed-order receipt vanishes when the network
  drops mid-view. Cache the LAST successfully fetched order row per id in
  localStorage (rendered with an honest "cached" banner reusing the
  PortalLoadFailed furniture doctrine), EN/ID + e2e with network-offline
  emulation. (2026-11-26, session 137; success views persist per-id in
  `lib/order-cache` (cap 10, shape+id guards), the page's whole success view
  extracted verbatim into client-capable `ReceiptBody` (ONE source; SSR HTML
  unchanged) with `persist`/`offline` props — the cached restore gates the
  live-API islands OFF, `CachedReceiptFallback` renders banner+savedAt clock
  or the shared `api-offline` card (never the not-found lie; 4xx keeps the
  byte-identical denial card — no-oracle not widened), /account deletion
  clears device copies; 3 Order keys EN/ID; API delta 0 (109/1552); curl
  smoke 5/5 live + 4/4 down + 4/4 4xx on a REAL API kill; persistent-profile
  browser proof 9/9; e2e `zz-receipt-offline` (mid-suite API kill/restart,
  28 assertions incl. ID locale), suite 137->138 green x2 consecutive
  fresh-seed; bundle /orders/[id] +2905 in-path A/B, row re-adopted.)
- [x] Perf: HTTP-cache hit-rate visibility — the session-103 store serves
  200s/304s invisibly: k6 can measure it but the ADMIN dashboard cannot.
  Additive `cache` totals (hits/stores/evictions, 304 revalidations) on
  the global metrics snapshot + a small card row on `/admin` traffic panel
  (never on the OWNER rung — session-85 rule), specs + curl smoke.
  (2026-11-26, session 138; CLOSED-set four counters on the GLOBAL totals
  — third application of the throttled/mail shape rule, restaurant view
  never carries the key; ONE producer per class: middleware branches own
  hits/stores/revalidations via optional `onCacheEvent`, the store's
  `onEvict` owns evictions, `HttpCacheService` wires both — fold line
  inherits with zero extra wiring; `recordCache` no-ops a stray key (no
  NaN-pollution of the pinned shape); disabled TTL=0 counts NOTHING;
  swagger `MetricsCacheTotalsResponse` ADMIN-only; web strip PRESENCE-GATED
  on `totals.cache` (6 Portal keys EN/ID, type-only api.ts additions);
  +12 tests (109/1564) incl. exact ladder + ttl=1 stale arm + cap=1
  eviction ladder; live smoke 15/15 on a 30-migration from-empty DB with
  hand-computed flood arithmetic (502 stores/2 evictions, re-miss 503/3),
  fold grep, second ttl=0 boot zeros, owner key-absence, zero 5xx; e2e
  139/139 green x2 fresh-seed + timing gate OK; bundle uniform +9 B
  in-path A/B, all seven rows pre-funded (CI confirms).)

## Phase 16 — Cache truth, offline depth & write-side sweeps (opened 2026-11-26, Phase 15 exhausted; from the Ops / Perf / UX / Product / Test evergreen loops)

- [x] Ops: cache-saturation ALERT rule — session 138 made hits/stores/
  evictions/revalidations visible but nothing PAGES on them: a store pinned
  at the 500-entry cap (evictions climbing every request) silently degrades
  the zero-SQL promise. Add rule 8 `cache_saturation` to the
  snapshot-derived engine (evictions vs an env floor, warning severity like
  `route_key_overflow`; 0 legal, garbage→default, never crash-boot) riding
  the fold line + `ops/alert-scan.sh` exit codes with ZERO extra wiring,
  `GET /admin/alerts` round-trip pin, unit matrix + live smoke firing the
  rule ALONE (session-123 arms recipe).
  (2026-11-26, session 139; rule 8 reads `totals.cache.evictions` STRICTLY
  above `ALERT_CACHE_EVICTIONS_MAX` (default = MAX_HTTP_CACHE_ENTRIES 500 —
  evictions are pure overflow, a store that fits NEVER evicts);
  snapshot-derived like session 134 so pull + fold + scan inherit with zero
  consumer changes; absent tallies honestly not-evaluated. Live smoke caught
  the one real wiring gap (service config.get() map missing the knob line —
  inert knob under green units) and a NEW drift guard pins all nine ALERT_*
  mappings by sentinel probe; 8 matrix tests + scan ride test
  (109 suites/1574, +10); live smoke 24/24 on a 30-migration from-empty DB
  — tightened-0 arm fires ALONE on exact 503-stores/3-evictions flood
  arithmetic with fold line + scan exit 1, default-500 arm stays quiet on
  the SAME flood, garbage-knob arm falls back without crash; web/e2e delta
  0, swagger ops 78 unchanged.)
- [x] Perf: honest cache hit-RATE — session 138 left the denominator
  uncounted (a derived rate needs an `eligible` counter: whitelisted
  anonymous GETs that ran the handler = the misses the store could have
  served). Add the 5th counter at the capture branch, mirror it in the
  web type + a derived `x of y served from cache` line in the strip, and
  re-pin the exact-arithmetic ladders (unit + integration + live).
  (2026-11-26, session 140; fifth CLOSED counter `eligible` recorded ONCE
  at the middleware capture-branch entry (whatever the handler finally
  answered — 200 capture, stale 304, 4xx passthrough); bearer/POST/HEAD/
  sub-path/ttl=0 count NOTHING, so `stores <= eligible` holds by
  construction and the honest served-from-cache rate is hits/(hits+
  eligible) with fresh-store 304s deliberately outside the ratio (they
  deliver no body). Snapshot + fold line + alert rule 8 inherit the key
  with zero consumer changes; swagger ADMIN model gains `eligible`; web
  `lib/api.ts` gains OPTIONAL `eligible?` (honest absence on a pre-140
  wire) + TrafficPanel a presence-gated `traffic-cache-rate` line "x of y
  served from cache" + 1 Portal EN/ID key. No route/DTO/migration change
  (ops stays 78). 109 suites/1575 tests (+1, every exact ladder RE-PINNED
  not loosened + a new 4xx-passthrough test), live smoke 27/27 on a
  30-migration from-empty DB across TWO boots (boot-1 exact-object jq pin
  per request; boot-2 ttl=2 stale arm eligible 2 + fold-line grep), e2e
  139/139 green ×2 fresh-seed incl. the 5-key wire pin + OWNER-rung
  strip-absent test + timing gate OK; bundle: local A/B measured −2 B but
  the CI gate read uniform +4 (session-132 class) — five rows re-adopted
  to the run's exact numbers, /orders pair absorbed it in headroom.)
- [x] UX: FULLY-offline receipt restore — session 137 covers the API being
  down while the web server answers; the deeper case (browser cannot reach
  the web server at all) today loses the receipt even when the device
  holds a copy: teach the offline app-shell path to surface the
  `lib/order-cache` banner + saved copy for `/orders/<id>` URLs. Playwright
  `context.setOffline(true)` proof, EN/ID, no new server round-trips.
  (2026-11-27, session 141; `OfflineRestoreIsland` on the `/offline` shell
  reads the REAL location (SW serves the shell with the receipt URL in the
  address bar) and restores through the SAME `CachedReceiptFallback` (two new
  OPTIONAL props — server-branch defaults byte-identical) with document-reload
  retry; `sw.js` CACHE v2 + install-time pre-cache of every `/_next/static`
  chunk the shell documents reference (the shell HYDRATES offline);
  restore-miss keeps the generic card (new `offline-shell-card` testid),
  catalog-at-cache-time locale caveat pinned by an online slot re-warm in the
  ID leg; zero message keys, API untouched; e2e 140/140 green x2 fresh-seed
  incl. the new `zz-offline-shell-receipt` spec; bundle `/orders/[id]` row
  adopted to local 163410 then re-adopted to the CI gate's exact 163454.)
- [x] Product: magic-link capability in the PUSH payload url — session 133
  put the `?rt=` token in receipt EMAILS; pushes still land on the bare
  receipt URL and rely on the session surviving the app switch. Attach the
  same minted token to the order-status push payloads (guests have no push
  subscriptions — signed-in only), pin expiry/tier behavior against the
  session-136 money ladder, live smoke on the captured token.
  (2026-11-27, session 142; ONE mint per notification event now feeds both
  channels — push url `/orders/:id?rt=<token>` byte-identical to the email
  link's, fail-open no-secret arm keeps the bare legacy payload, guests +
  `orderPushEnabled=false` never see a token leave the process; new
  `PUSH_JSON_CAPTURE` rig (SMTP twin, zero network, `PUSH_CAPTURED {json}`
  lines, config route stays honest); +6 tests 109/1581 — same-mint,
  order-binding, TTL-1 alive/dead via injected now, 3 rig cases; live
  smoke 35/35 on a 30-migration from-empty DB driving the REAL captured
  push tokens through the live ladder: bearer-less unlock 200, tampered/
  foreign/expired-live-mint all the byte-identical canonical 404,
  `POST /payments?rt=` on the OWNED order stays 404 (session-136 money
  tier untouched), zero-write deltas, zero level-50 log lines; web delta
  0 by construction — the page already rides `?rt=` and the SW keeps
  query strings.)
- [x] Test: write-side property sweep — session 135's constant-outcome
  doctrine applied to `POST /orders`: seeded-mutation sweep over real
  bodies (option-choice sets, promo codes, qty/stock edges, address shape)
  through the real pipe + filter asserting ONLY canonical outcomes
  (201/400/401/403/409 + the exact error-code set), zero 5xx, and
  write-nothing on every denial (row-count deltas vs the seeded baseline).
  (2026-11-27, session 143; `order-create-sweep.http.spec.ts` — real
  controller/service/pipe/filter over live HTTP with a transaction-faithful
  fake (buffered save + stock journal rolled back on throw) so "denial
  wrote nothing" is executable. Canonical set is {201,400,404,409,413}, not
  401/403: the route is guest-allowed with OptionalJwtAuthGuard (junk
  bearer → guest 201) and has no role gate — noted honestly. 18 tests
  including a 240-case deterministic mutation sweep (seed 0x09D5) over
  option sets, promo codes, qty/stock edges, address shapes, raw transport
  bodies (empty/null/non-JSON/prototype/duplicate-key/malformed/oversize),
  driving a real MenuOptionService. TWO live-500-class bugs caught by the real DB
  that the unit mocks passed: (1) a GONE dish answers the canonical 404
  `MenuService.findByIds` count-guard BEFORE the pricing loop (the harness
  initially conflated it with the 400 not-available — corrected faithful);
  (2) a NON-uuid `menuItemId` reached `In([...])` on the uuid PK → pg
  22P02 500 — fixed by an `@IsUUID` pipe rung (400, message pinned). Also
  `ErrorFormatFilter` now maps transport 4xx (raw-body PayloadTooLarge 413)
  to the canonical envelope at the transport status instead of sanitizing
  to a misleading 500. +19 tests 109→110 suites/1581→1600; live smoke
  84/84 on a 30-migration from-empty DB: 3 201s vs 17 denials each
  byte-asserted zero-write on orders/order_items/promo_usages deltas,
  over-stock 409 keeps stock, exact-stock drains to 0, promo ledger +1,
  restaurant-404 envelope byte-identical, malformed JSON→400, oversize→
  413, non-uuid dish→400, zero level-50 log lines.)
- [x] Perf: query-logger + EXPLAIN audit of the ORDER reads — session-79's
  method never ran on `GET /orders/my` (status filter + pagination +
  items-load) or the owner inbox list: prove constant statement shape,
  index-served status/createdAt paths, no N+1 on order items; findings in
  docs/PERFORMANCE.md + contract specs, fix what the logger catches.
  (2026-11-27, session 144; audit verdict: `/orders/my` + driver inbox are
  CONSTANT 3 statements (volume-doubling proves it) with backward
  `IDX_orders_userId_createdAt`/`IDX_orders_restaurantId_createdAt` page
  scans — no N+1, session-32 indexes suffice, composite (userId, status,
  createdAt) deliberately NOT added. The owner inbox answered 14/request: the gate ran
  the full restaurant DETAIL read (6) because `getOwnedRestaurant` called
  the public findOne, and SIX per-status repo counts each emitted
  `COUNT(DISTINCT) LEFT JOIN order_items` (eager `Order.items` rides plain
  counts — 287 buffers + a full order_items seq scan EACH). Fixes, all
  response bytes proven IDENTICAL old-dist vs new-dist on the same
  inflated DB: new `RestaurantsService.findOrderScope` one-projection read
  for the gate + create pricing (create 16→12); `findForRestaurant` 14→4
  via one index-only `GROUP BY status` (8 buffers, 0 heap fetches) serving
  BOTH zero-filled counts AND total; `findMine`/`findForDriver` split
  findAndCount into find + join-free `COUNT(1)` QB (count 8,073→188
  buffers measured). Perf contracts executable: fake repos LOUDLY reject
  findAndCount/count on the audited methods; findOrderScope pinned to one
  projection read, zero embeds. 110 suites/1602 tests (+2), live A/B smoke
  byte-identical envelopes + e01 empty-page shape 2, findings + EXPLAIN
  tables in docs/PERFORMANCE.md, e2e delta 0 expected (API-only, contract
  byte-pinned).)

## Phase 17 — Status-write truth, eager audit & owner digests (opened 2026-11-27, Phase 16 exhausted; from the Test / Perf / Product / UX evergreen loops)

- [ ] Test: write-side constant-outcome sweep on the STATUS transitions —
  session 143's template (`order-create-sweep.http.spec.ts`) applied to
  the four PATCH status routes (owner portal, admin, customer cancel,
  driver): canonical outcome set {200, 400, 402, 404, 409} with the
  payment-confirm gate ON, zero-write deltas + `order_status_audits`
  invariants on every denial, illegal-flow edges never half-writing
  timestamps.
- [ ] Perf: eager-relation inventory — session 144 proved `Order.items`
  `eager: true` rides a `LEFT JOIN order_items` into EVERY plain repo
  find/count (counts now route through QueryBuilders). Inventory the
  remaining sites (receipt `findOneForViewer`, admin lists, restock
  paths), decide per site: keep (response embeds items anyway) or flip to
  explicit relations, byte-pinned A/B for every swap; record the verdict
  in docs/PERFORMANCE.md.
- [ ] Product: owner daily digest email — yesterday's orders, revenue
  (cents), and top dishes per owned restaurant through the existing
  `MailService` + an `ops/` cron runner (stale-sweep pattern);
  `SMTP_JSON_CAPTURE=1` live smoke (sessions 122/134 rig) asserting
  EXACT one-mail-per-owner-per-day, zero-mail-for-no-orders, and the
  fail-arm tally.
- [ ] UX: order-history date-range filter — `from`/`to` query params on
  `GET /orders/my` (query-surface-audit REGISTRY entry mandatory per the
  session-87 rule; closed-range validation, clamped bounds) + web
  quick-pick chips EN/ID + e2e; history stays index-served (same
  (userId, createdAt) scan the audit measured).
- [ ] Product: "buy again" — history + receipt action that revalidates the
  saved cart lines server-side against the CURRENT menu (gone dishes,
  price deltas, option choices still legal, stock) and folds into the
  web cart; API helper + toast copy EN/ID + e2e.
- [ ] Test: query-logger audit of the REMAINING list surfaces — admin
  orders list, favorites, reviews feed, owner menu list (session-79/144
  method: bracketed windows on an inflated scratch DB, constant-shape
  proofs, EXPLAIN for index paths, contract specs for whatever the
  logger catches).

## Completed
- 2026-10-17 — Phase 0: monorepo scaffold, NestJS API (auth, restaurants, menu, orders, status machine, health), Next.js storefront (browse, detail, cart, checkout, order page), docker compose + Dockerfiles, seed data, jest unit tests, CI-ready scripts.
