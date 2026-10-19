#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Writes sdk/src/escrow-abi.ts from the Foundry build artefact of
// PerihelionEscrow, so the SDK ABI can never drift from the contract.
// The ABI array is emitted verbatim (JSON.stringify of the artefact's `abi`).
//
// Usage (after `forge build` in contracts/evm):
//   node scripts/gen-escrow-abi.mjs           # rewrite sdk/src/escrow-abi.ts
//   node scripts/gen-escrow-abi.mjs --check   # fail if the committed file is stale
//   node scripts/gen-escrow-abi.mjs --artifact <path>   # use another artefact

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "sdk/src/escrow-abi.ts");

const args = process.argv.slice(2);
const check = args.includes("--check");
const artifactIdx = args.indexOf("--artifact");
const artifact =
  artifactIdx >= 0
    ? args[artifactIdx + 1]
    : join(ROOT, "contracts/evm/out/PerihelionEscrow.sol/PerihelionEscrow.json");

let abi;
try {
  abi = JSON.parse(readFileSync(artifact, "utf8")).abi;
} catch (err) {
  console.error(`cannot read ABI from ${artifact}: ${err.message}`);
  console.error("Build the contract first: (cd contracts/evm && forge build)");
  process.exit(1);
}
if (!Array.isArray(abi) || abi.length === 0) {
  console.error(`${artifact} has no ABI`);
  process.exit(1);
}

const source = `// SPDX-License-Identifier: MIT

/**
 * PerihelionEscrow ABI.
 *
 * GENERATED FILE — DO NOT EDIT. Derived from the Foundry build artefact of
 * contracts/evm/src/PerihelionEscrow.sol by scripts/gen-escrow-abi.mjs.
 * Regenerate with \`make sdk-abi\`; CI fails if this file is stale.
 */

export const ESCROW_ABI = ${JSON.stringify(abi, null, 2)} as const;
`;

const rel = relative(ROOT, OUT);
if (check) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {}
  if (current !== source) {
    console.error(`::error::${rel} is out of date with the contract build.`);
    console.error("  Run: make sdk-abi   (then commit the result)");
    process.exit(1);
  }
  console.log(`ok ${rel} matches the contract build`);
} else {
  writeFileSync(OUT, source);
  console.log(`wrote ${rel} (${abi.length} ABI entries)`);
}
