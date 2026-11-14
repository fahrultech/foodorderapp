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
  checkout, never trusted from the client. Cart contents only send `menuItemId`s
  plus, for dishes with option groups, the selected `optionChoiceIds`. Those ids
  are the ONLY client-supplied input the option path consults: `MenuOptionService.resolveSelections`
  re-checks every one against the dish's own groups (existence, correct parent
  dish, no duplicates, per-group `minChoices`/`maxChoices`) and folds the DB
  `priceDeltaCents` values into `unitPriceCents` itself. A client-sent price,
  delta or `extraCents` field simply does not exist as far as the DTO is
  concerned, and any rejected selection 400s the whole order before a row is written.
- **Order create is ONE unit of work** — every mutation a new order owns
  (stock decrements, the order+items rows, the promo ledger row) runs inside a
  single `orders.manager.transaction`; a rejected or failing order leaves NO
  row anywhere. `menu_items.stock` (NULL = unlimited — the seeded default) is
  guarded by the decrement UPDATE itself (`stock >= requested` in the WHERE,
  zero-row = 409 `INSUFFICIENT_STOCK`), never by a read-then-write. Promo
  caps re-check under `SELECT ... FOR UPDATE` on the same transaction, which
  serializes simultaneous "last redemption" orders. Every path into
  `cancelled` returns the order's reserved units exactly once: creation
  freezes a `orders.stockDecrements` jsonb snapshot (only what was ACTUALLY
  decremented — an order with a NULL snapshot returns nothing, so an owner
  switching stock on later cannot be inflated), and the cancel flips the
  `stockRestockedAt`
  CAS marker inside one transaction before adding `stock + units` per dish
  (skips dishes cleared to unlimited; concurrent cancels cannot
  double-return). The narrow crash window BETWEEN the two commits (status
  saved, restock never landed) is drained by the ADMIN
  `POST /orders/ops/restock-repair` pass and the `restock-repair` cron
  (`ops/restock-repair.sh` + systemd timer): it selects exactly
  cancelled + non-empty array snapshot + marker NULL orders older than
  `RESTOCK_REPAIR_GRACE_MINUTES` (default 10 — a healthy in-flight cancel is
  never raced) and hands each to the SAME primitive, so repairs are
  idempotent and can never double-return. A snapshot with no usable entry is
  honestly re-surfaced in every report — never silently marked — until an
  operator repairs the ledger.
- **Storefront menu reads embed option groups** — `GET /restaurants/:id` attaches
  the same sorted `optionGroups` (choices included, `[]` when a dish has none) to
  its nested `menuItems` as `GET /restaurants/:id/menu`, through the single shared
  `MenuService.attachOptionGroups` pass (one IN-query, no N+1). The web cart picker
  renders directly from the storefront payload — there is no second fetch per dish.
- **Open/closed is DERIVED from the weekly schedule** — `restaurant_hours`
  rows (one per weekday window `[opensAt, closesAt)`, `closesAt <= opensAt`
  wraps past midnight) drive `isOpenNow` on every storefront read (list /
  detail / mine) through one batched IN-query pass in
  `RestaurantsService.attachHours`; a restaurant WITHOUT rows falls back to
  the legacy manual `isOpen` column, where `isOpenNow` simply equals it.
  Windows are interpreted in `restaurants.timeZone` (IANA, null =
  server-local). Owners (admins bypass) replace the whole week via
  PUT-semantics `PATCH /restaurants/:id/hours` — `days: []` clears the
  schedule and hands the signal back to the manual toggle. The web UI never
  recomputes the open/closed signal client-side; it renders the server's
  `isOpenNow` (session 68).
- **Map pins are a coordinate PAIR** — `restaurants.latitude/longitude`
  (WGS84 decimal degrees, nullable, DB CHECKs `-90..90` / `-180..180` mirror
  the DTO bounds). The partner rule lives in `RestaurantsService`:
  latitude+longitude must arrive together — a half pair (or one explicit
  `null`) is a 400 on both owner create and update; on update BOTH `null`
  clears the pin. The storefront `/map` (Leaflet, client-only chunk because
  Leaflet touches `window` at import) renders a `CircleMarker` per restaurant
  with a valid pair; missing/invalid coordinates are an off-map note, never
  a pin — and the web render re-validates the range even though the API
  guarantees it (session 70).
