# Test Reliability

## Browser coverage

The critical public-page navigation suite runs in Chromium, Firefox, and WebKit. Browser binaries are selected by the locked `@playwright/test` version, so update the dependency lockfile when changing the supported browser revisions. CI retains the Playwright JSON and HTML reports; a test that passes on retry is reported as flaky with its attempt details rather than being indistinguishable from a clean pass.

## Time semantics

Persist timestamps that represent moments as UTC instants (RFC 3339 timestamps with an offset, or database timestamps normalized to UTC). Render those instants in the viewer's timezone. Values that represent a calendar date, such as a date filter, are not instants: preserve them as `YYYY-MM-DD` and do not convert them through a local midnight. Tests around daylight-saving transitions must assert elapsed-time behavior using instants and calendar display using the selected timezone.

For backend scheduled or delayed jobs, use `DeterministicClock` and
`MockQueueFixture` from `xconfess-backend/test/deterministic/deterministic-fixtures.ts`
instead of wall-clock sleeps. Prefer injecting the `Clock` interface from
`xconfess-backend/src/common/clock.ts` into services; pass a fixed clock in unit
tests so due-time, expiry, and retry boundaries do not mutate global `Date`.
Keep `DeterministicClock` for legacy code that cannot accept an injected clock.
Queue tests should set worker concurrency explicitly and advance the clock
through configured delays/backoff. Restore any global clock fixture even when a
test fails.

Backend and frontend CI test jobs set `TZ=UTC`. Tests must still use explicit
IANA `timeZone` options when asserting calendar output for a viewer timezone;
do not change `process.env.TZ` during a test. Relative-time tests should supply
their reference instant rather than reading the current wall clock.

## Flaky-test triage

Do not permanently skip a flaky test without registering it in `.github/test-quarantine.json`. Each entry names the test, an owner, an expiry date, a tracking issue, a concise reason, and whether the suspected cause is a product or infrastructure failure. The CI validator rejects missing metadata, unregistered static skips, expired entries, and entries that no longer match a skipped test. Prefer repairing the cause and removing the registry entry; quarantine is temporary, not a replacement for a test.

Use the retained Playwright report to compare attempts. A repeatable failure in application behavior is classified as `product`; failures attributable to runner availability, browser installation, or external test infrastructure are classified as `infrastructure`. Leave ambiguous failures unquarantined until the cause is understood.

## Mutation contention

Concurrency coverage uses PostgreSQL rather than repository mocks. The reaction contention case sends synchronized duplicate mutations and asserts that all callers receive one canonical record, the unique invariant remains intact, and only one creation event is broadcast. Run it with `npm run test:e2e -- --runInBand --runTestsByPath test/reaction-contention.e2e-spec.ts` from `xconfess-backend` against an isolated test database.