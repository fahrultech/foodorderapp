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

## Phase 4 — Ops & quality
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

## Phase 5 — Scale-out ideas (seed list, expand freely)
- [x] Realtime order feed with WebSocket gateway (Socket.IO) (2026-10-27, session 36; `RealtimeGateway` on /orders namespace, JWT handshake auth, restaurant+user rooms off the shared SSE bus; 9-case socket integration spec + live smoke. Follow-up below: web-side consumer)
- [x] Web: dashboard/order-tracking consume the WS feed (SSE stays the fallback) (2026-10-27, session 37; `useOrderFeed` hook + transport ladder WS→SSE→poll, tracking page got its first live path; stale-debounce-closure bug found+fixed; 3 new e2e specs incl. WS-sabotage SSE-fallback test, suite 7/7 green x2)
- [ ] Payment abstraction (mock gateway → Stripe/Xendit adapters behind one interface)
  - [x] API core: `PaymentGateway` interface + `MockPaymentGateway` behind DI (PAYMENT_PROVIDER, boot fail-fast) + `payments` entity/migration + `POST /payments`, `POST /payments/:id/capture`, `GET /orders/:orderId/payments` + `payments` rate bucket + 46 new specs; live smokes incl. fail-mode and cancelled-order branches (2026-10-27, session 38)
  - [ ] Stripe adapter implementing `PaymentGateway` (+ webhook verification endpoint, clientSecret-driven confirm) — needs API keys; keep mock as CI/dev default
  - [ ] Xendit adapter (same interface + registry entry)
  - [ ] Refund flow: `refunded` status + gateway `refundIntent` + ADMIN route + partial amounts
  - [ ] Order-machine gate: owner confirm requires a succeeded payment (behind a feature flag; e2e fixtures need paying steps first)
  - [ ] Web: pay button on `/checkout` + `/orders/[id]` (consume intent/capture endpoints; receipt shows payment status)
- [ ] Notifications: email confirmations (nodemailer) then push (web-push)
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

## Completed
- 2026-10-17 — Phase 0: monorepo scaffold, NestJS API (auth, restaurants, menu, orders, status machine, health), Next.js storefront (browse, detail, cart, checkout, order page), docker compose + Dockerfiles, seed data, jest unit tests, CI-ready scripts.
