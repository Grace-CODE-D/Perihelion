# Dependency and lockfile policy

Perihelion keeps dependency updates and security triage explicit so that the bridge can be rebuilt reproducibly and audited consistently.

## Lockfiles and vendored dependencies

- The repository commits the npm lockfile at [package-lock.json](../package-lock.json) and the Soroban Rust lockfile at [contracts/soroban/Cargo.lock](../contracts/soroban/Cargo.lock).
- The repository does not commit `node_modules` or other generated install trees. Those directories are ignored and should be recreated with `npm ci`.
- The Soroban lockfile is committed because the contract workspace is part of the audited release artifact and must remain reproducible.

## Update cadence

- Dependencies should be reviewed on a regular basis, at least once per release train and whenever a dependency advisory is published.
- Runtime-critical components (SDK, relayer, solver, and contract dependencies) should be updated promptly when a patched version is available.
- Lockfiles must be regenerated and committed together with any manifest changes.
- [.github/dependabot.yml](../.github/dependabot.yml) opens a weekly update PR for each of the three ecosystems in use: npm (root workspace, covering `sdk`, `relayer`, `solver`, `mempool`, `test`), cargo (`contracts/soroban`), and github-actions (workflow-pinned actions). Dev dependencies and `@types/*` packages are grouped separately from runtime npm dependencies to keep PR volume manageable.
- Dependabot PRs are reviewed by whichever CODEOWNERS rule matches the changed manifest — a `contracts/soroban/Cargo.toml` bump routes to `@Perihelion-Protocol/soroban-maintainers`, a workflow bump to `@Perihelion-Protocol/maintainers`, and so on. No separate reviewer list is needed; see [CODEOWNERS](../.github/CODEOWNERS).
- A major-version bump (e.g. the pending `@stellar/stellar-sdk` v12 → current major) should not be merged as a routine Dependabot PR — close it with a comment linking to a tracked upgrade issue instead, since major bumps typically require code changes beyond the manifest.

## Vulnerability triage

- CI runs an npm audit job and a `cargo deny` job on pushes, pull requests, and a weekly schedule. The Rust job checks `advisories`, `licenses`, `bans`, and `sources` against [deny.toml](../deny.toml), so an unpatched advisory, an incompatible licence, a wildcard version requirement, or a dependency from an unknown registry or git source each fail the build.
- The workflow fails on high and critical advisories unless they are explicitly allowlisted in [.github/dependency-audit-allowlist.json](../.github/dependency-audit-allowlist.json) for the npm side and in [deny.toml](../deny.toml) for the Rust side.
- Any allowlisted advisory must include a short rationale and an expiry date in the corresponding file so the exception does not become permanent.

## Rust dependency policy

The policy lives in [deny.toml](../deny.toml) and applies to the Soroban workspace.

- **Licences.** Only permissive licences are allowed: MIT, Apache-2.0 (including the
  LLVM-exception variant), BSD-2-Clause, BSD-3-Clause, ISC, Unicode-3.0, Unlicense, and Zlib.
  Perihelion ships under MIT, so a copyleft dependency (GPL, AGPL, MPL) is a licence
  incompatibility and is rejected rather than warned about.
- **Advisories.** `yanked = "deny"`. Any RustSec advisory fails the job.
- **Bans.** Wildcard version requirements are denied. Duplicate versions of a crate warn rather
  than fail, because the fix usually sits in a transitive dependency, but they are tracked:
  duplicates inflate the wasm artefact and Soroban caps contract size.
- **Sources.** Unknown registries and git sources are denied, so every crate comes from
  crates.io.

### Exception process

1. Open an issue describing the advisory or licence and why the dependency cannot be replaced.
2. Add the entry to the relevant section of `deny.toml` with an inline comment giving the
   rationale, the issue link, and an expiry date.
3. An exception is a temporary measure. Reviewing expired entries is part of the release
   checklist, and an entry past its expiry is treated as a build failure to be fixed, not
   extended by default.

Run the same checks locally before pushing:

```bash
make audit          # all three ecosystems
make audit-rust     # cargo-deny only
```

## Maintenance checklist

1. Update dependency manifests.
2. Regenerate the relevant lockfiles.
3. Re-run the security scans locally (`make audit`) and in CI.
4. Document any allowlisted exception with rationale and expiry.
