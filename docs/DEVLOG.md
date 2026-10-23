# DEVLOG

Newest entries on top. Format: `YYYY-MM-DD HH:MM — slot — summary`.

---

## 2026-10-23 09:29 — Session 19

**Built:** Phase 3 item 3 — **order tracking timeline UI (status steps with
timestamps)**.

- API: five write-once step columns on the order entity
  (`confirmedAt`/`preparingAt`/`deliveringAt`/`completedAt`/`cancelledAt`,
  nullable TIMESTAMP) + `OrdersService.applyStatus(order, status)` — sets
  `status` and stamps the step's column **only if not already set**. All three
  transition paths (owner `setStatusForRestaurant`, customer `cancel`, admin
  `updateStatus`) now go through it; rejected transitions never reach it, so
  they stamp nothing. The `pending` step stays `createdAt` — no column for it.
- Migration `AddOrderStatusTimestamps1792719166289` (generated, DDL reviewed):
  adds the 5 columns, then backfills rows already past pending — the step the
  order currently sits in gets `updatedAt` (that write *is* the transition),
  earlier steps get `createdAt` (true lower bound), pending untouched.
  `down()` drops the columns. Seed's 7 demo orders now also get plausible
  spread-out step times via `seedStepStamps` so a fresh dev DB has a live
  timeline out of the box.
- Web: `components/OrderTimeline.tsx` (server-safe, no hooks) — vertical
  `<ol>` of Placed → Confirmed → Preparing → On the way → Delivered with
  green check dots + local-time stamps for reached steps, an amber pulse +
  "waiting…" on the next expected step, grey "—" for future ones, and a red
  terminal **Cancelled** node after the reached prefix when cancelled;
  `aria-current="step"` + `sr-only` progress summary. Wired into
  `/orders/[id]` as an "Order progress" card ("Reload to check for updates"
  hint — this page has no SSE yet); hero flips to ❌/"cancelled" copy for
  cancelled orders. `lib/api.ts` `Order` type gained the 5 nullable fields.

**Verified:**
- `nest build` clean; `jest` **223/223** (6 new specs in a
  "status-step timestamps" describe: single-step stamping, full
  pending→completed walk stamps each step once and never re-stamps,
  write-once vs a backfilled value, customer cancel, admin path, rejected
  transition stamps nothing — all under fake timers for exact stamps).
- Migration applied to dev DB; psql shows all 7 seeded orders backfilled
  correctly per status (pending all-null; completed all four; cancelled
  `cancelledAt=updatedAt`).
- Runtime smoke (API on :4000) — **16/16 checks** via python/urllib:
  guest order pending→all stamps null; owner confirm/prepare stamps +
  monotonicity; illegal preparing→completed 400 and stamped nothing;
  failed replay left `confirmedAt` unchanged; full walk to completed;
  customer cancel stamps `cancelledAt` only; backfilled rows visible
  through `GET /orders/:id` and the owner inbox (FO-SEED1/4/6). One smoke
  script bug found mid-run (search `q=warung` returns Ayam Goreng via
  description match — pinned the owner's restaurant by exact name; the API
  behaved correctly).
- Web: `next build` clean; live `next start` :3000 browser test on three
  seeded orders — completed (5 green checks + times, no pulse), pending
  (Placed ✓, pulse on Confirmed "waiting…", sr-only "1 of 5 steps
  reached"), cancelled (❌ hero, red Cancelled node with time, intermediate
  steps "—").

**Left for next sessions:** the customer order page is still reload-to-update
(SSE is owner-side only) — a customer-facing live update or auto-poll is
follow-up polish; next roadmap item — reviews.

---

## 2026-10-22 19:56 — Session 18

**Built:** Phase 3 item 2 — **Favorites (heart on dishes + `/users/me/favorites` API)**.

- API: new `Favorite` entity (`user_favorites`: unique `(userId, menuItemId)`,
  cascading FKs to users and menu_items) + migration
  `AddUserFavorites1792669513778` (generated, DDL reviewed, applied to dev DB).
  `FavoritesService` + three Bearer routes on `UsersController`:
  `GET /users/me/favorites` (flat dish+restaurant rows, newest first),
  `POST /users/me/favorites` (`{menuItemId}`, `@HttpCode(200)`, idempotent —
  `created:false` on re-add, `created:true` on insert, 404 for unknown dish,
  unique-violation 23505 absorbed as the already-there case for the
  double-click race), `DELETE /users/me/favorites/:menuItemId` (idempotent
  `removed:true/false`, non-uuid path id → 404 via `isUuid` before Postgres).
  DTO `AddFavoriteDto` carries `@IsUUID('4')` (whitelist-safe). Seed now gives
  the demo customer 3 hearts; TRUNCATE list covers `user_favorites`.
