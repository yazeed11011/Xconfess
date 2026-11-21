import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  validateFixture,
  type MigrationFixture,
} from '../../scripts/migration-rehearsal';

const fixturePath = resolve(
  __dirname,
  '../../test/fixtures/migrations/20261118.json',
);

describe('migration rehearsal fixture contract', () => {
  it('accepts the committed historical schema fixture and current migration sequence', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
    expect(() => validateFixture(fixture)).not.toThrow();
  });

  it('rejects unsupported fixture versions before running migrations', () => {
    const fixture = JSON.parse(
      readFileSync(fixturePath, 'utf8'),
    ) as MigrationFixture;

    expect(() =>
      validateFixture({ ...fixture, schemaVersion: 'unknown' }),
    ).toThrow('unsupported schema version');
  });

  it('rejects fixtures that omit data-preservation expectations', () => {
    const fixture = JSON.parse(
      readFileSync(fixturePath, 'utf8'),
    ) as MigrationFixture;

    expect(() => validateFixture({ ...fixture, preservedRows: [] })).toThrow(
      'incomplete',
    );
  });
});
