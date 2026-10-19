// SPDX-License-Identifier: MIT

/**
 * Decimal-aware unit helpers for Perihelion intent amounts.
 *
 * Asset decimal conventions are defined in docs/assets.md. In short, listed
 * EVM stablecoin source assets use 6 decimals, ETH-like ERC-20 assets commonly
 * use 18 decimals, and Stellar destination assets use 7 decimals.
 *
 * Use these helpers to convert human-readable amounts ("1.5") to/from the
 * smallest-unit decimal strings required by {@link Intent} fields, so callers
 * never need to reason about the 6↔7 decimal gap manually.
 *
 * @example
 * // 1 USDC on Base (6dp) → "1000000"
 * toSmallestUnits("1", 6)
 * // 0.99 USDC on Stellar (7dp) → "9900000"
 * toSmallestUnits("0.99", 7)
 */

import type { Address } from "viem";
import { PerihelionValidationError } from "./errors.js";

/** Upper bound on `decimals`, generous for any real asset but small enough to rule out unbounded BigInt exponentiation. */
const MAX_DECIMALS = 36;

/**
 * Encode a 20-byte EVM address as a 32-byte, left-padded hex string.
 *
 * Matches Solidity's `bytes32(uint256(uint160(addr)))` encoding used by
 * LayerZero for `Origin.sender`: the 20 address bytes occupy offsets 12-31
 * of the 32-byte word, with 12 leading zero bytes.
 *
 * @param address `0x`-prefixed 20-byte hex address, e.g. `"0x0000000000000000000000000000000000000001"`.
 * @returns `0x`-prefixed 32-byte hex string, e.g. `"0x0000000000000000000000000000000000000000000000000000000000000001"`.
 * @throws {PerihelionValidationError} If `address` is missing or not a valid `0x`-prefixed 20-byte hex address.
 */
export function evmAddressToBytes32(address: string): string {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new PerihelionValidationError(
      `evmAddressToBytes32: invalid EVM address "${String(address)}"`,
      "address",
    );
  }
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

/** Reject a `decimals` argument that is not a small non-negative integer. */
function assertValidDecimals(decimals: number, fn: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new PerihelionValidationError(
      `${fn}: decimals must be an integer between 0 and ${MAX_DECIMALS}, got ${decimals}`,
      "decimals",
    );
  }
}

/**
 * Convert a human-readable amount string to its smallest-unit integer string.
 *
 * @param human    Decimal amount, e.g. `"1.5"` or `"100"`.
 * @param decimals Number of decimal places for the asset (e.g. 6 for EVM USDC, 7 for Stellar USDC).
 * @returns Smallest-unit amount as a decimal string, e.g. `"1500000"`.
 * @throws If `human` is not a valid non-negative decimal number, or `decimals` is not an integer in `[0, 36]`.
 */
export function toSmallestUnits(human: string, decimals: number): string {
  assertValidDecimals(decimals, "toSmallestUnits");
  if (!/^\d+(\.\d+)?$/.test(human.trim())) {
    throw new PerihelionValidationError(`toSmallestUnits: invalid amount "${human}"`, "human");
  }
  const parts = human.trim().split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  if (frac.length > decimals) {
    throw new PerihelionValidationError(
      `toSmallestUnits: "${human}" has more than ${decimals} decimal places`,
      "human",
    );
  }
  const padded = frac.padEnd(decimals, "0");
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return raw.toString();
}

/**
 * Convert a smallest-unit integer string back to a human-readable decimal.
 *
 * Accepts an optional leading `-` for negative deltas (e.g. refund/adjustment
 * amounts); the sign is handled explicitly rather than left to `BigInt`'s `%`,
 * which retains the sign of the dividend and would otherwise produce a
 * malformed result like `fromSmallestUnits("-1500000", 6)` -> `"1.-5"` (issue #533).
 *
 * @param smallest Smallest-unit amount string, e.g. `"1500000"` or `"-1500000"`.
 * @param decimals Number of decimal places for the asset.
 * @returns Human-readable string, e.g. `"1.5"` or `"-1.5"`.
 * @throws If `smallest` is not a valid (optionally negative) integer string,
 *   or `decimals` is not an integer in `[0, 36]`.
 */
export function fromSmallestUnits(smallest: string, decimals: number): string {
  assertValidDecimals(decimals, "fromSmallestUnits");
  const trimmed = smallest.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new PerihelionValidationError(`fromSmallestUnits: invalid amount "${smallest}"`, "smallest");
  }
  const negative = trimmed.startsWith("-");
  const abs = negative ? BigInt(trimmed.slice(1)) : BigInt(trimmed);
  const factor = 10n ** BigInt(decimals);
  const whole = abs / factor;
  const frac = (abs % factor).toString().padStart(decimals, "0").replace(/0+$/, "");
  // Only prepend the sign if the magnitude is actually nonzero — avoids "-0".
  const sign = negative && (whole !== 0n || frac !== "") ? "-" : "";
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

/**
 * Encode a 20-byte EVM address into a 32-byte buffer, right-justified
 * (zeros in bytes 0–11, address in bytes 12–31).
 *
 * This matches the EVM ABI encoding `bytes32(uint256(uint160(addr)))` and is
 * the layout the escrow's `_decodeFillConfirmed` expects for `solver_evm`:
 * the upper 12 bytes must be zero, otherwise the payload is rejected as
 * `MalformedPayload` (issue #946).
 *
 * @param address 0x-prefixed 20-byte hex EVM address.
 * @returns 32-byte buffer with the address left-padded.
 * @throws If `address` is not a 0x-prefixed 20-byte hex string.
 */
export function evmAddressToBytes32(address: Address): Uint8Array {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new PerihelionValidationError(
      `evmAddressToBytes32: expected a 0x-prefixed 20-byte hex address, got "${String(address)}"`,
      "address",
    );
  }
  const out = new Uint8Array(32);
  const hex = address.slice(2);
  for (let i = 0; i < 20; i++) {
    out[12 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