- Web: `FavoritesProvider` (`lib/favorites.tsx`) — one fetch per signed-in
  session, optimistic toggle → server merge, rollback + resync on failure,
  per-dish in-flight lock, load-seq guard against stale responses across
  user switch/logout. `FavoriteButton` (♡/♥, `aria-pressed`, label flips;
  guests route to `/login?next=<menu path>`). Hearts wired into `MenuBrowser`
  rows; new `/favorites` page (guest card, skeleton, empty state, rows with
  restaurant link + un-heart + Add-to-cart); "Saved" link in the header.

**Verified:**
- `nest build` clean; `jest` **217/217** (new `favorites.service.spec.ts` 9
  tests: list shape/defensive filter, add created/re-add/race-23505/non-unique
  rethrow/404-dish, remove both outcomes).
- Migration: `migration:run` on dev DB (table + unique + 2 cascade FKs);
  `npm run seed` rebuilt with 3 favorites; API booted 0 pending.
- Runtime smoke (API on :4000) — **18/18 curl checks**: unauth 401 envelope,
  seeded total=3 + row shape + newest-first, add→created:true→re-add→
  created:false (200)→total=4, bad-uuid 400, unknown dish 404, remove→
  removed:true→re-remove removed:false→back to 3, garbage path id 404,
  cross-account isolation (fresh user sees 0).
- Web: `next build` clean; live browser test (`next start` :3000) — seeded
  hearts render pressed=true on Warung menu, click ♡ on Rendang → pressed
  true, `/favorites` shows 4 newest-first, un-heart there → 3 rows (and
  server list shrank), Add-to-cart from the page bumps the badge, guest
  heart-click redirects to `/login?next=`, guest `/favorites` shows the
  sign-in card. One real bug caught and fixed mid-verification: the skeleton
  was gated on `status==='signedIn' && pending`, so the loading state painted
  nothing.

**Left for next sessions:** next roadmap item — order tracking timeline UI.

---

## 2026-10-22 17:55 — Session 17

**Built:** Phase 3 item 1 — **dish search within the restaurant page +
category anchors**.

- `apps/web/components/MenuBrowser.tsx` (new, client) — takes the whole
  restaurant (the page already fetches the full menu, so filtering is pure
  in-memory; no new API). Sticky toolbar under the global header
  (`top-[63px]`, measured live) with: search input (name/description/category,
  case-insensitive), Clear button + Escape-to-clear, `aria-live` match count
  ("n of m dishes match"), and a category chip bar that anchors to the
  sections. Chips render only when >1 category is visible, and always mirror
  the filtered set (anchor ids are positional `cat-<i>` from the unfiltered
  grouping, so they stay stable while typing). Empty-state card with a
  "Clear search" action when nothing matches; the "no menu items yet" state
  is preserved.
- `apps/web/app/restaurants/[id]/page.tsx` — server component keeps the hero
  section; the old static category loop moved into `MenuBrowser`. Sections
  get `scroll-mt-[172px]` so anchor jumps land below the stacked
  header+toolbar (header 63px + toolbar ~100px).
- Add-to-cart behaviour untouched: `AddToCartButton` renders inside the
  filtered rows, cart rules (single-restaurant, switch modal) unaffected.

**Verified:**
- `next build` clean (only web changed; API untouched).
- Live stack smoke (Postgres service + `node dist/main.js` on :4000 +
  `next start` on :3000): `/api/health` db up; SSR HTML of
  `/restaurants/<warung-id>` contains the search input, 3 anchored sections
  (`id="cat-0..2"`) and 3 matching chip links.
- Real-browser interaction test (headless CDP): search "ayam" → 1 of 4
  dishes, live count text correct; nonsense query → "No dishes match" card,
  chips collapse to 0; anchor click `#cat-1` → scrollY 0→703, section top
  lands at 172px (clear of both sticky bars); sticky toolbar top == header
  bottom (63px) after the alignment fix; Escape clears the input; enabled
  Add buttons present in filtered rows. Screenshot reviewed — layout clean.

**Docs:** README storefront paragraph, ARCHITECTURE "in-page menu search is
client-side" decision bullet, ROADMAP item ticked.

