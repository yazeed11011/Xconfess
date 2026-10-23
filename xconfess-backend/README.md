## DLQ Retention Policy & Cleanup

The notification dead-letter queue (DLQ) is now protected by a retention policy and scheduled cleanup job.

### Configuration

Set these environment variables (or override in config):

- `DLQ_RETENTION_DAYS` (default: 14) — How many days to retain failed jobs
- `DLQ_CLEANUP_BATCH_SIZE` (default: 100) — Max jobs to process per cleanup run
- `DLQ_CLEANUP_DRY_RUN` (default: false) — If true, cleanup only logs candidates

### How it works

- Every 6 hours, the backend scans the DLQ for jobs older than the retention window.
- In dry-run mode, it logs which jobs would be deleted.
- In active mode, it deletes jobs and emits an audit log entry for each batch.
- Cleanup is idempotent and safe to rerun.

#### Manual Cleanup

You can trigger cleanup manually in code:

```ts
// In a service/controller:
await notificationQueue.cleanupDlq({ dryRun: true }); // or dryRun: false
```

#### Audit Logging

All cleanup activity is logged in the audit log with action type `NOTIFICATION_DLQ_CLEANUP`.

# xConfess Backend

For operational details on managing email templates and rollouts, see the [Template Rollout Runbook](../docs/template-rollout-runbook.md).

## Non-Personalized Discovery Mode

Users can explicitly opt out of personalization. When enabled, the discovery/feed boundary bypasses every personal ranking feature (affinity, interaction history, per-user boosts) and serves only non-personalized ordering.

- **Preference persistence**: the opt-out is stored on the user record and survives cache invalidation; after a cache flush the mode is re-read from the database before any ranking runs.
- **Authorization**: only the authenticated owner may toggle the preference (`PATCH /api/users/me/discovery-preferences`); admin overrides require the admin RBAC guard and are audited.
- **Failure semantics**: if the preference cannot be loaded, the request fails closed to the non-personalized path rather than silently personalizing.
- **Tests**: `npm run backend:test` covers the API toggle, the client behavior after cache invalidation, and the rejection path for unauthorized callers.

## Ranking Quality Drift Monitoring

Offline evaluation is supplemented by aggregate-only online indicators. No user-level histories are retained.

- **Minimum cohort**: indicators are only computed when the cohort has at least `RANKING_DRIFT_MIN_COHORT` (default `200`) impressions; smaller cohorts are skipped.
- **Indicators**: aggregate CTR, dwell-time proxy, and hide/report rate per ranking version.
- **Thresholds**: `RANKING_DRIFT_CTR_DELTA` (default `0.15`), `RANKING_DRIFT_HIDE_RATE_DELTA` (default `0.05`). Breaching a threshold opens a review item.
- **Retention**: aggregate buckets are retained for `RANKING_DRIFT_RETENTION_DAYS` (default `30`) and then purged; raw per-user events are never persisted.
- **Review path**: a flagged ranking version can be disabled via `RANKING_DISABLED_VERSIONS` (comma-separated) or the admin endpoint, which immediately falls back to the previous version.

## Stellar RPC Failover

Anchoring and tipping use a health-aware RPC pool.

- **Configuration**: `STELLAR_RPC_URLS` (comma-separated ordered endpoints), `STELLAR_RPC_HEALTH_TIMEOUT_MS` (default `3000`), `STELLAR_RPC_COOLDOWN_MS` (default `30000`), `STELLAR_RPC_MAX_RETRIES` (default `2`).
- **Health**: an endpoint is marked unhealthy after a timeout or transport error and enters cooldown before being retried.
- **Read vs submit safety**: reads may fail over freely; submits only fail over when the previous attempt is known not to have been accepted, preventing duplicate transaction submission during endpoint changes.
- **Tests**: `npm run backend:test && npm run contract:test:integration`.

## Outbound URL Policy

All backend URL fetches must use `outboundFetch` from
`src/common/security/outbound-url-policy.ts`. Set
`OUTBOUND_ALLOWED_ORIGINS` to a comma-separated list of exact HTTPS origins,
including every configured Stellar RPC/Horizon endpoint and enabled moderation
provider. The environment examples include the official testnet/mainnet Stellar,
OpenAI, and Perspective origins; custom endpoints must be added explicitly.

