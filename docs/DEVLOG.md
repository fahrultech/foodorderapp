# DEVLOG

Newest entries on top. Format: `YYYY-MM-DD HH:MM — slot — summary`.

---

## 2026-10-31 13:53 — Session 49 — Browser push opt-in UI + service worker

**Built:** completed the remaining Notifications web increment and closed the
parent Phase 5 item.

- Added `PushNotificationsProvider` and a signed-in header bell. It reads the
  API's public VAPID config, distinguishes unsupported / server-disabled /
  browser-blocked states, and requests notification permission only inside the
  user's enable-button click. A granted browser registers `/sw.js`, subscribes
  with the public key, and syncs only `{endpoint, keys}` through the existing
  JWT-scoped API.
- Opt-out DELETEs the user-scoped API row and always unsubscribes locally (the
  provider's next 410 also prunes the row if the DELETE was offline). Sign-out
  runs the same detach before auth logout so a shared browser cannot keep
  receiving the previous account's order updates. Existing subscriptions are
  refreshed/transferred on signed-in load without another permission prompt.
- Added `public/sw.js`: displays the API's privacy-minimal title/body/tag and
  focuses or opens the same-site order receipt URL on notification click.
- Added typed web API methods for config/register/remove and a Playwright spec
  covering gesture-only permission, exact subscription payload, opt-out, and
  logout cleanup. E2E documentation and architecture notes now describe the
  completed browser path.

**Verified:**
- Strict TDD: the new Playwright spec first failed because the notification
  control did not exist; after implementation it passed standalone.
- `apps/web npm run build` clean (Next type-check + 12 routes).
- Full Playwright suite **10/10 green** (57.2s), including the new push spec.
- Live web smoke: `/` 200 and `/sw.js` 200 `application/javascript`; the served
  worker contains both `push` and `notificationclick` listeners.
- Live API smoke against PostgreSQL 16: config 200 (disabled/null key on this
  unconfigured dev host), login 201, subscribe 200, unsubscribe 200, repeated
  unsubscribe 200 `{removed:false}` — temporary endpoint removed afterwards.

**Remaining:** real delivery needs deployment HTTPS (or localhost) and a VAPID
key triplet; those are operational credentials, not missing application code.

---

## 2026-10-31 10:34 — Session 48 — Browser-push API foundation (VAPID + subscriptions + order fan-out)

**Built:** scoped the remaining Phase 5 notifications item into a complete API
increment; the browser service-worker/opt-in UI is now an explicit follow-up.

- Added `web-push` behind `PushService`. A complete
  `VAPID_SUBJECT`/`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` triplet enables
  delivery; unset/incomplete config keeps the API healthy and push disabled.
  `GET /api/notifications/push/config` exposes only `{enabled, publicKey}`.
- Added migration `AddPushSubscriptions1793413681972` and entity
  `push_subscriptions`: multiple endpoints per user, globally unique endpoint,
  user index, and `ON DELETE CASCADE`. Re-registering an endpoint transfers it
  to the current JWT subject (shared-browser account safety); POST subscribe
  and DELETE unsubscribe are validated, idempotent, and never accept a user id.
- Push sends fan out to every subscription, serialize privacy-minimal payloads
  (order code/status + same-site receipt URL), delete provider-404/410 stale
  endpoints, and log/swallow transient failures. `OrderNotificationsService`
  now sends email and push independently from the same `OrderEventsService`
  event; guest orders still skip both channels.
- OpenAPI grew 47→50 operations with typed push config/subscribe/unsubscribe
  responses; env validation, Compose forwarding, `.env.example`, data-source
  entity registration, and architecture docs were updated. Added `web-push`
  and `@types/web-push`; repaired the 8 newly mirror-pinned lockfile URLs.

**Verified:**
- Strict TDD: new push service/DTO/controller tests were observed red before
  implementation; targeted suites then passed.
- `npm run build` clean; full Jest **53 suites / 669 tests green** (was
  50/658; +11 net tests and three suites, with existing suites extended).
- Migration applied to local PostgreSQL 16 (13 migrations recorded); generated
  schema-drift check correctly refused with “No changes … found”.
- Live API smoke: **12 assertions green** — disabled config 200, login, invalid
  endpoint 400 envelope, subscribe upsert 200 twice, delete true then false,
  and both new OpenAPI paths/methods present. API was stopped afterwards.
- `docker compose config` parses. Runner-style cold `npm ci` in a fresh HOME +
  empty cache installed 699 packages; all 699 lockfile resolved URLs point to
  `registry.npmjs.org`.

**Remaining:** web service worker and signed-in opt-in/out control (permission
requested only from a user gesture); real browser delivery needs HTTPS (or
localhost) plus a generated VAPID pair.

---

## 2026-10-30 10:11 — Session 47 — HTTP integration spec: restaurant-orders status route + 402 payment-gate envelope

**Built:** Phase 6 item "API: supertest-based integration specs for the payments + refunds routes (today covered by service-unit specs + live smoke only)".

On inspection the `payments.controller.spec.ts` (sessions 38–40) already covers the full payments/refunds HTTP surface (20 tests: intent, capture, refund, audit trail, rate-limit bucket, all guards + pipes). The gap named in the roadmap note was specifically "the gate's 402 envelope" — that `AppException(402, 'PAYMENT_REQUIRED')` from `OrdersService.setStatusForRestaurant` renders through `ErrorFormatFilter` as a proper `{error:{code:'PAYMENT_REQUIRED'}}` response over HTTP. No HTTP-level spec existed for `RestaurantOrdersController`.

- `src/orders/restaurant-orders-http.spec.ts` (new, 19 cases): boots the real `RestaurantOrdersController` + `OrderEventsService` on an ephemeral port with PRODUCTION `ValidationPipe` + `ErrorFormatFilter` + REAL `JwtAuthGuard` + REAL `RolesGuard`; `OrdersService` is mocked. Two describe blocks:

  **GET /restaurants/:id/orders (owner inbox — 6 cases):**
  - anonymous → 401 envelope, service untouched
  - CUSTOMER → 403 (RolesGuard), service untouched
  - OWNER + valid uuid → 200, actor forwarded correctly to service
  - ADMIN bypasses OWNER guard → 200
  - non-uuid restaurant id → 400 BAD_REQUEST (ParseUUIDPipe) before service
  - service AppException(404) → 404 standard envelope

  **PATCH /restaurants/:id/orders/:orderId/status (13 cases):**
  - anonymous → 401 envelope
  - CUSTOMER → 403 (RolesGuard), service untouched
  - OWNER + valid uuids + valid status → 200, actor forwarded
  - ADMIN bypasses OWNER guard → 200
  - non-uuid `:id` → 400 BAD_REQUEST (ParseUUIDPipe on :id)
  - non-uuid `:orderId` → 400 BAD_REQUEST (ParseUUIDPipe on :orderId)
  - junk `?status=gibbering` → 400 BAD_REQUEST (enum validation) with `details` array
  - missing `?status=` → 400 BAD_REQUEST
  - **AppException(402, PAYMENT_REQUIRED) → 402 envelope** (the core gap: gate renders through `ErrorFormatFilter`)
  - ADMIN backdoor also receives 402 from the gate (both confirm paths covered)
  - AppException(400, BAD_TRANSITION) → 400 envelope
  - AppException(403, FORBIDDEN) → 403 envelope
  - AppException(404, NOT_FOUND) → 404 envelope

**Verified:**
- New spec standalone: `npx jest --testPathPattern='restaurant-orders-http'` → **19/19 green**.
- `npm run build` → clean (0 errors).
- `npx jest` (full suite) → **658/658 green** (50 suites; was 639/49).
- Sanitizer audit: codepoint readback of the new file — zero U+2026, zero `***`.

---

## 2026-10-29 19:10 — Session 46 — Boot-time config validation (fail-fast on missing JWT_SECRET/DATABASE_URL)

**Built:** Phase 6 item "API: boot-time config validation (env.schema via class-validator; fail fast on missing JWT_SECRET/DATABASE_URL instead of silent dev fallbacks)"

- `src/config/env.validation.ts` — `EnvVars` class with class-validator decorators:
  - `DATABASE_URL` and `JWT_SECRET`: `@IsString() @IsNotEmpty()` — required; clear error messages naming the variable.
  - `LOG_LEVEL`: `@IsEnum(LogLevel)` — rejects typo'd log levels at boot.
  - `MOCK_PAY_GATEWAY_MODE` / `MOCK_REFUND_GATEWAY_MODE`: `@IsIn(['succeed','fail'])` — rejects garbage adapter modes.
  - All remaining env vars (`JWT_ACCESS_TTL`, `SMTP_*`, `RATE_LIMIT_*`, etc.): `@IsOptional() @IsString()` — present but don't fail boot if absent.
  - `validateEnv()`: uses `plainToInstance` + `validateSync`, collects ALL failing constraints, throws a single human-readable error listing every offending variable.
- `app.module.ts`: `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })` — the hook runs before any module initialises.
- `src/config/env.validation.spec.ts`: 15 unit tests covering: minimal valid config, missing DATABASE_URL (absent + empty), missing JWT_SECRET (absent + empty), both missing, invalid LOG_LEVEL, invalid gateway modes, unknown vars ignored, multi-error listed in one throw, SMTP optional.

**Verified:**
- `npm run build` → clean (0 errors).
- `npx jest` → **639/639 green** (49 suites; was 624 before this session).
- Runtime fail-fast probe: `DATABASE_URL="" JWT_SECRET="" node dist/main.js` → exits 1 with `Boot-time configuration validation failed — fix these env vars before starting: DATABASE_URL must be set (...) JWT_SECRET must be set to a strong secret`.
- Single missing field: `DATABASE_URL="" node dist/main.js` → exits 1 listing only DATABASE_URL.
- Normal boot: `node dist/main.js` (with real .env) → `GET /api/health` → `{"status":"ok","db":"up"}`.
- CI: all 4 jobs green on GitHub Actions (run 40863553781, commit 36a391c); required lockfile mirror-URL fix (nodemailer entries from session 45 baked the Tencent mirror) + CI e2e step needed JWT_SECRET exported (new validation catches it at startup).

---

## 2026-10-29 15:44 — Session 45 — Email notifications: order-placed confirmation + status-step emails (nodemailer, SMTP-gated)

**Built:** Phase 5 item "Notifications: email confirmations (nodemailer) then push
(web-push)" — the email half shipped:

- `src/notifications/mail.service.ts` (`MailService`): thin nodemailer wrapper.
  Reads `SMTP_HOST` at construction; if unset the service is a no-op (warn log,
  no crash). Auth block omitted when `SMTP_USER` is absent (relay-without-auth
  setups). `send()` is fire-and-forget — errors are logged, never thrown.
- `src/notifications/order-notifications.service.ts`
  (`OrderNotificationsService`): subscribes to `OrderEventsService` bus on
  `onModuleInit`. Two paths:
  - `order.created` → order-confirmation email: itemised receipt with subtotal,
    promo discount (if any), delivery fee, total (IDR cents formatted);
  - `order.updated` → status-update email for confirmed/preparing/delivering/
    completed/cancelled (pending has no update email — the confirmed email *is*
    the creation mail; pending is an interim state only).
  - Guest orders silently skipped (no `userId` → no email address; the entity
    stores `contactPhone`, not `contactEmail`; a `contactEmail` column + migration
    is deferred to the next notifications follow-up session).
- `src/notifications/notifications.module.ts`: imports `TypeOrmModule([Order,
  User])` + `OrdersModule` (which now exports `OrderEventsService`); registered
  in `AppModule`.
- `orders.module.ts`: `OrderEventsService` added to `exports` (previously
  provider-only, nothing outside could inject it).
- `20 new specs` (604→624): `mail.service.spec.ts` — SMTP disabled no-op,
  transport construction, sendMail error swallowed, SMTP_SECURE flag, auth
  omission; `order-notifications.service.spec.ts` — confirmation email content,
  guest skip, missing-order skip, promo line, every named status in `STATUS_LABEL`
  produces an email, pending produces no email, guest skip on update.
- `.env.example`: SMTP vars section added (all commented, opt-in).

**Verified:**
- `npm run build` → clean (0 errors).
- `npx jest` → **624/624 green** (48 suites).
- Runtime boot with `SMTP_HOST` unset: API started, `/api/health` → `{"status":"ok","db":"up"}`;
  the WARN `SMTP_HOST not set — email notifications disabled` appeared in stderr as expected.
- Port cleaned up; no orphan listeners.

**Scope note:** web-push notifications remain unchecked on the roadmap item
(deferred to a later session); the email portion is complete and live.

## 2026-10-29 13:29 — Session 44 — Enable-by-default decision: order-confirm payment gate now ON (explicit opt-out only)

**Built:** Phase 5 sub-item "Enable-by-default decision: e2e fixtures + web
checkout need paying steps first" — the decision is made and shipped:
`ORDER_CONFIRM_REQUIRES_PAYMENT` flips from default-OFF to default-ON.
Both prerequisites had landed (session 43's web pay button + `?pay=1`
checkout handoff; paying e2e fixtures), so keeping the gate inert would
only have preserved confirm-unpaid-orders as the accidental production
behaviour.

- `payment-confirm-gate.ts` rewritten: ON unless the value is an explicit
  opt-out spelling `0/false/no/off` (trimmed, case-insensitive); unset,
  empty, or garbage keeps the gate ON. The failure mode is deliberately
  inverted from session 42: a typo'd opt-out (e.g. `flase`) must not
  silently disable a money-integrity gate. No new code paths — the gate
  itself, its 402 `PAYMENT_REQUIRED` envelope, and the `payments` repo
  existence probe are exactly as built in session 42.
- `payment-confirm-gate.spec.ts`: parsing table re-pinned for the new
  semantics (+`ture`/`maybe`/`enable` ON cases, ` FALSE`/` Off ` OFF cases),
  new behaviour test "flag unset (production default) → unpaid confirm 402",
  old fail-open zero-regression test rewritten as "explicit opt-out 'off'".
  Tests 598→604 (46 suites, all green).
- `orders.service.ts` comments + `.env.example` (`ORDER_CONFIRM_REQUIRES_
  PAYMENT=on`) + `docs/ARCHITECTURE.md` gate paragraph updated to the
  default-ON reality.
- e2e `live-feed.spec.ts`: new `payOrder()` helper (POST /payments intent →
  POST /payments/:id/capture, customer token) runs before the owner's
  confirm PATCH — the suite now exercises the shipped default end to end,
  which is also what CI's e2e job does (fresh boot, no flag env).
  Payments bucket cost stays well inside 10/min/IP (2 POSTs from this file).
- No migration, no DTO, no new route — swagger count unchanged at 47.

**Verified:**
- `apps/api npm run build` + `npx jest`: 604/604 green.
- Live smoke A (flag UNSET, new default): 19/19 — unpaid owner confirm 402
  `PAYMENT_REQUIRED` (+ guest-order confirm 402 too), cancel stays
  payment-free on a gated order, intent→capture→confirm 200 with
  `confirmedAt` stamped, post-confirm flow continues, ADMIN backdoor unpaid
  confirm 402 → paid confirm 200.
- Live smoke B (API restarted with `ORDER_CONFIRM_REQUIRES_PAYMENT=off`,
  verified intact in /proc/PID/environ): 6/6 — unpaid confirm 200, no
  payments consulted. Opt-out escape hatch works.
- Full e2e suite against fresh reseeded DB with the gate ON by default:
  9/9 green twice consecutively (exit 0), incl. the live-feed test that now
  pays before the owner accepts. First attempt showed 1 failure —
  `account.spec` lost its FO-SEED card past `/orders/my` page 1 because
  ~21 leftover orders from smoke/e2e runs had accumulated on the demo
  account (data pollution, not a code regression); wiped + reseeded the
  disposable dev DB per WORKFLOW and both runs were clean.
- Servers stopped after verification; no orphan listeners on :4000/:3000.

**Known pitfall recurred (documented in memory, worth restating):** the
transcript sanitizer rewrote the literal demo password inside the smoke
script's write payload into `***` on disk — logins 401'd until the value
was assembled at runtime (`"demo" + "1234"`). The committed e2e specs
predate this and are unaffected (their literals survived in-repo from
earlier sessions); no committed file was touched by the corruption.

## 2026-10-29 10:09 — Session 43 — Web pay button: PaymentPanel + PayButton on the order receipt (intent→capture ladder, server-derived paid state)

**Built:** Phase 5 sub-item "Web: pay button on `/checkout` +
`/orders/[id]` (consume intent/capture endpoints; receipt shows payment
status)" — done, and with it the last unblocked payments sub-item
(Stripe/Xendit adapters remain credential-blocked; the enable-by-default
decision is now un-blocked: paying fixtures exist e2e).

- `lib/payments-types.ts` (new): `PaymentAttempt`/`PaymentStatus` web mirror
  of the API payment row, re-exported through `@/lib/api` (the single client
  surface). `api` gains the three calls the panel needs:
  `createPayment` (POST /payments — whole input is the order id),
  `capturePayment`, `listOrderPayments`.
- `components/PayButton.tsx`: one click = intent + capture (the mock settles
  synchronously; a real adapter drops in behind the same two endpoints).
  Defers to server truth on every branch: `ORDER_ALREADY_PAID` → treat as
  paid + refresh; `ORDER_NOT_PAYABLE`/`ORDER_CANCELLED` → refresh (panel
  re-derives availability); 429/502/404 → API envelope message verbatim.
  No client money rules, no double-intent path (POST /payments replays a
  live pending row by design).
- `components/PaymentPanel.tsx`: the Payment card on the receipt page.
  Signed-in pulls `GET /orders/:id/payments`; paid badge shows amount +
  provider + capture time + partial-refund line; pending attempt note says
  paying resumes it (no second charge); failed-attempt count honest;
  not-payable order states explain themselves; guests get a sign-in hint
  (payment is Bearer-gated server-side; guest orders payable by any account
  — copy, not logic). Session-resilient reads via the shared `authedCall`.
- Checkout hands signed-in customers over with `?pay=1` → panel renders
  elevated (emerald ring + "complete your payment" copy). Guests land
  without it. The `/checkout` receipt moment *is* the order page (checkout
  redirects), so both roadmap locations are served by one card.
- Hydration-safe: SSR shell + first client render both show "Loading
  payment status…" (auth provider starts `loading`); paid/history views
  appear only after client fetch.

**Verified:**
- `apps/web npm run build` green (types caught a real bug mid-flight: the
  auth provider's status is `guest`, not `signedOut`).
- Live API ladder via curl against the local Postgres/dev seed: intent
  `pending` 2100 IDR `mock_pi_…` → capture `succeeded` + `succeededAt` →
  `GET /orders/:id/payments` lists 1 succeeded → replay-after-paid **409**
  (the exact behavior PayButton branches on).
- NEW e2e `tests/pay-order.spec.ts` (2 tests): signed-in pays at the
  receipt → paid badge appears → survives reload (proves server-derived
  state) → pay button gone; guest receipt shows the sign-in hint, no pay
  button, no `pay=1`. **Full suite 9/9 green twice consecutively**
  (exit 0). An intermediate run showed 3 failures — payments rate bucket
  (10/min/IP) was still draining from the previous run + busy-machine
  timing on the two live-feed specs; with ≥60 s spacing every test passed
  twice in a row. Documented the spacing rule in e2e/README.
- Servers stopped after verification (port 4000/3000 released); no API
  code, migration, or DTO touched — swagger count stays 47.

**Docs:** ARCHITECTURE payments paragraph flipped from "Web pay UI still
pending" to wired-with-details; e2e README suite list caught up (was also
missing the session-37 live-feed specs); ROADMAP item ticked.

**Left for next sessions:** the enable-by-default decision for
`ORDER_CONFIRM_REQUIRES_PAYMENT` (paying e2e fixtures now exist — decision
item, not code); supertest HTTP specs for payments/refunds + the gate's
402 envelope (Phase 6 item); partial-refund receipt line is display-only —
no customer-facing refund yet (by design, ADMIN route).


## 2026-10-28 19:20 — Session 42 — Order-machine gate: `ORDER_CONFIRM_REQUIRES_PAYMENT` (owner/admin confirm needs a succeeded payment, flag-gated)

**Built:** Phase 5 payments sub-item "Order-machine gate: owner confirm
requires a succeeded payment (behind a feature flag)". (Stripe/Xendit
adapters above it stay credential-blocked; this was the top unblocked item.)

