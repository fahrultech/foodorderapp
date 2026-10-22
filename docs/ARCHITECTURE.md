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
- **Order status machine** — transitions validated server-side
  (`pending→confirmed→preparing→delivering→completed`, cancellable through preparing).
  `POST /orders/:id/cancel` lets the *customer* use exactly that machine edge
  (own orders only — foreign/guest orders answer 404 so existence is not
  leaked); restaurant-side progression goes through the owner-scoped
  `PATCH /restaurants/:id/orders/:orderId/status` route, and the generic
  `PATCH /orders/:id/status` path is admin-only (it used to be open).
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

Roles: `customer` (default), `owner`, `admin`. Owner-only routes guarded by `JwtAuthGuard` + `RolesGuard` (`@Roles(UserRole.OWNER)`); ADMIN bypasses `@Roles`. Owners create/update only their own restaurants (`PATCH /restaurants/:id` returns 403 unless caller owns the row). `slug`/`rating`/`ownerId` are not owner-writable — slug auto-derived and de-duplicated (`-2`, `-3`…) at create.
Dish ownership is **derived through the parent restaurant** (menu_items carries no owner column): owner menu routes `POST /restaurants/:id/menu`, `PATCH /menu/items/:id` (content only), `PATCH /menu/items/:id/availability`, `DELETE /menu/items/:id` all check `MenuService.assertCanManage`; platform restaurants (`ownerId null`) are admin-only. Route params that must be uuids are screened by `common/uuid.ts isUuid` → 404 instead of a raw Postgres 22P02 500.