Requests fail closed when the URL is malformed, uses a non-HTTPS or unauthorized
origin, contains credentials, resolves to any non-public IP address, or returns
a redirect. DNS addresses are validated at socket lookup and pinned for the
connection; environment proxy settings are bypassed. A denied moderation
request follows the existing rule-based fallback, while Stellar callers follow
their existing retry/unavailable behavior. Do not bypass this boundary for
user-influenced URLs.

## Account Sequence Coordination

Concurrent transaction workers serialize sequence allocation per Stellar account.

- **Lease**: each worker acquires an account-scoped lease (`STELLAR_SEQUENCE_LEASE_MS`, default `15000`) before building a transaction; the lease is released after submit.
- **Recovery**: expired leases are reclaimed automatically, so a crashed worker cannot block the account indefinitely.
- **Failure semantics**: if a lease cannot be acquired within the wait budget the submit is rejected with a retryable error rather than reusing a stale sequence.
- **Tests**: `npm run backend:test && npm run contract:test:integration` cover multi-worker concurrency and recovery after process failure.

## Language-aware moderation evaluation

Admins can run the synthetic multilingual evaluation with `POST /api/admin/moderation/language-evaluation`. The route requires a valid JWT and the admin role. Its optional `languages`, `categories`, and `disparityThreshold` filters select a subset of supported evaluation data; omitted filters use the full corpus.

- **Privacy**: the built-in corpus contains synthetic text only, with positive and negative samples for every supported language and moderation category. The response contains aggregate confusion-matrix metrics, including false-positive and false-negative rates by language and language/category pair; it does not include sample text or persist it.
- **Provider use**: evaluation submits only the built-in synthetic samples through the configured moderation service. A run may issue one moderation request per selected sample and follows the moderation service's existing provider/fallback behavior.
- **Failure behavior**: unsupported filters or filters with no matching samples return `400`. A thrown moderation error fails the request and does not cache a partial report.
- **Configuration**: no additional environment variables are required. The disparity threshold defaults to `0.15` and can be set between `0` and `1`.

## Moderation policy impact preview and rollout

An admin can preview threshold changes with `POST /api/admin/moderation/policy-impact-preview`, sending `highThreshold` and `mediumThreshold` values. The preview compares current and proposed decisions against the checked-in synthetic moderation corpus and returns aggregate decision-transition counts only. It uses the local rule-based scorer; it does not call moderation providers, read existing user content, or persist fixture text. Thresholds must satisfy `0 < mediumThreshold < highThreshold <= 1`.

Applying a change uses `POST /api/admin/moderation/config/thresholds` with the same thresholds, the returned `previewId`, and `"approved": true`. The admin JWT and role guard protects both endpoints. The preview ID is one-time, expires after 10 minutes, and is invalidated if another preview is created or the active thresholds change. A missing, expired, stale, or mismatched preview fails rather than applying the proposal.

Approved thresholds take effect in memory for the current backend process. `MODERATION_HIGH_THRESHOLD` and `MODERATION_MEDIUM_THRESHOLD` remain the startup baseline, so a process restart restores the configured values. In multi-instance deployments, route preview and approval to the same instance; otherwise approval fails closed if that instance has no matching preview.

## Provider And Background-Job Reliability

- `MODERATION_PROVIDER_TIMEOUT_MS` defaults to `5000` (bounded to `500`-`10000` ms), and `MODERATION_PROVIDER_MAX_ATTEMPTS` defaults to `2` (bounded to `1`-`3`). Retries use jitter and apply only to transient failures of side-effect-free moderation scoring calls; permanent 4xx responses are not retried. Provider metrics include only the provider and bounded outcome.
- SMTP connection, greeting, and socket budgets are controlled by `MAIL_CONNECTION_TIMEOUT_MS` (`5000`), `MAIL_GREETING_TIMEOUT_MS` (`5000`), and `MAIL_SOCKET_TIMEOUT_MS` (`10000`), each bounded to `500`-`30000` ms. SMTP delivery is not automatically retried after an ambiguous send failure; only the existing configured provider fallback is used.
- Performance measurements use matched route templates; unmatched routes are grouped under a fixed prefix. The logger accepts only its finite metric label vocabulary and caps each metric store at 1,000 series. Request IDs, user IDs, raw paths, query strings, and content are not metric labels.
- Notification and export jobs carry a generated or request-scoped `correlationId`; workers bind it to async logging context, and notification retries/DLQ copies retain it. Do not put credentials or user content in this field.
- Export jobs retry at most three times with exponential backoff. Chunk indexes are checkpoints: retries replace matching indexes and finalize only after generation completes; cancellation is checked before chunk writes and finalization. Chunk downloads are available only after `READY`.

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

