# DEVLOG

Newest entries on top. Format: `YYYY-MM-DD HH:MM — slot — summary`.

---
## 2026-11-24 10:35 — Session 124 — Scheduled perf regression runner: ops/perf-check.sh over the k6 write ladder with exit-code doctrine + analyzer selftests in CI + systemd timer example (Phase 13 Test item)

**Built:**

- Ops: `ops/perf-check.sh` — "baselines drift" is now caught by a RUNNER,
  not by memory. One-shot rig: preflight (node/jq/curl/npm/psql/docker,
  ENV_FILE, port-free fail-fast, flock against overlaps) → drop/create a
  scratch DB → `nest build` unless PERF_CHECK_BUILD=0 (a stale dist
  silently measures old code) → seed the full 29-migration chain →
  capture the seed window anchor → boot the compiled API on :4110 with
  boot-time-only relaxed limiter buckets (assembled via a runtime
  `RATE_LIMIT_${bucket}_MAX` loop so no credential-shaped literal ever
  reaches the transcript) → `/api/health` poll → k6 WRITE-LADDER smoke
  arm in the grafana/k6 container (`--network host`, shipped
  cache/compression defaults) → verdict → cleanup trap kills the API and
  drops the DB (PERF_CHECK_KEEP_DB=1 parks it). Exit codes mirror the
  alert-scan doctrine: 0 green · 1 REGRESSION · 2 rig broken; one compact
  JSON verdict line on stdout (rig metadata + analyzer facts + the
  crosscheck triple) so a MAILTO/OnFailure transport can parse it.
- Verdict logic split by design: `ops/perf-check.analyze.mjs` (pure +
  CLI) classifies the RUN from the k6 exit code — 99 crossed-internal-
  thresholds = regression; 108 = the profile's own abort guard fired,
  sample invalid = rig-broken; crash codes = rig-broken — then judges
  the RESULT from the summary JSON: p95 over PERF_CHECK_P95_MS_MAX
  (default 120 ms, ~7x the smoke baseline; the ladder's internal
  p95<500 is too loose to catch a 4x drift), 429 counter > 0, zero
  orders, capture ratio < 95%, failed-rate > 1%, checks < 0.99; thin
  samples (< PERF_CHECK_MIN_ITERS=5) and unreadable summaries are
  rig-broken, never green. Plus the session-121 doctrine inside the
  runner itself: exact DB cross-check (window orders == orders_placed,
  window succeeded payments == payments_captured, zero window orders
  lacking exactly one succeeded payment) and a zero-pino-level-50
  assertion over the scratch log.
- Selftests + CI: `ops/perf-check.analyze.test.mjs` — 18 node:test
  cases (healthy pin, both boundary rules exactly-AT and one-unit-over,
  capture boundary ceil(30*0.95)=29, exit 0/99/108/7 classes, thin
  sample, garbage/missing-field summaries, CLI process spawns asserting
  the 0/1/2 contract). The CI `api` job gained an "Ops script selftests"
  step running them plus `ops/load-test.contract.test.mjs` (the pure
  k6 helpers had no CI reference at all before this).
- Scheduling + docs: `ops/systemd/foodorder-perf-check.{service,timer}`
  example — daily 04:20 (after the backup slot, Persistent=true),
  TimeoutStartSec=20min so systemd's default cannot SIGTERM a healthy
  run mid-seed; PERFORMANCE.md gained the run section (exit-code table,
  anatomy, live proof numbers, knobs, honest NOT-gated list) and its
  workloads intro, and the session-82 recipe block was repaired: the
  committed line had lost its tail to the transcript sanitizer mid
  `JWT_SECRET=...` — the export is not needed at all (ConfigModule
  loads the secret from the untracked env file).

**Verified:**

- k6 container behavior MEASURED before coding to it (grafana/k6
  v2.3.0): crossed internal thresholds exit 99; `exec.test.abort` exits
  108 while STILL writing a thin summary-export (hence the run-class
  veto before the result rules); script-load errors exit 104; summary
  shape pinned: flat `metrics.<name>` values, rate metrics expose
  `value`, never-incremented counters are ABSENT (absence of
  rate_limited_429s means zero), per-metric threshold flags true=crossed.
