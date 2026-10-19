// Regression checks for #883: a failing nightly mutation run must be reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/mutation-testing.yml', import.meta.url)),
  'utf8',
);

// The summary job is the last job; everything from its header onward is its body.
const summary = workflow.slice(workflow.indexOf('  mutation-summary:'));

test('summary job is the only job granted issue write access', () => {
  assert.match(summary, /permissions:\n\s+contents: read\n\s+issues: write/);
  assert.equal(workflow.split('issues: write').length - 1, 1);
});

test('a tracking issue step exists with a stable title', () => {
  assert.match(summary, /name: Report to tracking issue/);
  assert.ok(summary.includes('"[MUTATION] Nightly mutation testing is failing"'));
  assert.ok(summary.includes('gh issue create'));
  assert.ok(summary.includes('gh issue comment'));
});

test('the tracking step runs on scheduled failures and precedes the red-run gate', () => {
  const step = summary.indexOf('name: Report to tracking issue');
  const gate = summary.indexOf('name: Fail if any stack failed');
  assert.ok(step > 0 && gate > step);
  assert.match(summary, /if: github\.event_name == 'schedule' && contains\(join\(needs\.\*\.result, ' '\), 'failure'\)/);
});