> NestJS-based backend for the xConfess anonymous confession platform.

## Runtime architecture

HTTP APIs are served only through NestJS: `main.ts` bootstraps `AppModule`, and every route is declared on Nest controllers inside feature modules (global prefix `api`). There is no parallel Express router tree; do not add handlers under orphaned `routes/` or `controllers/` folders.

Shared cross-cutting middleware used at bootstrap lives under `src/middleware/` (for example `RequestIdMiddleware`). Feature code belongs in the module directories listed below.

## Background job capacity and queue health

Worker concurrency is bounded per queue so expensive export jobs cannot consume
notification or confession-draft worker slots. These are per-worker settings;
fleet capacity is the configured concurrency multiplied by the number of
workers registered for that queue.

| Environment variable | Default | Valid range | Queue/job |
| --- | ---: | ---: | --- |
| `NOTIFICATION_WORKER_CONCURRENCY` | `5` | `1`–`100` | `notifications` / `send-notification` |
| `EXPORT_WORKER_CONCURRENCY` | `1` | `1`–`100` | `export-queue` / `process-export` |
| `CONFESSION_DRAFT_WORKER_CONCURRENCY` | `1` | `1`–`100` | `confession-draft-publisher` |
| `REDIS_QUEUE_WAIT_THRESHOLD_MS` | `30000` | positive integer | Oldest waiting job age before readiness degrades |

All workers for a given queue should use the same concurrency setting so the
capacity estimate in `/api/health/ready` remains meaningful. Its queue details
include `waitMs`, estimated `capacity`, and `saturated`; saturation means the
active count has filled estimated capacity while at least one job is waiting.
Wait exceeding the configured threshold degrades readiness. Unsupported job
names reject explicitly and remain subject to the queue's retry/failure policy.

