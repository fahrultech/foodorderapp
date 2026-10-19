# DEVLOG

Newest entries on top. Format: `YYYY-MM-DD HH:MM — slot — summary`.

---

## 2026-10-19 09:31 — Session 5

**Built:** Phase 1 item 4 — auth refresh tokens + `PATCH /users/me` profile update:
- New table `refresh_tokens` via migration `AddRefreshTokens1792374097450`
  (`id` uuid pk, `tokenHash` varchar(64) **unique**, `userId` uuid FK → users
  `ON DELETE CASCADE` + index, `expiresAt`/`revokedAt` timestamptz, `createdAt`),
  registered in `data-source.ts` (now 6 entities) and `AuthModule`.
- **Refresh tokens are opaque, not JWTs**: `randomBytes(32)` base64url handed to
  the client, only its **SHA-256 digest** persisted. That buys exact revocation
  (one row per session), a DB dump that is not a session store, and rotation —
  `POST /api/auth/refresh` revokes the presented row and issues a new pair, so a
  token is usable exactly once. Presenting an already-revoked token is treated
  as theft: **every session of that user is swept** and the call 401s.
- Access tokens: `JWT_ACCESS_TTL` (default `30m`, was a 7d module-wide default)
  and a `typ: 'access'` claim. `JwtAuthGuard` now rejects any token whose `typ`
  is not `access`, so refresh tokens and pre-Phase-1 tokens cannot open routes.
