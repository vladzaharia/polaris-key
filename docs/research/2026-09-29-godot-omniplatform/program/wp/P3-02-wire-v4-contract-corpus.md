# P3-02 Implement the wire v4 contract and corpus (feed, release, malleability, update and outlet matrices)

| Field       | Value                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P3: Signed feed, decision, feeds (wire v4)                                                                                                                                                                         |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                               |
| Depends on  | [P3-01](P3-01-wire-v4-plan.md)                                                                                                                                                                                     |
| Unblocks    | [P3-03](P3-03-feed-composition.md), [P3-04](P3-04-v4-node.md), [P3-05](P3-05-v4-react.md), [P3-06](P3-06-v4-python.md), [P3-07](P3-07-v4-swift.md), [P3-08](P3-08-v4-godot.md), [P3-11](P3-11-outlet-detection.md) |
| Role        | `pkey-implementer` (see `.claude/agents/`)                                                                                                                                                                         |
| Plan mode   | yes: execute the approved `plans/P3-01.md`; do not start until a human has merged it                                                                                                                               |
| Gates       | `PROTOCOL_VERSION` 3 → 4; corpus drift gate (`pnpm gen:corpus -- --check`, with the Swift and Godot mirrors); all SDKs (the new `jwsCases` run in every existing runner); generated docs (`reference/corpus.mdx`)  |
| Human input | none beyond the approved plan                                                                                                                                                                                      |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                          |

## Goal

The v4 contract is in the repository and the corpus pins it. `WIRE-CONTRACT-V4.md` is normative;
`shared-protocol` carries the new document and decision types; `JwsTyp` accepts `pkey-feed+jws`
and `pkey-release+jws`; `PROTOCOL_VERSION` is 4 in every language; `tools/sign-corpus.ts` emits
`feedCases`, `releaseRecordCases`, the malleability and JSON edge `jwsCases`, `update-matrix.json`
and `outlet-matrix.json` into `conformance/corpus/v2/` and every mirror. Every existing runner
passes the new `jwsCases`, and the drift gate is green. No SDK verifies a feed yet; that is the
wave that follows.

## Why

