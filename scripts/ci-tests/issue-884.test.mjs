// Regression checks for #884: the runtime floor must be a supported Node line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

test('.nvmrc pins Node 24', () => {
  assert.equal(read('.nvmrc').trim(), '24');
});

test('Docker build and runtime stages use node:24-alpine and no node:20 image', () => {
  const dockerfile = read('Dockerfile');
  assert.doesNotMatch(dockerfile, /node:20/);
  assert.equal(dockerfile.match(/^FROM node:24-alpine@sha256:[0-9a-f]{64} AS /gm)?.length, 2);
});

test('CI matrix no longer tests the EOL Node 20 line', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.equal(ci.split('node: [22, 24]').length - 1, 2);
  assert.doesNotMatch(ci, /node: \[20/);
});

test('mutation testing uses Node 24', () => {
  const mutation = read('.github/workflows/mutation-testing.yml');
  assert.match(mutation, /node-version: 24/);
  assert.doesNotMatch(mutation, /node-version: 20/);
});

test('every workspace declares engines.node >=22', () => {
  for (const path of ['package.json', 'sdk/package.json', 'relayer/package.json', 'solver/package.json', 'mempool/package.json']) {
    assert.equal(JSON.parse(read(path)).engines.node, '>=22', path);
  }
});