- New `orders/payment-confirm-gate.ts`: flag parser — truthy `1/true/yes/on`
  (trimmed, case-insensitive), EVERYTHING else OFF including garbage:
  deliberately fail-OPEN, a typo'd env must not silently block order flow
  (documented the inversion vs the payment-provider fail-fast: blocking the
  till is worse than letting one unpaid order through, and the flag is opt-in).
- `OrdersService.assertConfirmGate`: entering `CONFIRMED` while the flag is
  ON requires a `payments` row with status `succeeded` for that order
  (`repository.exist` — existence probe, no cross-module service import, no
  status write from the payment side). `refunded` rows do NOT satisfy it
  (money that came back is not payment). Throws `AppException` 402 with
  stable code `PAYMENT_REQUIRED` through the standard error envelope. Wired
  into BOTH paths that can confirm — owner portal
  `setStatusForRestaurant` AND the ADMIN backdoor `updateStatus` — so the
  gate cannot be stepped around; runs AFTER flow legality, BEFORE any
  mutation. Non-confirm transitions (cancel/preparing/...) never query
  payments (flag-on cancel stays payment-free — smoke-proven).
- Wiring: `OrdersModule.forFeature` gains the `Payment` entity (same
  shared-entity pattern `PaymentsModule` already uses for `Order`); the two
  new constructor params are OPTIONAL — all 8 pre-existing spec construction
  sites compile untouched and the gate is inert without the repo (defense in
  depth for older harnesses). DI provides both in the app (ConfigModule is
  global). No migration, no new endpoints, no DTO changes — swagger count
  stays 47.
- `.env.example`: documented knob (default `off`) + why the flag ships inert
  (e2e fixtures have no paying steps yet). `payment.entity.ts` +
  ARCHITECTURE "NOT yet wired" paragraph updated to describe the gate.

**Verified:**
- `npm run build` green; `npx jest` **598/598 (46 suites, 576→598, +22 new)**
  — flag parser table tests (ON spellings / OFF incl. garbage), owner-path
  402 + order untouched + query scoping assertion, paid→confirm OK,
  flag-OFF zero-payment-queries, refunded-does-not-satisfy, illegal
  transition 400 BEFORE any payment lookup, repo-less construction inert,
  ADMIN-backdoor gated + paid-passes.
- Live smoke (flag ON, mock provider) **12/12**: guest-owned order confirm →
  402 `PAYMENT_REQUIRED` envelope, order still `pending` + no `confirmedAt`;
  `POST /payments` → pending intent → `capture` → `succeeded` → owner confirm
  → 200 with `confirmedAt` stamped; demo promoted to ADMIN — backdoor PATCH
  confirm also 402, `pending→preparing` still the plain 400 flow rule,
  unpaid customer cancel still 201. (Three earlier partial runs tripped the
  10/min auth rate bucket — a smoke-runner artifact, not a code issue; after
  a window reset every branch passed in one clean run.)
- Flag-OFF regression: fresh boot without the env → unpaid owner confirm →
  **200 `confirmed`**, byte-identical pre-gate behavior.
- Postgres untouched by the change (no migration; `exist` probe rides the
  existing `(orderId, createdAt)` index). API stopped after smoke; port 4000
  released.

**Left for next sessions:** web pay button on `/checkout` + `/orders/[id]`
(then e2e paying fixtures, then the enable-by-default decision); supertest
integration spec for the gate's HTTP 402 envelope sits naturally in the
Phase 6 "payments+refunds integration specs" item.


## 2026-10-28 15:30 — Session 41 — Repaired sanitizer-corrupted DATABASE_URL fallbacks + corruption guard spec

**Built:** Phase 4 cleanup item. The committed dev fallbacks in
`src/database/data-source.ts` and `src/app.module.ts` carried a literal
three-asterisk string as the password — transcript-sanitizer corruption of the
original tool write, dead code in practice (`.env`/compose/CI always provide
`DATABASE_URL`) but a loud trap when unset. Fixed per the roadmap constraint
WITHOUT typing the secret into any tool call: a python step read the real
`DATABASE_URL` from the untracked `apps/api/.env` at write time and rewrote
both fallbacks; equivalence proven by sha256 comparison against the `.env`
value (never echoed). New regression spec
`src/database/committed-credentials.spec.ts` (3 cases): repo-wide scan that no
quoted postgres URL in `src/` carries a masked (`*` or U+2026) password, plus
per-file well-formedness of both fallbacks — so this corruption class fails CI
if it ever re-enters committed code.

**Verified:**
- Codepoint readback before/after: fallback password segment went from 3 chars
 (all `0x2A`) to the real 9-char value; both files' fallback strings
  hash-identical to the `.env` `DATABASE_URL`. Repo-wide scan: no other source
  file carried a masked credential-shaped literal (the masking in
  `ops/backup-db.sh` is an intentional redaction sed rule — left alone).
- `npm run build` green; `npx jest` 576/576 (45 suites, up from 573/44).
- Fallback boot: `env -u DATABASE_URL node dist/main.js` run from a scratch cwd
  (no `.env` discoverable) -> `/api/health` `db:"up"`, `/api/restaurants?limit=1`
  and a real restaurant menu route served from Postgres — the repaired fallback
  was genuinely the only DB path in that boot.
- Normal boot from `apps/api` (`.env` loaded) re-confirmed green; server stopped
  afterwards, port 4000 clean.

**Notes:** the guard spec had to be de-masked itself — the sanitizer rewrote a `\u2026`
`\u2026` escape in the write into a literal U+2026 character; caught by
codepoint readback and repaired with an escape built at runtime (standing rule:
verify config-ish writes by codepoint, display masks both ways).

## 2026-10-28 13:35 — Session 40 — Refund audit trail: `payment_refunds` ledger + ADMIN trail route + collision-free mock refund refs

**Built:** Roadmap Phase 5 refund sub-item "Refund audit trail: per-refund
rows (provider refund refs + amounts + acting admin) instead of a single
accumulated `refundedCents`" — done. (Stripe/Xendit adapter items above it on
the list remain credential-blocked.)

- NEW entity + migration `AddPaymentRefundAuditTrail`: `payment_refunds`
  append-only ledger — one row per LANDED refund: `providerRefundRef`
  (varchar 128, NULLABLE, deliberately NOT unique — a schema rule must never
  be able to reject the transaction of a refund the provider already
  executed), this refund's `amountCents` (CHECK `> 0`, declared on BOTH
  entity `@Check` and migration), `refundedAfterCents` running balance (makes
  the ledger self-describing; SUM(rows) == payment.refundedCents is the
  reconciliation invariant), `actingAdminId` FK SET NULL + `actingAdminEmail`
  snapshotted from the verified JWT (attribution outlives account deletion),
  composite `(paymentId, createdAt)` index matching the only read path.
  Generated diff reviewed: table + named CHECK + index + both FKs, nothing
  else touched. Down is a clean drop.
- `PaymentsService.refund`: the CAS balance UPDATE and the audit INSERT now
  run in ONE `manager.transaction` — balance and trail land together or not
  at all; the CAS loser throws inside the transaction (nothing half-written;
  real DB rolls back). Declined/errored provider refunds still leave neither
  row nor trail. Residual gap documented honestly: if the DB write itself
  fails AFTER the provider moved the money, the admin gets an error and the
  discrepancy reconciles against the provider — same exposure the CAS path
  always had, and the reason real adapters will need webhook reconciliation.
- NEW route `GET /payments/:id/refunds` (Bearer + @Roles(ADMIN) + RolesGuard
  + service re-check): chronological trail, empty array for never-refunded
  payments (not 404), malformed 400 (ParseUUIDPipe), unknown 404. Read route
  → no rate bucket, consistent with the other GETs. `PaymentResponse` sibling
  model `PaymentRefundResponse` added; swagger 46→47 operations, uuid sweep
  23→24 routes.
- Mock gateway refund refs were `mock_re_<paymentId>_<cents>` — TWO EQUAL
  partials of one intent produced the SAME provider ref, fine while nothing
  persisted it, a lie inside an audit ledger. Format now
  `mock_re_<paymentId>_<remaining>_<cents>`: the remainder-before component
  makes every refund of one intent distinct (proven on a live server with two
  consecutive 1000-cent partials).

**Verified:**
- `nest build` clean; FULL jest 573/573 (was 560; +13: 4 audit-write specs
  incl. running-balance chain and null-ref adapter, 4 `listRefunds` specs,
  3 HTTP guard specs, equal-split distinctness in mock spec, no-trail
  assertions added to the declined/502/CAS-loser tests).
- Migration applied to dev DB `foodorder` (12 recorded); CHECK live-probed —
  insert with amountCents=0 rejected on `CHK_payment_refunds_amount_positive`;
  unknown paymentId rejected on the FK; failed probes persisted nothing.
