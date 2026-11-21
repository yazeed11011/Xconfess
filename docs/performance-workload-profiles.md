# Performance Workload Profiles

This document describes the synthetic dataset generators and named workload
profiles used for xConfess benchmarks and load tests.

## Overview

Benchmarks are only comparable when every run uses the same data distribution.
The `DatasetGenerator` class produces deterministic, privacy-safe synthetic
fixtures from a numeric seed — no production data is ever used or emitted.

Named **workload profiles** document the concurrency mix, dataset scale, and
request distribution for each test scenario.  Profiles live in
`xconfess-backend/src/common/performance/workload-profiles.ts` and are consumed
by benchmark scripts and load-test drivers.

## Dataset Generator

**File:** `xconfess-backend/src/common/performance/dataset-generator.ts`

```ts
import { DatasetGenerator } from './common/performance/dataset-generator';

const gen = new DatasetGenerator(42); // seed makes it reproducible
const users        = gen.users(500);
const confessions  = gen.confessions(5000, users);
const reactions    = gen.reactions(25000, confessions, users);
const comments     = gen.comments(10000, confessions, users);
const jobs         = gen.notificationJobs(2000, users);
```

All generated IDs are namespaced (`user-<seed>-<index>`) so fixtures from
different seeds can coexist in the same test database without collisions.

### Privacy guarantees

- Usernames are random hex strings; no real names are generated.
- Confession content is a fragment + random hex suffix; no PII patterns.
- No email addresses, phone numbers, or real passwords are emitted.

## Workload Profiles

| Name          | VUs | Target RPS | Seed | Purpose                                      |
|---------------|-----|------------|------|----------------------------------------------|
| `smoke`       |   5 |         20 |    1 | CI sanity check — fast p50 baseline          |
| `read-heavy`  | 100 |        300 |   42 | Typical daytime traffic (80 % reads)         |
| `write-spike` | 200 |        500 |   99 | Viral event — elevated writes + queue load   |
| `ws-soak`     | 500 |         50 |    7 | Long-lived WS connections — memory leak test |

### Profile: `smoke`

Minimal concurrency.  Runs in under 30 seconds.  Validates p50 latency
baselines before deeper profiling begins.

### Profile: `read-heavy`

Models typical daytime traffic.  ~80 % of operations are reads (feed,
detail, trending, search).  Use this profile to establish cache hit rates
and DB read throughput.

### Profile: `write-spike`

Simulates a viral event where many users post and react simultaneously.
Tests DB write throughput, notification queue back-pressure, and WS fanout
under high write ratio.

#### Notification burst measurement

The CI benchmark layers a synthetic notification burst over `write-spike`:

| Input / threshold | Value |
|---|---:|
| submissions | 5,000 over 10 seconds (500/s) |
| producer concurrency | 200 |
| distinct source events | 1,000 |
| repeated submissions | 4,000 (80%) |
| modeled worker concurrency | 5 |
| modeled job service time | 75 ms |
| modeled queue-wait p50 / p95 / max | 2,475 / 4,725 / 4,975 ms |
| queue-wait p95 ceiling | 6,000 ms |
| repository operations per submission ceiling | 6 |
| persisted duplicate notifications | 0 |

The test calls the real `NotificationService.createNotification` path with
content-free source-event IDs, instrumented repositories, and a synthetic
queue. The current model reports 1,000 successful inserts, 4,000 duplicate
suppression outcomes, 1,000 queue enqueues, and 29,000 repository operations
(5.8 per submission), including 4,000 unique-index conflicts under concurrent
fan-in. It reports preference/user/notification reads and insert attempts.
Queue wait is modeled from the first enqueue time for each unique event and
the fixed worker service time; production queue wait is separately observed
from BullMQ's enqueue/worker-start timestamps as
`notification_queue_wait_duration_ms`.
Missing or invalid BullMQ timestamps increment
`notification_queue_wait_measurement_missing_total`.

These are deterministic capacity and database-operation budgets, not measured
PostgreSQL IOPS or a production SLO. The real database is intentionally not
connected during CI, and all benchmark content is synthetic. A live capacity
run must use an isolated non-production database and queue before treating the
modeled wait ceiling as an operational target.

### Profile: `ws-soak`

500 concurrent WebSocket connections held open for ≥ 10 minutes.  Designed
to expose unbounded heap growth in the notification gateway.  Monitor RSS
and heap-used over time; both should plateau rather than grow linearly.

## Using Profiles in a Load Test

```ts
import { buildProfileDataset, READ_HEAVY_PROFILE, normaliseDistribution }
  from './common/performance/workload-profiles';

const { profile, users, confessions } = buildProfileDataset(READ_HEAVY_PROFILE);
const dist = normaliseDistribution(profile.distribution);

// dist[i].normalisedWeight is the probability of picking that operation.
```

## Budget Review Cadence

Latency budgets (see `latency-budgets.ts`) should be reviewed with product
owners at the start of each milestone and after any infrastructure change
that affects database or cache topology.

## Running the benchmark tests

```bash
# Unit tests only (no live server required)
npm run backend:test

# Full CI check
npm run ci
```
