# Feasibility results and limits

Recorded test date: 15 October 2026. Packaging date: 19 October 2026.

## Demonstrated locally

The recovery suite records 28 passing tests/subtests in 15 top-level scenarios. The separate baseline-compatibility suite records 45 passing tests/subtests in 32 top-level scenarios. Additional recorded reruns agree with those totals. These are automated checks of a research prototype, not an external professional security audit.

The recovery tests exercise interruption at signer, transport and receipt-storage boundaries; persistent gross deposit reservations; retained per-channel voucher high-water marks; explicit channel quarantine; fresh-identity continuation within the original budget; and refusal when insufficient allowance remains.

Negative cases include old-identity reuse, missing or modified journal state, occupied locks, unsupported replacement identities, uncertain replacement channels, period allocation, malformed/unknown channel-read fixtures, delayed SDK success/refund callbacks and attempted quarantine during an in-flight transport.

A central fixture authorizes a 1-USDC deposit, interrupts the request, preserves that possible liability, quarantines the channel and authorizes a new 1-USDC deposit under a 2.5-USDC plan cap. With a 1.5-USDC cap, the second deposit is refused before signing. The old deposit does not become free allowance.

The 0.001-USDC quote and 1-USDC deposit values are test fixtures, not guarantees about current service terms. The prototype checks an upper quote cap; production fixed-price operation still needs explicit supported-price and route pinning.

## What these tests do not demonstrate

- No live CoW service acceptance, real authorization, funded wallet, paid quote or settlement.
- No production RPC/finality validation, deployed-contract execution or chain-reorganization testing.
- No same-channel reconciliation, on-chain revocation, money recovery or exactly-once service delivery.
- No hostile-host, complete-journal rollback, multi-host or raw-signer-bypass protection.
- No general dynamic-price support, historical-channel migration or complete operator-facing client.

All signatures are invalid dummy bytes; all HTTP responses and chain reads are fixtures. The SDK packages themselves are real pinned published packages. The network guard blocks external test networking.

The design assumes an intact trusted local journal, trusted operator, exclusive signing path and single host. Journal consistency checks do not prevent coherent rollback or malicious replacement of the whole history. Local quarantine remains effective only while that trusted history and signing path are respected.

Existing authorizations may remain usable after a channel is quarantined. A fresh channel does not settle or cancel the old one. Cash refunds do not automatically restore gross allowance. A strict voucher high-water policy can deliberately refuse incompatible reduced-charge or changing-price states.

## Remaining implementation work

Usable package exports and signer integration, fresh initial identity provisioning, operator inspection/quarantine flows, production lock and backup procedures, trusted read-only chain checks, fixed-price/route policy and separately authorized live acceptance remain outside this proof. No grant approval, adoption commitment or production-readiness claim follows from these tests.

## Source context

- [Pinned x402 batch-settlement specification](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md)
- [CoW integration and recovery documentation work](https://github.com/cowprotocol/docs/pull/666)
- [Public batch-budget integration request](https://github.com/DeepFirstHQ/deepfirstsearch/issues/34)

The proof does not claim generic budget controls or batch payers are novel. CoW's documentation and existing clients, including Tenjin, overlap parts of the broader problem. This repository examines the narrower retained gross-authorization and channel-quarantine behavior.