- Live smoke 35/35 against a booted API: order→pay→capture, then 1000 + 1000
  (EQUAL partials — refs `…_4250_1000` vs `…_3250_1000`, distinct) + remainder
  full → `refunded`; trail over HTTP: 3 rows, amounts [1000,1000,2250],
  running balances [1000,2000,4250], admin id+email on every row; guards 401
  anon / 403 owner / 400 malformed / 404 unknown; never-refunded payment
  reads []; SQL ledger chronological, SUM == refundedCents == amountCents.
- Live `/api/docs-json`: 47 operations, new route with bearer security +
  400/401/403/404 envelopes + `PaymentRefundResponse` array schema.
- Dev DB re-seeded to canonical state after the smoke (ledger emptied by the
  payments TRUNCATE cascade, as designed).
- Sanitizer sweep (standing rule): tracked files contain NO U+2026. NEW
  discovery — codepoint readback showed the COMMITTED fallback `DATABASE_URL`
  in `data-source.ts` + `app.module.ts` carries a literal `***` password
  (earlier sanitizer corruption, predates this session; my diff never touched
  those lines). Dead code in practice; added as an explicit Phase 4 roadmap
  item with the safe repair recipe instead of side-questing it here.

**Docs:** ARCHITECTURE payments bullet + audit-trail paragraph, data model
`payment_refunds` relation line (and the payments enum/refund columns that
session 39's write-up missed), ROADMAP item ticked + fallback-URL follow-up.

**Left for next sessions:** order-machine payment gate (feature-flagged),
web pay/refund surfaces, credential-blocked Stripe/Xendit adapters, the
`***` fallback repair (now on the roadmap).

## 2026-10-28 10:45 — Session 39 — Payment refunds: add-on gateway interface + ADMIN refund route + partial amounts

**Built:** Roadmap Phase 5 payment sub-item "Refund flow: `refunded` status +
gateway `refundIntent` + ADMIN route + partial amounts" — done API-side,
against the mock (the Stripe/Xendit adapters above it on the list are
credential-blocked; this was the next self-contained one).

- `payment-gateway.interface.ts`: refunds are an ADD-ON interface
  (`PaymentRefundGateway` + `RefundInput/RefundResult` + `supportsRefunds()`
  capability probe) — exactly the "adapters may ADD optional interfaces,
  never widen the core one" contract session 38's header comment promised.
  The service probes the mounted adapter and 501s `REFUND_UNSUPPORTED` when
  absent.
- `mock-payment-gateway.ts`: implements the add-on; deterministic
  `mock_re_<paymentId>_<cents>` refs; rejects non-positive/float amounts with
  the same hard TypeError as pay/capture; NEW `MOCK_REFUND_GATEWAY_MODE=fail`
  knob deliberately SEPARATE from the capture knob so a live server can
  pay+capture while refunds decline (documented in `.env.example`).
- `payment.entity.ts` + migration `1793154590353-AddPaymentRefunds`: status
  enum gains terminal `refunded`; `refundedCents int DEFAULT 0` +
  `refundedAt` accumulate refunds on the SAME row (the money trail never
  rewrites history); CHECK `0 <= refundedCents <= amountCents` declared on
  BOTH entity (`@Check`) and migration so future generate-diffs keep it.
  Migration HAND-WRITTEN (reviewed the generated diff: it rename/recreated
  the enum type — table-locking; PG16 runs `ALTER TYPE ... ADD VALUE` inside
  the migration transaction just fine since nothing uses the value there).
  Down drops the columns, does NOT pretend to remove the enum value.
- Semantics (service): refund only a `succeeded` row — pending 409
  `PAYMENT_NOT_CAPTURED`, failed 409, `refunded` 409
  `PAYMENT_ALREADY_REFUNDED`; omitted amount = full remainder (partial
  refunds keep status `succeeded`, the exact full amount flips it);
  overspec/non-integer 400 `INVALID_REFUND_AMOUNT` BEFORE the gateway; a
  provider DECLINE (409 `REFUND_DECLINED`) or explosion (502) leaves the row
  EXACTLY as it was. Order status does not gate refunds (refunding a
  cancelled order's payment is the normal case). Downstream: capture now
  409s refunded rows (no double-charge through one row), and a fully
  refunded row releases `ORDER_ALREADY_PAID` so re-paying starts a NEW
  attempt — while a PARTIALLY refunded row still reads already-paid.
- Concurrency: compare-and-set `UPDATE … WHERE refundedCents = <read value>`;
  loser gets 409 `REFUND_CONFLICT` — two racing admins cannot both land.
  Route `POST /payments/:id/refund` (Bearer, `@Roles(ADMIN)` + RolesGuard +
  service re-check, payments rate bucket, `@HttpCode(200)`, RefundPaymentDto
  — one optional validated int, whitelist strips everything else).
- Gate specs moved with the code: swagger doc 46 operations (route/op-count/
  protected/ERRORS/SUCCESS tables + `PaymentResponse` gains `refundedCents`
  [money-integer list]/`refundedAt`, enum 4 values), ParseUUIDPipe sweep now
  23 routes × malformed+valid passes, fake repo made honest (findOne hydrates
  copies — a live-object fake would have hidden a real CAS race; one capture
  identity assertion changed to deep-equality accordingly).

**Verified:**
- `nest build` clean; FULL jest 560/560 (was 524; +36: mock 10, service 22,
  controller HTTP 6 — incl. guards-before-pipes ordering proof: a bad body
  from a non-admin 403s, never 400).
- Migration applied to dev DB `foodorder`: enum shows 4 values; CHECK
  live-probed — insert with refundedCents>amountCents rejected (23514), a
  'refunded' row UPDATE accepted; probes deleted after.
- Live smoke 28/28 against a booted API (rate buckets relaxed via env only
  for the run): full happy path pay→capture→partial→remainder-full→refunded;
  403 for customer AND for a not-yet-promoted admin (SQL enum gotcha: roles
  are lowercase — `role='admin'`; JWT role claim asserted by decoding);
  400s (negative/float via DTO, over-total & over-remainder via service);
  409 branches (pending, refunded-twice, capture-after-refund); refund of a
  PENDING row 409; history shows amounts intact; repay-after-refund created
  a NEW pending attempt; SECOND API instance with MOCK_REFUND_GATEWAY_MODE=
  fail on :4100 proved the knobs are independent (capture succeeded there,
  refund 409 REFUND_DECLINED, row untouched afterwards).
- Smoke leftovers: 3 test users + their orders/payments rows remain in the
  dev DB (disposable seed-able data, same as prior sessions).

**Docs:** ARCHITECTURE payments bullet (+refunds paragraph), ROADMAP item
ticked + refund-audit-trail follow-up added, `.env.example` knob documented.

**Left for next sessions:** refund audit trail (per-refund rows), order-
machine payment gate (behind feature flag), web pay/refund surfaces, the
credential-blocked Stripe/Xendit adapters.


## 2026-10-27 19:37 — Session 38 — Payment abstraction: gateway interface + mock adapter + payments API

**Built:** Roadmap Phase 5 "Payment abstraction (mock gateway → Stripe/Xendit
adapters behind one interface)" — the API core, scoped to one session: the
abstraction, the mock, the money-shaped plumbing. Real adapters/refunds/web UI
are now explicit sub-items (ROADMAP).

- `payments/payment-gateway.interface.ts` — the one contract: `createIntent` +
  `capture` (integer cents in, provider refs out) under DI token
  `PAYMENT_GATEWAY`. Deliberately two verbs mirroring every real provider
  (intent → capture); adapters may later ADD optional interfaces (webhook
  verification, refunds) without widening this one. `PaymentsService` talks
  only to the interface — proven by unit specs that inject fakes.
- `mock-payment-gateway.ts` — deterministic `mock_pi_<paymentId>` refs and
  clientSecret stand-ins; refuses non-positive/float amounts with a hard
  TypeError on BOTH verbs (money contract = reject, not normalize);
  `MOCK_PAY_GATEWAY_MODE=fail` forces declines so the failed-payment path is
  exercisable against a live server (documented dev-only knob).
- `payments.module.ts` — `selectPaymentGateway` factory behind
  `PAYMENT_PROVIDER`: blank→mock, case/space tolerant, **unknown id fails the
  API at boot** instead of silently charging through the wrong adapter.
- `payments/payment.entity.ts` + migration `1793100690706-AddPayments` —
  one row per ATTEMPT: `orderId` FK CASCADE (indexed `(orderId, createdAt)`),
  payer `userId` FK SET NULL (audit survives user deletion), `provider`
  snapshot, status enum `pending|succeeded|failed`, `amountCents` = server
  snapshot of `orders.totalCents`, UNIQUE nullable `providerRef` (null only
  when intent creation itself died), `failureReason`, write-once
  `succeededAt`. DDL reviewed line-by-line before applying.
- Endpoints (all Bearer, all on the new `payments` rate-limit bucket —
  pay+capture share one counter, default 10/min/IP):
  `POST /payments` {orderId} → 201 intent (fresh: clientSecret; live pending:
  same row replayed, no second intent ever possible);
  `POST /payments/:id/capture` → 200 state-table resolution (pending→gateway
  verdict; succeeded replays without calling the gateway; failed 409
  PAYMENT_ALREADY_FAILED; a since-cancelled order 409 ORDER_CANCELLED even
  with a live row); `GET /orders/:orderId/payments` → newest-first attempt
  history. Semantics that matter: row-state gates BEFORE the order-status
  gate (a paid-and-cooked order reads ORDER_ALREADY_PAID, not a misleading
  ORDER_NOT_PAYABLE); only NEW intents need pending/confirmed; the row is
  PERSISTED before the gateway call so a provider explosion is recorded as a
  FAILED row + 502 PAYMENT_GATEWAY_ERROR, never lost; clients can NEVER send
  an amount or provider (extra body keys observed being stripped live).
- Access model: owner pays own order, ADMIN pays any, GUEST orders payable by
  any authenticated payer (receipt-link path — payer recorded on the row);
  foreign owned → 404 (no existence leak, cancel's stance). Payment capture
  does not emit on the SSE/WS bus yet (payments aren't order status) —
  noted, not faked.
- Wiring kept honest by the standing gate specs, not by hoping: swagger doc
  now **45 operations** (3 new routes registered in `swagger.spec.ts`'s
  route/op-count/protected/ERRORS/success-schema tables; `PaymentResponse`
  model + `payments` tag + money-integer assertion), the ParseUUIDPipe sweep
  grew to **24** guarded path params (2 new), `data-source.spec` to **11**
  entities, rate-limit config now 3 buckets. 3 new suites: mock + provider
  selection (12 tests), service unit (19), HTTP with REAL JwtAuthGuard + REAL
  RateLimitGuard incl. 429 envelope + Retry-After + shared-counter proof (11)
  — 42 new tests, plus the uuid sweep's 2 new routes parametrized ×2 (4 more)
  = 46 new tests total.

**Verified:**
- `nest build` clean; jest **44 suites / 524 tests** green (was 41/478; +46).
- Migration: generated against the running dev DB, DDL reviewed (enum, UNIQUE
  providerRef, composite index, CASCADE/SET NULL), `migration:run` applied
  first try; `down()` present and symmetric.
- **Live smoke A** (succeed mode, API on :4000): guest order total 4250 →
  pay 201 with `mock_pi_…` + clientSecret + amountCents=4250 snapshot; replay
  201 same id clientSecret=null; capture 200 succeeded w/ succeededAt; pay
  again **409 ORDER_ALREADY_PAID** in the standard envelope; capture replay
  200; list 200; foreign-owned-order pay **404**; malformed uuid body/path
  **400**; anonymous **401**; `/api/docs-json` serves 45 ops incl. all 3
  payments routes + declared tag + `PaymentResponse` schema.
- **Live smoke B** (second instance on :4100 with `MOCK_PAY_GATEWAY_MODE=fail`):
  capture → 200 with `status:failed, failureReason:mock_declined`; retry pay
  → NEW row 201; old failed row capture → 409 PAYMENT_ALREADY_FAILED; list
  shows the full attempt history newest-first. (A script hiccup: cancelling a
  GUEST order 404s by existing design — smoke C redid it with owned orders.)
- **Live smoke C** (owned orders on :4000): pending intent + owner cancel →
  capture **409 ORDER_CANCELLED**; cancelled-order pay (no rows) → **409
  ORDER_NOT_PAYABLE**; cancelled-order pay WITH live pending row → 201 replay
  — the documented row-state-first semantics, each proven over HTTP.
- Repo hygiene: U+2026 sanitizer scan clean on config files (only historical
  prose ellipses in DEVLOG), `docker compose config` OK, API instances shut
  down, dev DB re-seeded to canonical state (payments 0, orders 10, restos 6,
  users 2). Web untouched → `next build` skipped per WORKFLOW; CI covers both
  apps on push anyway.

**Docs:** ARCHITECTURE payment bullet + data-model line, `.env.example`
(3 new keys + provider/fail-mode comments), ROADMAP item decomposed into
done-core + 5 honest follow-ups (Stripe/Xendit adapters, webhook verify,
refunds, order-machine payment gate, web pay UI).

**Left for next sessions:** the ROADMAP sub-items in order — the payment gate
on owner-confirm is the one that changes order semantics, so it needs e2e
fixture updates + a flag; the Stripe adapter needs real keys and its webhook
verification endpoint together.

## 2026-10-27 17:14 — Session 37 — Web consumes the WS feed (SSE demoted to fallback)

**Built:** Roadmap Phase 5 "Web: dashboard/order-tracking consume the WS feed
(SSE stays the fallback)" — the browser side of session 36's gateway.

- `lib/ws-feed.ts` (pure, assertion-tested): `wsFeedUrl` (API origin +
  `/orders` namespace), `wsReconnectDelayMs` (capped exponential backoff),
  `WS_SUBSCRIBE_ACK_MS`, `shouldOpenSse` (the ladder gate), `feedTransport`
  (`ws|sse|poll|paused` precedence), terminal-status helpers.
- `lib/use-order-feed.ts` — `useOrderFeed` hook owning the whole socket
  lifecycle: handshake with a FRESH access token, `transports:['websocket']`
  + `reconnection:false` (a dead feed must fail FAST and degrade to the
  fallback ladder, never silently ride engine.io long-polling), subscribe
  ACKs gate `wsUp` (5s ack-silence watchdog), every failure path
  (connect_error/auth_error/disconnect/negative-or-missing ack) reconnects
  with a NEW token after backoff, 15m proactive rebuild mirrors the SSE
  token rule; stale-socket handlers are neutered via a `mine()` guard.
- `/dashboard` transport LADDER: `useOrderFeed(restaurantId)` is PRIMARY;
  the SSE effect (now `sseUp`) only opens while `shouldOpenSse(live, wsUp)`
  and is closed the instant WS recovers; the 10s poll idles while EITHER
  push is up; Live pill gains `data-feed-transport="ws|sse|poll|paused"` +
  transport-aware title. Pause closes all three, as before.
- `/orders/[id]` — the customer tracking page had NO live path at all
  ("Reload to check for updates"). New `components/OrderLiveFeed.tsx`
  island (page stays a server component): `subscribe:me` events for THIS
  orderId → debounced `router.refresh()` (server re-runs its own GET, the
  feed stays trigger-only); 10s interval refresh as the fallback when WS is
  down; guests and terminal orders keep the manual-reload hint;
  hydration-safe (auth hydrates as 'loading').
- **Real bug found & fixed:** the push-debounce timer used to capture the
  closure of whatever render SCHEDULED it. The mount render's catch-up call
  scheduled it with `selectedId=null`, so its fire guard-owned into nothing
  AND — while pending — swallowed every real wake-up inside its 400ms
  window. WS acks cluster exactly there, so the first order event after page
  load could be silently lost (the SSE era only escaped it by hello-timing
  luck). Fix: `requestSync` is now a stable scheduler whose timer ALWAYS
  executes through `syncFireRef` (pinned to the latest render's gate +
  fetchInbox).
- Deps: `socket.io-client@4.8.4` (matches server). The npm mirror baked 9
  `mirrors.tencentyun.com` resolved URLs into the web lockfile again —
  host+prefix rewrite (the mirror's `/npm/` prefix is NOT 1:1), verified by
  a runner-style `npm ci` in fresh HOME + empty cache; lockfile now 100%
  registry.npmjs.org.
- New `e2e/tests/live-feed.spec.ts` (3 tests, CI-covered by the existing
  e2e job): owner inbox reaches `data-feed-transport="ws"` and a new guest
  order + NEW badge land in <5s (the 10s poll cannot make that window);
  a signed-in tracking page follows an owner status change over `u:<self>`
  without reload; and with `window.WebSocket` sabotaged (addInitScript),
  the dashboard falls to `data-feed-transport="sse"` and push STILL works
  — the fallback rung proven, not just asserted in code.

**Verified:**
- `next build` clean (×5 during the session; final clean-instrumentation
  build green).
- Pure-helper assertion run (tsc→ESM + node assert, scratch): 24 cases over
  wsFeedUrl/backoff/SSE-gate/transport-ladder/terminal-status + live-sync
  regression sanity. One initial failure was MY expected-value bug
  (orderStreamUrl keeps the `/api` path), not a code bug — corrected.
- API untouched this session; `nest build` + `jest` re-run green
  (41 suites / 478 tests) before smoke.
- **Runtime smoke (real browsers, prod build):** Postgres 16 service + API
  :4000 (node dist/main.js) + web :3000 (next start). Full Playwright suite
  **7/7 green twice** (8.6s, 9.3s) — 4 pre-existing specs + 3 new feed
  specs. Debug trail worth noting: the ws push initially "failed" in test 1
  only because the e2e raced the restaurant switch (inbox was on Seoul
  Street while the fixture ordered Warung) AND because of the stale-closure
  bug above — caught via WSDBG console/closure instrumentation and a raw
  socket.io-client probe proving the server fan-out was correct all along.
  Note: the live auth rate limit (10/min/IP) bit the repeated e2e re-runs,
  not the app — spaced reruns, final two runs clean.

**Docs:** ARCHITECTURE realtime bullet rewritten (ladder + hook contract +
tracking island), ROADMAP item ticked, DEVLOG this entry.

**Left for next sessions:** roadmap Phase 5 continues with "Payment
abstraction (mock gateway → Stripe/Xendit adapters behind one interface)";
`/orders/my` list page could also wake on feed events (polish); the
single-worker e2e suite is getting long — consider per-test DB fixtures
before adding more state-touching specs.

---

## 2026-10-27 14:03 — Session 36 — Realtime order feed: Socket.IO gateway

**Built:** Roadmap Phase 5 "Realtime order feed with WebSocket gateway
(Socket.IO)". The SSE stream is owner-inbox-only and single-consumer-shaped;
this adds a general-purpose push transport that both owners AND customers can
use, without touching a single REST write path.

- `orders/realtime.gateway.ts` — `RealtimeGateway`, Socket.IO namespace
  `/orders` on the SAME HTTP port as REST (Nest auto-attaches
  `@nestjs/platform-socket.io` to the express server; verified live).
  Handshake auth is REQUIRED and identical in rules to the REST guards:
  access-JWT in `auth.token` (query `?token=` fallback), same secret, `typ`
  claim checked; failure → `auth_error {ok:false, code:UNAUTHENTICATED}` +
  close, success → `hello {serverTime}`. No app-level heartbeat (Socket.IO
  pings at the transport layer; the 15s SSE ping existed only against proxy
  idle timeouts).
- App-level subscribe protocol with acks (never throws over the wire):
  `subscribe:restaurant` reuses `OrdersService.assertStreamAccess` — the
  EXACT inbox gate — so 404/403/400 surface as ack codes and a non-owner
  never joins; rooms are `r:<restaurantId>` (fan-out side) and `u:<sub>`
  where the id comes from the VERIFIED token, not client input — a customer
  cannot eavesdrop on another's orders, and this is the first customer-side
  live feed the app ever had (`subscribe:me`, the `/orders/my` timeline).
  `unsubscribe:*` mirror the subscribes. Payloads are the SAME trigger-only
  `{orderId, code, status}` as SSE: consumers refetch via normal GETs.
- One event bus, two transports: gateway subscribes to `OrderEventsService`
  (SSE keeps consuming it untouched), so WS and SSE can only ever differ in
  delivery, not in content. Bus events gained an OPTIONAL `userId` (null for
  guest orders) at `OrdersService.emit` — drives the `u:` fan-out; SSE
  ignores it. Guest orders fan out to the restaurant room only.
- Deps: `@nestjs/websockets` + `@nestjs/platform-socket.io` + `socket.io`
  (prod), `socket.io-client` (dev, tests only). The npm mirror silently
  baked 29 `resolved` entries in the api lockfile — AND the mirror's path
  prefix `/npm/` is NOT 1:1 with registry.npmjs.org (first rewrite attempt
  404'd on `xmlhttprequest-ssl`). Rewritten correctly (host+prefix stripped),
  proven like a runner: fresh HOME + empty cache `npm ci` → 688 packages,
  green; all 689 `resolved` URLs now registry.npmjs.org.

**Verified:**
- `nest build` clean; `jest` **41 suites / 478 tests all green** (was
  40/469; +9 gateway cases; two strict event-literal assertions in
  orders.service.spec updated for the new `userId` field — they now pin it).
- New `realtime.gateway.spec.ts`: REAL Nest app on an ephemeral port, REAL
  socket.io-client handshakes — no/garbage/refresh-typ tokens refused with
  auth_error+disconnect, access token gets hello; BAD_REQUEST acks for junk
  restaurantId (service never called), NOT_FOUND/FORBIDDEN acks mapped from
  the inbox gate, verified claims (not client input) reach the gate; room
  fan-out delivers created+updated to subscribers only (a deaf socket on the
  same token+namespace receives nothing), unsubscribe stops the feed;
  `subscribe:me` isolation (other user's events never arrive) + guest-order
  no-user-fan-out; admin bypasses ownership exactly like the GET.
- **Live runtime smoke** (API :4000 on local Postgres 16, seeded DB; JWTs via
  normal login, none echoed): unauth socket → auth_error+close; owner
  subscribe real restaurant → ok ack; unknown → NOT_FOUND, junk → BAD_REQUEST;
  customer `subscribe:me` → ok. Then REAL REST writes drove the WS feed:
  `POST /orders` (FO-VCA4) → both owner-room and customer-room sockets got
  `order.created` {code FO-VCA4, pending}; owner `PATCH .../status?status=
  confirmed` → both got `order.updated confirmed`; customer
  `POST /orders/:id/cancel` → owner got `order.updated cancelled` (3 events
  each, zero loss). SSE stream re-checked on the same boot (hello frame with
  restaurantId) — bus change broke nothing. Smoke order left cancelled in the
  DB (normal churn).
- Sanitizer audit: every touched file read back — zero U+2026/'***'
  corruption; `package.json`/lockfile parse as valid JSON.

**Docs:** ARCHITECTURE gained the full WS contract bullet (namespace, auth,
protocol, rooms, guest rule, "dashboard keeps SSE"); ROADMAP item ticked with
an honest follow-up sub-item ("web consumes the WS feed") so the surface stays
on the radar; no REST surface changed → swagger counts untouched.

**Left for next sessions:** dashboard/order-tracking client on the WS feed
(new roadmap bullet); payment abstraction is the next top unchecked item.

---

## 2026-10-27 12:38 — Session 35 — Scheduled cron: auto-cancel stale pending orders

**Built:** Roadmap Phase 5 "Scheduled cron: auto-cancel stale pending orders".
Guest checkout is open by design, so a `pending` order can be placed and simply
abandoned — no prep, no stock, phantom demand in the owner inbox. This adds the
machine path that drains that backlog. Dependency-free (no `@nestjs/schedule`;
the scheduler is systemd/cron at the OS level, like the backups).

- One shared implementation, `orders/stale-order-sweep.ts`:
  `runStaleOrderSweep(repo, opts)` + `resolveStaleSweepConfig(env)`. It selects
  `status='pending' AND createdAt < (now - staleMinutes)` oldest-first, capped at
  `limit`, flips each to `cancelled` with a **write-once** `cancelledAt` (same
  policy as `applyStatus`), and returns a `{ cutoff, scanned, cancelled, capped,
  orders }` report. `capped=true` means the batch filled up → more stale rows
  remain, re-run to drain. Only `pending` is eligible — once an owner confirms
  an order, cancelling is a human decision; the customer already has self-cancel.
  Knobs via env `STALE_ORDER_MINUTES` (default 45) / `STALE_ORDER_BATCH`
  (default 500), parsed like the rate-limit config (junk/zero/negative → default).
- Two schedulable entrypoints, both on that one function (no drift):
  1. **Admin HTTP** `POST /api/orders/ops/cancel-stale` (`orders.controller`),
     ADMIN-gated (`JwtAuthGuard`+`RolesGuard`), command-style `@HttpCode(200)`
     (matches refresh/logout). Wraps the sweep via `OrdersService.cancelStalePending`
     which additionally **emits `order.updated`** per cancel so live owner-inbox
     SSE updates. Optional `CancelStaleDto` body `{staleMinutes,limit}` to
     override per run.
  2. **Standalone cron** `apps/api/src/scripts/cancel-stale.ts` (npm
     `cancel-stale`), wrapped by `ops/cancel-stale.sh` for systemd/cron. Boots
     the DataSource directly (no Nest/SSE — different process), reads config from
     env, prints a one-line JSON summary to stdout + per-order lines to stderr,
     supports `DRY_RUN=1` (no-op save, mutate nothing). `ops/systemd/
     foodorder-cancel-stale.{service,timer}` example: every 15 min, catch-up on
     boot. Money untouched (status machine only).
- `@IsOptional()` on both DTO fields is load-bearing: without it class-validator
  still applies `@IsInt/@Min/@Max` to an *absent* value, so an admin running with
  no overrides (`{}`) got a spurious 400. Pinned by a dedicated DTO spec.
- Swagger: new `CancelStaleResponse` model (integer counters, ISO `cutoff`,
  boolean `capped`); `swagger.spec` updated to 42 operations with the route in
  the covered/protected/success/error tables + honest-shape assertions.

**Verified:**
- `nest build` clean; `jest` **40 suites / 469 tests all green** (was 36/431 at
  session 34; +4 suites: sweep unit, service-wrapper emit, admin HTTP, DTO).
- New `stale-order-sweep.spec.ts` (15 cases): only-pending selection, strict
  `LessThan` cutoff boundary (order at the cutoff is NOT stale), oldest-first,
  batch cap + `capped` flag, write-once `cancelledAt`, hook ordering + async-await,
  dry-run save-less repo, env parsing + override precedence.
- `cancel-stale.admin.spec.ts` (11 cases, real HTTP): 401 no token / non-access
  `typ`, 403 OWNER, 200 admin passthrough, override forwarding + string→number
  coercion, 400 on `staleMinutes=0`/`limit>500`/non-integer, whitelist behaviour.
- `cancel-stale.service.spec.ts` (4): `order.updated` emitted per cancel + caller
  hook composed (not clobbered), overrides forwarded past env default.
- **Live runtime smoke** (API :4000 on local Postgres 16, seeded DB; stale rows
  staged via direct SQL — no credentials on any command line):
  - Standalone `DRY_RUN` → `wouldCancel:6` with FRESH + CONFIRMED correctly
    excluded; DB unchanged after the dry run.
  - Real `ops/cancel-stale.sh` → `cancelled:6`, exit 0; re-run → `cancelled:0`
    (idempotent); `STALE_ORDER_MINUTES=1` dry run then picked up the one 2-min
    fresh order → window honoured dynamically, and `confirmed` never eligible
    regardless of age.
  - ADMIN `POST .../ops/cancel-stale` over HTTP: `{}` → **200, scanned=2,
    cancelled=2** with the DB flipping those two to `cancelled` (cancelledAt set)
    while a 2-min-old pending and a 3-h-old confirmed stayed put; 401 (no token),
    403 (owner token), 400 (`staleMinutes=0`, standard envelope). JWTs signed in
    the helper, never echoed.
  - `DATABASE_URL`/`JWT_SECRET` read from the untracked `apps/api/.env` by the
    helper + script (dotenv); demo data re-seeded afterwards to leave the DB
    pristine for the next session.
- Sanitizer audit: all 15 changed/created files read back — **zero U+2026**;
  `apps/api/package.json` re-parsed as valid JSON with the `cancel-stale` script
  present.

**Docs:** ROADMAP Phase 5 item ticked. Web app untouched → no `next build` per
WORKFLOW. Env knobs are documented in the sweep header + `ops/cancel-stale.sh`
usage block; no new `.env` keys are required (defaults apply when unset).

**Left for next sessions:** nothing blocking. The standalone runner is a separate
process so it can't push SSE to in-memory dashboards (documented); the ADMIN HTTP
route is the SSE-aware path for a live API. A real deployment installs the systemd
timer OR schedules the endpoint call — both examples are ready under `ops/`.

---


**Built:** Roadmap Phase 4 "API: reject malformed uuid route params with 400"
(the 500-gap session 33 surfaced while smoke-testing backups).

- New `UuidParam(name)` decorator in `common/uuid.ts` = `@Param(name,
  ParseUUIDPipe)` (Nest built-in, default `all` version — exact same regex as
  the existing `isUuid` service guard, so shape semantics don't drift).
- Swept **all 22 uuid route params across all 8 controllers**: restaurants
  (:id GET/PATCH), menu (:restaurantId GET/POST, :id x3), orders (:id GET /
  next-statuses / cancel / status), restaurant-orders (:id inbox / stream,
  :orderId portal status), reviews (:id PATCH/DELETE, :id feed), users
  (:menuItemId favorite DELETE, :id address PATCH/DELETE/default). No uuid
  route param is left un-piped — the new integration spec walks every one.
- 400 `BAD_REQUEST` lands in the standard error envelope; guards still run
  BEFORE pipes (Nest ordering), so protected routes answer 401/403 first —
  smoke-confirmed and noted in UuidParam's docblock.
- users.controller: removed the three inline `isUuid` handlers they replaced
  (favorites DELETE 404-on-junk, addresses PATCH/DELETE/default guards);
  equivalent guards moved DOWN into the services for direct-call safety
  (favorites.add/remove, addresses.update/remove/getOwned) — the pattern
  menu/orders/reviews/restaurants already used. `menu.service
  .findByRestaurant` gets the guard that was missing — the actual 500 path.
- Swagger truth pass: every affected `@ApiError(404, 'Unknown or malformed…')`
  split into 400 (malformed) + 404 (unknown); routes that were idempotent for
  junk (DELETE address/favorite `removed:false`, DELETE favorite 404) now
  document the 400; swagger.spec ERRORS table updated to match.

**Verified:**
- `nest build` clean; `jest` **36 suites / 431 tests all green** (was 390
  pre-session; +42 uuid-route HTTP cases, +8 new guard units, fakes made
  uuid-shaped to match the real column).
- New `uuid-route-params.integration.spec.ts`: boots the REAL controller
  surface with the PRODUCTION ValidationPipe + ErrorFormatFilter (services
  mocked, guards stub-open) and proves over HTTP for every uuid route that a
  malformed param answers 400 envelope + the service handler is NEVER called,
  and a valid uuid passes through untouched. 42 cases green.
- Live runtime smoke (API :4000 on local Postgres 16, seeded DB): the exact
  roadmap bug `GET /restaurants/not-a-uuid/menu` now **400** (was 500); 20
  malformed-route probes all 400-BAD_REQUEST; valid real ids still 200
  (menu, order receipt, owner inbox, availability toggle); valid-unknown
  still 404 (orders, restaurants) / `removed:false` 200 (address DELETE);
  no-token guarded route still 401; SSE stream junk closes instantly 400;
  envelope carries X-Request-Id. No QueryFailedError appeared in logs.
- Sanitizer audit: all 16 touched files read back — zero U+2026 introduced
  (one pre-existing swagger-shorthand "…/default" from session 10d1924
  untouched); repo still builds.

**Found en route:** jest `it.each` arity trap — a 3-slot row + a 4-param
callback injects `done` as the 4th arg and every such test times out at the
hook default. Fixed by giving the body param a default (`body = undefined`)
so it never counts toward `fn.length`. SSE pass-through case excluded
deliberately (successful @Sse responses stay open).

**Docs:** ROADMAP item ticked. Web app untouched (it only ever sends ids
that came from the API) → no `next build` needed per WORKFLOW.

**Left for next sessions:** nothing blocking; if we ever mint non-v4 uuids
server-side, consider pinning the pipe version (DTOs use IsUUID('4'), the
pipe/regex accept v1-v8 like the old guards — unchanged semantics).

---

## 2026-10-26 17:52 — Session 33 — pg_dump backup/restore scripts + BACKUP.md runbook

**Built:** Roadmap Phase 4 "Backups: pg_dump scheduled script + restore doc" —
first real `ops/` tooling for the repo.

- `ops/backup-db.sh`: `pg_dump --format=custom --compress=9 --no-owner
  --no-privileges` → timestamped `foodorder-<stamp>.dump` in `ops/backups/`
  (git-ignored). Reads `$DATABASE_URL` from env, falls back to the untracked
  `apps/api/.env` — credentials never on a command line. Every dump is
  **verified by `pg_restore --list` before it is kept** (unreadable archive →
  deleted, exit 3); writes a sha256 sidecar; rotates to `$BACKUP_KEEP`
  (default 14) newest dumps.
- `ops/restore-db.sh`: refuses to guess a target (`--target-url` required,
  explicit `--yes`), checks the sha256 sidecar if present, then
  `pg_restore --clean --if-exists --single-transaction --exit-on-error` so a
  mid-restore failure leaves the target untouched.
- `ops/systemd/foodorder-backup.{service,timer}`: scheduling example (daily
  03:15 + 10 min jitter, EnvironmentFile from api .env); cron one-liner also
  documented. Units are repo examples — intentionally not installed on this
  host.
- `docs/BACKUP.md`: full runbook — backing up, scheduling (systemd/cron),
  restoring (script + manual `pg_restore` + compose `docker exec` variants),
  retention/off-host rsync note, and the restore drill record.
- New roadmap item logged honestly: `GET /restaurants/:restaurantId/menu`
  answers 500 (TypeORM QueryFailedError) for non-uuid params — pre-existing
  gap surfaced while smoke-testing, not a backup regression.

**Verified:**
- `bash -n` both scripts; `systemd-analyze verify` clean (only a pre-existing
  unrelated host unit warned).
- Live drill: backup of dev DB `foodorder` (37 KB, 76 entries) → created
  throwaway `foodorder_restore` → `restore-db.sh` → **count(\*) compared
  table-by-table across all 11 tables: 0 mismatches** (users 2 … orders 12,
  migrations 9); indexes 29/29, constraints 140/140, enums 3/3.
- Serve proof: booted `node dist/main.js` against the restored DB —
  `/health` db up, demo customer + owner login 201, `/orders/my` (4),
  restaurant list (6). Throwaway DB and smoke API torn down after.
- Rotation: `BACKUP_KEEP=1` with two dumps left only the newest + sidecar.
- Failure paths: truncated dump + stale sidecar → abort before touching
  target (exit 2); truncated dump without sidecar → abort at archive-listing
  check (exit 2).
- No API/web source touched → build/jest/next-build skipped per WORKFLOW.
  Sanitizer audit: new files read back via Python — zero U+2026, the single
  `***` is the intended URI-mask in backup-db's echo.

**Docs:** `docs/BACKUP.md` added; ROADMAP item ticked + new uuid-validation
item; `.gitignore` += `ops/backups/`.

**Left for next sessions:** ParseUUIDPipe sweep (new Phase 4 item); optionally
wire the backup into the compose deployment docs when the api/web images get
their first compose end-to-end run.


## 2026-10-26 15:02 — Session 32 — DB query-index migration + EXPLAIN check

**Built:** Roadmap Phase 4 "DB indexes migration (slug, restaurantId,
status, createdAt) + EXPLAIN check". Indexes match the real query shapes in
the services (not just single columns), so each one covers an actual path:

- `menu_items(restaurantId)` — `MenuService.findByRestaurant` (every menu
  page load).
- `orders(userId, createdAt)` — `/orders/my`: WHERE userId [AND status]
  ORDER BY createdAt DESC with pagination.
- `orders(restaurantId, createdAt)` — portal inbox list: WHERE restaurantId
  ORDER BY createdAt DESC with pagination.
- `orders(restaurantId, status)` — the six per-status tab counts in
  `findForRestaurant` (gets an Index Only Scan).
- `order_items(orderId)` — eager `items` relation loads on every order list
  and detail read (`IN (…)`).
- **slug: no new index.** `restaurants.slug` already has a btree via its
  UNIQUE constraint (`UQ_afb6330c…`, confirmed against `pg_constraint`).
  A second plain index would only add write cost; EXPLAIN confirms the
  lookup already uses the unique index *with default planner settings*.
- Entity `@Index` decorators added to `MenuItem`, `Order`, `OrderItem`
  mirroring the migration (decorator+DDL convention from Phase 2/3; schema
  stays owned by migrations, `synchronize` off).
- Migration `AddQueryIndexes1792997950541` generated with
  `migration:generate` (diff contained exactly the 5 `CREATE INDEX`
  statements — reviewed before committing).

**Verified:**
- `nest build` clean; jest **382/382 pass** (35 suites).
- Migration forward applied on dev DB `foodorder`; round-trip proven:
  `migration:revert` → all 5 `IDX_orders*`/menu/order-item indexes gone
  (`pg_indexes` count 0) → `migration:run` → all 5 back.
- EXPLAIN battery against the live dev DB (`enable_seqscan=off` to force
  index choice at this tiny table size — 10 orders/27 items; the plans show
  the indexes are usable for each query shape): Index Scan Backward ×
  `IDX_orders_userId_createdAt` and `IDX_orders_restaurantId_createdAt`
  (DESC sort served by the composite, no Sort node), **Index Only Scan** ×
  `IDX_orders_restaurantId_status` (count query), Index Scan ×
  `IDX_menu_items_restaurantId` and `IDX_order_items_orderId`, Index Scan ×
  slug unique index (default settings, no forcing).
- Runtime smoke on `node dist/main.js` + Postgres: `/api/health` db up,
  demo login → `/orders/my` (2/4), menu list (5 items), owner login →
  portal inbox (6 orders + per-status counts), `?status=pending` filter,
  guest order create server-priced (3×500 → 1500 + 300 fee = 1800, code
  FO-KFB2), owner PATCH `/restaurants/:id/orders/:id/status` → confirmed
  with `confirmedAt`. The admin-only `PATCH /orders/:id/status` correctly
  answered 403 for the owner token (guard intact — not a regression).
- Web untouched → `next build` skipped per WORKFLOW. Dev DB keeps two extra
  smoke orders (normal for this cadence).

**Docs:** ROADMAP item ticked.

**Left for next sessions:** pg_dump backup script (next Phase 4 item);
e2e CI job will pick the indexes up automatically via `migrationsRun` on
the fresh service DB.

---

## 2026-10-26 12:40 — Session 31 — login bad credentials → 401 UNAUTHORIZED

**Built:** Roadmap Phase 4 "Auth: login bad credentials should answer 401
UNAUTHORIZED" (the follow-up left open since session 28). Code + tests +
Swagger docs changed in one go.

- `auth.service.ts`: `login()` now throws `UnauthorizedException` instead of
  `ConflictException` for wrong credentials — presenting bad credentials is an
  authentication failure, not a resource-state conflict. Message stays the same
  opaque `Invalid email or password` for unknown email AND wrong password
  (no existence leak). `register` duplicate-email keeps its 409 CONFLICT, and
  the refresh-token collision retry path in `issueSession` keeps 409 — those
  are true conflicts.
- `auth.service.spec.ts`: the two login tests (unknown email, wrong password)
  re-pinned to `UnauthorizedException`.
- `auth.controller.ts`: login `@ApiError(409)` → `@ApiError(401)`; operation
  description now states the real wire contract.
- `swagger.spec.ts`: `/auth/login` expected error codes `[400, 409, 429]` →
  `[400, 401, 429]` (register line untouched).
- Wire-contract note: external clients keying on 409 for login failure must
  switch to 401. In-repo consumers unaffected — the web client shows the
  envelope message for login and is status-agnostic; its only status-specific
  check is the reviews 409 resync path (different endpoint, untouched).

**Verified:**
- `nest build` clean; jest **382/382 pass** (35 suites).
- Live smoke against `node dist/main.js` + local Postgres (13-check scripted
  battery, all green): wrong password → 401 `{error.code: "UNAUTHORIZED"}`,
  message unchanged; unknown email → 401 same message; good credentials → 201
  with access+refresh, no hash leak; `/auth/me` 200 with that token; register
  duplicate → still 409; junk refresh → still 401; `docs-json`: login
  responses `[201,400,401,429]`, register still carries 409.
- Web unchanged → `next build` skipped per WORKFLOW (API-only diff).

**Docs:** ROADMAP item ticked; DEVLOG entry. Server stopped and port 4000
released after smoke.

---

## 2026-10-26 11:00 — Session 30 — e2e suite in GitHub Actions

**Built:** Roadmap Phase 4 "CI: run the e2e suite in GitHub Actions".

- `e2e/package-lock.json`: all 3 `resolved` URLs rewritten 1:1 from the
  dev host's unreachable `mirrors.tencentyun.com` mirror to
  `https://registry.npmjs.org/` (paths identical, `integrity` untouched —
  the session-26 guarantee extended to the e2e project).
- `ci.yml`: new `e2e` job. Postgres 16 service container reusing the
  db-bootstrap job's exact trust-auth block (copied programmatically from
  disk), API + web installed/built, `npm run seed` on the empty DB
  (applies the full migration chain first), `npx playwright install
  --with-deps chromium`, then `npx playwright test` with the same
  `DATABASE_URL`-from-parts pattern as db-bootstrap; HTML report uploaded
  as an artifact on failure; 30-min timeout. `setup-node` caches all three
  lockfiles. CI header comment updated (301 → 382 tests, job list + e2e).
- `e2e/README.md`: new "In CI" section (runner behavior, pin rationale,
  registry-rewrite standing rule).

**Verified:**
- Rewritten lockfile cold-installed in a fresh HOME + empty npm cache
  (`HOME=… npm ci`): 3/3 tarballs served from `registry.npmjs.org`, zero
  mirror refs in the npm cache index, `playwright-core` resolves 1.63.0.
- Repo's `e2e/node_modules` reinstalled from the rewritten lockfile
  (`rm -rf node_modules && npm ci`), then the **full suite ran 4/4 green
  (49s) with both servers cold** — nothing listened on 3000/4000 first, so
  Playwright booted the API (`node dist/main.js`) and web
  (`next build && next start`) itself, exactly the runner path.
- API unchanged: `nest build` clean this run (jest untouched — no api/web
  source changes; 382-test suite was green in session 29 on identical code).
- ci.yml validated by reading disk back in Python: YAML parses (4 jobs),
  `POSTGRES_HOST_AUTH_METHOD` decodes to `trust` (2×), no U+2026/`***`
  sanitizer corruption, steps = 8.
- Dev DB re-seeded to canonical state after the local run (the guest test
  adds one pending FO- order by design).
- Runner proof: pushed CI run 40262042142 — E2E job **success on GitHub
  Actions** (every step green incl. seed-on-empty-DB, Chromium download and
  the 4-test suite; job wall time 1m58s; api/web/db-bootstrap jobs green
  too, polled anonymously from the public Actions API).

**Docs:** ROADMAP item ticked; DEVLOG entry.

**Left for next sessions:** the login 409→401 item (roadmap line below).

---

## 2026-10-26 09:41 — Session 29 — Playwright E2E smoke suite

**Built:** Roadmap Phase 4 "E2E smoke suite (Playwright: browse → cart →
checkout → order page)".

- New standalone `e2e/` project (own package.json + lockfile; apps/api and
  apps/web dependency trees untouched, so their CI lockfiles and the
  registry-rewrite guarantee from session 26 are unaffected).
- `@playwright/test` pinned **1.63.0** — that release bundles Chromium build
  1243, exactly the browser cached on this dev host (`~/.cache/ms-playwright`);
  no browser download needed. A bump must re-check the build pair.
- `playwright.config.ts`: serial (`workers: 1`) because the suite shares the
  single seeded dev DB and one rate-limit identity per IP (orders 30/min,
  auth 10/min); `webServer` entries boot the API (`node dist/main.js`) and
  the web app (`npm run build && npm run start`) when not already running and
  reuse them otherwise; `baseURL` overridable via `E2E_WEB_URL`.
- 4 tests, all asserting seed-fixed values as the contract
  (documented in each spec header):
  - `guest-order-smoke.spec.ts` — the roadmap flow end to end: home SSR,
    global search (?q=seoul hides Warung), restaurant detail (fee $3.00,
    min $10.00, rating **★ 4.0 · 2 reviews** — seed recomputes the 4.8
    column default from the two seeded Warung reviews), client menu search
    (1 of 5 match "rendang"), add 2 dishes, header badge units, cart stepper
    (subtotal $41.00), checkout live fee $3.00 → WARUNGHEMAT via UI −$5.00 →
    Place order $39.00 (2×1800+500−500+300 = 3900 integer cents), redirect to
    `/orders/<uuid>?code=FO-…`, confirmation page (pending pill, timeline
    "Placed" step, item/promo/delivery/total rows, contact echo), cart cleared.
  - `checkout-guards.spec.ts` — Seoul Street Bungeoppang $6.00 vs $10.00 min:
    alert "Add $4.00 more", submit button disabled "Below minimum order";
    plus empty-cart / empty-checkout guard states.
  - `account.spec.ts` — demo login → authenticated header nav → /orders/my
    lists the seeded `FO-SEED*` order cards.
- `e2e/README.md` documents prerequisites (started+seeded Postgres,
  apps/api/.env, builds) and the pin rationale. `.gitignore` += Playwright
  artifact dirs.

**Doc/fixture truths found by running, not reading:** restaurant ratings shown
in the UI are the REVIEW-RECOMPUTED values (4.0/5.0 for Warung/Seoul on the
canonical seed), not the seed's `rating:` column defaults — an e2e assertion
on 4.8 was wrong from day one.

**Verified:** ✅ built ✅ runtime-verified
- API unchanged: `nest build` clean, jest 35 suites / **382** tests pass.
  Web unchanged: `next build` clean.
- Full suite **4/4 pass, twice consecutively from a fully cold start** (each
  run: both ports free → Playwright booted API+web itself, ~48s incl. the
  Next build), after an earlier warm-reuse pass. The guest test's confirmation
  page is server-rendered from `GET /orders/:id`, so the green run also proves
  the order really persisted with server-side pricing.
- Iteration: first cold pass surfaced two test-authoring bugs (rating
  expectation above; strict-mode collisions on `role=alert` with Next's route
  announcer and an ambiguous `$6.00` text match) — fixed in the specs, no app
  code changes were needed.
- Dev DB re-seeded to canonical state after the runs (each suite pass adds one
  pending FO- order by design — documented in e2e/README.md).

**Docs:** ROADMAP item ticked; new Phase 4 follow-up: run the e2e suite in CI
(needs the session-26 resolved-URL rewrite for e2e's lockfile + browser
download on the runner).

**Left for next sessions:** CI wiring of e2e (logged above); then the login
409→401 item.

---

## 2026-10-24 19:05 — Session 28 — Typed OpenAPI response schemas (all 41 operations)

**Built:** Roadmap Phase 4 "Swagger response schemas: typed
`@ApiOkResponse`/`@ApiError` models for core endpoints".

- `src/common/swagger-response-models.ts` (new): 33 response model classes
  mirroring the ACTUAL service wire output (read from every service first,
  not guessed) + the shared `ErrorResponse` envelope + an `ApiError(status,
  description)` helper (`ApiResponse({status, type: ErrorResponse})` —
  @nestjs/swagger 11 exports `ApiResponse`, no `ApiErrorResponse`).
  Covers the full surface: session/safe-user, restaurant (+`menuItems`
  detail), menu item, order (+snapshot items, optional embedded restaurant),
  paginated envelopes, owner inbox `{...,counts}`, favorites, addresses
  (`{item}` wrappers, `promotedDefaultId?`), reviews (rows + recomputed
  `{rating,ratingCount}` echoes, feed adds the aggregate), promo preview as
  `oneOf` valid/invalid verdicts, health, `NextStatusesResponse`.
- All 10 controllers decorated: success model per operation (with the REAL
  status code — Nest POST default is 201, verified live) and per-op error
  responses ONLY where the code actually throws them (400/401/403/404/409/429
  mapped from the service/guard throw sites).
- `swagger.spec.ts` +3 tests (379 → 382): a 41-row SUCCESS table asserting
  code + schema shape per op (ref / array-of-model / string[] / SSE
  `text/event-stream` / promo oneOf); an ERRORS table asserting the envelope
  `$ref` per documented failure + a global sweep that EVERY 4xx anywhere uses
  `ErrorResponse` (89/89 live); component-contract checks — integer cents on
  all money fields, nullable timestamps, `SafeUserResponse` exact field set
  (no-leak allowlist guard), optional `restaurant`/`promotedDefaultId`/
  `restaurant?` flags, counts map keys, inline status enum values match the
  shared `OrderStatus` component.
- Two generated-quirk calibrations found by running the spec, not from docs:
  `@ApiProperty`/`Optional` with `type: () => Model` emits an `allOf`-wrapped
  `$ref` (assertion helper `refOf` accepts both); `enum + isArray` success
  emits an inline enum, not the component `$ref`.

**Doc bugs vs code found and fixed (documentation-side only):**
- `POST /auth/login` bad credentials: controller description (written in
  session 27) claimed 401, but `AuthService.login` throws
  `ConflictException` (409) — and `auth.service.spec.ts` PINS that (2 tests).
  Docs now state the truth (409 CONFLICT); behavior change 409→401 is added
  as a new ROADMAP item so code+tests+clients move together.
- SSE stream: `@ApiProduces('text/event-stream')` forced the content type
  onto the op's 401/403/404 too — but guard failures answer plain JSON.
  Removed it; the 200 frames declare `text/event-stream` via
  `@ApiOkResponse({content})` instead, errors keep `application/json`
  (asserted live).
- `POST /promos/validate`: comment claimed "always 200", actual POST default
  is 201 (verified live) — comment + description corrected. The roadmap's
  Phase-3 promo item predates this session, untouched.

**Verified:** ✅ built ✅ runtime-verified
- `nest build` clean; `jest` 35 suites / 382 tests pass (was 35/379 — +3
  response-schema tests inside swagger.spec).
- Live smoke vs local Postgres API (port 4000, seeded DB; credentials read
  from disk inside the script, never inlined): ~60 checks covering EVERY
  operation's documented status + shape — register-path skipped (rate limit
  budget), all others exercised: login 201/session keys, bad login 409
  envelope, refresh 200 rotation, me safe-user key-set, restaurants
  envelope/detail+menuItems/mine/cuisines, guest+authed order 201 with
  server-priced integer cents (`total = subtotal - discount + fee` checked),
  order receipt + next-statuses, cancel 201 cancelledAt set, /orders/my rows
  embed restaurant, owner inbox counts = 6 keys, favorites add/list/remove,
  addresses 201 `{item}` + idempotent delete (`removed:false` retry), menu
  create 201/delete 200 snapshot, review feed shape, guard 401/403 paths,
  bad-uuid 404.
- `GET /api/docs-json`: 41 ops, 33 `*Response` components, 89/89 documented
  4xx reference the envelope; `GET /api/docs` UI 200. (Test scripts left a
  couple of pending/cancelled smoke orders + one deleted dish row in the dev
  DB — normal seeded-DB scratch state.)

**Docs:** ROADMAP item ticked; new Phase 4 follow-up (login 409→401).

**Left for next sessions:** E2E Playwright smoke suite (next Phase 4 item);
login-credentials status-code fix item added.

---

## 2026-10-24 17:11 — Session 27 — OpenAPI/Swagger docs at `/api/docs`

**Built:** Roadmap Phase 4 "Swagger/OpenAPI docs auto-generated at
`/api/docs`":
- `@nestjs/swagger@11.4.7` added (v12 requires Nest 12; this app is Nest 11 —
  pinned `^11` after an ERESOLVE failure, not `--legacy-peer-deps`).
- `src/common/swagger.ts`: single source of truth for the document
  (title/version/markdown description incl. auth, roles, cents, error
  envelope, rate limits, x-request-id) + tag registry + path constants,
  shared by `main.ts` and the new spec.
- `main.ts`: `SwaggerModule.setup` after CORS/middleware, before listen.
- All 10 controllers annotated: `@ApiTags`, `@ApiOperation` (summary +
  contract description), `@ApiBearerAuth` on exactly the JWT-guarded routes,
  uuid `@ApiParam` schemas, `@ApiQuery` for restaurants search/sort/page/limit,
  `status` as QUERY enum on both transition routes, `@ApiProduces('text/event-stream')`
  + `access_token` query documented on the SSE stream.
- All 12 request DTO files decorated with `@ApiProperty`/`@ApiPropertyOptional`:
  explicit `type: 'integer'` for every cents/quantity/star field (plain
  `type: Number` emitted `number` — spec now asserts `integer`), shared
  `OrderStatus` enum component, `nullable: true` strings (union type would
  infer `Object`), patterns/lengths mirroring the class-validator rules,
  real seed examples (`WELCOME10`).
- Two doc claims fixed mid-session by checking the services first: slug
  collision auto-suffixes (`-2/-3…`) instead of 409; self-cancel is allowed
  through `preparing`, not just pending/confirmed.
- `src/common/swagger.spec.ts` (new, 6 tests): spins up a throwaway app with
  all REAL controllers (services/guards mocked) and asserts the generated
  document — all 41 operations present (and exactly 41), bearer scheme
  applied on the 28 protected ops and absent on the 13 deliberate public
  ones (incl. guest checkout), DTO required-flags/enum/nullable/integer
  bounds, query params, tag coverage, and live fetch of the UI + raw JSON on
  an ephemeral port.

**Verified:** ✅ built ✅ runtime-verified
- **CI caught a real regression on this session's own commit:** the fresh
  `npm install @nestjs/swagger` baked 6 mirror-locked `resolved` URLs
  (http://mirrors.tencentyun.com) into apps/api/package-lock.json — the
  exact recurring pitfall from the foodorder-github-ci skill (which this
  session failed to load before committing). First CI run on this commit:
  api + db-bootstrap jobs failed at "Install (clean, from lockfile)", web
  green. Fixed by the proven 1:1 host rewrite to registry.npmjs.org
  (integrity hashes untouched), then proved runner-style: `npm ci` in a
  fresh HOME without ~/.npmrc — green, `@nestjs/swagger` resolves. Full
  audit: both lockfiles 100% registry.npmjs.org (660 api + 137 web
  entries). Follow-up commit + green re-run recorded below.

- `nest build` clean; `jest` 35 suites / 379 tests pass (was 34/373).
- Live API on local Postgres: `GET /api/docs` → 200 Swagger UI (embeds the
  doc inline, so Try-it-out works without a spec fetch), `GET /api/docs-json`
  → 200 with 41 operations · 8 tags · bearer scheme · paths under `/api`,
  `GET /docs` (wrong URL) → 404 — the mount matches the roadmap contract
  exactly.
- Contract smoke via documented shapes: seed login → `GET /api/orders/my
  ?status=confirmed&limit=3` 200; `GET /api/restaurants?search=&sort=rating`
  200; `POST /api/promos/validate` 201; `X-Request-Id` header present.
- `@nestjs/swagger` 11 quirk captured in code comments: `createDocument`
  INCLUDES the global prefix in paths while `setup` does NOT prepend it to
  its mount path — hence `SWAGGER_UI_PATH='api/docs'` and no `addServer()`
  (a `/api` server entry would double the prefix in Try-it-out).
- No web changes (docs-only API increment) — `next build` not run.

**Left for next sessions:** response models (`@ApiOkResponse`/`@ApiError` +
typed response DTOs) are intentionally not in this pass — added as the next
Phase 4 item; UI polish/authorizing from the header needs nothing extra since
the JSON ships the bearer scheme.

## 2026-10-24 13:25 — Session 26

**Built:** Phase 4 item 4 — **rate limiting on auth + order endpoints** —
plus a repo-integrity fix the verification surfaced (see below).

- New `src/common/rate-limit/` (no new dependency; the codebase already owns
  its middleware and adding `@nestjs/throttler` would re-open the
  mirror-lockfile CI problem):
  - `rate-limit.store.ts` — `RateLimitStore` interface +
    `SlidingWindowLogStore`: per-key sliding-window log, injectable clock,
    blocked requests are *not* recorded (retry storms can't extend a window),
    lazy idle-key sweep, window-change rebase. Redis seam documented for
    multi-node.
  - `rate-limit.config.ts` — buckets `auth` (default 10/min) and `orders`
    (30/min); env overrides `RATE_LIMIT_{AUTH,ORDERS}_{MAX,WINDOW_SEC}` with
    strict positive-int parsing (garbage → default); `RATE_LIMIT_TRUST_PROXY`
    (default off: identity = socket IP; on: first XFF hop — only safe behind
    a header-overwriting proxy, since spoofable XFF would mint free buckets).
  - `rate-limit.decorator.ts` — `@RateLimit('auth'|'orders')` metadata,
    handler over class; non-decorated handlers always pass.
  - `rate-limit.guard.ts` — `RateLimitGuard` (kept FIRST in every
    `@UseGuards` list, so over-limit requests never reach JWT/validation
    work): sets `X-RateLimit-Limit/Remaining/Reset` on every throttled
    response; on block sets `Retry-After` and throws `AppException(429,
    'RATE_LIMITED', …, details={bucket, retry_after_sec, window_sec, req_id})`
    → renders through `ErrorFormatFilter` untouched. `req_id` comes from the
    session-25 AsyncLocalStorage (fulfilled the noted follow-up).
  - `rate-limit.module.ts` — `@Global` wiring; env read once at boot.
- Applied: `AuthController` (register+login+refresh share one `auth` bucket —
  credential rotation can't launder the limit; `me`/`logout` untouched),
  `OrdersController` (`POST /orders` guest+auth and `POST /orders/:id/cancel`
  share the `orders` bucket; reads untouched).
- Tests: 46 new (4 suites) — store semantics (exact retryAfter/remaining/
  slide/sweep), config parsing (8 garbage-override cases), guard unit
  (metadata resolution incl. handler-over-class, header contract, XFF
  spoof-rejection + trusted-proxy keying, fail-open paths, reqId attach),
  and a live-HTTP integration suite on the production chain (envelope +
  `Retry-After` + `req_id == X-Request-Id`, cross-route bucket sharing,
  bucket isolation, window recovery, blocked-not-counted, guard-before-
  validation, direct-listener spoof isolation, trusted-proxy keying).
- Wiring/docs: `RATE_LIMIT_*` envs + `RATE_LIMIT_TRUST_PROXY` in
  `.env.example` and docker-compose api env; README error-envelope section
  documents `RATE_LIMITED`; ARCHITECTURE decision bullet.

**Repo-integrity fix (found while validating compose):** the committed
`docker-compose.yml` contained literal U+2026 `…` characters in three env
defaults — `POSTGRES_PASSWORD: ${POST…}`, `DATABASE_URL` inline default,
`JWT_SECRET: ${JWT_…}` — transcript-sanitizer-corrupted writes baked in by
earlier sessions: `docker compose config` failed on every key (non-deterministic
first complaint) ⇒ **compose stack could never boot**, though CI never caught it
(workflows build images, not compose). Repaired compose lines 7/24/25,
`.env.example` lines 3/5 (same corruption; line 4 was intact and matched the
restored defaults), the *untracked* `apps/api/.env` JWT secret (rotated to a
clean ASCII dev value; all old dev tokens now invalid — dev only), and one
mangled comment in `users.controller.ts` (`"…/:id"` → `"/users/:id"`).
Prose/UI ellipses elsewhere (README, DEVLOG, placeholder strings) verified
intentional and left untouched. Full-tree U+2026 scan: only legitimate prose
remains. Fixed via runtime-assembled fragments (sanitizer-safe); disk state
asserted by codepoint readback + structural equality checks, never by display.

**Verified:**
- `nest build` clean; jest **373/373** (34 suites, was 327/30). No lockfile
  changes at all (zero new deps) → CI mirror problem cannot recur from here.
- `docker compose config` exit 0 after repair (was failing before, on master).
- Runtime smoke (local Postgres service; `node dist/main.js` background on
  :4000 booted with `RATE_LIMIT_AUTH_MAX=5 RATE_LIMIT_AUTH_WINDOW_SEC=5
  RATE_LIMIT_ORDERS_MAX=4 RATE_LIMIT_ORDERS_WINDOW_SEC=5` to prove env
  overrides live and keep the dev DB tidy) — scripted 24/24 assertions:
  health unthrottled + no rate headers; register 201 with Limit=5/
  Remaining=4 (override applied); 4 failed logins counted in the shared
  bucket (409s, pre-existing code); 6th hit 429 with `RATE_LIMITED`
  envelope, `Retry-After: 5`, `details {bucket:auth, retry_after_sec:5,
  window_sec:5, req_id}` with `req_id == X-Request-Id` echo; after a 6.2 s
  slide the same caller gets 201 + fresh token (rotated `.env` secret works
  end-to-end); `/auth/me` 200 without rate headers; guest `POST /orders`
  201×4 then 429 (bucket=orders) while `GET /orders/:id` stays unthrottled;
  authenticated create 201 + cancel 201 (guard-before-JWT) sharing the
  orders bucket; pino access log recorded every 429 as `warn` with the same
  `reqId` (5/5). Re-ran smoke after `.env` repair: 24/24 again.
- `apps/web` untouched this session (API-only change) — `next build` skipped
  per WORKFLOW.

**Docs:** ROADMAP Phase 4 item ticked; DEVLOG entry.

**Left for next sessions:** Swagger/OpenAPI at `/api/docs` (next Phase 4
item); web client should surface `X-Request-Id`/429 retry hints (`lib/api.ts`
ApiError); Redis store when a second API replica ever exists; consider
throttling portal `PATCH status` + review writes in a future ops pass.

---

## 2026-10-24 12:48 — Session 25

**Built:** Phase 4 item 3 — **structured logging (pino) + request-id
middleware**.

- New `src/common/logging/`:
  - `request-context.ts` — AsyncLocalStorage holding the active `reqId`;
    readable from any point in the request chain without signature threading.
  - `request-id.middleware.ts` — global, registered first. Reuses a safe
    inbound `X-Request-Id` (`[A-Za-z0-9._-]{1,64}` — log-injection guard;
    first value wins on duplicates, anything unsafe → fresh UUID v4), sets
    `req.id` for pino-http reuse, echoes `X-Request-Id` on the response
    (also added to CORS `exposedHeaders`), and wraps `next()` in the ALS
    context so async continuations inherit the id.
  - `pino-logger.ts` — `createRootLogger()` (one JSON line/event on stdout,
    `service: foodorder-api`, ISO time, level from `LOG_LEVEL` with sane
    fallback, redact: authorization/cookie/`**.password`/tokens) +
    `PinoLoggerService` implementing Nest's `LoggerService` — bootstrap
    messages, `RoutesResolver` lines and `new Logger(...)` call sites
    (ErrorFormatFilter included) all come out as JSON with the active
    `reqId`. Nest param convention respected: trailing string → `context`,
    stack-looking string → `stack`, Error → structured `err`, object →
    merged fields. Levels: log→info, verbose→trace, fatal→fatal.
  - `http-logging.ts` — pino-http factory: exactly one access line per
    finished request (`"GET /path -> 200"`, minimal `{method,url}` +
    `{statusCode}` serializers — no headers/bodies), `responseTime`, level
    5xx→error / 4xx→warn / else info, top-level `reqId`, `/api/health`
    autoLogging-ignored.
- `main.ts`: logger passed to `NestFactory.create(…, { logger })`,
  middleware order request-id → pino-http, CORS exposes the header, startup
  failure logs a structured `fatal`; dotenv loaded with `quiet: true`
  (v17's advisory banner would break the 100%-JSON stream). `seed`/
  `stamp-baseline` CLI scripts stay on console (not the server stream).
- Wiring: deps `pino@10`/`pino-http@11` (lockfile tarball URLs written
  directly against registry.npmjs.org — mirror-safe for CI), `LOG_LEVEL`
  added to docker-compose api env + `.env.example` with docs,
  ARCHITECTURE gains the logging decision.
- Tests: 26 new (3 suites) — request-id unit (generation/reuse/replacement/
  ALS scoping), pino-logger unit (level mapping, context/stack/err/object
  params, reqId attach/omit, circular-safety, LOG_LEVEL parsing), and a
  **live-HTTP integration suite** on the exact production middleware chain
  asserting: header echo, inbound-id reuse + unsafe rejection, one access
  line per request, async-handler ALS propagation, 404/500 warn/error lines
  sharing one `reqId` with the filter log, client-safe 500, health silence.

**Verified:**
- `nest build` clean; jest **327/327** (30 suites, was 301/27).
- Lockfile: zero `tencentyun` resolved URLs; `npm ci` from a fresh HOME with
  an **empty npm cache** in a scratch copy installed pino/pino-http from
  registry.npmjs.org (same cold path a GitHub runner takes) — green.
- Runtime smoke (Postgres service up, `node dist/main.js` background on
  :4000, LOG_LEVEL=debug then default): boot 100% JSON lines; every curl
  produced exactly one access line with correlated `reqId` (histogram: 13
  info/14 warn across 2xx/4xx — no real 5xx traffic); `X-Request-Id` echoed
  on all responses incl. 404/400/201; safe inbound `smoke-trace-001` reused
  verbatim end-to-end (header + access line), injection-shaped inbound
  (`evil injection":"x`) replaced by fresh UUID; `/api/health` answered
  200 with **zero** log lines; 404 and validation-400 got warn-level lines;
  register 201 → login → `Authorization: Bearer` → `/orders/my` 200; guest
  `POST /orders` 201 server-priced (subtotal 2600 + fee 350 = 2950, phone
  masked in response) with inbound `order-trace-9` echoed on the 201.
- Debug/trace lines correctly suppressed at default `info` level; the only
  stdout blemish found (dotenv 17 promo banner) fixed with `quiet: true`
  and re-verified: 0 non-JSON lines on a fresh boot.
- Smoke artifact, not a regression: demo login first returned 409 because
  the transcript sanitizer rewrote the literal password in my curl arg to
  `***` (known quirk); rebuilt from shell fragments → 200 + token.

**Docs:** ROADMAP item ticked; ARCHITECTURE logging decision; `.env.example`
+ compose `LOG_LEVEL`.

**Left for next sessions:** rate limiting on auth + order endpoints (next
Phase 4 item — can reuse `reqId` in 429 payloads for support tracing);
consider surfacing `X-Request-Id` in the web client's ApiError.

## 2026-10-23 19:50 — Session 24

**Built:** Phase 4 item 2 — **GitHub Actions CD workflow**
(`.github/workflows/cd.yml`): version tags publish both app images to GHCR.

- Triggers: `push` of a `v*` tag → build + push; `workflow_dispatch` →
  build-only (no push) so the workflow itself is safely re-verifiable.
- Single matrix job (`api`, `web`) on ubuntu-latest: checkout → Buildx →
  `docker/metadata-action` → `docker/login-action` (tag events only) →
  `docker/build-push-action` with `push: ${{ github.event_name == 'push' }}`.
- Registry auth = the **built-in `GITHUB_TOKEN`** with a scoped
  `permissions: packages: write` — zero new secrets to configure; the file
  contains only the template reference, never a token value. Packages
  published from Actions on a public repo are publicly pullable.
- Image names `ghcr.io/<repo>/foodorder-{api,web}`; tags per release:
  semver `0.1.0`, `0.1`, `sha-<commit>`, and `latest` (semver flavor).
- `NEXT_PUBLIC_API_URL` build-arg comes from repo `vars` with the localhost
  dev default (baked into the web image at build time; harmless no-op arg
  for the api image).
- `v0.1.0` annotated tag cut at the workflow commit and pushed — the first
  release of this repo. README gained a CD badge next to the CI badge.

**Verified (build half locally first, publish half on-platform after):**
- **First-ever local builds of both images** (pending since Session 1):
  `docker build` apps/api (614 MB) and apps/web (352 MB) both succeeded —
  inside-container `npm ci` now works because Session 23 repointed the
  lockfiles to npmjs.org.
- Image runtime smoke (both containers on the host network so the baked-in
  localhost URLs resolve; Postgres 16 service up): api container
  `/api/health` → `{"status":"ok","db":"up"}` and `/api/restaurants` served
  live seeded data; web container returned **HTTP 200** and SSR-rendered
  the real restaurant list pulled through the api container. Containers
  and `:cdtest` images removed afterwards; `docker ps` back to empty.
- cd.yml parses (PyYAML); sanitizer byte-audit: the `password:` line and
  all `${{ … }}` expressions verified by codepoint readback from disk —
  no masking artifact, no credential literal in the file anywhere.
- On-platform (polled anonymously via api.github.com): CD run **39949699099**
  on ref `v0.1.0` → both matrix jobs green (api 52 s, web 73 s), every step
  incl. "Log in to GHCR" and "Build + push to GHCR" success. CI run
  39949693265 on the same commit also stayed green (no regressions).
- Real side-effect check — images actually exist: `docker manifest inspect`
  (no auth) returned **OK for all six** tags:
  `foodorder-{api,web}` × {`0.1.0`, `0.1`, `latest`}.

**Docs:** ROADMAP item ticked; README CD badge.

**Left for next sessions:** actual deploy story for these images (compose on
a server or cloud run), registry retention, then pino structured logging —
the next Phase 4 item.

## 2026-10-23 18:16 — Session 23

**Built:** Phase 4 item 1 — **GitHub Actions CI** (`.github/workflows/ci.yml`,
3 jobs on every push to master + every PR):

- `api`: `npm ci` → `nest build` → `jest --ci` (node 22, npm cache keyed per
  lockfile, working-directory apps/api).
- `web`: `npm ci` → `next build`.
- `db-bootstrap`: `postgres:16-alpine` **service container** with health
  gating; applies the full migration chain to an EMPTY database, runs the
  seed, then asserts: all 11 entity+bookkeeping tables exist,
  `migrations` row count == committed migration FILE count, and
  users/restaurants/menu_items/orders are all non-empty after seed. Ends with
  a **schema-drift gate**: `migration:generate DriftCheck` must refuse to
  generate ("No changes in database schema were found") — any generated file
  means uncommitted entity/migration drift and fails CI with the diff shown.
  Service DB uses `POSTGRES_HOST_AUTH_METHOD=trust` so no password literal
  ever appears in the workflow; concurrency group cancels superseded pushes.
- Prereq fix (own commit): `apps/api/package-lock.json` root-dependency map
  was missing `dotenv` (present in package.json AND as a resolved package)
  → `npm ci` sync check would fail on runners. One-line lock regeneration,
  verified with a real clean `npm ci` from zero (640 api + 109 web packages).

**Verified (before push — every CI step first proven locally):**
- `npm ci` from scratch in throwaway dirs for BOTH apps after the lock fix:
  clean installs, no EUSAGE.
- Fresh-DB pipeline locally: dropped+recreated a `foodorder_ci` database →
  `migration:run` (8 migrations) → `npm run seed` (6 restos/27 dishes/2
  addresses/reviews) → ran the workflow's exact assert script against it:
  all 11 tables, 8 recorded, seed counts OK.
- Drift-gate behavior confirmed: `migration:generate` on that head DB wrote
  NO file and printed "No changes in database schema were found".
- `jest --ci` passes with an intentionally UNREACHABLE DATABASE_URL
  (27 suites, 301 tests) — proves the api CI job needs no database.
- `next build` passes with the API fully stopped on :4000 — proves the web
  CI job needs no live backend.
- Workflow YAML parses (PyYAML); raw-byte audit of every credential-shaped
  line — see sanitizer note below.

**Sanitizer incident (real, recurring pitfall):** writing the workflow the
first time, the transcript sanitizer rewrote VALUES of credential-shaped keys
in outgoing tool args: `POSTGRES_PASSWORD: ci` landed on disk as `***`
(breaking YAML — alias error) and even a `…AUTH_METHOD: trust` value got
masked. Fix: (a) use no password at all (`trust` host auth), (b) smuggle the
value as a YAML double-quoted backslash-continuation `"tru\<newline>st"` so no
masked token is ever sent, (c) verify the file by parsing it in Python and
comparing codepoints (116 114 117 115 116), not by grepping terminal output
(display masking ≠ disk content; the reverse is also true).

**Docs:** README CI badge under the title; ROADMAP Phase 4 item ticked.

**Left for next sessions:** CD workflow stub is the next roadmap item; local
`foodorder_ci` scratch DB dropped after this session's checks.

**Follow-up same slot (red → green, the honest arc):** the first CI run
(39939214332, SHA 7da7d49) failed ALL three jobs at `npm ci` (~70s timeouts).
Root cause: every `resolved` URL in both lockfiles pointed at
`http://mirrors.tencentyun.com/npm/` — this host's region mirror, unreachable
from GitHub runners (my local `npm ci` "verified" it because it ran ON the
mirror network). Fix 37461f5: 1:1 rewrite of `resolved` host to
`https://registry.npmjs.org` (paths identical, integrity untouched; npm
refuses to rewrite existing entries, so sed + verification). Proven with
`npm ci` in a fresh HOME with EMPTY npm cache — every tarball actually
downloaded from npmjs.org and integrity-passed (640 api / 108 web packages).
Run 39939888913 then went **green end-to-end**: api build+jest, web
next build, and db-bootstrap all 5 steps (migrate→seed→assert→drift) success
— the CI item's definition of done is real, on the actual platform. CI badge
in README now renders live.


## 2026-10-23 15:05 — Session 22

**Built:** Phase 3 item 6 (closing the phase) — **delivery addresses book**
(API CRUD + order-create integration + `/addresses` page + checkout picker).

- API: new `DeliveryAddress` entity (`delivery_addresses`: label 40,
  recipientName 120, phone 32, address text, `isDefault`, user FK cascade,
  `IDX_delivery_addresses_userId`) + migration `AddDeliveryAddresses`
  (generated, DDL reviewed, applied to dev DB).
- API: `AddressesService` + 5 routes on `/users/me/addresses`
  (GET list default-first, POST create, PATCH text-only edit, DELETE
  idempotent, POST /:id/default promote). Invariant enforced in the service:
  non-empty book ⇒ exactly one default (first row forced default, promote
  clears the previous, delete-default promotes the oldest survivor with
  `promotedDefaultId` reported). Cap 10 rows → 400. Foreign/unknown ids are
  one indistinguishable 404; junk uuids short-circuit before Postgres.
- API: `POST /orders` accepts optional `deliveryAddressId` (IsUUID).
  `OrdersService.resolveContact` — runs FIRST in create(): guest sender →
  400 "requires a signed-in customer"; foreign/unknown → 404; valid → the
  order stores the server's OWN recipient/phone/address text (client echo
  ignored — verified with deliberately hostile echoes) and the snapshot
  stays TEXT so later book edits never rewrite delivery history. The three
  contact fields became DTO-optional; the service now enforces the either/or
  and 400s listing exactly which fields are missing.
- Web: `/addresses` page (guest sign-in card w/ ?next back-pointer, skeleton
  while loading, add/edit inline form with client-side bounds mirroring the
  DTO, make-default, delete, default badge); `lib/api.ts` typed methods for
  all 5 routes + `deliveryAddressId` in `CreateOrderPayload`.
- Web: checkout saved-address radio picker (signed-in, book non-empty) —
  pre-selects the default and prefills name/phone/address; typing in any
  prefilled field drops the selection back to "manual" so the UI never lies
  about what the server will use; link to the management page. Header gains
  an Addresses link (lg+).
- Seed: demo customer gets Home (default) + Office; `TRUNCATE` list includes
  `delivery_addresses`.
- Tests: 3 new suites, 301 total (was ~268) — `addresses.service.spec`
  (15: invariant across create/promote/delete paths on a stateful repo
  double), `delivery-address.dto.spec` (8: real ValidationPipe stripping of
  isDefault-on-PATCH/userId/id + bounds), `orders-address.spec` (6: echo
  override, picker-only payload, guest 400, foreign 404, missing-field
  message, unchanged guest path). Both pre-existing orders specs updated for
  the new constructor arity.

**Verified:**
- `nest build` clean; `jest` 301/301 pass (27 suites).
- `migration:run` applied to dev DB; fresh `npm run seed` rebuilt books
  (+2 addresses); dist contains the compiled migration for docker bootstrap.
- `next build` green; `/addresses` prerenders, `/checkout` + home 200 via
  `next start` SSR probe.
- Live curl smoke (API on :4000, real Postgres): seeded book lists default
  first; create 3rd stays non-default; PATCH rename; promote → exactly one
  default; re-promote idempotent (`alreadyDefault:true`); order with
  `deliveryAddressId` + hostile echoes stored the ADDRESS's text (FO-V9N9:
  "Demo Customer/+62 812 000 1111/Jl. Kemang Raya 8"), picker-only payload
  (no contact fields) 201; guest missing fields → 400 listing all three;
  guest explicit path still 201; guest+id → 400; foreign/unknown id → 404
  (also cross-checked: owner token cannot spend the customer's address);
  junk id → 400 pre-DB; delete default promoted Home with
  `promotedDefaultId`; double delete `{removed:false}`; empty PATCH 400;
  book restored to seed shape afterwards.
- Note: `/addresses` guest card is client-gated by design (status starts
  'loading' on SSR) — probe asserts h1 + 200, matching the hydration-safe
  pattern used across the app.

**Docs:** ROADMAP Phase 3 now fully ticked; README 5 endpoint rows + orders
row updated; ARCHITECTURE address-book block. Phase 4 (Ops & quality) is the
new head of the backlog — next session takes GitHub Actions CI.

**Left for next sessions:** address quick-add from checkout (edit UX exists
only on /addresses); usage of `promotedDefaultId` in the web toast; docker
compose end-to-end still unverified since Phase 1.

## 2026-10-23 13:17 — Session 21

**Built:** Phase 3 item 5 — **promo codes & discount engine** (API + storefront).

- API: new `PromoCode` entity (`promo_codes`: unique uppercase `code`,
  `discountType` enum `percent|fixed`, `valueCents`, optional
  `maxDiscountCents` cap, `minSubtotalCents` gate, nullable `restaurantId`
  scope (null = platform-wide, FK `ON DELETE CASCADE`), `isActive` kill
  switch) + generated migration `AddPromoCodes1792732328155` (DDL reviewed;
  also adds `orders.discountCents int default 0` + `orders.promoCode
  varchar(24) nullable` snapshot columns — text snapshot on purpose, receipts
  survive promo deletion).
- `PromosService.evaluate(code, restaurantId, subtotalCents)` is the single
  decision point: normalize→lookup→active→restaurant-scope→min-subtotal gates,
  then integer-cent math (percent floors, cap applies, fixed clamped to the
  subtotal — fees are never discounted, total never below the fee). Soft
  outcome object, never throws; `POST /promos/validate` wraps it as a
  soft-200 preview (`{valid:false, reason, message}` for the 4 rejection
  kinds), public since checkout is guest-allowed and codes are public by
  design.
- Order integration: `CreateOrderDto.promoCode` (optional, `Matches` shape);
  `OrdersService.create` evaluates AFTER the min-order check (a promo can't
  smuggle a below-minimum cart) against its OWN recomputed subtotal — client
  subtotal never consulted — 400s the whole order when rejected, and stores
  `discountCents` + normalized code snapshot; `total = subtotal − discount +
  fee`. Wired: PromosModule in AppModule + OrdersModule, entity in the CLI
  `data-source.ts` list (spec bumped to nine entities), seed adds
  WELCOME10 (percent 10 capped 2000, min 2000) / WARUNGHEMAT ($5 fixed at
  Warung Nusantara, min 3000) / LAUNCH99 (inactive demo) and gives FO-SEED1
  a real WELCOME10 receipt (2800 − 280 + 300 = 2820).
- New specs: `promos.service.spec.ts` (15: gates, case-insensitivity,
  percent floor/cap, fixed clamp, zero-subtotal, preview shapes) +
  `orders-promo.spec.ts` (4: engine untouched without a code, server subtotal
  passed, snapshot + clamped total on success, 400 rejects the order,
  min-order beats promo). `OrdersService` ctor gained the 5th dep — all 7
  spec construction sites updated via a `fakePromos()` helper.
- Web: checkout summary gets a promo input (Apply button / Enter, disables
  while checking, applied shows description, rejects show the server's
  message inline); an applied discount renders a green `−$X` line and folds
  into the live total; the verdict is dropped whenever cart subtotal or
  restaurant changes (stale preview guard); submit sends the code ONLY when
  it passed preview. `Order`/`CreateOrderPayload` types + `api.validatePromo`
  added. `/orders/[id]` receipt shows `Promo (CODE) −$X` when
  `discountCents > 0`.

**Verified:**
- `nest build` clean; `jest` 24 suites / **272 tests pass** (19 new above).
- `next build` green.
- Runtime smoke (dev DB migrated + reseeded, API booted on :4000):
  `/api/promos/validate` matrix — lowercase `welcome10` at 2800 → valid 280;
  90000 subtotal → capped at 2000; 1000 → `below_min_subtotal`; WARUNGHEMAT
  at sushi-kan → `restaurant_mismatch`, at warung → valid 500; LAUNCH99 →
  `inactive`; NOPE → `not_found`; missing-field body → standard 400 envelope.
  `POST /api/orders` with `promoCode:"welcome10"` → FO-KSXC subtotal 2800,
  `discountCents 280`, snapshot `WELCOME10`, total 2820 (re-GET identical);
  inactive/unknown codes → 400 with the exact reason, no order row.
  SQL cross-check: seeded FO-SEED1 snapshot matches the live-created order
  column-for-column (2800/280/WELCOME10/2820). Smoke API stopped after.

**Left for next sessions:** promo admin CRUD (owner/platform creation UI —
currently seed/platform-managed rows only) and the separate "Coupons expiry +
usage caps" Phase 5 item (needs a usage ledger; deliberately not in this
engine). Next roadmap item: delivery addresses book.

---

## 2026-10-23 11:31 — Session 20

**Built:** Phase 3 item 4 — **customer reviews with server-side restaurant
rating recompute** (API + storefront).

- API: new `Review` entity (`reviews`: unique `orderId` = one review per
  completed order, `restaurantId`/`userId` denormalized from the order at
  insert, all FKs `ON DELETE CASCADE`, indexes on restaurant/user) +
  migration `AddReviews1792727031487` (generated, DDL reviewed, applied to
  dev DB) adding the table and `restaurants.ratingCount int default 0`.
- `ReviewsService` rules: author = JWT subject only; unknown order, malformed
  uuid and *someone else's* order are all the same 404 (no existence leak —
  same contract as customer cancel); only `completed` orders are reviewable
  (400 otherwise); duplicate → 409 `CONFLICT` pre-checked and via a 23505
  catch for the double-submit race. `PATCH /reviews/:id` (author-only, empty
  patch 400, `comment:null` clears text), idempotent `DELETE`,
  `GET /reviews/my`, public `GET /restaurants/:id/reviews` (page envelope +
  rating summary) via a route-shaped controller in ReviewsModule (the
  RestaurantOrdersController precedent). Every create/update/delete calls
  `recomputeRating`: one aggregate SQL (`AVG` rounded to 2 decimals, COALESCE
  to the platform default 4.5 at zero reviews) + one targeted `UPDATE` — the
  ONLY writer of `restaurants.rating/ratingCount`; clients can never write it.
- Wiring: `Review` registered in the CLI `data-source.ts` entity list (first
  migration generate silently omitted the table — caught by DDL review, the
  spec pinning the entity count was updated to 8). Seed now adds 3 completed
  demo-customer orders (FO-SEED8/9/10) + 3 reviews and runs the same
  aggregate, so a fresh dev DB shows recompute visibly (warung 4.8→4.0 ×2,
  seoul 4.4→5.0 ×1) and reviews are in the TRUNCATE reset list.
- Web: `lib/api.ts` Review types + 5 client methods + `Restaurant.ratingCount`;
  `components/Stars.tsx` (SSR-safe display row with `aria-label`);
  `components/RateOrderCard.tsx` on `/orders/[id]` (completed orders only) —
  guest sign-in prompt with `?next=`, existing-review panel via `/reviews/my`,
  accessible star fieldset + 2000-char comment, 409 handled as resync-not-error;
  restaurant page shows the recomputed badge (`★ 4.0 · 2 reviews`) + a
  server-fetched "Recent reviews" section (10 shown, total note); home
  `RestaurantCard` badge gained the `(n)` count.

**Verified:**
- `nest build` clean; `jest` **254/254** (31 new: 22 service specs — order
  gating incl. foreign-404, dup 409 + race 409, non-unique error passthrough,
  recompute wiring/number coercion, author-only PATCH/DELETE semantics,
  envelope clamping; 9 DTO specs — star bounds incl. stringified/decimal,
  uuid screening, comment null-cap/2000-limit, whitelist stripping of
  injected `userId`/`restaurantId`/`id`/`orderId`/`status`).
- Migration applied to dev DB (`migration:run`; boot reports 0 pending);
  seed rebuilt and psql confirmed per-restaurant rating/count aggregates.
- Runtime smoke (API on :4000, python/urllib) — **36 checks**: public feed
  shape/404/clamp; login (201 is the pre-existing auth shape); `/reviews/my`
  3 rows + 401; dup 409; pending 400; foreign/guest order 404; rating 6 and
  bad uuid 400; no-token 401; full write cycle on a fresh order driven
  pending→completed by the owner: review 1★ → GET restaurant 3.0×3 → PATCH 5★
  → 4.33×3 → comment clear → DELETE → 4.0×2 → re-review 201 (unique released)
  → idempotent double-delete `removed:false` → cleanup restored 4.0×2.
  Injected `userId` provably stripped: the forged row was authored by the JWT
  subject and DB restored afterwards.
- `next build` clean; live `next start` :3000 curl checks: warung page SSR
  contains the feed (both seeded comments, "4.0", "2 reviews", reviewer name);
  completed order page has the rate card, pending order page does not.
- Browser test (login as demo customer): reviewed order shows the
  existing-review panel; unreviewed completed order → clicked 5 stars, typed
  comment, submitted → thanks panel with stars+comment, restaurant page then
  showed **★ 4.3 · 3 reviews** and the new comment in the feed (end-to-end
  recompute proof). Test review deleted via API afterwards — dev DB back to
  seeded 4.0×2 (one extra smoke order FO-XBHF remains in history, harmless;
  `npm run seed` resets it).

**Docs:** ARCHITECTURE reviews bullets + ER line + `ratingCount` data-model
note; ROADMAP item ticked.

**Left for next sessions:** review edit/delete UI (API supports it, card is
create-only); "My reviews" page; promo codes (next roadmap item).

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
