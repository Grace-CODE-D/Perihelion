// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeToScVal, scValToNative, scvU32, scvVoid } from "@stellar/stellar-sdk";
import { FatalError } from "../src/relayer.js";
import { SorobanDestinationDelivery } from "../src/soroban-delivery.js";

const SIGNER_SECRET = "SATIFRDTRKIU6OIU3FURVUO2NIVO5KVH6GQIAGBFPMV4UE4WOXYK5PBW";
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const INTENT_HASH = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeDelivery(): SorobanDestinationDelivery {
  return new SorobanDestinationDelivery({
    rpcUrl: "https://soroban.example",
    networkPassphrase: "Test SDF Network ; September 2015",
    settlementContractId: CONTRACT_ID,
    signerSecret: SIGNER_SECRET,
  });
}

test("Soroban delivery encodes intent hashes as 32 raw bytes", () => {
  const delivery = makeDelivery();
  const scVal = (delivery as unknown as { intentHashScVal(hash: string): unknown })
    .intentHashScVal(INTENT_HASH);
  const native = scValToNative(scVal as Parameters<typeof scValToNative>[0]);

  assert.deepEqual(Buffer.from(native as Uint8Array), Buffer.from(INTENT_HASH.slice(2), "hex"));
});

test("Soroban delivery rejects invalid intent hash lengths", () => {
  const delivery = makeDelivery();
  assert.throws(
    () => (delivery as unknown as { intentHashScVal(hash: string): unknown })
      .intentHashScVal("0x1234"),
    FatalError,
  );
});

test("Soroban delivery encodes the intent deadline in the FillInstruction", () => {
  const delivery = makeDelivery();
  const deadline = 1_700_000_123n;
  const message = {
    srcEid: 1,
    dstEid: 2,
    intentHash: INTENT_HASH,
    messageType: 0,
    solver: "0x0000000000000000000000000000000000000001",
    recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    destAsset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    amount: "1000",
    nonce: 7,
    deadline,
  };

  const scVal = (delivery as unknown as {
    appendLzReceiveCall(args: {
      message: unknown;
      guid: string;
      payload: Uint8Array;
    }): { operations(): Array<{ body(): { invokeHostFunction(): { invokeContractOp(): { contractAddress(): unknown; functionName(): unknown; args(): unknown[] } } } }> };
  }).appendLzReceiveCall({
    message,
    guid: "0x" + "11".repeat(32),
    payload: new Uint8Array([1, 2, 3]),
  });

  const op = scVal.operations()[0]!.body().invokeHostFunction().invokeContractOp();
  const args = op.args();
  const decoded = scValToNative(args[args.length - 1] as Parameters<typeof scValToNative>[0]) as {
    deadline: bigint;
  };

  assert.equal(decoded.deadline, deadline);
  assert.notEqual(decoded.deadline, 0n);
});

test("Soroban delivery preserves FatalError", async () => {
  const delivery = makeDelivery();
  const fatal = new FatalError("permanent delivery failure");
  (delivery as unknown as { isEntryArchived(): Promise<boolean> }).isEntryArchived = async () => {
    throw fatal;
  };

  await assert.rejects(() => delivery.deliver({} as never), (error) => error === fatal);
});

test("Soroban delivery preserves the cause of ordinary errors", async () => {
  const delivery = makeDelivery();
  const original = new Error("temporary RPC failure");
  (delivery as unknown as { isEntryArchived(): Promise<boolean> }).isEntryArchived = async () => {
    throw original;
  };

  await assert.rejects(
    () => delivery.deliver({} as never),
    (error: unknown) => error instanceof Error && error.cause === original,
  );
});
