# API load testing and baselines

Four k6 workloads live in `ops/`:

- `ops/load-test.js` — the READ-ONLY public storefront baseline. It bootstraps
  restaurant ids, then cycles through:

- `GET /api/restaurants?sort=rating&limit=20`
- `GET /api/restaurants/meta/cuisines`
- `GET /api/restaurants/:id`
- `GET /api/restaurants?search=rice&limit=20`

It does not create users, orders, payments, or other persistent data, and
never will — destructive traffic stays in its own scenario (below).

- `ops/load-test-auth.js` — the AUTHENTICATED WRITE scenario (session 82):
  per-VU signup, then browse → order → MOCK pay (intent → capture) →
  receipt/history reads. Runs ONLY against an isolated instance + disposable
  database; the full recipe is in "Authenticated write baseline" below.

- `ops/load-test-conditional.js` — the CONDITIONAL-GET replay scenario
  (session 104): one unconditional capture per iteration (asserts the
  session-103 cache headers) followed by two `If-None-Match` replays that
  MUST be 304. Read-only; aborts loudly if the target answers without a
  strong ETag + `Cache-Control: public` (e.g. `HTTP_CACHE_TTL_SEC=0`),
  because that would measure nothing. Since session 108 both legs send
  browser-shaped `Accept-Encoding: gzip` (k6's default is identity and
  would measure an unencoded wire the profile ships compression for),
  record per-leg `capture_ms`/`replay_ms` trends, and pin a numeric
  Content-Length on the capture — that header is the honest wire-size
  signal (k6 decompresses at the JS layer).

- `ops/load-test-write.js` — the WRITE LADDER over the cached+compressed
  stack (session 121, Phase 12): anonymous cache-whitelisted browse GET ->
  signup -> order create -> payment intent -> capture -> receipt. Contracts:
  ZERO 429s (any throttled response aborts the run, naming the bucket), and
  under `CACHE_ARM=on` (default) every browse response must prove the
  strong ETag + `Cache-Control: public` + the both-sides-of-1024B gzip
  threshold (>= decoded -> `Content-Encoding: gzip` + numeric encoded
  Content-Length; < -> byte-transparent identity). `CACHE_ARM=off` pairs
  with an `HTTP_CACHE_TTL_SEC=0` boot for the control arm. Creates real
  rows: same isolated-rig rule as the auth scenario. This profile caught
  the `orders.code` birthday-collision 500 — see "Write ladder under the
  cached+compressed stack" below.

Pure helpers (cart planning, payload shape, profiles) live in
`ops/load-test.lib.mjs` and are pinned by `ops/load-test.contract.test.mjs`
(`node --test ops/load-test.contract.test.mjs`).

The WRITE LADDER smoke arm is additionally guarded by a SCHEDULED runner —
`ops/perf-check.sh` (session 124): scratch DB + boot + k6 + exact DB
cross-check, exiting 0 green / 1 regression / 2 rig broken like the
alert-scan doctrine. See "Scheduled write-ladder regression check" below.

## Run it

With k6 installed:

```bash
BASE_URL=http://127.0.0.1:4000/api PROFILE=smoke k6 run ops/load-test.js
BASE_URL=http://127.0.0.1:4000/api PROFILE=load k6 run ops/load-test.js
BASE_URL=http://127.0.0.1:4000/api PROFILE=smoke k6 run ops/load-test-conditional.js
BASE_URL=http://127.0.0.1:4100/api PROFILE=smoke k6 run ops/load-test-write.js   # scratch rig!
```

Or without a host installation:

```bash
sudo docker run --rm --network host \
  -v "$PWD/ops:/scripts:ro" \
  -e BASE_URL=http://127.0.0.1:4000/api \
  -e PROFILE=load \
  grafana/k6:latest run /scripts/load-test.js
```

Profiles:

- `smoke`: 1 VU for 15 seconds.
- `load`: ramp 0→10 VUs for 30 seconds, 10→25 for 1 minute, hold 25 for
  1 minute, then ramp to zero for 30 seconds.

The run fails when any threshold is missed:

- HTTP failure rate `< 1%`
- HTTP duration p95 `< 500 ms`
- HTTP duration p99 `< 1,000 ms`
- check success rate `> 99%`

Run only against an environment you are authorized to test. The default target
is localhost; set `BASE_URL` explicitly for every non-local run.

## Baseline — November 4, 2026

Environment:

- Local loopback between k6 and the production Nest build
- 2 vCPU (`AMD EPYC 7K62`), 1.9 GiB RAM
- Node.js 22.23.2
- PostgreSQL 16.15, canonical seed: 6 restaurants
- k6 2.3.0 in Docker

Results:

| Profile | Requests | Throughput | Failed | Checks | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|
| Smoke, 1 VU / 15 s | 75 | 4.98 req/s | 0% | 223/223 | 4.30 ms | 5.49 ms | 8.09 ms |
| Load, peak 25 VUs / 3 min | 15,027 | 83.41 req/s | 0% | 45,079/45,079 | 4.06 ms | 8.17 ms | 44.77 ms |

All thresholds passed and all 15,026 load-profile iterations completed without
interruption. `/api/health` still reported `status: ok` and `db: up` after the
run.

These numbers are a regression baseline, not a production capacity claim: the
client and server shared one host, there was no network/TLS/proxy overhead, and
the seed dataset is intentionally small.

## Authenticated write baseline — November 12, 2026 (session 82)