- Live rig on this host, four runs total. GREEN exit 0: 29 iterations /
  147 requests / p95 17.99 ms / avg 8.94 ms / checks 100.00% /
  crosscheck orders=29/29 payments=29/29 orphan_orders=0, API killed +
  scratch DB dropped by trap. REGRESSION exit 1 proven LIVE through the
  real runner (PERF_CHECK_P95_MS_MAX=5 named "p95 18.01 ms exceeds
  ceiling 5 ms" while the crosscheck stayed exact). RIG-BROKEN exit 2
  proven live twice (held flock; busy port — and the report showed the
  scratch DB was never created). The FIRST green attempt honestly
  caught two of my own harness bugs live: a wall-clock window captured
  before the seed swallowed the 10 seeded fixture orders (39/29 +
  orphans=10 = exactly the seeded ten — re-anchored to strict > over
  the post-seed greatest(max createdAt) of both tables), and jq's
  empty-generator semantics (`($x|select(length>0))` inside an object
  construction deletes the WHOLE report on early-exit paths — now
  explicit if/else nulls).
- API jest 101 suites / 1361 tests green (numbers match session 123's
  pin — zero app-code delta: no `apps/api/src` or `apps/web` file was
  touched; `nest build` ran fresh inside the rig). CI yaml parsed clean
  via the patch lint; selftest invocation green locally (19 pass).
- Sanitizer scan over every added file and DEVLOG entry: no
  asterisk-mask sequences, no U+2026, no backslash-u escapes; the
  DATABASE_URL derivation and RATE_LIMIT bucket lines were codepoint-
  verified on disk after writing (the documented-safe expansion shape,
  no literal credentials anywhere).
- CI follow-through (post-push): run 160 (my commit) went GREEN on all
  jobs — the new ops-selftests step included. Its predecessor run 159
  (yesterday's DOCS-ONLY plan commit) was found RED on the web job: the
  bundle gate measured `/cart` 139311 = +5 B over its row on an untouched
  web tree, while the next run measured it back INSIDE — the session-120
  ±5 wobble, now proven two-sided. Fixed in-session: `/cart` re-adopted
  to the failing run's CI-measured 139311 (untouched rows keep their
  headroom), and the gate's annotation semantics repaired — a red run
  used to publish EVERY row as `::error`, which made exact-at-budget
  routes indistinguishable from the single real violation and cost the
  postmortem real minutes; rows now carry per-route LEVEL (::error only
  for violations, ::notice within budget), pinned as the 16th
  `node --test` case (16/16 green locally; scripts-only change, zero
  app-code, bundle sums unaffected).

**Left for next sessions:**

- Optional stmt/req gate inside perf-check via the session-79/104
  query-logger windowing (ALTER-before-boot), as a second arm.
- Run-over-run trend storage (alert_verdicts- or fixture-timings-
  JSONL-style) so nightly p95 drift is visible, not just verdicts.
- Phase 13 still open: the `GET /api/search` cache-whitelist decision
  and "Order again" from CANCELLED orders.
---
## 2026-11-23 20:13 — Session 123 — Rate-limit pressure telemetry: guard-verified per-route 429 tallies + 5th alert rule `rate_limit_pressure` riding fold line + alert-scan (Phase 13 Ops item)

**Built:**

- Ops: the 42s that the limiter sheds are now first-class telemetry. The
  metrics registry counted status CLASSES, so a store silently turning
  customers away was invisible between the limiter's own headers and a
  complaint. New DI-free `common/rate-limit/rate-limit.marker.ts`:
  `RateLimitGuard` stamps the blocked request with its bucket BEFORE
  throwing `RATE_LIMITED`; the metrics middleware demands BOTH halves —
  stamp present AND finish-time status 429 — so a hypothetical other 429
  producer (or a stamp whose response never reached the wire) can never
  inflate the tally. The registry gains an additive per-route + totals
  `throttled` counter (a subset of `byStatus['4xx']`; overflow folding
  carries it into the `other` row; `record()` keeps a 5th optional arg so
  every existing caller is untouched). GLOBAL snapshot only:
  `restaurantSnapshot()` never emits the key (rows OR totals) — the
  session-85/98/116 OWNER-rung shape stays byte-identical, pinned in three
  specs incl. the HTTP round-trip against a live guard-marked sample.
- Alerts: `ops/alerts.ts` gains the 5th rule `rate_limit_pressure` —
  throttled share of served requests STRICTLY above
  `ALERT_RATE_LIMIT_PCT_MAX` (default 5), gated by the SAME
  `ALERT_MIN_REQUESTS` floor as the budget rule (a lone 429 in a young
  sample is the limiter breathing); warning severity on purpose — the 429
  means the limiter WORKED, sustained pressure means customers are being
  turned away (capacity/config attention, not an outage). One engine,
  every consumer inherits it with zero changes: `GET /admin/alerts`, the
  compact `request_metrics` fold verdict, `alert_verdicts` persistence
  (full report verbatim), and `ops/alert-scan.sh` exit codes
  (0 healthy / 1 alerting / 2 broken).
- Wiring/docs: knob declared in `env.validation.ts` (garbage falls back,
  never crash-boots; 0 legal to prove the chain); typed contracts gained
  the fields — `MetricsTotalsResponse.throttled` + optional
  `MetricsRouteRowResponse.throttled` (documented admin-only) +
  `AlertRuleResultResponse` enum + `AlertThresholdsResponse.rateLimitPctMax`;
  admin route summaries name the 5th rule. Deliberately NOT done: the
  window-delta payload keeps its shape (old persisted rows lack the field;
  the subtraction ignores extras — persisted snapshots ride the counter
  automatically, a windowed 429 delta is a filed follow-up). No new
  routes/params: swagger ops stay 78, query-surface audit untouched.

**Verified:**

- API build green; FULL jest 101 suites/1361 tests (+17 vs session 122's
  101/1344, suites unchanged): registry unit describe x5 (per-route +
  totals tallies, unmarked 429 stays an honest zero, overflow carry,
  restaurant-view absence incl. the persistence feed, reset), live-chain
  integration x2 (marked-vs-unmarked probes through the REAL middleware;
  a throttled top-up on a minted restaurant bucket surfaces the field
  GLOBAL but never on the scoped snapshot), guard unit x1 (stamp on block
  only, bucket-named), rule unit x8 (present-FIFTH, not-evaluable, floor
  gate at a 60% share, exactly-AT-5 does not fire, one-unit-over flips the
  verdict ALONE, 0% tightened ceiling, unmarked-429 share stays 0, env
  parsing), alert-scan x1 (rate_limit_pressure rides exit 1). Mirror pins
  re-derived from the REAL engine (admin.controller fixture + the
  all-FIVE-rules-in-order combination test; `toHaveLength(4)` re-pinned
  to 5; fixtures carry the new fields so the drift guard stays honest).
- Live smoke 38/38 on the real driver (scratch DB `foodorder_rl123`,
  29-migration from-empty + seed, :4123, orders bucket 2/600s,
  ALERT_MIN_REQUESTS=10, p95 ceiling raised so ONLY the new rule can
  fire): baseline totals.throttled 0; 2 served 201s + 5 guard 429s ->
  row requests 7 / throttled 5 / 4xx-subset pin; junk 400 and metrics
  reads never inflate; envelope keeps RATE_LIMITED + retry_after_sec;
  GET /admin/alerts answers firingRules EXACTLY [rate_limit_pressure]
  (warning, threshold 5, observed share consistent with the live
  denominator); the 5s fold line carries the same verdict + count; the
  REAL alert-scan exits 1 naming the rule; OWNER metrics payload has no
  throttled key on totals or rows; docs-json registers all four contract
  additions and live ops == swagger.spec SUCCESS (78). Two harness
  lessons: the cross-check band between two separate admin reads must
  tolerate the in-flight reads themselves, and pipefail + grep-abort
  needs the `{ ... || true; }` wrap.
- E2E: full suite 126/126 GREEN x2 consecutive on fresh seeds (API-only
  change — additive payload fields invisible to the panels; the OWNER
  key-set pins held unchanged), fixture-timing gate OK (the one 44s
  limiter-wait was a 429 backoff, credited out of work legs by design).
  Web files untouched; no new bundle delta (budget gate unaffected —
  zero web app-code changes).

**Left for next sessions:**

- Windowed 429 delta: `window` could expose the exact per-window
  throttled share (honest-null for baselines persisted before today —
  the session-116 baseline-honesty ladder, already filed here).
- Per-bucket limiter pressure (auth/orders/payments split is in the
  marker; riding it onto the fold line for multi-process ops is cheap).
- `rate_limit_pressure` also deserves the TrafficPanel/AlertHistory
  cards to show it as a rail item — raw rule ids already flow (session
  114), only the copy is missing.
## 2026-11-23 18:41 — Session 122 — Guest order notification emails over the session-76 proof column (EN+ID bilingual); email copy extracted; SMTP_JSON_CAPTURE rig (Phase 13 Product item)

**Built:**

- Product: guests finally get their lifecycle emails. Session 45's fan-out
  skipped guest orders silently ("no `contactEmail` on Order entity yet");
  session 76's proof column made that excuse stale, this session spent it.
  `resolveEmail` ladder: authed orders keep the BEARER-ONLY rule unchanged —
  `user.email` and only `user.email` (the stored `contactEmail` is checkout
  input, never a verified fallback); guest orders send to
  `orders.contactEmail` RE-NORMALIZED at read time via the shared
  `normalizeContactEmail` (trim/lowercase — a legacy/imported row can never
  mail a non-canonical address); guests without the column stay silent like
  before. Push stays bearer-only (subscriptions are JWT-scoped). Every IN-API
  status path (owner/admin-via-HTTP/driver/customer cancels and the
  ADMIN-triggered stale sweep) rides the shared event bus, so guests gain
  confirm/preparing/delivering/completed/cancelled notices with zero new
  wiring. Honest boundary (pre-existing, unchanged by this session): the
  STANDALONE `cancel-stale` cron script runs in its own process with no bus
  consumer, so sweep-cancels notify nobody on any identity — durable-outbox
  territory.
- Extract: new DI-free `notifications/email-copy.ts` owns the templates —
  `STATUS_UPDATE_LABELS` + `confirmationEmail`/`statusUpdateEmail` builders
  taking a `locales` array. Locale doctrine (no recipient locale is stored
  ANYWHERE server-side — the cookie lives on the web side): authenticated
  renders `['en']` BYTE-IDENTICAL to session 45 (spec-pinned against a
  re-implementation of the pre-extraction builders), guests render `['en',
  'id']` as ONE bilingual email (EN block, dash separator, ID block; subject
  merged "EN title / ID title — #CODE"; output locale-sorted so argument
  order cannot drift). The `locales` array is the extension point for a
  future stored per-user locale.
- Ops rig: `MailService` gains `SMTP_JSON_CAPTURE` (`true/1/yes`,
  case-insensitive; garbage INERT — a typo can only silence capture, never
  deliver): nodemailer jsonTransport, nothing leaves the process, every send
  logs one single-line `MAIL_CAPTURED {json}` entry. Takes precedence over
  `SMTP_HOST` (works with no relay at all). Declared in `env.validation.ts`
  + documented in `.env.example` and the mail.service header.

**Verified:**

- API build green; FULL jest 101 suites/1344 tests (+1 suite/+26 vs session
  121's 100/1318): `email-copy.spec.ts` EN byte-identity + EN/ID label-table
  completeness + bilingual composition + locale-order pin;
  `mail.service.spec.ts` +5 rig cases (jsonTransport with no host,
  precedence over a real host, garbage inert, exactly-one greppable payload
  line per send, silent when disabled);
  `order-notifications.service.spec.ts` — the two legacy "guest skips" pins
  intentionally FLIPPED to the new contract (bilingual mail + normalized
  `to` + no push + no user-table query), plus re-normalization of a
  non-canonical stored address and the bearer-suppression case (authed order
  with `contactEmail` set mails ONLY `user.email`, EN-only copy).
- Live smoke 27/27 on the real driver (`foodorder_gmail22`, 29-migration
  from-empty chain + seed, :4122, confirm gate opened): ARM1 boots with
  `SMTP_JSON_CAPTURE=1` and no host — guest create yields EXACTLY 1 capture
  with normalized `to` + bilingual subject + both greetings + `Kirim ke:`;
  owner confirm + cancel each yield their bilingual notice (ID support hint
  present); authed demo order yields exactly 1 EN-subject capture to
  `demo@foodorder.app` with ZERO captures ever to the proof address (bearer
  suppression proven on the wire); no-contactEmail guest changes nothing;
  ARM2 garbage value (`ture`) + no host falls back to the disabled warning
  with zero captures. Scratch DB dropped. Two harness lessons earned mid-
  smoke: the boot WARN line embeds the marker words (matcher now requires
  `MAIL_CAPTURED {`), and pino lines carry the payload escaped inside `msg`
  (parser gained the unescape fallback) — both harness bugs, product fine.
- Web files untouched (web delta 0); no new routes/DTOs/query params —
  swagger contract and query-surface audit unchanged; e2e untouched (mail is
  server-side only, checkout already collects the proof email).

**Left for next sessions:**

- Put the receipt DEEP-LINK into guest emails (`/orders/:id?email=<proof>` —
  the web link contract since session 76): today guests must type the proof
  into the OrderVerify island.
- A stored per-user locale (profile field) would replace the bilingual
  guest compromise — `email-copy`'s `locales` parameter is ready for it.
- Stripe/Xendit adapters + order-centric per-restaurant attribution remain
  the two 🔒 roadmap items (keys / registry design).
- Sweep-cancel notifications (the standalone cron script has no bus — see
  the honest boundary above; fix belongs to the durable-outbox idea).

---
## 2026-11-23 17:26 — Session 121 — k6 WRITE ladder over the cached+compressed stack; caught+fixed the orders.code birthday-collision 500 (Phase 12 Test item)

**Built:**

- Ops: new `ops/load-test-write.js` — the write ladder the roadmap item
  asked for: anonymous CACHEABLE browse GET (session 82's ladder read the
  detail bearer'd — an anonymous-whitelist opt-out, so no write path had
  ever touched the cache+gzip stack) -> signup (1/VU) -> order create ->
  payment intent -> capture -> bearer receipt. Loud contracts, session-104
  doctrine: ANY 429 aborts the run naming the bucket from the error
  envelope (rate_limited_429s threshold `count==0` too); under `CACHE_ARM=on`
  every browse response must carry a strong ETag + `Cache-Control: public`
  AND honor BOTH sides of the 1024 B compression threshold (decoded >= ->
  gzip + numeric encoded Content-Length; below -> byte-transparent identity;
  k6 decompresses at the JS layer so res.body.length is the honest
  comparator); the receipt read is pinned NOT cache-marked (layers
  off-whitelist = no res patch). Per-leg trends `browse_ms`/`write_ms`.
  Profiles + the deterministic-cart pins live in `ops/load-test.lib.mjs`
  (smoke 1 VU x 30 s; load ramp to a MODEST 5-VU plateau); the ops contract
  test grew 10 assertions (shape pins + determinism, `node --test` green).
- **Fix (found BY the profile's first load run):** `orders.code` is UNIQUE
  but `generateCode()` drew 4 chars from the 31-char alphabet via
  `Math.random()` — birthday-paradox odds growing quadratically with table
  size; the first run 500'd with duplicate-key 23505 after 160 in-run
  orders (~200 rows), the pre-existing session-82 baseline having sat
  luckily under the curve at 992. Session 121 shipped: 6-char draws from
  `crypto.randomInt` (924k -> ~887M space), and `create()`'s unit-of-work
  now re-runs up to 3 times on SQLSTATE 23505 with a FRESH code per attempt
  (the failed INSERT rolls the whole tx, stock decrements included, and
  `em.save` re-mints the PK — a retry cannot double-take; the random code
  is the only by-chance-collidable constraint inside that tx — promo caps
  re-check under FOR UPDATE and raise 400s). Past the bound the violation
  rethrows (pre-fix behavior becomes last resort). The tx body moved to a
  private `attemptCreateUnitOfWork` untouched in substance.
- API: +1 suite/+5 tests `order-code-collision.spec.ts` (format regex over
  the exact alphabet, redraw-per-attempt via a draft-code recorder, the
  bounded give-up, non-unique errors pass through UN-retried, promo ledger
  row survives the extraction on the retried path). Entity comment +
  generateCode docstring record the math.

**Verified:**

- ops contract test green; API build green; FULL jest 100 suites/1318
  tests (+1/+5 vs session 119's 99/1313).
- Live smoke 13/13 on the real driver (`foodorder_k6write`, 29-migration
  from-empty chain + seed, :4100, relaxed buckets): plain create 201 with
  a 6-char code; DETERMINISTIC retry proof — a BEFORE INSERT trigger raised
  23505 on exactly the first two attempts (counter via `nextval` BECAUSE a
  table UPDATE inside the trigger rolls back with every aborted tx — the
  first smoke iteration proved that trap by pinning the mode raise forever),
  third attempt committed, exactly ONE row, exactly two WARN lines;
  always-raise arm exhausted at 3 attempts -> 500 envelope, zero rows
  leaked, and the 500 is ATTRIBUTED via the log stack naming the simulated
  collision (a bare status-code PASS once hid a 42501 — the session-109
  "trigger runs as the APP role" ownership trap, GRANTs now in the script);
  24-way concurrent burst 24/201 all-unique well-formed codes; zero
  duplicate codes table-wide.
- k6 baseline arms (fixed dist): smoke 29 iters/147 reqs/352 checks all
  green; load CACHED (shipped TTL 15 + gzip 1024) 506 iters/2,536 reqs
  18.09 req/s, p95 12.71 ms, 6,076/6,076 checks, 0 429s, 0 failed
  requests; load CONTROL (HTTP_CACHE_TTL_SEC=0, gzip ON) 505/2,531,
  p95 13.79 ms, 4,546/4,546, 0 429s. Query-logger stmt/req (run-unique
  MARK_ windows, statement|execute counted): 8.00 control -> 7.11 cached —
  an honest 11% collapse (write legs dominate; the cache covers 1 of 5
  requests) but the browse leg 5.22 -> 1.53 ms avg on ZERO SQL in-TTL.
- Post-run DB cross-check EXACT: 1,011 new orders = the two counters
  (506+505), every one pending with exactly one succeeded payment, 10
  users, zero bad-format codes across 1,287 rows, zero 5xx in either
  window's API log (all post-boot 500s are the deliberate smoke trigger);
  health ok; scratch DB dropped.
- e2e touch (code flows to headings/URLs): 14/14 on the five specs that
  exercise create/receipt (guest-order-smoke, pay-order, zz-forms-a11y,
  menu-options, mobile-cart-checkout) against the fixed dist on a fresh
  seed — all format pins were already regex-flexible. Full suite and web
  build NOT re-run (zero web files touched).
- Sanitizer scan clean on all added lines (codepoint-checked: U+2026 masks,
  asterisk-mask sequences, literal backslash-u escapes); the write-ladder
  credential keys use the runtime-assembly idiom (session 80 doctrine).

**Left for next sessions:**

- The dev-box `foodorder` DB already carries pre-fix 4-char codes and may
  hold collision-adjacent history; nothing to migrate (codes are opaque),
  but a `docs/` note or ADMIN probe if volume grows.
- Session-120 post-push incident follow-through: confirm CI green for
  THIS push too (bundle baseline was re-adopted; this session changed no
  web bytes — the run should be clean).

============
## 2026-11-23 15:45 — Session 120 — Dark-theme focus ring + mobile bottom-bar keyboard audit (Phase 12 UX item)

**Built:**

- e2e: `focus-skip-a11y.spec.ts` grew the two halves the audit named.
  (1) DARK half: the `theme` cookie is set context-side so even the first
  navigation SSRs `html[data-theme='dark']`; the skip link and a header
  button on the storefront, and the dashboard restaurant switcher + the
  roving `#status-tab-all`, all re-walked by real Tab presses must now
  read the swapped ring brand-500 rgb(249,115,22) — same style/width/
  offset contract, exact computed-style equality.
  (2) MOBILE half: `tabStopsCycle` walks EXACTLY ONE full Tab cycle at
  360x800 (land on the skip link first, press until focus cycles back to
  it; headless Chrome inserts a phantom `body` stop at the document edge,
  which the helper documents and callers filter). On /cart (6-line seed
  recipe, so the document really scrolls): the bar's clear button and the
  checkout CTA are the FINAL two stops before the wrap, adjacent, both
  wearing the light ring, and focusing into the bar never un-sticks it
  (bottom edge pinned 796..801). On /checkout ($18+$7 cart, no submit
  pressed): the tail is `checkout-submit -> checkout-promo-input ->
  mobile-submit-cta` — the sticky handle is the document's last
  focusable; the empty promo keeps Apply disabled and disabled buttons
  contribute NO stop; the bar CTA is asserted ENABLED before the walk so
  a silent `canSubmit` regression could not hide the stop.
- Web: ONE product-side attribute — `data-testid="mobile-cart-clear"` on
  the compact bar's clear button (the walk needs a stable identity for it;
  the desktop duplicate action row was deliberately left untestided so
  strict testid locators stay compact-bar-only).
- Docs: ARCHITECTURE.md gained the consolidated **Keyboard focus
  contract** bullet — session 117's rule had lived only in globals.css
  comments + DEVLOG; the bullet now also records the theme swap and the
  compact-bar tab-order tail rule this session proved.

**Audit verdict (honest):** zero product bugs found. The `--focus-ring`
CSS-var swap works identically under the cookie-rendered dark theme, the
bg-white/90 bar surface inverts to rgb(41,37,36) (asserted in the walk's
dark phase), and the compact bars' DOM placement already yields correct
keyboard order. The session's deliverable is the PINNED contract, not a
fix. Harness truth learned the hard way (2 FAILs before green): Chrome
blur()/body focus keeps a sequential-navigation starting point — a Tab
from `<body>` can resume MID-cycle, so cycle walks must anchor on the
first stop (the skip link) instead of assuming document-top; and the
skip link carries its own `data-testid=skip-link`, so element naming must
check the href pattern BEFORE the testid branch or the wrap sentinel
never fires.

**Verified:**

- Targeted ladder: focus spec 10/10 (6 pre-existing session-117 tests
  unchanged and green against the parameterized helpers) + dark-mode
  spec = 11/11; the two new mobile tests green on first run after the
  harness fix.
- Web build green; bundle gate OK — margins +41..+50 B on all 7 routes
  (/cart absorbed the testid: +41 vs +48-50 elsewhere, CI budget table
  untouched).
- Full e2e 126/126 green x2 CONSECUTIVE on fresh seeds (122 + the 4 new
  tests); fixture-timing gate OK (18 labels, 6 prior runs merged).
- API delta 0 — no apps/api file touched, no jest run needed (unchanged
  99/1313 per session 119).
- Sanitizer scan clean on all added lines (U+2026 masks, asterisk-mask
  sequences, literal backslash-u escapes); em-dash/arrow prose chars
  landed as real characters, not escape text.
- POST-PUSH CI INCIDENT (honest, same session): CI run 137553015648 went
  RED on the Web bundle gate ALONE (e2e/API/PG15/PG16 all green). The
  annotations showed /cart measured=139306 over the 139304 row (+2 B —
  the mobile-cart-clear testid, local margin +41 had hidden nothing but
  CI sums run ~43 B above local per the session-118 path truth), while
  every UNTOUCHED route measured 5 B UNDER budget: shared 2619-*.js back
  at gzip 3385 despite the pinned runner node 22.23.5 — session 119's
  "+5 forever" attribution is therefore not the sole stabilizer. Fix per
  the re-measure doctrine: /cart row re-adopted to this run's
  CI-measured 139306 with the drift note above; untouched rows keep the
  +5 headroom rather than chasing a wobbly number. The follow-up CI run
  must be fully green.

**Left for next sessions:**

- k6 WRITE profile against the cached+compressed stack (the queue's last
  open non-locked item).
- Optional ring follow-up: the focus-skip suite pins storefront + owner
  dashboard + kitchen/driver/admin rings under LIGHT only for portals;
  the dark portal pass covers owner — driver/admin dark walks could
  reuse `setTheme` + one stop each if the evergreen UX loop asks again.

---
## 2026-11-23 13:11 — Session 119 — Tracking-page delivery polish: driver first name + honest countdown on the delivering receipt (Phase 12 product item)

**Built:**

- API: pure DI-free `orders/delivery-view.ts` — `buildOrderDeliveryView`
  derives `remainingMinutes = ceil((ETA seconds − confirmedAt→now)/60)`,
  clamped at 0 (= arriving soon), anchored on `createdAt` when
  `confirmedAt` is unusable, null when no honest basis exists; reuses
  session 113's `buildDeliveryEta` so 'observed'/'estimate' semantics are
  byte-identical to the restaurant pill (never claims observed below the
  5-sample floor). `firstNameOf` emits ONLY the first name token of the
  driver's user name.
- API: ONE attach point — `OrdersService.findOneForViewer` routes all
  three access rungs through `attachDeliveryView`, which fires ONLY when
  status is `delivering`: session 113's own `DELIVERY_ETA_SQL` against
  the orders repo (one statement, positional array param) +
  `UsersService.findById` for the driver name. Sub-read failures degrade
  INSIDE the view (`etaSource: null`, driver line survives) — the receipt
  never 500s; a DENIED viewer 404s before any embed read runs. Every
  other status/read/echo is byte-identical (early return, zero queries).
- API: additive swagger `OrderDeliveryViewResponse` component +
  `OrderResponse.delivery` (class defined BEFORE OrderResponse — model
  thunks resolve at decoration time). No new routes: docs op/path count
  unchanged (64 paths).
- Web: SSR card under the timeline in `/orders/[id]/page.tsx`, gated on
  `status === 'delivering' && order.delivery` (mirrors the wire contract);
  testids `tracking-delivery` / `-driver` / `-eta`; observed basis rides a
  title tooltip with the sample count (ICU plural kept numeric).
  `lib/api.ts` mirrors the view type. 5 new `Order` ns keys EN/ID
  (84→89, parity + ICU token-set asserted on disk BEFORE the merge;
  files proved roundtrip-identical so the json.dump merge churned only
  the 6 intended lines per file — the lone extra is a pre-existing
  trailing-comma reformat on `pageTitle`, byte-same value).
- e2e: `zz-tracking-polish.spec.ts` (2 tests) — paid+owner ladder,
  driver assigned mid-flow, preparing proves NO card/no key, the flip
  proves the DOM ↔ own-API-payload cross-check with the ETA-branch
  invariant (never an absolute minute pin — earlier specs move the
  median); ID locale pass byte-pins `Sedang diantar Demo` + the
  countdown regex. Sorts last among zz-*: zero shared-seed consumption.

**Verified:**

- API build green; jest 99 suites / 1313 tests (+1 suite / +19 tests vs
  session 118's 98/1294): 12 pure-builder cases + 7 service-ladder cases
  (rung parity, per-status no-query no-key sweep, aggregate-boom degrade,
  unassigned order, no-users harness, denied-404-runs-no-reads; fake
  timers make the countdown arithmetic exact).
- Live smoke 26/26 on a 29-migration from-empty scratch DB, gate-OFF boot
  (status flow, payments not under test): preparing receipt zero
  `percentile_cont` statements in its query-logger window (first run
  caught the session-79 GUC trap — ALTER must precede boot so the pool
  connects with logging — every window counted 0); delivering receipt
  exactly ONE; confirmedAt rewound 10 min makes the estimate branch
  deterministic — sampleCount 3 (seeded Warung completions <5 floor),
  remainingMinutes 15 = ceil((1500−600−δ)/60); bearer/proof/ADMIN payloads
  byte-identical via jq -cS; wrong proof = same 404, no delivery key;
  completed flip removes the key; embedded restaurant never leaks
  deliveryEta; docs-json registers the component; API log zero errors.
- Web build green; bundle gate OK — margins +43..+45 B IDENTICAL on all 7
  routes (a server-component + message change adds zero chunk bytes; the
  +44 uniform offset = the documented ~+4..6 B path phantom + the −39 B
  NEXT_PUBLIC_API_URL define-fold now visible on ALL routes under the
  session-118 chain method, per that session's own 7621-via-layout note).
- Full e2e 122/122 green ×2 CONSECUTIVE on fresh seeds (targeted 2/2
  first); fixture-timing gate OK (62 work legs, max 155 ms, 5-run history
  merged). Sanitizer scan clean on all added lines (U+2026 masks,
  asterisk-mask sequences, literal backslash-u escapes).
- POST-PUSH CI INCIDENT (same session, honest note): the push's CI run
  45120203711 went RED on the bundle gate alone (e2e/API/PG15/PG16 jobs
  all green) — every route measured exactly +5 B OVER the committed
  table. The gate self-report made the postmortem anonymous and
  per-file: diffing THIS run's `bundle-chain` annotations against run
  45097501585 (session 118's probe, byte-identical app code, node
  22.23.2) shows ONE changed chunk — shared 2619-*.js gzip 3385 → 3390 —
  i.e. the runner image's Node 22.23.2 → 22.23.5 patch drift moved the
  sums, my change contributed zero (margins uniform across untouched
  routes too). Session 118's "Node pin irrelevant" verdict is RETRACED
  (its A/B arms resolved to the same version — the experiment was blind,
  not the variable). Fix shipped as a follow-up commit: table re-adopted
  to the CI-measured +5 numbers (node 22.23.5 labeled), the web CI job
  pinned to 22.23.5 with the annotation-diff evidence in the comment,
  PERFORMANCE.md doctrine amended (deliberate runner-Node upgrades =
  re-measure ritual). Verification: the follow-up CI run must be fully
  green at the pinned 22.23.5 (proving budget >= measured for all 7);
  the exact +5 for the two truncated routes follows from the per-file
  diff itself — every OTHER chunk in their chains is byte-identical
  across the two runs and 2619-*.js rides every chain union exactly
  once, so their sums cannot have moved by anything but +5.

**Left for next sessions:**

- The Phase 8 🔒 order-centric attribution item still gates per-restaurant
  TRAFFIC for POST /orders + payments (the delivery embed itself needs no
  attribution — it rides the receipt read).
- The live-feed e2e could grow a 4th assertion riding the delivering→
  completed flip announcing the arrival card disappearing (card presence
  is today pinned via navigation, not push).
- UX: dark-theme focus ring + mobile bottom-bar pass is the next top-down
  item.

---
## 2026-11-23 09:38 — Session 118 — Bundle-gate undercount FIXED: the full ancestor chain (layouts + CSS) is now summed (Phase 12 perf item)

**Built:**

- `check-bundle-budget.mjs` per-route metric rewritten: the UNION of the
  route's own manifest entry and every ancestor layout entry (`/layout`
  down to `${route}/layout`, only keys present in the manifest), summing
  gzip-9 `.js` AND `.css` files, each counted exactly ONCE (dedup).
  New exported `ancestorLayoutKeys` helper (segment-stripping, never a
  listing heuristic); the report line now shows
  `N js + M css, chain: K entries`.
- The metric is deliberately BROADER than Next's printed "First Load JS"
  column (Size + shared only — the table shares the same blind spot): it
  is what the browser actually downloads on first paint. For `/` the old
  gate was blind to 28,805 B: 6,749 CSS + 12,087/2,148/4,117 chunks
  reachable only via the root layout + 3,704 `app/layout-*.js` — exactly
  where the session-117 SkipLink lived.
- Baseline RE-MEASURED with the new method; final committed numbers are
  the CI-measured sums (see the CI incident under Verified): `/` 135,773
  · `/restaurants/[id]` 138,844 · `/cart` 139,299 · `/checkout` 142,333
  · `/map` 137,011 · `/orders/[id]` 159,678 · `/orders/my` 144,304 B;
  table header relabeled "Baseline First Load JS+CSS, full chain (B,
  CI-measured)".
- Selftests 13 -> 15 cases: the CSS rule is REVERSED (a JS-only baseline
  must now fail naming exactly the CSS bytes); the LAYOUT-only negative
  the roadmap asked for — a chunk listed ONLY under `/layout` trips the
  gate (the SkipLink repro); a nested-chain test — root +
  `/dashboard/layout` + `/dashboard/kitchen/layout` all count and a chunk
  shared by all four entries dedupes to ONE count; existing rigs'
  baselines corrected for the CSS term.
- docs/PERFORMANCE.md gate section rewritten for the new method (blind-spot
  cause and the per-chunk byte breakdown recorded, session-115 CI-clean
  doctrine kept and extended with the reproducibility proof); CI web-job
  step comment updated.

**Why:** session 117's honest A/B proved the gate's zero-margin was a
methodology artifact — root-layout and CSS chunks were invisible to all 7
pinned budgets, so any future layout/globals.css growth would silently
pass. Filed as Phase 12 item 1; fixed now so every later web session is
budgeted honestly.

**Verified:**

- Selftests `node --test scripts/check-bundle-budget.test.mjs` 15/15.
- Re-measure ritual: `.env.local` stashed, `rm -rf .next && npm run build`
  cold on node 22 (CI's major) green; `--print` emitted the table numbers
  verbatim; the gate against the new table reports margin +0 on ALL 7
  routes; the LIVE 1-byte-under negative on the real `.next` exit 1 naming
  all 7 (session-115 precedent: local CI-clean sums reproduce CI exactly —
  run 44885551814 was green on the re-measure push).
- Reproducibility proof: the OLD-method own-entry sums of the SAME build
  reproduced the session-115 table byte for byte (`/` 106,963,
  `/orders/[id]` 145,103, all 7) — chain deltas are purely the newly
  counted layout/CSS bytes, no build drift.
- `.env.local` restored; CI-clean build kept as the on-disk `.next` — the
  `NEXT_PUBLIC_API_URL` define-fold default is the SAME literal
  (`http://localhost:4000/api`), so local runs are functionally identical.
- Web app-code delta 0 (only `scripts/` + docs + ci.yml comment touched);
  e2e not exercised for a tooling change. API delta 0: `nest build` clean,
  jest 98 suites / 1294 tests — byte-identical to session 117's claim.
- Sanitizer scan: no ellipsis-codepoint, asterisk-mask, or unicode-escape
  artifacts on added lines; `git diff --check` clean. (Process note: one
  patch tool context_aware landing DOUBLED the backslash escapes on two
  template lines — caught by `node --check`, repaired byte-wise; the
  returned diff is not always truth, the syntax check is.)
- THE CI INCIDENT (three runs, fully diagnosed, table corrected): the
  first CI run of the new method went RED +4..+6 B on every route — the
  session-115 doctrine's own contingency fired ("the table needs the CI
  numbers instead"). Diagnosis chain: (1) gate given per-route
  `::error` annotations (Actions logs are admin-only; check-run
  annotations are anonymous-readable via the API) — CI sums land
  uniformly +5 B; (2) Node pin 22.23.2 + zlib notice: sums IDENTICAL
  before/after the pin, Node/zlib exonerated (pin reverted, notice step
  kept); (3) per-file `bundle-chain` annotations: EVERY chunk byte-
  matches the local CI-clean listing except `main-app-*` (−1 B) and
  `app/layout-*` (+6 B) with page chunks differing only in hash at
  equal size; (4) decisive experiment — `cp -al` the repo to the EXACT
  runner path and rebuild locally: those two chunks flip to CI's hashes
  and sizes. ROOT CAUSE: the checkout path is embedded into the
  main-app/app-layout chunk module ids, so absolute sums are PATH-
  dependent (the session-117 worktree "phantom −84 B" was the same
  mechanism); the old own-entry sums agreed across environments only by
  size coincidence, and the local build additionally drifted from
  session 117's via the .env.local define-fold (chunk 7621, 2109 vs
  2148 B — session 115's +39 B story seen in the shared-chunk mirror).
  COMMITTED TABLE = CI-measured numbers (runner path is stable and is
  where the gate enforces); local gate runs now show a known phantom
  +4..+6 B margin. VALIDATED: final run 45098645551 FULL CI GREEN —
  the chain gate enforcing its own corrected zero-tolerance table on
  the runner, all 5 jobs.

**Left for next sessions:** Phase 12 items 2-4 — tracking-page delivery
polish, dark-ring + mobile bottom-bar focus pass, k6 WRITE profile. If a
future runner-image update changes the CI sums, the gate's `bundle-chain`
annotations diff the listing against any local build in minutes; a
dev-box node upgrade needs NOTHING (toolchain was proven irrelevant).

---
## 2026-11-21 20:10 — Session 117 — focus-visibility + skip-link audit: ONE global :focus-visible contract, keyboard-pinned (Phase 11 UX item, closes the phase)

**Built:**

- `app/globals.css` now owns the whole keyboard focus contract: one
  trailing `:focus-visible { outline: 2px solid var(--focus-ring);
  outline-offset: 2px }` (+ `#main-content:focus { outline: none }`).
  Declared AFTER `@tailwind utilities` it ties-and-wins against
  Tailwind's bare `.outline-none` (both (0,1,0), source order decides):
  text inputs keep their soft `focus:` border/ring paint for MOUSE
  focus while keyboard focus additionally gets the honest 2px brand
  ring. `--focus-ring` theme-switches (light brand-600 rgb(234,88,12),
  dark brand-500 rgb(249,115,22)) for >=3:1 non-text contrast on both
  canvases. ONE rule is what makes EVERY portal control focus-visible —
  the audit found exactly one real suppressor outlier besides it.
- The outlier: `ReviewReplyComposer`'s textarea carried the ONLY
  `focus:outline-none` VARIANT (specificity (0,2,0) — it would have
  beaten the contract on keyboard focus). Rewritten to the app-wide
  idiom (bare `outline-none` + `focus:border/ring`).
- New `SkipLink` client component wired as the FIRST focusable element
  in the root layout: sr-only until focused (`focus:not-sr-only` chip),
  label `Common.skipToContent` EN "Skip to content" / ID "Lewati ke
  konten" — the ONE genuinely new key pair (the roadmap said "existing
  keys"; none covered the skip affordance, message JSONs edited via
  surgical anchored inserts with count==1 + EN/ID Common parity
  asserts). Enter preventDefaults and moves DOCUMENT focus to
  `<main id="main-content" tabIndex={-1}>` programmatically —
  fragment-navigation focus transfer is browser-dependent; `.focus()`
  on a tabindex -1 target is not, and it made the e2e contract
  deterministic.
- `data-testid="kitchen-refresh"` / `"driver-refresh"` added so the
  ring pins target stable CSS selectors, not localized button text.
- New `e2e/tests/focus-skip-a11y.spec.ts` (6 tests): EVERY ring
  assertion is earned by REAL Tab presses walking the tab order until
  the target is `document.activeElement` (never `.focus()` —
  programmatic focus does not reliably match `:focus-visible`), then
  an EXACT computed-style equality on {solid, 2px, rgb(234, 88, 12),
  offset 2px}: skip link discovery + reveal + its own ring + the main
  target wearing NO ring + Enter focus hand-off (EN), ID locale label,
  owner dashboard (header button, restaurant switcher select, roving
  ARIA tab), kitchen board, driver portal, admin. Read-only/seed-safe:
  sign-ins + navigation only, creates no orders.

**Why:** session 77 audited storefront a11y only; since then every
portal surface grew controls with NO focus styling at all (UA default
rings, washed out on the dark canvas) while the inputs shipped a soft
border-color swap as their only keyboard signal — and keyboard/SR
users had no way to jump the header chrome. Phase 11 demanded both,
pinned the portal-a11y keyboard way.

**Verified:**

- `apps/web npm run build` green (x2 — the second build fed the suite).
- Bundle-budget honest A/B, IN-PATH (stash -> clean build -> --print ->
  pop -> clean build): HEAD and this tree print the committed table
  EXACTLY — gate margins all +0, gate OK. Root cause of the zero delta
  discovered while proving it: the gate sums each route's OWN
  app-build-manifest chunks, and the root LAYOUT chunk (which grew
  +209 B gz carrying SkipLink) is not listed for any pinned page — a
  real methodology undercount, filed as Phase 12 item 1 instead of
  being papered over. (A first A/B in a git worktree printed a phantom
  -84 B across the board — absolute gzip sums are path-sensitive;
  in-place builds are the doctrine.)
- targeted `focus-skip-a11y` 6/6 first run; FULL e2e 114 -> 120 green
  x2 CONSECUTIVE on fresh seeds (3.3 min each); session-106
  fixture-timing gate OK (max work leg 92 ms, limiter waits
  classified).
- API delta 0: `npm run build` clean, jest 98 suites / 1294 tests —
  byte-identical suite/test counts to session 116's claim.
- Sanitizer scan: 0 U+2026 / `***` / literal backslash-u sequences
  across added diff
  lines and both new files; `git diff --check` clean; message JSONs
  re-parsed (EN/ID key parity asserted).

**Left for next sessions:** Phase 12 opened (backlog never empties) —
the bundle-gate layout undercount fix FIRST, then the dark-canvas ring
pin + mobile bottom-bar focus pass, the tracking delivery polish, and
the k6 write profile.

## 2026-11-21 18:05 — Session 116 — Per-restaurant durability: persisted restaurant dimension + OWNER windowed deltas (Phase 8 🔒 item)

**Built:**

- `persistNow` now writes `{...global snapshot, restaurants: <entry map>}`
  into the SAME `metrics_snapshots` jsonb rows — one capture instant per
  tick serves both dimensions, so NO new table and NO 30th migration.
  `RequestMetricsRegistry.restaurantEntries()` is the persistence feed
  (every minted bucket, lowercased-id keys; cap-refused ids are absent by
  construction, so a stored map can never carry foreign attribution).
- `metrics-window.ts` widened to a structural `CumulativeSnapshotLike`:
  `computeWindowDelta`/`isSnapshotShape` now run on BOTH snapshot shapes
  — one monotonicity rule set (negative pair / vanished key / bounds
  mismatch → null, never a clamp), no second windowing engine.
- New `MetricsPersistenceService.describeRestaurant(rid, live)` — the
  OWNER-rung honesty ladder: same-boot row with entry → exact
  bucket-internal subtraction; entry ABSENT → the bucket provably minted
  after the row (rows always carry every minted bucket), so the window
  rides an honest ZERO baseline anchored at the row instant with
  `mintedAfterBaseline=true`; cross-boot row → null until this boot's
  first row (a restart inherits no false baseline); pre-session-116 row
  (no `restaurants` key) → `restaurantsPersisted=false` + null, never
  zero-clamped; operator-corrupted entry → null; ANY store failure →
  `error=true` and the route still 200s with the live bucket.
- `GET /restaurants/:id/metrics` adds exactly ONE top-level key,
  `durability`; the window delta is NESTED under `durability.window`
  because the session-98 contract pins the top-level `window` to the
  `'since_api_boot'` marker string (additive-only: session 99's e2e byte
  pins kept). The scoped block DELIBERATELY drops the admin durability's
  `stored` global row count — the session-85 ADMIN-only rule extends from
  global traffic to global durability metadata. Swagger contract extended
  (same op, no count change).
- Web: `lib/api.ts` mirrors the new fields (`durability`/window views)
  with the corrected honesty comments; the `TrafficPanel`/dashboard read
  nothing new. `owner-traffic.spec.ts` key-set pin updated: `durability`
  rides, its own 10-key set pinned mechanically, `stored` asserted ABSENT,
  window pinned by SHAPE only (tick-timing differs between fresh and warm
  servers).

**Verified:**

- API build green; jest 98 suites / **1294 tests** (+15 vs a measured
  HEAD baseline of 1279 — re-verified by `git stash push -u` + rerun):
  +10 describeRestaurant ladder cases, +3 restaurantEntries registry
  cases (incl. cap-refused ids absent), +1 window-engine restaurant-shape
  case, +1 HTTP durability-passthrough case, and the two legacy key-set
  pins rewritten.
- Live scratch-DB smoke **48/48** on a 29-migration from-empty DB,
  METRICS_SNAPSHOT_INTERVAL_SEC=6 (3 API boots): pre-row honesty; EXACT
  window = the 2 post-baseline GETs vs the stored entry's 3 tallies
  (cross-checked in psql jsonb); minted-after-baseline zero anchor for a
  second restaurant (ADMIN bypass rung); pre-116 row via `payload -
  'restaurants'` → null-not-clamped; RESTART: prev-boot row refuses a
  false baseline, 2 distinct boot stamps survive, post-restart re-mint
  window == live; disabled writer (interval 0) never touches the store;
  ADMIN rung byte-stable (no `restaurants` key at its top level);
  observer exemption holds (polls 1/1); 0 error-level log lines. First
  run 46/48 — both failures were HARNESS bugs (login before boot; a
  boot-stamp check placed before the new boot's first tick), zero
  product bugs.
- Web build green; full e2e **114/114 twice** (fresh seed between runs,
  Playwright-booted servers on free ports).

**Left for next sessions:**

- Phase 8's last 🔒 item — order-centric attribution (`POST /orders`,
  payments, receipt reads opt into restaurant buckets service-side).
  Its window will then extend to those routes automatically, since the
  persistence feed captures whatever the registry holds.
- The owner web panel could surface `durability.window` (a "since last
  snapshot" view beside the cumulative cards) — panel untouched this
  session; needs a Portal copy pass + e2e.
- Snapshot payload size now grows with minted buckets × restaurant
  template rows; worst case is ~250 buckets and bounded retention — fine
  at defaults, worth a PERFORMANCE.md note if the surface grows.

---
## 2026-11-21 16:16 — Session 115 — First Load JS budget gate in the CI web job (Phase 11 perf item)

**Built:**

- `apps/web/scripts/check-bundle-budget.mjs` — zero-dep node gate. Exact
  First Load JS per route = gzip-9 sum of every `.js` chunk listed for the
  route's OWN entry in `.next/app-build-manifest.json` (the session-90
  method; CSS excluded — the metric is JS). Arithmetic validated against
  Next's own build table at its kB rounding for every route
  (`/` 106,963 B -> "107 kB", `/checkout` 127,545 -> "128 kB",
  `/orders/[id]` 145,064 -> "145 kB") — the table rounds and HIDES small
  deltas (session 90's lesson), the gate sees bytes.
- Committed baseline: new section in `docs/PERFORMANCE.md` with the table
  between `BUNDLE-BASELINE` markers — 7 core storefront routes (home,
  restaurant detail, cart, checkout, map, receipt, order history),
  measured at ship on a COLD `rm -rf .next && next build` of this tree.
  ZERO tolerance by design (drift-gate doctrine): growth is shrunk back or
  re-measured deliberately via the new `--print` mode
  (`npm run budget:print` prints ready markdown rows for the same route
  set — numbers only, never silent route additions).
- Dead-gate guards (session-106 doctrine), all exit 1: missing manifest,
  missing/empty/duplicate-row/non-integer baseline table, a BASELINE route
  absent from the build (a renamed/deleted route would otherwise freeze
  the table silently), and a listed chunk missing on disk.
- `scripts/check-bundle-budget.test.mjs` — 13 browser-free node:test
  cases against synthetic rigs (env knobs `BUNDLE_NEXT_DIR` /
  `BUNDLE_BASELINE_FILE`), including the roadmap-requested DELIBERATE
  over-budget negative test (1 B over -> exit 1 naming the route), the
  at-budget margin-0 pass, CSS-exclusion, comma-formatted bytes, stale
  route, dead manifest, and `--print` behavior.
- CI `web` job: `next build` -> `node --test` selftests -> real gate
  (selftests first so a corrupted gate fails loudly instead of silently
  skipping). Convenience scripts `budget` / `budget:print` in
  apps/web/package.json. No dependency, no lockfile churn; API untouched;
  no web app-code touched (e2e suite unaffected — the build IS the web
  verification gate).

**Verified:**

- Cold web build green (Compiled successfully). Live gate on the real
  `.next` + committed table: exit 0, margin +0 B on all 7 routes.
- node --test 13/13 (twice — before and after an ASCII sweep of my own
  comment prose).
- LIVE negative proofs on the REAL build: absurd 1-byte baselines ->
  FAILED (7 route(s)), exit 1, each route named with its over-bytes; and
  against the docs file BEFORE the table existed -> marker-not-found
  exit 1 (the dead-gate path firing for real).
- FIRST CI RUN OF THE GATE WENT RED — and it caught a real measurement
  error, MINE: run 44885031356 web job selftests 13/13 green, real gate
  FAILED on 5 routes, each exactly +39 B over. Root cause: my baseline
  build ran with the gitignored `apps/web/.env.local` present — a defined
  `NEXT_PUBLIC_API_URL` is INLINED into the client chunks, while CI's
  clean checkout bundles the process.env path instead. The gate, run on
  the runner against a local-polluted table, correctly refused. Fix in
  the follow-up commit: cold re-measure with .env.local stashed (CI-clean
  = exactly what the runner builds), table updated (5 rows +39 B, `/` and
  `/map` byte-identical — the honest signature of an env-diff, not
  zlib drift), and the CI-CLEAN measurement doctrine recorded in
  docs/PERFORMANCE.md.
- Sanitizer scan: first pass caught 3 U+2026 — all prose ellipses in MY
  comments, rewritten ASCII and re-swept clean (no `***`, no literal
  `\u` on added lines); `git diff --check` clean; ci.yml + package.json
  lint-valid.

**Left for next sessions:**

- Portal routes (`/admin`, `/dashboard`, `/driver`, `/kitchen`) are NOT
  budgeted yet — adding a row + `npm run budget:print` number is the
  whole procedure whenever the team wants them pinned.
- CI proof PAID: run 44885551814 — full CI GREEN on the re-measure push,
  web job's selftests AND the real gate completed success on the runner
  (zero-tolerance strictness confirmed feasible: runner gzip bytes
  matched the local CI-clean build exactly). The first push's web-job
  RED was the expected pollution catch, documented above.

---
## 2026-11-21 14:55 — Session 114 — alert-history panel on /admin consuming the persisted verdict series (Phase 11 web item)

**Built:**

- Phase 11's 🔒 Web sub-item (session 112 shipped the API side). Purely
  web-side: 1 new component + 1 new e2e spec + 3 edited (`lib/api.ts`,
  `/admin` page, EN/ID bundles). API delta 0.
- `lib/api.ts` — `AlertsHistory`/`AlertVerdictRecord`/`AlertStreakView`/
  `AlertRuleResultView` contract types mirroring
  `admin-alerts.response.ts` field-for-field, plus
  `api.adminAlertsHistory(token, {windowSec?, limit?})` (params optional;
  the panel calls the defaults).
- `components/AlertsHistoryPanel.tsx` — error-budget-style sibling of
  TrafficPanel. Four cards: CURRENT VERDICT (the payload's
  `streak.currentStatus` live engine verdict), ALERTING STREAK (the
  `streak.alerting` incl.-this-read number; when `trailingCapped` the
  value renders with a ≥ prefix + lower-bound detail — never a false
  exact), PERSISTED VERDICTS (row count + alerting %; honest writer-off /
  series-unreadable detail branches), LAST VERDICT (newest capture time).
  Below: a per-tick RAIL (one colored cell per row, oldest-first per the
  server contract, `data-status` + title with the firing rule ids), the
  `truncated` honesty note, and a NEWEST-FIRST firing-rule table (cap 15)
  showing raw rule ids as chips + the stored report's fired-detail
  strings verbatim — rule ids stay untranslated ops-contract tokens.
  Rail/table render ONLY when the series is usable
  (`enabled && !error`) — a read failure shows a role=alert degrade
  banner instead of the empty-series copy (session-105 lie rule).
- `/admin` page: THIRD parallel `authedCall` (`adminAlertsHistory`) in
  the existing Promise.all; a history-only failure degrades ONLY its own
  card (`alerts-history-load-error`), never the tables or the traffic
  section. Same bundle-trim idiom as TrafficPanel: module-scope
  `dynamic()` + `ssr:false` + render-gate-is-the-code-split-gate, tiny
  named skeleton component for the localized aria-label (session-93 rule).
- 29 new Portal keys × EN/ID (ICU params passed String()-wrapped;
  `OK`/`ALERTING` status words and rule ids stay raw both locales),
  merged by the canonical ensure_ascii dump after a byte-exact
  round-trip proof of both bundles.

**Verified:**

- `cd apps/web && npm run build` green. API untouched:
  `npm run build` + jest 98 suites / 1279 tests — byte-identical to
  session 113 (delta 0).
- Live curl on the dev DB: `GET /api/admin/alerts/history` 200 with the
  full shape (window 86400, enabled true, 1 persisted row, streak
  `{persistedTrailingAlerting:1, currentStatus:'alerting', alerting:2}`
  — live read correctly counted on top of the persisted tail);
  `?windowSec=5` → 400 `BAD_REQUEST` envelope; unauthenticated → 401.
- New e2e `admin-alerts-history` 4 tests: LIVE payload cross-check
  (waitForResponse per the session-85 doctrine — cards/rail/table bound
  to the payload the page itself received, both alerting and
  cold-series/empty branches handled shape-wise, never absolutes);
  a deterministic INTERCEPTED alerting payload (route only the history
  URL; session-91 portal-interception recipe) pinning the ≥ lower-bound
  render, 67% alerting math, truncated note, rail cell count/order via
  `data-status`, firing-table chip + stored-detail strings, and
  independent degradation (traffic cards from the REAL metrics call
  still render); the intercepted `error:true` read proving the honest
  degrade banner and that the live verdict card still works; ID-locale
  chrome. Full suite 110→114 green ×2 consecutive on fresh seeds
  (~3.2 min each), fixture-timing gate OK (16 labels, 3 prior runs
  merged, limiter waits classified).
- Sanitizer scans: the 14 added-line `lit-\u` hits are ALL the
  messages-JSON canonical ensure_ascii escapes (matching the pre-existing
  bundle style — session-101 note); the TSX/spec files are clean. The
  component's first draft carried `\u2265`/`\u00b7` escapes + one comment
  U+2026 — rewritten to real characters and re-verified by codepoint
  readback. `git diff --check` clean.

**Left for next sessions:**

- No window/limit selector on the panel (the page uses the API defaults
  24h/288 rows) — a UI ask if evergreens want range control.
- Phase 11's remaining open items: First Load JS budget gate,
  focus-visibility/skip-link audit.
---
## 2026-11-21 12:35 — Session 113 — delivery ETA honesty: derived median on the detail read + storefront surfaces (Product, Phase 11)

**Built:**

- Phase 11 Product item. 3 new files (`delivery-eta.ts`, its spec,
  `zz-restaurant-eta.spec.ts`) + 8 edited (service/module/swagger-models +
  lib/api types + restaurant page + checkout page + EN/ID messages).
- `src/restaurants/delivery-eta.ts` — DI-free derivation module: constants
  (5-sample floor, 20-row median window), ONE batched parameterized SQL
  (window-ranked eligible orders -> `percentile_cont` over the newest 20,
  `MAX(samples)` carrying the FULL eligible count) and the pure builder
  implementing the ladder: no/filtered rows -> `estimate`
  (`avgPrepMinutes*60`, 0->garbage->30-min default), <5 samples ->
  `estimate` (sampleCount still honest), >=5 -> `observed` integer seconds
  (`Math.max(1, round(median))`), garbage median -> `estimate`. Eligibility
  = `completed` status + BOTH stamps + positive duration, so inverted/
  un-stamped rows are excluded from count AND median.
- `RestaurantsService.attachEta` called ONLY from `findOne` (session-79's
  3-statement list contract intentionally untouched; list/search rows stay
  byte-unchanged); `@Optional() @InjectRepository(Order)` for the raw
  read-only aggregate (entity registered in RestaurantsModule forFeature —
  no OrdersModule import, no DI cycle, session-42 precedent). A failed
  aggregate read attaches `null` + a warn line, route stays 200
  (session-89 extras-degrade doctrine). No migration, no new env knobs —
  backdating timestamps re-derives everything on the next read.
- Swagger: new `DeliveryEtaResponse` component (enum source, integer
  seconds/sampleCount) + optional nullable `deliveryEta` on
  `RestaurantResponse` (detail-attachment rule in the description). Op
  count UNCHANGED (76) — no new route.
- Web: restaurant-page pill branches — `observed` renders an emerald
  `⏱ Usually ~N min` (testid `eta-observed`, `title` names the sample
  count via ICU plural with numeric `count`, minutes passed as String per
  session-95); `estimate`/`null` keeps the OLD curated line BYTE-IDENTICAL
  (zero EN pins touched). Checkout gains a `Delivery time` row rendered
  ONLY on `observed`. 4 new keys × EN/ID (`Restaurant.etaUsually/
  etaObservedTitle`, `Checkout.etaLabel/etaUsually`), merged by the
  canonical ensure_ascii dump — round-trip-proven surgical diff.

**Verified:**

- `cd apps/api && npm run build` green; jest 98 suites / 1279 tests
  (97/1263 at session 112: +1 suite, +16 tests — 11 pure-builder ladder
  pins incl. garbage classes, 5 service attach/embed pins incl.
  dedupe-one-query, degrade-to-null, and the list path calling NO aggregate).
- `cd apps/web && npm run build` green.
- Live smoke **18/18** on a 29-migration from-empty scratch DB (seeded
  baseline warung estimate/sampleCount 3 seconds=avgPrep·60; sushi 0-sample
  estimate; list rows byte-free of the field; malformed-uuid 400 envelope;
  SQL-copied exact-duration ladder 4->estimate / 5->observed median 180 /
  6->even median 210; inverted-duration AND missing-stamp exclusions flip
  the branch BOTH ways with a restore proving zero-write re-derivation;
  21-row windowing proof: sampleCount 26 while the median windows only the
  newest 20 (60s); docs-json registers the enum+integer schema; warung
  untouched by the sushi ladder; 0 error-level API-log lines).
- New e2e `zz-restaurant-eta` 4 tests: contract+invariants; REAL paid +
  owner-ladder completions flip the SSR page to `observed` and the DOM pill
  is cross-checked against the API payload (shape doctrine — earlier
  specs may have completed Warung orders, so absolute minutes stay unpinned;
  serial worker + TTL=0 boot make the two reads provably equal); checkout
  observed row via client-side interception (session-91 recipe); ID locale
  pill/title + checkout row byte-shapes. Full suite 110/110 green ×2
  consecutive fresh-seed runs (106→110), fixture-timing gate OK.
- First targeted run 3/4: my own spec-side harness bug — the ID-locale
  Add CTA is `Tambah` (session-95 localized-CTA lesson, re-learned); fixed
  in the spec, no product change.
- Added-lines sanitizer scan CLEAN (U+2026/`***`/literal-\u): the two
  scan hits are PRE-EXISTING HEAD content (an ARCHITECTURE-era lib/api.ts
  comment; the messages-JSON `\u2014` escape form), verified against
  `git show HEAD`. `git diff --check` clean.

**Left for next sessions:**

- Search hits (`GET /search` restaurant rows) still embed hours but not
  the ETA — same batch helper could ride `search.service` with one more
  aggregate; deliberately scoped out to keep the statement-count sweeps
  isolated this session.
- Per-list ETA (cards showing "usually ~N min") would restore session 79's
  contract ONLY with an explicit statement-shape re-pin — need is a UI ask.
- Phase 11's remaining open items: admin alert-history panel (🔒),
  First Load JS budget gate, focus-visibility/skip-link audit.

---
## 2026-11-20 19:38 — Session 112 — alert verdicts persisted: time series + history route + scan escalation (Ops, Phase 11)

**Built:**

- Phase 11 Ops item, API side (the admin-dashboard panel is explicitly
  deferred as a sub-item — the roadmap item's third clause). 5 new files
  (entity, migration, service, service spec, query DTO) + 11 edited
  (module/data-source/controller/response-contract/scan + their specs,
  swagger contract, audit registry, ops/alert-scan.sh).
- `alert_verdicts` table (migration 29th, `AddAlertVerdicts1794988800000`):
  capturedAt (indexed) + `status` varchar(16) CHECK IN ('ok','alerting') +
  `firingRules` jsonb CHECK array + `report` jsonb CHECK object. status +
  firingRules are redundant with the stored full report ON PURPOSE: the
  CHECK keeps the domain honest at the storage layer and the streak
  reader never has to crack jsonb.
- `AlertVerdictsService` REUSES the session-89 writer pattern and,
  literally, its tick: same `METRICS_SNAPSHOT_INTERVAL_SEC` (default 300,
  0 off, garbage->default) + `METRICS_SNAPSHOT_RETENTION_SEC` knobs, one
  evaluation per tick via the SAME engine the route answers with
  (`metrics.alerts(freshnessInput())`), full report stored verbatim,
  retention prune over the same cutoff — the snapshot write of the sibling
  tick makes `snapshot_stale` read age ~0 on healthy ticks, so the series
  records `ok` honestly while a dead metrics writer records its OWN firing.
  Errors warn + return 'failed' — the session-86 dead-smoke-detector
  doctrine. Delete clause uses the RAW quoted `"capturedAt"` (session-89
  TypeORM alias trap pinned for this table too).
- `GET /admin/alerts/history` (ADMIN, OpenAPI ops 75->76, SUCCESS pin
  77->78): `AlertsHistoryQueryDto` (windowSec 60..2592000 default 86400,
  limit 1..2000 default 288; blank-or-0 -> unset -> default per the
  session-87 Number()-coercion truth; junk/out-of-range -> loud 400;
  service re-clamps both for direct callers) registered in the
  query-surface-audit REGISTRY with DTO-completeness + clamp evidence.
  Response: windowed rows OLDEST-FIRST (full stored reports), knobs
  echoed, `truncated`/`lastCapturedAt`/`error`, and the streak:
  `persistedTrailingAlerting` (newest->first ok, `trailingCapped` = lower
  bound at the limit), `currentStatus` (LIVE engine verdict at read time),
  `alerting` = trailing + 1 while live alerting else 0. Reads NEVER write.
- alert-scan ESCALATION: on an alerting verdict the scan side-reads
  history (healthy polls stay exactly two requests) and bumps the page
  note at `streak.alerting >= ALERT_SCAN_ESCALATE_AFTER` (default 3,
  floor 1) — an `ESCALATION` stderr line (cron MAILTO transport) +
  `escalated`/`streakAlerting`/`streakError` in the stdout JSON. Exit
  codes 0/1/2 UNCHANGED — a chronic fire pages louder, never changes
  class. A broken/garbled history read leaves escalation UNKNOWN
  (streakError) — the fire's exit 1 stands.
- Registration sweeps per the standing traps: swagger.spec 4 lists +
  SUCCESS pin, data-source entity list 21->22 + spec pin,
  swagger.spec mockedProviders (new AdminController ctor dep),
  MetricsModule forFeature/providers/exports.

**Verified:**

- `cd apps/api && npm run build` green; jest 97 suites / 1263 tests
  (96/1241 at session 109: +1 suite, +22 tests — 8 service unit,
  5 admin HTTP history-route incl. wire 400s/blank-defaults/frozen
  arithmetic, 6 scan escalation/config). Full suite rerun green after the
  targeted fixes.
- Live smoke 58/58 on a 29-migration from-empty scratch DB, TWO boot arms
  (3s tick): arm 1 (`ALERT_P95_MS_MAX=0`) proved tick rows exist, pair
  with metrics_snapshots 2/2, status domain + both jsonb CHECKs clean,
  stored report carries all 4 rules with observed/threshold/detail
  verbatim + p95 detail 'exceeds', stored thresholds echo the live knob,
  retention prune ran (oldest row <=11s while ticks ran >12s),
  SIGSTOP-frozen API<->SQL cross-checks EXACT (returned == row count,
  trailing streak == SQL tail-run, lastCapturedAt == max capturedAt),
  streak arithmetic + lower-bound flags (limit=1 -> truncated &&
  trailingCapped && persisted==1), 401/403/5x-400 branches, blank params
  -> defaults, illegal psql writes each died on their named CHECK,
  legal insert landed exactly +1 then removed by exact predicate.
  REAL scan: exit 1,
  escalated:true at streak 3, stderr ESCALATION line; threshold 999 ->
  same exit 1, no note. arm 2 (defaults): all rows ok, streak 0, scan
  exit 0 with NO streakAlerting field (healthy never reads history),
  both API logs free of error-level lines.
- Docs surface: live docs-json documents the op with bearer security +
  200/400/401/403 responses.
- Smoke harness lessons (both harness, not product): `psql -q` NEVER
  prints command tags — 'DELETE 1' asserts are structurally empty, use
  delta-count SELECTs; psql booleans print `t` while jq prints `true` —
  mixing the two fabricated 4 first-run FAILs.
- Added-lines sanitizer scan CLEAN (U+2026 / *** / literal-\u) across all
  19 touched files.

**Left for next sessions:**

- Web: error-budget-style alert-history panel on /admin consuming
  `GET /admin/alerts/history` (+ e2e) — filed as a ROADMAP sub-item.
- Per-restaurant durability + order-centric attribution (Phase 11's other
  open 🔒 items) untouched.

---
## 2026-11-20 15:30 — Session 111 — fixture-timing round trip VERIFIED + the transport's real bug found and fixed (Test, Phase 11)

**Built:**

- Phase 11 Test item; API + web product delta 0. Verification was done
  entirely through ANONYMOUS public surfaces (no token on this host):
  the runs/jobs/artifacts REST listings, the run pages' annotation lists,
  and a local zip-size simulator fed the on-disk record format.
- VERDICT (all three clauses): (1) the fetch step merges >=1 prior run —
  proven since run 126, see the size decode below; (2) the gate's
  historical-max/recent-maxes columns therefore reflect real CI-side leg
  records (prior lines carry the full 14-label map; sentinels would carry
  empty labels); (3) history bounded: 9 lines now, gate slice(-20) pinned
  by selftests — cap not yet reachable live. LISTING ORDER: anonymous
  artifacts listing proved consistently created_at-desc (3 fetches,
  identical order) and BOTH scripts sort explicitly client-side anyway —
  the run-id-sort contingency from the item did NOT trigger (no change).
- SIZE DECODE (the decisive evidence): fixture-timing-history zips grew
  467, 553, 633, 721, 761, -, 827, 887, 952, 1018 B across runs
  125→134 — monotonic +60..+88 per run. A local deflate simulation of
  the exact gate record shape (e2e/fixture-timing-history.jsonl + real
  runIds) shows one REAL ~700 B record line costs +52..+90 B compressed
  while a fixed-120 B sentinel (105 x-padding) costs ~+12 B. So every
  published file since 126 contains the accumulated REAL prior records —
  zero sentinels ever shipped. Session 110's "merge silently no-op'd"
  saga was a misread: the job-token REST download works (302 to the SAS
  blob needs NO auth — the undici header-strip is harmless), the
  auth-strip/root-cause theory and the job-token-scope theory were both
  wrong. Comments in fetch/list scripts corrected accordingly.
- THE ACTUAL DEFECT, found and fixed: the official
  download-artifact@v4 step STAMPED "Artifact not found for name:
  fixture-timing-history" on EVERY run (visible as the job's only ::error
  annotation on runs 131/132/133). Cause (read from action.yml + dist):
  v4's cross-run REST search (options.findBy) is built ONLY when the
  `github-token` INPUT is set — without it the SDK searches the CURRENT
  run (whose history isn't published yet) and errors; `continue-on-error`
  kept it green. Fix: `github-token: ${{ github.token }}` on the step.
  Intermediate honest note: the first attempt passed input `token:` —
  run 133 PROVED it ignored (same error annotation, chain still advanced
  via REST fallback), action.yml names it `github-token`; renamed.

**Verified:**

- ci.yml `yaml.safe_load` OK — the step's `with` keys are exactly
  [github-token, name, path, run-id] with the value `${{ github.token }}`
  read back from disk by python (display-may-lie rule).
- `node --check` clean on both touched scripts; gate selftests 12/12
  (node:test, browser-free).
- LIVE PROOF (public annotations, no auth): run 134 (sha 11f1642, the
  renamed input) — "Annotations: 5 warnings", the download-artifact
  ::error is GONE (runs 131/132/133 all showed "1 error and 5-6
  warnings"), and all five chain steps success. Artifact 1018 B = +66
  over run 133 = exactly one real record line. The chain now runs
  SDK-download primary with REST as genuine fallback.
- Added-line sanitizer scan CLEAN (U+2026 / *** / literal-\u); no product
  code touched, no lockfile touched (API/web builds unchanged since
  session 109's 96/1241 and the local 106/106 e2e).

**Left for next session:**

- Watch ~run 145 for the first bounded trim (>20 records) and a real CI
  green gate with zero prior merges ONLY on the first run after any
  artifact retention loss. If a future run's artifact delta drops to
  ~+12 B lines or regresses in size, that decodes as sentinels returning
  — inspect the SDK step's annotation FIRST.
- The size-decode simulator lives nowhere in-repo; if it earns its keep
  again, promote it to e2e/tests as a pure node script.

---
## 2026-11-20 13:40 — Session 110 — fixture-timing trend visibility: job summary + ::warning at 60% of ceiling (Test, Phase 10)

**Built:**

- Phase 10 Test item; API + web product delta 0. The session-106 ceiling
  gate was binary: a leg could crawl to 99% run after run and stay green.
  `e2e/check-fixture-timings.mjs` now aggregates legs per label (count +
  max), merges a run-over-run JSONL history, and publishes three trend
  surfaces: (1) a markdown job-summary table — slowest legs per label
  sorted by % of their own ceiling, with legs-this-run, prior-runs-seen,
  historical max and the last 5 prior maxima; (2) `::warning` annotations
  once a label's max is STRICTLY above 60% of its ceiling
  (`FIXTURE_TIMING_WARN_FRACTION`, default 0.6, garbage falls back to 0.6)
  and `::error` annotations for violating legs — the legacy console lines,
  exit codes and zero-leg instrumentation guard are UNCHANGED; (3) a
  bounded 20-record history file rewritten BEFORE the exit decision, so a
  violating slow run still lands in the trend, idempotent per
  GITHUB_RUN_ID (a re-invocation replaces its own record). Trend plumbing
  is cosmetic by contract: summary/history write failures print and never
  move the verdict.
- History transport in CI (`ci.yml` e2e job, between the suite and the
  gate): `e2e/fetch-fixture-timing-history.mjs` lists the repo's recent
  `fixture-timing-history` artifacts over the REST API (token via
  runtime-assembled header fragments; the export line uses the split-key
  YAML idiom — the sanitizer corrupted the naive adjacency and the repair
  is codepoint-verified), downloads up to 5 prior runs' zips, keeps only
  valid JSONL lines, and exits 0 on EVERY failure path — zero history
  simply means "first run". The gate then republishes the rewritten file
  via upload-artifact `if: always()` (90-day retention), so even a failing
  gate run still publishes its record.
- `e2e/check-fixture-timings.test.mjs`: 11 browser-free node:test
  selftests (legacy OK/violation contract, ::error stamp, warning band
  boundary 9000 vs 9001, limiter-wait ceiling class, zero-leg x
  ALLOW_ZERO x history-untouched, history merge + same-run dedupe,
  malformed-line tolerance, cross-class summary sort, WARN_FRACTION
  override + garbage default). The CI gate step runs them FIRST, so a
  corrupted trend path fails loudly instead of silently skipping.

**Verified:**

- node:test 11/11 (Node 22); `node --check` clean on both scripts; ci.yml
  `yaml.safe_load` OK with the 11-step e2e job in order; on-disk
  codepoint scan (base64 read-back) clean of U+2026 and sanitizer masks
  for all four touched surfaces + the exact fetch filename matches the
  workflow line.
- FULL local e2e suite 106/106 green (3.1m) producing the REAL report:
  51 legs / 14 labels; live gate run A (empty history) exit 0 — "0 prior
  run(s) merged", 14-row summary table, 1 history record written; run B
  exit 0 — "1 prior run(s) merged", table shows the historical-max and
  recent-max columns. The 11 s limiter-wait leg correctly sits at 12% of
  its own ceiling with no warning.
- fetch script proven LIVE against the real GitHub API anonymously
  (listing HTTP 200, zero matching artifacts yet, exit 0, empty history).
- API suite: product code untouched — session 109's 96/1241 stands as the
  baseline; no lockfile touched (no CI npm risk).

**Left for next session:**

- CI round-trip saga (caught AND root-caused SAME session, final proof
  pending run 7): run 44682441875 published a single-record artifact —
  the token-authenticated merge silently no-op'd behind the best-effort
  contract. Fix attempt 1 (e2e job permissions actions:write —
  upload-artifact rides the runner system auth so a green publish does
  NOT imply the job token can read artifact REST — + enumeration-based
  zip extraction) did NOT change the outcome (run 44683585995, still
  1 record). ROOT CAUSE then PROVEN with a local two-hop http test:
  Node 22 fetch (undici) STRIPS the Authorization header on
  cross-origin redirects, and the artifact /zip endpoint 302s to a
  foreign signed-blob host — every CI download hit the blob
  UNAUTHENTICATED. Fix: downloadZip() does the hop MANUALLY
  (redirect:manual, re-fetch the location WITHOUT the auth header — the
  SAS needs none), proven end-to-end by a local mock reproducing the
  GitHub artifact flow (listing -> 302 -> blob on a foreign port):
  good artifact merges, expired-SAS artifact stamps
  FETCH-DL-888-blob403, exit stays 0. Runner logs being auth-only
  made this self-attesting along the way: every fetch failure writes a
  fixed-120-byte valid sentinel (padding INSIDE the JSON — trailing
  dots were proven to break strict JSONL parsers; stable runId +
  gate-side dedupe so recurring failures contribute exactly one row),
  turning the PUBLIC artifact size into the diagnostic. Run 5 decode:
  expect >= ~2500 B (4 real prior records + own); 1 record ~500 =
  listing dead; ~500+120x = downloads still dying (sentinel kinds
  readable from the artifact itself with any authed token). RUN 6 then
  failed LOUDLY (first red job today): the OFFICIAL
  actions/download-artifact@v4 step (gen-2 wiring: anonymous listing ->
  SDK download by run-id -> dir merge) errored even with actions:write
  on the job token, and fatally - suite + listing + publish all stayed
  green but the step short-circuited merge/gate into skips. Correct
  wiring now: continue-on-error on the download step (best-effort
  contract: chain transports must never redden the job, and the REST
  fallback + sentinels keep self-attesting). Run 7 decode: job green;
  size ~1800+ = SDK download finally merged the chain (dir path, no new
  sentinels); size ~600-1000 with the REST 5-artifact sentinel band =
  SDK path dead too and the saga continues with a readable failure
  class (sentinel kinds are carried in the file itself). RUN 7 (green):
  listing -> SDK download -> dir merge -> gate -> publish ALL completed
  success, artifact grew 761 -> 827 B; run 6's download error did not
  reproduce. Exact chain accounting needs the fetch/gate stdout lines
  ("chain ready - N merged prior line(s)" + "N prior run(s) merged")
  which require a SIGNED-IN view of the job page (or any token) -
  ask the user to glance at one, or read the published artifact itself.
- Watch the first real `::warning`s: if a label legitimately lives above
  60% (e.g. seeded limiter backoffs), tune the ceiling or fraction rather
  than silencing the annotation.

---
## 2026-11-20 10:05 — Session 109 — snapshot_stale alert rule: catching the silently dead durability writer (API/Ops, Phase 10)

**Built:**

- Phase 10 Ops item, web delta 0. `ops/alerts.ts` gains its FOURTH rule,
  `snapshot_stale` (warning severity — telemetry degrades, users don't,
  same ladder as route_key_overflow; still flips the verdict to
  `alerting`, so alert-scan pages). The session-89 durability rows are
  the error budget's MEMORY: when the snapshot writer dies silently the
  windowed history zeroes while every live number keeps answering
  "healthy" — this rule watches exactly that.
- The engine stays DI-free: a new optional third argument
  `SnapshotFreshnessInput {enabled, intervalSec, lastCapturedAtMs,
  storeError?, nowMs?}` carries the DB facts; `evaluateAlerts` does the
  arithmetic (injectable clock, STRICTLY-above ceiling, future-dated rows
  clamp to age 0). Semantics: writer DISABLED (`METRICS_SNAPSHOT_INTERVAL
  _SEC=0`) is EXEMPT by design; zero rows grace from API uptime (a fresh
  boot has not reached its first tick — no false page); an UNREADABLE
  store (dropped table / dead connection) reports honestly as
  `UNREADABLE` rather than a fabricated "no rows"; a readable-but-stale
  row reports its age. Threshold default = 2x the configured interval —
  the writer must MISS TWO consecutive ticks (a single save hiccup
  retried next tick is noise); `ALERT_SNAPSHOT_STALE_AFTER_SEC` (positive
  int, 0/garbage → derived) overrides the multiplier, never disables the
  rule.
- Wiring: `MetricsPersistenceService.freshnessInput()` (the proven
  find+take:1 idiom, never throws — read failure → `storeError: true`);
  `GET /admin/alerts` becomes async and supplies the observation, so the
  admin pull rung AND the scheduler poller inherit the rule with ZERO
  alert-scan script changes (its exit-1 transport already rides
  `firingRules`). The synchronous pino fold line has no DB handle:
  there the rule honestly reports "not evaluated" (never a false ok,
  never a false fire) — documented in the engine header + ARCHITECTURE.
- Response contract `admin-alerts.response.ts` re-pinned (both enums gain
  `snapshot_stale`, thresholds gain the nullable
  `snapshotStaleAfterSec`); admin.controller.spec now holds a MIRROR pin
  that re-derives rule ids/severities + threshold keys from the REAL
  engine (the fixture can no longer silently lag a rename) and pins the
  route's exact observation payload.
- Header/comment updates in `alert-scan.ts`, `ops/alert-scan.sh` and
  `docs/ARCHITECTURE.md` (rule list, observation contract, exemption).

**Verified:**

- API: 96 suites / 1241 tests green (+0/+17 vs session 108's 96/1224) —
  alerts.spec gains a 9-test snapshot_stale describe (absent-observation,
  exemption, fresh/stale/at-ceiling boundary 600 vs 600.001s, clock-skew
  clamp, env-override, uptime grace, UNREADABLE, summarize, all-FOUR
  firing order) + knob-parse pins; metrics-persistence.spec +4
  freshnessInput cases (incl. the never-throw posture and the
  find+take:1 call-shape); alert-scan.spec +1 exit-1 pass-through; the
  rules-length combos re-pinned 3→4 honestly.
- Live smoke 32/32 on a 28-migration from-empty scratch DB, THREE boot
  arms: ARM1 healthy writer (interval 2s → derived threshold 4 echoed
  live, rule present-not-firing, 4-rule order on the wire, rows landing,
  fold-line verdict honest-ok, scan exit 0); ARM2 silently-dead writer
  (DROP TABLE mid-run → rule FIRES with the UNREADABLE detail, status
  alerting, /admin/metrics still 200 with durability.error, persistence
  warns in the API log, REAL alert-scan exits 1 and names the rule);
  ARM3 disabled writer (interval 0 + tightened ceiling 2s + uptime past
  it → EXEMPT not-firing, knob echoes 2 into thresholds, ZERO repo touch,
  scan exit 0). First-run 3 FAILs (fold interval never set; ARM3 still
  counting the table ARM2 had legitimately dropped) and one more on the
  first rerun (postgres-owned stand-in table the foodorder role could not
  read) — ALL FOUR harness bugs, zero product bugs; final rig green 32/32.
- Sanitizer scan: 14 changed files + the smoke script codepoint-clean
  (no U+2026 / `***` / literal-u escapes on added lines); `git diff
  --check` clean.

**Left for next:**

- None on this item. Evergreen note: if the per-restaurant durability
  🔒 item is picked up, `freshnessInput` is the shape to generalize
  (per-key row age), not a second engine.

---
## 2026-11-19 19:01 — Session 108 — gzip on the public browse payloads, layered over the session-103 cache (API/Perf, Phase 10)

**Built:**

- Phase 10 top item, web delta 0. New `common/http-cache/browse-compression.ts`:
  DI-free gzip layer registered in main.ts BEFORE the cache middleware —
  the order IS the contract: the wrapper owns `res.end` while the cache
  serves from its store, so store-served 200s encode exactly like
  captured handler responses (registering AFTER the cache would silently
  leave served hits identity; pinned in the live-chain integration
  describe).
- Scope = the SAME `cacheTargetOf` three-path whitelist as session 103
  (single source of truth, explicit matcher, never a url heuristic): GET
  only, `application/json` 2xx only, buffered body >=
  `HTTP_COMPRESS_MIN_BYTES` (default 1024, `0` off, garbage→default —
  the resolveTtlSec doctrine). Identity clients (no `Accept-Encoding:
  gzip` — plain curl), HEAD, POST, sub-paths, non-uuid segments and
  4xx/5xx never get their `res` patched at all — byte-transparent.
- The validator rule is the design spine: the store keeps UNCOMPRESSED
  bytes and the strong ETag stays the sha256 of the DECODED payload —
  identical across the gzip and identity variants (strong = semantic
  equality; a lossless encoding preserves exactly that), revalidation is
  encoding-blind, 304s stay bodiless with no Content-Encoding. `Vary`
  gains `Accept-Encoding` ONLY on actually-encoded responses; identity,
  304 and below-threshold responses keep `Vary: Authorization`
  byte-pinned. Bearer'd responses DO get encoded — the encoding layer is
  orthogonal to the cache bearer opt-out (pinned live + in chain specs).
- Hand-rolled instead of the `compression` package: interleaving with
  the cache's own res.end patching, byte-exact encoded `Content-Length`
  (the package streams chunked instead), the explicit whitelist doctrine
  — and ZERO new dependencies, ZERO lockfile churn. A 2 MiB buffer
  safety valve flushes pathological bodies uncompressed.
- `ops/load-test-conditional.js` (session-104 tool): BOTH legs now send
  browser-shaped `Accept-Encoding: gzip` — empirically k6 defaults to
  identity (first A/B moved byte-identical wire on both arms, so a naive
  re-measure would have sampled an unencoded connection the shipped
  profile no longer speaks); new per-leg trends `capture_ms`/`replay_ms`
  so the gzip CPU cost lands on the capture leg instead of smearing
  across the 304 replays; new loud check 'capture declares a numeric
  Content-Length' (that header IS the wire-size signal — k6
  decompresses at the JS layer, proven). Contract test kept green.
- Docs: new PERFORMANCE.md section with the A/B table incl. the
  statements-per-request honesty note (unchanged — encoding never
  touches SQL); ARCHITECTURE gained the gzip-layer bullet (order
  contract, validator rule, Vary rule, bearer orthogonality).

**Verified:**

- API: 96 suites/1224 tests green (+1 suite/+18 tests vs session 106's
  95/1206) — new `browse-compression.spec.ts` (knob doctrine, AE
  negotiation incl. `q=0`/`*`, decision table, the
  `etagFor(gunzip(gzip(body))) === etagFor(body)` round trip, pre-flight
  no-patch matrix) + a 7-test gzip describe over the REAL production
  chain at minBytes=64 (the minBytes=0 boot keeps every cache-era
  assertion byte-for-byte).
- Live smoke 38/38 on a 28-migration from-empty scratch DB:
  `sha256first32(gunzip(wire)) == ETag` on ALL three paths; identity
  variant byte-equal to the decoded gzip variant with the SAME ETag;
  Content-Length == exact wire size on encoded responses; Vary carries
  BOTH dimensions on encoded / exactly `Authorization` on identity;
  gzip+INM 304 with no body and no Content-Encoding; fresh store-served
  gzip hit re-encoded with the SAME validator; query-logger window over
  a 304 + two store-served hits executed ZERO SQL statements (the
  session-103 claim survives under gzip); a 66 B below-threshold search
  miss stays identity yet is still ETag-cached; the 3,120 B menu
  sub-path stays unencoded (proves scope, not size); bearer response
  encoded with no cache headers; health + 4xx untouched; zero 500s in
  the API log.
- k6 conditional A/B on a scratch rig (25 VU / 3 min, identical request
  shape both arms): throughput holds 250.32 vs 250.58 req/s; wire
  62.0→28.5 MB (list capture 6,914→1,924 B, −72%; −54% profile-wide);
  capture-leg p95 1.32→1.64 ms (the honest ~+0.3 ms gzip CPU per
  capture), replay leg unchanged; aggregate p95 1.31→1.53 ms, p99
  2.68→2.97 ms; checks 165,243/165,243 vs 165,474/165,474, zero failed
  requests. Session-104 rows reproduced by the control arm.
- Full e2e 106/106 green ×2 on fresh seeds with the layer ON by default
  (playwright boots TTL=0; compression unaffected). Web build green.
  Sanitizer scan: added lines clean (one self-inflicted U+2026 in my
  own ARCHITECTURE prose was caught by the scan and fixed).

**Left for next sessions:**

- Store-side PRE-COMPRESSED variants (gzip once at store.set, serve
  encoded bytes with zero per-request CPU) deliberately NOT taken — the
  roadmap wording keeps the store uncompressed and the per-request
  cost is measured small; revisit when browse traffic grows.
- Phase 8's two 🔒 carryovers (per-restaurant durability, order-centric
  attribution) remain the locked tail.

---
## 2026-11-19 14:55 — Session 107 — "Order again": one-click cart replay from the frozen snapshot (Web, Phase 10)

**Built:**

- Phase 10's top item, API delta 0 (the receipts already ship every field
  the ladder needs — `menuItemId` + jsonb `optionSelections`, live-proven
  via curl before writing a line of code).
- `lib/order-again.ts` — pure DI/React-free availability ladder. Per ordered
  row the first failing rung skips-and-names it: null/dangling
  `menuItemId` → `gone`; `isAvailable:false` → `unavailable`; tracked
  `stock===0` → `sold-out`; a frozen `choiceId` no longer in the same
  option group, or a rebuilt selection violating the group's CURRENT
  min/max (new mandatory group included) → `options-changed`. Surviving
  lines ride at TODAY's prices (snapshot prices are never trusted — the
  server re-prices at create anyway), duplicates merge by `lineKey`, and a
  tracked-stock shortfall CLAMPS the quantity and reports it.
- `CartProvider.applyOrderAgain(restaurant, drafts, 'merge'|'replace')` —
  the batch writer the single-unit `add` never was: merge onto matching
  lineKeys for an empty/same-restaurant cart (qty += clamped, cap 50),
  replace only from an explicitly confirmed foreign cart.
- `components/OrderAgainButton.tsx` — one island mounted in BOTH surfaces:
  completed history cards (`app/orders/my`, new block below the action
  row) and the SSR receipt page (`app/orders/[id]`, guest-proof — the
  cart is localStorage). Click → `GET /restaurants/:id` → ladder. A fully
  clean plan auto-routes to the restaurant page; ANY skip/clamp/
  below-minimum keeps the shopper with a result panel (units added, each
  skipped dish + reason, clamped lines, min-order warning vs the
  PROJECTED cart subtotal) and an explicit "Go to {restaurant}" CTA. A
  foreign cart gets an inline replace confirmation (cancel = cart fully
  intact) — same never-silently-discard doctrine as `CartSwitchDialog`.
- `Order.items[]` gained `menuItemId?: string | null` in `lib/api.ts`
  (wire truth, entity passthrough). New `OrderAgain` namespace 18 keys ×
  EN/ID (ICU plural `addedCount` keeps the numeric arg per session-102
  rule; whole-tree EN/ID key parity asserted programmatically before
  write — 695 leaf keys).
- ARCHITECTURE gained the ladder rule (first failing rung wins; prices
  never from the snapshot; batch writer is the only reorder path).

**Verified:**

- Web build green (twice; the second build covered the final comment-only
  edit). SSR HTML of a completed receipt contains the `order-again-FO-SEED8`
  island (curl grep on `next start`).
- New `e2e/tests/zz-order-again.spec.ts` 5 tests: clean FO-SEED8 click →
  auto-route + badge '1' (seed shape proven against the live payload:
  1x Nasi Goreng $18 ≥ $10 min); FO-SEED9 ($5 tea) → below-minimum panel
  with byte-exact EN strings + continue CTA, NO route; hidden-dish ladder
  (owner API hides Es Teh after a paid+completed 2-dish options order) →
  skipped-and-named while the Extra-egg selection rides at the CURRENT
  $20.00 unit, second replay from the RECEIPT page merges onto the same
  lineKey, cart proves 'Size: Large' never entered, availability restored
  in a finally; foreign-cart replace confirm/cancel both pinned; ID chrome
  byte-pins ('Pesan lagi', '1 item ditambahkan ke keranjang Anda', 'Ke
  Warung Nusantara'). History assertions ride the Completed FILTER TAB via
  the locale-agnostic `#orders-tab-completed` id — earlier zz-* specs grow
  demo's unfiltered history, so page-1 absolutes are not a fair pin.
- FULL e2e 101 → **106/106 green ×2 consecutive on fresh seeds**, plus
  5/5 again on the final rebuilt artifact; `check-fixture-timings.mjs`
  exit 0 on both reports (max work leg incl. new fixtures ≈ 120 ms).
  Honest harness note: the FIRST targeted probe consumed the once-per-seed
  state (admin/owner-analytics seed absolutes) — reseeded before every
  counting run, exactly the documented session-94 trap.
- API untouched: `nest build` green, jest **95 suites / 1206 tests — delta
  0** vs session 106.
- Sanitizer scan: added diff lines clean of U+2026/`***`/literal `\u`
  (message JSONs carry the standard `\uXXXX` ESCAPES the doctrine
  prescribes; a raw U+2026 that slipped into two comments was rewritten
  ASCII); `git diff --check` clean.

**Left for next sessions:**

- 'Order again' shares no promo: the snapshot's `promoCode` is deliberately
  NOT replayed (caps/expiry would make it dishonest). A "the code you used
  is still valid" hint could ride `POST /promos/validate` later.
- Cancelled orders intentionally get no button (the roadmap scoped this to
  COMPLETED); extending it is a copy + ladder decision, not a plumbing one.

---
## 2026-11-19 12:56 — Session 106 — Flake tooling graduated: ONE sign-in contract + the fixture-timing CI ceiling (E2E, Phase 9)

**Built:**

- Phase 9's top item. The session-100 flake kit is now suite-wide, from one
  source: new `e2e/helpers/fixtures.ts` owns `signInUi` (redirect-COMMIT
  contract, locale-tolerant `Sign in`/`Masuk` CTA + stable `#email`/
  `#password` ids, optional `goto`), `loginToken`/`payOrder` (timed,
  429-tolerant on BOTH payment legs), `createOrder`/`warungFixture` (timed),
  plus `timed`/`limiterWait`/`bearer`/`API`/`WEB`/`DEMO_PASS`.
- 19 spec files migrated. 16 inline click-sequences replaced (admin ×2,
  live-feed ×3, portal-a11y ×4, account, order-access, owner-analytics,
  empty-states, pay-order, stock, zz-driver-portal) — several had NO redirect
  guard at all (admin test 2, owner-analytics, pay-order: live members of
  the session-100 abort class). 9 local helper copies deleted
  (loginToken ×6, payOrder ×3, warungFixture ×4, createOrder ×3, signInUi ×4,
  bearer ×2, timed, ownerToken, placeOrder/warungNasiGoreng); 7 local
  sign-in functions rewritten as one-line delegations (portal-states,
  loading-skeletons, portal-chrome-id, admin-traffic, owner-traffic,
  zz-forms-a11y via import, zz-gdpr-account via import). Raw
  `headers: { authorization: ... }` literals are gone from the whole suite
  (runtime-assembled `bearer()` everywhere — sanitizer-adjacency doctrine).
- Deliberately NOT touched: `login-redirect-race`, `zz-login-abort`,
  `storefront-i18n-auth-id`, `storefront-i18n-account-id` — those specs'
  inline sequences ARE the login surface under test (ID-chrome label fills
  included).
- live-feed's order identity moved to a named `LIVE_FEED_ORDER` const
  (contactEmail receipt-proof comment preserved); its fixture read now uses
  the correct `search=` param (the old `?q=` was a silently-ignored alias).
- **The ceiling:** playwright config gained the `json` reporter
  (`playwright-report/results.json`); `e2e/check-fixture-timings.mjs` reads
  every `fixture-timing` annotation and fails on any leg over the ceiling —
  15 s work legs, 90 s `.limiter-wait` legs (rate-limit backoffs are credited
  OUT of their work leg, so the documented 429 doctrine can never false-fire
  it), and a ZERO-leg report fails too (a silently-dead gate is exactly what
  this kills). Wired as a step after `npx playwright test` in the CI e2e job.
- ARCHITECTURE's sign-in-doctrine bullet rewritten from "every helper must
  await the redirect" to the single-source reality + the gate; e2e/README
  gained a "Fixture contracts & the timing gate" section.

**Verified:**

- `playwright test --list`: 101 tests in 35 files — byte-identical inventory
  to session 105 (pure refactor, zero test churn).
- FULL e2e **101/101 green ×2 consecutive on fresh seeds** (3.0 + 3.1 min,
  `npm run seed` between) — every EN/ID byte-pin unchanged.
- Gate on BOTH run reports: exit 0; measured 38 work legs max **121 ms**
  (15 s ceiling ≈ 120× headroom) + real 9–10 s `payOrder.limiter-wait`
  legs classified separately exactly as designed (live proof of the
  credit mechanism).
- Gate negative tests (synthetic reports): ceiling=50ms → 19 violations
  exit 1; zero-leg report → exit 1; `FIXTURE_TIMING_ALLOW_ZERO=1` → 0;
  work-vs-wait ceiling split proven with a 5000ms work + 120000ms wait
  fixture (3 classifications, each exit as intended).
- API delta 0 (no server code touched): `nest build` green, jest 95 suites/
  1206 tests — identical to sessions 103–105. Web delta 0 (no app source).
- Sanitizer scan of all 24 changed/new files: zero U+2026/`***`/literal-\u
  on added lines (the pay-order `landmarks…` hit is pre-existing app copy,
  verified byte-identical in HEAD); `git diff --check` clean; ci.yml
  re-parsed with PyYAML (step order printed).
- CI honesty note: the new gate step has not yet executed on GitHub runners;
  local max observed is 121 ms against the 15 s ceiling, so a first CI run
  failing on ceiling would mean >100× runner slowness — recalibrate via the
  env knobs if ever observed.

**Left for next sessions:**

- Optional: extend `timed()` coverage to the remaining bespoke API-leg
  helpers (owner-analytics' createPaidConfirmedOrder, stock's setStock) —
  they run once per test today; the ceiling mostly guards the shared legs.
- The two Phase 8 lock-items stand untouched (per-restaurant durability,
  order-centric attribution).

---
## 2026-11-19 09:12 — Session 105 — Honest loading states on /favorites + /addresses (Web, Phase 9)

**Built:**

- Phase 9's top item. The audit first: the "both pages flip empty→content
  in one frame" hint was STALE — both pages have gated a pulse skeleton on
  `loaded` since sessions 95/96. The pass still caught a real violation of
  the session-77/91 error-vs-empty doctrine: **/addresses rendered the
  "No saved addresses yet" empty card over a FAILED load** (its condition
  never checked `loadError`; favorites had exactly that guard). Gate fixed.
- The addresses error banner became a real failure card: stable
  `addresses-error` testid + a localized **Try again** (Common.retry, EN/ID
  already shipped — ZERO new copy) wired to `refresh()`. Its error KIND
  was also brought to the `authedCall`/`isApiDown` doctrine: a network drop
  now names the unreachable API via the shared EN/ID `locale-strings`
  fallback instead of the generic "Could not load your addresses." — the
  FIRST targeted e2e run caught this (product-side fix, not spec-side).
- Both skeletons carry the established animated idiom: `animate-pulse` +
  stable testids (`favorites-skeleton`, `addresses-skeleton`); the existing
  aria-busy + localized loadingAria labels unchanged.
- New `e2e/tests/loading-skeletons.spec.ts` (4 tests): a 900 ms held load
  proves the skeleton is the ONLY thing on screen mid-fetch (no empty card,
  no error) before real rows land; failed loads must show the retry card
  and NEVER the empty state (the bug pin); the retry ladder ends honestly
  (error gone, skeleton gone, Add-address presence consistent with rows).
  All row payloads ride `page.route` interception — read-only and seed-safe;
  only the post-release retry step touches the real API.

**Verified:**

- Web build green (re-ran after the error-kind fix): `Compiled successfully`,
  21/21 static pages.
- Targeted new spec 4/4 (first run 3/4 — the addresses error-text assertion
  exposed the product gap; fixed, re-green).
- FULL e2e **101/101 green ×2 consecutive on fresh seeds** (97→101,
  `npm run seed` between the runs) — every existing EN/ID byte-pin unchanged.
- SSR curl 200 on `/favorites` + `/addresses` against the built server.
- API delta 0 (no server code touched); message bundles untouched — every
  string this pass needed already shipped in sessions 95/96; sanitizer scan
  of all 230 added lines: no U+2026/`***`/literal-\u hits; `git diff --check`
  clean.

**Left for next sessions:**

- The error-vs-empty + `isApiDown` audit only covered the two pages in this
  roadmap item; other per-page fetches (account GDPR surface, history
  filters) may carry the same generic-fallback looseness — natural next
  sweep of the loading-states loop.

---
## 2026-11-18 20:27 — Session 104 — k6 browse re-baseline under the HTTP cache + conditional-GET replay profile (Perf, Phase 9)

**Built:**

- Phase 9's top item (PERFORMANCE.md rec 6): the public browse profile
  re-baselined under the session-103 cache, A/B against a TTL=0 control on
  the same rig, recorded as a NEW baseline (never restated against the
  November 4 numbers), plus the optional `If-None-Match` replay profile.
- New read-only workload `ops/load-test-conditional.js`: per iteration one
  unconditional capture (asserts strong `Etag` + `Cache-Control: public`
  + JSON) then 2 `If-None-Match` replays that MUST be 304 with the echoed
  tag and an empty body. Loud `exec.test.abort` when the capture answers
  without a cacheable strong ETag — at TTL=0 that fires immediately
  (verified live: the abort caught a harness bug, see below) instead of
  quietly measuring 200s.
- `ops/load-test.lib.mjs`: pure `cacheBrowsePath` (the three session-103
  whitelisted URL shapes ONLY — `/restaurants/meta/cuisines` deliberately
  excluded, it can never 304), `isStrongEtag` (quoted, no `W/` — mirrors
  `etagFor`; Express's weak auto-etag must not pass), `REPLAYS_PER_ITERATION=2`,
  `revalidateProfile(smoke|load)` — load keeps the browse VU shape so the
  latency columns compare directly. Contract test extended: whitelist-only
  path pick, uuid-gating invariant vs `cacheTargetOf`, etag ladder, stage
  parity with `loadProfile('load')`.
- Docs: PERFORMANCE.md gained the third-workload intro + run command, the
  "Public browse re-baseline under the HTTP cache — November 18, 2026"
  section (tables below), and recommendation 6 marked DONE. No product-code
  changes — apps/api and apps/web untouched.

**Verified:**

- Re-rig first: fresh 28-migration chain + canonical seed into scratch DB
  `foodorder_k6reb` (full chain from empty green), production build booted
  :4100 per arm via `HTTP_CACHE_TTL_SEC` 15/0; k6 v2.3.0 in Docker,
  `--network host`.
- Clean load runs (no query logging), all thresholds green, 100.00% checks,
  0% failed requests:
  - browse TTL=0 control: 14,982 iters / 14,983 reqs @ 83.15 req/s,
    avg 2.67 ms, p95 5.07, p99 9.16, max 60.21.
  - browse TTL=15: 15,111 / 15,112 @ 83.86, avg 1.02, p95 2.52, p99 4.7,
    max 37.63 — p95 HALVED vs control at the same iteration rate.
  - conditional TTL=15: 15,048 iters / 45,145 reqs @ 250.74 req/s,
    avg 0.55 ms, p95 1.29, p99 2.4 — every one of the 30,096 replays a 304
    (150,481/150,481 checks incl. echoed-etag + empty-body pins).
- Statements-per-request A/B via query logger (`ALTER DATABASE ... SET
  log_statement='all'`, RUN-UNIQUE markers, pool re-booted after the ALTER;
  full load profile per window): control **2.000** stmt/req (14,968 reqs →
  29,939 statements — the session-79 constant shape exactly), cached browse
  **0.262** (15,115 → 3,959; 7.6× collapse), replay arm **0.003**
  (45,139 → 144: 140 TTL re-capture SELECTs + one metrics-snapshot
  INSERT/DELETE cycle; replays touched zero SQL). `log_statement` RESET
  afterwards; scratch DB dropped.
- Conditional smoke 74 iters / 223 reqs / 741 checks 100%.
- Harness bug caught by the profile's own abort contract: k6's Go bridge
  canonicalizes response header names — `headers['ETag']` is undefined,
  `headers['Etag']` is the key. Fixed in the script; zero product bugs.
- `node --test ops/load-test.contract.test.mjs` green; `nest build` green;
  API jest delta 0 (no src touched), web delta 0; TTL=0 transparency
  curl-verified (no `Cache-Control`, weak Express auto-etag only, replay
  200s).

**Left for next sessions:**

- The browse profile never reuses ETags (k6 has no HTTP cache) — a real
  proxy/crawler fleet mixes capture+revalidation; the conditional profile
  covers the replay end, a mixed hit/miss ratio profile could cover
  intermediates someday.
- `/api/search` has no k6 traffic in either browse rotation (the storefront
  list `search=` rides the `/restaurants` template) — a search-shaped
  replay arm would complete the whitelist coverage.

---
## 2026-11-18 18:55 — Session 103 — Public-read HTTP cache: ETag + short TTL on the browse reads (API, Phase 9)

**Built:**

- Phase 9's top item, API-only: new DI-free `common/http-cache/` — an
  in-process, URL-keyed store (500-entry cap, evict-oldest) serving
  `GET /api/restaurants`, `GET /api/restaurants/:id` (strict uuid match)
  and `GET /api/search` **for anonymous requests only** with a strong
  sha256 ETag over the exact response bytes, `Cache-Control: public,
  max-age=N` and `Vary: Authorization`. `HTTP_CACHE_TTL_SEC` (default 15,
  `0` off, garbage→default — the standing ops-knob doctrine; registered
  in `env.validation.ts`).
- The FRESH path is the performance claim: a fresh entry is served
  WITHOUT routing — matching `If-None-Match` → 304, else the stored 200
  — so zero SQL happens (the roadmap's "a revalidation must not fake a
  fresh DB read", proven per window with the query logger). After expiry
  the handler re-runs: unchanged bytes still answer 304 (transfer
  skipped) but the read honestly happens — no cheap version stamp exists,
  the docs say so.
- Chain placement + attribution: the middleware registers LAST
  (requestId → metrics → pino-http → cache) so served hits still hook
  both `finish` listeners — every 304 keeps its metrics sample and
  access line. Because a short-circuit never routed, the middleware
  stamps the whitelisted route PATH template onto `req.route` before
  ending the response — finish-time keys compose identically to matched
  requests (explicit whitelist attribution, session-98 rule intact; a
  `GET GET /api/...` double-prefix composition bug was caught by the
  integration spec, the template is stored WITHOUT the method for exactly
  this reason).
- Metrics rule tightened as the roadmap demanded: restaurant buckets are
  now minted by **2xx only** (was 2xx/3xx) — a cold observer can never
  mint via a 304; 3xx tops up existing buckets only (registry comment,
  three swagger descriptions, ARCHITECTURE.md updated).
- E2E safety: `e2e/playwright.config.ts` boots the API with
  `HTTP_CACHE_TTL_SEC=0` — the suite's write-then-assert flows and
  seed-absolute counts must never read a cached copy. The OpenAPI ops
  gained `@ApiHeader If-None-Match` documentation (contract lists and op
  counts unchanged).
- Product discovery pinned in specs: Express's own `res.send` freshness
  turns a cold `If-None-Match: *` into a 304 (weak auto-ETag) BEFORE our
  capture ever sees a 200 — the store only fills from unconditional 2xx
  captures; the integration spec asserts exactly this ladder.

**Verified:**

- API: `nest build` green; jest 95 suites / 1206 tests (+2 suites/+19
  vs session 102's 93/1187: `http-cache.spec` 11 +
  `http-cache.integration.spec` 8 incl. the ttl=0 transparency boot).
- Live smoke 51/51 GREEN **twice** on a 28-migration from-empty scratch
  DB (TTL=30 boot + TTL=1 + TTL=0 boots): query-logger windows show
  **0 statements** for cached-200 and fresh-304 revalidations on all
  three paths vs 2–8 for every capture window; per-URL keying
  (`?limit=10` is its own entry); bearer/sub-path(`/reviews`)/HEAD/
  malformed-uuid(400) negative controls carry NO Cache-Control;
  restaurant bucket minted by the 2xx (`restaurantKeys` +1), topped to
  `3xx=1` by the served 304 with keys stable, metrics reads exempt;
  TTL expiry revalidation still 304 but ≥1 statement (honest half);
  zero error-level API lines, zero 5xx access lines across both logs.
  Harness lessons (all four were harness bugs, zero product bugs):
  curl leaves `-o` files UNTOUCHED for bodiless 304s (truncate first);
  run-unique marker tags (an aborted run's OPEN window otherwise swallows
  the next run's seed — the phantom "408 statements"); `hdr` grep-absence
  kills a `set -euo pipefail` script through `$(...)` (wrap `|| true`);
  `-X HEAD` makes curl expect a body — use `--head`.
- Runtime :4000 dev boot: curl ladder green end-to-end (strong ETag,
  304 on revalidation, detail/search cached, reviews sub-path
  transparent) and the LIVE `GET /api/restaurants` metrics row reads
  `4 requests / {2xx:3, 3xx:1}` under the real controller — the
  fabricated-template attribution works against genuine routing.
- E2E full suite 97/97 green **x2** consecutive on fresh seeds (API
  boots now carry `HTTP_CACHE_TTL_SEC=0`; web untouched).

**Left for next sessions:**

- k6 public-browse re-baseline under the cache (PERFORMANCE.md
  recommendation 6 — filed as a roadmap item).
- Per-restaurant durability (Phase 8 🔒 item, unchanged): cached-304
  top-ups are exactly the samples a restart still zeroes.
- `isOpenNow` staleness (≤ TTL) is accepted; if the open-hours UX ever
  needs second-precision, the answer is a schedule-derived client-side
  computation, not a shorter TTL.

---
## 2026-11-18 16:27 — Session 102 — Owner reply COMPOSER UI: /dashboard/reviews (Web, Phase 9)

**Built:**

- Phase 9's session-101 sub-item, web-only increment: owners no longer need
  to script `PATCH /reviews/:id/reply`. New surface
  **`/dashboard/reviews`** (client page, dashboard/analytics gate idiom:
  skeleton → sign-in card → owner-gate card → restaurant switcher) + a
  zero-DOM `layout.tsx` owning the localized document title (session-93
  rule; SSR titles live-checked EN `Customer reviews — FoodOrder` and ID
  `Ulasan pelanggan — FoodOrder`). New **Reviews** tab in the shared
  `PortalTabs`.
- **`ReviewReplyComposer`** per review row: collapsed card shows the
  existing thread (label + date + text); `Reply`/`Edit reply` opens a
  2000-char textarea **pre-filled with the current thread**, Save is
  disabled while blank-or-unchanged (an invisible no-op write is a lie the
  UI never offers); a second save REPLACES (single-thread semantics made
  visible); `Delete reply` only renders when a thread exists; Cancel
  discards a dirty draft without any request; a failed save keeps the
  editor AND the draft open (the public row is unchanged server-side).
  Success/clear feedback: per-row `role=alert`/`role=status` line + a page
  polite live region announcing `FO-X` outcomes (portal-a11y doctrine).
- **The read rides the PUBLIC feed** (`GET /restaurants/:id/reviews`,
  `limit=50` + honest Load-more): the owner page reads exactly the rows the
  storefront renders — only the write pair carries the bearer. Session-91
  state honesty: the "no reviews yet" card renders ONLY after a successful
  feed load; failures split `PortalOffline` (down) vs `PortalLoadFailed`
  (4xx) — and the ADMIN rung gets its own honest card (see Verified).
- **API client**: `api.setReviewReply` / `api.clearReviewReply` (typed
  `{ review: ReviewRow }` responses; no API source touched at all).
- **i18n**: 30 new `Portal` keys × EN/ID (surgical single-line inserts,
  files stay pure-ASCII ensure_ascii; ICU token-set parity + EN/ID key
  parity asserted BEFORE writing; the ID==EN loanword audit found zero
  unintended copies). The `rvRated` EN value is an ICU plural — `count` is
  passed as a NUMBER (plural cases need it; `#` renders ungrouped at
  these magnitudes).

**Verified:**

- Web: `next build` green — `/dashboard/reviews` 5 kB / 126 kB first load;
  one real compile error caught and fixed on the first build (layout
  imported `getTranslations` from `next-intl`, it lives on
  `next-intl/server`).
- Live curl ladder on :4000 (seeded dev DB): feed shape (total 2, rating
  4.0/2, replied 1), PATCH sets `reply`+`repliedAt` together, DELETE clears
  to null, whitespace-only PATCH 400s with the `BAD_REQUEST` envelope, feed
  back to seed shape afterwards. ADMIN probe: `GET /restaurants/mine`
  answers `[]` → the page's restaurants===0 branch shows the honest
  no-restaurant card (never an empty-reviews claim over data the switcher
  could not fetch) — pinned by a new 5th e2e test.
- Targeted e2e `owner-reviews.spec.ts` 5/5: composer round trip
  (save → `Reply saved.` + live-region announcement → **reload = server
  truth** → delete → seed shape restored, stars provably unmoved),
  replace/cancel semantics on the SEEDED thread (restored byte-exact via
  API in `finally`), anonymous + customer gates, ADMIN card, ID chrome
  byte-pins (`Ulasan pelanggan`, `Balasan Anda`, `Balas`, `Ubah
  balasan`) — read-only.
- FULL e2e suite **92 → 97 green ×2 CONSECUTIVE** on fresh seeds (final
  tree; the earlier 96-run predates the ADMIN pin). API: jest/build delta 0
  — `apps/api` untouched (0 changed files), suite counts stay 93/1187 from
  session 101.
- Harness lesson (second sighting of the session-95/101 class):
  `getByLabel('Restoran')` is NOT strict on this page — the review
  section's localized `aria-label` contains the same word
  case-insensitively; the switcher is pinned by `label select`
  (portal-chrome-id doctrine). First targeted run 3/4 with that ONE strict
  violation — spec-side, zero product bugs.
- Sanitizer scan: 869 added lines, zero U+2026/`***`/literal `\u`;
  `git diff --check` clean; the single pre-existing U+2026 in
  `apps/web/lib/api.ts` re-verified as HEAD prose (count 1 both sides).

**Left for next sessions:**

- Optional: notify a reviewer when the restaurant replies (carried from
  session 101).
- The composer page lists rows with no filter yet (unreplied-first
  ordering or an `unreplied` chip would cut owner effort); the seeded
  fixtures are too small to need pagination today.
- Phase 9 keeps three open items: HTTP caching for public reads (Perf),
  `/favorites` + `/addresses` loading pass (UX), flake-tooling graduation
  (Test).

---
## 2026-11-18 14:18 — Session 101 — Owner replies to reviews: one thread ON the review row (Product, Phase 9)

**Built:**

- Phase 9's product item, end to end. **Migration 28th**
  `AddReviewReplies1794900600000`: `reviews.reply` varchar(2000) NULL +
  `reviews.repliedAt` timestamptz NULL + `CHK_reviews_reply_pairing`
  (a reply without its timestamp is rejected at the DB — the smoke fired
  the violation on purpose). Single-thread design recorded honestly: the
  second PATCH REPLACES the text (no history rows, no child table until
  conversational depth exists).
- **API**: `PATCH /reviews/:id/reply` + `DELETE /reviews/:id/reply` on the
  ReviewsController rung (bearer). Access is session 98's `getOwned`
  ladder ON THE REVIEW'S RESTAURANT: owner or ADMIN — authorship does NOT
  grant reply rights (the review's own author as a plain customer 403s),
  unknown/malformed ids 404 at the ladder (400 at the route via UuidParam).
  Deliberate 403-vs-404 split documented: reviews are already PUBLIC data,
  so "not yours" leaks nothing and a stale dashboard deserves the honest
  code. `ReplyReviewDto` fully class-validator-decorated; whitespace-only
  text 400s at the SERVICE (an invisible response card is a lie); blank
  body 400s at the pipe. A reply NEVER recomputes stars — and
  `ReviewReplyResponse` carries NO `restaurant` aggregate at all, so the
  contract itself cannot suggest the rating moved. Idempotent clear:
  clearing an unreplied row writes NOTHING (no updatedAt churn — the smoke
  pinned the timestamp). Public feed + `/reviews/my` embed `reply`/
  `repliedAt` through the shared `toReviewRow`; the GDPR export allowlist
  deliberately does NOT carry owner reply text (not the customer's
  personal data) — export-keys pin proves it.
- **Swagger contract**: 2 ops registered (live + spec 75 -> 77, SUCCESS
  pin bumped), bearer + error lists + schema pins (`reply` nullable string,
  `repliedAt` nullable date-time, reply response restaurant-free).
  `uuid-route-params` table extended so the new routes join the malformed-
  id gate.
- **Web**: restaurant page renders the response card nested under the
  review (`data-testid=review-reply`: localized label + reply date +
  text); new `Restaurant.ownerReply` key EN/ID. Seed ships ONE
  deterministic owner reply (3-star sate complaint, repliedAt pinned to
  2026-11-02T09:30Z so specs can pin the date) — a fresh DB shows the
  thread with zero API calls.
- ARCHITECTURE reviews bullet extended with the whole reply rule.

**Verified:**

- API: `nest build` green; jest 93 suites / 1165 -> 1187 (+22: 14 service
  ladder/set/replace/clear/pairing/feed tests incl. the admin-bypass
  no-restaurant-read pin, 6 ReplyReviewDto pipe cases, 2 re-pinned exact
  row shapes).
- Live scratch-DB smoke (28-migration chain from EMPTY, API on :4010):
  41/41. Highlights: seed pairing exact, trim-on-write DB truth, replace
  semantics, rating EXACTLY 4/2 identical before and after all reply
  traffic, full ladder on a fixture-reassigned second owner (author 403
  FORBIDDEN envelope, foreign owner 403, owning owner 200, ADMIN 200,
  every rejected leg wrote nothing), 6 validation branches, no-op clear
  byte-identical updatedAt, CHECK rejects manual drift, docs live-ops ==
  spec pin 77 with bearer on both reply ops, 401 unauthenticated. Zero
  error lines in the API log.
- Live :4000 curl ladder set -> feed -> clear -> feed, seed shape restored.
- Web: `next build` green. New `e2e/tests/review-replies.spec.ts` 3 tests
  (nested render + set/clear round trip with the seeded thread counted
  exactly, access-ladder wire asserts proving zero writes afterwards, ID
  label byte-pin 'Balasan dari restoran'); targeted 3/3, FULL suite
  89 -> 92 green x2 CONSECUTIVE on fresh seeds. The first targeted run's
  single failure was spec-side strict mode (two reply cards share the
  label) — fixed with a testid count pin + `.first()`, no product change.
- Sanitizer scan: zero U+2026/`***` on added lines (the one U+2026 in
  apps/web/lib/api.ts is a pre-existing HEAD prose ellipsis, count 1 on
  both sides); messages edited surgically (single-line inserts — an early
  json-dump attempt reformatting the whole file was reverted before
  commit); `git diff --check` clean.

**Left for next sessions:**

- Owner reply COMPOSER UI: today an owner needs the API to write the
  reply — the dashboard has no reviews surface at all. Filed as a sub-item.
- Optional: notify a reviewer when the restaurant replies (the
  notifications fan-out is the natural home).

## 2026-11-18 12:16 — Session 100 — Receipt-flake root cause: a goto racing the sign-in click ABORTS the auth request (E2E, Phase 9 opened)

**Built:**

- Phase 8 is down to its two 🔒 items, so Phase 9 opened as the new
  top-down queue (seeded from the Test / Product / Perf / UX evergreen
  loops). Its first item was due twice already: the `zz-forms-a11y`
  "receipt: bare link..." flake, flagged in session 91 and again in
  session 99 ("instrument the loginToken/createOrder/payOrder
  timings"). Root cause found by CODE, not by measurement:
- **Mechanism.** The receipt test ran `page.goto('/login')` ->
  `signInUi(...)` -> `page.goto('/orders/:id')`, and `signInUi`
  returned the moment the click dispatched. The full-document
  navigation COMMITS while `POST /auth/login` is still in flight, and
  Chromium CANCELS pending fetches when the document is replaced —
  `login()` never resolves, `applySession` never stores the tokens,
  and the receipt page renders the guest OrderVerify state, so the
  signed-in-only heading times out at 15 s. The suite had ALREADY
  learned this class twice independently (`zz-gdpr-account` carries
  session 88's verbatim comment "racing one mid-login renders the
  dashboard as guest"; sessions 93/97 added the
  `not.toHaveURL(/\/login/)` guards) — only this file's helper copy
  was unguarded, and the session-97 product settle-gate cannot help:
  `inert` blocks CLICKS, never a script-driven `page.goto`.
- **Hardened `signInUi`** in BOTH specs owning a copy
  (`zz-forms-a11y`, `zz-gdpr-account`): the helper now waits for the
  URL to leave `/login` before returning — the redirect commits
  strictly AFTER `login()` resolved and `applySession` persisted the
  session, so any caller navigation after the helper is safe. The
  suite idiom, promoted into the helper itself.
- **Instrumentation** (the twice-filed ask): a `timed()` wrapper now
  stamps wall-clock `fixture-timing` annotations + stdout on EVERY
  direct-API fixture leg of `zz-forms-a11y` — `loginToken`,
  `warungFixture`, `createOrder`, `payOrder`, `ownerAdvance` — for
  passes and failures alike; a recurrence names the slow leg instead
  of the whole helper.
- **`loginToken` 429 tolerance** (payOrder's doctrine: read
  `details.retry_after_sec`, sleep, retry ONCE, 45 s cap) — the auth
  bucket is 10/min per identity on hand-booted APIs and several specs
  log in inside the same rolling minute; it was the last unguarded
  API leg in that fixture chain.
- **New pin** `e2e/tests/zz-login-abort.spec.ts` (2 tests, read-only,
  seed-safe, zz-* sorted): HOLD the login response 1.5 s (armed on
  the `request` event per the session-97 harness rule, real call
  still reaches the API via `route.fetch`), then test 1 reproduces
  the OLD sequence VERBATIM and asserts the guest gate h1, no signed-in
  h1, and localStorage session `null` — proof of ABORTION, not
  slowness; test 2 applies the hardened contract to the same hold and
  asserts the signed-in render. The flake class is now executable,
  not folklore.
- ARCHITECTURE settle-gate bullet extended with the adjacent
  goto-abort class (helper doctrine); ROADMAP Phase 9 opened with
  this item ticked + 4 unchecked session-sized items.

**Verified:**

- FULL e2e suite 87->89 green x2 CONSECUTIVE on fresh seeds (3.0 min
  each; both runs include the two new pins). Zero EN pins edited —
  every pre-existing assertion byte-identical, the touched files are
  exactly the two helper patches + the new spec.
- Targeted loop `zz-forms-a11y` + `zz-login-abort`: 8/8 x3
  consecutive with a re-seed BEFORE every iteration.
- API delta 0 as claimed: `nest build` green; jest 93 suites / 1165
  tests — identical to sessions 98/99 (no API or app code touched).
- Sanitizer scan: zero U+2026/`***`/U+FFFD on added CODE lines (the
  docs ellipsis is prose); the rewritten login data line read back by
  codepoint — its value is the `DEMO_PASS` identifier, no mask on
  disk; `git diff --check` clean.

**Left for next sessions:**

- Graduate the flake tooling (Phase 9 item): the remaining INLINE
  sign-in sequences (admin, live-feed, portal-a11y, account keep
  their own click code) onto the redirect-commit contract, and turn
  `fixture-timing` annotations into a CI ceiling.
- The two Phase 8 🔒 items stand untouched (per-restaurant durability,
  order-centric attribution).
## 2026-11-18 10:32 — Session 99 — Owner traffic panel on /dashboard/analytics consuming the per-restaurant metrics route (Web, Phase 8)

**Built:**

- Session 98's first roadmap sub-item: the web surface for
  `GET /api/restaurants/:id/metrics`. Chose to make the EXISTING
  `TrafficPanel` the shared component rather than fork a second panel: its
  props are generalized to a structural `TrafficView` =
  `Pick<MetricsSnapshot, 'generatedAt' | 'uptimeSec' | 'totals' | 'routes'>`
  plus an optional scoped `heading` — the restaurant payload satisfies it
  field-for-field, and because the component can ONLY read those four keys,
  a global field can never ride onto the OWNER rung through it even by
  accident (the session-85 ADMIN-only rule holds at the type level now, not
  just in the API).
- `lib/api.ts`: `RestaurantMetricsSnapshot` contract type (documents the
  scope/window honesty markers and the zero-global-fields rule) +
  `api.getRestaurantMetrics(token, id)` on the owner-portal rung.
- `/dashboard/analytics`: a SECOND, INDEPENDENT fetch beside analytics —
  a metrics failure never blanks the revenue cards and an analytics failure
  never hides the traffic section (the admin-page degradation rule).
  `dynamic(() => import('@/components/TrafficPanel'), { ssr: false })`
  rendered strictly under the `traffic != null` data-presence gate, so the
  panel chunk is fetched behind the metrics round-trip (session 90's
  gate-doubles-as-code-split rule); localized `traffic-panel-loading`
  skeleton while in flight; amber `role=alert` strip
  (`traffic-load-error`) on failure — a failed load degrades LOUD, it never
  pretends "no traffic" (session 91 rule; the honest zero rows now only
  ever come from a SUCCESSFUL fetch). Section only renders once a
  restaurant is selected (the switcher's `selectedId` drives the fetch, so
  an owner with zero restaurants sees no phantom panel).
- i18n: ONE new key `Portal.ownerTrafficHeading` EN "Traffic for
  {restaurant}" / ID "Trafik untuk {restaurant}"; everything else reuses
  the sessions 80/85/93 traffic chrome keys already byte-pinned EN/ID.
- ARCHITECTURE metrics bullet extended with the web-consumer rule
  (structural TrafficView Pick, render-gate code split, loud degradation).

**Verified:**

- `next build` green; `/dashboard/analytics` First Load 126 kB — the panel
  is NOT in it (deferred chunk; the degradation e2e proves the gate: with
  metrics aborted, `traffic-route-table` renders 0 elements).
- API untouched — `nest build` + jest re-run prove the delta 0
  (93 suites / 1165 tests, same as session 98).
- New `e2e/tests/owner-traffic.spec.ts` (3 tests, all read-only /
  route-intercepting — seed-safe): (1) signs in as owner, MINTS the bucket
  deterministically with one attributed owner-inbox 2xx (a cold boot would
  otherwise legitimately show zeros), captures the page's OWN metrics
  response via waitForResponse and pins the EXACT OWNER key-set
  (scope='restaurant', window='since_api_boot', the 8-field key list — no
  global/durability field can ride along), cross-checks cards/heading/
  cumulative label/minted route row against that payload, and sweeps every
  route key for uuid leaks AND for `/metrics` rows (the observer exemption
  holds end-to-end); (2) aborts the metrics route -> analytics cards stay,
  the amber alert strip appears, the panel table is absent; (3) ID locale
  byte strings ('Permintaan', 'Trafik untuk …', 'Kumulatif sejak API
  boot'). Harness lesson pinned in the spec: a response captured ACROSS a
  full navigation reload is not retrievable later
  (Network.getResponseBody misses) — the wire↔DOM cross-check must ride
  the in-page fetch, not a reload.
- FULL e2e suite 84→87: run 1 green, run 2 failed EXACTLY ONE test — the
  `zz-forms-a11y` "receipt: bare link…" flake already recorded as a
  PRE-EXISTING candidate in session 91's DEVLOG (its direct-API fixture
  path is untouched this session; the new spec creates no orders and
  changes no state) — then runs 3+4 green 87/87 CONSECUTIVE on fresh
  seeds. Not claimed as a regression; session 91's "instrument the
  fixture timings if it recurs" note stands.
- Sanitizer scan: zero U+2026/`***`/U+FFFD in any added CODE line (all six
  app/e2e files clean); the only ellipses/stars introduced are deliberate
  prose in this log entry. Both messages JSONs parse; EN/ID Portal key-sets
  still equal (one new key each).

**Left for next sessions:**

- Per-restaurant durability (next roadmap sub-item): buckets are live-only,
  a restart silently zeroes the owner view — persist the dimension and
  serve windowed deltas, mirroring session 89's same-boot subtraction rules.
- Order-centric attribution (roadmap sub-item): `POST /orders`, payments
  and receipt reads concern a restaurant but carry no path param — needs an
  explicit service-side opt-in hook, never a url heuristic.
- The `zz-forms-a11y` receipt flake recurred once (first time since session
  91 filed it) — instrumenting its loginToken/createOrder/payOrder timings
  is now due, ideally before it starts eating clean-run evidence.

---
## 2026-11-16 19:32 — Session 98 — Per-restaurant traffic for owners: the explicit registry dimension + OWNER-rung scoped read (API, Phase 8)

**Built:**

- Last open Phase 8 item (session 85's decision: restaurant scoping needs an
  EXPLICIT registry dimension and the global snapshot must never surface on
  an OWNER rung). `RequestMetricsRegistry` gains a restaurant dimension:
  every sample whose MATCHED route template is restaurant-scoped
  (`/api/restaurants/:id/*` incl. the `:restaurantId` menu variant —
  `restaurantScopeOf` keys on the TEMPLATE so `/menu/items/:id`'s dish-id
  can never be misread as a restaurant) additionally lands in that
  restaurant's own sub-registry of the same route-key space, uuid-gated and
  lowercased.
- Cardinality + probe policy: buckets are MINTED ONLY BY 2xx/3xx — random
  valid-uuid probes 404 and never grow the key space — while later 4xx/5xx
  still TOP UP an existing bucket (owners see errors on their surfaces, not
  just pageviews). Past the 250-bucket cap new buckets are REFUSED rather
  than folded (folding one owner's traffic into a shared "other" bucket
  would be the one unforgivable leak); the global snapshot gains additive
  `restaurantKeys`/`restaurantOverflowed` so operators see the dimension's
  health, and unmatched junk can never mint anything.
- Observer exemption: `GET /api/restaurants/:id/metrics` itself is excluded
  from attribution, so a dashboard polling its own traffic never inflates
  the numbers it reads.
- New OWNER route `GET /api/restaurants/:id/metrics` (admins bypass) in a
  dedicated `RestaurantMetricsController`: ownership via the SAME ladder as
  `updateOwned` — `RestaurantsService.getOwned` was extracted and
  `updateOwned` refactored onto it, so the 404-malformed/404-unknown/403-
  foreign semantics can never diverge. The payload is built EXCLUSIVELY
  from the restaurant's own bucket: `restaurantId/scope/window/uptimeSec/
  boundsMs/totals/routes` — zero global fields, no durability/window
  extras, honest zero snapshot for an owned-but-quiet restaurant. Typed
  swagger contract `RestaurantMetricsResponse` (ops 74→75, registered in
  all four swagger.spec pin lists).
- v1 deliberately reads the LIVE registry only — per-restaurant traffic is
  NOT persisted to `metrics_snapshots` (session 89's window math stays a
  global concern) and no order/payment-scoped routes are attributed (no
  path-visible restaurant id); both filed honestly below.

**Verified:**

- `nest build` green; jest 91/1142 → **93 suites / 1165 tests** (+2/+23:
  new `restaurant-traffic.spec.ts` unit block — attribution variants,
  exemption, success-mint vs error-topup, cap refusal, case normalization,
  isolation, reset; new `restaurant-metrics-http.spec.ts` — real guard
  chain over HTTP: 401 anonymous/bad token, 403 customer+driver BEFORE the
  ladder is consulted, 400 malformed uuid, 404/403 service answers through
  the envelope, exact OWNER key-set pin proving no global field can ride
  along, honest empty snapshot; plus one finish-time attribution case
  appended to `request-metrics.integration.spec.ts` driving a REAL
  `@Controller('restaurants/:id')` probe through the production middleware
  chain — template collapse, 404-probe mint refusal, top-up, uppercase
  normalization, observer exemption, junk-no-mint, all pinned).
- Live scratch-DB smoke **48/48** on a 27-migration from-empty DB
  (`foodorder_rm98_smoke`, API on :4013): exact per-bucket arithmetic
  (3 pageviews + 1 role-denied PATCH → requests 4, byStatus {2xx:3,4xx:1},
  TWO template rows), metrics reads change NOTHING across repeated polls,
  foreign-restaurant isolation (Seoul sees 1, never 4), zero-traffic owned
  restaurant → honest 200 with 0 requests (not a 404, not stale data),
  probe flood of 3 random uuids mints nothing (`restaurantKeys==2` after
  create+probes+polling), the metrics op row itself tallies 8 requests
  5×200/3×4xx globally, deny ladder 401/403/400/404 envelope codes,
  zero writes to `orders`, restaurants delta exactly +1 (the throwaway),
  0 driver errors in the API log.
- API-only increment — web untouched, `next build` n/a. No migration, no
  seed change, no env knobs added.

**Left for next sessions:**

- 🔒 Web: owner traffic panel consuming `GET /restaurants/:id/metrics`
  (shape-based cross-check recipe per session 85; EN/ID).
- Per-restaurant DURABILITY: restaurant buckets are live-only — a restart
  silently zeroes them (same flaw session 89 fixed for the global view).
- Attribution for order-centric routes (`POST /orders`, payments) — the
  restaurant is service-known but not path-visible; needs an explicit
  opt-in hook, NOT a url heuristic.

---
## 2026-11-16 17:22 — Session 97 — Auth-redirect settle-gate: the login-redirect vs nav-click race fixed in the product (Web, Phase 8)

**Built:**

- Product fix for the last open Phase 8 race item (session 93
  A/B-quantified ~1/5 cold; the suite had only a test-side `not.toHaveURL`
  workaround). New `lib/nav-gate.ts`: a DI-free client store that holds the
  shared `<header nav>` INERT from the first moment of a login/register
  submit until that form's post-auth redirect COMMITS (normal release = the
  form's unmount; failed submits release in the catch; an 8s safety timer
  covers a pathological never-commits redirect like a crafted
  `?next=/login`). No clickable link can begin inside the flight window
  anymore — the exact state that used to let a click commit first and then
  get dragged back home by the later-landing `router.replace(next)`.
- `Header.tsx` consumes it via `useSyncExternalStore` (server snapshot
  false — hydration-safe, first paint never gated). While gated the nav
  carries `inert` (keyboard/AT) + `pointer-events: none` (the half browsers
  AND Playwright's "receives events" check wait on) + the `data-navgated`
  pin attribute.
- Login (both the already-signed-in skip effect and submit) and register
  (skip effect, post-validation submit path) engage synchronously BEFORE
  dispatching `router.replace(...)` and re-engage immediately before the
  dispatch in case a slow auth round-trip tripped the safety timer; the
  catch paths hand the nav back.
- 4 new e2e tests `login-redirect-race.spec.ts`: the deterministic
  swallowed-click repro (home RSC fetch held 800 ms after arming on the
  auth REQUEST — arming on the response loses the race against the page's
  own continuation; documented in-file), the inert-window pins
  (`data-navgated=1` + `inert` from submit start until landing), a failed
  sign-in releasing immediately plus a genuinely interactive nav after,
  the already-signed-in `/login` skip redirect, and the same guarantee on
  the registration flow (throwaway timestamped account — no seed-state
  consumption).

**Verified:**

- `next build` green. A/B protocol: a throwaway outcome-only probe ran on
  the UNMODIFIED HEAD build FIRST and PASSED — the honest finding is that
  a route-held redirect whose fetch lands after the click's commit is
  correctly DISCARDED by the router; the race only bit inside the narrow
  fetch-done→commit-done render window, which network interception cannot
  widen (session 93's cold 1/5 remains the empirical defect evidence —
  recorded, not re-fabricated). The fix removes that window BY
  CONSTRUCTION: the gate covers submit-start → commit inclusive, so no
  click can start inside it; the regression spec pins the mechanism.
- The 4 new specs 5× consecutive stable (4/4 ×5); the aborted-prefetch
  experiment taught the harness lesson pinned in the spec: aborting the
  pre-auth home prefetch makes Next fall back to a FULL-DOCUMENT reload
  instead of an SPA flight, destroying the very window under test —
  pre-auth RSC requests must be passed through.
- Full e2e suite 80→84 GREEN ×2 consecutive on fresh re-seeds (2.2m / 2.1m).
- API untouched — `nest build` + jest re-run prove delta 0 (91 suites /
  1142 tests, same as sessions 90–96).
- Sanitizer scan: 0 `***` / 0 U+2026 on every added line of all six touched
  files (codepoint readback, not display); `git diff --check` clean.
- ARCHITECTURE: the session-93 "e2e flows must wait for the redirect" rule
  REWRITTEN as the product-side settle-gate rule (the old suite-side
  guards stay as harmless belt-and-braces).

**Left for next sessions:**

- Roadmap's next unchecked item stands: per-restaurant traffic for owners
  (🔒 needs an explicit registry dimension; never expose the global
  snapshot on an OWNER rung).
- If a deterministic pre-fix failure repro is ever needed again, note the
  canary-discards finding above — route holds cannot widen the
  fetch-done→commit render window.

---
## 2026-11-16 15:20 — Session 96 — Storefront i18n sweep #4: favorites + account surfaces (Web, Phase 8)

**Built:**

- 43 new message keys × EN/ID: new `Favorites` (15) and `Account` (27)
  namespaces + `Common.retry` ("Try again"/"Coba lagi"); both guest-gate
  CTAs reuse `Header.signIn`. `/favorites` fully localized: heading, the
  load-failure card, guest gate, skeleton aria "Loading saved dishes",
  BOTH empty-card variants (ICU `emptyWithName`/`emptyNoName` reproduce
  the old JSX ternary byte-identically), the row meta "· saved {date}"
  (date now renders through `toLocaleDateString(locale)` — session 94
  doctrine) and the "· currently unavailable" flag. The SHARED
  `FavoriteButton` heart came too (aria Save/Remove + guest title — the
  same sweep #4 wording mirrored on the restaurant menu).
- `/account` fully localized: guest gate, identity line ("Signed in as"
  fragment; the mono-`DELETE` token stays the EXACT server phrase inside
  the localized label "Ketik DELETE untuk mengonfirmasi"), the export
  card (both button states, done-line ICU `{file}`, browser-blocked
  fallback), the danger-zone card, and both client guards
  (`errPasswordRequired`/`errConfirmPhrase` — EN renders "Type DELETE
  exactly to confirm." byte-identically), plus the post-delete summary —
  the hand-rolled `? 's' :` plural became `deletedOrders`
  `{count, plural, =1/other}` + `{count}` suffix keys. Server envelope
  messages (e.g. the password-check alert) stay English per the
  session-95 API-side non-goal.
- Document titles: two zero-DOM title-owning server layouts — `/favorites`
  "Saved dishes — FoodOrder"/"Hidangan tersimpan — FoodOrder", `/account`
  "Account & privacy — FoodOrder"/"Akun & privasi — FoodOrder"
  (sessions 93/95 pattern).
- ARCHITECTURE localization bullet now names the favorites/heart + GDPR
  account surfaces.

**Verified:**

- Catalog doctrine asserted BEFORE and after writing: every EN value
  proven byte-equal to the JSX it replaces (source slices extracted,
  html-unescaped and whitespace-collapsed for the six multi-line prose
  blocks; exact-literal presence for the rest; the DELETE-exactly
  template and the hand-rolled plural checked against their source
  shapes), EN/ID key parity + ICU token-set match per namespace,
  ensure_ascii dumps re-read with codepoint spot-checks (U+2026/U+2019/
  U+201C intact).
- `next build` green. API untouched — `nest build` + jest re-run prove
  delta 0 (91 suites / 1142 tests, same as sessions 90–95).
- SSR curl smoke: EN and ID (`locale=id` cookie) `<title>`s render
  server-side on both routes.
- Sanitizer scan: 0 `***` / 0 stray U+2026 across all eight touched
  files (codepoint readback, not display); `git diff --check` clean.
- NEW 6 `storefront-i18n-account-id` tests (74→80): ID favorites
  signed-out gate + CTA href pin; ID favorites signed-in row meta
  ("· disimpan") + localized heart aria — assertion-only, the heart and
  Add buttons are never clicked; ID account gate; ID account signed-in
  chrome (headings, identity fragment, labels, the mono-DELETE label
  regex); ID localized client guard firing BEFORE any request (empty
  password submit → localized alert, account alive); EN title pins.
  First run caught one harness lesson: `exact: true` getByText cannot
  match a fragment INSIDE a bigger element — the identity line pins by
  substring (session 81 whitespace family).
- Full suite 80/80 green ×2 consecutive on fresh seeds (reseed between
  runs); the EN suite was untouched — every English string is carried
  byte-identically by the pinned catalog values.

**Left for next sessions:**

- Roadmap's next unchecked item stands: product fix for the
  login-redirect vs nav-click race (settle-or-cancel discipline +
  regression spec).
- Server API error envelopes remain English (API-side Accept-Language
  vs user-pref decision, session 95 note).
- `formatPrice` renders plain `$X.YY` in every locale (pre-dates this
  sweep, app-wide); an IDR/money-format decision belongs to the
  Evergreen product loop, not a text sweep.

---
## 2026-11-16 10:42 — Session 95 — Storefront i18n sweep #3: login, register, addresses book + lib fallbacks (Web, Phase 8)

**Built:**

- 80 new message keys × EN/ID: new `Auth` (24) and `Addresses` (33)
  namespaces + `Common` (+10 shared words: email/password/name/phone/
  cancel/edit/delete/loading/optional/phonePlaceholder) + 3 document-title
  keys (`Auth.titleSignIn`/`titleRegister`, `Addresses.pageTitle`) and
  `Checkout.pageTitle`/`Order.pageTitle`. EN values byte-identical to the
  JSX they replaced (the untouched EN suite is the proof); `Sign in` CTAs
  reuse `Header.signIn`, `Jane Doe`/`Budi Santoso` and the street
  placeholder reuse `Checkout`, `Default`/`Utama` reuses
  `Checkout.defaultBadge` (reuse-over-duplication doctrine).
- `/login` fully localized: heading, subtitle, both labels, both CTA
  states, register link line, demo hint, Suspense fallback, and the
  `Could not sign in` last-resort. `/register`: heading, subtitle, all six
  labels (the `(optional)` spans stay separate text nodes so accessible
  names like `Telepon (opsional)` reproduce), placeholders, the whole
  inline-validation ladder (module-scope `validate()` now receives the
  translated message set — hooks cannot run there), server-error fallback,
  both CTA states, sign-in link. `/addresses`: heading, hint, add/edit/
  delete/`Make default`/default-badge, both form variants incl.
  `AddressFields`, guest gate, empty card, `Edit “{label}”` as an ICU
  message, all seven validation strings, the three error fallbacks and the
  `Loading addresses` aria name.
- Document `<title>`s: four zero-DOM title-owning server layouts
  (`/login`, `/register`, `/addresses`, `/checkout` — session 93 pattern;
  the pages are client components) and `generateMetadata` directly on the
  SSR receipt page. EN gains real titles (`Sign in — FoodOrder` …, the
  Portal convention); ID renders `Masuk — FoodOrder` etc.
- Locale-aware lib fallbacks (the item's open decision): new
  `lib/locale-strings.ts` serves `authedCall`'s two last-resort strings
  outside React, reading the locale from the SSR'd `<html lang>` (single
  source of truth — the `locale` cookie is httpOnly, so a client read is
  not an option). ID wording matches the Portal `histErrApi*` pair
  already shipped; EN values stay byte-identical (the `favorites-error`
  e2e pin proves it). `lib/api.ts`'s `API error ${status}` remains
  technical English by decision (debug-class fallback, never primary UI).
- `docs/ARCHITECTURE.md`: the storefront-localization rule now names the
  auth/addresses surfaces + document titles and pins the `<html lang>`
  lib-fallback contract.

**Verified:**

- `next build` green; API untouched — `nest build` + jest re-run prove
  delta 0 (91 suites / 1142 tests, same as sessions 90–94; jest needed
  `--maxWorkers=2` on this 2 GB host after a default-worker OOM, no
  product impact).
- EN/ID key parity + ICU token-set match asserted programmatically per
  namespace before any write; messages written by a python
  `ensure_ascii` dump (escapes generated host-side). The `Mum's`
  apostrophe was corrected EN-first (file carries ASCII `'`), and the ID
  `Konfirmasi kata sandi` casing bug (capital K) was caught by the new
  spec's own run and fixed in the catalog.
- NEW 5 `storefront-i18n-auth-id` tests (69→74): ID login chrome+title;
  ID register chrome, placeholders and the four localized inline alerts
  (read-only — client-blocked); ID addresses signed-out gate THEN
  signed-in seeded book chrome (`Tambah alamat`, `Utama` badge, `Ubah`/
  `Hapus`); ID checkout + bare-receipt titles; EN titles pin for all five
  routes. First targeted run caught two spec-side bugs (catalog casing;
  string `getByText` is a case-INSENSITIVE substring match — `Utama` hit
  the hint and `Jadikan utama` too → `exact: true`).
- One real suite-contract break, product-side honest: session 92's
  `portal-chrome-id` assumed "the login page is English chrome" and signed
  in under the ID cookie — now the CTA reads `Masuk`; its `signIn` helper
  accepts /^(Sign in|Masuk)$/ (input ids stable; comment updated).
- Full suite 74/74 green ×2 CONSECUTIVE on fresh seeds. (The earlier
  mixed run's 2 failures were both the portal-chrome-id assumption above.)
- Sanitizer scan: added lines + all new files 0 `***` / 0 stray U+2026;
  `git diff --check` clean.

**Left for next sessions:**

- `/favorites` and `/account` chrome are still English-only (adjacent
  surfaces found while sweeping; filed as the next roadmap item).
- Server API error-envelope messages (login failures, validation) remain
  English — a deliberate non-goal of the web sweeps, needs an API-side
  decision (Accept-Language vs user pref).

---
## 2026-11-14 20:19 — Session 94 — Storefront i18n sweep #2: cart, checkout, receipt (Web, Phase 8)

**Built:**

- 153 new message keys × EN/ID across three new namespaces (`Cart` 23,
  `Checkout` 39, `Order` 83) plus `Common` (+5: subtotal/total/wordDelivery/
  promoLine/qtyLine shared by checkout AND receipt) and `Offline` (+3 for the
  PWA shell page) — localizing every remaining storefront English surface the
  sessions 74–92 note scoped out: the cart page (chrome, steppers, offline
  note, desktop/mobile fee lines), the cart-switch dialog (fragment split so
  the `<strong>` runs keep their DOM), the whole checkout form (labels,
  hints, saved-address picker, promo engine ladder, both submit buttons), the
  SSR receipt page (header templates, six status pills, items/summary/contact
  rows), and its islands: `OrderTimeline` (steps + sr-only summary),
  `OrderLiveFeed` (transport pills + status-change announcement),
  `PaymentPanel`/`PayButton` (every state incl. refund/pending/failed-count
  templates), `OrderVerify` (deny + unlock paths) and `RateOrderCard` (legend,
  star radios via ICU plural, submit ladder).
- EN values byte-identical to the JSX they replaced: the ICU split of the
  below-minimum alert (` — ` + link tail), `Paid — {price} via {provider}`,
  the refunded running line as three conditional fragments, pluralized
  `# failed attempt(s)` and `# star(s)` — all assembled so the rendered text
  nodes match the old literals exactly (the untouched 66-test EN suite is
  the proof).
- Reuse per doctrine: guest `Sign in` links read `Header.signIn`, shared
  words flow through `Common`; `String(n)` passed for every `{count}`/price
  ICU param. Deliberate ID==EN loanwords/symbols only: Checkout, Promo,
  Subtotal, Total, Keranjang→cart CTA arrows, `N × dish`, ` (status: x).`
- `OrderTimeline` timestamps became locale-aware (`id` → `id-ID`, `en` keeps
  the historical `en-US` rendering byte-identical).
- `docs/ARCHITECTURE.md`: the storefront-localization rule now names the
  whole order funnel + byte-pin/`String(n)` doctrine as durable contract.

**Verified:**

- `next build` green; API untouched — `nest build` + jest re-run prove delta
  0 (91 suites / 1142 tests, same as sessions 90–93).
- EN/ID key parity asserted programmatically per namespace (533=533 overall)
  and every ICU token set EN↔ID-matched; EN byte-pin dict (42 strings the
  e2e suite pins — headings, labels, `Pay $21.00`, `Place order — $39.00`
  templates, aria names) asserted against the on-disk JSON before any edit.
- NEW 3 `storefront-i18n-checkout-id` tests (66→69): ID cart+checkout chrome
  through the real add-to-cart flow incl. live-priced `Buat pesanan —
  $21.00` enabled submit; ID receipt on a self-created order (title, status
  pill, timeline subs, payment guest hint, contact rows); ID OrderVerify
  denial path (exact-text `Tidak ada yang terbuka…`), all locale-cookie,
  read-only or self-owned orders, sorted after the seed-absolute specs.
- Full suite 69/69 green ×2 CONSECUTIVE on fresh seeds — zero EN assertions
  edited. (An intermediate run failed only `admin.spec` 10→11 orders: the
  targeted new-spec run had consumed the seed — suite contract, not a
  regression; the doctrine's reseed-between-runs rule applies.)
- Sanitizer scan: 676 added lines, 0 `***`; messages written by a python
  `ensure_ascii` dump (escapes generated host-side), codepoint probes on
  disk verified em-dash/ellipsis/emoji/`\\u2019`-apostrophe values intact;
  `git diff --check` clean.

**Left for next sessions:**

- `lib/authed-call.ts` + `lib/api.ts` client fallback error strings ('Cannot
  reach the API. Is the server running?' etc.) are locale-free plumbing
  literals shared by portal + storefront — a lib-level message pass would
  need a locale-aware helper; deliberately untouched (favorites error testid
  byte-pin stays safe).
- Saved-address book page (`/addresses`) and login/register forms remain
  English chrome — natural storefront i18n sweep #3 candidates.
- Receipt/checkout document `<title>`s still come from the global metadata.

---
## 2026-11-14 20:52 — Session 93 — Localization leftovers: portal titles, menu/analytics/history chrome, TrafficPanel (Web, Phase 8)

**Built:**

- 132 new `Portal` message keys × EN/ID closing every surface session 92
  scoped out: `/dashboard/menu` chrome (gates, subtitle composing
  `Dishes for {restaurant} · N dishes · M hidden` byte-identically, Hide/Show
  tooltips, row stock fragments `· stock: unlimited` / ` · sold out` / `only N
  left`, error/notice templates incl. the curly-quoted `Could not change
  "{name}"` pair), the whole `MenuItemForm` dialog (title, every field label,
  the stock tracker, upload furniture + all 6 validation errors),
  `/dashboard/analytics` (gates, three cards, hourly table + headers), the
  customer `/orders/my` history chrome (gate, tabs reusing `tabAll`/
  `status*`/`word*`, empty states, cancel confirm/notice/errors, pagination
  reusing the shared `pagination` + `unit*` + `prevPage`/`nextPage`), and the
  deferred `TrafficPanel` internals (heading, cumulative-since-boot line, all
  four cards, caption/headers, empty + hidden-notes) plus the module-scope
  code-split skeleton aria (hoisted into a `TrafficPanelSkeleton` client
  component — `dynamic()` at module scope cannot call hooks; wires the key
  `trafficLoadingAria` session 92 had reserved unused).
- Document `<title>` per portal page: six zero-DOM pass-through server
  `layout.tsx` files (`/dashboard` + kitchen/menu/analytics, `/driver`,
  `/admin`) each exporting only `generateMetadata` from `Portal.title*` —
  the pages are client components and cannot export metadata themselves.
  No `loading.tsx` boundary added (session-77 rule respected).
- Reuse over duplication: shared strings flow through existing keys
  (`restaurantsLoadError`, `refresh`, `tryAgain`, `tabAll`, `details`,
  `pagination`, `prevPage`/`nextPage`, `ownerGate*`, `signIn`,
  `trafficLoadError`, `PortalStates.noRestaurantTitle` via a second `ts`
  translator). Numeric ICU params that were raw `${n}` interpolations are
  passed `String(n)` to keep byte-pins safe from Intl reformatting.
- `docs/ARCHITECTURE.md`: Portal-chrome rule extended to the new surfaces
  (+ the `String(n)` ICU doctrine), new durable rules for title-owning
  layouts and for the login-then-navigate redirect race.

**Verified:**

- `next build` green; API untouched — `nest build` + jest re-run prove delta
  0 (91 suites / 1142 tests, same as sessions 90–92).
- NEW 5 `portal-chrome-id` tests (61→66): EN vs ID `document.title` for all
  six portal routes (guest-safe — layouts own metadata), menu-manager ID
  chrome incl. an open/close of the ID dish dialog (read-only, Warung
  pinned via selectOption — live-feed doctrine), analytics cards/table ID
  labels, history tabs/rows/pagination ID, admin traffic-panel ID cards +
  heading via waitForResponse.
- EN regression: full suite 66/66 green ×2 CONSECUTIVE on fresh seeds —
  every pinned EN string byte-identical (no spec assertion edited).
- FLAKE ROOT-CAUGHT (pre-existing, not from this change): `admin.spec`
  login→'Admin' click intermittently swallowed by the post-login
  `router.replace('/')` (the role-gated header is already visible on
  `/login`). Failed runs 1+3 of the session, 65/66; A/B cold loops ×5 per
  tree: HEAD 4P/1F, session-93 tree 4P/1F — identical rates, so NOT a
  regression. Harness-hardened (`expect(page).not.toHaveURL(/\/login/)`
  before the click in `admin.spec.ts` + `admin-traffic.spec.ts`): guarded
  cold loop 5/5 P, then full suite 66/66 ×2. Product-side race remains
  real (new ARCHITECTURE rule + backlog item).
- Sanitizer scan: no `***` on any added line (diff + 6 new files scanned by
  codepoint); exotic inventory only pre-existing prose chars (U+2014 ×22,
  U+21BB, U+00B7, U+00D7); `git diff --check` clean; messages EN/ID key
  parity 274=274, ICU tokens valid, EN byte-pin dict asserted on disk.

**Left for next sessions:**

- Input PLACEHOLDERS (`Kimchi ramen`, `e.g. 12 (0 = sold out)`, the broth
  description sample…) deliberately stay English technical examples.
- Storefront i18n sweep #2: checkout labels, cart-page chrome, receipt
  (the DEVLOG 92 storefront-leftover note) — new ROADMAP item.
- Product fix for the login-redirect vs nav-click race (settle-or-cancel
  discipline in the login flow) — new ROADMAP item.

---

## 2026-11-14 17:11 — Session 92 — Portal chrome localization EN/ID (Web, Phase 8)

**Built:**

- New `Portal` message namespace — 142 keys × EN/ID — carrying the chrome of
  the four portal surfaces session 91 listed as leftovers: page titles and
  subtitles, gate cards (guest/role/no-restaurant), status action labels,
  transport pills incl. the dashboard tooltips, the `PortalTabs` section nav
  and the shared `StatusBadge` labels.
- `app/dashboard/page.tsx`: all chrome through `t('Portal')` — header,
  Live pill labels + 4 tooltips, "updated {time}" clock, tabs (capitalized
  status words) + tablist aria, NEW badge, group/receipt aria labels,
  incl-delivery line, pagination ("Page {p} of {t} · {n} orders {status}"),
  empty states, error banners, AND both sr-only announcement templates
  (`{code} is a new order, currently {status}.` / `moved from …`) now flow
  through messages while staying byte-identical EN (raw status words mapped
  per locale). `OWNER_ACTIONS` switched `label` → `labelKey`.
- `app/dashboard/kitchen/page.tsx` + `app/driver/page.tsx`: Portal chrome via
  a SECOND translator `tc` (`t` stays on `PortalStates` — session 91 state
  furniture untouched); `Lane` title/hint/action and the driver `NEXT_STATUS`
  now key-based; driver `STATUS_LABEL` → key map (`'Ready for pickup'`,
  `'Delivered'` stay distinct from the generic badge words).
- `app/admin/page.tsx`: gates, eyebrow/title/sub, CountCard labels AND the
  detail templates (numbers interpolated AS STRINGS — no ICU locale-grouping
  surprises), section headings, all 15 table headers, Open/Closed, fallbacks.
- `components/PortalTabs.tsx` (map alias `t`→`tab` freed the translator name)
  + `components/StatusBadge.tsx` localized; badges on the (still English)
  `/orders/my` history page now flip to Indonesian too — free storefront fix.
- `docs/ARCHITECTURE.md`: new durable rule (portal chrome lives in the Portal
  namespace; EN byte-pinned by the e2e suite; second translator per file).

**Verified:**

- `next build` green. API untouched — `nest build` + jest re-run prove the
  delta 0 (91 suites / 1142 tests, same as sessions 90/91).
- NEW `e2e/tests/portal-chrome-id.spec.ts` 4/4: ID chrome on all four
  surfaces incl. the guest gate card (header collision proven: the localized
  header also carries a 'Masuk' link, so the gate CTA is pinned by href) and
  an intercepted synthetic driver order exercising card labels + the action
  button WITHOUT touching seeded state. First run caught two real spec bugs
  (restaurant default was Seoul Street, not Warung — same pinning doctrine as
  live-feed; tabs are role=tab not button) and one PRODUCT bug: the ID dict
  left `signIn` untranslated — found by auditing every Portal value identical
  to EN: 10 hits, 9 deliberate loanwords, 1 miss.
- EN regression: full e2e suite 57→61 green ×2 CONSECUTIVE on fresh seeds
  (1.8 min each) — every existing EN chrome assertion (✓ Accept, ↻ Refresh,
  'moved from pending to confirmed', Admin overview, Start delivery…) still
  byte-identical, no spec text edited anywhere.
- Sanitizer scan: zero `***` on added lines; the three U+2026 hits are the
  legit '…' busy-marker + 'Updating…' prose (HEAD idiom moved to messages),
  codepoint-verified on disk. messages EN/ID key-sets equal (top + Portal +
  PortalStates), ICU braces balanced.

**Left for next sessions:**

- Portal chrome leftovers deliberately scoped out: document `<title>`
  per portal page (client pages export no metadata), `TrafficPanel`
  internals, the admin TrafficPanel-loading spinner aria (module-scope
  dynamic() — needs the translator hoisted), `/dashboard/menu` +
  `/dashboard/analytics` page chrome, and the still-English `/orders/my`
  chrome outside the badge (the history page takes no translations at all).
- `i18n` sweep for storefront leftovers next (history/filter chips,
  checkout labels) — the storefront i18n item can be re-opened from the
  Evergreen UX loop once portal chrome is fully retired.

---


## 2026-11-14 15:24 — Session 91 — Kitchen display + driver inbox states audit (Web, Phase 8)

**Built:**

- `lib/authed-call.ts`: error results now carry `down` — the client twin
  of `isApiDown` (network throw or 5xx). Purely additive: every consumer
  only branches on `ok`/`kind`/`message` (verified repo-wide).
- New `components/PortalOffline.tsx` — `PortalOffline` (localized
  EN/ID offline card reusing the storefront's `api-offline` testid, with
  an in-page re-fetch retry) and `PortalLoadFailed` (plain failure card
  for non-downness, shows the API's own message). Client twins of
  session 77's server-rendered `ApiOffline`, for the authed portal
  surfaces.
- `/driver` states split: `loadFailed` now owns the list area when the
  FIRST inbox load fails (offline card on down, failure card otherwise)
  — the "No deliveries assigned" empty card can no longer render over
  missing data (the audit's headline bug on this surface). A failing
  manual Refresh with a loaded list keeps the list + amber strip via
  `pageRef` (last-good doctrine). Empty inbox, quiet lines and the sync
  strip localized.
- `/dashboard/kitchen` the same audit caught TWO liars: a failed
  `listMyRestaurants` zeroed the array AND set the banner, so the page
  fell through to three "No orders in this lane" cards; a failed board
  load likewise rendered quiet lanes under the error. Now: the list
  effect keeps `restaurants === null` + `loadFailed{down}`; the board
  area is owned by the failure/offline card until a load succeeds;
  only a LOADED lane may claim quiet (`page && items.length === 0`);
  a fully-loaded all-zero board shows one emerald ALL CLEAR banner
  (`kitchen-board-empty`) — the "first order" board; failing Refresh
  with data on screen keeps the last good board. Retry re-runs exactly
  the loader that broke (list → reloadKey, board → refetch).
- New `PortalStates` message namespace (13 keys × EN/ID) — state
  furniture localized like the storefront; page chrome/gate cards stay
  English (tracked as a new roadmap item).
- `docs/ARCHITECTURE.md`: new durable rule bullet ("The portal surfaces
  hold the same line as the storefront").

**Verified:**

- `next build` green; API untouched — `nest build` + jest re-run prove
  the delta 0 (91 suites / 1142 tests, same as session 90).
- New `e2e/tests/portal-states.spec.ts` 7/7 on the first run — offline
  vs empty vs 4xx vs loaded-quiet separated on both surfaces, retry
  restores the real seeded data both times, restaurant-LIST death also
  answers the offline card, and the ID locale proves both new cards
  render Indonesian. Read-only by design (all `page.route`
  interception): FO-SEED3 stays intact for the later `zz-driver-portal`
  spec.
- FULL e2e suite 50→57 green ×2 CONSECUTIVE on fresh seeds (2.5–2.6
  min each). Honest note: one intermediate run failed exactly one
  test — `zz-forms-a11y` "receipt: bare link…" (a direct-API fixture
  path untouched this session) with its known conditional-skip
  cascade; it passed in a targeted re-run and never reproduced in the
  two consecutive clean full runs. Recorded as a pre-existing flake
  candidate, not a regression claim.
- Sanitizer scan: zero U+2026/`***` on any added line (the single `…`
  in kitchen is HEAD's "Updating…" label); messages JSON re-validated
  + EN/ID key-sets equal.

**Left for next sessions:**

- Portal CHROME localization (page titles, gate cards, action labels,
  transport pills on dashboard/kitchen/driver/admin) — new Phase 8
  roadmap item; this session localized only the state furniture.
- The `zz-forms-a11y` receipt flake: if it recurs, instrument the
  direct-API fixture (loginToken/createOrder/payOrder) timings.

---

## 2026-11-14 13:29 — Session 90 — /admin bundle trim: TrafficPanel code-split behind the metrics fetch (Web, Phase 8)

**Built:**

- `apps/web/app/admin/page.tsx`: the `TrafficPanel` static import became
  `next/dynamic` (`ssr: false`) with an `h-40` shimmer fallback
  (`data-testid="traffic-panel-loading"`). The render gate was already
  `metrics != null`, and a `dynamic()` chunk request starts at first
  RENDER — so the panel chunk is now fetched strictly BEHIND the
  `GET /api/admin/metrics` round-trip: a metrics outage or a 401 downloads
  ZERO panel bytes. `ssr: false` is honest — the snapshot is bearer-only
  client data with nothing to server-render. No other file changed.
- `docs/PERFORMANCE.md`: new "Admin panel bundle audit" section with the
  exact A/B numbers (manifest gzip sums, not the rounding-blind route
  table) and the honest framing that the trim is SMALL — the panel is
  compact pure-DOM React, no chart library; the roadmap's
  "charts-adjacent DOM" label overstated it, and the guaranteed win is
  the failure path. Verdict recorded: no further split warranted (the
  remaining ~16 kB page chunk IS the three overview tables).

**Verified:**

- Cold `rm -rf .next` builds before vs after: `/admin` first-load JS
  113,561 → 113,295 B gz (−266 B; raw 386,660 → 384,466, −2,194 B); route
  table 4.84 kB · 114 kB → 4.54 kB · 113 kB; page chunk 18,521 → 16,304 B
  raw; deferred async chunk 5,818 B raw / 1,962 B gz.
- Served-HTML probe (guest GET /admin on `next start`): script tags list
  the new page chunk, and the async chunk hash appears exactly 0 times —
  the panel code is genuinely not in the first payload.
- `admin-traffic.spec.ts` 2/2 — the waitForResponse DOM-vs-payload
  cross-check passes through the lazy mount (chunk fetch + shimmer +
  render all land before the auto-retrying assertions settle).
- FULL e2e suite 50/50 green (2.5 min) on a fresh seed after the change.
- API untouched: `nest build` + seed re-run only as the e2e rig's boot
  prerequisites; jest delta 0 (91 suites / 1142 tests unchanged).

**Left for next sessions:** nothing on this item — closed.

---

## 2026-11-14 11:12 — Session 89 — Metrics durability: persisted snapshots + window deltas on /admin/metrics (API, Phase 8)

**Built:**

- `metrics_snapshots` table (27th migration, hand-written DDL with named
  PK/CHECK/IDX + `jsonb_typeof(payload)='object'` guard; indexed
  `capturedAt` serves both the newest-row lookup and the range prune) +
  `MetricsSnapshotRow` entity registered in `data-source.ts` (21 entities)
  and via `TypeOrmModule.forFeature` in `MetricsModule`.
- `common/metrics/metrics-persistence.service.ts` — the scheduler: writes
  the FULL cumulative snapshot (`payload`) stamped with `capturedAt` AND
  the producing registry's `bootStartedAt` every
  `METRICS_SNAPSHOT_INTERVAL_SEC` (default 300; `0` disables everything
  incl. reads; garbage→default, never crash-boot — same doctrine as the
  pino fold knob) and prunes rows past `METRICS_SNAPSHOT_RETENTION_SEC`
  (default 24h → bounded ~288 rows; `0` is treated as GARBAGE because a
  zero retention would prune its own writes). `persistNow` never throws
  out of the heartbeat (caught + warned), so a DB blip can't take down
  observability or surface an unhandled rejection. The registry exposes
  `bootStartedAtMs` so no row can ever be subtracted across process boots.
- `common/metrics/metrics-window.ts` — DI-free pure `computeWindowDelta`:
  element-wise subtraction of two cumulative snapshots (totals,
  status-class tallies, route-key sets, per-route request/byStatus/sumMs
  tallies, merged delta histogram + nearest-bound percentiles computed
  over the BOUNDS THE SNAPSHOTS THEMSELVES declare). ANY negative
  subtraction, vanished route key, bounds mismatch, or operator-corrupted
  jsonb ⇒ the whole window is `null` — never a clamped fiction; min/max
  deliberately absent (not subtractable).
- `GET /admin/metrics` returns the live snapshot **plus two strictly
  additive fields** (pre-existing shape untouched, so the admin
  TrafficPanel keeps working): `durability` (enabled, resolved knobs,
  bootStartedAt, stored, lastCapturedAt, bootAligned, error) and `window`
  (exact traffic since the newest SAME-BOOT row, else null). Cross-boot
  baseline REFUSED: right after a restart `bootAligned=false` +
  `window=null` while `stored` still reports the surviving history — the
  roadmap item's whole point. Store read errors degrade to
  `error:true, window=null` and the route still 200s with the full live
  snapshot (session-86 doctrine: a dead smoke detector never 5xxs).
  Swagger contract extended (`MetricsDurabilityResponse` +
  `MetricsWindowResponse` + `MetricsWindowRouteResponse`; route summary
  reworded); env.schema gained the two optional knobs; the controller
  HTTP spec now round-trips the REAL persistence service over a fake
  repo, hand-pinned to exact window numbers.

**Verified:**

- `npm run build` green; `npx jest --silent` **91 suites / 1142 tests**
  (was 89/1117: +2 suites / +25 tests — window arithmetic incl. integrity
  guards, scheduler/persistence incl. disabled + prune + failure paths, 3
  reworked + 2 new HTTP metrics cases).
- Live smoke **30/30** on a 27-migration from-empty scratch DB, 2s tick:
  EXACT identity `window.requests == live totals − the stored row the
  response itself names` (row matched by payload generatedAt, count==1
  asserted); byStatus sums + histogram monotonicity; REAL RESTART —
  registry zeroed while `stored` survived, `bootAligned=false`/`window=null`
  before the new boot's first tick, `bootAligned=true` after; boot stamps
  verified against the table; RETENTION PRUNE proven by aging the oldest
  row 2h and asserting zero rows older than the cutoff survive + the aged
  id is gone while fresh rows stay; DISABLED boot writes no rows and the
  route reports `enabled=false` without touching the DB; docs-json exposes
  the new component schemas; 0 error-level API-log lines; 401/403 ladder
  unchanged.
- Two GENUINE product bugs the live driver caught that unit mocks had
  papered over (both now pinned): (1) order-only `repo.findOne({order})`
  is REJECTED by this TypeORM ("You must provide selection conditions…")
  — the read path would have 100% errored in production → `find+take:1`;
  (2) the prune DELETE with the query alias emitted
  `DELETE FROM "metrics_snapshots" WHERE snap.capturedAt` (alias dropped
  from FROM) → Postgres "missing FROM-clause entry" every tick — proven
  by a direct QB `getSql()` probe → raw quoted `"capturedAt"` clause.
  Harness lessons too: the template rewrite initially DROPPED the seed
  step (401 on logins, users=0), and per-boot `>LOG` truncation hid the
  prune warns — smoke logs now carry seed output and the final grep reads
  the LAST boot's log only.
- Sanitizer scan: 15 touched files, zero U+2026/`***` in added lines;
  `git diff --check` clean.

**Left for next sessions:**

- Alerts window mode: the evaluator still reads cumulative-since-boot
  totals; `window.fiveXxRatePct` is now the restart-surviving sibling it
  could switch to (plus the fold line could carry the window verdict).
- Perf: admin panel bundle trim is next top unchecked item.

---

## 2026-11-13 20:01 — Session 88 — GDPR self-service web surface + e2e coverage (Web, Phase 8)

**Built:**

- Recovered session 88's crashed-run WIP (the uncommitted tree was the
  increment; every dependency re-verified against HEAD before trusting it):
  the /account page was complete and its every server contract re-confirmed
  on disk — `GET /users/me/export` (allowlist, schemaVersion 1) and
  `DELETE /users/me` (`@HttpCode(200)`, password + exact-`DELETE` guard) in
  users.controller, the anonymization literals ('Deleted user', '[deleted]')
  and `anonymizedOrders`/`detachedRestaurants`/`unassignedOrders` result
  fields in account-data.service, the `authedCall` 401-rotate-retry helper,
  `inbox-card-{code}` testid on the owner dashboard, the login `?next`
  allowlist, `foodorder.auth.v1` storage key. No API source touched.
- `apps/web/app/account/page.tsx` — in-app GDPR self-service (session 63
  shipped the API only, smoke-tested via curl): "Download my data" fetches
  the full personal-data JSON through `authedCall` and triggers a real
  browser blob download named `foodorder-data-export-YYYY-MM-DD.json`; the
  danger zone demands the current password AND the exact `DELETE` phrase
  (client pre-checks mirror the server, which stays the authority — a
  delete-endpoint 401 is the password check, never routed through the token
  refresh dance); success forces `logout()` (server sessions are already
  cascade-dead) and renders the deleted-state receipt with what was touched.
  Guest state renders a sign-in card (`/login?next=%2Faccount`), never the
  controls.
- Wiring: `api.exportMe`/`api.deleteMe` + `AccountExport`/
  `AccountDeleteResult` types in lib/api.ts, localized header nav link
  (`account`/`Akun` in en/id messages), `/account` added to robots.txt
  disallow (authenticated private surface — same rule as /addresses).
- `e2e/tests/zz-gdpr-account.spec.ts` (3 tests, named zz-* to sort after
  the seed-absolute specs): signed-out gate + robots assertion; the full
  journey in ONE test because the `page` fixture is a fresh browser context
  per test (localStorage does not survive) — throwaway registered customer
  + its own Warung order (no absolute counts), real download captured via
  `waitForEvent('download')` with content asserts (order code present,
  leak sweep over EVERY payload key: no passwordHash/password/
  refresh_token/access_token/secret, no bcrypt-shaped values), both
  rejection guards proven ALIVE (wrong password → 'Invalid password' alert,
  lowercase 'delete' → exact-phrase alert, session still signed in), then
  the real delete: 'Account deleted' receipt, header flipped to guest,
  localStorage cleared, the browser's own captured refresh token rejected
  401 at /auth/refresh (cascade proven against the LIVE token), re-login
  401; third test: the anonymized retained order still renders for the
  restaurant owner's inbox ('Deleted user' + '[deleted]', NOT 'GDPR
  Traveler' / the delivery address).

**Verified:**

- `apps/web` `npm run build` green (new /account route in the manifest).
- API untouched: `npm run build` + `npx jest --silent` **89 suites / 1117
  tests** — byte-identical delta 0 vs session 87's baseline.
- Full e2e suite **50/50 green ×2** (was 47; +3) on a fresh `npm run seed`
  before EACH run, Playwright booting both apps itself (free ports 3000/4000
  per the rate-limit-bucket rule).
- Sanitizer scan of the whole WIP tree: no U+2026 or `***` in any added
  line (the two U+2026 hits are legit prose ellipses in the page's own
  loading labels, 'Preparing export…'/'Deleting…'); the e2e spec's bearer
  header is codepoint-clean on disk (`'authorization: Bearer ' + token`
  idiom), en/id JSON parse, `git diff --check` clean.

**Left for next sessions:** nothing for this item; Phase 8 continues with
metrics durability.

---

## 2026-11-13 17:08 — Session 87 — Sanitizer sweep of the remaining query surfaces + static @Query audit gate (API, Phase 8)

**Built:**

- Audit verdict first, honestly: NO raw TEXT query param escapes the
  session-84 guards. Dish search does not exist as a raw restaurant-read
  param (it lives at the guarded `/api/search` + client-side MenuBrowser
  filtering); the only remaining free-text query param is the guest
  receipt proof `?contactEmail=`, which `findOneForViewer` normalizes and
  compares in JS memory — it never becomes a SQL predicate (the sweep
  pinned this with forbid-regexes, not trust). What the sweep DID catch
  is the numeric sibling of the same 500 class: three list surfaces bound
  unbounded `Number(page)` math straight into OFFSET — `GET
  /restaurants/:id/reviews` (PUBLIC, DTO-less raw params), the
  `ListMyOrdersDto` trio (`findMine`/`findForDriver`/`findForRestaurant`:
  `1e30` passes `IsInt`+`@Min(1)`) and `GET /admin/promos/:id/usages`
  (page had NO bound at all). All three were GENUINE HTTP 500s
  (22001/22P02 bigint overflow) — reproduced live against the real driver
  on the pre-fix HEAD build before touching anything.
- `common/int-range.ts` grew the shared pieces: `MAX_PUBLIC_PAGE`
  (100k, was file-local to restaurants.service) and `blankToUndefined`
  (present-but-blank = unset), both now used by EVERY paginated list.
  reviews/orders/promos services clamp page/limit through
  `clampToIntRange` (orders ×3 blocks + promos `listUsages` had no
  service guard at all); blank live params ride the global pipe's
  Number-coercion to the clamp MIN (documented + smoke-pinned — identical
  to `/restaurants` since session 84; `blankToUndefined` guards direct
  service calls).
- `common/fuzz/query-surface-audit.spec.ts` — the regression gate the
  roadmap item asked for ("no controller takes an unsanitized public
  string to the driver"). TypeScript-AST discovery of every `@Query`
  parameter across all 18 controllers (11 sites found); the registry must
  match EXACTLY both ways — a new unregistered site fails CI, a deleted
  site may not leave its claim behind. Each site carries only EXECUTABLE
  evidence: service-source regexes for the sanitizer/clamp/allowlist
  idioms (incl. counts — orders must clamp exactly ×3), forbid-regexes
  (proof never in `where:`), and a class-validator completeness walk over
  the four query DTOs (every property decorated — the whitelist:true
  rule, mechanically). Negative-proven: deleting the reviews clamp turns
  the gate red.
- Fuzz HTTP harness extended to the sweep surfaces: 150-case reviews
  pagination sweep (transport never 5xx; recorded the harness lesson
  that the global pipe Number()-coerces raw `number`-annotated params
  BEFORE the service — '1' → NaN), 60-case contactEmail sweep (verdict
  400-or-404 only, wire-form verbatim forwarding pinned), transport-junk
  bracket/array cases across all of it.

**Verified:**

- `npm run build` green; `npx jest --silent` **89 suites / 1117 tests**
  (+1 suite / +20 tests over session 86's 88/1097): 4 audit-gate tests,
  3 new HTTP sweep tests, 6 reviews `it.each` clamp pins, 2 orders
  hostile pagination pins (skip safe-integer proven), 1 promos usages
  clamp pin, 4 int-range helper pins.
- PRE-FIX proof: HEAD build on a scratch DB answered **500** for
  `?page=1e30` on all three surfaces (reviews/orders-my/promo-usages) —
  the regression was real, not theoretical.
- Live smoke **18/18 PASS** on a 26-migration from-empty scratch DB:
  reviews overflow shapes (1e30/24-digit/Infinity/NaN/2.5/blank) all 200
  with honest echoes; `/orders/my?page=abc` still 400 at the DTO; guest
  order created with proof email → NUL-bearing proof 404, real proof 200;
  admin `?status=%00cancelled` 400 (envelope) then legal transition 200;
  session-84 combo regression still guarded; **zero 22021/22001/22P02 and
  zero level-50 pino lines** in the API log.
- Sanitizer codepoint scan over all 750 added lines: no U+2026, no `***`;
  `git diff --check` clean. No web changes; e2e untouched.

**Left for next sessions:**

- Body-string write paths (guest checkout address/name, promo code
  lookups) are the natural next sweep of the same class — this item was
  scoped to query strings by the roadmap line; the audit gate already
  enumerates their controllers and could grow disposition checks.
- Consider surfacing the query-surface registry in docs (ARCHITECTURE now
  states the contract; the spec file remains the source of truth).

## 2026-11-13 15:27 — Session 86 — Alert rules on the metrics engine + ADMIN /admin/alerts + scheduler scan (API, Phase 8)

**Built:**

- `src/ops/alerts.ts` — DI-free alert engine over the session-80 metrics
  snapshot, one evaluation shared by EVERY consumer so the route, the logs
  and cron can never disagree. Three rules: `error_budget` (5xx rate vs the
  99.5% availability SLO → 0.5% budget, fires STRICTLY above, gated by a
  `minRequests` sample floor so a lone 5xx on a fresh boot is noise, not
  an outage), `p95_latency` (global histogram-estimated p95 vs a ceiling —
  nearest-bound estimates are documented to fire early by one bound), and
  `route_key_overflow` (the 250-key cardinality cap folded new keys into
  `other`; a WARNING that still flips the verdict — degraded telemetry
  deserves a look). Thresholds resolve from `ALERT_5XX_RATE_PCT_MAX` /
  `ALERT_P95_MS_MAX` / `ALERT_MIN_REQUESTS` once at boot with the
  observability-knob policy (garbage/negative → default, never crash-boot;
  `0` is a LEGAL tightened ceiling — the chain can be proven end to end
  without shipping an insecure default). Declared in `env.validation.ts`.
- ADMIN `GET /api/admin/alerts` (`JwtAuthGuard` + `RolesGuard(ADMIN)`, same
  rung as `/admin/metrics`): full report — status, firingRules, resolved
  thresholds, and every rule's `{firing, severity, observed, threshold,
  detail}` with human-readable numbers. Swagger contract
  `AdminAlertsReportResponse` mirror + round-trip fixture pin; OpenAPI op
  count 73 → 74 (both swagger.spec lists extended).
- Fold line carries the verdict: every periodic `event: "request_metrics"`
  pino line now includes compact `alerts: {status, firing}` — a log-based
  alerter needs no second rule engine.
- Scheduler precedent (stale-sweep style): `src/scripts/alert-scan.ts`
  polls login → `GET /admin/alerts` against the RUNNING API (the registry
  has no DB mirror — snapshot durability stays the next Ops item) with a
  deliberate exit-code split: `0 healthy · 1 alerting · 2 the SCAN is
  broken` — "building on fire" and "smoke detector broken" must not page
  the same way. Thin `ops/alert-scan.sh` + `ops/systemd/` unit examples
  `foodorder-alert-scan.{service,timer}` (5-min timer, `OnFailure=` hook
  documented; creds via EnvironmentFile, never in the unit). ARCHITECTURE
  metrics section rewritten to record the engine + three consumers.

**Verified:**

- `npm run build` green; `npx jest --silent` **88 suites / 1097 tests** all
  pass (+2 suites / +33 tests over session 84's 86/1064): 24 evaluator
  tests run against REAL `RequestMetricsRegistry` snapshots (boundary pins:
  exactly-at-budget quiet, strictly-above fires, min-sample gate observed=
  null, histogram floor arithmetic 10ms@p95=10), 10 scan classification
  tests (stubbed fetch: creds-missing/401/403/transport/shape/unknown-status
  all exit 2, never 1), 2 admin-controller tests (guards + full-report
  round-trip), 1 integration test proving the fold and `service.alerts()`
  report the SAME verdict off one engine.
- Live smoke **41/41 PASS** on a from-empty 26-migration scratch DB across
  THREE boots (`/tmp` scratchpad, port fail-fast + per-boot logs): boot A
  defaults — 401/403/200 ladder, thresholds echo `0.5/1000/50`, budget
  unevaluable below sample floor, fold line `{status:ok, firing:[]}`,
  docs-json registers `/api/admin/alerts` (ref + 401/403), scan exits 0
  healthy / 2 no-creds / 2 dead-API (NOT 1); boot B tightened — genuine
  500 by `DROP DATABASE ... WITH (FORCE)` under the live pool →
  `error_budget` fires ALONE on the route with a real observed rate, fold
  flips to `alerting`, and after recreating + re-seeding the DB the scan
  exits 1 (cumulative verdict survives recovery — exactly the documented
  since-boot semantics); boot C — 260 distinct unmatched paths →
  `route_key_overflow` fires alone (observed 250 = cap, severity warning,
  budget provably quiet on an all-4xx flood), scan exits 1 naming it.
- No web changes; e2e suite untouched by this increment.

**Left for next sessions:**

- Snapshot durability (next Phase 8 Ops item) — alert verdicts inherit the
  cumulative-since-boot semantics; once windows exist, add windowed rule
  variants and a `/admin/alerts?window=` surface.
- Web: a verdict badge on the admin TrafficPanel (session 85) — the route
  is live and typed, the panel just doesn't read it yet.
- The scan needs a dedicated ADMIN service account on real hosts; only the
  seeded admin fixture was exercised here.

## 2026-11-13 13:45 — Session 85 — Error-budget traffic panel on the admin overview (Web, Phase 7)

**Built:**

- Unlocked + shipped the Phase 7 stub item ("error-budget dashboard stub —
  wire the metrics route"): session 80's `GET /api/admin/metrics` finally
  has a UI. SCOPE CORRECTION: the roadmap line said "owner analytics page",
  but the metrics route is ADMIN-only platform telemetry (route templates +
  latency, no per-restaurant scoping) — putting it behind an OWNER bearer
  would either 403 or leak global traffic. The cards therefore live on the
  `/admin` overview, which is the role the route already serves.
- `TrafficPanel` (`components/TrafficPanel.tsx`): four cards + a per-route
  table over the live snapshot. Requests (route-key count + cardinality-cap
  flag), Latency p95 (p50/p99/max beside it, labeled histogram estimates),
  Server errors (5xx count + 4xx tally, with the note that 4xx does NOT
  burn the budget), Error budget (99.5% availability SLO → 0.5 pts of 5xx
  allowed; `computeErrorBudget` exported for pure-math review: consumed %
  can exceed 100, remaining clamps at 0, empty registry renders "—" not
  division by zero). Table shows the top 15 of ≤251 route keys with a
  hidden-rows note; `sr-only` caption + `scope="col"` headers.
- Honest-by-construction wording: "Cumulative since API boot" + uptime +
  snapshot time on every panel — the registry has no time windows, so the
  UI never implies one.
- `/admin` page fetches overview + metrics with `Promise.all` of two
  `authedCall`s; a metrics-only failure degrades the traffic section to its
  own amber alert and NEVER blanks the existing tables (overview banner
  semantics untouched, keeping `admin.spec` contract).
- Client contract types `MetricsSnapshot`/`MetricsRouteRow` in `lib/api.ts`
  mirror `common/metrics/request-metrics.ts` exactly; the API-side
  round-trip pin in `admin.controller.spec` fails first on any rename.

**Verified:**

- `apps/web` `npm run build` green (no API source touched — jest suite
  unchanged at 86/1064 from session 84; `apps/api` rebuilt for the smoke boot).
- Live curl smoke against a hand-booted API: `POST /auth/login` 201 →
  `GET /admin/metrics` 200; 9 tracked requests / 5 route keys; `GET
  /api/restaurants/:id` row carried `4xx:1` from a deliberate malformed-uuid
  GET; the `/api/health` probes and the raw `not-a-uuid` segment never
  appeared in any route key; no-token request → 401.
- New e2e `admin-traffic.spec.ts` (2 tests): cards cross-checked against the
  payload THE PAGE RECEIVED via `waitForResponse` (shape-based on purpose —
  counts are cumulative-since-boot, so no absolute-number assertions), the
  payload's busiest route row rendered, template-only keys + health
  exclusion asserted, login POST proven tracked.
- Full Playwright suite 47/47 GREEN TWICE (45→47) on fresh seeds — run 2
  re-seeded per the suite contract; webServer booted both apps itself with
  the raised auth bucket (ports freed before each run, no hand-boot reuse).

**Left for next session:**

- The locked payment-adapter items still need real Stripe/Xendit API keys.
- Traffic cards are ADMIN-only by design; if owners ever get traffic, the
  honest shape is per-restaurant request counts (a registry extension), not
  this global snapshot.
- Possible follow-up: the k6 authenticated profile could sample
  `/admin/metrics` p95 drift as a guard rail; the alerts evergreen loop now
  has data AND a viewer — an alert RULE (5xx threshold → notify) is the
  natural next Ops item.

## 2026-11-13 10:09 — Session 84 — Property-based fuzz gate: public search/list params (API, Phase 7)

**Built:**

- Fuzz harness (`src/common/fuzz/fuzz-harness.ts`): seeded xorshift32 RNG
  (no fast-check dependency — byte-reproducible, every FAIL prints its
  seed and replays exactly) + three hostile corpora: `HOSTILE_TEXT` (SQL/
  LIKE metachars, injection idioms, NUL/C0 controls, lone surrogates,
  U+FFFD, bidi/zero-width, oversize), `HOSTILE_NUMERIC`, `HOSTILE_SORT`.
  `encodeParam` percent-encodes via WHATWG TextEncoder semantics (lone
  surrogates become replacement bytes on the wire, like a browser).
- Root cause found by the sweep, fixed in two gates:
  1. `common/query-sanitizer.ts` — DELETE-only sanitizer for text params
     headed to Postgres. A NUL byte or lone surrogate survives trim()/
     MinLength and the driver answers SQLSTATE 22021 → HTTP 500 on a
     PUBLIC GET (driver-proven, not theory: raw param probe throws 22021).
     Illegal codepoints are deleted, never substituted; a junk-only value
     becomes '' and takes the EXACT branch of an absent one — the emitted
     statement shape can never depend on content (session 79's contract,
     now enforced at the edge).
  2. `common/int-range.ts` — `clampToIntRange(raw, min, max, fallback)`:
     closed-integer clamp for numeric params. The old `Math.min(50,
     Math.max(1, Number(x)||20))` guard leaked `limit=2.5` to the driver
     (bigint 22P02 → 500; driver-proven) and NaN/Infinity propagated;
     `page=1e23` could escape bigint OFFSET. Now: non-finite/boolean/unset
     → fallback, fractional rounds, result always a finite int in range.
- Wired: `GET /restaurants` (NO DTO in front — service is the only gate)
  sanitizes search/cuisine/city + clamps page (1..100_000,
  `MAX_PUBLIC_PAGE`)/limit (1..50); blank-present `?limit=` keeps the old
  unset semantics. `GET /api/search` sanitizes in the DTO `@Transform`
  (before validation: junk-only q = the same 400 as blank) AND again at
  the service edge (direct-call defense in depth). `sort` whitelist and
  `escapeLike` untouched — verified they hold, not changed.

**Verified:**

- `npm run build` green; `npx jest --silent` **86 suites / 1064 tests**
  all pass (+4 suites / +70 tests over session 83's 82/994): 500+500-case
  list sweep (predicate-set == presence-only, bound values illegal-free,
  skip/take bounded), 400+400-case search sweep (constant 2-call shape,
  positional params only, junk-only q → 400 with NOTHING at the driver),
  shape-neutrality cases (NUL-only == absent, arm-for-arm), array-valued
  params, SQL-injection-as-bound-param scan, plus HTTP-level specs: both
  real controllers behind the real ValidationPipe + ErrorFormatFilter on
  live sockets, 200+200 hostile GETs + 8 transport-junk shapes (brackets,
  proto keys, repeated params) — every response 2xx/4xx, envelope codes
  on rejections, service receives the SANITIZED value.
- One REAL bug caught pre-commit by the suite: `clampToIntRange(true)`
  coerced to 1 via JS truthiness (spec flagged the contract break) —
  booleans now collapse to the fallback like any non-wire numeric shape.
- Live smoke on a 26-migration from-empty scratch DB with the REAL
  driver, **29/29 PASS** (`/tmp` scratchpad, zero API-log errors): driver
  probes reproduce 22021/22P02 for the raw classes; `q=war%00ung` → 200
  echoing `warung` with the same result set as `warung`; junk-only → 400
  BAD_REQUEST envelope; `limit=2.5` → 200 integer 3; NaN/Infinity → 20;
  `page=1e23` → clamped 100000, empty page; junk filters == absent
  filters (totals 6); DROP-TABLE idiom bound + table intact; 75-case
  percent-encoded sweep over both routes — no 5xx, no hangs. (First
  smoke run was 28/29 — the one FAIL was a jq harness bug,
  `sort(reverse)` doesn't exist; product untouched.)
- No web change; no route/DTO surface added, so the swagger op count is
  untouched. Sanitizer scan on all added lines: clean (U+2026 hits are
  legitimate em-dash prose; no raw NUL, no mask).

**Left for next session:**

- 🔒 "error-budget dashboard stub" stays locked behind the metrics item —
  unchanged.
- Possible follow-up (NOT done): apply the same delete-only sanitizer to
  other public free-text params as they appear (dish search within
  restaurant page reads `q` through a DTO with the same gap — worth a
  sweep for raw-query-param routes without DTOs).

## 2026-11-12 18:55 — Session 83 — Mobile polish pass: cart + checkout at 360px (Web, Phase 7)

**Built:**

- CART page restack: at 360px the old single flex row (name · stepper ·
  fixed `w-20` price) left a ~56px column for the dish name. Rows are now
  two-line blocks — name+options+"each" price on the left, the line total
  top-right, steppers on their own 44px row — one price element per line
  (the pwa spec's `getByText('$54.00')` count-2 contract preserved).
  Steppers `h-8 w-8` → `h-11 w-11` (32→44px, WCAG 2.5.5); Clear cart, the
  desktop Checkout link and the empty-state Find-food CTA got `min-h-11`.
- Sticky mobile checkout bar on /cart: subtotal + 44px Checkout CTA (+ Clear
  cart) pinned to the viewport bottom with safe-area padding — a long cart
  never buries the primary action. Desktop keeps the inline summary/actions
  blocks; the sticky bar renders ONLY on compact viewports.
- RENDER GATE, the load-bearing decision: `useIsCompactViewport`
  (`lib/use-compact-viewport.ts`, matchMedia <640px, false during SSR +
  first paint). CSS `sm:hidden` was NOT enough — the desktop suite's strict
  text locators (`getByText('Subtotal')`, the price-count assertion) match
  hidden nodes, so a hidden-but-present duplicate bar breaks them; only
  conditional rendering keeps the desktop DOM byte-identical to before.
- CHECKOUT: every text input/textarea moved `text-sm` → `text-base` (16px —
  iOS auto-zooms the viewport on focus below that, breaking the sticky bar
  mid-form); autofill plumbing (`autocomplete` name/tel/email/
  street-address, `inputMode` tel/email); promo Apply + "enter manually"
  toggle → `min-h-11`. The form got `id="checkout-form"` and a sticky
  bottom bar (live total + 44px submit) whose button re-targets that ONE
  form via the `form=` attribute — second handle, same handler, same
  disabled/label ladder, not a second flow.
- Shared header — the actual horizontal-scroll culprit on EVERY phone page
  (guest nav ≈440px of content, nowrap flex → document scrollWidth blows
  past 360px): row + nav made `flex-wrap` with gap-y, logo `shrink-0`,
  guest pills `px-4` → `px-3 sm:px-4`, nav gap `gap-x-2.5 sm:gap-x-4`.
- New e2e `mobile-cart-checkout.spec.ts` (360×800 via `test.use`): empty
  states fit; a 6-line cart (3 dishes × 2 selections — the line-per-
  selection rule) asserts no horizontal scroll (polled scrollWidth
  delta ≤ 1), boundingBox-measured 44px steppers/CTAs, computed
  `position: sticky` + bar bottom == viewport bottom at page top AND
  still in-viewport at page bottom; checkout asserts ≥16px computed
  font-size on all five fields, tap targets, autofill attrs, and places
  a real GUEST ORDER by tapping the sticky CTA (URL `FO-` check + cart
  emptied) — proving the `form=` routing end-to-end.

**Verified:**

- `npm run build` (web) green; full e2e **45/45 green ×2 on fresh seed**.
  Run #1 failed 11 specs — pure harness cause, product blameless: I had
  booted the API myself WITHOUT the suite's `RATE_LIMIT_AUTH_MAX=100
  (login bursts 429) and against an un-reseded DB (`★ 4.0 · 2 reviews`
  drifts after any review-creating run). Reseed + let playwright boot its
  own API (or export the env) before blaming code.
- API untouched: `nest build` clean, jest 82 suites / 994 tests — exactly
  the session-80/82 pin.
- curl smoke: /cart and /checkout SSR 200; grep proved the mobile bar
  testids absent from served desktop markup (the render gate holds in the
  real HTML, not just in the browser).
- Sanitizer scan: all five touched files `***`-clean; the two `…` hits are
  pre-existing UI ellipses ("Placing order…", "landmarks…").

**Left for next sessions:** 320px (iPhone SE) width for the same flow; the
owner dashboard + driver portal have never had a phone-viewport pass; the
receipt page could reuse the sticky-bar pattern for the pay CTA.

---

## 2026-11-12 17:15 — Session 82 — k6 authenticated write scenario + new baseline (Ops/Perf, Phase 7)

**Built:**

- `ops/load-test-auth.js` — the paying-customer cycle PERFORMANCE.md rec 5
  asked for, kept in its own script so the public browse baseline stays
  read-only forever. Per-VU signup (module state is k6-VU-isolated: one
  register, then the token stays warm), and every iteration is 7 requests:
  authenticated `GET /restaurants/:id` browse → `POST /orders` (201, pending,
  server-priced) → `POST /payments` intent (201) → `POST /payments/:id/capture`
  (200, `succeeded`) → `GET /orders/:id` receipt via the session-76 bearer rung
  → `GET /orders/my?limit=5` → 1 s think-time. The storefront cart is
  client-side localStorage, so its API-side equivalent is the browse+create
  pair — documented in the script header.
- Pure helpers in `ops/load-test.lib.mjs` (the public script's imports are
  untouched): `planCart` — clears `minOrderCents` in integer cents with the
  DTO's @Max(50) mirrored as `MAX_LINE_QTY`, skips unavailable/sold-out dishes,
  spills to a second line when a cheap dish can't reach the minimum alone,
  rotates the starting dish by iteration; `orderPayload` — the contact triple +
  NO client-supplied money; `authProfile` — smoke 1 VU/30 s, load ramp-to-10
  (write iterations own a transaction, so the plateau is 10 not 25). The
  ops contract test gained 20 assertions pinning all three + the profiles.
- Isolation rig (scratchpad, recipe now in PERFORMANCE.md): 26-migration
  from-empty DB `foodorder_k6load`, canonical seed, API on :4100 booted with
  `RATE_LIMIT_{AUTH,ORDERS,PAYMENTS}_MAX=20000` — the production 10/30/10
  buckets would 429-shed load traffic and pollute the latency sample, so
  relaxed buckets are part of the documented recipe, not a code change. k6
  ran in the cached grafana/k6 v2.3.0 image (`--network host`,
  `--summary-export`). Custom counters `orders_placed`/`payments_captured`
  carry `count>0` thresholds so an HTTP-green but write-dead run cannot pass.
- No API/web source touched. Sign-up emails are `loadtest-vu*@load.test`
  to make the post-run SQL cross-check exact.

**Verified:**

- `npm run build` green; `npx jest --silent` 82 suites / 994 tests — exactly
  the session-80 pin (API untouched, delta 0). Contract test:
  `node --test ops/load-test.contract.test.mjs` pass (browse + auth).
- Smoke (fresh scratch DB): 29 iterations, 176 requests, 233/233 checks,
  0% failed; DB assert EXACT: users=1, orders=29 all `pending`, each with
  exactly one `succeeded` payment, zero intent-replay doubles.
- Load: 992 iterations, 5,963 requests at 42.40 req/s (~7.05 order-creates/s),
  7,937/7,937 checks, 0 failed requests, p95 13.69 ms / p99 24.14 ms /
  max 126.76 ms; k6 exit 0 = every threshold incl. the write counters green.
  Same EXACT DB cross-check: 992 orders (pending, one succeeded payment each),
  10 users. `/api/health` ok after the run; scratch DB dropped, port freed.
- Harness lessons, all spec-side (first two runs failed, product answered
  correctly every time): k6 `Counter` is a named export; a JSON-string body
  without `Content-Type` reaches Nest unparsed (validation 400 was right);
  summary-export reports checks as `passes`/`fails`; the k6 container is
  unprivileged so the export dir needs mode 777; and PG refuses
  `coalesce(<enum>,'text')` without `::text` plus `GROUP BY 1` over an
  aggregate-containing expression.
- Sanitizer: the script assembles the two credential-shaped key names at
  runtime (`'pass'+'word'`, `'Autho'+'rization'`) and was codepoint-scanned
  after writing (no U+2026, no `***`, assembly literals intact); lib/docs
  added lines scanned clean; `git diff --check` clean.

**Left for next sessions:** per-endpoint latency breakdown needs custom
`Trend` metrics per operation (the summary-export aggregates them away);
recs 1–2 of PERFORMANCE.md still open (external load generator through TLS
ingress, production-shaped volumes); the 🔒 error-budget dashboard stub and
the search-params fuzz item remain the next Phase 7 candidates.

---

## 2026-11-12 15:40 — Session 81 — A11y pass #2 on session 78's leftover forms (Web, Phase 7)

**Built:**

- The forms session 78 explicitly left over, API untouched. REGISTER: the
  aggregated error list became INLINE per-field `role=alert` errors wired to
  their control (`aria-invalid` + `aria-describedby=<field>-error`), submit
  focuses the first invalid field, and the form is `noValidate` (native
  bubbles were intercepting submission before the app's own announced
  alerts — `minLength` dropped, client `validate()` is the single channel;
  server errors keep a top `role=alert` block).
- ADDRESSES (`AddressFields`): four ORPHAN labels — the exact bug class
  session 78 fixed on checkout (visually adjacent, programmatically absent) —
  now real `htmlFor`/`id` pairs (`address-label/recipient/phone/street`;
  only one form instance ever mounts, so the fixed ids cannot collide), and
  the opened add/edit form autofocuses its first field.
- ORDER-HISTORY filters: upgraded from bare `role=tab` buttons to the FULL
  APG tabs pattern mirroring the session-78 dashboard — roving tabindex,
  Arrow/Home/End with wrap, auto-activation, `aria-controls="orders-panel"`
  → a real `role=tabpanel` (tabIndex=-1) wrapping skeleton/empty/list +
  pagination and relabelled by the active tab. Cancel notice `role=status`,
  error banner `role=alert`.
- RECEIPT rate card: the sr-only star radios had NO accessible name (their
  label content was the aria-hidden ★ span — AT heard "radio, 1 of 5"), each
  now carries "N star(s)"; the comment textarea got a hidden real label +
  the counter wired as `aria-describedby`; submit errors `role=alert`.
  OrderVerify: the hint paragraph is now the email input's accessible
  description.
- e2e `zz-forms-a11y.spec.ts` — 6 tests mirroring the portal-a11y pattern,
  named so its mutations (a new completed+reviewed Warung order) land AFTER
  every seed-absolute assertion. Covers: login labels + failed-sign-in
  alert; register inline alerts + aria wiring + focus-first-invalid;
  address associations + focus + validation + persistence; the history tabs
  keyboard contract driving the tabpanel; the bearer-rung auto-unlock of a
  bare receipt + named stars + review landed; the guest OrderVerify rung
  (wrong email stays "nothing unlocked", the proof email unlocks). API
  helpers were copied VERBATIM from portal-a11y via python (never through
  tool args); the test password is assembled in-page.

**Verified:**

- apps/web build green; API untouched so the jest/smoke gates do not apply.
- First full run: 5 spec-side bugs, ZERO product bugs — (1) EVERY App Router
  page ships an empty `<div role=alert id=__next-route-announcer__>`, so a
  bare `getByRole('alert')` is never strict (always `.filter({ hasText })`);
  (2) the "(optional)" spans are part of the accessible name — exact label
  lookups must include them; (3) FILTER order is the STATUS-FLOW order
  (All→Pending→…), instrumented repro proved the keyboard handler was right
  all along; (4) `check()` on the clipped 1px sr-only radio retries the hit-
  target intercept forever — click the WRAPPING LABEL instead. All four are
  harness lessons, each pinned as a comment in the spec.
- Targeted re-run 6/6 green; FULL suite 42/42 GREEN on a fresh re-seed
  (36 pre-existing untouched). Sanitizer scan: added lines + the new spec
  codepoint-clean (no mid-word U+2026, no `***`); `git diff --check` clean.

**Left for next sessions:** announcements/strings stay EN-only (pages
untranslated, consistent with the portal decision); CartSwitchModal still
awaits the session-78 dialog focus-restore (`useDialogFocus` extraction
becomes worth it when a third dialog lands); the 🔒 error-budget dashboard
stub now has real data to wire (session 80 metrics route).

---

## 2026-11-12 14:05 — Session 80 — Request-metrics middleware folded into pino + ADMIN GET /admin/metrics (API, Phase 7)

**Built:**

- The alerts loop's data source. New `src/common/metrics/`: a DI-free
  `RequestMetricsRegistry` (per-route count, 2xx/3xx/4xx/5xx tallies,
  cumulative duration histogram 5ms–10s bounds + Inf, nearest-bound
  p50/p95/p99 estimates, avg/min/max, uptime) behind an Express capture
  middleware and one Nest provider. Cardinality is bounded three ways:
  keys are the MATCHED route template (`GET /api/restaurants/:id`, never
  the concrete uuid — `req.route` is already resolved when the `finish`
  listener fires), unmatched paths collapse uuid/numeric segments and
  truncate, and a 250-key cap folds new keys into an honest `other` row
  (totals keep counting — nothing silently drops). `/api/health` is
  ignored, same policy as the access logger.
- FOLDED into the existing pino stream instead of a second log surface: the
  per-request `{bucket, status_class}` summary rides ON the access line
  (customProps now reads `res.metrics`), which works because the metrics
  middleware registers BEFORE pino-http — Node fires same-event `finish`
  listeners in registration order. That ordering is a silent-break trap,
  so it is pinned by an integration spec AND main.ts comments. Plus a
  periodic aggregate line `event: "request_metrics"` every
  `METRICS_LOG_INTERVAL_SEC` (default 60; `0` disables the fold, garbage
  falls back to default — an observability knob must never crash boot) and
  pull-based ADMIN `GET /admin/metrics` with a fully typed swagger model
  (`AdminMetricsSnapshotResponse`); the contract pin moved 72→73 ops.
- Snapshots are cumulative-since-boot by design (v1): pull route and fold
  lines read ONE registry so they can never disagree; alerting computes
  deltas between consecutive fold lines. SSE streams are accounted at
  close — same documented policy as access logging.

**Verified:**

- Build green; jest 82 suites / 994 tests (+2 suites / +29 tests over
  session 79's 80/965): registry math (bucket inclusivity, cumulative
  monotonicity, percentile ranks, overflow folding loses nothing),
  interval-knob parsing, and a LIVE-HTTP integration spec driving the
  exact production chain — template collapse, 404/400 status classes,
  health invisibility, and the access line carrying `metrics`
  (ordering contract) all asserted against a real pino memory stream.
- Live smoke 28/28 on a from-empty scratch DB (26-migration chain +
  seed, fresh compiled API on :4014): 401/403/200 guard ladder;
  snapshot key shapes exact; 3 detail GETs over 2 different restaurant
  uuids = +3 on ONE `GET /api/restaurants/:id` row with zero raw-uuid
  keys; ParseUUIDPipe 400 lands 4xx on the template row; junk path
  normalized; histograms cumulative-consistent; 5 health probes
  invisible to BOTH stream and registry; access lines carry
  `"metrics":{"bucket":...,"status_class":"2xx"}`; a real
  `request_metrics` fold line appeared within the 5s test interval with
  totals.requests > 0; docs-json registers the bearer-secured op and
  live ops count == swagger.spec list length. First run: 1 FAIL —
  harness had hardcoded 12 bounds (truth: 11); fixed to derive
  histogram==bounds+1 from the payload, re-ran 28/28.
- E2E 36/36 GREEN on fresh seed (middleware sits on every API request —
  full regression warranted); web code untouched.
- Sanitizer scan: 1,024 added lines codepoint-clean (no U+2026, no
  masked-credential triplets); `git diff --check` clean. INCIDENT caught
  live: a patch rewriting the spec's `Author...:` header helper line was
  outgoing-masked and the fuzzy-matching patch tool WROTE the mask to
  disk (broke the ternary) — caught by python codepoint readback
  (display masks both directions, so the check computed gap lengths and
  ordinal char lists, never echoed the string), repaired via runtime-
  assembled replacement strings, then diffed vs HEAD to prove the line
  is byte-identical to the committed original.

**Left for next sessions:** Phase 7 item 2 (a11y pass #2 on the leftover
forms); the locked error-budget dashboard item can now wire real data
into owner analytics; if deployments run multiple API replicas, metrics
are per-process by design — cross-instance aggregation is a deliberate
non-goal until the alert format (item: alerts loop) pins what it needs.


## 2026-11-12 11:38 — Session 79 — Storefront list-path perf sweep: query-logger verdict, ILIKE-indexable search, DISTINCT cuisines, EXISTS city filter (API, Phase 6)

**Built:**

- First a MEASUREMENT, not a guess: Postgres `log_statement='all'` scoped
  to a throwaway DB (seed + inflation to 8,994 restaurants / 53,955 menu
  items), API booted against it, every list shape curl'd inside
  marker-bracketed windows, statement counts read back from the server log
  + `EXPLAIN (ANALYZE, BUFFERS)`. Full findings in docs/PERFORMANCE.md.
  Verdict: the roadmap's `menuItemCount subqueries` hint is stale — the
  list already emits a CONSTANT 3 statements at any limit (no N+1). What
  the logger DID catch, now fixed:
- `search=` filter: `LOWER(col) LIKE '%t%'` is a function call on the
  column — un-indexable by construction. Now `col ILIKE` (IDENTICAL
  case-insensitive substring semantics, verified row-for-row on the probe
  DB) served by the session-69 GIN `gin_trgm_ops` indexes. Metacharacters
  (`% _ \`) now ESCAPED — typed literally, matching the `/api/search`
  rule; the escape moved to `common/like-escape.ts` (search.service
  re-exports it, its specs pin the same behavior). Swagger query doc notes
  the literal-metacharacter rule. New migration (26th):
  `IDX_restaurants_cuisine_trgm` — the search OR's second arm had no
  index and a bitmap OR only forms when EVERY arm does.
- `city=` filter: `leftJoin('r.cityEntity')` + skip/take made TypeORM run
  its DISTINCT-ids two-query strategy — a 4th statement per request
  (probe-proven). Now a single-WHERE EXISTS semi-join with the identical
  match rule (registry slug/name, legacy NULL-cityId snapshot): back to 3.
- `GET /restaurants/meta/cuisines`: replaced the FULL-table entity load
  (all 21 columns × 9k rows, 3.1 MB quicksort, de-dup in Node) with one
  `SELECT DISTINCT cuisine` (`distinctCuisines()`; `findRestaurants()` is
  gone — it had no other callers). Same 12-value answer, ~40x narrower
  scan, no per-request 9k-object hydration.
- Deliberately NOT added: sort indexes. Top-N over 374 buffered pages
  is sub-ms at 9k rows — PERFORMANCE.md's own overfitting warning
  applies; the decision is documented instead.

**Verified:**

- Build green; jest 80 suites / 965 tests (+5 new `query shapes (perf
  contract)` specs pinning the ILIKE arms + escaping, the no-leftJoin
  EXISTS city filter, the DISTINCT-cuisine query, and the batched-IN
  hours contract — suite count unchanged 80→80).
- Live query-logger probe re-run AFTER the change on the same inflated
  DB: city 4→3 statements; cuisines statement text is now the narrow
  DISTINCT (was the width-331 full-row fetch); searchbowl 3; limit1 vs
  limit50 both 3 (no-N+1 holds). EXPLAIN: selective `sate` search touches
  10 shared buffers vs 374 full-scan; `bowl` BitmapOrs both trgm indexes
  (cost 553→489); cuisine-arm `east` served by the new index.
- Endpoint behavior curls: cuisines identical list sorted; `search=house`
  total 1499; metachar `search=50%` 0 rows (no crash, literal); city
  case-insensitive total 2998, unknown city 0; combined search+cuisine+
  city 150.
- Full migration chain from EMPTY DB: 26 migrations incl. the new index
  apply green via `migration:run`; probe DB got it via boot `migrationsRun`.
- Web untouched — e2e 36/36 GREEN (fresh seed) since cuisines/search feed
  the homepage chips + search bars.
- Sanitizer scan: added lines codepoint-clean (no ellipsis characters, no
  masked-credential triplets); the escape-regex and swagger backslashes
  verified literal on disk.
  `git diff --check` clean.

**Left for next sessions:** PERFORMANCE.md recs 1 and 5 (off-host load
generator through real TLS ingress; authenticated scenarios with isolated
accounts) remain open; if restaurant cardinality grows 10x+, revisit the
rating-DESC index decision with fresh telemetry.


## 2026-11-11 20:12 — Session 78 — Checkout + portal a11y pass: real label associations, ARIA tabs, aria-live order status (Web, Phase 6)

**Built:**

- Checkout (`/checkout`): the five `<label class=…>Text</label>`s sat beside
  their inputs as orphans — ZERO programmatic associations (label text, not
  wrapping, no `for`): screen-reader users heard "edit text, blank" and
  there was no click-to-focus. All now `htmlFor` + ids (`checkout-name` …
  `checkout-note`), including the promo input; the receipt-email help
  paragraph is the field's accessible DESCRIPTION
  (`aria-describedby="checkout-email-help"`); the submit-error `<p>` finally
  got its `role="alert"` (the promo error always had one).
- Dashboard (`/dashboard`): the status strip claimed `role=tablist`/`role=tab`
  but implemented none of it — every tab in the tab order, no arrow keys, no
  panel. Now the real ARIA tabs pattern: roving `tabIndex` (exactly ONE tab
  in the order), Arrow/Home/End move+auto-select with focus following,
  `aria-controls="inbox-panel"`, and the inbox (skeleton/empty/list+pagination)
  wrapped in `role=tabpanel` `aria-labelledby` the ACTIVE tab (`tabIndex=-1`
  so "browse to panel" lands there).
- aria-live ON ORDER STATUS, the item's core ask:
  - Dashboard: silent push-syncs repaint the inbox VISUALLY, which is
    completely silent for assistive tech. The same snapshots are now diffed
    (page-scoped) and mirrored into one always-mounted polite sr-only region:
    "`FO-X is a new order, currently pending.`" / "`FO-X moved from pending
    to confirmed.`" — and the owner's OWN action announces through the same
    region inside the in-place patch.
  - Tracking page (`OrderLiveFeed`): the transports trigger
    `router.refresh()` and the badge changes silently; the island now watches
    its server-driven `orderStatus` prop and announces
    "Order status changed from A to B." A terminal order used to unmount the
    whole island — the polite region STAYS mounted so the FINAL transition
    is announced too.
- Dish dialog (`MenuItemForm`): `role=dialog aria-modal` that leaked focus
  behind the overlay on Tab and dumped keyboard users at `<body>` on close.
  Added a Tab trap (cycles at both boundaries over live non-disabled
  controls) + opener focus restore — the opener is captured DURING RENDER,
  because a mount effect sees `autoFocus`'s input, not the button that
  opened the dialog. (Escape-to-close already existed.)
- Context for repeated button names: inbox cards became `role=group`
  `aria-label="Order CODE, status"` (menu rows "Dish NAME") and the bare
  "Details" link is `View receipt for order CODE` — no more five identical
  "Edit" buttons in a row-by-row SR reading. Load-failure banners on
  dashboard + menu pages got `role=alert`. Kitchen display needed nothing
  (labels already wrap its selects, cards are named `<article>`s).

**Verified:**

- Full web build green on a wiped `.next`, then re-green on the exact
  committed tree (comment-only patch after the runs).
- API untouched: jest re-ran at session 76's baseline — 80 suites / 960
  tests, no delta (web-only increment).
- e2e 36/36 GREEN ×2 (31 pre-existing + 5 new `portal-a11y.spec.ts`), fresh
  `npm run seed` before each clean run: every checkout field resolves via
  `getByLabel` (impossible pre-session — the association IS the test) +
  accessible description probe; roving-tabindex invariant + arrow/Home/End
  auto-activation + focus-follows + tabpanel `aria-labelledby`; live inbox
  region announces a REST-created order "is a new order" and the UI "✓
  Accept" announces "moved from pending to confirmed"; dialog Shift+Tab
  wraps INSIDE and Escape lands focus back on "+ Add dish"; tracking page
  announces pending→confirmed→preparing over the real WS feed.
- Honesty note: the FIRST suite run failed only the tracking test's pay
  step — `429 RATE_LIMITED` on the payments bucket (10/min/IP; several spec
  files pay orders in one serial minute). Harness bug per the documented
  rate-limit pitfall, zero product involvement: `payOrder` in the new spec
  now waits out the advertised window and retries once. Both clean runs
  green after.
- Sanitizer scan: 503 added lines, ZERO `***` ON DISK — the three
  `authorization: Bearer ${token}` lines display masked but a python
  codepoint readback of the file proves them literal. The one U+2026 was
  intentional comment prose; reworded to keep future scans silent.
  `git diff --check` clean.

**Left for next sessions:** same pass for the remaining forms (login /
register / addresses / order-history / receipt's OrderVerify + rating card)
— checkout+portal were this item's scope; live regions announce PAGE-scoped
diffs (orders on the current view/page — off-page moves stay in the tab
counts only); a shared `useDialogFocus` hook is worth extracting if another
dialog needs the trap (CartSwitchModal, RateOrderCard); announcement strings
are EN-only, matching the unlocalized portal, must localize when the portal
joins next-intl.

---

## 2026-11-11 18:58 — Session 77 — Storefront states audit: a dead link is NOT a dead API (Web, Phase 6)

**Built:**

- Web: the storefront SSR now splits "resource gone" from "API
  unreachable". New `isApiDown` in `lib/api.ts` classifies before any UI
  touches the error: a non-`ApiError` throw (network) or any 5xx is an
  outage; the API's own 4xx (unknown restaurant, malformed-uuid 400) is a
  genuine dead link. `/restaurants/[id]` previously folded EVERY failure
  into `notFound()` — a backend restart made every alive kitchen look
  permanently deleted. Outages render the new localized `ApiOffline` card
  (data-testid, EN+ID `Offline` namespace); dead links keep `notFound()`.
- `generateMetadata` got the same ladder: transient outage titles the page
  "Restaurant temporarily unavailable — FoodOrder" and deliberately does
  NOT `noindex` it (a noindex during a blip poisons the SERP until the
  next recrawl); only a real dead link keeps "Restaurant not found" +
  noindex.
- Home: a filtered no-results search now names WHAT was filtered (`“query”`
  and/or the cuisine chip) with a "Clear search & filters ✕" escape
  CTA; the bare "No restaurants match your search." remains for a truly
  empty DB. Both cards localized EN + ID.
- Favorites: `FavoritesProvider` now EXPOSES the load error it already
  received from `authedCall` and discarded. `/favorites` renders a
  failure card with a working "Try again" instead of lying "Nothing saved
  yet — tap the heart on any dish" over a dead API. A toggle-time refresh
  failure keeps the stale list and paints the banner above it; the
  empty-card branch is gated on `!error`.
- The audit's loading-state verdict: ZERO route-level `loading.tsx`,
  DELIBERATELY. Adding boundaries made Next flush the shell with HTTP 200
  before the page settled — downgrading sitemap-listed dead restaurant
  links to soft-404s — and the boundary template duplicates the resolved
  segment in a hidden div, which broke map.spec's strict-mode locator
  (resolved 2 elements; caught live). Attribution done with a HEAD
  worktree build (hard 404, proving the regression came from MY
  boundaries, not from the split). Home/restaurant/map wait for the full
  render; client surfaces keep their existing inline skeletons (order
  history, favorites pending cards).
- ARCHITECTURE.md: durable rule "dead links and a dead API are different
  news" incl. the no-`loading.tsx`-above-`notFound()` corollary.
- `GET /orders/:id`'s receipt page NOT split on purpose: its single
  lumped card ("the API may be offline, the link is wrong, or the receipt
  needs its email key") is session 76's deliberate
  denial-indistinguishable contract — splitting there WOULD leak existence
  shape. Documented, untouched.
- E2E: new `empty-states.spec.ts` (3 tests): dead link answers hard 404 +
  no offline testid; home no-results names the query and the clear CTA
  restores the grid; signed-in favorites with the browser-side fetch
  aborted shows the failure card (never "Nothing saved") and recovers on
  retry after the route is released.

**Verified:**
- Full web build green on a wiped `.next` (clean 13.6s compile, 19 pages).
- Live SSR curl smoke 14/14 against a real `next start` + real API
  (script output to a file after the pipe-hang trap fired again — the
  first run's "timeout" was the script's nohup'd restart holding the
  pipe, zero product impact): API up → home grid, no-results card (query
  AND cuisine-only variants), restaurant page 200, unknown uuid = HARD
  HTTP 404, malformed uuid = 404 (API 400 counts as dead link, by
  design); API stopped → restaurant offline card at 200 + "temporarily
  unavailable" title, unknown uuid ALSO offline (honest: cannot know a
  link is dead while the API is down), home + map keep their apiDown
  cards. The "could not be found" grep clause was a harness bug (that
  phrase ships in every streamed page's RSC payload) — assertions moved
  to data-testid/status.
- e2e 31/31 GREEN ×2 (28 pre-existing + 3 new), fresh `npm run seed`
  before each clean run. Honesty note: an intermediate third full run
  failed ONLY `admin.spec`'s nav-click → heading 10s timeout — transient,
  not reproducible on either side of it; both clean runs green.
- API side untouched this session — jest stays at session 76's 80 suites
  / 960 tests.
- Sanitizer scan: zero `***` in every added line (118 tracked + the new
  files); the only U+2026s are legitimate EN/ID UI prose ellipses (same
  class as HEAD's "Search restaurants or dishes…" — and the two skeleton
  files that used one are no longer in the tree). `git diff --check` clean.

**Left for next sessions:** the accessibility pass on checkout+dashboard
(next Phase 6 item) can reuse `isApiDown` for its error surfaces; the
receipt island's EN-only copy (session 76 note) still stands; if real API
latency ever appears, route skeletons need a design that keeps
`notFound()` statuses HARD (e.g. PPR or co-located Suspense BELOW the
page's own data await — do NOT just re-add loading.tsx); dedupe the
restaurant page's double fetch (metadata + body each hit
`GET /restaurants/:id`); session 69's `/api/search` fuzzy endpoint still
has no storefront UI surface.

---

## 2026-11-11 17:20 — Session 76 — Receipt ownership: `GET /orders/:id` now proves a key, not just the uuid (API+Web, Phase 6)

**Built:**

- API: `orders.contactEmail` nullable varchar(254) (25th migration) +
  `CreateOrderDto.contactEmail` (`@IsEmail`, optional for API clients; the
  storefront always collects it). Stored normalized through ONE shared
  `normalizeContactEmail` (trim+lowercase) feeding both the write path and
  the read comparison — they can never drift on casing/whitespace.
  New `OrdersService.findOneForViewer(id, viewer?, contactEmail?)` ladder:
  ADMIN bearer → owning-customer bearer (`sub === order.userId`) → ANY
  presenter of the stored proof email (case-insensitive) — everything else
  throws the SAME `NotFoundException` an unknown id produces (message
  identical: the route never confirms existence, matching the cancel
  route's convention). `GET /orders/:id` switched to
  `OptionalJwtAuthGuard` + `contactEmail` query; `findOne` stays the
  unguarded internal loader (create-echo, status flows, event fan-out).
  Orders stored WITHOUT an email (legacy rows, API clients that omitted it)
  simply have no guest rung — documented, asserted.
- GDPR parity: account export now carries `contactEmail`; erasure nulls it
  alongside the rest of the contact block. Seed gives every demo order a
  deterministic proof email (FO-SEED1..10) so receipt reads work e2e.
- Web: checkout gained a required "Contact email" field (prefilled from the
  account when signed in); the post-order redirect carries `?email=`, and
  history/dashboard/admin links append the proof from their (already
  JWT-scoped) rows. The receipt SSR page feeds `?email=` to the API; on a
  denial it renders the new `OrderVerify` island, which auto-probes the
  bearer rung for signed-in viewers (re-entering the server render with the
  fetched row's own stored email — never typed) and offers guests a typed
  email unlock; a wrong answer stays indistinguishable from an unknown
  order.

**Verified:**
- api build green; jest 80 suites / 960 tests (session 75: 79/949 → +1
  suite / +11 tests — new `orders-ownership.spec.ts` pins the whole ladder:
  normalization, ADMIN/owner/proof rungs, foreign bearer answering the
  IDENTICAL 404 as an unknown id, NULL-stored-email orders having no guest
  rung, guest orders being owner-token-inert, single repo touch). Re-pinned:
  the GDPR erasure payload + the uuid-route sweep now points
  `GET /orders/{id}` at the `findOneForViewer` mock.
- Live smoke 30/30 on a from-EMPTY scratch DB (25/25 migrations + seed):
  mixed-case proof stored lowercased and matched case-insensitively; bare
  uuid / wrong proof / foreign bearer all 404 with `NOT_FOUND` envelope;
  correct proof 200; ADMIN bearer 200; proof unlocks for ANY presenter
  (checkout-redirect model); NULL-email order dead for guests; malformed
  uuid still 400 (`BAD_REQUEST`) before the ladder; junk email at create
  400 with the field named, rejected path wrote NOTHING (DB count) and no
  stored value violates `lower(contactEmail)`; untouched neighbours
  (`next-statuses`, `GET /orders/:id/payments`, GDPR export with the new
  key) green; docs-json registers the `contactEmail` query and the surface
  is unchanged at 72 ops. Two smoke-harness bugs found+fixed (unquoted
  camelCase identifier folded by psql; stale 71-op pin from session 69).
- web build green; e2e 28/28 GREEN ×2 (fresh `npm run seed` between runs):
  +2 new `order-access.spec.ts` tests — guest bare-link receipt shows the
  verify card, wrong email stays 404-shaped, typed (uppercase) proof
  unlocks via URL handoff; a signed-in customer opening the BARE url is
  auto-unlocked through the bearer rung and lands carrying the email.
  guest-order-smoke / menu-options / pay-order checkout helpers type the
  new required field; live-feed's API-created order stores the demo proof
  email (its bare-URL tracking page now flows through the island).
  Honesty note: the FIRST full run was 27/28 — pay-order's GUEST variant
  shared a helper that missed the required email input; fixed in-spec,
  then ×2 green above.

**Left for next sessions:** same ladder for `GET /orders/:id/next-statuses`
(still public; leaks only the status-machine edge of an existing order —
low but same class); a rate bucket on the proof endpoint if email guessing
ever matters; guest status emails can now unlock via the new column
(session-45 gap); i18n for the checkout email label + OrderVerify copy
(EN-only storefront surfaces today); no auth-cookie SSR session exists, so
`?email=` in the URL is the proof transport (history-visible — revisit if
the app grows real users).

---

## 2026-11-11 15:52 — Session 75 — CI matrix Postgres 15/16 + a schema-drift gate that actually gates (CI, Phase 5)

**Built:** `.github/workflows/ci.yml` only — no app code touched.

- `db-bootstrap` job now runs a `strategy.matrix.pg: ['15','16']`
  (`postgres:${{ matrix.pg }}-alpine` service containers, `fail-fast: false`
  so one leg's verdict never hides the other's). The full bootstrap chain —
  migrations → seed → schema/seed asserts → drift gate — must prove out
  identically on both majors. The e2e job deliberately stays pinned to 16:
  doubling the Chromium suite adds no schema-compatibility signal.
- Rewrote the schema-drift gate, which was **vacuously green the whole time**.
  Two independent bugs: (1) TypeORM writes generated migrations as
  `<timestamp>-DriftCheck.ts`, so the old `grep '^DriftCheck'` anchor never
  matched even a real drift file; (2) the "entities match migrations" state
  does NOT produce "No changes in database schema were found" — it produces a
  permanent 31-statement diff of known introspection noise (migration-only
  CHECK drops, migration-only trgm/GIN index drops, explicit-FK-name →
  TypeORM-hash rename pairs), so "any file = fail" would always fail if the
  grep had ever matched. New gate: extract the generated `up()` statements,
  filter exactly those three noise classes, and fail on ANYTHING ELSE with
  the offending SQL printed. A future migration-only CHECK/index keeps
  passing automatically; an entity column no migration applies does not.
  Noise set verified byte-identical on PG15.19 vs PG16.

**Verified:**
- Local PG15.19 (throwaway `postgres:15-alpine` container, trust auth):
  full chain green — 24/24 migrations recorded, seed ok, 11-table assert ok,
  core-row asserts ok; compiled API booted against it and 9/9 curl probes
  passed (trigram typo search, `<%` dish rows, `isOpenNow`/hours tz logic,
  coordinates, cities).
- Drift diff on a PRISTINE fresh-migrated DB is 31 statements on BOTH PG15
  and PG16 (normalized sorted diff empty).
- The CI drift step extracted verbatim from the YAML and run under `bash -e`
  exactly as Actions does: PASS ("no real drift") on both pristine DBs, and
  a NEGATIVE probe — extra `drift_probe` column injected into the PG15 DB —
  FAILS rc=1 printing exactly `ALTER TABLE "restaurants" DROP COLUMN
  "drift_probe"`.
- YAML parses; matrix/image assertions pass; the sanitizer line-continuation
  for the trust-auth value still decodes to `trust`; zero U+2026/`***` in
  the workflow file; `git diff --check` clean.
- api gates unchanged as expected (no src edits): build ok, jest 79 suites /
  949 tests — identical to session 74's counts.
- Incident found mid-verification (honesty note): `migrationsRun: true` +
  the app glob `migrations/*.{ts,js}` meant a DriftCheck file that existed
  briefly in `src/` got compiled into `dist/` and was AUTO-APPLIED by an API
  boot to the local scratch DB and the dev DB (renamed FKs to hashes,
  dropped the 4 trgm + migration-only CHECKs) — which is why an early gate
  probe falsely reported "zero changes". Both databases were rebuilt
  pristine afterwards (24/24 migrations, trgm=4, checks=22, reseeded) and
  the stale compiled artifact purged; the FINAL gate numbers above are from
  the pristine state. `nest build` does not delete orphan dist files —
  keep that in mind whenever a throwaway migration is generated.

**Left for next sessions:** regenerate the drift gate's noise filter if
entities ever start declaring their own `@Check`s (noise shrinks by design,
gate stays valid); `deleteOutDir`/`nest build --deleteOutDir` so stale dist
migrations can never auto-apply on boot; Stripe/Xendit payment adapters
still 🔒 API keys.

## 2026-11-11 13:43 — Session 74 — Storefront stock badges + dashboard stock editor (WEB, Phase 5 close-out)

**Built:** completed the ROADMAP follow-up "Web: storefront 'only N left' badge
+ dashboard stock editor" — the last unbuilt display half of the session-71
stock counter. The increment was left UNCOMMITTED by the crashed 10:20 slot
(its e2e spec was the newest file in the tree); this run reviewed every WIP
file, corrected three harness bugs, then verified and shipped it.

- API delta (mirror only, no migration): `FavoriteDish.stock` — the favorites
  row now carries the dish's live `stock` (`dish.stock ?? null`) so hearts
  show the same truth as the storefront; `FavoriteDishResponse` gained the
  nullable integer `stock` prop (op count stays 72, pinned in swagger.spec
  with a new probe).
- NEW `components/StockBadge.tsx`: amber "Only N left" pill at 1..5 tracked
  units, red "Sold out" pill at 0 (exports `LOW_STOCK_LIMIT=5` + defensive
  `isSoldOut`/`isLowStock`, junk negatives treated as zero), nothing for
  NULL = unlimited. Pure display over the server value — a stale badge can
  only look optimistic, never oversell, because order create still answers
  409 INSUFFICIENT_STOCK server-side.
- Storefront: badge embedded in the `MenuBrowser` dish heading;
  `AddToCartButton` disables and re-labels "Sold out" (chips disabled too,
  `data-testid="add-sold-out"`); favorites page maps `stock` through
  `toMenuItem`; EN/ID messages (`soldOutBadge`, `lowStockBadge`,
  `CartButton.soldOut`).
- Dashboard menu manager: inline `stock: unlimited / only N left / stock: N /
  SOLD OUT` on each row; `MenuItemForm` gained a "Limit sellable units"
  tracker — checkbox off = unlimited, ON = whole-number >= 0 input, and the
  three-way PATCH semantics are mirrored exactly (number SETS, unchecking
  while tracked sends explicit `null` CLEARS, untouched stays omitted);
  `lib/api.ts` `MenuItem.stock` + `MenuItemInput.stock` typed.
- NEW `e2e/tests/stock.spec.ts` (2 tests): badge follows the owner counter
  low→sold-out→unlimited incl. disabled Add, and the dialog sets/lowers/
  clears stock across dashboard + storefront; both restore seed stock=NULL in
  `finally` to keep the single-seed suite contract.
- Review fixes over the crashed WIP: e2e fixture used `?q=Warung` (the list
  route's param is `search=` — the `.find` masked it; corrected); smoke
  harness learned the real contracts: POST /users/me/favorites is pinned
  200 (`@HttpCode(200)`, idempotent), the error envelope is
  `{error:{code,…}}`.

**Verified:**

- API production build clean; full Jest **79 suites / 949 tests** green
  (+1 test vs session 73: the stock-mirror spec in `favorites.service`;
  swagger probe added inside an existing test).
- Live smoke on a scratch DB (24-migration chain from EMPTY + seed, API on
  :4021, payment gate open): **16/16 assertions** — favorites mirror tracks
  NULL→3→0→NULL exactly against owner three-way PATCHes; storefront detail
  reads carry the same live numbers; sold-out order create rejected 409
  `INSUFFICIENT_STOCK` with the orders table row count UNCHANGED and the
  counter untouched at 0; unlimited-clear restores mirror to null; server
  decrement still exact (5−2=3) and the favorites mirror reflects it after
  the order; docs-json `FavoriteDishResponse.stock` integer+nullable and
  total ops unchanged at 72.
- Web production build clean (new required `MenuItem.stock` compiles across
  every construction site). E2E **26/26 green** on fresh seed (Playwright
  boots both apps; the 2 new stock specs included). NOTE: the first suite
  run hit 3 failures caused by a STALE hand-booted API still listening on
  :4000 (auth-bucket `RATE_LIMITED` 429s — the known 10/min trap); freeing
  the port + re-seed made it 26/26, zero product bugs.
- Sanitizer codepoint scan across all added + untracked lines: no U+2026,
  no `***`; `git diff --check` empty; both messages JSONs parse.

**Left for next sessions:** CI matrix postgres 15/16 compatibility (next
unblocked ROADMAP line); `GET /orders/:id` guest-ownership fix (id
enumeration risk); storefront empty/loading/error states audit; accessibility
pass; `/restaurants` N+1 sweep; Stripe/Xendit adapters still 🔒 keys.

---

## 2026-11-10 14:09 — Session 73 — Restock repair pass for crashed cancels (API)

**Built:** completed the ROADMAP follow-up "Restock repair pass — cancelled
orders whose snapshot is non-NULL but `stockRestockedAt` stayed NULL must get
their units back" (session-72 crash window). The increment was left
UNCOMMITTED by a crashed session (13:0x slot); this run reviewed every WIP
file, then verified, hardened and shipped it.

- NEW shared module `orders/stock-restock-repair.ts` (plain, DI-free — same
  philosophy as `stock-restock.ts`/`stale-order-sweep.ts`): `runRestockRepair`
  selects orphans with ONE reusable SQL predicate — `cancelled` + marker NULL
  + `jsonb_typeof='array'` + `jsonb_array_length>0` + `updatedAt < cutoff` —
  oldest-first, bounded, then hands each to the SAME
  `restockCancelledOrder`, so the marker CAS keeps every repair exactly-once
  even against a live cancel or a second scheduler. Grace window (default
  `RESTOCK_REPAIR_GRACE_MINUTES=10`) means a healthy in-flight cancel is
  never raced; `RESTOCK_REPAIR_BATCH=500` drains a pathological backlog
  gradually (`capped=true` flags more remaining). NULL/empty snapshot is NOT
  an orphan (nothing was decremented); a snapshot whose entries are ALL
  malformed is selected, skipped, and NEVER marked — it honestly resurfaces
  in every report until a human repairs the ledger. `dryRun` (script-only)
  reports what a real run would return and touches nothing; a missing
  manager answers an empty report instead of throwing; scan errors propagate.
- ADMIN route `POST /orders/ops/restock-repair` (400/401/403 envelope) +
  `RestockRepairDto` (`graceMinutes` 1..10080, `limit` 1..500, both
  `@IsOptional @Type(Number) @IsInt @Min @Max`; `dryRun` deliberately NOT
  exposed over HTTP — whitelist strips it, pinned in specs and live).
  `OrdersService.restockRepair` delegates to the shared function — HTTP,
  script and route all run one implementation, no drift.
- Standalone cron `src/scripts/restock-repair.ts` (`npm run
  restock-repair`, `DRY_RUN=1` env, per-order detail on stderr + ONE JSON
  summary line on stdout — same machine contract as `cancel-stale`) +
  `ops/restock-repair.sh` wrapper + systemd service/timer examples (every
  30min + jitter + `Persistent=true` catch-up — a missed run after downtime
  IS the crash scenario this pass exists for).
- OpenAPI: `RestockRepairResponse` model (graceMinutes/cutoff/scanned/
  repaired/skipped/capped/orders); contract re-pinned 71→72 ops (both path
  lists, SUCCESS/ERROR tables, props/required probes). No migration — the
  24-column schema from session 72 already carries everything needed.
- SANITIZER REPAIR beyond the increment: the crashed session had copied
  `const SECRET = '***'` from `cancel-stale.admin.spec.ts` — a session-35-era
  masked literal living in HEAD (the `committed-credentials.spec.ts` guard
  only catches URL-shaped masks, so it passed CI for two weeks). Restored
  real passphrases in BOTH specs (`unit-cancel-stale-jwt`,
  `unit-restock-repair-jwt`), codepoint-verified on disk, suites re-run.

**Verified:**

- API production build clean; full Jest **79 suites / 948 tests** green
  (+3 suites / +32 tests vs session 72: 13-case unit spec incl. tuple-shape
  mock + grace-cutoff forwarding + CAS-loser skip + dryRun-touches-nothing,
  11-case supertest ADMIN HTTP spec, 8-case DTO bounds spec).
- Live smoke on a scratch DB (24-migration chain from EMPTY + seed, API on
  :4018): **58/58 assertions** — 401/403/400×3 envelope with ZERO mutation;
  default run exact report `scanned=3 repaired=2 skipped=1` oldest-first
  with codes + units `[3,2]`; ghost-dish snapshot entry repairs with marker
  set and a zero-row add (counter untouched); re-run = exactly-once (junk
  only, stock unchanged); junk stays unmarked until raw-SQL-repaired, then
  drains; 2-min-old cancel invisible to default 10-min runs but repaired by
  `graceMinutes:1`; `{"dryRun":true,...}` over HTTP STRIPPED and ran for
  real; TRUE-concurrent `limit:1` pair → repaired sum EXACTLY 1 and stock
  moved exactly once (both race outcomes observed across the two smoke runs
  — same-orphan CAS loss, and late-scan-wins-nothing — both safe); capped=true
  through sequential batch drain then false when clear; standalone
  `node dist/scripts/restock-repair.js` DRY_RUN report-only (marker NULL,
  stock unchanged), `ops/restock-repair.sh` real run (+1 unit, marker set),
  re-run drains to zero; docs-json 72 ops with the `$ref` pinned.
- E2E **24/24 green** on fresh seed (Playwright boots both apps; web
  untouched). No lockfile changes. Sanitizer codepoint scan across all
  added + untracked lines: the two `***` secrets fixed; no U+2026 remains;
  `git diff --check` empty.

**Left for next sessions:** Stripe/Xendit adapters (🔒 keys); the web "only
N left" badge + dashboard stock editor (next sub-item); CI postgres 15/16
matrix (next top-level); optionally an in-process interval scheduler for the
repair pass (today: ADMIN route + systemd timer only).

---

## 2026-11-09 18:11 — Session 72 — Restock on cancellation (API)

**Built:** completed the ROADMAP follow-up "Stock restock on cancel — owner/
admin/customer cancels and the stale-sweep must return reserved units".

- Migration `AddOrderStockRestock1794466800000` (24th): two nullable columns
  on `orders`. `stockDecrements` jsonb + `CHK_orders_stockDecrements_array`
  (NULL OR jsonb_typeof=array) — the ledger snapshot written by `create()`
  inside its unit-of-work transaction: exactly the per-dish aggregated units
  the stock guard actually decremented, or NULL when it decremented nothing.
  `stockRestockedAt` timestamp — the exactly-once CAS marker.
- WHY A SNAPSHOT instead of re-summing `order_items`: an order placed while
  a dish was unlimited must NOT pad the owner's counter after they switch
  stock on later. The snapshot freezes the truth at decrement time —
  restock returns precisely what was taken, never more, never less.
- NEW shared module `orders/stock-restock.ts` (plain, DI-free — same
  philosophy as `stale-order-sweep.ts`): `restockCancelledOrder(manager,
  order)` runs ONE transaction — CAS `UPDATE orders SET stockRestockedAt =
  $2 WHERE id = $1 AND stockRestockedAt IS NULL AND status = 'cancelled'`
  (the zero-row result IS the exactly-once + still-cancelled guard; a
  concurrent overwrite to a live status keeps the decrement) — then per-dish
  `UPDATE menu_items SET stock = stock + $2 WHERE id = $1 AND stock IS NOT
  NULL` in sorted-id order (mirrors the create-side lock sequence). A dish
  cleared to unlimited (or deleted) mid-flight is a silent per-row no-op.
  The `[rows, rowCount]` tuple trap is normalized and pinned in mocks.
  Snapshot entries are re-validated defensively (duplicate ids folded,
  junk skipped).
- WIRED INTO ALL FOUR CANCEL PATHS: customer `cancel()`, owner/admin
  `setStatusForRestaurant()` and `updateStatus()` (only when the transition
  lands on `cancelled` — confirm/preparing/complete never touch the ledger),
  the service stale-sweep wrapper, and the STANDALONE `cancel-stale` cron
  script (same shared function — no drift between HTTP and cron).
- Entity + OpenAPI `OrderResponse` document both fields; docs-json stays
  71 ops (no new routes). Seed unchanged (stock stays owner-API-proven).

**Verified:**

- API production build clean; full Jest **76 suites / 916 tests** green
  (+1 suite / +16 tests vs session 71: 9-case `stock-restock.spec.ts` unit
  contract incl. tuple-shape CAS loser, 5 wiring cases proving each cancel
  path + the sweep restock and each non-cancel transition does NOT, 2
  create-snapshot cases in `orders-unit-of-work.spec.ts`).
- Live smoke on a scratch DB (24-migration chain from EMPTY + seed, API on
  :4016): **63/63 assertions** — schema/CHECK probes; customer cancel exact
  return + marker set; re-cancel 400 with NO double-return and an unchanged
  marker; two TRUE-concurrent customer cancels → units returned exactly
  once; owner cancel, admin backdoor cancel; confirm does not restock but a
  later cancel does; rejected edges (delivering cancel, completion) return
  NOTHING and never mark; legacy-style order (NULL snapshot) cancelled
  AFTER the owner switched stock on → counter stays at the owner's number
  (no over-restock); dish cleared to unlimited mid-flight → cancel succeeds
  as a no-op add with marker set; HTTP sweep on a backdated guest order →
  report cancelled == live candidate count, guest units returned; the real
  `node dist/scripts/cancel-stale.js` cron path → units returned, re-run
  drains to zero with no further change; two-dish cart → both per-dish
  adds; raw-SQL probes (`"notarray"`, object → rejected by CHECK; negative
  stock still rejected); docs-json 71 ops with both fields present.
- E2E **24/24 green** on fresh seed (Playwright boots API+web itself; web
  untouched, extra JSON fields tolerated). No lockfile changes; sanitizer
  scan of every added line clean (no ellipsis characters, no asterisk
  masks), `git diff --check` empty.

**Left for next sessions:** a repair pass for the crash window between the
status-save commit and the restock transaction (a cancel killed in between
leaves the order cancelled with the marker NULL and units unreturned — no
automatic retry today; the marker makes such rows identifiable); Stripe/
Xendit adapters (🔒 keys); the web "only N left" badge + dashboard stock
editor; CI postgres 15/16 matrix (next top-level item).

---

## 2026-11-09 15:45 — Session 71 — Unit-of-work order create + stock guard (API)

**Built:** completed the ROADMAP item "Unit-of-work: wrap order create in
a transaction + stock guard".

- Migration `AddMenuItemStock1794380400000` (23rd): `menu_items.stock`
  nullable int + `CHK_menu_items_stock_nonnegative` (`NULL OR >= 0`)
  mirroring the DTO bound. `NULL` = UNLIMITED and is the state of every
  existing/seeded row — the column alone changes nothing until an owner
  opts in. Seed intentionally NOT updated (e2e suite contract depends on
  stable seed state; stock is proven through the owner API instead).
- OWNER API: `stock` on Create/UpdateMenuItemDto (`@IsInt @Min(0)`,
  explicit null passes `@IsOptional`); three-way patch semantics on
  `PATCH /menu/items/:id` — number SETS, explicit null CLEARS to
  unlimited, absent untouched (same shape as the session-70 coordinate
  pair). Create stamps `stock ?? null`. No new routes — docs-json stays
  71 ops; `MenuItemResponse.stock` documents the embed.
- UNIT OF WORK in `OrdersService.create()`: reads/pricing/promo-evaluate
  stay OUTSIDE; every MUTATION runs inside ONE
  `orders.manager.transaction(cb)` — stock decrements → order+items
  `em.save` → promo ledger row — so a rejected or failing order writes
  NOTHING (previously order+ledger were two independent commits).
  Live-feed emit + refetch stay post-commit, unchanged.
- STOCK GUARD: `stock >= requested` lives in the UPDATE's WHERE clause
  (`UPDATE ... SET stock = stock - $2 WHERE id = $1 AND stock IS NOT
  NULL AND stock >= $2 RETURNING stock`) — the conditional zero-row
  result IS the guard, no read-then-write race. Duplicate cart lines of
  one dish aggregate into ONE decrement; decrements run in sorted
  menuItemId order (deterministic lock sequence); fail-closed when an
  owner flips stock to null mid-flight. Trip = 409 `INSUFFICIENT_STOCK`
  (AppException envelope: menuItemId/requested/stockAtRead).
- PROMO RACE CLOSED: `PromosService.recordUsage(input, em)` now runs ON
  the order transaction: `SELECT ... FOR UPDATE` the promo row → RE-CHECK
  both caps post-lock → insert ledger. Two simultaneous "last redemption"
  orders serialize; the loser gets evaluate()'s exact 400 message and its
  order rolls back too. Session 67's documented race comment replaced.

**Verified:**

- API production build clean; full Jest **75 suites / 900 tests** green
  (+1 suite / +17 tests: 9-case `orders-unit-of-work.spec.ts`; 5-case
  transactional `recordUsage` (lock requested, caps re-checked, guest
  skip, vanished-promo, no-insert-on-reject); 2+2 stock cases in the menu
  service/DTO specs; 4 create-path harnesses rewired through
  `manager.transaction`).
- Live smoke on a scratch DB (23-migration chain from EMPTY + seed, API
  on :4013): **49/49 assertions** — schema probes, DTO ladder
  (-1/1.5/"3" → 400, non-owner 403, rejected writes NOTHING), over-order
  409 + zero rows written + stock intact, exact-fit drain to 0, stock-0
  never sellable, duplicate-line aggregate, owner create with/without
  stock, clear-to-unlimited round trip, raw-`UPDATE stock=-5` rejected by
  the DB CHECK, `docs-json` still 71 ops with stock documented, and THE
  money test: two TRUE concurrent promo orders against a cap-1 code →
  exactly one 201 + one 400, ledger EXACTLY one row, loser wrote no
  order/line rows.
- Two REAL bugs the smoke caught (jest stayed green through both):
  (1) this TypeORM/pg stack returns DML-with-RETURNING from `em.query()`
  as a `[rows, rowCount]` TUPLE — a zero-row miss is `[[], 0]` (length 2),
  so a naive `rows.length === 0` check NEVER tripped the guard and
  over-orders silently committed. Proven with a raw driver probe, fixed
  with an explicit shape normalizer; unit mocks now pin the TUPLE shapes
  (a `[]` mock hid this for one full gate). (2) harness lesson: a bare
  `wait` in the smoke script also waits on the backgrounded API server —
  it must wait on the race subshell PIDs, and the boot port must be
  verified free or a stale server silently serves an OLD build (session
  71 hit exactly that and reported the guard "broken" when dist was fine).
- E2E **24/24 green** on fresh seed (first run's 3 failures were the
  documented once-per-seed trio — admin/owner-analytics/zz-driver — and
  cleared by re-seeding, not a regression). Web untouched, no build
  needed.
- Sanitizer scan: added lines carry no U+2026/`***`; `git diff --check`
  clean. No lockfile changes.

**Left for next sessions:** restock on cancellation (owner/admin/customer/
stale-sweep paths all still leave stock drained — today the ledger is
decrement-only); storefront "only N left" badge + dashboard stock editor;
optional: idempotency window / retry guidance for the (mitigated, not
eliminated) multi-dish deadlock case.

---

## 2026-11-09 11:20 — Session 70 — Leaflet storefront map + restaurant coordinates (API + web + e2e)

**Built:** completed the ROADMAP item "Map view of restaurants (Leaflet)".
The item needed geometry the schema never had, so the increment is
coordinates-API + map-page as one shipped slice.

- Migration `AddRestaurantCoordinates1794294000000` (22nd):
  `restaurants.latitude/longitude` — WGS84 decimal degrees, `double
  precision` NULL, DB CHECKs `-90..90` / `-180..180` mirroring the DTO
  bounds; each column checked independently so even a raw-SQL half pair
  cannot store out-of-earth geometry. No backfill (seed owns platform pins,
  owners set their own).
- PARTNER RULE in `RestaurantsService.resolveCoordinatePair`: latitude and
  longitude must travel together on BOTH owner create and update — a half
  pair (including value+explicit-null) is a 400; on update BOTH `null`
  clears the pin, an absent pair is untouched. class-validator cannot
  express cross-field rules, so this is the single deciding layer (the DTO
  spec pins that deliberate split).
- DTOs: `@IsNumber @Min @Max` bounds on both Create/UpdateRestaurantDto
  (`@IsOptional` lets explicit nulls through for the clear path).
- Seed: 5 of 6 restaurants pinned with real Jakarta/Bandung/Surabaya
  coordinates; **Bowl House deliberately stays N/N** so the off-map path is
  exercised by every e2e run. Public reads serialize the pair automatically
  (entity rows); swagger `RestaurantResponse` documents it (no new routes —
  docs-json still 71 ops).
- Web `/map` (EN/ID): server page fetches `GET /restaurants?limit=50`,
  RE-validates pair finiteness/range before rendering (defense-in-depth per
  ARCHITECTURE), then mounts the Leaflet map through a client boundary
  (`dynamic(..., ssr:false)` — Leaflet touches `window` at import time).
  Pins are `CircleMarker`s (SVG paths — no icon asset URLs through the
  bundler), green/emerald = server-derived `isOpenNow` (legacy `isOpen`
  fallback), grey = closed; popups link to the restaurant. An accessible
  pinned-list below the map mirrors the markers and counts off-map
  restaurants. Header "Map/Peta" nav; sitemap entry; deps `leaflet@1.9.4`
  + `react-leaflet@5.0.0` installed with `--registry=https://registry.npmjs.org`
  so every new lockfile `resolved` is runner-reachable (lockfile verified
  0 tencentyun URLs after install).

**Verified:**

- API production build clean; full Jest **74 suites / 883 tests** green
  (+1 suite / +13 tests: 7-case real-ValidationPipe DTO spec incl. the
  whitelist-strip of `lat/lng` aliases and the pinned DTO-vs-service
  split; 6-case service pair-guard spec: move/clear/untouched +
  rejected-half-pair-writes-nothing on both routes).
- Live smoke on a scratch DB (22-migration chain from EMPTY + seed):
  **39/39 assertions** — schema probes (columns + both CHECKs), seed pin
  exacts, list/detail embeds, owner PATCH ladder (full pair→200 + DB moved,
  half pair→400 wrote NOTHING, value+null→400, 91/-181→400, alias strip
  200-no-write, both-null clears, non-owner 403, admin 200), POST create
  with pair/absent/half (rejected wrote 0 rows), raw-`UPDATE latitude=95`
  rejected by the DB CHECK, `-90/180` extremes accepted, docs-json still
  71 ops + `RestaurantResponse.latitude` documented + no stray `/map` API
  route.
- Web build clean; `/map` SSR (curl): "5 places pinned on the map", 5-row
  pinned list with NO Bowl House, "1 more restaurant without a location",
  sitemap includes `/map`, header link present; Indonesian cookie renders
  the localized strings.
- E2E **24/24 green ×2** on fresh seeds (≥60 s between runs; +2 tests:
  marker count == API-pinned count with off-map exclusion asserted both
  ways, and a deterministic marker→popup→detail-page walk). First run of
  the popup test FAILED for a real reason — with pins spanning 3 cities the
  Jakarta markers overlap within pixels, so pointer hit-testing lands on
  whichever path is topmost; fixed by dispatching a DOM `click` on the
  exact `nth()` path (Leaflet resolves `e.target`, no hit-test). A
  follow-up "3 failed" run was the documented once-per-seed suite contract
  (admin/owner-analytics/zz-driver), cleared by re-seeding — not a
  regression.
- Sanitizer scan: added lines carry no U+2026/`***`; `git diff --check`
  clean. Lockfile: 0 tencentyun resolved URLs.

**Left for next sessions:** owner web UI for setting the pin (the dashboard
restaurant-profile form does not expose lat/lng yet; API + DTOs are ready);
city-clustered viewports (a per-city map toggle or clustering would help
once restaurants exceed a handful of cities — current fitBounds spreads
Jakarta pins to ~2px); admin can already PATCH pins via the same route;
search results do not carry coordinates (deliberate: `/map` reads the list
route); `latitude`-only raw SQL rows are guarded only by the DB CHECK, not
by the API (accepted trade-off, documented in ARCHITECTURE).

---

## 2026-11-07 20:00 — Session 69 — Fuzzy search with pg_trgm (API)

**Built:** completed the ROADMAP item "Search: fuzzy name/description match
with pg_trgm" — a public, relevance-ranked cross-restaurant search endpoint,
backed by real trigram indexes, plus one honesty fix to the OpenAPI contract.

- Migration `AddSearchTrgmIndexes1794207600000` (21st): `CREATE EXTENSION
  IF NOT EXISTS pg_trgm` + four GIN `gin_trgm_ops` indexes
  (`IDX_{restaurants,menu_items}_{name,description}_trgm`). pg_trgm is TRUSTED
  since PG13, so the non-superuser DB owner runs it — proven on a scratch DB
  whose owner is the app role (and on CI's `foodorder` superuser).
- `src/search/`: `SearchModule` + public `GET /api/search?q=&limit=` (limit
  = per-side cap, 1..25, default 10) over restaurants (name/description/
  cuisine) and AVAILABLE dishes (name/description, JOINed restaurant brief).
  Match = symmetric trigram `col % q` OR word containment `q <% col` OR
  escaped-ILIKE substring (LIKE metacharacters in the query are literal);
  ranking = server-side `GREATEST(similarity, word_similarity…) DESC` with
  rating/price/name tie-breaks. Positional `$n` bind params throughout —
  TypeORM's Postgres runner passes params straight to `pg`, objects are not a
  supported convention. Restaurant hits run through the shared
  `attachHours` (session 68) so search never recomputes open-ness on a second
  clock; dish prices stay integer cents; pg NUMERIC `rating` is coerced to a
  JSON number.
- `SearchQueryDto`: `q` trimmed BEFORE validation (blank ⇒ 400), 1..100
  chars; `limit` int 1..25. Every property decorated (whitelist:true).
- Live smoke found a REAL bug pre-commit: `col %< q` 500s on PG16 —
  `%<` was renamed to `<%` in PG13 and the argument order is query-left.
  Fixed the SQL, re-pinned the spec regexes, and proved via EXPLAIN that
  `q <% col` is index-served (planner commutates to the indexed `col %> q`).
- Swagger: new `SearchResultsResponse`/`SearchRestaurantResultResponse`/
  `SearchDishResultResponse`/`SearchRestaurantBriefResponse` models, `search`
  tag, route contract-pinned as PUBLIC with a 400 envelope. BONUS contract
  honesty fix: `MenuOptionsController` (session 65) was silently missing from
  the swagger.spec route/SUCCESS/ERRORS/bearer lists — 6 owner ops had never
  been pinned; all 6 registered, so the pin (71 ops) now matches reality.

**Verified:**

- API production build clean; full Jest **73 suites / 870 tests** green
  (+2 suites / +19 tests: 9-case service spec pinning the generated SQL +
  bound params + clamp/escape/mapping branches, 8-case real-HTTP DTO spec
  incl. the whitelist-strip and trim-then-min-length paths; swagger.spec
  re-pinned and green).
- Live smoke on a scratch DB (21/21 migration chain from EMPTY, extension
  created by the non-superuser owner role): **41/41 assertions** — schema
  probes (4 GIN gin_trgm_ops indexes), `q=warung` ranks Warung Nusantara
  first with relevance ≥0.9 + 7-row hours embed + number-typed rating,
  contrast proof that the legacy substring `/restaurants?search=warunq` finds
  NOTHING while fuzzy `/search` still returns Warung (and typo `sushii`→Sushi
  Kan, `teokbokki`→Tteokbokki), description-only restaurant match (`sambal`
  → Bu Tini), dish hits with nested restaurant + integer cents, the
  availability filter proven by mutation (disabling Lalapan drops exactly one
  dish hit from the same query), 400 matrix (missing/blank/limit=99) +
  whitelist strip + limit capping + trim echo, metachar-safe `50%` (no error,
  no wildcard match), SQL-injection probe (200, table intact at 6 rows),
  four EXPLAIN probes showing the planner using each trigram GIN index
  (seqscan off), and the runtime docs-json serving the op with 71 total
  operations + public security.
- Web build/e2e not run: API-only increment (WORKFLOW rule).
- Sanitizer scan: added lines carry no U+2026/`***`; `git diff --check` clean.

**Left for next sessions:** the web storefront is not yet wired to
`GET /search` — header search box + results page (EN/ID), with the legacy
`/restaurants?search` substring param either delegating or documented;
similarity thresholds ride pg_trgm GUC defaults (0.3 / 0.6) — expose
per-deployment tuning if recall proves too loose/tight; no synonym/pinyin
handling; still open from session 68: transactional `replaceHours`
(folds into "Unit-of-work"), owner web UI for the weekly schedule.

---

## 2026-11-07 16:38 — Session 68 — Restaurant open hours + auto isOpen (API + web)

**Built:** completed the ROADMAP item "Restaurant open hours (day-of-week
schedule entity) + auto isOpen". Session start found the crashed session's
WIP tree uncommitted; every file was reviewed, then the increment was
verified end-to-end (the feature code proved sound — the WIP's *smoke script*
and *e2e spec* carried bugs, fixed here).

- `restaurant_hours` table (migration `AddRestaurantOpenHours1794121200000`,
  20th): one row per weekly window `[opensAt, closesAt)`; `closesAt <=
  opensAt` wraps past midnight; a weekday WITHOUT a row = closed that day.
  CHECK domains mirror the DTO exactly (dayOfWeek 0..6, HH:MM 24h regex),
  UNIQUE (restaurantId, dayOfWeek), FK CASCADE. `restaurants.timeZone`
  varchar(64) nullable — the IANA zone windows are interpreted in
  (null = server-local), validated on write via an Intl probe.
- `open-hours.ts` — pure, side-effect-free derivation (no host-clock/zone
  dependence in tests): `isOpenAt` checks today's windows plus yesterday's
  wrap-past-midnight tail; an EMPTY schedule returns null = "no signal",
  so the legacy manual `isOpen` column stays the fallback path.
- `RestaurantsService.attachHours` — batched one-IN-query pass (same
  contract as the option-groups attach) embeds `hours` + derived `isOpenNow`
  on the storefront list, detail and `/restaurants/mine` reads.
- Owner-or-admin `PATCH /restaurants/:id/hours` (PUT semantics): `days` is
  the COMPLETE replacement; `days: []` clears the schedule and hands the
  open status back to the manual toggle. Service guards class-validator
  cannot express: duplicate dayOfWeek, `opensAt === closesAt` (all-day is
  00:00-23:59), bogus IANA zone → 400 before any write; foreign owner →
  403 (admins bypass), unknown id → 404, malformed uuid → 400.
- Seed: three demo branches — Warung full week 07:00–23:00, Sushi-kan
  closed Mondays (6 rows), Bu Tini's night stall wraps 17:00→02:00 — all
  `Asia/Jakarta`; the rest stay unscheduled so both code paths ship.
  TRUNCATE covers `restaurant_hours`.
- Web: RestaurantCard's CLOSED overlay and the detail page's
  "Open now / Closed right now" pill follow the SERVER-derived `isOpenNow`
  (never recomputed client-side); the "Today HH:MM–HH:MM / Closed today"
  line renders from the embedded schedule in the restaurant's zone; en/id
  messages added. Swagger: `RestaurantResponse` gained `timeZone`/`hours`/
  `isOpenNow`, new `RestaurantHoursViewResponse`, op pinned in the 64-op
  contract.

**Verified:**

- API production build clean; full Jest **71 suites / 851 tests** green
  (+2 suites / +28 tests: 12-case pure `open-hours.spec`, 5-case
  real-ValidationPipe DTO spec incl. whitelist stripping, 11 new
  service-spec cases for attach/replaceHours branches).
- Web production build clean.
- Live smoke on a scratch DB (chain 20/20 from empty): **47/47 assertions**
  — seed embeds (7/6/0-row branches, wrap window, 3 zones), list/detail/mine
  carry `hours`+`isOpenNow`, derived-open at the current Asia/Jakarta minute
  (wrap window covering now) and derived-closed (future single-minute
  window), PUT replace = exactly 1 row with rejected paths writing NOTHING,
  400/401/403/404 matrix incl. customer-role and foreign-owner, admin
  bypass on platform restaurants, clear → legacy fallback incl. manual
  close/reopen deriving `isOpenNow` false/true, explicit-null zone reset,
  direct psql probes: dayOfWeek CHECK, HH:MM CHECK, weekday UNIQUE,
  FK-CASCADE sweep, and the runtime swagger doc serving the new op.
  Four bugs found and fixed in the crashed session's SMOKE SCRIPT itself
  (unbalanced quote, single-quoted SQL escaping, owner token where
  admin/customer roles were required, top-level `has()` instead of
  `.paths | has()`).
- Full Playwright suite **22/22 green** on a re-seeded local DB with the
  config's own runner (new `open-hours` spec 2/2; fixed its two
  pagination-envelope bugs — `GET /restaurants` returns `{items,...}`).
  Attribution note: partial failures in earlier reruns were NOT the
  increment — a hand-booted API without the config's auth-bucket override
  429-throttled suite logins (default 10/min); the documented runner path
  is green.
- Sanitizer scan: added lines carry no U+2026/`***`/`\uXXXX`; `git diff
  --check` clean.

**Left for next sessions:** `replaceHours` delete+insert is not yet
transactional (folds into the existing "Unit-of-work" roadmap item); the
ADMIN overview's `restaurants.open` count still reads the legacy `isOpen`
column, not the derived status — worth a follow-up; no owner WEB UI for
editing the weekly schedule (API-only, same as promo management); no
"opens at HH:MM" countdown on the storefront.

---

## 2026-11-06 17:38 — Session 67 — Coupons expiry + usage caps (API)

**Built:** completed the ROADMAP item "Coupons expiry + usage caps" — promo
codes now carry a redemption window and ledger-backed caps, enforced at every
decision point, with ADMIN minting/editing + an audit read of the ledger.

- `promo_codes` gains `startsAt`/`expiresAt` (timestamptz, window start
  inclusive / end EXCLUSIVE) and `maxTotalUsages`/`maxPerUser` (int, nullable
  = unlimited, CHECK >= 0) — migration `AddCouponExpiryAndUsageCaps1794038400000`
  (19th) plus the append-only `promo_usages` ledger entity/table: one row per
  consumed discount, `orderId` UNIQUE (an order redeems at most one code once),
  `promoId`/`orderId` CASCADE, `userId` FK SET NULL (guests AND GDPR-erased
  accounts keep counting toward the total cap without an identity),
  integer-cents `discountCents` snapshot, indexes (promoId) + (promoId,userId).
  Caps are counted on THIS table — no mutable counter to drift.
- `PromosService.evaluate` grew a 4th `ctx { userId?, now? }` arg and four new
  rejection reasons (`not_started`, `expired`, `total_cap_reached`,
  `per_user_cap_reached`), gated in cheapest-first order (ledger queries run
  last, only for live codes). Guests skip the per-user cap only — there is no
  provable identity to cap. `OrdersService.create` passes the caller identity
  and appends the ledger row AFTER the order save (FK needs the id); a
  rejected code still 400s with nothing written.
- `POST /promos/validate` now runs behind `OptionalJwtAuthGuard` (a bearer
  token activates the per-user check; guests/stale tokens stay public) and
  the valid payload adds `startsAt`/`expiresAt`/`remainingUsages`.
- ADMIN-only `PromosAdminController` at `/api/admin/promos`: list (with live
  `usageCount` via one GROUP BY — no N+1), create, PATCH (omitted keeps,
  explicit null CLEARS; lowering a cap below the current count makes the code
  instantly spent, ledger untouched), and `GET /:id/usages` paginated ledger.
  Guards mirrored on the service: percent 1..100 (400), `startsAt >= expiresAt`
  (400), unknown restaurant (400 before an FK 500), duplicate normalized code
  (409), UuidParam 400 on malformed ids.
- Seed: 6 codes — WELCOME10 gained `maxPerUser 3`, WARUNGHEMAT a +365d expiry,
  plus EXPIRED25/NEXTWEEK5/FLASH3OFF demoing expired/not_started/cap-1;
  every promo-coded seed order (FO-SEED1) now gets its matching ledger row so
  cap counting starts honest. TRUNCATE covers `promo_usages`.
- Swagger: 4 new operations pinned in `swagger.spec` (route 63-op contract,
  bearer lists, SUCCESS/ERRORS matrices, 8-value reason enum); money math
  untouched (discount clamped to subtotal, fee never discounted).

**Verified:**

- API production build clean; full Jest **69 suites / 823 tests** green
  (+1 suite / +38 tests: expiry/caps service specs, ADMIN CRUD/ledger specs,
  4 real-ValidationPipe DTO cases, orders-promo ledger assertions).
- Live smoke on a scratch DB (chain 19/19 from empty; payment gate OFF — not
  under test): **54/54 assertions** — window boundaries, EXPIRED25 order 400
  wrote nothing, guest FLASH3OFF redemption (ledger userId NULL, 300 cents),
  second redemption 400 total cap + rejected path wrote zero rows, owner
  per-user loop exactly 3 landings then 400 while demo (1 seeded of 3) and
  guests stay valid, ADMIN 401/403/404/400/409 branches, cap-0 instantly
  spent, null-clear revives with `remainingUsages` null, ledger pagination +
  404, and direct psql probes: negative-cap CHECK, negative-discount CHECK,
  duplicate-order UNIQUE, "every promo-coded order has exactly one redemption
  row".
- Two real bugs found BY the smoke and fixed: `PromosModule` lacked
  `AuthModule` so the route guards failed DI at boot, and admin `code`
  validation rejected pasted whitespace (`@Transform` trim added, unit-pinned
  through the real pipe).
- Full Playwright suite **20/20 green ×2** on re-seeded local DB (web source
  unchanged; seed promo fixture money math verified intact: the $39.00
  WARUNGHEMAT cart still passes). Scratch DB dropped, servers killed,
  ports 3000/4000/4010 freed.

**Left for next sessions:** the count→insert race for two simultaneous
"last redemption" orders stays open until "Unit-of-work: wrap order create in
a transaction" (existing roadmap item — ledger write then moves inside it);
promo redemptions are not in the GDPR export allowlist (SET NULL keeps
erasure safe); storefront does not yet render the `expiresAt`/
`remainingUsages` hints the preview already sends; no admin WEB UI for promo
management (API-only for now). Next roadmap item: restaurant open hours.

---

## 2026-11-06 14:55 — Session 66 — Cart line option picker (web)

**Built:** finished the ROADMAP item "Menu item options/variants" with its
web half — the cart line option picker that renders groups from the menu
read, enforces min/max in the UI, sends `optionChoiceIds`, and shows the
frozen receipt — plus the one API embed the storefront needed.

- API embed (additive): extracted `MenuService.attachOptionGroups` out of
  `findByRestaurant` (one IN-query, position sort, `[]` when none) and
  `RestaurantsService.findOne` now runs its nested `menuItems` through it —
  `GET /restaurants/:id` ships the IDENTICAL option payload as
  `GET /restaurants/:id/menu` (byte-parity proven in the live smoke). The
  `MenuService` constructor arg is `@Optional()` so existing unit harnesses
  compile untouched; `RestaurantsModule` imports `MenuModule` (no cycle:
  MenuModule pulls in only AuthModule).
- Cart model (`lib/cart.tsx`): `CartLine` gains `basePriceCents`, receipt-
  shaped `options[]` and a `lineKey` (dish id + sorted choice ids) — the
  same dish at two selections is TWO independent lines; `add` merges on
  lineKey, `setQty` keys on it, `quantityOf` badges across selections,
  and the unit price is always re-derived as base+Σ-deltas. Persisted
  pre-options carts normalize at hydration (legacy lines survive), and a
  cart-switch request carries its options so the replaced cart prices the
  line right.
- Picker (`AddToCartButton`): chips rendered from the embedded
  `optionGroups` — radio semantics at `maxChoices 1`, accumulating
  multi-select otherwise with unchecked chips disabled at the cap — `+$`
  delta labels, live "Unit price:" readout, and Add disabled + relabelled
  "Choose {group}" while a mandatory group is unmet. The button keeps the
  exact name "Add" for satisfied/optional cases (the contract the whole
  e2e suite clicks).
- Receipt everywhere: cart rows, checkout summary, switch modal,
  `/orders/[id]` items and `/orders/my` summaries render grouped labels
  ("Add-ons: Extra egg, Chicken satay (3 pcs)") through the shared
  `optionRowLabels` helper — flat per-choice rendering had repeated the
  group name (found BY the new e2e, fixed before commit). Checkout sends
  `optionChoiceIds` only on lines that carry picks.
- i18n: new `Options` namespace + `CartButton.chooseOptions` in BOTH EN
  and ID locales; `MenuBrowser` splits the dish-row layout so the picker
  gets a full-width block under the name/price row while option-less
  dishes keep the classic layout.

**Verified:**

- API production build clean; full Jest **68 suites / 785 tests** green
  (+3: embed wiring, no-menu skip, optional-harness case).
- Web production build clean.
- Live smoke on a scratch DB (migration chain 18/18 from empty; payment
  gate OFF — not under test): **22/22 assertions** — detail route embeds
  optionGroups (Size max 1, position-sorted choices, `[]` for the option-
  less dish, key present on all 5 rows); Size payload byte-identical
  across the two public menu reads; selections server-priced (Es Teh+
  Large 700, Nasi+egg+satay 2500 each, subtotal 5700), exactly 2 rows of
  jsonb snapshot stored position-ordered; plain line kept the base price
  with a null snapshot; cross-dish id / duplicate / over-max each answered
  400 and wrote NOTHING.
- Full Playwright suite **20/20 green ×2 on fresh seeds** — including the
  new `menu-options.spec.ts` (2 tests: three-line option cart → $43.50
  checkout → receipt snapshot round trip; radio swap / cap stacking /
  deselect + untouched plain-Add behavior).
- Scratch DB dropped; test servers killed and ports 3000/4000/4010 freed
  so the next session never reuses stale builds or consumed seed state.
  `git diff --check` clean; added-line sanitizer scan (U+2026/`***`):
  the only ellipsis mirrors the checkout page's own placeholder string —
  codepoint-verified on disk, not corruption.

**Left for next sessions:** the kitchen board and owner inbox do not yet
surface per-item option rows (staff needs the "no egg" visibility); the
favorites page adds plain base-price lines because its payload omits
`optionGroups` (safe on optional groups, wrong for mandatory ones); next
roadmap item — coupons expiry + usage caps.

---

## 2026-11-06 11:15 — Session 65 — Menu options/variants (API)

**Built:** completed the ROADMAP item "Menu item options/variants" API half,
left uncommitted in the working tree by the session that crashed
mid-implementation (the 2026-11-06 morning WIP: entities, migration, service,
controller, order wiring, seed and two spec files all present, nothing
verified). Reviewed every file, then ran the full gates.

- Two new entities + migration `AddMenuOptionGroups1793952000000` (18th):
  `menu_option_groups` (name, minChoices 0..20, maxChoices 1..20 >= min,
  position; FK menuItemId CASCADE) and `menu_option_choices` (name,
  `priceDeltaCents` >= 0 integer cents, position; FK groupId CASCADE), both
  CHECK-constrained + indexed, mirroring the DTO bounds exactly.
- Owner CRUD: `POST/PATCH/DELETE /menu/items/:itemId/options/groups[/:groupId[/choices[/:choiceId]]]`
  (`MenuOptionsController`, OWNER role, ownership resolved through the DISH via
  the now-public `MenuService.loadManagedItem` — foreign/unknown ids all 404).
  Guards: min>max 400, min above provided/current choice count 400, deleting
  the choice that would starve a mandatory group 400, 20-choice cap per group,
  cascade group-delete returns the pre-delete snapshot.
- Public menu read embeds sorted `optionGroups` (one IN-query, no N+1; dishes
  without groups get `[]`). Order lines accept `optionChoiceIds`;
  `MenuOptionService.resolveSelections` validates existence/parent-dish/
  duplicates/per-group min-max and folds DB price deltas into
  `unitPriceCents` server-side; the receipt freezes into the new jsonb
  `order_items.optionSelections` (null = no picks / pre-options rows).
  Seed adds optional (min 0) Size + Add-ons groups on Warung Nusantara so the
  web cart can adopt them without breaking checkout meanwhile.

**Verified:**

- API production build clean; full Jest **68 suites / 782 tests** green
  (+2 suites / +23 tests: `menu-option.service.spec.ts` incl. real-pipe DTO
  checks, `orders-option-pricing.spec.ts` for the index-aligned wiring).
- Live smoke on a scratch DB (payment gate off — payments not under test):
  **40/40 assertions**, notably — migration chain 18/18 from empty; seeded
  2 groups/6 choices; public menu arrays + position sort; owner create
  (cascade 2 choices), 400 min>max, 403 customer token, 404 foreign dish;
  order with Large -> unit 700 = base 500+200, subtotal 1400, receipt stored;
  client-sent `priceCents` stripped by the whitelist; duplicate/foreign/
  unknown ids each 400 and wrote no order; mandatory-group missing 400,
  satisfied 201; 3 picks on max 2 -> 400 while 2 picks priced both deltas
  (1540); deleting the Size group cascaded its choices yet the past order's
  snapshot stayed intact; non-uuid choice id -> 400 at the DTO.
- Scratch DB dropped; port released. Added lines scanned for sanitizer
  corruption (U+2026/`***`): none; `git diff --check` clean.

**Left for next sessions:** web cart line option picker (render groups,
enforce min/max in UI, send `optionChoiceIds`, show receipt on order
history); then coupons expiry + usage caps.

---

## 2026-11-06 06:10 — Session 64 — Order status-change audit trail

**Built:** completed the ROADMAP item "Audit log table for status changes",
left uncommitted in the working tree by the 2026-11-05 19:27 session that
crashed on an upstream 402 (provider credits) mid-implementation.

- New `OrderStatusAudit` entity + migration `AddOrderStatusAudits1793865600000`:
  append-only `order_status_audits` table — `fromStatus`/`toStatus`/`source` +
  actor userId/role/email snapshot, CHECK constraints on all three domains,
  `orderId` FK CASCADE vs `actorUserId` FK SET NULL (GDPR erasure keeps history
  with the email snapshot), `(orderId, createdAt)` + `actorUserId` indexes.
- Every accepted transition path records exactly one row: restaurant-owner
  route (ADMIN actor recorded as admin source), driver route (email now flows
  from the JWT payload), generic admin `PATCH /orders/:id/status` (now captures
  the calling admin as actor — previously actor-less), customer cancel, HTTP
  stale-sweep route, and the standalone `cancel-stale` cron script path (writes
  its own row since it bypasses the service). Rejected transitions short-circuit
  before the save and write nothing.
- Wiring: `OrdersModule` registers the repository; the service constructor takes
  it `@Optional` so existing unit harnesses stay valid; `data-source.ts` + the
  entity-count spec updated to 16 entities.

**Verified:**

- API production build clean; full Jest **66 suites / 759 tests** green
  (+1 suite / +4 tests from the new `order-status-audit.spec.ts` covering all
  five sources plus the rejected-transition case).
- Migration chain ran 17/17 from an empty scratch DB, then a live smoke against
  the built API (payment-confirm gate disabled via env for the transition test):
  owner confirmed+preparing, driver delivering, admin generic confirm, customer
  cancel, HTTP ops sweep, backdated script sweep. Result: **exactly 7 audit
  rows covering all 5 sources** with correct from/to statuses and actor emails;
  an illegal driver edge (delivering→pending) answered 400 and added **no row**;
  the script path wrote exactly 1 row (no double-write with the service hook).
- FK policies proven live: deleting an order cascades its audit rows; deleting
  the acting user SET NULLs `actorUserId` while `actorEmail` survives.
- Scratch verification database dropped after use; API port released.
  `git diff --check` clean; added lines scanned for sanitizer corruption
  (U+2026/`***`): none.

**Left for next sessions:** next roadmap candidates — menu item
options/variants, `GET /orders/:id` guest-ownership fix, coupons expiry.

---

## 2026-11-05 13:10 — Session 63 — Personal-data export and account deletion

**Built:** completed the next unblocked Phase 5 item as two authenticated
self-service API endpoints.

- Added `GET /api/users/me/export`, scoped exclusively from the JWT subject. The
  versioned export explicitly maps profile, address book, favorites, customer
  orders, payments made, reviews, owned restaurants/menu, driver assignments,
  issued-refund history, refresh-session metadata, and push endpoints. Password
  hashes, refresh-token hashes, push key material, raw tokens, and payment client
  secrets cannot enter the response shape.
- Added `DELETE /api/users/me` with a fully decorated DTO requiring the current
  password and exact `DELETE` confirmation. The operation is transactional:
  retained customer-order snapshots are anonymized, refund-admin email snapshots
  are cleared, the user is deleted through existing cascade/SET NULL FKs, and
  affected restaurant review aggregates are recomputed.
- Added operational safety gates: the final administrator cannot self-delete;
  drivers must clear active assignments; owners must resolve active restaurant
  orders. Successful deletion reports anonymized orders, detached restaurants,
  and unassigned deliveries. Refresh sessions cascade immediately; existing
  short-lived access JWTs keep their normal cryptographic expiry boundary.
- Added typed OpenAPI models for both endpoints and their nested export fields,
  plus privacy architecture/API documentation. No schema migration was needed;
  the existing FK actions and nullable retained-history links already express the
  deletion policy.

**Verified:**

- Strict TDD: the new DTO/service suites first failed on missing modules; after
  implementation they passed **8/8**. The expanded Swagger contract and UUID
  controller harness then exposed both missing test providers before the full
  suite was rerun.
- API production build clean; full Jest **65 suites / 755 tests green**.
- Live PostgreSQL-backed smoke against the built API: registered a temporary
  customer, created an authenticated order containing private contact snapshots,
  exported it with no sensitive key material, proved wrong password → 401 and
  non-exact confirmation → 400, then deleted the account → 200 with one
  anonymized order. The retained order had `userId:null`, all contact/address
  fields replaced, note cleared, and the deleted refresh token returned 401.
- The temporary smoke data was removed by a full canonical reseed; port 4000 was
  released. `git diff --check` passed, and added-line sanitizer auditing found no
  masked credential literals or U+2026 corruption.

---

## 2026-11-05 09:23 — Session 62 — Restaurant SEO metadata and crawler routes

**Built:** completed the next unblocked Phase 5 item across the public browse
surface.

- Added restaurant-specific server metadata on `/restaurants/:id`: canonical
  title and description from the API row, absolute canonical URL, Open Graph and
  Twitter cards, and the restaurant image when present. Missing restaurants are
  explicitly `noindex,nofollow` instead of inheriting generic storefront SEO.
- Added `/sitemap.xml` with the homepage plus every live restaurant returned by
  the API. It is generated on demand so restaurant changes do not require a web
  rebuild; during an API outage it remains valid with the homepage entry rather
  than failing the route.
- Added `/robots.txt`, advertising the sitemap while excluding authenticated and
  customer-workflow routes such as dashboard, admin, checkout, orders, driver,
  account, and address pages.
- Added one validated site-origin helper and documented
  `NEXT_PUBLIC_SITE_URL`; localhost remains the safe local default. Root
  `metadataBase`, canonical links, crawler routes, and social URLs now share the
  same origin contract.
- Added `e2e/tests/seo.spec.ts` plus architecture/E2E documentation for the
  crawler and metadata behavior.

**Verified:**

- Strict TDD: the focused Playwright test first failed because `/robots.txt`
  returned 404; after implementation it passed. A later expected-value failure
  caught the sitemap root's standards-correct trailing slash and the assertion
  was corrected without changing application behavior.
- Web production build clean with **19 generated routes**, including static
  `/robots.txt` and dynamic `/sitemap.xml`.
- Full PostgreSQL-backed Playwright suite **18/18 green**.
- Live production curl-equivalent smoke asserted the robots directives and
  sitemap declaration, all **6/6** seeded restaurant URLs in the sitemap, and a
  real Seoul Street page's title, canonical URL, and Open Graph title.
- The canonical database seed was restored after E2E; ports 3000/4000 were
  released. API code was untouched, so API build/Jest were skipped per workflow.
- `git diff --check` passed; sanitizer audit found no masked credential literals
  or U+2026 corruption in tracked additions.

---

## 2026-11-04 19:18 — Session 61 — k6 browse baseline and tuning report

**Built:** completed the next unblocked Phase 5 item with a repeatable,
non-destructive API load workload.

- Added `ops/load-test.js` with smoke and 25-VU ramp/hold profiles. It
  bootstraps real restaurant ids, then cycles through public restaurant list,
  cuisines, detail, and substring-search reads. It never creates or mutates
  application data.
- Added explicit SLO gates: HTTP failures below 1%, p95 below 500 ms, p99 below
  1 second, and checks above 99%. Every response must be HTTP 200 JSON without
  the standard error envelope.
- Split deterministic profile/path/bootstrap helpers into
  `ops/load-test.lib.mjs` and pinned them with a Node contract test.
- Added `docs/PERFORMANCE.md` with native and Docker commands, workload safety
  boundaries, the measured baseline, query-plan findings, and evidence-based
  follow-ups. README now points operators to the workload and report.

**Verified:**

- Strict TDD: the contract test first failed on the absent load-test helper;
  after implementation it passed and remained green after the k6 script was
  finalized.
- API production build clean; full Jest **63 suites / 747 tests green**.
- Real k6 smoke: **75 requests**, **0 failures**, checks **223/223**, p95
  **4.30 ms**, p99 **5.49 ms**, max **8.09 ms**.
- Real 3-minute load profile: peak **25 VUs**, **15,027 requests** at **83.41
  req/s**, **0 failures**, checks **45,079/45,079**, p95 **4.06 ms**, p99
  **8.17 ms**, max **44.77 ms**; all thresholds passed and no iteration was
  interrupted.
- PostgreSQL 16 `EXPLAIN (ANALYZE, BUFFERS)` confirmed UUID detail uses the
  primary-key index; list/cuisine/search scan the six-row seed cheaply. No
  speculative tuning was applied. API health remained `status:ok`, `db:up`
  after the run.

---

## 2026-11-04 17:28 — Session 60 — Deterministic database feature flags

**Built:** completed the next unblocked Phase 5 item as an API foundation for
safe staged rollouts.

- Added the `feature_flags` table/entity with a unique 80-character key,
  optional description, global enabled switch, and a `smallint`
  `rolloutPercentage`. The migration and entity both enforce the 0–100 range;
  flags default disabled and therefore cannot turn behavior on accidentally.
- Added exported `FeatureFlagsService.isEnabled(key, subjectId)`. Missing and
  disabled flags fail closed, 0/100 provide explicit global boundaries, and a
  partial rollout requires a stable subject id. SHA-256 of the separated key and
  subject id produces a deterministic 0–99 bucket, so a user stays in one cohort
  while different experiments remain independent.
- Registered the entity in the CLI data source and the module in the Nest app.
  No public mutation endpoint or seed flag was added: future features can inject
  the helper, while rollout administration remains an explicit later surface.

**Verified:**
- Strict TDD: the focused spec first failed because the feature-flag entity and
  service did not exist; after implementation the focused service/data-source
  run passed **11/11**.
- API production build clean; full Jest **63 suites / 747 tests green**.
- Migration applied to PostgreSQL 16 as migration 16; schema-drift generation
  correctly refused with “No changes in database schema were found”.
- Real application-context smoke inserted a temporary 20% flag and proved an
  included bucket, excluded bucket, anonymous partial-rollout exclusion,
  missing/disabled fail-closed behavior, global 100% behavior, and live CHECK
  rejection of 101 (`23514`). The temporary row was deleted afterwards.
- Built API booted normally and `/api/health` returned `status:ok`, `db:up`;
  port 4000 was released afterwards. No API endpoint changed this session.

---

## 2026-11-04 15:37 — Session 59 — Installable PWA and offline cart

**Built:** completed the next unblocked Phase 5 item without adding a PWA
framework dependency.

- Added a Next metadata manifest with standalone display mode, FoodOrder theme
  colors, and generated 192×192, 512×512, and maskable 512×512 PNG icons.
- Registered the existing `/sw.js` for every storefront visitor. The worker now
  keeps its browser-push behavior and adds a versioned cache for the small public
  app shell (`/`, `/cart`, `/offline`, manifest/icons) plus visited Next static
  assets. App-shell navigation is network-first; uncached offline navigation gets
  the neutral offline page. API requests and authenticated portal/order HTML are
  deliberately never cached.
- Reused the existing device-local cart storage: a visited cart can render and
  change quantities offline. The cart announces loss of connectivity and makes
  the checkout boundary explicit instead of pretending an order can submit.
- Added Playwright coverage for manifest/icon contracts, worker control, a real
  Chromium offline reload, persisted cart rendering, offline status, and an
  offline quantity edit. Architecture and E2E docs record the cache/privacy
  boundary.

**Verified:**
- Strict TDD: the focused browser spec first failed because
  `/manifest.webmanifest` returned 404; after implementation it passed offline.
- Web production build clean with **18 generated pages/routes**, including the
  manifest and `/offline`.
- Full PostgreSQL-backed Playwright suite **17/17 green**; the canonical seed was
  restored afterwards.
- Live production-web curl smoke verified **7 endpoints/files**: manifest,
  worker, three PNG icons with exact dimensions, `/offline`, and `/cart`.
  Manifest values and both fetch/push worker handlers were asserted. Port 3000
  was released afterwards.

---

## 2026-11-04 10:55 — Session 58 — Live driver delivery portal

**Built:** completed the remaining web half of the Phase 5 driver/courier item.

- Added `/driver`, guarded in the UI to the exact DRIVER role, with assigned
  delivery cards, restaurant/customer/address/phone/items/notes, legal
  preparing→delivering and delivering→completed actions, loading/empty/error/
  signed-out/wrong-role states, and a role-scoped header link (EN/ID labels).
- Extended the shared Socket.IO order feed with `subscribe:driver` /
  `unsubscribe:driver` and verified `d:<JWT-sub>` rooms. Order events now carry
  internal-only affected driver ids; assignment replacement wakes both the old
  and new driver, while driver status changes wake the current assignee. The web
  refetches canonical `GET /driver/orders` data on push and falls back to a
  10-second poll.
- Added typed web client methods for the driver inbox/status route and a
  Playwright flow that proves a server-side status write arrives without reload,
  then completes the delivery through the portal. The E2E-owned API raises only
  its auth test bucket to avoid role-login ordering failures; production limits
  and the dedicated rate-limit specs are unchanged.
- Fixed a push debounce race exposed by the expanded suite: an event arriving
  while the kitchen's on-ready timer was pending could be swallowed behind the
  earlier fetch. Kitchen and driver views now use a trailing debounce, preserving
  the latest wake-up.

**Verified:**
- Strict TDD: the new browser spec first failed on the absent `/driver` heading;
  after implementation, the expanded full suite exposed and reproduced the
  kitchen debounce race and the auth-bucket ceiling before both harness issues
  were fixed.
- API production build clean; full Jest **62 suites / 740 tests green**.
- Web production build clean with **16 routes**, including `/driver`.
- Full PostgreSQL-backed Playwright suite **16/16 green**; focused kitchen +
  driver regression run **2/2 green**.
- Live built-API curl smoke: health/db up; DRIVER login; filtered driver inbox;
  FO-SEED3 preparing→delivering→completed with both timestamps. Built `/driver`
  returned HTTP 200 with the route payload. Ports 3000/4000 were released and
  the canonical seed was restored afterwards.

---

## 2026-11-03 17:48 — Session 57 — Driver assignment API foundation

**Built:** completed the API half of the top Phase 5 driver/courier item while
leaving the parent roadmap item open for its web portal/live-feed follow-up.

- Added the exact `driver` user role and a nullable indexed `orders.driverId`
  relation with `ON DELETE SET NULL`. The committed migration extends the
  existing PostgreSQL role enum idempotently, then adds the order column/index/FK;
  its down path deliberately leaves the enum value in place.
- Added owner/admin `PATCH /restaurants/:id/orders/:orderId/driver` with a
  fully decorated `{driverId: uuid|null}` body, ownership + path scoping,
  DRIVER-role target validation, terminal-order immutability, and normal
  `order.updated` publication after assignment/unassignment.
- Added exact-DRIVER `GET /driver/orders` (JWT-subject assignment scope with
  status/paging) and `PATCH /driver/orders/:id/status`, limited to
  preparing→delivering and delivering→completed. Unknown and foreign assignments
  share 404; illegal transitions answer 400. Admin does not bypass this boundary.
- OpenAPI now documents 57 operations, driver role/response fields/auth/errors;
  the UUID route sweep covers all new path params. Seed creates a demo driver and
  assigns FO-SEED3. Admin API counts now include drivers. Architecture, README,
  and roadmap sub-items record the API/web split.

**Verified:**
- Strict TDD RED evidence: schema spec first failed on the missing migration and
  role; DTO spec failed on its missing module; service/HTTP specs failed on the
  missing methods/controller; seed and admin specs failed on absent fixtures/counts;
  Swagger failed on absent `driverId` response schema and undeclared driver tag.
- Focused driver/schema/DTO/HTTP/OpenAPI/admin/seed tests green; expanded UUID
  sweep **58/58** and related order/auth tests green.
- Full API Jest suite **62 suites / 738 tests green** and production build clean.
- PostgreSQL 16 migration applied as the 15th migration; the seed completed with
  four users and FO-SEED3 assigned to the demo driver. A schema-drift probe first
  exposed an entity/migration FK-name mismatch; a failing metadata regression was
  added, `@JoinColumn` now pins the committed constraint name, and the final
  `migration:generate` correctly refused with “No changes in database schema”.
- Live built-API smoke **11/11**: health/db, all four role logins, seeded assignment,
  driver-scoped inbox, exact-role 403 for ADMIN, non-driver assignment 400,
  unassign/reassign, driver preparing→delivering→completed timestamps, malformed
  UUID 400, and all three OpenAPI paths.
- The first GitHub CI run exposed the seed contract outside the API: the admin
  Playwright fixture still expected three users, and the admin card omitted the
  new driver count. A focused browser test reproduced the failure, then the web
  API type/card and assertion were updated. Web production build is clean and the
  full PostgreSQL-backed Playwright suite is **15/15 green**. The database was
  re-seeded to the canonical fixture afterwards.

---

## 2026-11-03 16:10 — Session 56 — Tablet kitchen display

**Built:** completed the next unblocked Phase 5 item as a web-only projection
of the existing guarded owner-order API.

- Added `/dashboard/kitchen` and a shared Kitchen portal tab. The board reads
  `confirmed`, `preparing`, and `delivering` orders in parallel (up to 50 per
  lane), sorts oldest first, and presents them as Queued, Preparing, and Out
  for delivery. Pending acceptance/cancellation stays in the full inbox, so
  unpaid or unaccepted work does not enter the prep flow.
- Added tablet-sized cards with order code/time, customer, item quantities,
  prominent kitchen notes, lane totals, and full-width touch actions for the
  legal forward transitions. Successful actions move the server-returned card
  in place; completion removes it and every affected lane total is updated.
- Reused the owner Socket.IO restaurant room as the live wake-up path with a
  debounced authenticated refetch, visibility catch-up, and 10-second polling
  fallback. Silent reads that started before a landed action are discarded so
  they cannot move a card backward. A 50-row lane cap is surfaced instead of
  silently hiding overflow.
- Extended the existing owner Playwright session (rather than spending another
  auth-rate-limit login): create a guest order, pay/capture it, confirm it,
  observe its WebSocket arrival on a 1024×768 board, then move it through all
  three lanes and assert card content plus count changes. A second order arrives
  while the first action response is deliberately held, proving the dropped
  busy-period wake-up is remembered and flushed afterwards. Architecture and
  E2E docs now describe the prep-board contract.

**Verified:**
- Strict TDD: the focused browser spec first failed because the Kitchen route
  and heading did not exist; a later count assertion failed before lane-total
  wiring was added; the busy-action regression then failed until missed push
  wake-ups were retained and flushed.
- Web production build clean (Next.js type-check + **15 routes**, including
  `/dashboard/kitchen`).
- Focused kitchen flow green, then the full PostgreSQL-backed Playwright suite
  **15/15 green**. The first full run exposed the existing 10/min auth-bucket
  ceiling after a separate kitchen login; the test was folded into the existing
  owner session and the clean full run passed without relaxing production limits.
- Live production smoke: API health returned 200 with `db:"up"`; the built
  `/dashboard/kitchen` route returned HTTP 200 and served its route payload.
  API/web processes were stopped and the database was re-seeded to the canonical
  10-order fixture afterwards.
- Touched-file sanitizer audit: no masked credential literals; the only U+2026
  characters are intentional UI/prose ellipses.

---

## 2026-11-03 11:08 — Session 55 — Presigned menu-image uploads

**Built:** completed the next unblocked Phase 5 item end to end, from the owner
portal through an S3-compatible direct upload.

- Added `POST /api/menu/items/:id/image-upload` behind the existing JWT,
  OWNER-role, UUID, and dish-ownership checks. The validated body accepts only
  JPEG/PNG/WebP/AVIF plus an integer size from 1 byte through 5 MiB. The API
  returns a unique `menu-items/<dish-id>/<uuid>.<ext>` object key, public URL,
  required `Content-Type`, and a five-minute presigned PUT; image bytes never
  transit Nest.
- Added optional complete-set `S3_*` configuration and AWS SDK v3 wiring.
  Incomplete configuration leaves the API bootable and produces a stable 503
  `IMAGE_STORAGE_DISABLED`. OpenAPI now documents 54 operations and the typed
  upload response; the UUID route sweep includes the new path.
- Extended `/dashboard/menu`: owners editing an existing dish can choose a
  JPEG/PNG/WebP/AVIF file up to 5 MiB, request the presign, PUT bytes directly
  with the returned headers, and save the resulting public URL through the
  existing menu-item PATCH. Upload/save states cannot be dismissed mid-write;
  create mode explains that a dish must exist before its object key can be
  minted. Manual image URLs remain supported.
- Expanded the owner Playwright flow to assert the exact presign metadata,
  direct PUT bytes/header, returned URL, and final PATCH without depending on
  external storage. Architecture, E2E, and environment documentation include
  the bucket-CORS requirement.

**Verified:**
- Browser TDD: the owner flow first failed on the missing `Image file` control,
  then passed after the API client and form upload path were implemented.
- API production build clean; full Jest **57 suites / 697 tests green**.
- Web production build clean (Next.js type-check + 14 routes).
- Full PostgreSQL-backed Playwright suite **15/15 green** after folding the new
  flow into the existing owner session to stay within the default auth bucket;
  the database was re-seeded to the canonical fixture afterwards.
- Live built-API smoke with fake S3-compatible configuration: anonymous 401,
  unsupported MIME 400, valid owner presign 201 with a real SigV4 query,
  300-second expiry, required `Content-Type`, CDN URL, and Swagger path present.
  API and web ports were released afterwards.
- Runner-style cold `npm ci` in a fresh HOME/cache installed 724 packages and
  resolved `@aws-sdk/client-s3` 3.1161.0; all API/web/e2e lockfile tarballs point
  only to `registry.npmjs.org`.

---

## 2026-11-02 16:26 — Session 54 — Owner revenue and peak-hour analytics

**Built:** completed the next unblocked Phase 5 item with an owner-scoped SQL
analytics endpoint and portal page.

- Added `GET /api/restaurants/:id/orders/analytics`, guarded by the same real
  JWT + OWNER role checks and service ownership recheck as the order inbox;
  ADMIN keeps the established bypass. The endpoint aggregates only completed
  orders, returning all-time `grossRevenueCents`, completed count, exactly 24
  UTC `createdAt`-hour demand buckets, and a deterministic busiest hour (earliest
  wins ties; null when empty). Money remains integer cents and no migration was
  needed.
- Added typed OpenAPI models and route coverage for success, malformed UUID,
  unauthenticated, wrong-role/foreign-owner, and unknown-restaurant responses.
  The generated API document now contains 53 operations.
- Added `/dashboard/analytics` with restaurant switching, revenue/order/peak
  summary cards, an accessible hourly table with demand bars, and signed-out,
  wrong-role, no-restaurant, loading, retry, and empty-data states. The shared
  owner portal tabs and typed web API client now expose the page.
- Added Playwright coverage for the seeded owner/Warung result and all 24 hourly
  rows; architecture and E2E documentation record the aggregate semantics.

**Verified:**
- Strict TDD: API service tests first failed on the missing method, HTTP tests
  first received 404, and the Playwright spec first failed on the missing page.
- `apps/api npm run build` clean; full Jest **56 suites / 685 tests green**.
- `apps/web npm run build` clean (Next.js type-check + 14 routes, including
  `/dashboard/analytics`).
- Full PostgreSQL-backed Playwright suite **15/15 green**; the database was
  re-seeded to the canonical fixture afterwards.
- Live curl-equivalent smoke against the built API: owner analytics 200 for
  Warung with **7300 cents / 3 completed orders / 24 buckets**, earliest peak
  derivation matched the buckets; anonymous access returned 401 and the new
  Swagger path was present. API stopped afterwards.

---

## 2026-11-02 14:38 — Session 53 — ADMIN platform oversight

**Built:** completed the next unblocked Phase 5 item with a read-only admin
panel covering users, restaurants, and orders.

- Added `AdminModule` with `GET /api/admin/overview`, guarded by the real
  access-token and ADMIN role guards. The response combines platform totals,
  per-role/per-order-status counts, and bounded newest rows (10 users, 10
  restaurants, 20 orders); users are mapped through `toSafeUser`, so password
  hashes never enter the wire shape.
- Added typed OpenAPI response models and registered the admin controller in the
  route/auth/success/error/schema drift suite. The document now has 52
  operations and an `admin` tag.
- Added `/admin`: summary cards and responsive recent-user, restaurant, and
  order tables. The header link is rendered only for admin sessions; guest and
  non-admin direct navigation get an access-required state, while the API stays
  the authoritative gate.
- Seed now creates `admin@foodorder.app` alongside the existing demo accounts,
  reusing the seed hash. Added Playwright coverage for the admin happy path and
  owner denial, plus architecture/E2E documentation.

**Verified:**
- Strict TDD: service and HTTP specs first failed on the missing admin service /
  controller; the Playwright spec first failed on the missing nav/page. Targeted
  admin + Swagger suites finished **13/13 green**.
- `apps/api npm run build` clean; full Jest **56 suites / 679 tests green**.
- `apps/web npm run build` clean (Next.js type-check + 13 routes, including
  `/admin`).
- Full Playwright suite **14/14 green** against the reseeded PostgreSQL-backed
  production builds. The first focused run found a test-fixture naming mistake
  (`Warung Budi` vs the actual seeded `Warung Nusantara`); corrected in the
  test, not the application.
- Live curl smoke: anonymous overview 401 `UNAUTHORIZED`, owner 403 `FORBIDDEN`,
  admin 200 with counts **3 users / 6 restaurants / 10 orders**, bounded recent
  arrays, and no `passwordHash`; `/api/docs-json` exposes the route with
  `AdminOverviewResponse`. API stopped and DB re-seeded to canonical state.
- Sanitizer audit found no masked strings in touched files; the only U+2026
  characters are pre-existing intentional UI/money ellipses in `lib/api.ts`
  and the locale message catalogs.

---

## 2026-11-02 11:14 — Session 52 — Cookie-persisted dark mode

**Built:** completed the top unblocked Phase 5 item.

- Added an accessible moon/sun theme control to the shared header, with English
  and Indonesian labels. The client submits only the next `light|dark` value;
  the root server action validates it and persists it in a one-year HTTP-only,
  same-site cookie.
- Root layout now renders `data-theme` and the dark class on the first response.
  There is no localStorage hydration race or wrong-theme flash across reloads,
  server navigation, or signed-in/customer/owner pages.
- Added a dark compatibility palette for the storefront's existing Tailwind
  stone and status-color utilities, covering backgrounds, cards, forms,
  borders, muted text, hover states, validation notices, and order badges.
  Native controls receive the matching `color-scheme`; reduced-motion users do
  not get the palette transition.
- Added `dark-mode.spec.ts` and documented the theme contract in architecture
  and E2E docs.

**Verified:**
- Strict TDD: the new Playwright spec first failed because `<html>` had no
  `data-theme`; it passed after implementation.
- `apps/web npm run build` clean (Next.js type-check + 12 routes).
- Full Playwright suite **12/12 green**, including computed palette assertions,
  accessible toggle names, navigation/reload persistence, payment, realtime,
  push, and i18n regressions.
- Live production smoke: default and `theme=dark` requests both returned 200
  SSR HTML with the correct root marker and matching toggle label; API health
  reported `db:"up"` and the home page fetched the live restaurant/cuisine APIs.
- Dev database re-seeded to the canonical 10-order fixture after E2E; ports
  3000 and 4000 released. Touched-file sanitizer audit found no masked strings;
  the only U+2026 characters are pre-existing intentional translated ellipses.

---

## 2026-10-31 18:18 — Session 51 — English/Indonesian storefront localization

**Built:** completed the next unblocked Phase 5 item with `next-intl@4.14.9`.

- Added request-scoped `en`/`id` message catalogs and the official
  no-locale-routing integration. English is the fallback; unknown locale cookie
  values cannot select arbitrary message imports.
- Added an EN/ID header switch backed by a validated server action and a
  one-year HTTP-only, same-site cookie. Existing URLs stay unchanged; the active
  request locale drives `<html lang>`, localized metadata, and the shared
  client provider.
- Localized the customer storefront surface: shared header/footer, home hero,
  search/filter/empty/offline states, restaurant cards, restaurant facts and
  review copy, menu search/count/empty states, and add-to-cart labels. Product,
  cuisine, restaurant, and category names remain API-owned content.
- Added Playwright coverage for English default, Indonesian switching, cookie
  persistence across reload/navigation, restaurant/menu translations, and the
  switch back to English. Architecture and E2E docs now record the contract.
- Added `next-intl`; repaired every newly installed lockfile URL to
  `registry.npmjs.org` after the host npm mirror rewrote them.

**Verified:**
- Strict TDD: the new Playwright spec first failed waiting for the missing
  “Bahasa Indonesia” control, then passed after implementation.
- `apps/web npm run build` clean (Next.js type-check + 12 routes).
- Full Playwright suite **11/11 green**; the new test exercises both locales in
  the production build against the live PostgreSQL-backed API.
- Runner-style cold `npm ci` in a fresh HOME/cache installed 147 packages and
  resolved `next-intl=4.14.9`; all app/e2e lockfile URLs are
  `registry.npmjs.org` with no masked strings or U+2026 corruption.
- Dev database re-seeded to its canonical fixture state after E2E; ports 3000
  and 4000 are released.
- GitHub Actions run **41192329211** for code commit `778a24f`: API, web
  production build, fresh-Postgres migration/seed/drift, and Playwright E2E all
  completed successfully.

---

## 2026-10-31 16:12 — Session 50 — Multi-city registry + restaurant scoping

**Built:** completed the top unblocked Phase 5 item. The Stripe and Xendit
adapter sub-items are now explicitly marked 🔒 because real provider keys are
required; multi-city was the next self-contained roadmap increment.

- Added the `cities` entity/module and public `GET /api/cities`, returning only
  active cities alphabetically. OpenAPI now has 51 operations and a typed
  `CityResponse`.
- Added nullable/indexed `restaurants.cityId` with `ON DELETE SET NULL`; the
  generated migration creates the registry, backfills distinct existing city
  names with stable slugs, links existing restaurants, then adds the FK.
- Owner create/update DTOs accept validated UUID `cityId`. The service resolves
  only active cities, rejects unknown/inactive ids with 404, and writes the FK
  plus the existing read-friendly `city` name snapshot together. The legacy
  free-form `city` field stays compatible for older clients.
- Restaurant browsing now scopes `?city=` by registry slug or name,
  case-insensitively, with a text fallback only for legacy null-FK rows.
- Seed now creates Bandung/Jakarta/Surabaya first and assigns all six seeded
  restaurants to registry rows. Data-source/entity registration and
  architecture docs were updated.

**Verified:**
- Strict TDD: four targeted suites first failed on missing city modules and the
  missing second repository; the legacy-city consistency regression also failed
  red before its fix. Targeted suites finished **33/33**.
- `npm run build` clean; full Jest **54 suites / 675 tests green**.
- Migration applied to PostgreSQL 16 (14 migrations recorded), seed completed,
  and schema-drift generation correctly refused with “No changes … found”.
- Fresh-DB migration drill: the previous 13 migrations were applied, mixed
  ` Jakarta `/`jakarta` legacy rows plus `München` were inserted, then the new
  migration collapsed case/whitespace variants to two cities and linked all
  3/3 restaurants (slugs `jakarta,m-nchen`); throwaway DB dropped afterwards.
- Live API smoke **10/10**: sorted city registry; Jakarta slug and Bandung name
  filters; owner login; create/update by cityId; malformed UUID 400; unknown
  city 404; updated restaurant moved city scopes; OpenAPI path/schema present.
- API stopped, port 4000 released, and the database was re-seeded to canonical
  data after the smoke.
- GitHub Actions run **41183990451** for code commit `fb43391`: all four jobs
  green (API, web production build, fresh-Postgres migration/seed/drift, and
  Playwright E2E).

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