**Left for next sessions:** Phase 3 item 2 — favorites (heart on dishes +
`/users/me/favorites` API: needs entity + migration + seed, its own session).

## 2026-10-22 16:33 — Session 16

**Built:** Phase 2 item 5 (SSE half) — **live order updates via server push**,
closing out Phase 2. The owner dashboard now subscribes to a real SSE stream;
the 10s poll stays as a transport that only runs while push is down.

- `apps/api/src/orders/order-events.service.ts` (new) — process-local rxjs
  bus, live-only (no replay). `ORDER_STREAM_HEARTBEAT_MS = 15_000`. Scope
  note in the file: single-container by design; multi-node realtime is the
  Phase 5 Socket.IO item.
- `OrdersService` publishes after every state-changing write: `create` →
  `order.created`; `setStatusForRestaurant` / `cancel` / `updateStatus` →
  `order.updated` — so a customer self-cancel or the admin ops route wakes
  the owner stream too. Payload is trigger-only
  (`{orderId, code, status}`): the dashboard always refetches the inbox GET
  for truth, so a dropped event costs latency, never correctness. Also
  exposed `assertStreamAccess` (same 404/403 gate as the inbox GET).
- `apps/api/src/common/sse-jwt-auth.guard.ts` (new) — `SseJwtAuthGuard`:
  EventSource cannot send headers, so the access token may ride
  `?access_token=`. Verification identical to `JwtAuthGuard` (`typ` claim
  enforced); Authorization header wins when both are present. Tradeoff
  (token in query → access logs) documented in ARCHITECTURE + code.
- `GET /restaurants/:id/orders/stream` (`@Sse` on
  `RestaurantOrdersController`) — guards `SseJwtAuthGuard + RolesGuard
  @Roles(OWNER)`, ownership asserted in the async handler BEFORE the
  observable returns (Nest 11 awaits async @Sse → rejections stay plain
  JSON 401/403/404, the stream never starts). Emits `hello`, filtered
  `order.created`/`order.updated`, `ping` every 15s.
- `apps/web/lib/live-sync.ts` — `shouldPoll` gained the `pushUp` term (the
  10s interval goes idle while the stream is connected = fallback only);
  new pure helpers `orderStreamUrl`, `liveMode` (pill state machine),
  constants `PUSH_SYNC_DEBOUNCE_MS=400`, `STREAM_STALL_MS=30_000` (2×
  server heartbeat — zombie detection), `STREAM_TOKEN_REBUILD_MS=15m`
  (well inside the 30m access TTL), `STREAM_MAX_CONSECUTIVE_ERRORS=3`.
- `apps/web/app/dashboard/page.tsx` — EventSource per (restaurant, live);
  named listeners on `order.created`/`order.updated` → `requestSync`
  (debounced coalescing: 5 events in a second = 1 GET; wake-ups arriving
  while busy/hidden are remembered via `missedPushRef` and flushed when the
  gate opens). `hello` (not `onopen`) is the push-up signal — proven
  end-to-end write — and fires an immediate catch-up sync. Any event resets
  the stall watchdog; two missed heartbeats → close, poll resumes, rebuild
  after 10s. Error path: `readyState CLOSED` (4xx — browser stops retrying)
  or 3 consecutive errors → rebuild with a FRESH token (stale-token
  reconnect loops are structurally impossible thanks to this + the 15m
  rebuild). Pause closes the stream AND the interval. Live pill now reads
  **Live · push** / **Live** (poll fallback) / Live · retrying / Paused.
  All session-15 race guards (viewKey epoch, stale-vs-action, applyPage
  single-writer) are reused untouched — push events ride the same
  `fetchInbox('silent')` path.

**Verified:**
- API: `nest build` clean; `jest` **208/208** (was 186) — new:
  `order-events.service.spec` (5: delivery, live-only, fan-out, unsubscribe,
  sane heartbeat), `sse-jwt-auth.guard.spec` (7: header/query/precedence/
  missing/empty/bad-signature/wrong-typ/array-param),
  `restaurant-orders.controller.spec` (3: reject-before-stream 403/404,
  hello-first, per-restaurant filtering), 7 emit/access cases in
  `orders.service.spec`.
- Web: `tsc --noEmit` + `next build` green; `live-sync` standalone assert
  run **32/32** (all 12 session-15 checks still pass + pushUp gating,
  liveMode table, stream-URL shape, constants).
