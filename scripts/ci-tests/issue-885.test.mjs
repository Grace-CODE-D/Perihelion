// Regression checks for #885: differential fuzzing runs only for relevant changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/differential-fuzz.yml', import.meta.url)),
  'utf8',
);

// Text between the top-level `on:` and the first job-level key.
const triggers = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('\n# Cancel in-progress'));
const pathBlock = [
  "      - 'contracts/soroban/**'",
  "      - 'contracts/evm/**'",
  "      - 'contracts/shared/wire-vectors/**'",
  "      - 'scripts/run-differential-fuzz.sh'",
  "      - '.github/workflows/differential-fuzz.yml'",
].join('\n');

for (const event of ['push', 'pull_request']) {
  test(`${event} trigger is limited to the contract, wire-vector and harness paths`, () => {
    const start = triggers.indexOf(`  ${event}:`);
    const rest = triggers.slice(start + 1);
    const block = triggers.slice(start, start + 1 + rest.search(/\n {2}\S/));
    assert.ok(block.includes('    paths:\n' + pathBlock), block);
  });
}

test('schedule and dispatch triggers are not path-filtered', () => {
  const scheduleStart = triggers.indexOf('  schedule:');
  const tail = triggers.slice(scheduleStart);
  assert.ok(!tail.includes('paths:'));
});

test('no unfiltered push or pull_request trigger remains', () => {
  assert.equal(triggers.split('\n    paths:').length - 1, 2);
});
