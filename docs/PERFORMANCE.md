# API load testing and baselines

Two k6 workloads live in `ops/`:

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

Pure helpers (cart planning, payload shape, profiles) live in
`ops/load-test.lib.mjs` and are pinned by `ops/load-test.contract.test.mjs`
(`node --test ops/load-test.contract.test.mjs`).

## Run it

With k6 installed:

```bash
BASE_URL=http://127.0.0.1:4000/api PROFILE=smoke k6 run ops/load-test.js
BASE_URL=http://127.0.0.1:4000/api PROFILE=load k6 run ops/load-test.js
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
export DATABASE_URL="${DATABASE_URL%/*}/foodorder_k6load" PORT=4100 JWT_SECRET
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
