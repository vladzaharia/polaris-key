# P4-25 Content-key delegation in Python and Swift

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | P4: Packs                                                                                                          |
| Size        | 0.75–1 engineer-weeks                                                                                              |
| Depends on  | [P4-19](P4-19-content-key-delegation.md), [P4-23](P4-23-content-decision-python-swift.md)                          |
| Unblocks    | none                                                                                                               |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                               |
| Plan mode   | yes: execute the approved `plans/P4-19.md` (its P4-25 parts); the plan's approval is this package's plan-mode gate |
| Gates       | plan mode; corpus (runners only; P4-19 owns the corpus); all SDKs                                                  |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

Port P4-19's content-key delegation to Python and Swift, so every `delegationCases` and
`dataOnlyCases` row passes there exactly as it does in client-core.

## Read first

- **`docs/research/2026-09-29-godot-omniplatform/program/plans/P4-19.md`**: §2.3–§2.7 (the
  delegated-record chain, where the path is allowed, data-only enforcement including the tail
  sniff and the head magics, revocation and rotation, client order and persistence), §4.2–§4.3,
  §5's order-2 row, §8.1 decisions and §8.5's P4-25 bullet. Where it and this brief differ, the
  plan wins.
- client-core's P4-19 implementation on main (the reference), and P4-23's Python and Swift ports.

## Scope

**In:**

- The chain and `recordRevoked`; `dataOnlyRefusal` (normalised paths only, content-sniffed heads
  never extensions, the tail sniff, tree layout only); step 11 relevance; the decision-input
  expansion; the install member; the engine refusals (`pack-not-data-only` before any fetch,
  `pack-revoked` detail `delegation`); reload of a stored delegated install.
- Python: `core/record.py`, `packs/dataonly.py`, its engine. Swift:
  `PolarisKeyCore/ReleaseRecord.swift`, `DataOnly.swift`, its engine. Correct Swift's stale
  `RESERVED_RECORD_KINDS` (`ReleaseRecord.swift:16`).
- Runners for `delegationCases` and `dataOnlyCases`; `packs.delegation` in each `parity.json` moves
  from `planned` to implemented; README.

**Out:** the Worker, CLI, client-core, Node/React and corpus (P4-19); Godot (P4-26).

## Steps

1. Branch from `main` after P4-19 and P4-23 have merged.
2. Implement the scope; run the green gate, stopping at the first failure.
3. Report to the lead; the lead reviews, merges and sets the status.

## Acceptance

- [ ] Every `delegationCases` and `dataOnlyCases` row passes in pytest and `swift test`.
- [ ] Non-normalised paths and extension-disguised resources are refused (P4-08 review lesson).
- [ ] The full green gate passes.