The authenticated API/controller remains the producer authorization boundary;
do not enqueue jobs from an untrusted caller without enforcing ownership or
administrative authorization there. See [queue readiness signals](../docs/HEALTH_ENDPOINT_QUICK_REFERENCE.md#what-gets-checked).

## Auth Endpoint Split (`/users/*` vs `/auth/*`)

Both route groups are active in this codebase:

- `/api/users/*`: user lifecycle endpoints (`register`, `login`, `profile`, account status, user notification preferences)
- `/api/auth/*`: auth-centric endpoints (`login`, `me`, `logout`, password reset flow)

Examples:

- `POST /api/users/register`
- `POST /api/users/login`
- `POST /api/auth/login`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`

## Active Modules

| Module        | Path                 | Description                                            |
| ------------- | -------------------- | ------------------------------------------------------ |
| Auth          | `src/auth/`          | JWT authentication, guards, decorators                 |
| User          | `src/user/`          | User + anonymous user management                       |
| Confession    | `src/confession/`    | Confession CRUD, search, tags, encryption              |
| Reaction      | `src/reaction/`      | Emoji reactions with WebSocket                         |
| Comment       | `src/comment/`       | Nested commenting system                               |
| Messages      | `src/messages/`      | Anonymous messaging (author-reply)                     |
| Report        | `src/report/`        | Report creation & resolution                           |
| Admin         | `src/admin/`         | Admin panel with RBAC                                  |
| Moderation    | `src/moderation/`    | AI content moderation (OpenAI)                         |
| Audit Log     | `src/audit-log/`     | Comprehensive audit trail                              |
| Logger        | `src/logger/`        | Structured logging with PII masking                    |
| Stellar       | `src/stellar/`       | Stellar blockchain integration                         |
| Tipping       | `src/tipping/`       | XLM micro-tipping                                      |
| Encryption    | `src/encryption/`    | Field-level confession encryption                      |
| Cache         | `src/cache/`         | Redis/in-memory caching                                |
| Analytics     | `src/analytics/`     | View counts, trending                                  |
| Data Export   | `src/data-export/`   | GDPR data export                                       |
| WebSocket     | `src/websocket/`     | Real-time event gateway                                |
| Notifications | `src/notifications/` | Outbox, email, Bull queues, DLQ admin                  |

## Background Job Requirements

Redis-backed Bull queues are required for background-job features. In particular:

- `src/notifications/notifications.module.ts` explicitly owns `notifications` and `notifications-dlq`
- `src/data-export/data-export.module.ts` explicitly owns `export-queue`

If Redis-backed background jobs are enabled, the backend must be able to bootstrap those queue tokens or the related processors and services will fail to initialize.

## Project Setup

```bash
npm install
```

## Compile and Run

```bash
# development
npm run start:dev

# production mode
npm run build
npm run start:prod
```

## Run Tests

```bash
# unit tests
npm run test

# e2e tests
npm run test:e2e

# test coverage
npm run test:cov
```

### Intentionally Test-Light Directories

Some backend directories are expected to have few or no dedicated `*.spec.ts` files:

| Directory | Why it is test-light |
| --- | --- |
| `migrations/` and `src/migrations/` | TypeORM migration files are mostly timestamped schema changes. They are reviewed for SQL/schema correctness and exercised when a database is migrated, with focused specs added only for migration helpers or unusually risky data movement. |
| `src/types/` | Shared TypeScript-only type definitions compile away at runtime, so coverage comes from `tsc` and the code that consumes those types. |
| `src/**/dto/` | DTOs are mostly declarative validation and API-shape classes. Add focused specs when a DTO contains custom validation, transformation, or other behavior; otherwise controller and e2e tests cover the request/response paths that use them. |

## Environment Variables

Copy `.env.example` to `.env` and update the values:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_NAME=xconfess
JWT_SECRET=your-secret-key
PORT=5000
NODE_ENV=development
APP_ENV=local
TYPEORM_SYNCHRONIZE=false
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
ENABLE_BACKGROUND_JOBS=true
REPUTATION_RECONCILIATION_BATCH_SIZE=100
```

The scheduled reputation reconciliation worker runs only when
`ENABLE_BACKGROUND_JOBS=true`. It resumes from a database checkpoint, processes
at most one batch per schedule, and clamps the configured batch size to 1-500.
Apply the `CreateReputationReconciliationCheckpoints20261022000001` migration
before enabling it in a deployed environment. Progress and failure events
contain aggregate counts and generic error codes, not confession or transaction
identifiers.

### TypeORM Synchronize Policy

- Default is `false` in all environments.
- Sync is enabled only when both conditions are true:
  - environment is local/dev (`NODE_ENV` or `APP_ENV` is `local`/`dev`/`development`)
  - `TYPEORM_SYNCHRONIZE=true`
- In non-dev environments, schema sync remains disabled even if the flag is set.

## Database Migrations

Migrations are the authoritative schema-evolution mechanism for non-dev environments.

```bash
# generate a migration from local entity changes
npm run migration:generate -- ./migrations/<migration-name>

# apply pending migrations
npm run migration:run

# revert the latest migration (if needed)
npm run migration:revert
```

## API Documentation

When running locally, Swagger docs are available at `/api/api-docs`.

## Cross-Domain Integrity Checks

The backend provides a read-only cross-domain integrity verification report accessible to administrators via `GET /api/admin/integrity/report`.
It executes bounded, read-only queries across identity, content, export, and moderation domains, returning stable error codes (`ERR_INTEGRITY_*`), severity levels, and automated repair guidance for detected invariant violations.

Configuration environment variables:
- `INTEGRITY_CHECK_DEFAULT_TIMEOUT_MS`: Default timeout budget per report run (default: 5000).
- `INTEGRITY_CHECK_MAX_TIMEOUT_MS`: Maximum timeout budget allowable (default: 30000).
- `INTEGRITY_CHECK_DEFAULT_LIMIT`: Default sample limit per invariant check (default: 50).
- `INTEGRITY_CHECK_MAX_LIMIT`: Maximum violation sample limit (default: 200).

## 📄 License

[MIT licensed](../LICENSE)


## Health Checks

See [HEALTH_CHECK_DOCUMENTATION.md](./HEALTH_CHECK_DOCUMENTATION.md) for full details.

| Endpoint | Use for |
|---|---|
| `GET /api/health/live` | Local smoke test — is the process up? |
| `GET /api/health/ready` | Full stack check — are all dependencies ready? |

Quick check after `npm run start:dev`:
```bash
curl -s http://localhost:3000/api/health/live   # {"status":"ok"}
curl -s http://localhost:3000/api/health/ready  # {"status":"ok",...}
```
