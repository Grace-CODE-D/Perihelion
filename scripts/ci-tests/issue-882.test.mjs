// Regression checks for #882: the Markdown link check must cover contracts/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/docs.yml', import.meta.url)),
  'utf8',
);

test('link check no longer excludes all of contracts/', () => {
  assert.ok(!workflow.includes("-not -path '*/contracts/*'"));
  assert.ok(workflow.includes("-not -path './contracts/evm/lib/*'"));
});

test('link check iterates files NUL-safely', () => {
  assert.ok(!workflow.includes('for f in $FILES'));
  assert.equal(workflow.split("read -r -d '' f").length - 1, 2);
});

test('docs workflow triggers on contract Markdown changes for push and pull_request', () => {
  const filter = "      - 'contracts/**/*.md'";
  assert.equal(workflow.split(filter).length - 1, 2);
});
