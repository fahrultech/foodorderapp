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
- **Storefront localization uses `next-intl` without locale-prefixed routes** —
  English (`en`) is the safe default and Indonesian (`id`) is selected from the
  shared header. A server action validates the requested locale and stores it in
  an HTTP-only, same-site cookie; `i18n/request.ts` rejects unknown cookie values
  back to English. This preserves every existing URL, cart link, callback, and
  SEO route while localizing metadata, shared header/footer, restaurant browse
  cards, restaurant detail/reviews, menu search states, and add-to-cart labels.
  The root `NextIntlClientProvider` gives client islands the same request locale
  as server components, and `<html lang>` follows the active choice.
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
  scope is deliberate (the bus stays process-local even with multi-node
  deployments — the WS gateway below consumes the same bus).
  Auth is `SseJwtAuthGuard` + `RolesGuard @Roles(OWNER)` +
  `OrdersService.assertStreamAccess` (same 404/403 semantics as the inbox)
  asserted BEFORE the stream starts. `EventSource` cannot send headers, so
  the token may ride `?access_token=` — accepted ONLY on this route, header
  wins when both are present; trade-off: query tokens can reach access
  logs, mitigated by short TTLs + TLS at deployment. The client watches the
  heartbeat: two missed cycles (`STREAM_STALL_MS`) mark the connection a
  zombie → poll fallback + rebuild; the stream is also rebuilt with a fresh
  token every 15min, well inside the 30m access TTL.

- **Realtime order feed (Socket.IO)** — Phase 5 item: `RealtimeGateway`
  (`orders/realtime.gateway.ts`) mounts a Socket.IO server under the `/orders`
  namespace on the SAME HTTP port as REST (URL `ws://<api>/orders`, default
  path `/socket.io/`). It consumes the one `OrderEventsService` bus, so SSE
  and WS announce identical trigger-only payloads (`{orderId, code, status}`)
  and can never drift in content — only in transport. Handshake REQUIRES an
  access JWT (`auth: { token }`, query `?token=` fallback), verified with the
  same secret + `typ` rules as the REST guards; a bad socket gets an
  `auth_error` frame then a close, no events ever flow. Subscribing is an
  app-level protocol with acks: `subscribe:restaurant {restaurantId}` reuses
  `OrdersService.assertStreamAccess` (the exact inbox GET gate; 403/404/400
  surface as ack codes, never a join) and joins room `r:<restaurantId>`;
  `subscribe:me` joins `u:<sub>` with the id taken from the VERIFIED token —
  the customer-side live feed for one's own orders, which never had an
  endpoint before. Guest orders (`userId` null on the event) fan out to the
  restaurant room only. No app-level heartbeat: Socket.IO pings at the
  transport layer. The web consumes it as its PRIMARY push transport
  (session 37): `lib/use-order-feed.ts` wraps the handshake/subscribe/
  reconnect lifecycle (WS-only transport so a dead feed fails fast and
  degrades instead of silently re-routing through engine.io polling;
  `reconnection: false` — the hook owns reconnect with capped backoff and a
  fresh-token handshake, `subscribe` ACKs gate the `wsUp` state, plus a
  15m proactive rebuild mirroring the SSE token rule). `/dashboard` runs a
  strict transport LADDER — WS up ⇒ SSE stays closed (`shouldOpenSse`);
  WS down ⇒ SSE opens (the Phase-2 stream unchanged, now the fallback);
  both down ⇒ the 10s poll; the Live pill renders the current rung as
  `data-feed-transport="ws|sse|poll|paused"`. `/orders/[id]` (customer
  tracking, previously manual-reload only) gained live updates the same
  way via the `OrderLiveFeed` island: `subscribe:me` events for THIS order
  trigger a coalesced `router.refresh()` (server component re-runs its
  own GET — the feed never carries truth), with 10s refresh polling as the
  fallback and no transport at all for guests or terminal orders.

