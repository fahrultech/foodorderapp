# ARCHITECTURE

## System

```
Browser ──▶ Next.js web (SSR for browse pages, client for cart/checkout)
               │  REST JSON  (NEXT_PUBLIC_API_URL)
               ▼
          NestJS API ──▶ PostgreSQL (TypeORM, migrations-owned schema)
               ▲
   docker compose: db (postgres:16-alpine) + api + web
```

## Decisions

- **Monorepo `apps/`** — one repo, two deployables; shared git history for the
  daily-progress cadence (see docs/WORKFLOW.md).
- **Money as integer cents** — every price/fee/total is `int` cents; formatting
  only at the UI edge. Avoids float drift in totals.
- **Server-side pricing** — order totals are computed from DB menu prices at
  checkout, never trusted from the client. Cart contents only send `menuItemId`s.
- **One-restaurant carts** — a cart holds dishes from a single restaurant
  (matches delivery/logic reality). Adding a dish from a *different*
  restaurant never wipes the cart silently: the CartProvider raises a
  `switchRequest` and a confirmation modal ("Start a new cart?") shows the
  current cart (count, restaurant, subtotal) vs the one-item new cart —
  Keep discards the add, Replace swaps. Escape/backdrop close = Keep.
- **In-page menu search is client-side** — the restaurant page already ships
  the full menu in `GET /restaurants/:id`; `MenuBrowser` filters it in memory
  (name/description/category, case-insensitive) instead of adding a per-keystroke
  API. Category anchor ids are positional (`cat-<i>`) and stable while filtering.
- **Order status machine** — transitions validated server-side
  (`pending→confirmed→preparing→delivering→completed`, cancellable through preparing).
  `POST /orders/:id/cancel` lets the *customer* use exactly that machine edge
  (own orders only — foreign/guest orders answer 404 so existence is not
  leaked); restaurant-side progression goes through the owner-scoped
  `PATCH /restaurants/:id/orders/:orderId/status` route, and the generic
  `PATCH /orders/:id/status` path is admin-only (it used to be open).
- **Status-step timestamps** — the order entity carries write-once
  `confirmedAt`/`preparingAt`/`deliveringAt`/`completedAt`/`cancelledAt` columns
  stamped by `OrdersService.applyStatus` on first entry into each step (every
  transition path — owner, customer-cancel, admin — goes through it; rejected
  transitions stamp nothing). The `AddOrderStatusTimestamps` migration backfills
  pre-existing rows: current step = `updatedAt`, earlier steps = `createdAt`
  (a true lower bound), pending untouched. The web `/orders/[id]` page renders
  them as the customer tracking timeline (`OrderTimeline` — done/waiting/future
  nodes, red terminal node when cancelled; `pending` step is `createdAt`).
- **Paginated reads** — `GET /orders/my` (`?status&page&limit`, default 20,
  max 50) and `GET /restaurants` share the `{items,total,page,limit}` envelope;
  `/orders/my` rows load `restaurant` + `items` relations so the web history
  page renders full cards in one request.
- **Owner inbox scoping** — `GET /restaurants/:id/orders` (same query DTO +
  envelope, plus a per-status `counts` map computed over ALL statuses so the
  dashboard tabs stay accurate while filtered) is guarded by
  `JwtAuthGuard + RolesGuard @Roles(OWNER)` and re-checked in
  `OrdersService.findForRestaurant`: only the restaurant's owner (or an admin)
  may read its orders — restaurant pages are public, order data is not. The
  web `/dashboard` page consumes it after `GET /restaurants/mine`, and its
  action buttons use `PATCH /restaurants/:id/orders/:orderId/status`
  (`OrdersService.setStatusForRestaurant`): same guard + ownership check,
  then the order must live under the path's restaurant (else 404 — a foreign
  order id gives no information) and the move must be a `STATUS_FLOW` edge.
  The inbox is LIVE with two cooperating transports:
  **SSE push (primary)** — the page subscribes to
  `GET /restaurants/:id/orders/stream` (see next bullet) and each
  `order.created` / `order.updated` event fires one debounced silent refetch
  (`PUSH_SYNC_DEBOUNCE_MS` in `lib/live-sync.ts` coalesces bursts; a wake-up
  arriving while hidden/busy is remembered and flushed when the gate opens).
  **10s poll (fallback)** — the interval tick keeps running but goes idle
  whenever the stream is connected (`shouldPoll` gained the `pushUp` term);
  if the stream drops, ticks resume within one interval. Responses are
  dropped when the view (restaurant / filter / page) changed mid-flight, and
  a sync that started before a successful status action is discarded so the
  card never regresses.
