# API load testing and baseline

`ops/load-test.js` is a read-only k6 workload for the public storefront API. It
bootstraps restaurant ids, then cycles through:

- `GET /api/restaurants?sort=rating&limit=20`
- `GET /api/restaurants/meta/cuisines`
- `GET /api/restaurants/:id`
- `GET /api/restaurants?search=rice&limit=20`

It does not create users, orders, payments, or other persistent data.

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