- **Runtime SSE smoke vs live server** (`node dist/main.js` + local
  Postgres): **18/18** — stream opens with `hello`; `order.created` pushed
  on guest POST; `order.updated` on owner PATCH; **customer cancel wakes the
  owner stream**; `ping` observed within 17s; a foreign restaurant's order
  produced ZERO leaked events; 401 no-token / 403 customer-token / 404
  unknown rid / 403 foreign rid (all as JSON, stream never started);
  query-param token path authenticates. (3 initial "FAIL"s were my smoke
  script expecting 200 where the API legitimately returns 201 — fixed the
  script, not the app.)
- **Browser E2E** (Chromium vs `next start :3100` + API :4000, signed-in
  owner): pill reaches **Live · push**; two guest orders appeared with NEW
  badges in **507 ms / 512 ms** (vs ≤10s poll); pause → pill Paused, order
  FO-6AMT invisible for 13s; resume → visible in ~500 ms, pill back on
  push; UI Accept on FO-6AMT patched in place (Pending8→7, Confirmed2→3)
  and stayed Confirmed through the push-triggered sync 3s later (the
  stale-guard path survives the new transport). Servers killed after;
  E2E/smoke orders cancelled back to a clean baseline (one `SSE Foreign`
  guest order at a NON-owned restaurant remains — owner cannot patch it by
  design).

**Docs:** README portal line + stream endpoint row; ARCHITECTURE inbox
bullet rewritten for the two-transport contract + new Order stream (SSE)
bullet incl. the query-token tradeoff; ROADMAP item ticked — **Phase 2
complete** header added.

**Tooling note:** the transcript sanitizer again rewrote `Bearer <token>`
literals in outgoing tool args (3 test fixtures landed as `'***'` on
disk). Fixed by assembling `['Bearer', tok].join(' ')` at runtime in
`sse-jwt-auth.guard.spec.ts` — same pattern as the dotted-key fix.

**Left for next sessions:** Phase 3 item 1 (dish search within restaurant
page + category anchors); Phase 4 CI can be started any time now that both
phases are feature-green.

## 2026-10-22 12:46 — Session 15

**Built:** Phase 2 item 4 (polling half) — **live order updates on the
owner dashboard**: the inbox silently re-polls `GET /restaurants/:id/orders`
every 10s. SSE (the "→ then SSE" half) split out as its own unchecked item.

- `apps/web/lib/live-sync.ts` (new, pure + unit-testable) —
  `POLL_INTERVAL_MS = 10_000`; `diffNewOrderIds(prev, next)` (ids that
  appeared since the last tick, next-order preserved); `shouldPoll({live,
  hidden, busy})` gate; `pollIsStaleVsAction(fetchStart, actionDone)` —
  drops a poll snapshot fired BEFORE an owner action but resolving after it
  (would visibly regress the card the owner just accepted).
- `apps/web/app/dashboard/page.tsx` — `loadOrders` refactored into
  `fetchInbox(mode: 'full' | 'silent')`: full = today's visible load
  (skeleton + banner) on entry / view change / ↻ Refresh; silent = the tick
  (page swapped in place incl. tab counts, no skeleton). `applyPage` is the
  single writer of `data` + `dataRef` (the silent-diff baseline) so the two
  can never diverge — act() patches now route through it too. A `viewKey`
  (restaurant:filter:page) epoch drops straggler responses that resolve
  after the owner switched views — a pre-existing race polling would have
  amplified. One `setInterval` per (restaurant, live) with the tick swapped
  via `tickRef`, so filter/page/busy changes never re-phase the 10s cadence;
  ticks skip while `document.hidden` and `visibilitychange` catches up
  instantly; resuming from pause also syncs immediately.
- UI: **Live pill** (green pulsing dot / amber "Live · retrying" / gray
  "Paused") doubles as the pause toggle (`aria-pressed`), "updated HH:MM:SS"
  label, a small amber line when a tick fails while last-good data stays on
  screen, and a sky **NEW** badge (`role=status`) on cards that appeared
  since the previous tick (cleared by the next one).

**Verified:**
- `tsc --noEmit` + `next build` green — `/dashboard` 5.89 → 6.71 kB.
- Pure helpers: standalone `tsc` compile + node assert run — **12/12 pass**
  (diff ordering/empties, shouldPoll truth table, stale-guard boundary).