- **Order stream (SSE)** — `GET /restaurants/:id/orders/stream` streams
  `hello` (once), `order.created` / `order.updated` (trigger-only payload
  `{orderId, code, status}` — data truth always comes from the inbox GET),
  and a 15s `ping` heartbeat. Events are live-only from a process-local rxjs
  bus (`OrderEventsService`), published by `OrdersService` after create /
  owner-status / customer-cancel / admin-status writes; single-container
  scope is deliberate (multi-node realtime is the Phase 5 Socket.IO item).
  Auth is `SseJwtAuthGuard` + `RolesGuard @Roles(OWNER)` +
  `OrdersService.assertStreamAccess` (same 404/403 semantics as the inbox)
  asserted BEFORE the stream starts. `EventSource` cannot send headers, so
  the token may ride `?access_token=` — accepted ONLY on this route, header
  wins when both are present; trade-off: query tokens can reach access
  logs, mitigated by short TTLs + TLS at deployment. The client watches the
  heartbeat: two missed cycles (`STREAM_STALL_MS`) mark the connection a
  zombie → poll fallback + rebuild; the stream is also rebuilt with a fresh
  token every 15min, well inside the 30m access TTL.

- **Owner menu manager** — web `/dashboard/menu` does full dish CRUD on the
  existing owner routes (`POST /restaurants/:id/menu`, `PATCH /menu/items/:id`,
  `PATCH /menu/items/:id/availability`, `DELETE /menu/items/:id`, all
  JWT+OWNER+ownership-guarded in `MenuService.assertCanManage`). The list view
  reads the UNFILTERED `GET /restaurants/:id/menu` so hidden drafts stay
  visible to the owner; the edit form clears optional text fields by sending
  `null` (@IsOptional skips null → MenuService stores it). `MenuService.remove`
  snapshots the entity BEFORE `repo.remove()` — TypeORM's `remove()` nulls the
  primary column on the disposed entity, so a naive `return item` serialized
  JSON without `id` (caught by session 14 runtime smoke; the jest repo mock
  now reproduces the mutation to guard it).
- **Optional auth on checkout** — `POST /orders` uses `OptionalJwtAuthGuard`:
  a valid access token attaches the order to the user (enabling history and
  self-cancel); a missing, expired or garbage token silently proceeds as a
  guest, so a stale session can never break checkout.
- **JWT access + opaque refresh tokens** — no passport for now; the guard
  verifies Bearer tokens and decorates `req.user` with
  `{sub, email, role, name, typ}`. See *Auth (Phase 1)* below for the full
  token model.
- **Snapshot order items** — `order_items` store name+unit price copies, so
  historical orders survive menu edits *and dish deletes* (the
  `order_items.menuItemId` FK is `ON DELETE SET NULL`).
- **TypeORM migrations own the schema** — `synchronize` is off; the baseline
  `InitSchema` migration reproduces the Phase 0 dev schema exactly. Pending
  migrations run automatically on API boot; `db:stamp-baseline` adopts
  pre-migration databases. Entity changes require a committed migration.
- **One error envelope everywhere** — a global `ErrorFormatFilter`
  (`@Catch()`) renders *every* failure — guards, ValidationPipe, controllers,
  the router's own 404 — as `{ error: { code, message, details } }`,
  preserving the HTTP status. `code` is stable per status (unknown ones get
  `HTTP_<n>`); `AppException` carries explicit domain codes + structured
  `details`. Validation constraint lists move to `details` under a generic
  `"Validation failed"` headline; non-HttpExceptions are logged with stack
  and answered as a sanitized 500 so driver internals never reach clients.
  The web `lib/api.ts` throws a typed `ApiError` (`status`, `code`,
  `details`) parsed from this envelope. See README *Error envelope*.

## Auth (Phase 1)

- **Access token**: JWT signed with `JWT_SECRET`, TTL `JWT_ACCESS_TTL` (default
  `30m`), claims `{sub, email, role, name, typ: 'access'}`. `JwtAuthGuard`
  rejects anything whose `typ` is not `access`, so a refresh token (or a token
  from the pre-Phase-1 `7d` era) can never unlock an API route.
