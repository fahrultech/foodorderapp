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
  - [ ] Stripe adapter implementing `PaymentGateway` (+ webhook verification endpoint, clientSecret-driven confirm) — needs API keys; keep mock as CI/dev default
  - [ ] Xendit adapter (same interface + registry entry)
  - [x] Refund flow: `refunded` status + gateway `refundIntent` + ADMIN route + partial amounts — API: `PaymentRefundGateway` optional add-on + `supportsRefunds()` probe (mock implements it, independent `MOCK_REFUND_GATEWAY_MODE=fail` knob) + `refundedCents`/`refundedAt` + `refunded` status (migration w/ CHECK) + `POST /payments/:id/refund` ADMIN route w/ CAS on `refundedCents` (partial accumulates, full → terminal; capture refuses refunded rows; repay-after-refund opens a NEW attempt) + 36 new tests (524→560) + live smoke 28/28 incl. declined-refund branch (2026-10-28, session 39)
    - [x] Refund audit trail: per-refund rows (provider refund refs + amounts + acting admin) instead of a single accumulated `refundedCents` — `payment_refunds` append-only ledger (migration + CHECK + composite index; `refundedAfterCents` running balance; acting admin id FK SET NULL + JWT email snapshot) written in the SAME transaction as the CAS balance update + `GET /payments/:id/refunds` ADMIN route + mock refs made collision-free (`mock_re_<pid>_<remaining>_<cents>` — equal partials now get distinct provider ids) + 13 new specs (560→573) + live smoke 35/35 incl. equal-partial and DB constraint probes (2026-10-28, session 40)
  - [x] Order-machine gate: owner confirm requires a succeeded payment (API flag + spec/live-smoke 2026-10-28 session 42; enable-by-default decision shipped 2026-10-29 session 44 — see sub-items)
    - [x] API: `ORDER_CONFIRM_REQUIRES_PAYMENT` flag (default off, fail-open) gating EVERY path into `confirmed` (owner portal `setStatusForRestaurant` + ADMIN `updateStatus`) on a `succeeded` payments row → 402 `PAYMENT_REQUIRED`; existence probe on the `payments` repo (no cross-module service coupling, no status write from the payment side); 22 new specs (576→598) + live smoke 12/12 with flag ON (gated confirm, pay+capture→confirm, admin-backdoor gated, cancel/flow untouched) + flag-OFF regression 200 unpaid (2026-10-28, session 42)
    - [x] Enable-by-default decision: `ORDER_CONFIRM_REQUIRES_PAYMENT` flipped to default-ON — unset/garbage keeps the gate on, only the explicit opt-out `0/false/no/off` takes it out (inverted failure mode: a typo'd opt-out must not silently disable a money-integrity gate); live-feed e2e fixture now pays (intent→capture) before the owner confirm so the suite exercises the shipped default (CI included); gate spec re-pinned (598→604) + live smoke 19/19 default-on & 6/6 opt-out + full e2e 9/9 green x2 on fresh seed (2026-10-29, session 44)
  - [x] Web: pay button on `/checkout` + `/orders/[id]` (consume intent/capture endpoints; receipt shows payment status) (2026-10-29, session 43; `PaymentPanel` + `PayButton` on the receipt page — intent→capture ladder, paid state server-derived via `GET /orders/:id/payments`, `?pay=1` checkout handoff for signed-in, sign-in hint for guests; e2e `pay-order.spec.ts` 2 tests, suite 9/9 green x2)
- [ ] Notifications: email confirmations (nodemailer) then push (web-push)
  - [x] Email: `MailService` (nodemailer, SMTP_HOST-gated) + `OrderNotificationsService` (order-placed + status-step emails for authenticated users; guest orders silently skip — no contactEmail on Order entity yet) + 20 specs (2026-10-29, session 45)
  - [x] Push API foundation: `PushService` (VAPID-gated web-push adapter), multi-device `push_subscriptions` table, JWT-scoped subscribe/unsubscribe routes, stale-endpoint cleanup, and order-created/status fan-out from the shared event bus (2026-10-31, session 48)
  - [ ] Web: service worker + signed-in notification opt-in/out control (permission only after user gesture)
- [ ] Multi-city rollout config (cities as entities, restaurant scoping by city)
- [ ] i18n: English + Indonesian locale on storefront (next-intl)
- [ ] Dark mode
- [ ] Admin panel (users, restaurants, orders oversight)
- [ ] Analytics dashboard for owners (revenue, peak hours — SQL aggregates)
- [ ] Image upload for menu items (S3-compatible, presigned PUT)
- [ ] Kitchen display system view (tablet-friendly prep board)
- [ ] Driver/courier role + assignment flow
- [x] Scheduled cron: auto-cancel stale pending orders (2026-10-27, session 35; shared `stale-order-sweep` + ADMIN HTTP route + `ops/cancel-stale.sh` systemd/cron runner, STALE_ORDER_MINUTES/BATCH env, DRY_RUN; 469 tests green + live smoke)
- [ ] PWA: installable storefront + offline cart
- [ ] A/B-friendly feature flags table + helper
- [ ] Load testing script (k6) + tuning report in docs/
- [ ] SEO: metadata per restaurant page, sitemap.xml, robots.txt
- [ ] GDPR-ish data export & account deletion endpoints
- [ ] Audit log table for status changes
- [ ] Menu item options/variants (size, spice level, extras) — cart line options
- [ ] Coupons expiry + usage caps
- [ ] Restaurant open hours (day-of-week schedule entity) + auto isOpen
- [ ] Search: fuzzy name/description match with pg_trgm
- [ ] Map view of restaurants (Leaflet)
- [ ] Unit-of-work: wrap order create in a transaction + stock guard
- [ ] CI matrix: postgres 15/16 compatibility

## Phase 6 — Hardening & polish (opened 2026-10-28, Phase 4 closed; from the Ops/UX evergreen loops)
- [x] API: boot-time config validation (env.schema via class-validator; fail fast on missing JWT_SECRET/DATABASE_URL instead of silent dev fallbacks) (2026-10-29, session 46)
- [x] API: supertest-based integration specs for the payments + refunds routes (today covered by service-unit specs + live smoke only) (2026-10-30, session 47; 19-case HTTP spec for RestaurantOrdersController incl. the 402 payment-gate envelope)
- [ ] API: `GET /orders/:id` ownership fix — guests must prove contact-email match, not just know the uuid (id enumeration risk)
- [ ] Web: storefront empty/loading/error states audit (no-results search, dead restaurant links, offline API banner)
- [ ] Web: accessibility pass on checkout + dashboard (labels, focus order, aria-live on order status)
- [ ] Perf: N+1 sweep on `/restaurants` list (menuItemCount subqueries) + verify with query logger + EXPLAIN

## Completed
- 2026-10-17 — Phase 0: monorepo scaffold, NestJS API (auth, restaurants, menu, orders, status machine, health), Next.js storefront (browse, detail, cart, checkout, order page), docker compose + Dockerfiles, seed data, jest unit tests, CI-ready scripts.