- API untouched; `jest` **186/186** still green.
- **Browser E2E** (Chromium vs `next start :3100` + API :4000 + local
  Postgres, signed in as demo owner, no page interaction during tests):
  guest order FO-X9U4 created via API at 12:43:09 → appeared on the open
  dashboard with NEW badge at the 12:43:15 tick (counts All6→8, Pending3→5,
  "updated" advanced); pause → order FO-UBZR invisible after 13s, pill
  "Paused", timestamp frozen → resume → caught up within 2s (All9/Pending6,
  1 badge); Accept on FO-X9U4 patched in place (Pending5/Confirmed1) and
  the NEXT tick kept it (no regression — stale-guard path live); 3 smoke
  orders cancelled via UI buttons, counts settled at Pending3/Cancelled5 =
  original baseline. Test servers killed after.
- E2E also caught a stale `.next` server (killed parent pid, next-server
  child survived → ChunkLoadError) — harness mishap, not an app bug; fixed
  by killing the real listener pid and rebuilding clean.

**Docs:** README portal line mentions live updates; ARCHITECTURE inbox
bullet gained the polling contract + race rules; ROADMAP item ticked, SSE
split out as new unchecked item.

**Artifacts left in dev DB:** three `Poll/Paused Smoke` guest orders
(FO-VV9A, FO-X9U4, FO-UBZR), all cancelled — same harmless demo noise as
earlier sessions.

**Left for next sessions:** Phase 2 item — SSE feed (server push replacing
the poll; UI already final). Menu rows could later get image thumbnails +
drag-reorder (polish pass).


## 2026-10-21 18:57 — Session 14

**Built:** Phase 2 item 3 — **owner menu management UI** at
`/dashboard/menu`: full dish CRUD against the existing owner endpoints
(no new API surface for the feature itself), plus one real API bug the
runtime smoke caught and fixed on the way.

- `apps/web/app/dashboard/menu/page.tsx` (new) — restaurant switcher +
  full dish list from `GET /restaurants/:id/menu` (UNFILTERED, so hidden
  drafts are visible to the owner), rows grouped by category in server
  order (category, name), per-row **Hide/Show** (first-class availability
  route), **Edit** and two-step **Delete** (Delete → Confirm/Keep, no
  window.confirm). Toggle + delete patch the list in place; create/edit
  refetch (renames can move a row between category groups). Single
  write in flight at a time (row buttons disable, `…` on the busy row);
  failures raise the amber banner; gating + skeletons mirror `/dashboard`
  (signed-out card, customer card, no-restaurant empty state, storefront
  deep link, dish/hidden counts in the subtitle).
- `apps/web/components/MenuItemForm.tsx` (new) — create/edit dialog for
  name*, price*, category (datalist of existing categories), description,
  imageUrl, prepMinutes (+ create-only "start as hidden draft" checkbox).
  Client mirrors DTO bounds but the server is authority (a rejected submit
  keeps the dialog open with typed values intact). Money via
  `parseMoneyToCents`/`centsToInput` in `lib/api.ts` — integer cents, no
  float math ("12.50" → 1250 by string split). Clearing category/
  description/imageUrl on edit sends explicit `null` (@IsOptional skips
  null; MenuService stores it). Escape/backdrop close; availability is NOT
  an edit field (it has its own route + row toggle).
- `apps/web/lib/api.ts` — `MenuItemInput` + `listRestaurantMenu`,
  `createMenuItem`, `updateMenuItem`, `setMenuItemAvailability`,
  `deleteMenuItem`; money helpers above.
- `apps/web/lib/authed-call.ts` (new) — the dashboard's rotate-and-retry
  auth helper EXTRACTED verbatim (no behavior change) so both portal pages
  share it; `apps/web/app/dashboard/page.tsx` now imports it and got the
  same `PortalTabs` nav (Orders ↔ Menu) as the menu page.
- `components/PortalTabs.tsx` (new) — two-pill portal section nav.
- **API fix** `apps/api/src/menu/menu.service.ts` — `remove()` returned the
  entity AFTER `repo.remove()`, and TypeORM nulls the primary column on the
  disposed entity, so `DELETE /menu/items/:id` answered 200 with JSON
  **missing `id`**. Now snapshots `{ ...item }` before deletion.
  `menu.service.spec.ts` — repo `remove` mock now reproduces that
  in-place PK mutation (the old identity mock was hiding the bug): reverting
  the service fix makes 'owner deletes own dish' FAIL (red→green proven),
  and the runtime smoke covers the real TypeORM path.

**Verified:**
- `next build` green — `/dashboard/menu` 7 kB (First Load 113 kB),
  `/dashboard` still 5.89 kB after the helper extraction.
- `jest` **186/186 pass** (16 suites) after the spec-mock change; targeted
  RED proof: with the snapshot line reverted, menu suite = 1 failed, with
  the fix = 31/31; full suite green again before commit.
