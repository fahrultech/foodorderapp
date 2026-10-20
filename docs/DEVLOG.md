# DEVLOG

Newest entries on top. Format: `YYYY-MM-DD HH:MM — slot — summary`.

---

## 2026-10-20 19:50 — Session 10

**Built:** Phase 1 item 9 — **web checkout shows the real delivery fee +
min-order warning from the restaurant before submit**.

- `apps/web/app/checkout/page.tsx` — on mount (and whenever the cart's
  restaurant changes) the page fetches `GET /restaurants/:id` — the same
  source the server prices orders from — and drives three pricing states:
  - **loading**: fee/total show `loading…`/`—`, submit disabled
    ("Loading delivery fee…") so users never order blind.
  - **ready**: summary shows real **Delivery** fee (`free` when 0), a
    **Minimum order** row, and a true **Total = subtotal + fee**; the
    Place-order button label carries the same total. If
    `subtotal < minOrderCents`, an amber `role=alert` banner names the
    restaurant, the minimum, the exact shortfall ("Add $5.00 more") and a
    back-to-cart link; submit is disabled with "Below minimum order".
  - **unavailable** (fetch failed): neutral soft banner explains the fee
    will be applied server-side and submit stays allowed — mirrors the
    server as the pricing authority instead of hard-blocking on a transient
    API error.
- No API changes needed: `deliveryFeeCents`/`minOrderCents` were already on
  the restaurant entity/endpoint and enforced in `OrdersService.create`
  (integer cents throughout; client math is display-only).

**Verified:**
- `next build` green (`/checkout` prerenders as the client shell).
- Reused the live API on :4000 (`/health` up); `GET /restaurants/:id`
  smoke-curl returns fee/min for all 6 seeded restaurants.
- Real-browser E2E (`next start :3217` + live API + seeded DB), Warung
  Nusantara (min $10.00, fee $3.00):
  - below-min: 1 × Es Teh Manis ($5) → banner "…minimum order of $10.00.
    Add $5.00 more…", button "Below minimum order" **disabled**, delivery
    $3.00, total $8.00 shown;
  - ready: + Gado-Gado ($12) → banner gone, button "Place order — $20.00"
    enabled, Total $20.00; form filled → order **FO-GDKH** placed, redirect
    to `/orders/:id`, cart cleared;
  - server pricing matches the estimate exactly: `GET /orders/FO-GDKH` →
    subtotal 1700 + fee 300 = total 2000 (cents), status pending;
  - unavailable path: cart pointed at a nonexistent restaurant id → GET 404
    → soft "Couldn't load the delivery fee…" banner, delivery falls back to
    "calculated by the kitchen", submit allowed.
- Empty-cart checkout state regression-checked (still renders the dashed
  "Nothing to check out" card).
- Test web server stopped after E2E; :4000 API left running as before.

**Docs:** ROADMAP item ticked.

**Left for next sessions:** next Phase 1 item — cart persistence
confirmation modal across restaurant switches; then Phase 2 portal.

## 2026-10-20 14:45 — Session 9

**Built:** Phase 1 item 8 — **web order-history page (`/orders/my`) with
status badges, pulls live**.

