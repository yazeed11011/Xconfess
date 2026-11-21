# Database Migration Gating

This document describes the migration safety gate for xConfess CI and
deployments, implemented as part of issue #129.

## Overview

The migration gate (`scripts/migration-gate.js`) runs in CI and before every
deployment to catch unsafe or broken migrations before they reach a live
database.

The CI migration job also runs `data-classification:gate`. For changed TypeORM
entities and migrations, it requires an owning module and classifies newly
added columns against `docs/data-classification-registry.json`. A migration
with no column data changes still needs an owner and an operational/data
classification. The job compares against the pull request's base branch and
blocks when the registry is missing or incomplete.

## Checks performed

### 1. Duplicate timestamp detection

TypeORM orders migrations by their numeric timestamp prefix.  Two migrations in
the same directory with identical leading digits will run in an undefined order,
which can cause silent schema corruption.

- **Full timestamps** (13+ digits, e.g. `1774790298268`): duplicates in the
  same directory are always a hard failure.
- **Date-only prefixes** (e.g. `20260126`): pre-existing in the repo; treated
  as a warning only.  New migrations should use a full timestamp or a
  `yyyymmddHHMMSS` format to avoid ambiguity.

### 2. up() / down() presence

Every migration must provide both an `up` method (forward change) and a `down`
method (rollback).  If the rollback is genuinely irreversible, the `down()`
should throw an `Error` explaining why rather than being omitted.

### 3. Destructive DDL in up()

The following operations in an `up()` method are flagged as requiring review:

- `DROP COLUMN` — removing a column loses data
- `DROP TABLE` — removing a table loses data
- `TRUNCATE` — truncating a table loses data

**Preferred approach (expand/contract):**

1. Add the new column/table in one migration (expand).
2. Deploy the new application version that reads/writes both old and new.
3. In a follow-up migration, remove the old column/table (contract).

This allows the previous app version to continue operating during the deploy
window without schema incompatibilities.

**If a destructive migration is intentional and reviewed:**

Add the acknowledgement comment to the top of the migration file:

```typescript
// @unsafe-migration-acknowledged
// Rationale: <explain why this is safe>
```

Or set `ALLOW_UNSAFE_MIGRATIONS=true` when running the gate (CI only; do not
use in production deploy scripts).

### 4. Deployed schema drift (opt-in)

The gate can make a read-only connection and compare the database's TypeORM
migration records with the migrations registered by this checkout. It also asks
TypeORM's schema builder for the DDL it would apply to bring the live schema in
line with entity metadata; the DDL is reported, never executed. This catches
unknown or missing migration records and physical schema changes that diverge
from the current TypeORM model.

The database check is deliberately skipped unless explicitly authorized:

```bash
MIGRATION_GATE_DATABASE_CHECK=true npm run migration:gate
```

Provide the normal `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, and
`DB_NAME` settings for the backend. Use a database account with read-only
permissions. The checker also disables TypeORM synchronization and automatic
migration execution and sets PostgreSQL's `default_transaction_read_only` for
its connections. A detected drift or connection/permission failure blocks the
normal gate. With `--dry-run`, findings are printed but the command exits 0, as
with the existing static checks. Database errors are intentionally summarized
without printing connection details or raw driver messages.

Schema comparison is against the currently registered TypeORM entity metadata;
the migration ledger is compared to the committed migration classes. Any
intentional schema change should be represented by a committed migration and
the corresponding current entity metadata.

## Running the gate

```bash
# Normal run — fails the build on errors
node scripts/migration-gate.js

# Or via npm script
npm run migration:gate

# Dry-run — prints findings but exits 0 (for reporting without blocking)
npm run migration:gate:dry-run

# Allow pre-reviewed unsafe migrations (use sparingly)
ALLOW_UNSAFE_MIGRATIONS=true node scripts/migration-gate.js
```

The root `migration:gate:dry-run` command also runs a PostgreSQL migration
rehearsal in a disposable `postgres:16-alpine` container. It loads the committed
`20261118` historical fixture, applies the six migrations introduced through
`20261120`, checks that pre-existing confession rows remain unchanged, and
rolls the batch back. The migration test has a 5-second PostgreSQL statement
timeout, a 10-second per-migration budget, a 30-second migration-batch budget,
and a 45-second database startup limit. The container is removed on success or
failure; this rehearsal never connects to configured application databases.

The rollback check expects ordinary schema additions to be removed while
existing rows remain intact. PostgreSQL enum additions cannot be removed
safely, so the rehearsal explicitly asserts that the audit enum value remains
after rollback. Rollback of the new tables is suitable only before application
data has been written to those tables; after rollout, use a compensating
migration and an explicit data-retention plan rather than assuming `down()`
preserves newly written rows.

If Docker is unavailable, the rehearsal fails explicitly rather than reporting
a successful migration check. To retry, rerun the command; each run starts with
a fresh database and fixture.

## CI integration

The gate runs as the `migration-gate` job in `.github/workflows/ci.yml`,
blocking the `apps` job if any check fails.

## CD integration

In `.github/workflows/cd.yml`, the `build` job runs `node scripts/migration-gate.js`
before building artifacts.  Additionally, the `deploy` job runs
`npm run migration:run` on the remote host **before** restarting the application
process, ensuring the schema is updated before any new code serves traffic.

## Rollback guidance

If a migration fails on production:

1. **Do not edit the existing migration** — it may already be partially applied.
2. Create a new compensating migration that reverses the change.
3. Apply the compensating migration: `npm run backend:migration:run`.
4. Verify the readiness probe returns 200: `curl https://<host>/api/health/ready`.
5. Re-deploy the previous application version if the schema change is
   incompatible with the current app version.

## Assumptions & follow-up work

- The deployed database check is opt-in and does not run in CI unless an
  authorized database configuration is provided. Without the opt-in flag, the
  gate performs static analysis only and reports that the live check was
  skipped.
- Online migration locking (advisory locks, `pg_try_advisory_lock`) and
  backward-compatibility validation against a test database are follow-up items.
- Cross-directory duplicate timestamp detection (between `migrations/` and
  `src/migrations/`) is not enforced because TypeORM resolves ordering by
  class name in that case.