- API rebuilt (`nest build`), booted on :4000 against local Postgres.
- Runtime smoke (`scratch/smoke_menu_crud.py`, **24/24 PASS**, live
  curl-equivalents as the demo owner): create dish + create hidden draft;
  draft visible in owner list view; update incl. `null`-clear of category;
  hide/show toggle; guest order of the updated dish priced from the EDITED
  price (3500¢); DELETE returns the full dish now; deleted dish absent
  from menu; **order line snapshot survives the delete** (name+price kept,
  menuItemId FK nulled); no-token → 401; customer token create/edit/delete
  → 403; owner editing/deleting a Sushi Kan (foreign) dish → 403;
  whitespace name → 400; priceCents 0 → 400; whitelist strips body
  `restaurantId`/`evil` → dish still lands under the URL restaurant.
  Temp dishes cleaned up; menu count restored to baseline.
- `next start -p 3100` served `/dashboard/menu` HTTP 200 (auth-gated
  client shell renders its skeleton server-side, as designed; killed after).

**Docs:** README now lists both demo accounts + the portal (orders inbox and
menu manager, server-side gating noted); ARCHITECTURE gained the
owner-menu-manager bullet (incl. the TypeORM `remove()` PK-nulling trap);
ROADMAP Phase 2 item 3 ticked.

**Artifacts left in dev DB:** one `Smoke Menu` guest order (completed dish
deleted, snapshot intact) — same harmless demo noise as earlier sessions.

**Left for next sessions:** Phase 2 item 4 — 10s polling → SSE for the
dashboard. Menu rows could later get an image thumbnail + drag-reorder
(polish pass). (Checked, no issue: hidden dishes still render on the
storefront but `AddToCartButton` disables them and `OrdersService` rejects
ordering an unavailable dish with 400 — verified by grep of both paths.)


## 2026-10-21 15:19 — Session 13

**Built:** Phase 2 item 2 — **owner status actions on the dashboard inbox**
(accept / start preparing / out for delivery / complete / cancel), closing the
security gap session 12 flagged: restaurant-side transitions now go through a
scoped, authenticated route and the previously-open generic route is admin-only.

- `apps/api/src/orders/orders.service.ts` — `setStatusForRestaurant(restaurantId,
  orderId, status, actor)`: restaurant 404 → ownership 403 (admin bypass) →
  order 404 if it lives under a DIFFERENT restaurant than the path (existence
  of foreign order ids is not leaked) → `STATUS_FLOW` 400 → save. Ownership
  check extracted into `getOwnedRestaurant`, now shared with
  `findForRestaurant` (identical semantics, no behavior change to the inbox).
- `apps/api/src/orders/dto/set-order-status.dto.ts` (new) — `@IsEnum(OrderStatus)`
  on the `status` query param: junk values get a clean 400 from ValidationPipe
  instead of falling through to the service's generic message.
- `apps/api/src/orders/restaurant-orders.controller.ts` —
  `PATCH :orderId/status` with `JwtAuthGuard + RolesGuard @Roles(OWNER)`
  (customer token → 403; admin passes the role gate and relies on the
  service-side bypass — RolesGuard lets ADMIN through any @Roles list).
- `apps/api/src/orders/orders.controller.ts` — **hardening:** `PATCH /orders/:id/status`
  was completely unauthenticated; now `JwtAuthGuard + RolesGuard @Roles(ADMIN)`
  as the ops backdoor. No code in web/seed called it (grep confirmed).
- `apps/web/lib/api.ts` — `setRestaurantOrderStatus(token, rid, oid, status)`.
- `apps/web/app/dashboard/page.tsx` — per-status action buttons on inbox cards
  from an `OWNER_ACTIONS` map mirroring STATUS_FLOW (server is still the
  authority): pending → Accept + Cancel, confirmed → Start preparing + Cancel,
  preparing → Out for delivery + Cancel, delivering → Mark completed, terminal
  statuses → none. Success patches the card's status AND the tab counts in
  place (no refetch flash); one action in flight at a time (all buttons
  disabled, busy card shows `…`); failures raise an amber alert banner;
  401s use the shared rotate-and-retry `authedCall`. Subtitle no longer says
  "read-only".