- **Outbound order notifications** — `OrderNotificationsService` consumes the
  same process-local `OrderEventsService` bus after order creation/status
  writes, reloads the canonical order, and fans out independently to email
  (`MailService`, enabled by `SMTP_HOST`) and browser push (`PushService`,
  enabled by the complete VAPID subject/public/private triplet). Push delivery
  addresses live in `push_subscriptions`: one user may own multiple browser
  endpoints, endpoint re-registration transfers a shared browser to the
  current JWT subject, unsubscribe is user-scoped/idempotent, and provider
  404/410 responses prune stale rows. Guest orders skip both channels because
  they have no user id. Push payloads contain only order code/status and a
  same-site receipt URL — no address, phone, item, or payment data. Delivery is
  best-effort and inherits the process-local bus boundary; a durable outbox or
  broker is future multi-instance work. The web side is now complete:
  `PushNotificationsProvider` reads the public config only for signed-in users,
  exposes a header bell, and calls `Notification.requestPermission()` only from
  that explicit click. A granted browser registers `/sw.js`, subscribes with
  the VAPID public key, and POSTs only the endpoint + encryption keys; turning
  the bell off DELETEs the user-scoped row and locally unsubscribes. Sign-out
  performs that same detach before revoking the auth session, preventing a
  shared browser from continuing to receive the previous account's orders.
  Existing subscriptions are silently refreshed/transferred on the next
  signed-in load without another permission prompt. The service worker shows
  the API's privacy-minimal payload and focuses or opens its same-site receipt
  URL on click. Unsupported, server-disabled, and browser-blocked states never
  request permission and render a disabled control.

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
- **Structured logs + request ids (pino)** — one JSON line per event on
  stdout, level from `LOG_LEVEL` (default `info`), `service` field on every
  line. `requestIdMiddleware` (global, registered first) assigns each request
  a correlation id — reuses a safe inbound `X-Request-Id` (≤64 chars,
  `[A-Za-z0-9._-]`, log-injection guard), else a UUID v4 — echoes it on the
  response (CORS-exposed), and activates an `AsyncLocalStorage` context for
  the whole chain. `PinoLoggerService` replaces Nest's console logger, so
  bootstrap messages and `new Logger(...)` call sites (e.g. ErrorFormatFilter)
  log as JSON too and pick up the active `reqId`. `pino-http` then emits
  exactly one access line per finished request (`method url -> status`,
  `responseTime`, 4xx→`warn`, 5xx→`error`, `/api/health` ignored) reusing the
  same `req.id` — app lines and access lines correlate 1:1 by `reqId`.
  Request/response serializers are minimal: no headers, no bodies, plus
  explicit redact paths (`authorization`, cookies, `**.password`, tokens).
