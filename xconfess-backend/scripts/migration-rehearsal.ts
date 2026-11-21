import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { AddConfessionShareAndSeries20261119000001 } from '../migrations/20261119000001-add-confession-share-and-series';
import { AddAdminSupportAccessAuditAction20261119000001 } from '../src/migrations/20261119000001-add-admin-support-access-audit-action';
import { AddModerationGovernance20261119000002 } from '../src/migrations/20261119000002-add-moderation-governance';
import { AddTopicsWebhooksAndSearchOutbox20261120000001 } from '../src/migrations/20261120000001-add-topics-webhooks-and-search-outbox';
import { CreateUserCollections20261120000003 } from '../src/migrations/20261120000003-create-user-collections';
import { AddPublicationOutboxAndAnalyticsConsent20261120000004 } from '../src/migrations/20261120000004-add-publication-outbox-and-analytics-consent';

const BACKEND_ROOT = resolve(__dirname, '..');
const FIXTURE_DIR = join(BACKEND_ROOT, 'test/fixtures/migrations');
const FIXTURE_PATH = join(FIXTURE_DIR, '20261118.json');
const PASSWORD = 'migration-rehearsal-only';
const DATABASE = 'migration_rehearsal';
const STARTUP_TIMEOUT_MS = 45_000;
const MIGRATION_TIMEOUT_MS = 10_000;
const BATCH_TIMEOUT_MS = 30_000;

const MIGRATIONS: MigrationInterface[] = [
  new AddAdminSupportAccessAuditAction20261119000001(),
  new AddConfessionShareAndSeries20261119000001(),
  new AddModerationGovernance20261119000002(),
  new AddTopicsWebhooksAndSearchOutbox20261120000001(),
  new CreateUserCollections20261120000003(),
  new AddPublicationOutboxAndAnalyticsConsent20261120000004(),
];

function getMigrationName(migration: MigrationInterface): string {
  return migration.name ?? migration.constructor.name;
}

export interface MigrationFixture {
  schemaVersion: string;
  setupSql: string;
  migrations: string[];
  preservedRows: Array<{ id: string; message: string; view_count: number }>;
  createdTables: string[];
  addedConfessionColumns: string[];
  addedConfessionIndexes: string[];
  irreversibleEnumValues: string[];
}

export function validateFixture(value: unknown): asserts value is MigrationFixture {
  if (!value || typeof value !== 'object') {
    throw new Error('Migration fixture must be an object.');
  }
  const fixture = value as Partial<MigrationFixture>;
  if (
    fixture.schemaVersion !== '20261118' ||
    fixture.setupSql !== '20261118.sql' ||
    !Array.isArray(fixture.migrations) ||
    !Array.isArray(fixture.preservedRows) ||
    !fixture.preservedRows.length ||
    !Array.isArray(fixture.createdTables) ||
    !Array.isArray(fixture.addedConfessionColumns) ||
    !Array.isArray(fixture.addedConfessionIndexes) ||
    !Array.isArray(fixture.irreversibleEnumValues)
  ) {
    throw new Error('Migration fixture is incomplete or has an unsupported schema version.');
  }

  const expectedMigrations = MIGRATIONS.map(getMigrationName);
  if (JSON.stringify(fixture.migrations) !== JSON.stringify(expectedMigrations)) {
    throw new Error('Migration fixture does not match the current rehearsal migration sequence.');
  }
}

function docker(args: string[], allowFailure = false): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch {
    if (allowFailure) return '';
    throw new Error('Docker is required to run the disposable PostgreSQL migration rehearsal.');
  }
}

async function waitForPostgres(port: number): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const client = new Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password: PASSWORD,
      database: DATABASE,
      connectionTimeoutMillis: 1000,
    });
    try {
      await client.connect();
      await client.end();
      return;
    } catch {
      await client.end().catch(() => undefined);
      await delay(250);
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready before the 45 second startup limit.');
}

async function applyBatch(queryRunner: QueryRunner): Promise<void> {
  const completed: MigrationInterface[] = [];
  const startedAt = performance.now();

  for (const migration of MIGRATIONS) {
    const migrationStartedAt = performance.now();
    await queryRunner.startTransaction();
    try {
      await migration.up(queryRunner);
      await queryRunner.commitTransaction();
      completed.push(migration);
    } catch {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      for (const applied of completed.reverse()) {
        await queryRunner.startTransaction();
        try {
          await applied.down(queryRunner);
          await queryRunner.commitTransaction();
        } catch {
          if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
          throw new Error(`Failed to clean up after migration ${getMigrationName(migration)}; disposable database will be discarded.`);
        }
      }
      throw new Error(`Migration ${getMigrationName(migration)} failed; disposable database will be discarded.`);
    }
    if (performance.now() - migrationStartedAt > MIGRATION_TIMEOUT_MS) {
      throw new Error(`Migration ${getMigrationName(migration)} exceeded the ${MIGRATION_TIMEOUT_MS}ms runtime budget.`);
    }
  }

  if (performance.now() - startedAt > BATCH_TIMEOUT_MS) {
    throw new Error(`Migration batch exceeded the ${BATCH_TIMEOUT_MS}ms runtime budget.`);
  }
}

async function assertPreservedRows(
  queryRunner: QueryRunner,
  expectedRows: MigrationFixture['preservedRows'],
): Promise<void> {
  const rows = await queryRunner.query(
    'SELECT id::text AS id, message, view_count FROM anonymous_confessions ORDER BY id',
  );
  if (JSON.stringify(rows) !== JSON.stringify(expectedRows)) {
    throw new Error('Historical confession rows changed during the migration rehearsal.');
  }
}

