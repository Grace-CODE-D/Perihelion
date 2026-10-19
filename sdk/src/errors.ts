// SPDX-License-Identifier: MIT

/**
 * Typed error hierarchy for the Perihelion SDK.
 *
 * Integrators should catch these types to distinguish error categories
 * programmatically rather than string-matching error messages.
 *
 * @example
 * ```ts
 * import { PerihelionHttpError, PerihelionTimeoutError } from "@perihelion/sdk";
 *
 * try {
 *   await client.submitIntent(signed);
 * } catch (e) {
 *   if (e instanceof PerihelionHttpError && e.status === 400) {
 *     // validation rejection — don't retry, surface to user
 *   } else if (e instanceof PerihelionHttpError && e.status >= 500) {
 *     // server error — retry
 *   }
 * }
 * ```
 */

/** Base class for all Perihelion SDK errors. */
export class PerihelionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** Thrown when an HTTP request to the mempool returns a non-2xx status. */
export class PerihelionHttpError extends PerihelionError {
  readonly status: number;
  readonly body: string;
  readonly operation: string;
  constructor(operation: string, status: number, body: string, options?: ErrorOptions) {
    super(`[Perihelion] ${operation} failed: HTTP ${status} — ${body}`, options);
    this.operation = operation;
    this.status = status;
    this.body = body;
  }
}

/**
 * Thrown when a request or `waitForSettlement` exceeds its configured timeout.
 * For `waitForSettlement`, `lastStatus` holds the most recent observed status.
 */
export class PerihelionTimeoutError extends PerihelionError {
  readonly intentHash?: string;
  readonly lastStatus?: string;
  constructor(message: string, intentHash?: string, lastStatus?: string, options?: ErrorOptions) {
    super(message, options);
    this.intentHash = intentHash;
    this.lastStatus = lastStatus;
  }
}

/** Thrown when a network or transport failure occurs communicating with the mempool. */
export class PerihelionNetworkError extends PerihelionError {
  readonly operation?: string;
  constructor(message: string, operation?: string, options?: ErrorOptions) {
    super(message, options);
    this.operation = operation;
  }
}

/** Thrown when intent fields fail client-side validation before submission. */
export class PerihelionValidationError extends PerihelionError {
  readonly field?: string;
  constructor(message: string, field?: string, options?: ErrorOptions) {
    super(message, options);
    this.field = field;
  }
}

/**
 * Thrown when an intent fails field-level validation in `validateIntent` or
 * `buildIntent`. Extends {@link PerihelionValidationError} so callers can
 * catch either the specific type or the broader validation superclass.
 *
 * `field` names the first intent field that failed; `message` describes the
 * constraint that was violated.
 *
 * @example
 * ```ts
 * try {
 *   validateIntent(params);
 * } catch (e) {
 *   if (e instanceof IntentValidationError) {
 *     console.error(`Intent field '${e.field}' is invalid: ${e.message}`);
 *   }
 * }
 * ```
 */
export class IntentValidationError extends PerihelionValidationError {
  constructor(field: string, message: string, options?: ErrorOptions) {
    super(message, field, options);
  }
}

/**
 * Thrown when the mempool returns a hash that does not match the locally-computed
 * hash. This indicates a server bug or tampering attempt.
 */
export class PerihelionHashMismatchError extends PerihelionError {
  readonly localHash: string;
  readonly serverHash: string;
  constructor(localHash: string, serverHash: string, options?: ErrorOptions) {
    super(
      `[Perihelion] Server returned hash ${serverHash} but locally-computed hash is ${localHash}. ` +
        `This may indicate a server bug or tampering. The local hash is authoritative.`,
      options,
    );
    this.localHash = localHash;
    this.serverHash = serverHash;
  }
}

/**
 * Thrown when a contract call reverts with a custom error decoded from the
 * escrow ABI. `errorName` is the Solidity error identifier (e.g.
 * `"NoPendingOwner"`), `selector` is the 4-byte selector as a hex string, and
 * `args` holds any decoded error arguments.
 *
 * @example
 * ```ts
 * try {
 *   await escrow.write.cancelOwnershipTransfer();
 * } catch (e) {
 *   if (e instanceof PerihelionContractError && e.errorName === "NoPendingOwner") {
 *     // nothing to cancel — no pending transfer exists
 *   }
 * }
 * ```
 */
export class PerihelionContractError extends PerihelionError {
  readonly errorName: string;
  readonly selector?: string;
  readonly args?: readonly unknown[];
  constructor(
    errorName: string,
    selector?: string,
    args?: readonly unknown[],
    options?: ErrorOptions,
  ) {
    super(
      `[Perihelion] Contract reverted with ${errorName}` +
        (selector ? ` (selector ${selector})` : ""),
      options,
    );
    this.errorName = errorName;
    this.selector = selector;
    this.args = args;
  }
}

/**
 * Thrown when `cancelOwnershipTransfer` is called but no ownership transfer is
 * pending. The caller is the owner; the failure is that there is nothing to
 * cancel, not that the caller lacks ownership.
 */
export class NoPendingOwnerError extends PerihelionContractError {
  constructor(selector?: string, options?: ErrorOptions) {
    super("NoPendingOwner", selector, undefined, options);
  }
}

/**
 * Thrown when an asset is being allowlisted but the address has no contract
 * code. No transfer is attempted; the asset simply is not a contract.
 */
export class NotAContractError extends PerihelionContractError {
  constructor(selector?: string, options?: ErrorOptions) {
    super("NotAContract", selector, undefined, options);
  }
}

/**
 * Thrown when a call is made while the contract is paused. The contract
 * reverts with OpenZeppelin's `EnforcedPause()` error.
 */
export class EnforcedPauseError extends PerihelionContractError {
  constructor(selector?: string, options?: ErrorOptions) {
    super("EnforcedPause", selector, undefined, options);
  }
}

/** Known custom error names emitted by the escrow contract. */
export type EscrowErrorName =
  | "NoPendingOwner"
  | "NotAContract"
  | "EnforcedPause"
  | "NotOwner"
  | "TransferFailed"
  | "NotAllowed"
  | "InvalidAmount"
  | "InvalidDeadline"
  | "AlreadySettled"
  | "IntentExpired"
  | "Unauthorized"
  | "ReentrancyGuardReentrantCall";

/**
 * Map a decoded contract error name to the matching typed SDK error. Unknown
 * names fall back to a generic {@link PerihelionContractError}.
 */
export function contractErrorFromName(
  errorName: string,
  selector?: string,
  args?: readonly unknown[],
  options?: ErrorOptions,
): PerihelionContractError {
  switch (errorName) {
    case "NoPendingOwner":
      return new NoPendingOwnerError(selector, options);
    case "NotAContract":
      return new NotAContractError(selector, options);
    case "EnforcedPause":
      return new EnforcedPauseError(selector, options);
    default:
      return new PerihelionContractError(errorName, selector, args, options);
  }
}