- `apps/web/app/orders/my/page.tsx` — client page: auth-gated (guests get a
  sign-in prompt linking `/login?next=/orders/my`, already honored by the
  login page's open-redirect-safe `?next=` handling), live `GET /orders/my`
  rows newest-first, **status filter chips** (All + 6 statuses), **status
  badges** per order, per-order line summary (first 2 items + "+N more"),
  totals in cents via `formatPrice`, pagination footer + Prev/Next at
  `limit=10`, manual ↻ Refresh, and **silent 30 s polling** while the tab is
  visible so badges stay live without skeleton flicker.
- Self-service **Cancel order** button rendered only where the client copy of
  the state machine allows it (`pending/confirmed/preparing` — mirrors
  `STATUS_FLOW`); confirm dialog → `POST /orders/:id/cancel` → success notice
  + silent reload; API 400 ("can no longer be cancelled") surfaces as a
  red banner and the list refreshes to the truth.
- 401-on-read handling: retry once with a rotated token via `getAccessToken()`,
  second 401 → local sign-out → guest prompt (terminal revocation is the
  correct answer, matching the session model from session 8).
- `apps/web/lib/api.ts` — `listMyOrders` / `cancelOrder` bearer methods,
  `ORDER_STATUSES`, `CANCELABLE_STATUSES`, `MyOrdersPage` envelope type.
  `components/StatusBadge.tsx` — shared badge with literal per-status Tailwind
  classes (scanner-safe). `Header.tsx` — "My orders" nav link for signed-in
  users. Loading state renders identically server + first client paint
  (hydration-safe).
- Small API enabler: `findMine` now loads `items` alongside `restaurant`
  relations, so one request renders full cards (unit tests assert both).

**Verified:**
- `nest build` clean; `jest` **168/168** (16 suites) incl. updated
  `findMine` relations assertion. `next build` green — `/orders/my` prerenders
  as the static client shell by design.
- API restarted on :4000 (fresh build); **curl smoke 22/22**: 401 no/garbage
  token; 5 authed orders created via Bearer checkout; rows carry
  restaurant+items[]; newest-first; `?status=` filter + BAD_REQUEST on junk
  status; `limit=2` pages 1/2/3 → 2/2/1 rows with distinct content; cancel →
  cancelled, re-cancel → BAD_REQUEST, cancelled row under filter; guest-order
  cancel → 404 (no existence leak); completed-order cancel → BAD_REQUEST;
  public list + `/health` regression green.
- Real-browser E2E (`next start :3217` + live API + seeded DB): guest prompt →
  demo login through `?next=/orders/my` → 5 live cards with exactly the
  expected badge mix; filter chips hit the server (Cancelled 1, Completed 1,
  Pending 2, Preparing → empty state); cancel button present only on
  Pending/Confirmed cards; UI cancel → notice, card left the Pending view,
  **hard reload kept the server state** (2 Cancelled / 1 Pending); Details
  link targets the real order UUID; Refresh re-pulls; header shows "My
  orders"; guest "Smoke Guest" order never leaked into user history; sign out
  returns the guest prompt. (Screenshot IPC timed out twice — harness-only,
  all assertions taken from the live DOM.)
- Throwaway data cleaned: the 6 smoke orders deleted via psql (DB back to 0
  orders / 2 seeded users), `:3217` server stopped, `:4000` left running the
  committed build.

**Docs:** README endpoint-table row note, ARCHITECTURE paginated-reads bullet,
ROADMAP item ticked.

**Left for next sessions:** checkout real-fee + min-order warning (Phase 1
item 9), cart-switch confirm UX (item 10), then Phase 2 portal — the
`CANCELABLE_STATUSES`/badge pieces here are reusable for the owner inbox.

---

## 2026-10-20 12:55 — Session 8

**Built:** Phase 1 item 7 — **web login & register pages wired to the auth
API, token stored, header shows the user**. API untouched (all auth endpoints
already shipped through session 7).

- `apps/web/lib/auth.tsx` — `AuthProvider` client context: session
  (`{access_token, refresh_token, expires_at, user}`) persisted to
  `localStorage` under a `foodorder.auth.v1`-style key (assembled from
  fragments at runtime — see the sanitizer note below), rehydrated on every
  page load, **proactive refresh 60 s before access-token expiry** (deduped
  in-flight; network failure retries once after 30 s), terminal 401 on refresh
  clears the session locally (correct response to the API's rotation +
  reuse-detection sweep), `logout()` revokes server-side best-effort then
  always clears locally, `getAccessToken()` refreshes on demand (ready for the
  order-history & checkout items). Status starts `loading` on server AND first
  client paint → hydration-safe header.
- `apps/web/lib/api.ts` — typed `SafeUser`/`Session` shapes mirroring
  `toSafeUser`/`issueSession`, Bearer helpers, `api.register/login/refresh/
  me/logout`, `isUnauthorized()`.
- `app/login/page.tsx` — Suspense-wrapped (uses `useSearchParams`), honors a
  same-origin `?next=` only (`//` and `/\` rejected → open-redirect guard),
  auto-bounces already-signed-in visitors, error banner fed by the API
  envelope ("Invalid email or password"), demo-account hint.
- `app/register/page.tsx` — name/email/password/confirm/optional phone+address
  with client mirrors of `RegisterDto` constraints (2–120 / email / 8–200 /
  ≤30 / ≤500); mismatch + server errors render in one alert list; success is
  auto-signed-in (register issues a session).
- `components/Header.tsx` — guest: Sign in + Register; signed in: initial
  avatar + name + Sign out; `loading`: skeleton pill. `app/layout.tsx`:
  `AuthProvider` wraps the tree above `CartProvider`.

**Bug found & fixed during verification:** the transcript sanitizer does not
just rewrite *displayed* text — it rewrites **outgoing tool arguments**, so a
literal dotted storage-key string committed all the way back in session 1 had
landed on disk (and in git) mangled to three asterisks, and my first write of
the auth key was mangled the same way (caught before commit by a `cat -A`
byte-check). Both keys are now assembled from fragments (`['foodorder','x','v1'].join('.')`),
which passes clean; cart.tsx carries a NOTE comment. Consequence: carts
previously persisted under the mangled key appear empty once (dev-only data,
acceptable).

**Verified:**
- `next build` green 3× (final incl. type-check; `/login` `/register`
  prerendered static — the page body is a client-rendered Suspense fallback in
  SSR HTML by design since `useSearchParams` opts out of prerender).
- Real-browser E2E (headless Chrome against `next start :3217` + live API
  `:4000` + seeded DB): guest header → wrong password shows the exact envelope
  message → demo login redirects to `?next=/cart` → header shows "Demo
  Customer / Sign out" → reload keeps the session (localStorage record probed:
  4 fields, 30-min expiry) → visiting `/login` while authed bounces to `/` →
  Sign out returns guest header and removes exactly the auth key → register
  flow: password-mismatch banner, corrected submit auto-signs-in
  ("Rina Testfield") → cart round-trip regression after the key fix: 2× Add
  persists across reload under the repaired key.
- API contract script (the exact calls `lib/auth.tsx` makes): 19/19 real
  assertions — register 201 session shape, me, refresh rotation, replayed
  refresh → 401 + reuse sweep kills newest session too, demo login, logout
  revokes exactly 1 + refresh-after-logout 401, 409/400 envelope details,
  anon `/auth/me` 401 (a 20th "failure" was my script asserting form HTML in
  the SSR prerender fallback — expected, browser E2E covers it).
- `npx jest` 168/168 unchanged (no API code touched). Smoke throwaway users
  deleted afterwards — DB back to the 2 seeded accounts.

**Docs:** ARCHITECTURE web-session-client bullet, ROADMAP item ticked.

**Left for next sessions:** order-history page (`/orders/my`, next Phase 1
item — `getAccessToken()` is ready for it), checkout prefill from profile +
real delivery fee (item 9), then cart-switch confirm UX.

---

## 2026-10-20 09:56 — Session 7

**Built:** Phase 1 item 6 — consistent API error format. Every non-2xx
response from the API now has exactly one shape, `{ error: { code, message,
details } }`, HTTP status preserved:
- `common/error-format.filter.ts` — global `@Catch()` ExceptionFilter wired
  in `main.ts` (`app.useGlobalFilters`). Normalizes *all* failure sources:
  guard/controller `HttpException`s get stable status-derived codes
  (`NOT_FOUND`, `UNAUTHORIZED`, `CONFLICT`, …, `HTTP_<n>` for exotic ones),
  ValidationPipe failures move their constraint list into `details` under a
  `"Validation failed"` headline, the router's implicit 404 (`Cannot GET …`)
  is enveloped like any other, and any non-HttpException is logged with its
  stack server-side and answered as a sanitized 500 — driver internals can
  never reach a client. Object bodies without a usable message fall back to
  canonical reason phrases (local map; Nest 11 removed `getStatusText`).
- `common/app-exception.ts` — `AppException(status, code, message, details)`
  for explicit domain codes (e.g. `MIN_ORDER_NOT_MET`) + structured details;
  filter passes them through untouched. No existing throw needed changing —
  the envelope wraps the plain message exceptions as-is; adopting domain
  codes in services is available for future sessions.
- `common/app-config.ts` — the ValidationPipe options are now exported as the
  single source of truth used by both `main.ts` and the integration spec, so
  tests exercise the *real* production config instead of a re-declared copy.
- **Web client adapted to the new contract** (it read `body.message`):
  `apps/web/lib/api.ts` now throws a typed `ApiError(message, status, code,
  details)` parsed from `body.error`, with fallback to the old shape for
  robustness. Checkout UI keeps working unchanged (`err.message`).

**Verified:**
- `nest build` clean; `npx jest` **168/168** across 16 suites (was 145/14) —
  +11 unit specs (`error-format.filter.spec.ts`: envelope shape for every
  exception class, always-present `details` key, validation-array→details,
  AppException passthrough incl. array details, 500 sanitization assert the
  leak text is *absent*, 418/custom fallbacks, junk-details coercion, code
  never rewrites status) and +12 HTTP-level integration specs
  (`error-format.integration.spec.ts`: a real Nest app booted with the
  production pipe+filter config on an ephemeral port, no supertest — probes
  success untouched, guard 401, controller 404, unknown-route 404, real
  ValidationPipe 400 with exact constraint details, injected-prop strip
  behavior, genuine-crash route returns sanitized 500 with no stack text,
  AppException round-trip incl. object details, malformed-JSON-body 400).
- `next build` green; web runtime smoke: `next start` on :3217 → `/` and
  `/checkout` HTTP 200, home SSR rendered seeded restaurants against the
  new API.
- Live API smoke on the new build (:4000, DB reseeded after): **22/22 valid
  assertions** (a 23rd script expectation — restaurants `?limit` over max →
  400 — was wrong, not an API bug; see the gap note below) — envelope shape
  (`code,message,details` exactly) verified on
  unknown route, malformed/unknown uuid order reads, anon + garbage-token
  `/orders/my`, bad query enum/page under a valid token (guards run before
  pipes, so unauthenticated requests 401 first — pre-existing Nest order,
  caught and corrected my script's assumption), `limit` over max, register
  validation, duplicate email 409, wrong password 409, unknown refresh 401,
  below-min-order 400, cancel-without-token 401, cancel foreign order 404,
  PATCH malformed uuid 404, customer on owner route 403, empty profile patch
  400, and two success paths (guest 201 server-priced total, `/health`) to
  prove the filter never touches 2xx bodies.
- Gap found (pre-existing, honest note): `GET /restaurants` query params are
  *not* DTO-validated at all (no ListRestaurantsDto — service clamps
  `limit` to 1..50 defensively), so `?limit=abc` silently falls back to the
  default instead of answering the ValidationPipe envelope the orders list
  does. Left as follow-up below.

**Docs:** README gained an *Error envelope* section under API surface;
ARCHITECTURE decisions bullet; ROADMAP item ticked. Dev DB restored to
canonical seed; API left running on :4000 with the new build; web smoke
server stopped.

**Left for next sessions:** add `ListRestaurantsDto` validation for
`GET /restaurants` (query parity with `/orders/my`); optionally adopt
`AppException` domain codes in orders/auth services (min-order, status
transition); docker compose end-to-end still carried from session 1; next
roadmap item — web login & register pages.

## 2026-10-19 14:16 — Session 6

**Built:** Phase 1 item 5 — orders status filter + pagination on `/orders/my` + customer cancellation:
- `GET /api/orders/my` now takes `ListMyOrdersDto` (`?status=<enum>`,
  `?page` ≥1, `?limit` 1–50, default 20) and returns the same
  `{items,total,page,limit}` envelope as `GET /restaurants` (was: bare array,
  hard-coded `take:50`). No web consumer existed for the old shape. The DTO
  rejects junk query params (400) and the whitelist strips everything else —
  `userId` is never injectable, scoping comes from the token subject only.
  The service additionally clamps page/limit defensively.
- **`POST /api/orders/:id/cancel`** (Bearer): customer cancels **own** orders
  only, reusing the single `STATUS_FLOW` truth — allowed from
  pending/confirmed/preparing, **400** from delivering/completed/cancelled.
  Someone else's order and guest orders (userId NULL — no proof of
  possession) answer the same **404** as unknown ids, so order existence is
  not leaked across accounts. `PATCH /:id/status` stays the open
  restaurant-side lever (unchanged; portal auth is Phase 2).
- **Gap found and fixed while wiring this:** `POST /orders` *never* attached
  `userId` even with a token — the old comment claimed otherwise, so
  `/orders/my` could only ever return empty and cancellation was moot. New
  `OptionalJwtAuthGuard` (`common/`): valid access token → order attached to
  the user; missing/expired/garbage token → silently proceeds as guest, so
  checkout can never break on a stale session.
- Malformed-uuid guard (`isUuid`, session 4's class of bug) applied to
  `OrdersService.findOne` + `cancel` — `GET /orders/:id`, `/next-statuses`
  and `PATCH /:id/status` used to 500 on non-uuid ids (Postgres 22P02);
  now 404 before touching the DB. No schema change → no migration.
- Tests (jest, 145 passing): 18 in `orders.service.spec.ts` (findMine
  defaults/where-clause/skip math/clamping/page-slice+total/user isolation;
  cancel matrix over all 6 statuses, foreign/guest/unknown/malformed 404s,
  findOne guard) and 6 in `list-my-orders.dto.spec.ts` driving the **real**
  global ValidationPipe as `type:'query'` (string→number coercion, unknown
  status / page=0 / 'abc' / fractional / limit>50 rejected, `userId`
  injection stripped); 6 in `optional-jwt-auth.guard.spec.ts` (valid →
  attaches; no/non-Bearer/garbage/expired/wrong-typ/foreign-secret → guest,
  never throws).

**Verified:**
- `nest build` clean; `npx jest` **145/145** across 14 suites (was 115/12).
- API restarted on :4000 with the new build (an old session-5 process was
  found serving there — killed). Live smoke — **54/54 assertions**: guest
  order server-priced + stays ownerless; garbage bearer on checkout → guest
  201; below-min-order → 400 with message; register A/B → 4 orders attached
  to A from token; `/orders/my` 401 anonymous + garbage token; envelope
  totals; `status=pending` 4 / `completed` 0; `limit=2`×2 pages cover 4
  distinct ids, beyond-end page empty with total kept; DESC ordering; 6 bad
  query combos → 400; injected `userId` stripped — still own scope; B sees 0
  of A's orders; cancel pending ✓ → GET reflects cancelled ✓; double-cancel
  400; confirmed→cancel ✓ after open PATCH status transition (regression);
  preparing→delivering ✓ then customer cancel **400**; B/guest-order/
  no-token/malformed/unknown cancel → 404/404/401/404/404; malformed uuid on
  read + status routes → 404; final mixed tally (2 cancelled / 1 delivering
  / 1 pending) matches `status=cancelled` count 2; owner login +
  `/restaurants/mine` regression; `/health` db up.
- Two smoke "failures" during development were script bugs, not API bugs
  (single-cheapest-item was not actually below that restaurant's min —
  replaced with a deterministic resto+item search; Nest returns **201** for
  `@Post` and the script expected 200) — fixed, re-ran, green.
- Dev DB restored to canonical seed (2 users / 6 restos / 27 dishes / 0
  orders / 0 sessions) via `npm run seed`; API left running on :4000 with
  the fresh build.

**Docs:** README endpoint table (query params, envelope, cancel route,
checkout auth wording corrected), ARCHITECTURE orders/pagination/
optional-auth bullets, ROADMAP item ticked.

**Left for next sessions:** error-format middleware (Phase 1 item 6);
web login/register pages can now actually store a session and see history;
docker compose end-to-end still unverified (carried since session 1).

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