- Tests: 15 new jest specs (`OrdersService.setStatusForRestaurant` describe):
  each legal edge ×4, owner-cancel ×3 + delivering-cancel refused, illegal
  back-migrations leave orders untouched, 403-before-load + admin bypass on
  an unowned restaurant, cross-restaurant order 404, unknown-restaurant /
  malformed-order-id / missing-order 404s without a save, guest order
  (userId null) actionable by the restaurant owner.

**Verified:**
- `nest build` clean; `jest` **186/186 pass** (16 suites; orders suite 36).
- `next build` green (`/dashboard` 5.37 kB).
- API booted on :4000 against local Postgres; new route mapped in startup log.
- Runtime smoke (`/home/ubuntu/.hermes/cache/scratch/smoke_owner_actions.py`,
  25/25 PASS, live curl-equivalents): full chain
  pending→confirmed→preparing→delivering→completed on a fresh guest order at
  the demo owner's Seoul Street; back-migration from completed → 400; junk
  status value → 400; skip-ahead pending→delivering → 400; owner cancel
  pending→cancelled → 200; no-token → 401; customer token → 403; owner
  PATCHing a foreign restaurant's path → 403; foreign order id under the
  owner's path → 404; generic `PATCH /orders/:id/status` → 401 unauth / 403
  owner / 403 customer.
