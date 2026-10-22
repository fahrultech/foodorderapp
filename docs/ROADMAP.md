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
- [ ] Order tracking timeline UI (status steps with timestamps on order entity)
- [ ] Reviews: customers rate completed orders; restaurant rating recomputed server-side
- [ ] Promo codes & discount engine (server-side validation, order integration)
- [ ] Delivery addresses book (multiple saved addresses, pick at checkout)

## Phase 4 — Ops & quality
- [ ] GitHub Actions CI: build + test both apps per push
- [ ] GitHub Actions CD workflow stub (build images, push to registry)
- [ ] API: structured logging (pino) + request-id middleware
- [ ] API: rate limiting on auth + order endpoints
- [ ] Swagger/OpenAPI docs auto-generated at `/api/docs`
- [ ] E2E smoke suite (Playwright: browse → cart → checkout → order page)
- [ ] DB indexes migration (slug, restaurantId, status, createdAt) + EXPLAIN check
- [ ] Backups: pg_dump scheduled script + restore doc

## Phase 5 — Scale-out ideas (seed list, expand freely)
- [ ] Realtime order feed with WebSocket gateway (Socket.IO)
- [ ] Payment abstraction (mock gateway → Stripe/Xendit adapters behind one interface)
- [ ] Notifications: email confirmations (nodemailer) then push (web-push)
- [ ] Multi-city rollout config (cities as entities, restaurant scoping by city)
- [ ] i18n: English + Indonesian locale on storefront (next-intl)
- [ ] Dark mode
- [ ] Admin panel (users, restaurants, orders oversight)
- [ ] Analytics dashboard for owners (revenue, peak hours — SQL aggregates)
- [ ] Image upload for menu items (S3-compatible, presigned PUT)
- [ ] Kitchen display system view (tablet-friendly prep board)
- [ ] Driver/courier role + assignment flow
- [ ] Scheduled cron: auto-cancel stale pending orders
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
