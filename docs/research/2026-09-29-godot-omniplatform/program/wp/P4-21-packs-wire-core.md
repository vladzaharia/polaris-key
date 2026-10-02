# P4-21 Packs wire core: contract amendment, pack record and marker claims and cases, files-index functions, `@polaris-key/zstd-wasm`

| Field       | Value                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs                                                                                                                                                  |
| Size        | 1.25–1.75 engineer-weeks                                                                                                                                   |
| Depends on  | [P4-01](P4-01-packs-plan.md), [P3-02](P3-02-wire-v4-contract-corpus.md)                                                                                    |
| Unblocks    | [P4-02](P4-02-pack-deliverables.md), [P4-03](P4-03-ci-patch-artifacts.md), [P4-04](P4-04-content-corpus-v1.md)                                             |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                      |
| Plan mode   | yes: execute the approved `plans/P4-01.md` (its P4-21 parts); the plan's approval is this package's plan-mode gate, as for P3-12                           |
| Gates       | plan mode; corpus (the corpus lane, one corpus package at a time); drift gates; Action rebundle; threat model; generated docs; constants (`gen:constants`) |
| Human input | none                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                  |

## Goal

Land the part of the packs wire that P4-02 and P4-03 import, so neither waits for the content
corpus: the contract amendment, the pack types and constants, `releaseRecordClaims` for
`kind: pack` and `kind: app` records, the files-index functions, the pack record and marker corpus
cases, and the decoder-only zstd WASM package.

## Why

`plans/P4-01.md` decision 38 split this out of [P4-04](P4-04-content-corpus-v1.md) so the
program's critical path grows by 1.75 weeks instead of 3.5 (§8.3). P4-02's ingest runs
`releaseRecordClaims` and the zstd-wasm decoder, and the Worker imports the corpus-pinned claims
rather than keeping its own copy (decision 33), so these pieces must land first.

## Read first

- `AGENTS.md` rules 3, 9 and 10 and the green gate.
- **`docs/research/2026-09-29-godot-omniplatform/program/plans/P4-01.md`**: §2.1 (the
  amendment table, except P4-04's rows), §2.3, §2.4, §2.8, §2.9's codes owned by P4-21, §2.13's
  P4-21 rows, §4.2 (the fixed object-ref table), §4.6 whole, §4.8, §5 row 0, §8.1 decisions 33,
  36, 37 and 38, and §8.4's P4-21 bullet. Where it and this brief differ, the plan wins.
- `docs/security/WIRE-CONTRACT-V4.md`, `packages/client-core/src/record.ts`,
  `tools/sign-corpus.ts`, `tools/gen-sdk-constants.ts`, `conformance/parity/errors.json` and
  `enums.json`.

## Scope

**In:**

- The contract amendment of §2.1, except the rows P4-04 owns.
- §2.13's P4-21 rows: the pack types and constants (`shared-protocol` `/packs` subpath and
  `core.ts`), `RECORD_KINDS`, `releaseRecordClaims` with `isPackId` and `objectRef`,
  `parseFilesIndex`, `checkPaths`, `treeDigest`, `variantKey`, `contentClaims`,
  `parseContentStamp` (`client-core` `/packs` subpath), and `@polaris-key/zstd-wasm` with its
  hand-assembled window test.
- §4.6 whole: `packRecordCases`, `markerCases` and the two rewritten P3-02 cases, signed over
  §4.2's fixed object-ref table, with the 80-check registry, both self-checks and the Node
  runner's claims and pointer-set sections. Regenerate with `pnpm gen:corpus`; never hand-edit
  generated files.
- `packs.record` in `features.json`.
- The "Packs on the wire" threat-model section, except its decode sentences.
- The `errors.json` codes its functions return and the `enums.json` entries its types use
  (`filesLayout`, `contentCodec`, `packType`, …), via `gen:constants` (§4.8).
- The docs gen and the Action rebundle (`bundle:action -- --check`).

**Out:** the content set, `content/cases.json`, `plan-matrix.json`, `content/blobs/refs.json`,
`packSetId`, `windowLogMax`, `frameWindow`, `frameWindowCases`, stage matrix version 3, the
Python, Swift and Godot pointer-set sections, the contract's §2.6 [C], §9 and §11 rows, and the
threat-model decode sentences (all [P4-04](P4-04-content-corpus-v1.md)); the descriptor, the
validator and ingest (P4-02); the CLI (P4-03).

## Steps

1. Branch `wp/P4-21-packs-wire-core` from `main`.
2. Implement the scope in the plan's order; run the green gate, stopping at the first failure.
3. Report to the lead; the lead reviews, merges and sets the status.

## Acceptance

- [x] Every case in §4.6 passes in the Node runner; both self-checks pass in `gen:corpus`.
- [x] `gen:corpus -- --check`, `gen:constants -- --check`, `parity:check`, docs `gen:check` and
      `bundle:action -- --check` are current.
- [x] `@polaris-key/zstd-wasm` decodes the hand-assembled window test and refuses a window above
      the limit before decoding.
- [x] The full green gate passes.