`ops/load-test-auth.js` implements recommendation 5 below: a full paying
customer cycle — **signup → browse → order → pay (MOCK gateway)** — kept in a
separate script so it is never mixed into the public browse baseline. One
iteration = 7 requests: auth signup (first iteration of each VU only),
`GET /restaurants/:id` (authenticated), `POST /orders`, `POST /payments`
(intent), `POST /payments/:id/capture`, `GET /orders/:id` (receipt, bearer
rung), `GET /orders/my?limit=5`, then 1 s think-time. The storefront cart is
client-side localStorage; its API-side equivalent is the menu browse +
order-create pair, and the cart plan (clear `minOrderCents` in integer cents,
per-line quantity capped at the DTO's 50, rotate dishes by iteration) is a
pure helper pinned by the ops contract test.

The scenario writes real rows, so the rig is isolated end-to-end:

```bash
# from apps/api, on top of the untracked .env — a scratch DB, relaxed guardrails
# (the JWT secret needs NO export — ConfigModule loads it from .env; the
#  process-env DATABASE_URL/PORT overrides below win over it)
export DATABASE_URL="${DATABASE_URL%/*}/foodorder_k6load" PORT=4100
export RATE_LIMIT_AUTH_MAX=20000 RATE_LIMIT_ORDERS_MAX=20000 RATE_LIMIT_PAYMENTS_MAX=20000
sudo -u postgres psql -c "CREATE DATABASE foodorder_k6load OWNER foodorder"
npm run migration:run && npm run seed && node dist/main.js &
# k6 hits it from docker (--network host); see the public section for the pattern:
#   -v "$PWD/ops:/scripts:ro" -e BASE_URL=http://127.0.0.1:4100/api -e PROFILE=smoke|load
#   grafana/k6:latest run --summary-export=/out/<tag>.json /scripts/load-test-auth.js
```

The relaxed buckets are boot-time env on this throwaway instance ONLY (the
default production limits — 10 auth / 30 orders / 10 payments per minute —
would 429-shed this traffic, and a 429 would pollute the latency sample).
Signup emails are always `loadtest-vu*@load.test`, which makes the post-run
database cross-check exact: every `orders_placed`/`payments_captured` counter
value was asserted against actual rows — orders all present, `pending`, each
holding exactly one `succeeded` payment; users = 1 (smoke) / 10 (load).

Profiles: `smoke` = 1 VU × 30 s. `load` = ramp to 5 VUs (20 s), to 10 (40 s),
hold 10 × 1 min, ramp down (20 s). The plateau is 10, not the browse
profile's 25: write iterations own a DB transaction, so this is the
apples-with-apples comparison for a write path.

Environment: same host as the November 4 baseline (2 vCPU EPYC, 1.9 GiB RAM,
Node 22.23.2, PostgreSQL 16.15, canonical 6-restaurant seed, k6 **v2.3.0** in
Docker, loopback). The payment-confirm gate stayed at its shipped default
(the flow pays and never owner-confirms, so it exercises the same path a
customer's does).

Results (all thresholds green, 0 failed checks):

| Profile | Iterations | Requests | Throughput | Failed | Checks | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Smoke, 1 VU / 30 s | 29 | 176 | 5.76 req/s | 0% | 233/233 | 15.97 ms | 33.80 ms | 140.88 ms |
| Load, peak 10 VUs / 2m20s | 992 | 5,963 | 42.40 req/s | 0% | 7,937/7,937 | 13.69 ms | 24.14 ms | 126.76 ms |

The load profile sustained **~7.05 order-creates/s** (each: transactional
stock guard + order + line items + server re-pricing) plus 2 payment calls and
3 reads per iteration at sub-15 ms p95; average iteration wall time was 1.04 s
(think-time dominated — the server-side work was ~40 ms per iteration).
`/api/health` reported `status: ok` after the run; the scratch DB was dropped.

Same caveats as the public baseline: shared-host loopback, tiny seed dataset,
and the MOCK gateway settles synchronously — a real PSP round-trip will add
its own latency to the two payment calls, not to our server time.

Harness lessons from the first runs (all spec-side, zero product bugs):
k6's `Counter` is a **named** export of `k6/metrics`; a `http.post` with a
JSON string body but no `Content-Type` header reaches Nest as an unparsed
body (the 3 validation errors were correct behaviour); the summary-export
reports checks under `passes`/`fails` (not `pass`/`fail`); and the k6
container runs unprivileged, so the `--summary-export` directory must be
world-writable. Postgres side: `coalesce(<enum>, 'text')` needs an explicit
`::text`, and `GROUP BY 1` over a `col||'='||count(*)` expression is illegal —
group by the column.

## Storefront list-path audit — November 12, 2026 (session 79)

Phase 6 roadmap item "N+1 sweep on `/restaurants`". Method: Postgres
`log_statement='all'` scoped to a throwaway DB, seeded then inflated to
**8,994 restaurants + 53,955 menu items**, the API booted against it, and
every storefront list shape curl'd inside a marker-bracketed time window;
statement counts read back from the server log, plans via
`EXPLAIN (ANALYZE, BUFFERS)`.

Verdicts:

- **No N+1 exists.** `GET /restaurants` emits a CONSTANT 3 statements at
  `limit=1` and `limit=50` alike (list + count + ONE batched-IN hours pass —
  the session-68 batching holds). The old `menuItemCount subqueries` hint in
  the roadmap predates sessions 65–68's batched attaches and found nothing.
- **`/restaurants/meta/cuisines` was the real cost.** It loaded every row as
  a FULL entity (width 331, `ORDER BY name`, 3.1 MB quicksort at 9k rows) and
  de-duplicated in Node to answer a 12-value question. Now one
  `SELECT DISTINCT cuisine` (width 8, HashAggregate; plan cost 1054→486,
  and no 9k-object hydration per request in Node).
- **`search=` was un-indexable BY CONSTRUCTION.** `LOWER(col) LIKE '%t%'` —
  a function call on the column — can never use an index. Rewrote to plain
  `col ILIKE` (identical case-insensitive substring semantics) with LIKE
  metacharacters escaped, matching the `/api/search` rule; added the missing
  GIN `gin_trgm_ops` partner index on `cuisine` (session 69 covered
  name/description only, and an OR bitmap-scans only when EVERY arm has an
  index). Post-change plans: `bowl` BitmapOr over both trgm indexes
  (cost 553→489, heap hits 374→384 spread across bitmap fetches), selective
  `sate` touches **10 shared buffers vs 374** for the full scan, and the
  cuisine-only arm `east` is served by the new index (900 rows via
  `IDX_restaurants_cuisine_trgm`).
- **`city=` cost a 4th statement.** `leftJoin('r.cityEntity')` + skip/take
  flips TypeORM into its DISTINCT-ids two-query strategy. Replaced with a
  single-WHERE EXISTS semi-join (identical rows): probe back to 3 statements.
- **Sort indexes: deliberately NOT added.** The rating/createdAt/fee
  top-N sorts at 9k rows scan 374 pages already in `shared_buffers` and
  heapsort in ~40 kB — sub-millisecond. Adding btrees here would overfit,
  exactly the trap this document has warned about since November 4. If
  production telemetry shows the tables growing into hundreds of MBs,
  revisit `ORDER BY rating DESC` first.

## Admin panel bundle audit — November 14, 2026 (session 90)

Phase 8 roadmap item "admin panel bundle trim". Scope: client JS only,
the `/admin` route. Method: cold `rm -rf .next && next build` for the route
table, plus an EXACT measurement — summing gzip-9 sizes of every chunk
listed for `/admin` in `.next/app-build-manifest.json` (the rounded table
hides deltas this small).

Change: `TrafficPanel` moved from a static import to `next/dynamic`
(`ssr: false`). The page already renders it strictly behind
`metrics != null`, and a `dynamic()` chunk request only starts at first
RENDER — so the panel's chunk is fetched behind the `GET /api/admin/metrics`
round-trip, and on a metrics outage or 401 it is never downloaded at all.

Numbers (same tree, static import vs dynamic split):

| | BEFORE | AFTER | delta |
|---|---|---|---|
| `/admin` first-load JS (manifest gz sum) | 113,561 B | 113,295 B | **−266 B** (raw 386,660 → 384,466, −2,194 B) |
| route table | 4.84 kB · 114 kB | 4.54 kB · 113 kB | (rounding of the same gz bytes) |
| page chunk | 18,521 raw / 4,840 gz | 16,304 raw / 4,555 gz | panel code left the chunk |
| deferred async chunk | — | 5,818 raw / 1,962 gz | fetched only when metrics resolves |

Honest framing: the trim is SMALL because `TrafficPanel` is compact pure-DOM
React (no chart library — the "charts-adjacent DOM" label overstated it).
A successful visit nets −266 B gz (the async chunk costs more standalone
than inlined: `dynamic()` wrapper + its own compression dictionary). The
guaranteed win is the FAILURE path: zero panel bytes when metrics is
unavailable. No further split is warranted — the remaining 16 kB page chunk
is the three tables themselves, which are the route's reason to exist.

Verified: served-`/admin` HTML script tags list the new page chunk and
contain the async chunk hash **0 times** (not in first payload);
`admin-traffic.spec.ts` 2/2 green — lazy mount still mirrors the payload
DOM-for-DOM; full e2e suite green after the change.

## Public-read HTTP cache — November 18, 2026 (session 103)

`HTTP_CACHE_TTL_SEC` (default 15, `0` disables) puts a strong-sha256 ETag +
`Cache-Control: public, max-age=N` + `Vary: Authorization` in front of the
three anonymous public browse reads (`GET /api/restaurants`,
`GET /api/restaurants/:id`, `GET /api/search`), served from an in-process
URL-keyed store (500-entry cap, evict-oldest). The whole point is the DB:
the live smoke bracketed every request in query-logger windows and counted
statements per window:

| Window | Outcome | Statements |
|---|---|---|
| first read (capture) | 200 | 2–8 (real reads; list path = 2) |
| repeat read within TTL, no INM | 200 from store | **0** |
| `If-None-Match` within TTL | **304** | **0** |
| distinct `?limit=` variant first read | 200 | 4 |
| per-restaurant detail revalidation | 304 | **0** |
| after TTL expiry + INM, unchanged bytes | 304 | ≥1 — the read HAPPENS, the transfer is skipped |

The expiry row is the honest boundary: without a cheap server-side version
stamp, `max-age` only postpones the read, it does not cancel it after
expiry. What IS cancelled is the byte transfer and (within the TTL) the
read itself.

Metrics interaction (the roadmap asked for it): served hits keep their
samples because the cache middleware is registered after the metrics and
access-log listeners hook `finish`; the per-restaurant mint rule was
tightened from 2xx/3xx to **2xx only**, so a cold revalidation can never
mint a bucket, it only tops up `byStatus.3xx` (live: keys stable across a
304, `3xx` increments; the metrics-read exemption unchanged).

Latency shape: cache-served requests skip the pool entirely — on the live
dev boot a mixed capture/serve row averaged 5.8 ms across 4 samples with
the FIRST pool read still inside it; re-measure the served-only shape via
the k6 baseline (recommendation 6), which is where the throughput claim
belongs.
Staleness contract: `isOpenNow` on a cached copy can lag the clock by at
most the TTL; e2e boots the API with `HTTP_CACHE_TTL_SEC=0` so the suite
never reads a cached copy.

## Public browse re-baseline under the HTTP cache — November 18, 2026 (session 104)

PERFORMANCE.md recommendation 6: re-run the public browse profile now that
the three read routes are ETag-cached (session 103), as a NEW baseline —
never restated against the November 4 numbers. Same host (2 vCPU EPYC,
1.9 GiB RAM, Node 22.23.2, PostgreSQL 16.15, canonical 6-restaurant seed,
k6 **v2.3.0**), same scratch rig: fresh 28-migration chain + seed into
`foodorder_k6reb`, production build booted on :4100, k6 via `--network
host`. The API arm differs per run: `HTTP_CACHE_TTL_SEC=0` (control) vs
the shipped default `15`.

Results (all thresholds green, 100.00% checks, 0.00% failed requests):

| Profile | Arm | Iterations | Requests | Throughput | avg | p95 | p99 | Max |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| browse `load` | TTL=0 control | 14,982 | 14,983 | 83.15 req/s | 2.67 ms | 5.07 ms | 9.16 ms | 60.21 ms |
| browse `load` | **TTL=15 cached** | 15,111 | 15,112 | 83.86 req/s | 1.02 ms | **2.52 ms** | 4.7 ms | 37.63 ms |
| conditional `load` | TTL=15 replay | 15,048 | 45,145 | **250.74 req/s** | 0.55 ms | **1.29 ms** | 2.4 ms | 14.27 ms |

- **The cached arm halves p95** (5.07 → 2.52 ms) at identical iteration
  rate. k6 ships no HTTP cache and never sends `If-None-Match` on its own,
  so this gain is purely server-side: the served 200 skips the pool and
  the bytes hash.
- **The conditional arm measures the 304 path head-on**: 3 requests per
  iteration (1 capture + 2 replays, every replay answered 304 with the
  echoed ETag and an empty body — 150,481 checks all green). At the same
  25-VU shape the request count triples: 45,145 requests at 250.7 req/s,
  median 0.35 ms. This is the transfer-skipped ceiling, not a browse-
  throughput restatement.
- **Statements-per-request collapsed**, proven with the query logger
  (`log_statement='all'` ALTER DATABASE-scoped, marker-bracketed windows,
  run-unique markers, one full load profile each):

| Arm (load profile) | Requests | Logged statements | stmt/req |
|---|---:|---:|---:|
| browse TTL=0 (control) | 14,968 | 29,939 | **2.000** — the session-79 constant shape exactly |
| browse TTL=15 | 15,115 | 3,959 | **0.262** (7.6× collapse; ≈ the 25% always-SQL `meta/cuisines` quarter + per-URL TTL re-captures) |
| conditional TTL=15 | 45,139 | 144 | **0.003** (≈625× below control; 140 TTL re-capture SELECTs + one metrics-snapshot INSERT/DELETE cycle — replays never touch SQL) |

Harness lessons from the first conditional run (spec-side, zero product
bugs): k6 runs on Go, so response header names arrive **canonicalized**
over the JS bridge — `ETag` surfaces as `Etag`; reading `headers['ETag']`
yields undefined and the honest abort fired exactly as designed. The
profile's loud-abort contract (strong ETag + `Cache-Control: public` or
stop) is what caught it; TTL=0 itself stays byte-transparent (verified:
no `Cache-Control`, Express's weak auto-etag only, replay 200s — the
contract test keeps the three replay paths inside the session-103
whitelist, `/restaurants/meta/cuisines` deliberately excluded because it
can never 304).

## Response compression of the public browse payloads — November 19, 2026 (session 108)

Phase 10: gzip on top of the session-103 cache for the THREE whitelisted
reads (`GET /api/restaurants`, `/api/restaurants/:id`, `/api/search`). The
store keeps UNCOMPRESSED bytes and the strong ETag stays the sha256 of the
decoded payload — identical validator across the gzip and identity
variants (live curl proof: `sha256first32(gunzip(wire)) == ETag` on all
three paths, and the identity variant byte-equal to the decoded gzip
variant). `HTTP_COMPRESS_MIN_BYTES` (default 1024, `0` off, garbage ->
default) scopes the layer: non-whitelisted routes, HEAD, POST, 4xx/5xx and
sub-1 KiB bodies never see a res wrapper at all; `Vary` gains
`Accept-Encoding` ONLY on actually-encoded responses; 304s stay bodiless
and the zero-SQL revalidation claim survives under gzip (query-logger
window: 0 statements across a 304 + two store-served hits, one of them
re-encoded).

Results (all thresholds green, 100.00% checks, 0 failed requests; same
host and k6 v2.3.0 rig as session 104, fresh 28-migration scratch DB,
production build on :4100):

| Profile | Arm | Iterations | Requests | Throughput | avg | p95 | p99 | Max | data_received |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| conditional `load` | `HTTP_COMPRESS_MIN_BYTES=0` control | 15,043 | 45,130 | 250.58 req/s | 0.56 ms | 1.31 ms | 2.68 ms | 23.3 ms | 62.0 MB (1,375 B/req) |
| conditional `load` | **gzip (default)** | 15,022 | 45,067 | 250.32 req/s | 0.66 ms | 1.53 ms | 2.97 ms | 37.2 ms | **28.5 MB (633 B/req)** |
| capture leg only (`capture_ms` trend) | control | 15,043 | — | — | 0.605 ms | 1.32 ms | — | 23.3 ms | — |
| capture leg only (`capture_ms` trend) | **gzip** | 15,022 | — | — | 0.778 ms | 1.64 ms | — | 35.4 ms | list 6,914 -> 1,924 B (**72% off**) |

- **Wire bytes are the headline**: the conditional profile's total bytes
  received collapse 62.0 -> 28.5 MB (**54%**, driven by the per-path 72%
  on the restaurant list; the 304 replays are already bodiless and stay
  unchanged). The capture-leg `Content-Length` IS the encoded length
  (byte-exact, not chunked) — k6 reports it as 1,924 vs 6,914.
- **Throughput holds**: 250.32 vs 250.58 req/s at the identical 25-VU
  shape; the per-leg trends (new `capture_ms`/`replay_ms` in
  `ops/load-test-conditional.js`) put the gzip cost exactly where it
  belongs — the capture leg pays ~+0.3 ms at p95 for the per-request
  `gzipSync`, the replay leg is unchanged inside run noise. On this
  2 vCPU box the CPU was the constrained resource; headroom is bought
  with bandwidth, not latency.
- **The profile itself changed (session 108)**: k6 sends
  `Accept-Encoding: identity` by default, so BOTH arms now explicitly
  request `Accept-Encoding: gzip` (browser-shaped) and k6 decompresses at
  the JS layer — every existing check still reads decoded JSON; the raw
  `Content-Length` header is the honest wire-size signal. A loud
  numeric-`Content-Length` check was added to the capture contract.
- Cross-check against session 104: its control row (1.29 ms p95 aggregate,
  250.74 req/s) is what the B2 row reproduces — the replay-heavy shape is
  stable, and neither arm regressed it.

## Write ladder under the cached+compressed stack — November 23, 2026 (session 121)

Phase 12 Test item: session 104's conditional profile never exercised
writes, and the session-82 write ladder predates the cache and read the
restaurant detail BEARER'd — an anonymous-whitelist opt-out, so no write
baseline had ever touched the cached+compressed stack. `ops/load-test-write.js`
fills the gap: each iteration is an anonymous cacheable browse GET (also
proving the layers, or aborting), signup once per VU, order create, payment
intent + capture, and the bearer receipt read (pinned NOT cache-marked —
the layers stay byte-transparent off-whitelist).

**The first run did exactly what a write profile is for: it caught a REAL
product bug.** After 160 successful orders in the load arm (~200 rows on the
table counting seed + smoke), order-create answered 500 with
`duplicate key value violates unique constraint` on `orders.code`. The
column is UNIQUE while `generateCode()` drew 4 characters from the 31-char
alphabet via `Math.random()` with no collision guard — birthday-paradox
collision odds that grow QUADRATICALLY with table size (already ~2% by
200 rows, near-certain past ~1.6k), a time bomb that scales with business
volume (session 82's 992-order baseline sat on the lucky side of the curve).
Fixed in the same session: 6-char draws from `crypto.randomInt` (31^6 ~ 887M),
AND the create unit-of-work now re-runs up to 3 times on SQLSTATE 23505
with a FRESH code per attempt. The retry is safe by construction: the
failed INSERT rolls the whole transaction (stock decrements included) and
`em.save` re-mints the PK, so nothing double-takes; inside that transaction
the by-chance-collidable constraint is only the random code (promo caps
re-check under FOR UPDATE and raise plain 400s). Past the bound the
violation rethrows — the pre-fix behavior becomes the last resort, not the
first hit. +5 unit specs (`order-code-collision.spec.ts`) pin format, the
redraw-per-attempt, the non-unique pass-through, the exhaustion, and the
promo ledger surviving the extraction; a 13/13 live smoke proves the retry
DETERMINISTICALLY on the real driver — a BEFORE INSERT trigger raises 23505
on exactly the first two attempts (counter via `nextval`, since a table
UPDATE inside the trigger rolls back with every aborted transaction — first
smoke run burned that lesson), the bounded give-up writes NOTHING, and a
24-way concurrent create burst lands 24/201s with unique well-formed codes.

Rig: same host (2 vCPU EPYC, 1.9 GiB RAM, PostgreSQL 16, canonical
6-restaurant seed, k6 v2.3.0 in Docker `--network host`), fresh
`foodorder_k6write` on the full 29-migration chain + seed, production build
on :4100, `RATE_LIMIT_{AUTH,ORDERS,PAYMENTS}_MAX=20000` boot-time only on
this throwaway instance (shipped defaults are per-IP 10/30/10 per minute —
the payments bucket alone caps the ladder at 5 iterations/min/IP, so a
honest write baseline relaxes it exactly like session 82; the zero-429
assertion then proves THIS run was limiter-free). Arms: shipped defaults
(TTL 15 + gzip 1024) vs `HTTP_CACHE_TTL_SEC=0` control with compression
still ON (`CACHE_ARM=off` skips only the cache-header assertions).

Results (all thresholds green, 100.00% checks, 0 failed requests, 0 429s):

| Arm | Iters | Requests | req/s | avg | p95 | max | browse leg avg | write legs avg | Checks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **cached (TTL 15, shipped)** | 506 | 2,536 | 18.09 | 6.05 ms | **12.71 ms** | 93.3 ms | **1.53 ms** | 25.6 ms | 6,076/6,076 |
| control (TTL 0, gzip on) | 505 | 2,531 | 18.01 | 7.01 ms | 13.79 ms | 128.0 ms | 5.22 ms | 26.8 ms | 4,546/4,546 |

Statements-per-request (query logger `log_statement='all'`, run-unique
`MARK_`-bracketed windows, `LOG: (statement|execute)` counted, DETAILs
ignored):

| Arm | Requests | Logged statements | stmt/req |
|---|---:|---:|---:|
| cached | 2,536 | 18,021 | **7.11** |
| control | 2,531 | 20,237 | **8.00** |

Honest reading: only an 11% collapse (vs the browse baseline's 7.6x) BECAUSE
the write legs dominate SQL — the cache covers ONE of five requests per
iteration. What it does buy: every in-TTL browse re-read costs ZERO
statements (browse leg 5.22 -> 1.53 ms avg) and the create+intent+capture
legs are untouched by the layers (~26 ms avg both arms) — compression and
cache are byte-transparent for writes, pinned per iteration by the receipt
check. (The cached window carries one 5-statement background snapshot tick;
the control window none.)

Post-run DB cross-check EXACT: 1,011 new orders in the two windows
(506+505 = the `orders_placed` counters), every one `pending` with exactly
one `succeeded` payment, 10 signup users (5 VUs x 2 arms), zero duplicate
`code` rows across the final 1,287-order table, zero rows outside the
seed-format + new-6-char grammar, zero 5xx lines in either API log window
(all post-fix 500s in the log belong to the deliberate smoke trigger).
`/api/health` `status: ok` after the run; scratch DB dropped.

Other harness lessons (all spec-side): the trigger helper table AND sequence
need `GRANT ... TO foodorder` — the trigger body runs as the APP role, and
an ungranted helper 42501s into a misleading 500 (the session-109 ownership
trap, re-earned); and a 500-class "PASS" must be attributed (the log stack
naming the simulated collision is now asserted, not the status code alone).

Smoke arm for the shape: 1 VU x 30 s, 29 iterations, 147 requests,
4.84 req/s, 352/352 checks, p95 16.6 ms, 0 429s.

## Search-shaped whitelist coverage — November 24, 2026 (session 126)

Phase 13's cache-whitelist decision item, resolved as **KEEP**: session
103 already whitelisted `GET /api/search` (full-URL keys, shared
500-entry evict-oldest store, template attribution) — the open part was
the explicit decision record (now in ARCHITECTURE.md) and the fact that
**no k6 profile ever rode the search route** (the list `search=` filter
is a different template; session 104's own leftover said so). Both
rotations gained a `/search?q=nasi&limit=10` leg: public browse is now a
FIVE-shape rotation, conditional replay a FOUR-shape one;
`ops/load-test.contract.test.mjs` pins every replay shape against the
`cacheTargetOf` template set (exact-path + uuid-gated mirror).

Live proof on a from-empty 29-migration scratch DB (TTL=60, snapshot
writer off, production dist on :4010; query-logger windows, run-unique
markers; 44/44 asserts, zero product bugs, zero 5xx, zero writes):

| Window | Outcome | Statements |
|---|---|---|
| `?q=nasi` capture | 200, strong quoted ETag, `public, max-age=60` | 3 |
| repeat within TTL, no INM | 200 served from store | **0** |
| `If-None-Match` within TTL | **304**, empty body | **0** |
| distinct `?q=sushi` first read | 200, DIFFERENT ETag (per-query keys) | 3 |
| bearer read | 200, NO Cache-Control (full opt-out) | 3 |
| anon repeat after bearer | still served, same ETag | **0** |
| 499 unique-query flood | every one captured | 998 (2/query) |
| newest flood entry replay | 304 — resident | **0** |
| OLDEST entry after the flood crossed the cap | 304, but honest re-read | 3 |
| 501st set: it evicted S2 too | capedge + S2 both re-read | 5 |

The eviction rows are the decision's spine: fan-out is real (a unique
`q` never hits), but the bounded store makes the worst case exactly a
re-read — never stale serving, never unbounded memory. Attribution
closes arithmetically: `GET /api/search` answered 6 requests as
`{2xx:5, 3xx:1}` after the ladder, 510 with `2xx+3xx` matching the total
after the churn, and the two k6 smoke arms grew the row to 579 with the
search legs included (conditional arm 74 iters / 223 reqs / 100% checks,
p95 2.15 ms — capture p95 3.90 vs replay p95 1.55; browse arm 75 iters /
76 reqs, 100% checks). These are SMOKE-arm numbers on a TTL=60 boot —
they do not restate session 104's load table, whose rotation recorded
there deliberately excludes the search leg as measured at the time.

API source untouched (jest delta 0, 102/1380), web delta 0.

## First Load JS+CSS budget gate — November 21, 2026 (session 115); ancestor-chain revision November 23, 2026 (session 118)

Phase 11 roadmap item "Perf: First Load JS budget gate". A zero-dep node
script, `apps/web/scripts/check-bundle-budget.mjs`, is the CI `web` job's
build-post step: after `next build` it reads `.next/app-build-manifest.json`
and FAILS the job when any core storefront route's exact first-load payload
exceeds the baseline table below.

Metric, as of session 118: gzip-9 sum of EVERY `.js` AND `.css` chunk
listed for the route's own manifest entry PLUS every ancestor layout entry
(`/layout` down to `${route}/layout`), each file counted once. The original
session-90 method summed only the route's OWN chunks, which session 117
proved blind: the root layout chunk and the global CSS chunk are not listed
for ANY pinned page, so SkipLink's real +209 B gz into `app/layout-*.js`
landed at margin +0 on all seven routes. Next's own printed table shares
the blind spot (its per-page `First Load JS` is Size + shared, no layout or
CSS rows) — the chain sum is deliberately broader: it is what the browser
actually loads on first paint. For `/` that is 135,768 B vs the printed
"107 kB": +6,749 B CSS, +12,087+2,148+4,117 B of client chunks reachable
only via the root layout, +3,704 B layout module.

Why exact bytes: the route table rounds to 1 kB and hides small deltas
(session 90 proved a 266 B gz win invisible there; session 117 a 209 B
layout loss).

Baseline = CI-MEASURED numbers (session 118): re-measured on a cold
`rm -rf .next && next build` from a CI-CLEAN checkout — no gitignored
`apps/web/.env.local`: a defined `NEXT_PUBLIC_API_URL` define-folds
`lib/api.ts`'s fallback branch and moved one shared client chunk (7621)
−39 B on EVERY route (session 115's +39-B anecdote was the same mechanism
seen through the old own-entry sums). Why CI is the source of truth:
absolute gzip sums are PATH-SENSITIVE — the `main-app-*` and
`app/layout-*` chunk hashes and sizes embed the checkout path, so the dev
box (`/home/...`-short) and the runner (`/home/runner/work/<repo>/<repo>`)
build those two chunks differently (measured by session 118's live A/B:
identical files everywhere else, −1/+6 B on exactly the two, under byte-
identical Node 22.23.2 + zlib 1.3.1-e00f703 on both sides; the Node-pin
arms of that A/B resolved to the SAME version, so it could not test a
Node delta — session 119 then proved one exists: the runner image moved
22.23.2 → 22.23.5 and rebuilt byte-identical app code, shifting every
route's sum exactly +5 B (annotation per-file diff across runs
45097501585/45120203711: ONE chunk, 2619-*.js, 3385 → 3390 gzip; shared
and counted once per chain, hence uniform). The web CI job is PINNED to
the measured version (22.23.5); a deliberate runner-Node upgrade now
means re-measuring the table on CI). The old own-entry sums agreed
across environments only because the path-embedded chunks happened to
compress to equal sizes there — luck the chain metric no longer relies
on. Runners are path-stable, so these numbers are; the local `next build`
gate run will show a phantom +4..+6 B margin on every route (local chunks
are the smaller side of the two path-embedded ones) — compare via
in-path `--print` A/B (session-117 doctrine) or read the CI annotations
the gate emits on failure (`bundle-budget`/`bundle-chain` titles,
anonymously API-readable). The prior CI-CLEAN reproducibility still
holds IN-PATH: the old-method own-entry sums of the same local build
reproduced the session-115 table byte for byte. Lockfile-pinned, so CI
rebuilds reproduce these bytes modulo runner-image changes. Tolerance is
ZERO by design — like the schema-drift gate, growth is either shrunk
back or re-measured deliberately on CI (or an exact-path replica build),
committing the new numbers WITH the change that grew the bundle.

Route set = the core storefront funnel (home, restaurant detail, cart,
checkout, map, receipt, order history). Portal routes (`/admin`,
`/dashboard`, `/driver`) are not budgeted yet — session 90/114 covered
their split decisions separately.

<!-- BUNDLE-BASELINE-START -->
| Route | Baseline First Load JS+CSS, full chain (B, CI-measured, node 22.23.5) |
|---|---|
| `/` | 135778 |
| `/restaurants/[id]` | 138849 |
| `/cart` | 139311 |
| `/checkout` | 142338 |
| `/map` | 137016 |
| `/orders/[id]` | 159683 |
| `/orders/my` | 144309 |
<!-- BUNDLE-BASELINE-END -->

Session-120 note: `/cart` re-adopted to the CI-measured 139306 (the
`mobile-cart-clear` testid cost +2 B over the old row). The SAME run
measured every untouched route 5 B UNDER the table — shared chunk
2619-*.js back at gzip 3385 despite the pinned runner node 22.23.5 — so
session 119's "runner Node patch drift" attribution is NOT the sole
stabilizer; the untouched rows deliberately keep that +5 headroom rather
than re-measuring a wobbly number down onto the baseline.

Session-124 note: CI run 159 (a DOCS-ONLY commit — zero web files) measured
`/cart` 139311, +5 B over the row, and failed the gate; the very next run
(160, same untouched web tree) passed it. The ±5 band is therefore
two-sided and live, exactly as session 120 suspected — `/cart` re-adopted
ONE LAST time to the failing run's CI-measured 139311 (session-120
ritual), untouched rows keep their incidental headroom. Postmortem of that
run also drove a gate fix: every row used to publish `::error` annotations
once ANY route violated, so exact-at-budget routes read as failures beside
the single real +5 B — annotations now carry per-route LEVEL (violated
`::error`, within-budget `::notice`, a passing gate emits zero `::error`),
pinned as the 16th selftest case.

The gate is dead-gate-proofed (session-106 doctrine): it fails on a missing
manifest, missing/empty/duplicate-row/unparseable baseline table, a baseline
route absent from the build (renamed/deleted route would otherwise freeze
the table silently), and a listed chunk absent on disk. The full decision
table lives in `scripts/check-bundle-budget.test.mjs` (16 node:test cases,
browser-free, spawned via the `BUNDLE_NEXT_DIR`/`BUNDLE_BASELINE_FILE`
knobs), INCLUDING the deliberate over-budget negative test (1 B over ->
exit 1 naming the route) the roadmap asked for, and since session 118 the
two chain negatives: a chunk listed ONLY under `/layout` tripping the gate
(the exact SkipLink blind spot) and the nested ancestor chain deduping a
chunk shared by four entries to one count. The CI web job runs
`node --test` before the real gate, and the ship run additionally proved
the negative live on the real `.next` with deliberately 1-byte baselines.

## Scheduled write-ladder regression check — November 24, 2026 (session 124)

Phase 13 Test item: session 121's baseline is now guarded by a RUNNER, not
by memory. `ops/perf-check.sh` builds a throwaway rig — drop/create scratch
DB on the full 29-migration chain + canonical seed, optional fresh
`nest build`, API on a dedicated port with boot-time relaxed limiter buckets
— runs the `ops/load-test-write.js` SMOKE arm via the `grafana/k6`
container (`--network host`, shipped cache/compression defaults), and
judges the run. Exit codes mirror `ops/alert-scan.sh` (session 86):

| Exit | Verdict | Triggers |
|---|---|---|
| 0 | green | every rule passes AND the DB cross-check is exact |
| 1 | REGRESSION | p95 over `PERF_CHECK_P95_MS_MAX` (default 120 ms, ~7x the smoke baseline); `rate_limited_429s` > 0; zero orders; capture shortfall < 95%; `http_req_failed` > 1%; checks pass-rate < 0.99; k6 crossed its own internal thresholds (exit 99); written rows DISAGREE with the k6 counters; any 5xx (pino `level:50`) line in the scratch API log |
| 2 | rig broken | missing prereq, build/seed/boot failure, port busy, overlapping run (flock), k6 ABORTED (exit 108 — the zero-429 / cache / bootstrap guard fired, so the sample is invalid), k6 crashed, unreadable summary, sample thinner than `PERF_CHECK_MIN_ITERS` (5), psql unreachable |

A dead smoke detector never reports green, and never pages like a fire:
the 1-vs-2 distinction is the paging policy downstream.

Anatomy: preflight (node/jq/curl/npm/psql/docker, `.env`, port free, flock)
→ scratch DB → `nest build` unless `PERF_CHECK_BUILD=0` (a stale dist
silently measures OLD code — the live-smoke fail-fast doctrine) → seed →
capture the LATEST seeded timestamp as the run-window anchor → boot +
`/api/health` poll → k6 smoke arm → `ops/perf-check.analyze.mjs` (k6 exit
class + result rules over the summary JSON) → exact DB cross-check + the
5xx log grep → one compact JSON verdict on stdout (facts, reasons, rig
metadata). The cleanup trap kills the API and drops the DB
(`PERF_CHECK_KEEP_DB=1` parks it for a postmortem).

Why the verdict splits exit-class vs JSON (measured against the real
container this session): k6 v2.3.0 exits 99 when its OWN thresholds cross,
but those are loose (p95<500 ms) — a 4x latency drift vs the 120 ms ceiling
this guard exists for would still exit 0. And `exec.test.abort` exits 108
while STILL exporting a (thin) summary: the run-level class must veto
before the result rules can be fooled by it. Summary-shape facts pinned by
the selftests: flat values under `metrics.<name>`; rate metrics expose
`value` (`http_req_failed` = failure rate, `checks` = pass rate); a never
incremented counter can be ABSENT from the export (absence of
`rate_limited_429s` means zero, not unknown).

Harness catch of the first live run (spec-side, zero product bugs): the
seed writes its 10 fixture orders with `createdAt = now`, so a wall-clock
RUN_START captured BEFORE the seed swallows them into the window — the
cross-check reported orders=39/29 with orphan_orders=10 = exactly the
seeded ten. The window is now strict `>` over `greatest(max(orders),
max(payments))` captured AFTER the seed; psql's ISO timestamp text keeps
its significant space (no `tr -d` on it).

Live proof on this host (smoke arm, 2026-11-24):

| Run | Iters | Reqs | p95 | avg | DB cross-check (orders, payments, orphans) | Exit |
|---|---:|---:|---:|---:|---|---:|
| green | 29 | 147 | 17.99 ms | 8.94 ms | 29/29, 29/29, 0 | 0 |
| regression (`--p95-max 5` live) | 29 | 147 | 18.01 ms | — | 29/29, 29/29, 0 | 1 |
| rig: busy port | — | — | — | — | scratch DB never created | 2 |
| rig: held flock | — | — | — | — | scratch DB never created | 2 |

p95 17.99 ms vs session 121's 16.6 ms smoke run: the arm is stable and the
120 ms default ceiling carries ~7x noise margin — tighten
`PERF_CHECK_P95_MS_MAX` deliberately when a new baseline lands.

Selftests: `ops/perf-check.analyze.test.mjs` — 18 `node --test` cases
(healthy pin, both boundary rules at exactly-AT and one-unit-over, 429>0,
zero orders, capture-ratio boundary `ceil(30*0.95)=29`, failed rate, checks
rate, k6 exit 0/99/108/7 classes, thin sample, garbage/missing-field
summaries, plus CLI process spawns asserting the 0/1/2 exit contract).
Wired into the CI `api` job next to the pure-helper contract test, so a
dead gate fails pushes, not just the nightly.

Scheduling: `ops/systemd/foodorder-perf-check.{service,timer}` — daily at
04:20 (65 min after the backup slot, `Persistent=true` catches up misses),
`TimeoutStartSec=20min` because systemd's default would SIGTERM a healthy
run mid-seed, `OnFailure=` wired to the same transport as the alert-scan
units. `PERF_CHECK_PROFILE=load` upgrades a run to the full 2.5-minute
ladder (session 121 load arm: 506 iters, p95 12.71 ms) — it fits the
daily slot too; the smoke arm ships as the default to keep the nightly
cost ~2 minutes.

Deliberately NOT gated here: statements-per-request (needs the
session-79/104 query-logger ALTER-before-boot windowing — a manual
follow-up) and the TTL=0 control arm (session 121's one-off A/B — the
scheduled guard measures the stack PRODUCTION runs).

## Query-plan findings and tuning decisions (November 4 baseline, historical)

`EXPLAIN (ANALYZE, BUFFERS)` on the same seed showed:

- Restaurant detail used the UUID primary-key index and executed in 0.056 ms.
- The default list and cuisine source scanned six restaurant rows and sorted in
  memory (27 KiB and 26 KiB respectively); execution stayed below 0.1 ms.
- Substring search used a sequential scan because `LOWER(name) LIKE '%term%'`
  and `LOWER(cuisine) LIKE '%term%'` cannot use the current btree indexes.

No database or pool setting was changed: the measured workload had ample
latency headroom, and tuning against six rows would overfit the seed rather than
improve a demonstrated bottleneck.

Recommended next steps when realistic cardinality or production telemetry is
available:

1. Run this same profile from a separate load generator through the real TLS
   ingress and compare against this baseline.
2. Populate production-shaped restaurant/menu volumes before changing indexes.
   (DONE as of session 79: the list-path audit above ran against an inflated
   9k-restaurant DB, and its index decisions reference these numbers.)
3. Implement the existing `pg_trgm` fuzzy-search roadmap item, then add a
   GIN/GiST plan assertion for the substring path.
   (DONE: session 69 shipped `/api/search` + the GIN indexes; session 79 made
   the storefront `search=` filter bitmap-scan on them, with plans above.)
4. Replace the cuisines endpoint's full-row fetch plus in-process de-duplication
   with a database `SELECT DISTINCT cuisine` query if restaurant cardinality
   makes that allocation visible.
   (DONE: session 79 — see the audit above.)
5. Add authenticated read and write scenarios only with isolated test accounts
   and a disposable database; do not mix destructive traffic into this public
   browse baseline.
   (DONE: session 82 — `ops/load-test-auth.js`, signup → browse → order → MOCK
   pay on an isolated instance + scratch DB, baseline above.)
6. Re-run the public browse k6 profile now that the three read routes are
   ETag-cached (session 103) — expect statements-per-request to collapse and
   p95 to move; record it as a NEW baseline (never restated against the
   November 4 numbers), optionally with an `If-None-Match` replay profile to
   measure the 304 path directly.
   (DONE: session 104 — re-baseline above; p95 5.07 → 2.52 ms at TTL=15,
   stmt/req 2.000 → 0.262, and the shipped `ops/load-test-conditional.js`
   replay profile measures the 304 path head-on at 0.003 stmt/req.)
