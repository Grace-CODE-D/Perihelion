// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  http,
  keccak256,
  numberToHex,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { ESCROW_ABI } from "../src/escrow-abi.js";
import { PerihelionEscrowClient } from "../src/escrow-client.js";

const ESCROW = "0x00000000000000000000000000000000000e5c10" as Address;
const INTENT_HASH = ("0x" + "ab".repeat(32)) as Hex;
const LOCK = {
  solver: "0x1111111111111111111111111111111111111111" as Address,
  user: "0x2222222222222222222222222222222222222222" as Address,
  asset: "0x3333333333333333333333333333333333333333" as Address,
  amount: 1_000_000n,
  minDestAmount: (1n << 127n) + 7n,
  deadline: 4102444800n,
  released: false,
  refunded: true,
};

test("ESCROW_ABI exposes the contract's locks getter and EnforcedPause error", () => {
  const names = ESCROW_ABI.map((e) => ("name" in e ? e.name : e.type));
  assert.ok(names.includes("locks"));
  assert.ok(names.includes("EnforcedPause"));
  assert.ok(!names.includes("getLock"));
  assert.ok(!names.includes("PausedError"));
});

function clientWithEthCall(handler: (data: Hex) => Hex) {
  const transport = custom({
    async request({ method, params }) {
      if (method === "eth_chainId") return numberToHex(foundry.id);
      if (method === "eth_call") return handler((params as [{ data: Hex }])[0].data);
      throw new Error(`unexpected RPC ${method}`);
    },
  });
  const publicClient = createPublicClient({ chain: foundry, transport });
  const walletClient = createWalletClient({ chain: foundry, transport });
  return new PerihelionEscrowClient(publicClient, walletClient, ESCROW);
}

test("getLock calls locks(bytes32) and maps the 8-value result", async () => {
  let calledWith: readonly unknown[] | undefined;
  const client = clientWithEthCall((data) => {
    assert.equal(data.slice(0, 10), toFunctionSelector("locks(bytes32)"));
    calledWith = decodeFunctionData({ abi: ESCROW_ABI, data }).args;
    return encodeFunctionResult({
      abi: ESCROW_ABI,
      functionName: "locks",
      result: [
        LOCK.solver,
        LOCK.user,
        LOCK.asset,
        LOCK.amount,
        LOCK.minDestAmount,
        LOCK.deadline,
        LOCK.released,
        LOCK.refunded,
      ],
    });
  });

  assert.deepEqual(await client.getLock(INTENT_HASH), LOCK);
  assert.deepEqual(calledWith, [INTENT_HASH]);
});

test("getLock returns undefined for the zero-valued record of an unknown intent", async () => {
  const client = clientWithEthCall(() =>
    encodeFunctionResult({
      abi: ESCROW_ABI,
      functionName: "locks",
      result: [zeroAddress, zeroAddress, zeroAddress, 0n, 0n, 0n, false, false],
    }),
  );
  assert.equal(await client.getLock(INTENT_HASH), undefined);
});

// ---------------------------------------------------------------------------
// Anvil: deploy the real contract and read a lock back through the SDK.
// Skipped unless Foundry (forge + anvil) is on PATH.
// ---------------------------------------------------------------------------

const EVM_DIR = fileURLToPath(new URL("../../contracts/evm/", import.meta.url));
// Anvil's well-known first dev account.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function hasFoundry(): boolean {
  try {
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function forgeInspect(field: string): string {
  return execFileSync("forge", ["inspect", "PerihelionEscrow", field, "--json"], {
    cwd: EVM_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

interface StorageLayout {
  storage: { label: string; slot: string; type: string }[];
  types: Record<string, { members?: { label: string; slot: string; offset: number }[] }>;
}

test("getLock returns the stored lock from a deployed escrow (Anvil)", {
  skip: !hasFoundry() && "forge/anvil not installed",
  timeout: 300_000,
}, async () => {
  const raw = forgeInspect("bytecode").trim();
  const bytecode = (raw.startsWith('"') ? JSON.parse(raw) : raw) as Hex;
  const layout = JSON.parse(forgeInspect("storageLayout")) as StorageLayout;

  const port = 20000 + Math.floor(Math.random() * 20000);
  const anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  try {
    const transport = http(`http://127.0.0.1:${port}`);
    const account = privateKeyToAccount(ANVIL_KEY);
    const publicClient = createPublicClient({ chain: foundry, transport });
    const walletClient = createWalletClient({ account, chain: foundry, transport });

    for (let i = 0; ; i++) {
      try {
        await publicClient.getChainId();
        break;
      } catch (err) {
        if (i >= 100) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const deployHash = await walletClient.deployContract({
      abi: ESCROW_ABI,
      bytecode,
      // Any non-zero endpoint: getLock never touches LayerZero.
      args: ["0x000000000000000000000000000000000000dEaD", 30148],
    });
    const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    assert.ok(contractAddress);

    // Seed locks[INTENT_HASH] directly, using the compiler's storage layout so
    // the test does not hard-code slot numbers or struct packing.
    const locks = layout.storage.find((s) => s.label === "locks");
    assert.ok(locks, "locks mapping missing from storage layout");
    const structType = locks.type.match(/^t_mapping\(t_bytes32,(.+)\)$/)?.[1];
    const members = structType && layout.types[structType]?.members;
    assert.ok(members, "Lock struct layout missing");
    const base = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256" }],
          [INTENT_HASH, BigInt(locks.slot)],
        ),
      ),
    );
    const words = new Map<bigint, bigint>();
    for (const m of members) {
      const v = LOCK[m.label as keyof typeof LOCK];
      const n = typeof v === "boolean" ? BigInt(v) : typeof v === "string" ? BigInt(v) : v;
      const slot = base + BigInt(m.slot);
      words.set(slot, (words.get(slot) ?? 0n) | (n << BigInt(m.offset * 8)));
    }
    for (const [slot, value] of words) {
      await publicClient.request({
        method: "anvil_setStorageAt" as never,
        params: [contractAddress, numberToHex(slot, { size: 32 }), numberToHex(value, { size: 32 })] as never,
      });
    }

    const client = new PerihelionEscrowClient(publicClient, walletClient, contractAddress);
    assert.deepEqual(await client.getLock(INTENT_HASH), LOCK);
    assert.equal(await client.getLock(("0x" + "cd".repeat(32)) as Hex), undefined);
  } finally {
    anvil.kill();
  }
});
