# Differential Fuzzing Corpus

This directory holds **hand-curated regression inputs** for cross-language validation with the Solidity decoder. It is tracked in git and is only ever **read** by tests — nothing writes here automatically.

Generated corpus output from the Rust proptest fuzzer goes to an ignored location instead (`target/fuzz-corpus/` by default, or the directory named by `PERIHELION_FUZZ_CORPUS_DIR`).

## Purpose

The Rust fuzzer exports adversarial and edge-case payloads as `.hex` files. The EVM test suite (`CrossValidate.t.sol`) reads these files and validates that the Solidity decoder handles them identically to the Rust decoder — either accepting with identical field values, or rejecting with the same error.

Two directories are involved:

| Directory | Tracked | Written by | Read by |
|-----------|---------|------------|---------|
| `contracts/shared/wire-vectors/fuzz-corpus/` (this one) | yes | humans only | tests (read-only) |
| `target/fuzz-corpus/` (or `$PERIHELION_FUZZ_CORPUS_DIR`) | no (gitignored) | `cargo test fuzz` | `CrossValidate.t.sol` in CI |

## File Naming Convention

- `<message_type>_<mutation>.hex` — adversarial payloads
- `<message_type>_<case_id>.hex` — edge cases from proptest

Examples:
- `fill_confirmed_nonzero_high.hex` — FillConfirmed with non-zero high bytes in `solver_evm`
- `cancel_intent_bad_reason.hex` — CancelIntent with unknown reason code

## Generated Files

Generated corpus files are written to `target/fuzz-corpus/` (gitignored) by running:
```bash
cd contracts/soroban/settlement
PROPTEST_CASES=100 cargo test fuzz -- --test-threads=1
```

To write them somewhere else (e.g. a shared path for the Solidity side), set `PERIHELION_FUZZ_CORPUS_DIR`:
```bash
cd contracts/soroban/settlement
PERIHELION_FUZZ_CORPUS_DIR=../../evm/fuzz-corpus PROPTEST_CASES=100 cargo test fuzz -- --test-threads=1
```

Do not edit generated files manually. To regenerate from scratch:
```bash
rm -rf target/fuzz-corpus
./scripts/run-differential-fuzz.sh bounded
```

## Git Tracking

This directory is tracked in git to preserve interesting edge cases discovered during fuzzing. When a new class of divergence is found:

1. Proptest generates a regression file in `proptest-regressions/`
2. The generated payload lands in `target/fuzz-corpus/`
3. Copy the interesting payload into this directory under a descriptive name and commit it, so the regression is tested in CI

Never copy the whole generated corpus here — only the minimal curated inputs.

## CI Integration

The `differential-fuzz.yml` workflow:
1. Runs the Rust fuzzer, which writes corpus files to `target/fuzz-corpus/`
2. Uploads `target/fuzz-corpus/` as artifacts
3. Downloads them in the `cross-validate` job and points `PERIHELION_FUZZ_CORPUS_DIR` at the downloaded directory
4. Runs `CrossValidate.t.sol` to verify Solidity handles them correctly

## Local Validation

After generating the corpus locally:
```bash
cd contracts/evm
PERIHELION_FUZZ_CORPUS_DIR=../../target/fuzz-corpus forge test --match-contract CrossValidate -vv
```

To inspect a specific payload:
```bash
cat fill_confirmed_nonzero_high.hex
# 0x0102111111111111111111111111111111111111111111111111111111111111111111111111ff00000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa00000000000000000000000000000f424000000000000000002a
```

Decode manually:
```bash
cast abi-decode "decodeFillConfirmed(bytes)" $(cat fill_confirmed_nonzero_high.hex)
```

## Cleanup

To remove stale **generated** corpus files (e.g., after refactoring message types), just delete the ignored directory — no git changes are involved:
```bash
rm -rf target/fuzz-corpus
```

To remove a stale **curated** regression input, delete the specific file and commit the removal:
```bash
git rm contracts/shared/wire-vectors/fuzz-corpus/<name>.hex
git commit -m "Clean differential fuzz corpus"
```