- Three "Smoke ..." guest orders left in the dev DB (A completed, B cancelled,
  C pending at Sushi Kan — invisible in the demo owner's inbox); harmless
  demo noise, same as earlier sessions' smoke artifacts.

**Docs:** README route table (new owner-action row; generic status row marked
admin-only), ARCHITECTURE status-machine + owner-inbox bullets, ROADMAP item 2
ticked.

**Left for next sessions:** Phase 2 item 3 — menu management UI (CRUD against
the existing owner menu endpoints); then item 4 — 10s polling → SSE. The
dashboard could also show an "order moved" hint when a card's status leaves
the active tab filter — minor polish.

## 2026-10-21 14:00 — Session 12

**Built:** Phase 2 items 1 + 5 (the dashboard can't exist without its API,
so both landed as one vertical slice) — **owner portal `/dashboard` orders
inbox** backed by **`GET /restaurants/:id/orders`** scoped to the owner.

- `apps/api/src/orders/orders.service.ts` — `findForRestaurant(restaurantId,
  actor, query)`: ownership enforced server-side (unknown/garbage id → 404,
  foreign restaurant → 403, admin bypass), same `ListMyOrdersDto`
  status/page/limit as `findMine`, plus a per-status `counts` map computed
  over ALL statuses so inbox tabs stay accurate while a filter is active.
- `apps/api/src/orders/restaurant-orders.controller.ts` (new) —
  `@Controller('restaurants/:id/orders')` with `JwtAuthGuard + RolesGuard
  @Roles(OWNER)`; lives in OrdersModule (which already imports
  RestaurantsModule) to avoid a module cycle. Registered in `orders.module.ts`.
- `apps/web/lib/api.ts` — `listMyRestaurants` + `listRestaurantOrders` and
  the `RestaurantOrdersPage` envelope type (`counts: Record<OrderStatus, number>`).
- `apps/web/app/dashboard/page.tsx` (new) — client page: auth-gated (guest →
  sign-in prompt with `?next=/dashboard`; customer role → "portal is for
  restaurant owners" card), loads `/restaurants/mine` (empty → owner empty
  state), restaurant switcher when the owner has 2+, status tabs with live
  count badges, newest-first order cards (code, badge, time, full line list,
  customer/phone/address/note block, total incl. delivery), Details link to
  `/orders/:id`, Prev/Next pagination, manual ↻ Refresh. 401 → rotate-and-
  retry once, terminal 401 signs the device out (shared `authedCall` helper).
  Read-only by design — accept/complete actions and 10s polling are the next
  portal items.
- `apps/web/components/Header.tsx` — "Dashboard" nav link only for
  owner/admin roles.
- `apps/api/src/database/seed.ts` — 7 demo orders across statuses: 4 at Warung
  Nusantara + 2 at Seoul Street (both owned by `owner@foodorder.app`) and 1 at
  Sushi Kan (NOT owned — proves scoping on a fresh clone); FO-SEED1 is attached
  to `demo@foodorder.app` so customer history has data too. Integer-cent
  snapshots mirror `OrdersService.create`.

**Verified:**
- `nest build` clean; jest 16 suites / 173 tests pass — 5 new
  `findForRestaurant` specs (404 before any query, 403 non-owner + admin
  bypass, strict restaurant scoping, newest-first pagination + limit clamping,
  status filter with all-status counts).
- `next build` green (9/9 pages, `/dashboard` prerenders as client shell).
- Dev DB rebuilt via `npm run seed` (6 restos, 27 dishes, 7 orders) and API
  restarted on :4000 from the new build. Curl smoke as owner: `/restaurants/
  mine` → 2 restaurants; Warung inbox → total 4, counts
  {pending 1, confirmed 1, preparing 1, completed 1}, items carry line items;
  `?status=pending&limit=5` → FO-SEED1 only, counts unchanged; foreign
  restaurant → 403; garbage id → 404 envelope; no token → 401;
  `?status=bogus` → 400 validation message; customer token → 403
  "Insufficient role". Regression: `/orders/my` as demo shows seeded FO-SEED1.
- Real-browser E2E (`next start :3217` + live :4000): owner login → header
  shows Dashboard → Seoul Street inbox renders (tabs All2/Pending1/
  Cancelled1, cards FO-SEED5/6); switch to Warung → All4 tabs + FO-SEED4→1
  newest-first, Sushi Kan's FO-SEED7 absent; Pending tab → FO-SEED1 only +
  "1 order pending" footer; Details → `/orders/:id` with correct $28.00 +
  $3.00 = $31.00 server-priced totals. Customer account: no Dashboard link,
  /dashboard renders the owner-only card; guest: sign-in prompt.
- Test web server stopped; :4000 API left running; browser localStorage cleared.

**Docs:** README endpoint table + ARCHITECTURE "Owner inbox scoping" bullet,
ROADMAP items 1 and 5 ticked.

**Left for next sessions:** Phase 2 item 2 — owner status actions
(accept/start/deliver/complete/cancel from the inbox; the open
`PATCH /orders/:id/status` route is currently unauthenticated and should get
the same owner guard when wired); then menu management UI, then 10s polling.

## 2026-10-21 10:49 — Session 11

**Built:** Phase 1 item 10 (last one — **Phase 1 complete**) — **cart
persistence across restaurant switches via a confirmation modal**.

- `apps/web/lib/cart.tsx` — `add()` no longer silently wipes the cart when a
  dish from a *different* restaurant is added. It now returns
  `'added' | 'needs-switch'`; on foreign items it raises a `switchRequest`
  (item snapshot + target restaurant) and leaves the cart untouched.
  New `confirmSwitch()` replaces the cart with a single line for the pending
  item, `cancelSwitch()` dismisses. Same-restaurant adds keep the previous
  merge/qty-cap behavior. localStorage key + hydration logic unchanged.
- `apps/web/components/CartSwitchModal.tsx` (new) — presentational
  `role=dialog aria-modal` rendered by `CartProvider` (no import cycle:
  dialog imports only the `SwitchRequest` *type* from cart.tsx). Body names
  both sides of the switch with live numbers — "Your cart holds N items from
  X ($Y)… adding Z from W would discard your current cart" — plus a
  "New cart would contain" preview card. Focus lands on **Keep current
  cart** (safe default); Escape and backdrop click both cancel; card click
  is stop-propagated.
- `apps/web/components/AddToCartButton.tsx` — flashes "Added ✓" only on the
  `'added'` result, so a blocked switch never pretends the dish went in.

**Verified:**
- `next build` green (8/8 pages).
- Real-browser E2E (`next start :3217` + live :4000 API + seeded DB):
  - 2 items added at Warung Nusantara → badge 2; navigate to Sushi Kan →
    Add → dialog "Start a new cart?" with exact copy "2 items from Warung
    Nusantara ($43.00)" + Salmon Nigiri $19.00 preview; badge stayed 2
    (cart not wiped);
  - **Escape** → dialog gone, badge 2 · **Keep current cart** → dialog gone,
    badge 2 · **Replace cart** → badge 1, `/cart` shows "From Sushi Kan" +
    the nigiri line, $19.00 subtotal;
  - reload → cart persisted (badge 1, From Sushi Kan);
  - regression: two adds from the *same* restaurant → no dialog, badge
    increments normally;
  - a11y attributes confirmed live: `aria-modal=true`,
    `aria-labelledby/describedby` wired, autofocus on Keep.
- Test web server stopped; :4000 API left running; browser localStorage
  cleared after E2E.

**Docs:** ROADMAP item ticked + Phase 1 marked complete, ARCHITECTURE
one-restaurant-cart bullet rewritten to describe the confirm flow.

**Left for next sessions:** Phase 2 begins — owner dashboard route
(`/dashboard`) orders inbox (first unchecked item).

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
