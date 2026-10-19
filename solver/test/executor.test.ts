// SPDX-License-Identifier: MIT

/**
 * Tests for Executor: fill flow, idempotency, and error paths.
 *
 * The executor makes real network calls (viem + Soroban RPC), so these tests
 * mock the transport layer at the boundary. We use the dependency-injection
 * seam exposed by the class: replace the internal factory functions by
 * patching the module-level viem and Stellar SDK clients with stubs that
 * capture calls and return canned responses.
 *
 * Because ESM modules are sealed, we cannot monkey-patch named exports after
 * import. Instead we inject the behavior by overriding globalThis.fetch (used
 * by viem's http transport under the hood) and by providing a subclass that
 * exposes the private methods for unit testing their logic in isolation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntent, hashIntent, perihelionDomain } from "@perihelion/sdk";
import type { Hex, SignedIntent } from "@perihelion/sdk";
import { nativeToScVal, scvU32, scvVoid } from "@stellar/stellar-sdk";
import { Executor, type ExecutorConfig, type Logger } from "../src/executor.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const EVM_PRIVATE_KEY =
  ("0x" + "1".repeat(64)) as Hex; // deterministic: same address every run
const SOROBAN_SECRET =
  "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ESCROW_ADDRESS = "0x2222222222222222222222222222222222222222" as const;
const SETTLEMENT_ID = "C" + "A".repeat(55);
const STELLAR_NETWORK = "Test SDF Network ; September 2015";

const BASE_CONFIG: ExecutorConfig = {
  evmRpcUrl: "http://localhost:8545",
  sorobanRpcUrl: "http://localhost:8000",
  evmPrivateKey: EVM_PRIVATE_KEY,
  sorobanSecretKey: SOROBAN_SECRET,
  escrowAddress: ESCROW_ADDRESS,
  settlementContractId: SETTLEMENT_ID,
  sourceChainId: 8453,
  stellarNetwork: STELLAR_NETWORK,
};

const SILENT_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CHAIN_ID = 8453;
const ESCROW_ADDR = "0x0000000000000000000000000000000000000001" as const;
const domain = perihelionDomain(CHAIN_ID, ESCROW_ADDR);

function makeIntent() {
  return buildIntent({
    user: "0x0000000000000000000000000000000000000002",
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000003",
    sourceAmount: "1000000",
    destAsset: "native",
    minDestAmount: "990000",
    deadline: Math.floor(Date.now() / 1000) + 600,
    nonce: "42",
  });
}

function makeSignedIntent(): SignedIntent {
  const intent = makeIntent();
  return {
    intent,
    signature: ("0x" + "ab".repeat(65)) as Hex,
    hash: hashIntent(intent, domain),
  };
}

// ─── Testable subclass ────────────────────────────────────────────────────────
//
// Exposes private methods so we can unit-test them independently without
// standing up real RPC endpoints. TypeScript sees them as private; the runtime
// property access works normally since JS has no private slots here.

type PrivateExecutor = Executor & {
  checkFillStatus(hash: Hex): Promise<{ filled: boolean; settlementTx?: string }>;
  isSettled(hash: Hex): Promise<boolean>;
  lockOnEvm(signed: SignedIntent): Promise<Hex>;
  fillOnSoroban(signed: SignedIntent, lockTx: Hex): Promise<Hex>;
};

function expose(config: Partial<ExecutorConfig> = {}): PrivateExecutor {
  return new Executor({ ...BASE_CONFIG, ...config }, SILENT_LOGGER) as unknown as PrivateExecutor;
}

// ─── fill(): idempotency via checkFillStatus ──────────────────────────────────

test("fill: returns early if intent is already settled", async () => {
  const signed = makeSignedIntent();
  const logs: string[] = [];

  // Subclass that overrides checkFillStatus to report already-settled.
  class IdempotentExecutor extends Executor {
    protected override async checkFillStatus(
      _hash: Hex,
    ): Promise<{ filled: boolean; settlementTx?: string }> {
      return { filled: true, settlementTx: "0xexisting" as Hex };
    }
    protected override async lockOnEvm(_: SignedIntent): Promise<Hex> {
      throw new Error("lockOnEvm must not be called when already settled");
    }
    protected override async fillOnSoroban(
      _: SignedIntent,
      __: Hex,
    ): Promise<Hex> {
      throw new Error("fillOnSoroban must not be called when already settled");
    }
  }

  const executor = new IdempotentExecutor(
    BASE_CONFIG,
    { info: (msg) => logs.push(msg), warn: () => {}, error: () => {} },
  );

  const result = await executor.fill(signed);
  assert.equal(result.settlementTx, "0xexisting");
  assert.ok(
    logs.some((l) => l.includes("already settled")),
    "expected 'already settled' log",
  );
});

test("fill: calls lockOnEvm then fillOnSoroban in order, returns settlementTx", async () => {
  const signed = makeSignedIntent();
  const callOrder: string[] = [];

  class OrderedExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async lockOnEvm(_: SignedIntent): Promise<Hex> {
      callOrder.push("lock");
      return "0xlockTx" as Hex;
    }
    protected override async fillOnSoroban(
      _: SignedIntent,
      lockTx: Hex,
    ): Promise<Hex> {
      assert.equal(lockTx, "0xlockTx", "fillOnSoroban receives the lockTx");
      callOrder.push("fill");
      return "0xstellarTx" as Hex;
    }
  }

  const executor = new OrderedExecutor(BASE_CONFIG, SILENT_LOGGER);
  const result = await executor.fill(signed);

  assert.deepEqual(callOrder, ["lock", "fill"]);
  assert.equal(result.settlementTx, "0xstellarTx");
});

test("fill: propagates lockOnEvm errors to the caller", async () => {
  const signed = makeSignedIntent();

  class FailingLockExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      throw new Error("EVM RPC unavailable");
    }
    protected override async fillOnSoroban(): Promise<Hex> {
      throw new Error("fillOnSoroban must not be called after lock failure");
    }
  }

  const executor = new FailingLockExecutor(BASE_CONFIG, SILENT_LOGGER);
  await assert.rejects(
    () => executor.fill(signed),
    /EVM RPC unavailable/,
  );
});

test("fill: propagates fillOnSoroban errors to the caller", async () => {
  const signed = makeSignedIntent();

  class FailingSorobanExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      return "0xlockTx" as Hex;
    }
    protected override async fillOnSoroban(): Promise<Hex> {
      throw new Error("Soroban simulation failed");
    }
  }

  const executor = new FailingSorobanExecutor(BASE_CONFIG, SILENT_LOGGER);
  await assert.rejects(
    () => executor.fill(signed),
    /Soroban simulation failed/,
  );
});

// ─── checkFillStatus ──────────────────────────────────────────────────────────

test("checkFillStatus: returns filled=false when isSettled returns false", async () => {
  class NotSettledExecutor extends Executor {
    protected override async isSettled(_: Hex): Promise<boolean> {
      return false;
    }
  }
  const ex = new NotSettledExecutor(BASE_CONFIG, SILENT_LOGGER) as PrivateExecutor;
  const result = await ex.checkFillStatus(makeSignedIntent().hash);
  assert.equal(result.filled, false);
  assert.equal(result.settlementTx, undefined);
});

test("checkFillStatus: returns filled=true with intentHash as marker when isSettled returns true", async () => {
  const signed = makeSignedIntent();
  class SettledExecutor extends Executor {
    protected override async isSettled(_: Hex): Promise<boolean> {
      return true;
    }
  }
  const ex = new SettledExecutor(BASE_CONFIG, SILENT_LOGGER) as PrivateExecutor;
  const result = await ex.checkFillStatus(signed.hash);
  assert.equal(result.filled, true);
  assert.equal(result.settlementTx, signed.hash);
});

test("checkFillStatus: swallows isSettled errors and returns filled=false", async () => {
  class ThrowingExecutor extends Executor {
    protected override async isSettled(_: Hex): Promise<boolean> {
      throw new Error("RPC timeout");
    }
  }
  const ex = new ThrowingExecutor(BASE_CONFIG, SILENT_LOGGER) as PrivateExecutor;
  // Must not throw — query failure is treated as "not yet settled"
  const result = await ex.checkFillStatus(makeSignedIntent().hash);
  assert.equal(result.filled, false);
});

// ─── isSettled: decoding real ScVal status encodings ─────────────────────────
//
// `status(intent_hash)` returns `Option<IntentStatus>`, where `IntentStatus` is
// a `#[contracttype]` C-like enum (Locked = 0, Filled = 1, ConfirmationSent = 2,
// Cancelled = 3). Soroban encodes it as a `u32`, and `None` as void. These tests
// feed real `ScVal` encodings through the decoder to verify classification.

type StatusDecoder = {
  decodeStatus(retval: unknown): unknown;
};

function statusDecoder(): StatusDecoder {
  const ex = expose() as unknown as StatusDecoder;
  assert.equal(
    typeof ex.decodeStatus,
    "function",
    "Executor must expose a decodeStatus helper for status ScVals",
  );
  return ex;
}

test("isSettled: Filled (scvU32(1)) counts as settled", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvU32(1)), "Filled");
});

test("isSettled: ConfirmationSent (scvU32(2)) counts as settled", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvU32(2)), "ConfirmationSent");
});

test("isSettled: Locked (scvU32(0)) does not count as settled", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvU32(0)), "Locked");
});

test("isSettled: Cancelled (scvU32(3)) does not count as settled", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvU32(3)), "Cancelled");
});

test("isSettled: None (scvVoid()) decodes as not registered", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvVoid()), undefined);
});

test("isSettled: native u32 values are classified correctly", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(nativeToScVal(1, { type: "u32" })), "Filled");
  assert.equal(
    decoder.decodeStatus(nativeToScVal(2, { type: "u32" })),
    "ConfirmationSent",
  );
  assert.equal(decoder.decodeStatus(nativeToScVal(0, { type: "u32" })), "Locked");
  assert.equal(
    decoder.decodeStatus(nativeToScVal(3, { type: "u32" })),
    "Cancelled",
  );
  assert.equal(decoder.decodeStatus(nativeToScVal(null)), undefined);
});

test("isSettled: unknown discriminants decode as undefined", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvU32(99)), undefined);
});

// ─── Constructor: config validation ──────────────────────────────────────────

test("Executor: constructs without throwing for valid config", () => {
  assert.doesNotThrow(() => new Executor(BASE_CONFIG, SILENT_LOGGER));
});

// ─── loadExecutorConfig ───────────────────────────────────────────────────────

test("loadExecutorConfig: throws consolidated error for all missing required vars", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  assert.throws(
    () => loadExecutorConfig({}),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return (
        msg.includes("PERIHELION_EVM_RPC_URL is required") &&
        msg.includes("PERIHELION_SOROBAN_RPC_URL is required") &&
        msg.includes("PERIHELION_EVM_PRIVATE_KEY is required") &&
        msg.includes("PERIHELION_SOROBAN_SECRET_KEY is required") &&
        msg.includes("PERIHELION_ESCROW_ADDRESS is required") &&
        msg.includes("PERIHELION_SETTLEMENT_CONTRACT_ID is required") &&
        msg.includes("STELLAR_NETWORK is required")
      );
    },
  );
});

test("loadExecutorConfig: returns valid config when all vars are present", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  const config = loadExecutorConfig({
    PERIHELION_EVM_RPC_URL: "http://localhost:8545",
    PERIHELION_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    PERIHELION_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    PERIHELION_SOROBAN_SECRET_KEY:
      "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    PERIHELION_ESCROW_ADDRESS: ESCROW_ADDRESS,
    PERIHELION_SETTLEMENT_CONTRACT_ID: "0".repeat(64),
    PERIHELION_SOURCE_CHAIN_ID: "8453",
    STELLAR_NETWORK: STELLAR_NETWORK,
  });
  assert.equal(config.sourceChainId, 8453);
  assert.equal(config.stellarNetwork, STELLAR_NETWORK);
  assert.equal(
    config.escrowAddress.toLowerCase(),
    ESCROW_ADDRESS.toLowerCase(),
  );
});

test("loadExecutorConfig: rejects malformed EVM escrow address", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  assert.throws(
    () =>
      loadExecutorConfig({
        PERIHELION_EVM_RPC_URL: "http://localhost:8545",
        PERIHELION_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        PERIHELION_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        PERIHELION_SOROBAN_SECRET_KEY:
          "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        PERIHELION_ESCROW_ADDRESS: "not-an-address",
        PERIHELION_SETTLEMENT_CONTRACT_ID: "0".repeat(64),
        STELLAR_NETWORK: STELLAR_NETWORK,
      }),
    /PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed 20-byte EVM address/,
  );
});

test("loadExecutorConfig: rejects EVM private key without 0x prefix", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  assert.throws(
    () =>
      loadExecutorConfig({
        PERIHELION_EVM_RPC_URL: "http://localhost:8545",
        PERIHELION_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        PERIHELION_EVM_PRIVATE_KEY: "1".repeat(64), // missing 0x
        PERIHELION_SOROBAN_SECRET_KEY:
          "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        PERIHELION_ESCROW_ADDRESS: ESCROW_ADDRESS,
        PERIHELION_SETTLEMENT_CONTRACT_ID: "0".repeat(64),
        STELLAR_NETWORK: STELLAR_NETWORK,
      }),
    /PERIHELION_EVM_PRIVATE_KEY must start with 0x/,
  );
});

test("loadExecutorConfig: rejects non-positive source chain id", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  assert.throws(
    () =>
      loadExecutorConfig({
        PERIHELION_EVM_RPC_URL: "http://localhost:8545",
        PERIHELION_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        PERIHELION_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        PERIHELION_SOROBAN_SECRET_KEY:
          "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        PERIHELION_ESCROW_ADDRESS: ESCROW_ADDRESS,
        PERIHELION_SETTLEMENT_CONTRACT_ID: "0".repeat(64),
        STELLAR_NETWORK: STELLAR_NETWORK,
        PERIHELION_SOURCE_CHAIN_ID: "-1",
      }),
    /PERIHELION_SOURCE_CHAIN_ID must be a positive integer/,
  );
});

// ─── Protected-method override tests (via subclassing) ───────────────────────
//
// isSettled and lock/fill take real RPC clients. We test their observable
// contract — the inputs they propagate and the outputs they produce — by
// subclassing the Executor and overriding just the boundary that touches the
// network, verifying the surrounding orchestration logic.

test("fill: logs locked-on-EVM and filled-on-Soroban info messages", async () => {
  const signed = makeSignedIntent();
  const infos: string[] = [];

  class InstrumentedExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      return "0xlockHash" as Hex;
    }
    protected override async fillOnSoroban(): Promise<Hex> {
      return "0xsorobanHash" as Hex;
    }
  }

  const executor = new InstrumentedExecutor(BASE_CONFIG, {
    info: (msg) => infos.push(msg),
    warn: () => {},
    error: () => {},
  });

  await executor.fill(signed);

  assert.ok(infos.some((m) => m.includes("locked on EVM")));
  assert.ok(infos.some((m) => m.includes("filled on Soroban")));
});

test("fill: idempotent — second call with settled intent returns same settlementTx", async () => {
  const signed = makeSignedIntent();
  let lockCalls = 0;

  class CountingExecutor extends Executor {
    private settled = false;
    protected override async checkFillStatus(
      hash: Hex,
    ): Promise<{ filled: boolean; settlementTx?: string }> {
      if (this.settled) return { filled: true, settlementTx: "0xsettled" as Hex };
      return { filled: false };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      lockCalls++;
      return "0xlockTx" as Hex;
    }
    protected override async fillOnSoroban(): Promise<Hex> {
      this.settled = true;
      return "0xsettled" as Hex;
    }
  }

  const executor = new CountingExecutor(BASE_CONFIG, SILENT_LOGGER);

  const first = await executor.fill(signed);
  assert.equal(first.settlementTx, "0xsettled");
  assert.equal(lockCalls, 1);

  const second = await executor.fill(signed);
  assert.equal(second.settlementTx, "0xsettled");
  // Lock must not be called again on the second attempt.
  assert.equal(lockCalls, 1, "lockOnEvm must not be called a second time");
});
