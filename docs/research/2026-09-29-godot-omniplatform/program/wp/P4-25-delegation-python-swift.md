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

- [x] Every `delegationCases` and `dataOnlyCases` row passes in pytest and `swift test`.
- [x] Non-normalised paths and extension-disguised resources are refused (P4-08 review lesson).
- [x] The full green gate passes.

## Corrections from implementation

- **File names.** Python's record module is `core/release_record.py` and its data-only module is
  `update/packs/dataonly.py`. Swift's `DataOnly.swift` lives in **PolarisKeyPacks**, not
  PolarisKeyCore: it needs the files index's path rules (`pathSafe`, now module-internal), and
  client-core keeps `dataonly.ts` under `packs/` too.
- **Swift's `RESERVED_RECORD_KINDS`** was already removed by P4-23; nothing was left to correct.
- **Swift result shape.** `VerifyReleaseRecordResult` gains `.delegated(ReleaseRecordDoc,
RecordDelegation)`, returned only when `delegation` is passed, instead of a `delegation` member
  on `.ok`; `record` covers both and `delegation` reads the new case. `ReleaseRecordStep` gains
  `.delegation` and `.scope`; `FeedRevocation` gains `kind`; `PackInstall` and `PackJournal` gain
  `delegation`; `DelegatedRelease` lives in PolarisKeyCore so `UpdateCheckContent.delegated` can
  name it. The README lists these source changes.
- **Strict UTF-8.** Python decodes with the strict `utf-8` codec. Swift validates the bytes
  itself (WHATWG ranges: no overlong form, surrogate or value above U+10FFFF) and runs the marker,
  NUL and escape checks over the bytes, because `String(validating:)` needs macOS 15 and iOS 18.
  Over valid UTF-8 a byte search gives the same verdict as client-core's string search.
- **Holds.** client-core's engine refuses the delegated path for a hold only when the host's
  stamp object carries `holds`, which the Node packs client never sets. Swift gains
  `PackEngineOptions.holds` and Python reads `stamp["holds"]`, and both packs clients now pass
  the stamp's holds (`stampHolds`). This is stricter than Node in practice, and it matches the
  plan's §2.4 table.
- **Pinned `pkd1-` kids.** Both SDKs refuse such a kid in `pinned_release_keys` /
  `pinnedReleaseKeys` with `invalid-options`, as sdk-node does (§2.2).
- **The noop re-sniff** reads the reused install's files from the seeds the preflight opened,
  as client-core does. The chunk-index engine test runs on the default strategies, because
  neither SDK implements the `chunk` strategy yet.