- **Refresh token**: *not* a JWT — 256-bit opaque random string
  (`crypto.randomBytes(32)`, base64url). Only its SHA-256 hex digest is stored,
  in `refresh_tokens(id, tokenHash UNIQUE, userId, expiresAt, revokedAt,
  createdAt)` with `userId` FK `ON DELETE CASCADE`. Revocation is exact rather
  than "wait for expiry", and a leaked table dump is not a session store.
- **Rotation + reuse detection**: `POST /api/auth/refresh` revokes the presented
  row and issues a new pair (one token is usable exactly once). Presenting an
  already-revoked token means it was copied, so *every* session of that user is
  revoked and the request 401s.
- **Logout** (`POST /api/auth/logout`, requires a valid access token) revokes
  one session (`refresh_token`), or all of the caller's sessions (`all: true`
  or an empty body). Scoped by `userId`, so one caller cannot revoke another's
  session; idempotent. Already-issued access tokens still live out their
  `JWT_ACCESS_TTL` — that is why it is minutes.
- **`GET /api/auth/me` reads the database**, not the cached claims, so profile
  edits appear immediately and a deleted account stops answering.
- **`PATCH /api/users/me`** self-service profile: allowlist of
  `name`/`phone`/`address` in `UpdateProfileDto`; `email` (identity), `role`
  (authorization) and password are *not* self-writable — email change needs a
  verification flow, role change is admin-only, and a password change must
  verify the old one. Empty patch → 400 (never a silent no-op "success").
- **Favorites (`/api/users/me/favorites`, Bearer)** — hearts on dishes in the
  `user_favorites` table (unique `(userId, menuItemId)`, both FKs cascade, so
  deleting a user or a dish never leaves dangling hearts). Add is deliberately
  idempotent: an existing heart answers 200 `{created:false}` (the unique
  index plus a 23505 catch covers the concurrent double-click race), and
  un-heart likewise answers `{removed:false}` for unknown pairs — the web
  heart button can fire optimistically and refetch on mismatch. Rows are
  always scoped to the JWT subject; there is no `:userId` route to leak.
- **Web favorites client** (`apps/web/lib/favorites.tsx`): one app-wide
  `FavoritesProvider` fetches the set once per signed-in user; menus and the
  `/favorites` page share it, toggles are optimistic with rollback + resync on
  failure, and a load-sequence guard drops stale responses after a user
  switch/logout. Guests clicking a heart are routed to `/login?next=` (the
  existing back-pointer flow), and SSR/first paint always render the neutral
  heart so hydration matches.
- **Reviews (`/api/reviews`, Bearer + public feed)** — customers rate their own
  COMPLETED orders in `reviews` (unique `orderId`: one review per order, the
  DB enforces it — duplicate POST answers 409 `CONFLICT`; unknown and
  foreign orders are both 404, no existence leak; other statuses 400). The
  author is the JWT subject and `restaurantId` is copied from the order — the
  whitelist strips anything else the body tries to inject. `PATCH`/`DELETE`
  are author-only (404 otherwise; empty PATCH → 400, DELETE is idempotent).
  **Server-side rating**: every review write recomputes
  `restaurants.rating = AVG(rating)` (2 decimals; platform default 4.5 when no
  reviews remain) plus `ratingCount` — the seed value a restaurant ships with
  is what it shows *until* its first review lands. Public list
  `GET /restaurants/:id/reviews` (page envelope + rating summary).
- **Web review UI**: `RateOrderCard` on `/orders/[id]` (completed orders only)
  — sign-in prompt for guests (?next= back-pointer), existing-review panel
  (matched via `GET /reviews/my`), star picker + capped comment, and a 409
  absorbed as "resync and show the stored review" for double tabs/retries.
  Restaurant pages render the recomputed badge (`★ 4.3 · 3 reviews`) plus a
  server-fetched "Recent reviews" section; `Stars.tsx` is display-only and
  SSR-safe. Review edit/delete exist on the API but have no UI yet.
