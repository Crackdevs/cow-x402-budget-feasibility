# CoW x402 budget feasibility proof

**Experimental, offline research prototype. Not a production payment client.**

This repository tests whether a client can retain gross deposit allowances and cumulative-voucher limits while isolating an uncertain payment channel and continuing new work through a fresh identity. It is supporting feasibility evidence for a possible CoW quote client, not the finished grant deliverable.

The implementation and test files were produced with AI assistance. The recorded runs are from **15 October 2026**. This public-sharing package was prepared on **19 October 2026** without changing or rerunning that implementation. A clean dependency installation was not performed during this packaging step.

## What is here

- `adapter.mjs`: experimental durable allowance and channel-quarantine implementation.
- `test/recovery.test.mjs`: recovery extension; historical result **28 tests/subtests passed**, across 15 top-level scenarios.
- `test/baseline-compat.test.mjs`: separately adapted regression suite; historical result **45 tests/subtests passed**, across 32 top-level scenarios.
- `network-guard.mjs`: blocks external networking during the tests.
- `evidence/historical/`: unchanged recorded outputs and provenance manifests.
- `RESULTS.md`: demonstrated behavior, assumptions and limitations.

The 45-test file is a compatibility copy of the earlier baseline, executed against this derivative adapter. It is not the untouched original prototype. The two suites are separate; do not describe them as 73 independent end-to-end payment or recovery scenarios.

## Setup and reproduce

Use **Node.js 24 or later**; the prototype uses built-in `node:sqlite`. The recorded environment used Node.js 24.19.0. All package versions are pinned in `package-lock.json`.

From this repository's root:

```sh
npm ci --ignore-scripts
```

Dependency installation accesses the package registry. The following test commands preload the network guard and use synthetic responses; they do not need a wallet, API key, RPC URL or `.env` file.

Recovery suite:

```sh
npm test
```

Separate baseline-compatibility suite:

```sh
node --import ./network-guard.mjs --test --test-reporter=tap --test-concurrency=1 test/baseline-compat.test.mjs
```

The earlier SDK-proof archive is **not required** to run these two included suites. Dependencies are installed from this repository's lockfile; there is no required local symlink.

## Safety boundary

The tests import actual `@x402/core`, `@x402/evm` and `@x402/fetch` **2.28.0**, plus `viem` **2.48.11**. HTTP responses and chain reads are injected fixtures. Signatures are deliberately invalid all-zero bytes. Child-process interruption tests stop real local Node processes, but no valid payment authorization, paid quote, RPC operation or blockchain settlement was performed.

Quarantine means local refusal to sign again for that identity while retaining its possible liabilities. It does not revoke signatures, reconcile an uncertain payment, withdraw funds or recover money. Fresh-channel continuation can consume additional cash and allowance while old funds remain unresolved.

Do not add a funded wallet or replace the fixtures with a real RPC and call the result production-ready. See `RESULTS.md` for the trusted-host assumptions and outstanding production work.

## Publication and licensing

No production credentials or wallet configuration belong in this repository. `.gitignore` excludes common dependency, credential and journal files.

**A license for the new prototype code has not yet been selected.** Public visibility is not a substitute for an explicit reuse license. See `LICENSING.md` and `THIRD_PARTY_NOTICES.md`. This package is not represented as an official CoW release or as security-audited software.

## Integrity

`SHA256SUMS` covers this public-sharing package. Historical manifests in `evidence/historical/` describe the original archive and are not checksums for this repackaged directory. See the evidence README before interpreting them.
