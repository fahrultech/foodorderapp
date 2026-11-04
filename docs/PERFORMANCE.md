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

## Query-plan findings and tuning decisions

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
3. Implement the existing `pg_trgm` fuzzy-search roadmap item, then add a
   GIN/GiST plan assertion for the substring path.
4. Replace the cuisines endpoint's full-row fetch plus in-process de-duplication
   with a database `SELECT DISTINCT cuisine` query if restaurant cardinality
   makes that allocation visible.
5. Add authenticated read and write scenarios only with isolated test accounts
   and a disposable database; do not mix destructive traffic into this public
   browse baseline.
