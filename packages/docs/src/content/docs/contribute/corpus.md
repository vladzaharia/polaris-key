---
title: "The conformance corpus"
description: "One generator, the language runners, the generator-owned Swift and Godot mirrors, how to add a case without hand-editing generated output, and the HTTP transcripts recorded beside it."
sidebar:
  order: 5
  label: "Corpus"
---

`conformance/corpus/v2/` is **one signer's** golden output — encoded documents plus their
expected verify outcomes — that every independent implementation checks itself against
byte-for-byte. It is how every language agrees on the wire without one interpretation of the
same prose per language.

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
  `GateMatrixTests.swift`, `FingerprintConformanceTests.swift`, `StageMatrixTests.swift`,
  and more.
- **Godot** — `sdks/godot/tests/`: `suite_conformance.gd` covers the JWS cases today (P1-02 adds
  the rest), run by `sdks/godot/tools/run_tests.sh` on an editor and an exported release
  template.
- **The Worker** — two slices. `packages/worker/test/fingerprintCorpus.test.ts` covers the
  fingerprint/device-id vectors: the Worker recomputes a submitted device's `hwid` server-side
  rather than trusting the client's copy, so it has to agree with what every SDK computes
  client-side. `packages/worker/test/gateMatrixCorpus.test.ts` replays every `gate-matrix.json`
  row through the server's own `checkBuildGate`, which makes the server the oracle for the
  build-gate ports the Node, Python and Swift runners carry. It is not a runner for the signed
  cases: it is a signer for license, config, and trust documents in production, not an
  independent verifier of pre-signed ones.

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

## The Godot resource mirror

An exported Godot pack can read only `res://`, its own project directory, so the generator also
writes all three files into `sdks/godot/tests/corpus/v2/`. The editor run and the
release-template run both read that mirror, and the drift check guards it like the Swift one.
Every target is one entry in `CORPUS_TARGETS` in `sign-corpus.ts`, so a new corpus file reaches
every mirror by construction. A JSON file in a mirror that the generator does not write fails
the check as a stray; it is never deleted automatically.

A GDScript `String` cannot hold U+0000, so `jwsCases` documents carry one generated annotation
for that platform, `expect.docNulReplaced` (WIRE-CONTRACT-V3 §10). Other runners ignore it.

## Never hand-edit the generated files

`cases.json`, `gate-matrix.json`, `fingerprint.json`, `stage-matrix.json`, and both mirrors are all output.
`pnpm gen:corpus -- --check` regenerates every one of them **in memory** and fails if any
committed file differs — mirrors included. A red drift job means a wire-affecting change wasn't
reflected in the corpus; regenerate and commit the result in the same PR:

```sh
pnpm gen:corpus            # write the corpus (and the Swift and Godot mirrors)
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
2. Run `pnpm gen:corpus` to sign it and update every output file, source and mirrors alike.
3. Run `pnpm gen:corpus -- --check` before committing, to confirm nothing else drifted.

The gate matrix is different: it is hand-authored, and its carried rows — the fifteen inlined
from corpus v1 when v1 was deleted — are **frozen**. Nothing may be edited there to make a gate
change pass. A genuinely new decision is a new row appended in `buildGateMatrixV2`, so the diff
shows exactly what changed rather than rewriting history that was already pinned. A carried row
can be retired only by an approved plan, through `RETIRED_CARRIED_ROWS`, which names the plan,
the reason and a successor row; the frozen array itself is never edited, and the generator
refuses to run if a retired name is not a carried row or its successor is not emitted. P0-04
retired one (the pre-R3-01 dev-build bypass).

The stage matrix is hand-authored too, and **append-only** in the same way. `buildStageMatrixV1`
writes literal rows (each an ordered list of host events with the exact emits each produces),
an `accepts` table and one probe per event type, and self-checks them before writing: the stage
lists, the vocabulary, the `accepts` table and every cell of the sync and gate tables. Every
runner replays every row and sends every probe at every state the rows reach. Rows that use
only the current vocabulary keep `stageMatrixVersion`; a change to the vocabulary, to `accepts`
or to an existing row's expectation bumps it, and the package that does so updates every port
in the same change.

## HTTP transcripts

Registration, activation and sync are conversations, not pure functions, so the corpus cannot
pin them. `conformance/transcripts/*.json` does instead: each file is one conversation — the
requests a client must send and the Worker's real answers — recorded through the production
router by the Worker's own scenario tests and replayed by every SDK against a fake server that
serves the recorded responses and asserts each request.

| Piece                  | Where                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Format (documented)    | `packages/worker/test/transcripts/format.ts`                                            |
| Recorder and scenarios | `packages/worker/test/transcripts/` (`recorder.ts`, `determinism.ts`, `scenarios/`)     |
| Drift check            | `packages/worker/test/transcripts.test.ts`, wrapped by `pnpm gen:transcripts`           |
| Swift mirror           | `sdks/swift/Tests/PolarisKeyTests/Resources/transcripts/` (generator-owned, like `v2/`) |
| Node replayer          | `conformance/runners/node/transcripts.test.ts` over `transcriptReplay.ts`               |
| React replayer         | `packages/sdk-react/test/transcripts.test.ts` (the same engine; discovery only)         |
| Python replayer        | `sdks/python/tests/test_transcripts.py` over `transcript_replay.py`                     |
| Swift replayer         | `sdks/swift/Tests/PolarisKeyTests/TranscriptTests.swift` over `TranscriptReplay.swift`  |

**Recording.** A scenario seeds a product, builds each request exactly as a wire-contract client
would, sends it through `dispatchWith` (the router with the request clock injected), asserts
the server's behaviour as an ordinary test, and declares what a replaying SDK is held to. Values
from the client's own state are recorded as placeholders (`{deviceId}`, `{version}`,
`{token}`, `{key}`); values the server chose, such as an ETag, are recorded literally. The
seven `X-PKey-*` headers are asserted by presence only. Recording is deterministic: `Date` is
frozen, `crypto.getRandomValues` and `crypto.randomUUID` draw from a stream seeded by the
scenario id, and the Worker signs with the corpus test key, so every recorded document verifies
against the corpus pins. Each scenario is recorded twice per run and the two must match.

**Replaying.** An SDK replays a transcript when its `parity.json` marks every id in the
transcript's `features` `implemented` and none in its `requires` `na`, so a transcript for a
feature an SDK has not built yet is skipped rather than failing, and runs the moment the
manifest claims the feature. A replayer fails on an unexpected request, on an expected request
the SDK never sent, on a header or body that does not match, and on a client outcome that
differs from the step's `expect`. Each replayer also runs doctored transcripts to prove those
failures fire. `pnpm parity:check` holds the other end: where a transcript applies to an SDK,
each feature it proves needs a test tagged `@pkey-feature <id>` that replays
`conformance/transcripts`.

```sh
pnpm gen:transcripts            # re-record every scenario, write the files and the Swift mirror
pnpm gen:transcripts -- --check # the drift guard — exit 1 if anything is stale
```

Never hand-edit a transcript: change the scenario and re-record. A Worker change that alters a
recorded response regenerates the transcripts in the same change; if an SDK replayer then
fails, that SDK has to follow. To add a conversation, add a scenario under
`packages/worker/test/transcripts/scenarios/`, list it in `scenarios/index.ts`, run
`pnpm gen:transcripts`, and map any new action in each SDK's replayer.