- **Rate limiting (in-house guard, no dependency)** — sliding-window log per
  client IP over an in-memory store (`src/common/rate-limit/`). Opt-in per
  route via `@RateLimit('auth'|'orders')` + `RateLimitGuard` (guarded as the
  FIRST guard, so throttled requests never reach JWT/validation work): the
  whole `/auth` credential trio (`register`, `login`, `refresh`) shares one
  `auth` bucket (default 10/min), guest `POST /orders` and
  `POST /orders/:id/cancel` share `orders` (default 30/min); everything else
  is untouched. Every throttled response carries `X-RateLimit-Limit/
  Remaining/Reset`; blocks get `Retry-After` plus the standard error envelope
  `{code: "RATE_LIMITED", details: {bucket, retry_after_sec, window_sec,
  req_id}}` — the `req_id` matches the logged `X-Request-Id` (session 25
  hook-up) so a 429 is traceable. Blocked requests are *not* counted (retry
  storms can't extend a window). Identity is the socket IP by default;
  `RATE_LIMIT_TRUST_PROXY=1` switches to the first XFF hop — only safe behind
  a proxy that overwrites the header, otherwise spoofed XFF would mint free
  buckets. Limits/window per bucket are env-tunable
  (`RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_WINDOW_SEC`,
  `RATE_LIMIT_ORDERS_MAX`, `RATE_LIMIT_ORDERS_WINDOW_SEC`). The store is
  process-local — correct for the current single API instance; multi-node
  deploys swap in a Redis-backed `RateLimitStore` behind the same interface
  (guard/decorators/response contract unchanged).

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
- **Payment abstraction (`/api/payments`, Bearer)** — Phase 5 core: one
  `PaymentGateway` interface (`createIntent` + `capture`, integer cents in,
  provider refs out) hides whichever adapter is mounted. `PAYMENT_PROVIDER`
  picks it at BOOT via a DI factory that fails fast on an unknown id — today
  the only adapter is `MockPaymentGateway` (deterministic `mock_pi_<paymentId>`
  refs, no network, `MOCK_PAY_GATEWAY_MODE=fail` forces declines so the
  failed-payment path is live-exercisable). Adding Stripe/Xendit = implement
  the interface + register it in `PaymentsModule`; `PaymentsService` never
  touches provider code. **Amounts are never client input:** `POST /payments`
  takes an order id and snapshots `order.totalCents` (integer cents) onto the
  `payments` row; capture settles the SNAPSHOT. One row per ATTEMPT with a
  unique `providerRef` and its own audit trail (`provider`, `failureReason`,
  write-once `succeededAt`); pay() is idempotent while an attempt is pending
  (the live row replays — a second intent per order is impossible), a
  succeeded row 409s `ORDER_ALREADY_PAID`, a failed row is terminal and
  retrying means a NEW row. `POST /payments/:id/capture` resolves the state
  table: pending→gateway verdict, succeeded replays (200, gateway untouched),
  failed 409s. Orders gate: only pending/confirmed accept NEW intents;
  capture additionally refuses when the order has since been cancelled
  (409 `ORDER_CANCELLED`). Access: owner pays their order, ADMIN pays any,
  GUEST orders are payable by any authenticated payer (the receipt-link path
  — payer is recorded on the row); foreign owned orders 404 (no existence
  leak, same stance as cancel). Rows persist BEFORE the intent call, so a
  gateway explosion is recorded as a FAILED row + surfaced as 502
  `PAYMENT_GATEWAY_ERROR`, never lost. `payments` bucket throttles pay+capture
  together (default 10/min/IP). **Refunds** (same bucket): the optional
  `PaymentRefundGateway` add-on (`refundIntent`) — probed via
  `supportsRefunds()`, never forced onto the core interface; the mock ships it
  with an INDEPENDENT `MOCK_REFUND_GATEWAY_MODE=fail` knob (a live server can
  pay+capture while refunds decline, exactly the refund-failure path).
  `POST /payments/:id/refund` is ADMIN-only (@Roles + service re-check):
  refunds accumulate on the SUCCEEDED row (`refundedCents`/`refundedAt`,
  CHECK-constrained 0..amountCents); partial keeps status `succeeded`, the
  exact full amount flips it to terminal `refunded` (which frees the order to
  be repaid as a NEW attempt and blocks capture with 409). Omitted amount =
  full remainder; overspecs 400; declines never touch the row; a compare-and-set
  on `refundedCents` makes two racing refunds impossible. Order status does
  NOT gate refunds (refunding a cancelled order's payment is the normal case).
  **Refund audit trail** (`payment_refunds`): every LANDED refund appends one
  row — provider refund ref (mock `mock_re_<paymentId>_<remaining>_<cents>`;
  the remainder-before component makes even two equal partials of one intent
  carry distinct refs), this refund's cents, the running `refundedAfterCents`,
  and the acting admin (id FK SET NULL + email snapshot from the JWT, so
  attribution outlives account deletion) — written in the SAME transaction as
  the CAS balance update it explains; declined/errored attempts leave no trace.
  The row's cumulative `refundedCents` stays the fast balance check;
  SUM(ledger.amountCents) must equal it. `GET /payments/:id/refunds`
  (ADMIN-only) reads one payment's trail chronologically.
  Order confirmation is gated on a succeeded payment by the
  `ORDER_CONFIRM_REQUIRES_PAYMENT` flag (Phase 5 order-machine gate),
  ENABLED BY DEFAULT since session 44: every path into `confirmed` — owner
  portal AND the ADMIN backdoor — answers 402 PAYMENT_REQUIRED until a
  `succeeded` payments row exists for that order (existence probe, never a
  status write from the payment side; `refunded` rows do not satisfy it).
  Only the explicit opt-out spellings 0/false/no/off take the gate out;
  unset/garbage keeps it ON (a typo'd opt-out must not silently disable a
  money-integrity gate). **Web pay UI is wired**
  (session 43): `components/PaymentPanel.tsx` + `components/PayButton.tsx`
  on the order receipt page — one click runs the two documented calls
  (intent → capture), the paid/fail/pending/refunded views derive purely
  from `GET /orders/:orderId/payments`, and checkout hands signed-in
  customers over with `?pay=1` (elevated pay card). Guests see a sign-in
  hint because every payment route is Bearer-gated; the client re-implements
  no money rule — all rejections (409 ORDER_ALREADY_PAID / NOT_PAYABLE /
  ORDER_CANCELLED, 429, 502) surface the API envelope verbatim.
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
cities(1)──(N)restaurants  (restaurants.cityId → cities.id; nullable for legacy rows, FK ON DELETE SET NULL, indexed; restaurants.city is the read-friendly name snapshot)
users(1)──(N)reviews(1)──(1)orders(1)──(1)restaurants  (reviews: unique orderId, all FKs ON DELETE CASCADE; restaurants.rating/ratingCount are recomputed server-side on every review write)
restaurants(1)──(N)promo_codes  (restaurantId nullable: null = platform-wide, FK ON DELETE CASCADE; code unique uppercase; orders keep promoCode/discountCents text+int snapshots, no FK)
orders(1)──(N)payments  (payments.orderId FK ON DELETE CASCADE; payer payments.userId FK ON DELETE SET NULL — audit row survives user deletion; providerRef UNIQUE nullable (null only when intent creation itself failed); amountCents = server snapshot of orders.totalCents at intent time; status enum pending|succeeded|failed|refunded; refundedCents/refundedAt accumulate refunds on the same row, CHECK 0..amountCents; indexed (orderId, createdAt) for the per-order history list)
payments(1)──(N)payment_refunds  (refund audit ledger — one append-only row per LANDED refund, written in the same transaction as the payment-row CAS update; paymentId FK ON DELETE CASCADE, indexed (paymentId, createdAt) for the chronological read; providerRefundRef varchar(128) snapshot — nullable, deliberately NOT unique: a schema rule must never reject a refund the provider already executed; amountCents > 0 CHECK; refundedAfterCents running balance; actingAdminId FK SET NULL + actingAdminEmail JWT snapshot for attribution outliving the account)

Roles: `customer` (default), `owner`, `admin`. Owner-only routes guarded by `JwtAuthGuard` + `RolesGuard` (`@Roles(UserRole.OWNER)`); ADMIN bypasses `@Roles`. Owners create/update only their own restaurants (`PATCH /restaurants/:id` returns 403 unless caller owns the row). `slug`/`rating`/`ownerId` are not owner-writable — slug auto-derived and de-duplicated (`-2`, `-3`…) at create.
Multi-city scope is registry-backed: public `GET /cities` returns active cities; owner restaurant create/update accepts a validated active `cityId` and atomically stores both the FK and display-name snapshot. `GET /restaurants?city=` matches the registry slug or name (case-insensitive), with a legacy text fallback only for rows whose `cityId` is null.
Dish ownership is **derived through the parent restaurant** (menu_items carries no owner column): owner menu routes `POST /restaurants/:id/menu`, `PATCH /menu/items/:id` (content only), `PATCH /menu/items/:id/availability`, `DELETE /menu/items/:id` all check `MenuService.assertCanManage`; platform restaurants (`ownerId null`) are admin-only. Route params that must be uuids are screened by `common/uuid.ts isUuid` → 404 instead of a raw Postgres 22P02 500.