async function rehearse(): Promise<void> {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
  validateFixture(fixture);
  const setupSql = readFileSync(join(FIXTURE_DIR, fixture.setupSql), 'utf8');
  const containerName = `xconfess-migration-rehearsal-${process.pid}`;
  let dataSource: DataSource | undefined;

  try {
    docker([
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--env',
      `POSTGRES_PASSWORD=${PASSWORD}`,
      '--env',
      `POSTGRES_DB=${DATABASE}`,
      '--publish',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ]);
    const portText = docker(['port', containerName, '5432/tcp']);
    const port = Number(portText.substring(portText.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1) {
      throw new Error('Could not resolve the disposable PostgreSQL port.');
    }
    await waitForPostgres(port);

    dataSource = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port,
      username: 'postgres',
      password: PASSWORD,
      database: DATABASE,
      synchronize: false,
      migrationsRun: false,
      logging: false,
      extra: { options: '-c statement_timeout=5000' },
    });
    await dataSource.initialize();
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query(setupSql);
      await assertPreservedRows(queryRunner, fixture.preservedRows);
      await applyBatch(queryRunner);
      await assertPreservedRows(queryRunner, fixture.preservedRows);

      const columns = await queryRunner.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'anonymous_confessions'`,
      );
      const presentColumns = new Set(columns.map((row: { column_name: string }) => row.column_name));
      for (const column of fixture.addedConfessionColumns) {
        if (!presentColumns.has(column)) {
          throw new Error(`Migration did not add expected confession column: ${column}`);
        }
      }

      const indexes = await queryRunner.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'anonymous_confessions'`,
      );
      const presentIndexes = new Set(indexes.map((row: { indexname: string }) => row.indexname));
      for (const index of fixture.addedConfessionIndexes) {
        if (!presentIndexes.has(index)) throw new Error(`Migration did not create expected confession index: ${index}`);
      }

      for (const table of fixture.createdTables) {
        const [row] = await queryRunner.query('SELECT to_regclass($1) AS table_name', [table]);
        if (!row.table_name) throw new Error(`Migration did not create expected table: ${table}`);
      }

      const enumLabels = await queryRunner.query(
        `SELECT e.enumlabel FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE t.typname = 'audit_logs_action_enum'`,
      );
      const presentLabels = new Set(enumLabels.map((row: { enumlabel: string }) => row.enumlabel));
      for (const label of fixture.irreversibleEnumValues) {
        if (!presentLabels.has(label)) throw new Error(`Migration did not add expected enum value: ${label}`);
      }

      for (const migration of [...MIGRATIONS].reverse()) {
        await queryRunner.startTransaction();
        try {
          await migration.down(queryRunner);
          await queryRunner.commitTransaction();
        } catch {
          if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
          throw new Error(`Rollback ${getMigrationName(migration)} failed; disposable database will be discarded.`);
        }
      }

      await assertPreservedRows(queryRunner, fixture.preservedRows);
      for (const table of fixture.createdTables) {
        const [row] = await queryRunner.query('SELECT to_regclass($1) AS table_name', [table]);
        if (row.table_name) throw new Error(`Rollback left migration-created table in place: ${table}`);
      }
      const remainingColumns = await queryRunner.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'anonymous_confessions'`,
      );
      const remainingNames = new Set(
        remainingColumns.map((row: { column_name: string }) => row.column_name),
      );
      for (const column of fixture.addedConfessionColumns) {
        if (remainingNames.has(column)) throw new Error(`Rollback left added confession column in place: ${column}`);
      }
      const remainingIndexes = await queryRunner.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'anonymous_confessions'`,
      );
      const remainingIndexNames = new Set(
        remainingIndexes.map((row: { indexname: string }) => row.indexname),
      );
      for (const index of fixture.addedConfessionIndexes) {
        if (remainingIndexNames.has(index)) throw new Error(`Rollback left added confession index in place: ${index}`);
      }

      const retainedEnumLabels = await queryRunner.query(
        `SELECT e.enumlabel FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE t.typname = 'audit_logs_action_enum'`,
      );
      const retainedLabels = new Set(
        retainedEnumLabels.map((row: { enumlabel: string }) => row.enumlabel),
      );
      for (const label of fixture.irreversibleEnumValues) {
        if (!retainedLabels.has(label)) {
          throw new Error(`Expected documented irreversible enum value to remain after rollback: ${label}`);
        }
      }
    } finally {
      await queryRunner.release();
    }

    console.log(
      `migration-rehearsal: applied and rolled back ${MIGRATIONS.length} migrations against fixture ${fixture.schemaVersion}; legacy rows preserved.`,
    );
  } finally {
    if (dataSource?.isInitialized) await dataSource.destroy();
    const cleanup = spawnSync('docker', ['rm', '--force', containerName], {
      stdio: 'ignore',
      timeout: 30_000,
    });
    if (cleanup.error || (cleanup.status !== 0 && cleanup.status !== null)) {
      console.warn('migration-rehearsal: disposable container cleanup did not complete; remove the named container manually.');
    }
  }
}

if (require.main === module) {
  void rehearse().catch((error: unknown) => {
    console.error(
      `migration-rehearsal: ${error instanceof Error ? error.message : 'unexpected failure'}`,
    );
    process.exitCode = 1;
  });
}