Wire v4 is an all-languages event and the order is fixed: contract → catalog → corpus → SDKs
(`AGENTS.md` rule 2; `packages/docs/src/content/docs/contribute/waves.md`). The SDK wave
([P3-04](P3-04-v4-node.md) to [P3-08](P3-08-v4-godot.md), [P3-11](P3-11-outlet-detection.md))
needs one set of files to prove against. The corpus also lacks Ed25519 malleability and JSON edge
vectors today, so backends can diverge silently
([README §9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #19,
[notes/A2 §7.1](../../notes/A2-sdk-port.md),
[notes/A5 §3](../../notes/A5-godot-empirical.md#3-pure-gdscript-ed25519-verify)).

## Read first

- `AGENTS.md` rules 1–3 and the green gate; `CLAUDE.md` (plan mode).
- **`docs/research/2026-09-29-godot-omniplatform/program/plans/P3-01.md`**. Where it and this
  brief differ, the plan wins.
- `docs/security/WIRE-CONTRACT-V3.md`, all of it: V4 restates what does not change.
- `packages/docs/src/content/docs/contribute/corpus.md` (how to add a case) and `waves.md`.
- `tools/sign-corpus.ts`: `KEYS` (`:58-71`), the v3 fixed clocks (`:145-165`), `buildJwsCases`
  (`:293`), `buildV2` (`:1619-1630`), the hand-authored gate matrix with its frozen carried rows
  (`:1646`, `:2034`), `reconcile` and `main` with the Swift mirror (`:2313-2379`).
- The runners that read `jwsCases` today: `conformance/runners/node/corpusV2.test.ts:177`,
  `sdks/python/tests/test_conformance.py:48-110`, `sdks/swift/Tests/PolarisKeyTests/ConformanceTests.swift:186-230`,
  and the Godot runner P1-01 created, if `sdks/godot` exists.
- The verifiers they drive: `packages/shared-jws/src/index.ts:308-379`,
  `sdks/python/src/polaris_key/core/jws.py`, `sdks/swift/Sources/PolarisKeyCore/JWSVerifier.swift`.
- `prototype/vectors/` (the Node-oracle Ed25519 negatives: S+L, S=L, non-canonical y, off-curve y).
- [README §3.3](../../README.md#33-trust-model-two-signers-two-documents),
  [§3.6](../../README.md#36-update-what-an-installed-app-should-do-next),
  [PARITY §4.1](../../PARITY.md#41-corpora-behaviour-as-data).

## Scope

**In:**

- **Contract.** `docs/security/WIRE-CONTRACT-V4.md` as the plan specifies, with V3 marked
  superseded. Update `AGENTS.md` rule 2 ("currently **3**", the signed document set), the wire
  section of `README.md`, `packages/docs/src/content/docs/build/wire/index.md` and
  `contribute/corpus.md` ("three files"), and add the glossary terms (release record, channel
  feed, release key) to `start/concepts.md` if P2 has not.
- **Types.** In `packages/shared-protocol`: `PROTOCOL_VERSION = 4` (`src/core.ts:9`); the feed
  document type in `src/update.ts` and the release-record type in `src/release.ts` (proposed
  `ChannelFeedDoc`, `ReleaseRecordDoc`, matching `TrustManifestDoc`); the decision and outlet
  types where the plan puts them; barrel exports; `test/exports.test.ts`.
- **`typ`.** `JwsTyp` in `packages/shared-jws/src/index.ts:31-35` gains both values; tests for
  typ separation between every pair. The encoding and caps do not change unless the plan says so.
- **Version constant everywhere.** `sdks/python/src/polaris_key/core/models.py:69`,
  `sdks/swift/Sources/PolarisKeyCore/Models.swift:262`, the Godot constant if present, and every
  test or fixture pinned to 3: `sdks/python/tests/helpers.py:288`,
  `sdks/python/tests/test_capabilities.py:139`, `sdks/swift/Tests/PolarisKeyTests/DiscoveryTests.swift:34,70`,
  `WireContractV3Tests.swift:437`, `packages/sdk-react/test/fixtures.ts:140`, and the
  `protocolVersion` prose in `packages/worker/openapi/polaris-key.v3.yaml:88-89`. Discovery picks
  up the constant itself (`packages/worker/src/core/discovery.ts:87`).
- **Malleability and JSON edge vectors** appended to `buildJwsCases`, with the plan's ids and
  verdicts, and the fixes each existing verifier needs to agree: explicit pre-checks (for example
  `S < L`, canonical point encodings, a strict JSON pre-scan), never a loosened expectation.
- **New corpus material** from new builders (proposed `buildFeedCases`,
  `buildReleaseRecordCases`, `buildUpdateMatrix`, `buildOutletMatrix`): the release test keys
  added to `KEYS`; `feedCases` and `releaseRecordCases` in `cases.json`; `update-matrix.json` and
  `outlet-matrix.json` beside it, each with its version constant; the same files in
  `sdks/swift/Tests/PolarisKeyTests/Resources/v2/` (`.copy("Resources/v2")` in `Package.swift`
  bundles new files automatically) and in the Godot mirror if it exists.
- **Generator self-checks** that throw on inconsistency: every feed-pinned hash equals the
  SHA-256 of the record vector it names (except in the cases built to mismatch), every negative
  case differs from its valid twin in the one property it tests, and ids are unique.
- **Docs generator.** `corpusInventory()` in `packages/docs/scripts/gen-reference.mjs:366` lists
  the new files and their version constants; regenerate `reference/corpus.mdx`.
- **Parity registry** (once P1b-01 has landed): entries `release.record` (`releaseRecordCases`),
  `update.feed` (`feedCases`), `update.decide` (`update-matrix.json`) and `outlet.detect`
  (`outlet-matrix.json`) point at the new proofs, `planned` in every SDK manifest.

**Out** (and where it belongs instead):

- Verifying feeds and records, the decision and the cache slices in `client-core` and React
  (→ [P3-05](P3-05-v4-react.md)); Node (→ [P3-04](P3-04-v4-node.md)); Python
  (→ [P3-06](P3-06-v4-python.md)); Swift (→ [P3-07](P3-07-v4-swift.md)); Godot
  (→ [P3-08](P3-08-v4-godot.md)); runner sections for the new families (same packages).
- Outlet detection in the SDKs (→ [P3-11](P3-11-outlet-detection.md)).
- Record ingest, feed routes and signing in the Worker (→ [P3-03](P3-03-feed-composition.md)).
- Pack records, pack sets, content rows and revocations (→ [P4-01](P4-01-packs-plan.md),
  [P4-13](P4-13-revocation-floors-decision.md)); content-key delegation
  (→ [P4-19](P4-19-content-key-delegation.md)).

## Design notes

- **Which plan.** The plan-mode gate is satisfied by `plans/P3-01.md`. There is no
  `plans/P3-02.md` unless the P3-01 plan split the work, so do not stop looking for one.
- **The new `jwsCases` run everywhere at once.** Every runner iterates `jwsCases`, so a vector a
  backend gets wrong breaks that SDK's CI in this PR. That is why this package carries the
  all-SDKs gate. Fix the verifier with an explicit check; `AGENTS.md` rule 1 and `corpus.md` forbid
  weakening a runner or hand-editing output. If a vector turns out to need a different verdict,
  amend the plan and get it re-approved.
- **A new `typ` in `jwsCases` breaks Swift.** `testAllJwsCases` fails on a `typ` its `JwsTyp`
  enum does not know (`sdks/swift/Tests/PolarisKeyTests/ConformanceTests.swift:202-204`). If any
  new `jwsCases` vector uses `pkey-feed+jws` or `pkey-release+jws` (typ-separation cases would),
  add both values to Swift's `JwsTyp` and Python's `TYP_*` constants here; P3-06 and P3-07 then
  build on them.
- **The new families are dormant until the wave.** The runners read named sections
  (`test_conformance.py:48`, `ConformanceTests.swift:30`), so `feedCases`, `releaseRecordCases`
  and the two new files break nothing here. [P3-05](P3-05-v4-react.md) is the first full proof of
  them; run it next, so a corpus mistake surfaces once rather than in five SDKs.
- **Keep `corpusVersion: 2`** unless the plan says otherwise: the Node (`:179`), Python (`:61`) and
  Swift (`:185`) runners assert it.
- **Deterministic output.** Ed25519 is deterministic and the clocks are fixed constants. Add v4
  clocks beside `V3_ISSUED` rather than reading the system clock. `--check` must be stable.
- **Hand-authored matrices are append-only**, like `CARRIED_MATRIX_ROWS`: a later change is a new
  row, so a diff shows exactly what changed.
- **Key separation cases.** Include a feed signed by a release key and a record signed by the
  product key; both must fail. The release keys are a separate input, never part of `trust`.
- **Minimum case coverage** (the plan's ids win): feed valid, wrong `typ`, expired on the network
  path, future-dated, `seq` rollback, wrong `aud`, wrong channel, unknown `kid`, reload-path use
  of an expired feed for the `seq` floor; record valid, hash mismatch, unpinned `kid`, rotation
  (second key), `seq` or version not matching the feed, wrong `aud`, duplicate key, a reserved
  `kind` refused at use.
- **Size budget.** Keep `cases.json` growth modest; there is no need for large cap vectors beyond
  one feed at the plan's cap.

## Steps

1. Confirm `plans/P3-01.md` is merged and `check.mjs --show P3-02` shows P3-01 `done`. Branch
   `wp/P3-02-wire-v4`; set `in-progress`.
2. Contract: write V4, mark V3 superseded, update AGENTS.md rule 2, README, the wire docs and the
   glossary.
3. Types and `typ`; bump `PROTOCOL_VERSION` in every language and every pinned test.
4. Add the malleability and JSON edge vectors; run every runner; fix each disagreeing verifier;
   one commit per SDK.
5. Add the test keys and the feed and record builders, with self-checks.
6. Add `update-matrix.json` and `outlet-matrix.json` builders exactly as the plan's row lists.
7. Mirrors, the docs generator, the parity registry entries.
8. Run the green gate. Set `in-review`, run prettier on the program files, push.

## Acceptance criteria

- [ ] `PROTOCOL_VERSION` is 4 in TypeScript, Python, Swift (and GDScript if present), discovery
      serves `protocolVersion: 4`, and no test or fixture outside historical docs still pins 3.
- [ ] `JwsTyp` includes `pkey-feed+jws` and `pkey-release+jws`; `shared-jws` tests prove each
      `typ` is rejected where another is expected.
- [ ] `docs/security/WIRE-CONTRACT-V4.md` exists and is referenced from AGENTS.md rule 2; V3 says
      it is superseded.
- [ ] `cases.json` contains `feedCases`, `releaseRecordCases` and the plan's new `jwsCases` ids;
      `update-matrix.json` and `outlet-matrix.json` exist with their version constants; the Swift
      mirror (and the Godot mirror, if present) contains all of them.
- [ ] `pnpm gen:corpus -- --check` passes, and changing any one committed byte makes it fail.
- [ ] The Node runner, `pytest`, `swift test` and the Godot runner (editor and release template, if
      `sdks/godot` exists) all pass, including every new `jwsCases` vector.
- [ ] `reference/corpus.mdx` lists the new families and files; `docs gen:check` passes.
- [ ] The green gate passes (`AGENTS.md`), including the corpus and generated-docs drift gates.
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm build
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
mise exec node@22 -- pnpm format
```

Run the Godot runner with the command [P1-01](P1-01-godot-scaffold.md) documented, on the editor
and a release template.

## Hand-off

- File and section names, version constants and test key ids exactly as the plan fixed them. The
  SDK wave loads `feedCases`, `releaseRecordCases` and `update-matrix.json`;
  [P3-11](P3-11-outlet-detection.md) loads `outlet-matrix.json`.
- `ChannelFeedDoc`, `ReleaseRecordDoc` and the decision types in `@polaris-key/protocol`, used by
  [P3-03](P3-03-feed-composition.md) (signer and ingest) and [P3-05](P3-05-v4-react.md)
  (`client-core`).
- Any later corpus fix is plan-mode: amend `plans/P3-01.md` and regenerate, never hand-edit.
- `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P3-02 done` in the PR
  that completes the work.