- **Cart lines are keyed by dish + selection** — `CartLine.lineKey` is
  `menuItemId` alone for option-less lines and `menuItemId|<sorted choice ids>`
  otherwise, so the same dish at two sizes is two independent lines. Every cart
  mutation (qty, merge-on-add, React keys) keys on `lineKey`, never `menuItemId`;
  persisted pre-options carts normalize to the new shape at hydration without
  losing lines. Displayed line price is `basePriceCents + Σ deltas`, always
  re-derived — a tampered stored `priceCents` never reaches the subtotal.
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
- **Cross-restaurant search is SERVER-side pg_trgm** (session 69) — public
  `GET /api/search?q=` matches a restaurant name/description/cuisine or an
  AVAILABLE dish name/description via trigram similarity (`col % q`, threshold
  0.3) OR word containment (`q <% col`, threshold 0.6 — query on the LEFT;
  `%<` was renamed in PG13) OR escaped-ILIKE substring, all served by GIN
  `gin_trgm_ops` indexes. Ranking is the server's `GREATEST(similarity,
  word_similarity…)` — clients render the returned order and NEVER rescore;
  restaurant hits embed the shared `hours`/`isOpenNow` derivation, dish hits
  carry a nested restaurant brief and integer-cents `priceCents`.
- **The storefront list path is CONSTANT-STATEMENT by contract** (session 79,
  query-logger-proven): `GET /restaurants` emits at most 3 statements per
  request regardless of `limit` (list + count + ONE batched-IN hours pass;
  an empty page skips the hours pass — nothing to batch) and
  `GET /restaurants/meta/cuisines` is a single `SELECT DISTINCT cuisine` —
  never a full-row entity load with in-process de-dup. The `search=` filter is
  `col ILIKE` with LIKE metacharacters escaped (identical case-insensitive
  substring semantics, pg_trgm-indexable); the `city=` filter is a single
  WHERE with an EXISTS semi-join — a `leftJoin` here would flip TypeORM into
  its DISTINCT-ids strategy and re-add a 4th statement.
- **Public browse routes publish server-derived SEO metadata** — each
  `/restaurants/:id` response uses the canonical restaurant row for its title,
  description, canonical URL, Open Graph card, and Twitter card. Missing
  restaurants are marked `noindex`. `app/sitemap.ts` lists the homepage and every
  live restaurant while degrading to the homepage if the API is temporarily
  unavailable; `app/robots.ts` points crawlers at that sitemap and excludes
  authenticated/customer workflow routes. `NEXT_PUBLIC_SITE_URL` is the one
  deployment origin used for every absolute URL (localhost is the dev fallback).
- **Storefront localization uses `next-intl` without locale-prefixed routes** —
  English (`en`) is the safe default and Indonesian (`id`) is selected from the
  shared header. A server action validates the requested locale and stores it in
  an HTTP-only, same-site cookie; `i18n/request.ts` rejects unknown cookie values
  back to English. This preserves every existing URL, cart link, callback, and
  SEO route while localizing metadata, shared header/footer, restaurant browse
  cards, restaurant detail/reviews, menu search states, and add-to-cart labels.
  The root `NextIntlClientProvider` gives client islands the same request locale
  as server components, and `<html lang>` follows the active choice.
- **Dark mode is server-selected and cookie-persisted** — the shared header
  submits a validated `light|dark` server action, storing the preference in an
  HTTP-only, same-site cookie. Root layout renders `data-theme` and `color-scheme`
  on the first response, so reloads and navigation do not flash the wrong theme.
  A global compatibility layer remaps the storefront's existing stone/pastel
  Tailwind utilities under the dark root, keeping cards, forms, status notices,
  and portal pages readable without client-side theme hydration.
- **The storefront is an installable PWA with a deliberately small offline
  boundary** — `app/manifest.ts` publishes standalone metadata plus 192/512 and
  maskable icons, while `PwaRegistration` registers `/sw.js` for every visitor
  (notification opt-in still requires its explicit user gesture). The existing
  push worker also owns versioned storefront caching: `/`, `/cart`, `/offline`,
  the manifest/icons, and visited Next static assets. Network-first navigation
  keeps those app-shell pages fresh when online; cached copies serve them when
  offline, while other failed navigations receive the neutral offline page and
  API requests are never cached. Cart rows remain device-local in the existing
  `CartProvider` storage, so a previously visited cart can be reviewed and edited
  offline; the cart surfaces connectivity state and states that checkout needs a
  connection. This avoids caching authenticated order/admin HTML or API truth.
- **Dead links and a dead API are different news** — storefront SSR never
  conflates "resource gone" with "API unreachable" (`isApiDown` in
  `lib/api.ts`: a non-`ApiError` network throw or any 5xx is the latter, the
  API's own 4xx is the former). `/restaurants/[id]` answers a HARD HTTP 404
  only when the API said 4xx (unknown id and malformed-uuid 400 both count
  as dead, by design); anything else renders the localized `ApiOffline` card
  at 200 with a "temporarily unavailable" title and deliberately NO noindex
  — the page revives with the API. Corollary the code must respect: no
  `loading.tsx` may sit ABOVE a segment that can call `notFound()`, because
  a Suspense boundary from any parent level flushes the shell with 200
  before the page settles, downgrading sitemap-visible dead restaurant links
  to soft-404s (and the hidden boundary template duplicates resolved
  content in the DOM, which breaks strict-mode locators). Both halves proven
  live against `next start` during the states audit (session 77): no
  boundaries -> unknown/malformed uuid = 404; API stopped -> offline card.
- **The portal surfaces hold the same line as the storefront** (session 91):
  a FAILED load may never render an empty state over missing data.
  `authedCall` errors carry `down` (the client twin of `isApiDown`), and
  `/driver` + `/dashboard/kitchen` own their list/board area with the
  localized `PortalOffline` card (same `api-offline` testid as the
  storefront) on down/5xx, `PortalLoadFailed` on other errors, skeletons
  while loading, and their empty cards ONLY after a successful load. The
  kitchen additionally shows one all-clear banner when every loaded lane
  totals zero; a Refresh that fails with data on screen keeps the last
  good board with the amber strip instead of blanking.
- **Order status machine** — transitions validated server-side
  (`pending→confirmed→preparing→delivering→completed`, cancellable through preparing).
  `POST /orders/:id/cancel` lets the *customer* use exactly that machine edge
  (own orders only — foreign/guest orders answer 404 so existence is not
  leaked); restaurant-side progression goes through the owner-scoped
  `PATCH /restaurants/:id/orders/:orderId/status` route, and the generic
  `PATCH /orders/:id/status` path is admin-only (it used to be open).
- **Receipt reads prove a key, never just the uuid** — `GET /orders/:id`
  answers for the order's own customer (bearer `sub`), for ADMIN (bearer +
  role), or for ANY viewer who presents the order's stored `contactEmail`
  normalized case-insensitively (collected at checkout; the storefront
  carries it as `?email=` in the checkout redirect, history links and the
  OrderVerify island). Everything else gets the same 404 as an unknown id —
  existence is never confirmed, matching the cancel route's convention.
  Orders stored without an email (legacy rows, API clients that omitted it)
  simply have no guest rung.
- **Driver assignment is a separate, exact-role API boundary** — users may carry
  the `driver` role, while orders keep a nullable indexed `driverId` FK to users
  (`ON DELETE SET NULL`). Owners (or admins through the established owner-route
  bypass) assign or clear a DRIVER-role account with
  `PATCH /restaurants/:id/orders/:orderId/driver`; restaurant ownership and
  order path scoping are rechecked server-side, and completed/cancelled orders
  are immutable. Drivers use `GET /driver/orders` with the standard status/page/
  limit query contract, always scoped to the verified JWT subject. The exact-role
  `DriverOnlyGuard` deliberately does **not** grant the normal admin bypass.
  `PATCH /driver/orders/:id/status` exposes only `preparing→delivering` and
  `delivering→completed`; missing and foreign assignments share the same 404,
  while illegal transitions are 400. `/driver` is the exact-role browser portal:
  it lists the verified subject's assignments, exposes only the two legal driver
  actions, and renders pickup/drop-off/items/notes from canonical GET responses.
  It uses the shared Socket.IO hook as a wake-up path and 10-second polling as
  fallback; the header exposes its Driver link only to DRIVER accounts.
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
- **Admin oversight is read-only and server-gated** — `GET /admin/overview` is
  protected by `JwtAuthGuard + RolesGuard @Roles(ADMIN)` and returns aggregate
  user/restaurant/order counts plus bounded newest rows (10 users, 10
  restaurants, 20 orders). `AdminService` maps accounts through `toSafeUser`,
  so password hashes never enter the response; order money remains integer
  cents. The web `/admin` route repeats the role gate for UX, exposes summary
  cards and three oversight tables, and the shared header only advertises it to
  admin sessions. API authorization remains authoritative for direct requests.
- **Account portability and deletion use explicit privacy boundaries** —
  `GET /users/me/export` is scoped only from the verified JWT subject and maps
  every response through an allowlist: profile, addresses, favorites, customer
  orders, payments made, reviews, owned restaurants/menu, driver assignments,
  issued refunds, refresh-session metadata, and push endpoints. It never emits
  password hashes, refresh-token hashes, Web Push key material, raw tokens, or
  gateway client secrets. `DELETE /users/me` requires the current password plus
  the exact `DELETE` confirmation and executes in one transaction. Address,
  favorite, review, refresh-session, and push rows cascade; order/payment/refund
  audit rows survive through their existing `SET NULL` links. Before deletion,
  customer order snapshots are anonymized and refund-admin email snapshots are
  cleared; affected restaurant review aggregates are recomputed after the review
  cascade. The last admin cannot self-delete, and owners/drivers must first clear
  active orders/assignments. Existing signed access JWTs remain cryptographically
  valid until their normal short expiry, but refresh is revoked immediately and
  account-backed reads fail once the user row is gone.
- **Status-change auditing is append-only** — every accepted order status
  transition writes an `order_status_audits` row (`fromStatus`/`toStatus`, a
  constrained `source` of `owner`/`admin`/`driver`/`customer`/`stale_sweep`, and
  an actor snapshot of userId/role/email) from the same code path that saves the
  order: restaurant-owner route, driver route, generic admin route, customer
  cancel, and both stale-sweep entry points (HTTP ops route and the cron script).
  Rejected transitions never write a row. `orderId` cascades on deletion while
  `actorUserId` is `SET NULL`, so account erasure keeps the history with its
  email snapshot; `(orderId, createdAt)` and `actorUserId` indexes back timeline
  and actor queries.
- **Feature flags are DB-backed and deterministic** — `feature_flags` stores a
  unique key, global enabled switch, and constrained integer rollout percentage
  from 0 through 100. `FeatureFlagsService.isEnabled(key, subjectId)` fails
  closed for missing/disabled flags and partial rollouts without a stable
  subject. For a partial rollout, SHA-256 of the separated key and subject id
  assigns one stable 0–99 bucket; including the key keeps experiments
  independent for the same account. The module exports the helper for future
  product surfaces without exposing flag mutation publicly or using per-request
  randomness.
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
  The inbox is LIVE through the Socket.IO restaurant room, with the SSE stream
  as its push fallback and a 10s poll as the final safety net. Every
  `order.created` / `order.updated` event fires one debounced silent refetch
  (`PUSH_SYNC_DEBOUNCE_MS` in `lib/live-sync.ts` coalesces bursts; a wake-up
  arriving while hidden/busy is remembered and flushed when the gate opens).
  Polling idles while either push transport is connected. Responses are
  dropped when the view (restaurant / filter / page) changed mid-flight, and
  a sync that started before a successful status action is discarded so the
  card never regresses.
- **Kitchen display is an active-order projection of the owner inbox** — the
  tablet-friendly web `/dashboard/kitchen` route reads the same guarded inbox
  endpoint in three parallel status slices (up to 50 each), sorts oldest first,
  and maps `confirmed` → Queued, `preparing` → Preparing, and `delivering` → Out
  for delivery. Large single-tap actions advance only the legal forward edge;
  completion removes the card. Pending acceptance/cancellation remains in the
  full Orders inbox, so unpaid or unaccepted work never appears on the prep
  board. The existing Socket.IO restaurant room wakes debounced board refetches;
  a wake-up received while an action is in flight is remembered and flushed
  afterwards, a 10s poll covers feed outages, and stale pre-action responses
  are discarded.
- **Owner analytics are completed-order SQL aggregates** —
  `GET /restaurants/:id/orders/analytics` uses the same JWT + OWNER role guard
  and service-side ownership check as the inbox (admins bypass both owner-role
  restrictions in the established way). Only `completed` orders contribute:
  `grossRevenueCents` is the all-time sum of the server-priced `totalCents`, and
  demand is grouped by the UTC hour of `createdAt`. The response always carries
  24 ordered hour buckets; the busiest hour is deterministic (earliest wins a
  tie) and null for an empty cohort. This is fulfilled-order gross revenue, not
  payment settlement after refunds. The web `/dashboard/analytics` page lets an
  owner switch restaurants and renders revenue, completed count, busiest hour,
  and an accessible hourly table; API authorization remains authoritative.
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
  endpoint before. Exact-role `subscribe:driver` joins `d:<sub>`; order events
  carry internal-only `driverIds` routing metadata that is never sent to clients.
  Assignment replacement includes both the previous and next driver, so an
  unassigned courier is woken to remove the card and a newly assigned courier is
  woken to add it. Driver status writes wake the current driver room. Guest orders
  (`userId` null on the event) fan out to the restaurant room only. No app-level
  heartbeat: Socket.IO pings at the
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
  fallback and no transport at all for guests or terminal orders. `/driver`
  selects the driver room through the same hook and uses the same WS→poll
  trigger/refetch model (there is no driver SSE endpoint).

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
- **Menu images upload directly to S3-compatible storage** — an owner editing
  an existing dish asks `POST /menu/items/:id/image-upload` for a five-minute
  presigned PUT. The API first reuses the normal dish ownership check, accepts
  only JPEG/PNG/WebP/AVIF metadata up to 5 MiB, and signs the exact content type
  and byte length; image bytes never transit the Nest process. The browser PUTs
  to storage with the returned headers, then saves only the returned public URL
  through the existing menu-item PATCH. An incomplete `S3_*` configuration
  keeps the API healthy but returns `503 IMAGE_STORAGE_DISABLED`; the bucket's
  CORS policy must allow the web origin to PUT with `Content-Type`.
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
  `order_items.menuItemId` FK is `ON DELETE SET NULL`). Menu-option picks follow
  the same rule as a `jsonb` `optionSelections` receipt
  (`{groupId, groupName, choiceId, choiceName, priceDeltaCents}`) frozen at order
  time with **no FK**, so deleting a group or a choice never rewrites past orders;
  the column is `null` for pre-options rows and for lines with no picks.
- **Option selections are optional-by-default** — seeded groups ship
  `minChoices 0` (a mandatory group with no client support would make the dish
  unorderable). Bounds live in two places and must match: DTO
  (`menu-option.dto.ts` constants) and migration CHECKs (`minChoices` 0..20,
  `maxChoices` 1..20 and >= min, `priceDeltaCents` 0..10_000_000 integer cents).
  The owner cannot starve a mandatory group either — deleting the choice that
  would drop a group below its own `minChoices` answers 400.
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
- **Public query-surface contract** (sessions 84 + 87) — every `@Query`
  site must be registered in `common/fuzz/query-surface-audit.spec.ts`
  with mechanical evidence of its guard: raw text reaching Postgres is
  delete-only-sanitized at the service (`common/query-sanitizer.ts` —
  NUL/lone-surrogate → 22021 → 500 class), raw numerics land on a closed
  integer range (`common/int-range.ts` — `clampToIntRange` +
  `MAX_PUBLIC_PAGE`; unbounded `Number(page)` math bound OFFSET past
  bigint → 22001/22P02 → 500 class), query enums are allowlisted in
  memory before any write, and guest-proof strings are compared in JS
  memory only — never bound into SQL. A new `@Query` parameter without a
  registry entry fails CI; hostile inputs are proven inert against the
  real driver in `common/fuzz/` HTTP sweeps + the live smokes.
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
- **Request metrics (in-process, no dependency)** — `common/metrics/`
  records per route TEMPLATE (matched Express path,
  never concrete ids; unmatched paths normalized + a 250-key cap folds
  overflow into `other`): counts, status-class tallies (2xx/3xx/4xx/5xx) and
  a cumulative duration histogram (fixed 5ms–10s bounds + Inf). `/api/health`
  is ignored, matching the access logger. Two consumption surfaces read the
  SAME registry: the compact `{bucket, status_class}` summary is folded into
  the existing pino access line (no second stream; ORDER-SENSITIVE — the
  metrics middleware must be registered before `pino-http` so its `finish`
  listener decorates `res.metrics` first), plus a periodic aggregate line
  `event: "request_metrics"` every `METRICS_LOG_INTERVAL_SEC` (default 60,
  `0` disables the fold, garbage falls back to default — never crashes boot)
  and pull-based ADMIN `GET /admin/metrics`. Snapshots are cumulative
  since boot by design — and DURABLE since session 89:
  `MetricsPersistenceService` writes the full snapshot to the
  `metrics_snapshots` table (jsonb payload + capturedAt + the producing
  registry's bootStartedAt) every `METRICS_SNAPSHOT_INTERVAL_SEC` (default
  300, `0` disables, garbage→default never crash-boots) and prunes rows
  older than `METRICS_SNAPSHOT_RETENTION_SEC` (default 24h; `0` counts as
  garbage). The DELETE clause must reference the RAW quoted column
  (`"capturedAt" < :cutoff`), never the query alias — this TypeORM's
  DeleteQueryBuilder drops the alias from FROM, leaving `snap.capturedAt`
  a live "missing FROM-clause entry" error. `GET /admin/metrics` adds
  `durability` + `window` fields (strictly additive — the pre-existing
  snapshot shape never changed, so the admin TrafficPanel is untouched):
  the window is exact subtraction of the NEWEST SAME-BOOT row from the
  live totals; a row stamped by a previous boot yields `window=null`
  until the new process writes its first row (a restart can never inherit
  a false baseline), and store read failures degrade to
  `durability.error=true` with the route still 200 — a dead smoke detector
  must never 5xx like a fire. On top of the snapshots sits the DI-free alert engine
  `ops/alerts.ts` (session 86): three rules — `error_budget` (5xx rate vs
  the 99.5% availability SLO, gated by a minimum sample), `p95_latency`
  (histogram estimate vs ceiling) and `route_key_overflow` (cardinality-cap
  folding, a warning) — evaluated from env-resolved thresholds
  (`ALERT_5XX_RATE_PCT_MAX` / `ALERT_P95_MS_MAX` / `ALERT_MIN_REQUESTS`,
  read once at boot; garbage falls back, never crash-boots). ONE engine,
  three consumers that can never disagree: ADMIN pull route
  `GET /admin/alerts` (full report), the compact `{status, firing}` verdict
  folded into every `request_metrics` line (push), and the scheduler poller
  `ops/alert-scan.sh` → `src/scripts/alert-scan.ts` whose exit codes split
  `0 healthy · 1 alerting · 2 scan broken` so a broken smoke detector never
  pages like a fire. systemd examples: `ops/systemd/foodorder-alert-scan.*`.
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
  platform-managed: ADMIN-only CRUD at `/api/admin/promos` (list with live
  `usageCount`, create, PATCH where an omitted field keeps its value and an
  explicit `null` CLEARS expiry/caps) plus the read-only redemption ledger at
  `GET /admin/promos/:id/usages` — no owner access, owners must not mint or
  widen their own discounts. Definition: `percent` (1..100 of subtotal,
  optional `maxDiscountCents` cap) or `fixed` cents-off, gated by
  `minSubtotalCents` (checked against the PRE-discount subtotal, so a promo
  can't bypass a restaurant minimum either — that check still runs first) and
  optionally scoped to one restaurant (`restaurantId` null = platform-wide);
  `isActive=false` is the kill switch; `startsAt`/`expiresAt` form the
  redemption window (start INCLUSIVE, end EXCLUSIVE — equality with
  `expiresAt` rejects); `maxTotalUsages`/`maxPerUser` are redemption caps
  counted on the append-only `promo_usages` ledger (one row per consumed
  discount, unique per order, integer-cents snapshot; `userId` null = guest
  or GDPR-erased account — guests consume the total cap but are never
  per-user capped, since there is no provable identity to cap).
  `PromosService.evaluate` is the single decision point, called by
  `OrdersService.create` with the SERVER-computed subtotal plus the caller
  identity — the client's numbers are never consulted; a rejected code 400s
  the whole order. An applied code appends the ledger row AFTER the order is
  saved (FK needs the id); the count→insert window for simultaneous
  "last redemption" orders stays open until the order-create transaction
  lands. The applied code + `discountCents` are denormalized onto
  the order (text snapshot, not FK — receipts survive promo deletion). The
  discount is clamped to the subtotal: delivery fees are never discounted.
  `POST /promos/validate` is a soft-200 preview for the checkout UI (valid
  payloads add `startsAt`/`expiresAt`/`remainingUsages`; a bearer token
  additionally applies the per-user cap check). Seed ships demo codes for
  every gate (WELCOME10 per-user-capped + WARUNGHEMAT expiring + expired
  EXPIRED25 + not-yet-started NEXTWEEK5 + cap-1 FLASH3OFF) and writes a
  ledger row for every promo-coded seed order. Web: promo input in the
  checkout summary (apply/Enter, stale-cart reset, inline reason), discount
  line on the receipt `/orders/[id]`.
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
restaurants(1)──(N)restaurant_hours  (weekly windows [opensAt, closesAt) per dayOfWeek 0..6, closesAt <= opensAt wraps past midnight; CHECK domains mirror the DTO (HH:MM 24h regex), UNIQUE (restaurantId, dayOfWeek), FK ON DELETE CASCADE; a missing weekday row = closed; restaurants.timeZone (varchar 64, IANA, null = server-local) is the interpretation zone; NO rows at all = the legacy manual isOpen column governs)
menu_items(1)──(N)menu_option_groups(1)──(N)menu_option_choices  (both FKs ON DELETE CASCADE + indexed on the child side; a group carries minChoices/maxChoices/position, a choice carries priceDeltaCents/position — money columns integer cents with CHECK bounds mirroring the DTO)
order_items(1)──(jsonb)optionSelections  (denormalized receipt array, NOT a relation: no FK, so option rows can be deleted without touching order history)
users(1)──(N)reviews(1)──(1)orders(1)──(1)restaurants  (reviews: unique orderId, all FKs ON DELETE CASCADE; restaurants.rating/ratingCount are recomputed server-side on every review write)
restaurants(1)──(N)promo_codes  (restaurantId nullable: null = platform-wide, FK ON DELETE CASCADE; code unique uppercase; startsAt/expiresAt redemption window (timestamptz, nullable), maxTotalUsages/maxPerUser integer caps nullable with CHECK >= 0; orders keep promoCode/discountCents text+int snapshots, no FK)
promo_codes(1)──(N)promo_usages  (append-only redemption ledger: one row per consumed discount — the caps are counted on this table, never a mutable counter; promoId FK ON DELETE CASCADE, orderId FK ON DELETE CASCADE + UNIQUE (an order redeems at most one code once), userId FK ON DELETE SET NULL (GDPR erasure keeps the total count alive), discountCents integer-cents snapshot CHECK >= 0; indexed (promoId) and (promoId, userId))
orders(1)──(N)payments  (payments.orderId FK ON DELETE CASCADE; payer payments.userId FK ON DELETE SET NULL — audit row survives user deletion; providerRef UNIQUE nullable (null only when intent creation itself failed); amountCents = server snapshot of orders.totalCents at intent time; status enum pending|succeeded|failed|refunded; refundedCents/refundedAt accumulate refunds on the same row, CHECK 0..amountCents; indexed (orderId, createdAt) for the per-order history list)
payments(1)──(N)payment_refunds  (refund audit ledger — one append-only row per LANDED refund, written in the same transaction as the payment-row CAS update; paymentId FK ON DELETE CASCADE, indexed (paymentId, createdAt) for the chronological read; providerRefundRef varchar(128) snapshot — nullable, deliberately NOT unique: a schema rule must never reject a refund the provider already executed; amountCents > 0 CHECK; refundedAfterCents running balance; actingAdminId FK SET NULL + actingAdminEmail JWT snapshot for attribution outliving the account)

Roles: `customer` (default), `owner`, `admin`. Owner-only routes guarded by `JwtAuthGuard` + `RolesGuard` (`@Roles(UserRole.OWNER)`); ADMIN bypasses `@Roles`. Owners create/update only their own restaurants (`PATCH /restaurants/:id` returns 403 unless caller owns the row). `slug`/`rating`/`ownerId` are not owner-writable — slug auto-derived and de-duplicated (`-2`, `-3`…) at create.
Multi-city scope is registry-backed: public `GET /cities` returns active cities; owner restaurant create/update accepts a validated active `cityId` and atomically stores both the FK and display-name snapshot. `GET /restaurants?city=` matches the registry slug or name (case-insensitive), with a legacy text fallback only for rows whose `cityId` is null.
Dish ownership is **derived through the parent restaurant** (menu_items carries no owner column): owner menu routes `POST /restaurants/:id/menu`, `PATCH /menu/items/:id` (content only), `PATCH /menu/items/:id/availability`, `DELETE /menu/items/:id` all check `MenuService.assertCanManage`; platform restaurants (`ownerId null`) are admin-only. Route params that must be uuids are screened by `common/uuid.ts isUuid` → 404 instead of a raw Postgres 22P02 500.