- **Promo codes (`/api/promos` + order-create hook)** — `promo_codes` rows are
  platform/seed-managed (no owner CRUD yet): `percent` (1..100 of subtotal,
  optional `maxDiscountCents` cap) or `fixed` cents-off, gated by
  `minSubtotalCents` (checked against the PRE-discount subtotal, so a promo
  can't bypass a restaurant minimum either — that check still runs first) and
  optionally scoped to one restaurant (`restaurantId` null = platform-wide);
  `isActive=false` is the kill switch. `PromosService.evaluate` is the single
  decision point, called by `OrdersService.create` with the SERVER-computed
  subtotal — the client's numbers are never consulted; a rejected code 400s
  the whole order. The applied code + `discountCents` are denormalized onto
  the order (text snapshot, not FK — receipts survive promo deletion). The
  discount is clamped to the subtotal: delivery fees are never discounted.
  `POST /promos/validate` is a soft-200 preview for the checkout UI; expiry
  dates + usage caps are deliberately Phase 5 ("Coupons expiry + usage caps"
  needs a usage-ledger table). Web: promo input in the checkout summary
  (apply/Enter, stale-cart reset, inline reason), discount line on the
  receipt `/orders/[id]`.
- **Delivery address book (`/api/users/me/addresses`, Bearer + checkout
  picker)** — `delivery_addresses` rows (label/recipientName/phone/address +
  `isDefault`), user FK cascade, indexed by `userId`, capped at 10 rows (400).
  The service maintains **exactly one default while the book is non-empty**:
  the first row is forced default, `POST /:id/default` promotes (clearing the
  previous one), and deleting the default promotes the oldest survivor
  (`promotedDefaultId` reports the handover). PATCH edits text fields only —
  the flag never moves through PATCH (whitelist strips it), keeping the
  invariant in one obvious place. Unknown and foreign ids are one
  indistinguishable 404; DELETE is idempotent `{removed}` like un-hearting.
  **Order integration:** `POST /orders` accepts optional `deliveryAddressId`;
  the server resolves it against the JWT subject (guest sender → 400,
  foreign → 404) and copies its OWN recipient/phone/address text onto the
  order — the client echo is ignored, and the order keeps a TEXT snapshot (not
  an FK), so later book edits never rewrite where past food went. Without an
  address id the three contact fields stay required; `OrdersService` enforces
  that either/or with a message listing what is missing. Web: `/addresses`
  management page (add/edit/delete/make-default, client-side bounds mirror
  the DTO) and a radio picker on `/checkout` that pre-selects the default,
  prefills the form, and drops back to "manual" the moment a field is typed —
  honest about what the server will actually use.
- **No token revocation list for access tokens** — deliberate: short TTL +
  stateless verification. Re-add a deny-list only if TTL ever grows.
- **Web session client** (`apps/web/lib/auth.tsx`): the storefront keeps the
  pair in `localStorage` as `{access_token, refresh_token, expires_at, user}`
  under key `foodorder.auth.v1` and rehydrates on every page load, so sign-in
  survives reloads. `AuthProvider` refreshes proactively 60 s before access-token
  expiry (deduped via an in-flight promise; a network failure retries once after
  30 s), clears the session on the first terminal 401 (revoked/rotated/unknown —
  the API's reuse-detection sweep makes that the correct client response), and
  `logout()` revokes server-side best-effort before always clearing locally.
  Pages never touch the token directly — they call `login/register/logout` or
  `getAccessToken()`, which refreshes on demand; `/login` honors a same-origin
  `?next=` only (`//` and `/\` prefixes rejected).

## Data model (v0)

users(1)──(N)orders(1)──(N)order_items(N)──(1)menu_items(N)──(1)restaurants
users(1)──(N)restaurants  (restaurants.ownerId → users.id; nullable, FK ON DELETE SET NULL, indexed)
users(1)──(N)reviews(1)──(1)orders(1)──(1)restaurants  (reviews: unique orderId, all FKs ON DELETE CASCADE; restaurants.rating/ratingCount are recomputed server-side on every review write)
restaurants(1)──(N)promo_codes  (restaurantId nullable: null = platform-wide, FK ON DELETE CASCADE; code unique uppercase; orders keep promoCode/discountCents text+int snapshots, no FK)

Roles: `customer` (default), `owner`, `admin`. Owner-only routes guarded by `JwtAuthGuard` + `RolesGuard` (`@Roles(UserRole.OWNER)`); ADMIN bypasses `@Roles`. Owners create/update only their own restaurants (`PATCH /restaurants/:id` returns 403 unless caller owns the row). `slug`/`rating`/`ownerId` are not owner-writable — slug auto-derived and de-duplicated (`-2`, `-3`…) at create.
Dish ownership is **derived through the parent restaurant** (menu_items carries no owner column): owner menu routes `POST /restaurants/:id/menu`, `PATCH /menu/items/:id` (content only), `PATCH /menu/items/:id/availability`, `DELETE /menu/items/:id` all check `MenuService.assertCanManage`; platform restaurants (`ownerId null`) are admin-only. Route params that must be uuids are screened by `common/uuid.ts isUuid` → 404 instead of a raw Postgres 22P02 500.