- New endpoints: `POST /api/auth/refresh` (200, unauthenticated — the token *is*
  the credential), `POST /api/auth/logout` (200, Bearer; one session via
  `refresh_token`, all sessions via `all: true` or empty body; scoped by `userId`
  so one caller cannot revoke another's session; idempotent),
  `PATCH /api/users/me` (200/400/401/404).
- `GET /api/auth/me` now reads the **database** and returns an allowlisted
  `SafeUser` (`id/email/name/phone/address/role/createdAt/updatedAt`) instead of
  echoing stale JWT claims — profile edits show up immediately, deleted accounts
  stop answering, and `passwordHash` can never ride along again.
- `PATCH /api/users/me` + `UpdateProfileDto`: allowlist `name`/`phone`/`address`
  only (`email` = identity, `role` = authorization, password needs old-password
  verification — none are self-writable); empty patch → **400** rather than a
  silent no-op "success"; missing row → 404; `UsersModule` gained
  `UsersController` and imports `AuthModule` for the guard's `JwtService`.
- New helpers: `common/duration.ts` (`durationToMs`/`expiryFrom`, fails loudly on
  a malformed TTL instead of minting an endless session), `common/safe-user.ts`
  (explicit allowlist, not spread-and-delete), `common/tokens.ts` (shared `typ`
  + TTL defaults, kept out of `auth/` so the guard doesn't import repositories).
- Tests (jest, 115 passing): `auth.service.spec.ts` rewritten as a full-path
  coverage suite — register (duplicate rejected before hashing, pair issued,
  only the digest stored, distinct token per session), login (unknown email,
  wrong password with identical message, claim set + default TTL, env TTL
  overrides, malformed TTL), refresh (rotation, replay sweep including sibling
  sessions, unknown/empty/expired token, deleted account, role carried over),
  logout (single session, foreign token no-op, `all:true`, empty body, `all`
  beats a single token, idempotent, revoked token can no longer refresh), `me`
  (DB-backed shape, gone account, missing subject); `jwt-auth.guard.spec.ts`
  uses a **real** `JwtService` (valid, missing/non-Bearer header, wrong secret,
  expired, no `typ`, wrong `typ`, no half-populated `req.user`);
  `auth.dto.spec.ts` + `update-profile.dto.spec.ts` drive the app's actual
  `ValidationPipe` (whitelist stripping of `role`/`email`/`id`/`passwordHash`);
  `users.service.spec.ts` covers the allowlist/400/404 paths; `duration.spec.ts`
  the TTL parser; `data-source.spec.ts` updated to 6 entities.
- Docs/config: `seed.ts` truncates `refresh_tokens`; `.env.example` +
  docker-compose expose `JWT_ACCESS_TTL`/`JWT_REFRESH_TTL`; README endpoint table
  completed (it was also missing the Phase 1 owner routes); ARCHITECTURE gained
  an **Auth (Phase 1)** section with the token model and its rationale.

**Verified:**
- `nest build` clean; `npx jest` **115/115** across 11 suites.
- Migration: generated DDL reviewed line by line against the entity (unique
  index on `tokenHash`, index on `userId`, FK `ON DELETE CASCADE`, `timestamptz`
  expiries); `migration:run` applied it to the dev DB (1 new → executed, 3
  migrations recorded).
- Live API smoke on `:4000` (`node dist/main.js`, 44 assertions, all pass):
  register → access + opaque refresh with `expires_in: 1800`; duplicate → 409;
  `GET /auth/me` 200 / 401 without token / 401 with a tampered token; refresh
  token as Bearer → 401; rotation → new pair, old row revoked; replay of the
  rotated token → `reuse detected — 1 session(s) revoked` and the sibling
  session dies; login → `PATCH /users/me` persisted name/phone/address and
  `/auth/me` reflected it immediately; empty patch → 400 `No profile fields to
  update`; injected `role`/`email` stripped (still `customer`/original email);
  `/users/me` without a token → 401; `logout {all:true}` → `revoked_sessions: 1`
  then that refresh token → 401 and a second logout → `revoked_sessions: 0`;
  regressions: seeded owner login, `GET /restaurants/mine` (still 200 with rows),
  `/health` db up.
- Database truth via `psql` (URL read from the untracked `apps/api/.env`, never
  echoed): 0 live sessions for the smoke user after logout-all, and every
  stored `tokenHash` is a 64-char hex digest with the raw token absent.
- TTL override smoke on `:4001` (`JWT_ACCESS_TTL=1s JWT_REFRESH_TTL=10m`, 9/9):
  `typ=access`, `exp-iat = 1s`, `expires_in = 1`, refresh expiry ≈ +600 s,
  `/auth/me` 200 while fresh → **401 `Invalid or expired token`** after 2.5 s,
  while `POST /auth/refresh` still mints a working session and the consumed
  token is single-use (401). That is the real renewal path the storefront will
  use, exercised against a genuinely expired token.
- `apps/web` untouched → `next build` skipped per WORKFLOW; grep confirms the
  storefront has no stored tokens or `/auth/me` consumer yet, so the response
  shape change (`sub` → `id`) breaks nothing that exists.

**Breaking change (intentional):** access tokens minted before this session
(7-day, no `typ` claim) are now rejected by `JwtAuthGuard` — clients log in once
and then renew via `POST /api/auth/refresh`. No storefront session existed, so
nothing user-facing regressed.

**Left for next sessions:** password change + email change (need
old-password verify / email verification), then Phase 1 item 6 (web login &
register pages, which will store the refresh token and renew on 401);
docker compose end-to-end still unverified (carried since session 1).

## 2026-10-17 20:10 — Session 4

**Built:** Phase 1 item 3 — menu item CRUD for owners (commit `feat(api): …`):
- New owner endpoints: `POST /api/restaurants/:restaurantId/menu` (201, dish
  stamped with the URL's restaurant), `PATCH /api/menu/items/:id` (content
  only), `PATCH /api/menu/items/:id/availability` (first-class toggle),
  `DELETE /api/menu/items/:id`. All `JwtAuthGuard` + `RolesGuard`
  `@Roles(OWNER)`; authorization to the dish's **parent restaurant** is
  checked in `MenuService.assertCanManage` (ADMIN bypasses; platform
  restaurants with `ownerId null` are admin-only). Menu items carry no owner
  column — ownership always derived, so it can never drift from the resto.
- DTOs (`menu/dto/menu-item.dto.ts`), every property decorated for the
  whitelist pipe: `CreateMenuItemDto` requires name (`IsNotEmpty` +
  `Matches(/\S/)` — plain IsNotEmpty would let `"   "` through) and
  `priceCents` (`IsInt Min(1) Max(10000000)` — cents stay integers, strings
  rejected); optional description/category/imageUrl/prepMinutes/isAvailable
  (draft dishes). `restaurantId`/`id` are never body-writable.
  `UpdateMenuItemDto` deliberately omits `isAvailable` (toggle route owns it);
  `UpdateAvailabilityDto` is a single required boolean.
- `MenuModule` now imports `AuthModule` + registers the `Restaurant` repo —
  the session-3 DI-crash class avoided by construction. No migration needed:
  `menu_items` schema unchanged.
- **Fix found by smoke:** malformed uuid route params (`PATCH
  /menu/items/nonexistent`) crashed TypeORM with Postgres 22P02 → opaque 500.
  New `common/uuid.ts isUuid` guard applied to `MenuService` (dish ids +
  parent id) and — same latent bug — `RestaurantsService.updateOwned` /
  `findOne` (also fixes `GET /api/restaurants/:id` and the session-3 PATCH
  route). Malformed ids now 404 before touching the DB.

**Verified:**
- `nest build` clean; `jest` **58/58** pass (6 suites; 32 new: 19
  `menu.service.spec` authorization/default/patch/guard cases, 12
  `menu-item.dto.spec` running the **real global ValidationPipe** (same
  options as main.ts) to prove stripping + rejections, 1 restaurants
  malformed-uuid case).
- Live API smoke (new build on :4000, reseeded dev DB) — **38 checks, all
  pass**: owner create 201 (defaults honored; injected `restaurantId`/`id`/
  `ownerId` stripped, URL restaurant wins, draft flag kept); customer 403,
  anonymous 401, other-owner/platform resto 403; 4× 400 validation
  (missing/zero/string price, blank name); PATCH own price 200 while body
  `isAvailable`+`restaurantId` ignored; PATCH/DELETE on platform dish 403;
  **toggle gate proven end-to-end**: unavailable → guest order 400 "not
  available", toggle back → 201; **DELETE of an ORDERED dish** → order still
  readable (`menuItemId` NULL via ON DELETE SET NULL, snapshot name + 26000
  unit price intact); admin (SQL-promoted, re-login) toggles + creates
  platform dishes, role reverted; regressions green — public list/menu,
  malformed-uuid GET → 404, guest order server-priced (FO-87GY, 1400 cents).
- Dev DB restored to canonical seed afterwards; API stopped.

**Note:** `GET /restaurants/:id/menu` still returns unavailable dishes —
storefront filtering / "sold out" UI is portal-era work (Phase 2 item 3 will
need it). Same for order-line `menuItemId` back-references after a delete.

**Next:** Phase 1 item 4 — auth refresh tokens + `PATCH /users/me` with full
jest coverage of auth paths.

## 2026-10-17 17:10 — Session 3

**Built:** Phase 1 item 2 — owner role on restaurants + owner CRUD (commit `feat(api): …`):
- `restaurants.ownerId` (uuid, nullable — platform-seeded rows keep `null`),
  `@ManyToOne User` with **ON DELETE SET NULL**, index `IDX_restaurants_ownerId`;
  migration `AddRestaurantOwner` (`1792227879651`) generated via the new
  migration workflow (first real entity change → generate → apply cycle).
- `RolesGuard` + `@Roles(...)` decorator (`src/common/`): reads the `role`
  claim from the JWT payload attached by `JwtAuthGuard`; ADMIN bypasses;
  empty metadata = open. Known caveat: role changes only take effect on a
  fresh login (token carries the claim).
- Owner endpoints on `RestaurantsController`: `POST /api/restaurants`
  (create own; ownerId always taken from token — body `ownerId` is stripped
  by the global whitelist pipe), `GET /api/restaurants/mine`,
  `PATCH /api/restaurants/:id` (owner-or-admin; 403 otherwise). DTOs
  `CreateRestaurantDto` / `UpdateRestaurantDto` with full class-validator
  coverage; `slug`, `rating`, `ownerId` are not owner-writable — slug is
  slugified from the name (or explicit kebab-case one) and de-duplicated
  with `-2`, `-3`… suffixes.
- Seed now creates users before restaurants and assigns the demo owner
  (`owner@foodorder.app`, real `UserRole.OWNER` — old `as any` hack dropped)
  to Warung Nusantara + Seoul Street, so `/restaurants/mine` is non-empty.
- New unit specs: `restaurants.service.spec.ts` (11 tests: slugify/dedupe/
  empty-name fallback, create defaults+ownerId stamping, findOwned filter,
  update owner/other-owner/admin/404/DTO-whitelist cases) and
  `roles.guard.spec.ts` (5 tests). Fixed during verification:
  `RestaurantsModule` was missing the `AuthModule` import → Nest DI crash on
  boot (`JwtAuthGuard` couldn't resolve `JwtService`) — same class of bug as
  session 1's OrdersModule fix.

**Verified:**
- `nest build` clean; `jest` **26/26** pass (4 suites).
- `migration:run` on dev DB applied AddRestaurantOwner cleanly (column +
  index + FK SET NULL); `npm run seed` rebuilt data with ownership rows.
- API restarted on :4000; curl smoke on the live server: owner login token
  carries `role:"owner"` · `GET /restaurants/mine` → 2 owned ·
  `POST` create → 201 with slug `bebek-goreng-pak-togok-88`, `ownerId` =
  token subject (injected `"ownerId":"ATTACKER"`, `rating`, `slug` stripped
  by whitelist) · duplicate name → `-2` slug · `PATCH` own → 200
  (isOpen/name change, rating/slug/ownerId immutable) · `PATCH` unowned →
  403 · admin (role promoted via SQL, re-login) → 200, then reverted ·
  customer `POST` → 403 · no token → 401 · bad slug pattern / negative
  fee → 400 · public list + guest order regression green
  (server-priced 2×1800 + fee 300 = total 3900, code FO-8RK4).
- Dev DB re-seeded to canonical state after smoke writes.

**Docs:** ARCHITECTURE data model + roles paragraph, ROADMAP item ticked.

**Left for next sessions:** menu-item CRUD for owners (Phase 1 item 3 —
reuses `RolesGuard` + the ownership check pattern); docker compose e2e
still pending from session 1.

## 2026-10-17 13:15 — Session 2

**Built:** Phase 1 item 1 — schema ownership moved from TypeORM
`synchronize: true` to **migrations**.

- `src/database/data-source.ts`: single shared DataSource config (entities,
  migration glob for ts+js, `synchronize: false`, `migrationsRun: true`,
  dotenv-loaded `DATABASE_URL`). Used by the typeorm CLI; Nest's
  `TypeOrmModule` got the same options (`app.module.ts`).
- Baseline migration `1792213437047-InitSchema` generated from the entities
  against an empty DB, plus an explicit `CREATE EXTENSION IF NOT EXISTS
  "uuid-ossp"` (fresh images lack it in template1 — no reliance on driver magic).
- CLI scripts in package.json: `migration:generate|run|revert`; `seed.ts` now
  uses the shared AppDataSource, so `npm run seed` bootstraps a brand-new DB
  (migrate + seed) with no manual steps.
- `db:stamp-baseline` script: records the baseline in existing
  synchronize-built databases (creates the `migrations` table if absent) so
  they can be adopted without re-running DDL.
- New jest spec `data-source.spec.ts`: synchronize off, 5 entities + glob,
  single-DataSource CLI contract, baseline implements up/down.

**Verified:**
- `nest build` clean; `jest` 8/8 pass (both suites).
- Fresh-DB pipeline: `migration:run` on an empty `template1`-derived DB →
  all 5 tables + enum types + `uuid-ossp` created; rerun → "No migrations
  are pending"; `migration:revert` → tables gone.
- Baseline == old schema: `pg_dump --schema-only` of the migrated+seeded DB
  vs the live synchronize-built DB — **199/199 content lines identical**
  (5 tables, 5 FKs, 3 unique, 5 PKs, 2 enums, uuid defaults; only delta is
  the `migrations` bookkeeping table, which the old DB lacked).
- Cutover of dev DB `foodorder`: schema dropped → `npm run seed` rebuilt it
  from migrations (6 restos, 27 dishes, 1 applied migration) → new API build
  booted (0 pending) → curl smoke: `/health` db up, search, guest order
  create server-priced (2×500 → subtotal 1000, +fee 300 = 1300),
  pending→confirmed OK (200), confirmed→delivering rejected (400),
  confirmed→preparing OK, login + `/auth/me` (JWT).
- Stamp path: simulated a pre-migration DB (dropped `migrations` table on a
  migrated DB) → `db:stamp-baseline` recorded it → `migration:run` reports
  nothing pending. Fixed a real bug found during testing (untyped params in
  the stamp INSERT, pg error 42P08).
- Note: smoke initially "failed" because the test script sent `status` in the
  body while `PATCH /orders/:id/status` takes it as a query param (pre-existing
  API shape, unchanged) and login returns `access_token` — not regressions.

**Docs:** WORKFLOW schema rules, ARCHITECTURE synchronize bullet, ROADMAP
item ticked. Scratch verification databases dropped after use.

**Left for next sessions:** docker compose end-to-end (images still unverified);
next roadmap item — owner role + restaurants CRUD.

## 2026-10-17 11:30 — Session 1 (kickoff)

**Built:** Phase 0 foundation in one push set:
- Monorepo layout `apps/api` + `apps/web`, root docker-compose (postgres16/api/web), Dockerfiles for both apps (Next standalone, Nest compiled).
- NestJS API: TypeORM+Postgres (entities: User, Restaurant, MenuItem, Order, OrderItem), JWT auth (register/login/me), restaurants list with search/cuisine/city/sort/pagination, menu endpoints, order create with server-side pricing, min-order check, status state-machine, guest + authenticated orders, `/health` DB probe, seed script (6 restaurants, ~28 dishes, 2 demo users).
- Next.js 15 storefront: homepage (search + cuisine chips), restaurant detail with categorized menu, localStorage cart (single-restaurant rule, qty steppers), checkout form posting to API, order confirmation page with status labels.
- jest unit tests for AuthService (duplicate email, token issue, password compare).
- docs/: WORKFLOW (session routine), ROADMAP (evergreen backlog, Phases 1–5), DEVLOG, ARCHITECTURE.

**Verified:** npm installs green; `nest build` + `jest` (4 tests pass); seed script
run against Postgres 16 (6 restaurants, 27 menu items, 2 users); live curl smoke
test: health, restaurant list/search, menu, order create (server-priced, code
FO-xxxx), status machine (pending→confirmed OK; illegal transition → 400),
quantity bounds → 400, guest + JWT (`/auth/login`, `/auth/me`, `/orders/my`).
`next build` green; SSR home renders all 6 restaurants from the live API;
detail/cart/checkout routes HTTP 200.

**Bugs fixed during verification:** OrdersModule missing AuthModule import
(JwtService DI crash); `quantity` DTO property stripped by whitelist (added
IsInt/Min/Max); seed used `delete({})` (now TRUNCATE CASCADE); checkout page
TS narrowing.

**Left for next sessions:** `docker compose up --build` end-to-end test (docker
installed but images unverified); Playwright e2e; anything in Phase 1+.
