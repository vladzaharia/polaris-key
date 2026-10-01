---
title: "The conformance corpus"
description: "One generator, four runners, the Swift resource mirror, and how to add a case without hand-editing generated output."
sidebar:
  order: 5
  label: "Corpus"
---

`conformance/corpus/v2/` is **one signer's** golden output — encoded documents plus their
expected verify outcomes — that every independent implementation checks itself against
byte-for-byte. It is how five languages agree on the wire without five interpretations of the
same prose.

One generator, `tools/sign-corpus.ts` (run via `pnpm gen:corpus`), signs every vector from a
fixed keypair and a fixed case list. The runner set is taxonomized in full on
[the wire-contract corpus page](/docs/build/wire/corpus/) (which also counts React's
gate-matrix-only runner); the ones a contributor touches most:

- **Node** — `conformance/runners/node`: `corpusV2.test.ts` covers the JWS, document, trust,
  and bundle cases plus the gate matrix; `fingerprint.test.ts` covers the fingerprint vectors;
  `stageMatrix.test.ts` covers the boot stage machine.
- **Python** — `sdks/python/tests/`: `test_conformance.py`, `test_gate_matrix.py`,
  `test_fingerprint_conformance.py`, `test_stage_matrix.py`, and more, one file per corpus
  concern.
- **Swift** — `sdks/swift/Tests/PolarisKeyTests/`: `ConformanceTests.swift`,
  `GateMatrixTests.swift`, `FingerprintConformanceTests.swift`, `StageMatrixTests.swift`, and
  more.
- **The Worker** — `packages/worker/test/fingerprintCorpus.test.ts`, the fingerprint/device-id
  slice only. The Worker recomputes a submitted device's `hwid` server-side rather than trusting
  the client's copy, so it has to agree with what every SDK computes client-side — that is the
  one corpus file it is a runner for, not the full set: it is a signer for license, config, and
  trust documents in production, not an independent verifier of pre-signed ones.

Node, Python, and Swift each assert byte-identical verify outcomes against the whole corpus;
the Worker's slice is narrower but no less load-bearing, since a drifted `hwid` formula would
silently stop matching a returning machine to its existing free-tier enrollment.

## What's in the corpus

Four files, one directory, so a runner can point at `corpus/v2/` and find everything it needs:

| File                | Contents                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `cases.json`        | JWS cases, license/config documents, trust manifests, clock-floor sequences, offline bundles.    |
| `gate-matrix.json`  | The client gate's decision table — every input combination and the state it must produce.        |
| `fingerprint.json`  | Hardware-fingerprint and device-id derivation vectors.                                           |
| `stage-matrix.json` | The boot stage machine (client boot behaviour, outside the wire contract): rows and guard cases. |

There is exactly one corpus: v1 was deleted when wire contract v2 shipped, so there is no
dual-shape ambiguity for a runner to pick the wrong side of. Version constants travel with the
files themselves — `corpusVersion` **2**, `gateMatrixVersion` **2**, `fingerprintVersion` **1**,
`stageMatrixVersion` **1** — and case counts, generated straight from the corpus files, live at
[Conformance corpus v2](/docs/reference/corpus/).

## The Swift resource mirror

The Swift test target can't reach up the monorepo at test time, so `sign-corpus.ts` also copies
every file into `sdks/swift/Tests/PolarisKeyTests/Resources/v2/` — a generator-owned mirror
rather than a hand-kept translation. `main()` reconciles each file into every directory of
`CORPUS_TARGETS`, so a new file or a new mirror needs no other change. The mirror is guarded by the same drift check as
the source, file for file.

## Never hand-edit the generated files

`cases.json`, `gate-matrix.json`, `fingerprint.json`, `stage-matrix.json`, and the Swift mirror
are all output.
`pnpm gen:corpus -- --check` regenerates every one of them **in memory** and fails if any
committed file differs — mirror included. A red drift job means a wire-affecting change wasn't
reflected in the corpus; regenerate and commit the result in the same PR:

```sh
pnpm gen:corpus            # write the corpus (and every mirror)
pnpm gen:corpus -- --check # the drift guard — exit 1 if anything is stale
```

Never weaken a runner to make a change "pass." If a runner disagrees with the corpus, either the
runner has a bug or the corpus is missing a case for the behavior you actually intended — not a
reason to loosen an assertion.

## Adding a case

Each case family in `tools/sign-corpus.ts` is an array returned by its own `async function` —
`buildJwsCases`, `buildLicenseDocCases`, `buildConfigDocCases`, `buildTrustCasesV2`,
`buildClockFloorCasesV2`, `buildBundleCases` — assembled by `buildV2()` into the object
`gen:corpus` writes as `cases.json`. To add a case:

1. Add a case object to the relevant array, with a unique `id` and a `description` explaining
   what it proves and why (the existing cases are the style guide — read a few nearby first).
2. Run `pnpm gen:corpus` to sign it and update every output file, source and Swift mirror alike.
3. Run `pnpm gen:corpus -- --check` before committing, to confirm nothing else drifted.

The gate matrix is different: it is hand-authored, and its carried rows — the fifteen inlined
from corpus v1 when v1 was deleted — are **frozen**. Nothing may be edited there to make a gate
change pass. A genuinely new decision is a new row appended in `buildGateMatrixV2`, so the diff
shows exactly what changed rather than rewriting history that was already pinned.

The stage matrix is hand-authored too, and **append-only** in the same way. `buildStageMatrixV1`
writes literal rows (each an ordered list of host events with the exact emits each produces),
an `accepts` table and one probe per event type, and self-checks them before writing: the stage
lists, the vocabulary, the `accepts` table and every cell of the sync and gate tables. Every
runner replays every row and sends every probe at every state the rows reach. Rows that use
only the current vocabulary keep `stageMatrixVersion`; a change to the vocabulary, to `accepts`
or to an existing row's expectation bumps it, and the package that does so updates every port
in the same change.
