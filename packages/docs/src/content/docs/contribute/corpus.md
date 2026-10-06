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
  and bundle cases plus the gate matrix, and for wire contract v4 the pointer sets, the
  `update-matrix.json` version cases and the feed and record claim steps; `fingerprint.test.ts` covers the fingerprint vectors;
  `stageMatrix.test.ts` covers the boot stage machine; `headers.test.ts` and
  `configMatrix.test.ts` cover the header values and config resolution. `corpusV2.test.ts` only
  loads the files: its cases live in `suites.ts` (`defineCorpusSuites`), which the browser runner
  shares. CI runs it on Node 22 and again on the `engines.node` floor (the `node-floor` job).
- **Browser** — `conformance/runners/browser` (`@polaris-key/conformance-browser`): Vitest browser
  mode drives the same `suites.ts` in a real engine. CI runs it in Chromium (`browser`), Firefox
  on Linux (`browser-firefox`) and WebKit on macOS (`browser-webkit`). Locally, run
  `pnpm --filter @polaris-key/conformance-browser exec playwright install chromium` once, then
  `pnpm test:browser`. Append `-- --browser=firefox` or `-- --browser=webkit` to pick another
  engine. The root `pnpm test` leaves this package out, because it needs a Playwright browser.
- **React** — `packages/sdk-react/test/`: `headers.test.ts` (the `web` rows and the captured
  request) and `configMatrix.test.ts` (every config case, against its no-environment answer).
- **Python** — `sdks/python/tests/`: `test_conformance.py`, `test_gate_matrix.py`,
  `test_fingerprint_conformance.py`, `test_stage_matrix.py`, `test_headers.py`,
  `test_config_matrix.py`, and more, one file per corpus concern. CI runs them on CPython 3.9
  and 3.14 (Linux) and on the current CPython (macOS).
- **Swift** — `sdks/swift/Tests/PolarisKeyTests/`: `ConformanceTests.swift`,
  `GateMatrixTests.swift`, `FingerprintConformanceTests.swift`, `StageMatrixTests.swift`,
  `HeadersTests.swift`, `ConfigMatrixTests.swift`, and more.
- **Godot** — `sdks/godot/tests/`: `suite_conformance.gd` covers every `cases.json` family, the
  `fingerprint.json` device ids and both `headers.json` sections, and `config/test_matrix.gd`
  runs `config-matrix.json` with the environment layer on and off (the gate and stage matrices
  follow with the licence client and the boot stage machine), run by
  `sdks/godot/tools/run_tests.sh` on an editor and an exported release template.
- **Kotlin** — `sdks/kotlin/conformance/src/test/kotlin/im/plrs/key/conformance/`: `CorpusV2Test.kt`
  (the JWS, document, trust, clock-floor and bundle families and their pointer sets),
  `ReleaseRecordTest.kt` (`releaseRecordCases`), `FeedCasesTest.kt` (`feedCases`),
  `ContentDecisionTest.kt` (`feedContentCases`, `revocationCases`, `update-matrix.json`'s
  `contentRows`), `PackRecordTest.kt` (`packRecordCases`, `markerCases`), `DelegationTest.kt`
  (`delegationCases`, `content/`'s `dataOnlyCases`), `UpdateMatrixTest.kt`, `PlanMatrixTest.kt`,
  `ContentCorpusTest.kt` (every `content/` section, under both zstd paths), `GateMatrixTest.kt`,
  `ConfigMatrixTest.kt`, `HeadersTest.kt`, `FingerprintTest.kt`, `StageMatrixTest.kt` and
  `OutletMatrixTest.kt`, reading `conformance/corpus/v2/` in place (no mirror).
  `( cd sdks/kotlin && ./gradlew :conformance:test )` runs every suite on the JCA Ed25519 backend
  and again with Tink forced (each suite extends `ConformanceSuite`, which installs the backend
  first).
- **The Worker** — three slices. `packages/worker/test/headersCorpus.test.ts` runs every
  `headers.json` row through the normaliser that stores the client metadata headers. `packages/worker/test/fingerprintCorpus.test.ts` covers the
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

Ten files and the content corpus, one directory, so a runner can point at `corpus/v2/` and find everything it needs:

| File                   | Contents                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cases.json`           | JWS cases, license/config documents, trust manifests, clock-floor sequences, offline bundles, and (wire contract v4) channel feeds and release records. A case whose payload holds a number that cannot be a wire integer lists those pointers in `nonWireIntegers`, beside `expect`. |
| `gate-matrix.json`     | The client gate's decision table — every input combination and the state it must produce (`rows`) — and, in `entitlementRows`, what `isEntitled` answers in each licence state.                                                                                                       |
| `fingerprint.json`     | Hardware-fingerprint and device-id derivation vectors, and the §6.1 source rules: `windowsCim` (with `windowsCimCommand`), `linuxAnchor`, `ramBuckets`. Node and Python run all three; Swift runs `ramBuckets`.                                                                       |
| `stage-matrix.json`    | The boot stage machine (client boot behaviour, outside the wire contract): rows, guard cases and (version 2) boot-confirmation cases.                                                                                                                                                 |
| `headers.json`         | WIRE-CONTRACT-V3 §5.2: each runtime spelling of a platform or arch and its canonical header value, or none. The rows are the `PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` tables.                                                                                                          |
| `config-matrix.json`   | WIRE-CONTRACT-V4 §2.2.1: config precedence, the variable name, the strict environment value and the user-visible list, each with a no-environment answer where it differs (`expectNoEnv`).                                                                                            |
| `update-matrix.json`   | WIRE-CONTRACT-V4 §11.1: version comparisons, capability narrowing, the decision's outlet, rollout buckets and every update-decision row with its boot value.                                                                                                                          |
| `outlet-matrix.json`   | WIRE-CONTRACT-V4 §11.2: outlet capability defaults and narrowing, the listing-URL prefixes, the detection signals and every detection row.                                                                                                                                            |
| `plan-matrix.json`     | WIRE-CONTRACT-V4 §11.4: the install planner's rows, variant selection and target mapping (packs v1).                                                                                                                                                                                  |
| `feed-url-matrix.json` | The app-updater feed URLs (`appcast`, `winsparkle`, `velopack`, `appInstaller`, `zsync`) expanded from discovery's `update.endpoints` templates, or `{unsupported: "product"}` when a template is missing (`plans/SP-00.md` D5).                                                      |
| `content/`             | WIRE-CONTRACT-V4 §2.6: `content/cases.json` (path rules, the files index, the chunk index, full, delta, file and chunk apply, `packSetId`, the content stamp, `frameWindow`) over the committed blobs in `content/blobs/`. Source only, not mirrored.                                 |

There is exactly one corpus: v1 was deleted when wire contract v2 shipped, so there is no
dual-shape ambiguity for a runner to pick the wrong side of. Version constants travel with the
files themselves — `corpusVersion` **2**, `gateMatrixVersion` **2**, `fingerprintVersion` **1**,
`stageMatrixVersion` **3**, `headersVersion` **2**, `configMatrixVersion` **1**,
`updateMatrixVersion` **1**, `outletMatrixVersion` **1**, `planMatrixVersion` **2**,
`feedUrlMatrixVersion` **1**, `contentCorpusVersion` **2** — and case counts, generated straight from the corpus files, live at
[Conformance corpus v2](/docs/reference/corpus/).

## The Swift resource mirror

The Swift test target can't reach up the monorepo at test time, so `sign-corpus.ts` also copies
every file into `sdks/swift/Tests/PolarisKeyTests/Resources/v2/` — a generator-owned mirror
rather than a hand-kept translation. `main()` reconciles each file into every directory of
`CORPUS_TARGETS`, so a new file or a new mirror needs no other change. The mirror is guarded by the same drift check as
the source, file for file.

## The Godot resource mirror

An exported Godot pack can read only `res://`, its own project directory, so the generator also
writes every file into `sdks/godot/tests/corpus/v2/`. The editor run and the
release-template run both read that mirror, and the drift check guards it like the Swift one.
Every target is one entry in `CORPUS_TARGETS` in `sign-corpus.ts`, so a new corpus file reaches
every mirror by construction. A JSON file in a mirror that the generator does not write fails
the check as a stray; it is never deleted automatically.

A GDScript `String` cannot hold U+0000, so `jwsCases` documents carry one generated annotation
for that platform, `expect.docNulReplaced` (WIRE-CONTRACT-V4 §10). Other runners ignore it.

## The content corpus's inputs

`content/blobs/` is the exception to "everything is output". Its zstd blobs and `refs.json` are
**inputs** to `tools/gen-content-corpus.ts`, which `sign-corpus.ts`'s `main` calls: zstd output
is not stable across libzstd versions, so a normal or `--check` run never compresses. It reads
the blobs, decodes them with `@polaris-key/zstd-wasm` (the same decoder on every Node), checks
each against the `blobs` table, recomputes every verdict with its own reference appliers and
planner, and writes `content/cases.json` and `plan-matrix.json`. `--check` also fails on a
missing blob, a blob not in the table, a stray file in `content/`, or a `content/` directory in
a mirror.

`content/blobs/refs.json` holds the object refs (`{sha256, bytes, size, codec}`) of the four
frames the signed pack records and the `plan-real-*` rows pin but the corpus does not ship (v2 as
one frame, v1's gaps, and the two trees as one frame each): shipping them would pass the 5 MB
budget for bytes no case decodes. It is in the `blobs` table like any blob.

Content corpus v2 (`plans/P4-10.md` §4) adds the chunk blobs: `chunks/v1.pkc` (stored raw),
`chunks/v2.pkc` and its zstd frame `chunks/v2.pkc.zst` (the object `djdl.levels@1.2.0` pins, so
the two corpora join by hash), the synthetic `chunks/dup.pkc` (t1's first three files with the
first repeated, so duplicate records exist), and `bundles/<sha256>`: v2's new bundles, the one
v1 bundle the repair case refetches from, and the dup bundle. The rebuild's reference chunker is
`fastcdc-2016-nc1` with the file-aware segments and the 64-byte padding rule of `plans/P4-10.md`
§2.4, at a 64 KiB average, with per-chunk `zstd -19` frames stored raw when not smaller. The
corpus bundle target is 256 KiB (production CI uses 4 MiB) so request runs cross bundles and
only one v1 bundle ships; v2's bundles are laid out shared after v1's.

The only writer of either is the explicit rebuild mode, never part of the gate:

```sh
pnpm gen:corpus -- --rebuild-content-blobs   # needs `zstd -V` to report exactly 1.5.7
pnpm gen:corpus                              # then rebuild cases.json, plan-matrix.json and the signed records
```

The rebuild computes every blob in memory and then **adds only**: it throws, writing nothing, when
an existing blob's bytes would change or disappear, or when an existing `refs.json` entry would
change (`plans/P4-10.md` decision 15; `tools/gen-content-corpus.test.ts` proves it on a
temporary copy). A rebuild that reproduces every committed frame adds nothing, so a new blob can
land with the feature that needs it; changing an existing blob still changes the hashes signed
over it and needs a PR of its own with the guard deliberately relaxed. `.prettierignore` and `.gitattributes` (`binary`) cover `content/blobs/` so that
`pnpm format` and `core.autocrlf` never change a hashed byte.

## Never hand-edit the generated files

`cases.json`, `gate-matrix.json`, `fingerprint.json`, `stage-matrix.json`, `headers.json`,
`config-matrix.json`, `update-matrix.json`, `outlet-matrix.json`, `plan-matrix.json`,
`feed-url-matrix.json`, `content/cases.json`, and both mirrors are all output.
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
`buildClockFloorCasesV2`, `buildBundleCases`, `buildFeedCases`, `buildReleaseRecordCases` —
assembled by `buildV2()` into the object
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

`entitlementRows` (SP-00, `plans/SP-00.md` D4) is a second family in the same file, beside
`rows`, so `gateMatrixVersion` stays 2 and a runner that iterates `rows` is unaffected. Each row
is `{name, gate, license, entitlement, expect: {status, isEntitled}}`: the same `gate` and
`license` inputs as `rows`, plus `entitlement: {key, entry}`, the entry the cached licence
document carries at `entitlements[key]` (`null` when it carries none, always `null` without a
document). `isEntitled` is `isUsable(status) && entry.value === true`, so a revoked, expired or
unactivated licence entitles nothing even while its cached document still says `true` (S-19
G11). The documents are today's licence shape (S-19 `legacy` mode). The generator evaluates every
row through `@polaris-key/client-core`'s `licenseState` and `isUsable` and refuses to write one
that disagrees.

`feed-url-matrix.json` is hand-authored the same way. Its templates are not: `endpointSets.everything`
is read from the Worker's byte-checked discovery golden
(`packages/worker/test/fixtures/discovery-golden.json`), so a Worker change to a template goes
stale under `--check`. Each row names an endpoint set and `{kind, channel?, velopackChannel?,
buildId?}`. The expansion is the one sdk-node's `appcastUrlFrom` and Godot's updater already
ship: an absent channel is `stable`, an alias goes through `CHANNEL_ALIASES` (`staging` → `beta`,
`latest` → `stable`), every placeholder is replaced by the value encoded as
`encodeURIComponent`, `appcast` puts a non-stable channel in the path before `/appcast.xml`, and
`velopack` without a `velopackChannel` is the feed directory Velopack's UpdateManager opens. The
generator recomputes every row with its own reference expansion.

The stage matrix is hand-authored too, and **append-only** in the same way. `buildStageMatrix`
writes literal rows (each an ordered list of host events with the exact emits each produces),
an `accepts` table and one probe per event type, and self-checks them before writing: the stage
lists, the vocabulary, the `accepts` table and every cell of the sync and gate tables. Every
runner replays every row and sends every probe at every state the rows reach. Rows that use
only the current vocabulary keep `stageMatrixVersion`; a change to the vocabulary, to `accepts`
or to an existing row's expectation bumps it, and the package that does so updates every port
in the same change.

`headers.json` and `config-matrix.json` are hand-authored and **append-only** too.
`buildHeadersCorpus` writes one row per spelling; its self-check ties every canonical value to
`conformance/parity/enums.json` and requires an identity row for each, so a new vocabulary value
needs a corpus case, and every runner asserts that its generated table equals the rows. A new
spelling (a row plus a table entry) keeps `headersVersion`; a changed row bumps it (SP-08 took it to 2 when the `visionOS` and `tvOS` rows gained values). `buildConfigMatrix` checks every
expectation against a generator-local reference of §2.2.1 that imports nothing from the SDKs,
and fails on a missing or redundant `expectNoEnv`, an unsorted list, an unused source or JSON
type, a number some SDK would read differently, or a rule whose edges are not pinned. A new row
keeps `configMatrixVersion`; a changed row or rule bumps it.

`update-matrix.json` and `outlet-matrix.json` (wire contract v4) are hand-authored from the
plan's row lists (`plans/P3-01.md` §4.6, §4.7) and **append-only** as well. The generator carries
its own reference `compareVersions`, `effectiveCapabilities`, `resolveUpdateOutlet`,
`decideUpdate`, `bootDecision` and `detectOutlet`, written from the plan and importing nothing
from the SDKs, recomputes every version case, capability case, outlet case, bucket vector,
decision row and detection row, and fails when a result differs from the row's expectation. It
also runs its own claim checks for all six `typ`s, so every per-claim integer case is proved to
break its claim alone. A corpus change that edits a row is plan-mode: amend the plan first.

P4-13 (`plans/P4-13.md` §4) appends content sections without moving any version:

- `cases.json` gains three `feedCases` (`feed-valid-content-members-populated`,
  `feed-valid-content-members-per-platform`, `feed-valid-content-at-cap`, a payload of exactly
  65,536 bytes), so every existing runner proves a populated feed still verifies; a new
  `feedContentCases` section (about 32 cases) after `feedCases`, each a signed, valid feed built
  from one base by one mutation, with `expect.content` (each of `packSets`, `packFloors` and
  `revocations` parsed, or `null`); and a new `revocationCases` section (about 18 cases) after
  `releaseRecordCases`, each with an `entry` (the feed entry) and `mode`
  (`revocation` or `replacement`), expecting the parsed revocation or a failing step (`hash`,
  `jws`, `claims`, `cross-check`, `revocation`). The superseding cases also name the case they
  supersede and are checked with `newerRevocation`.
- `update-matrix.json` gains `packs` in `vocabulary.actions`, `content-floor` and
  `revoked-content` in `vocabulary.blockedReasons`, and 44 `contentRows` after `rows`: the same
  shape plus `input.content`, and on a `packs` answer an `expect.packSetId` the runner recomputes
  as `packSetId(decision.set)`. The self-check that no row answers `required` stays for `rows`;
  `contentRows` must answer `required` exactly on the revoked-content rows.
- `content/cases.json` gains four `stampCases` with `expect.holds`. `parseContentStamp`'s result
  is unchanged; a runner that implements holds runs `holdsOf` on the parsed stamp and compares it
  **only when `expect.holds` is present**, so the section stays append-only.

A runner that does not yet implement a new section ignores it; the count assertions move
(`feedCases` 77 → 80, `stampCases` 6 → 10) in every runner in the same change.

P4-19 (`plans/P4-19.md` §4) appends two sections, each the **last** member of its file, so each
file's diff is a pure append and every earlier section (P4-13's and P4-10's included) stays byte
for byte; no version moves and no runner count assertion changes:

- `cases.json` gains `delegationCases` (46), after `markerCases`. Each case has `id`,
  `description`, `mode` and `jws`, then per mode:
  - `record`: `delegation` (the delegation's compact JWS the caller supplies), `releaseKeys`,
    `productTrust`, `expectedAud`, `expectedHash`, `pin` (or `null`) and, on the two
    `recordRevoked` cases, `revoked` (target hashes); `expect` is `{verify: "ok", kind,
delegation: {sha256, deliverable, types, issuedAt, expiresAt} | null, revoked?}` or
    `{verify: "fail", step}` with `step` one of `hash`, `jws`, `claims`, `cross-check`,
    `delegation`, `scope`. A runner calls `verifyReleaseRecord` with `delegation`, then
    `recordRevoked` when `revoked` is present;
  - `release-only`: the same keys with `delegation: null`; verified with no delegation passed;
  - `revocation`: `delegation: null`, `releaseKeys`, `productTrust`, `expectedAud` and `entry`
    (the feed entry, with `kind: "delegation"` on a delegation target); `expect` as in
    `revocationCases`, checked with `verifyRevocation`;
  - `feed`: `trust`, `expectedAud`, `channel`, `platform`, `now`, `checkFreshness`; a signed, valid
    feed whose `expect.content` is `feedContent`'s answer (the entry `kind` kept, dropped or
    making `revocations` unusable).

  The content key is a deterministic test key derived from a fixed seed in the generator; its
  public half appears only inside the cases' delegations, so the top-level `keys` are unchanged.
  The generator's own reference `delegationOf`, delegated steps 12–16 and `recordRevoked` refuse
  each failing case at exactly its step.

- `content/cases.json` gains `dataOnlyCases` (76), after `frameWindowCases`:
  `{id, description, path, head, tail, tailFill?, content?, expect}`. `head`, `tail` and
  `content` are standard base64. The file is `head ‖ tail`, where a `tailFill` (`{byte, length}`)
  stands in for a long tail of `length` copies of `byte`; or, when `content` is present (Amendment
  A1), the file is `content` and `head` and `tail` are empty. A runner passes `dataOnlyRefusal`
  the path, the file's first 64 bytes, its last 65,557 bytes and the whole file, and expects
  `{ok: true}` or `{ok: false, rule}` with `rule` `extension` or `content`. The cases cover each
  allowed extension, the refused loader extensions, every refused head, the head window's cut
  (whitespace to its end, a word head it cuts), the tail sniff and its bound, an empty file, nine
  paths that are not already normalised, and the text rule (script markers, backslash-split
  markers, ASCII or malformed `\u`/`\U` escapes, invalid UTF-8; non-ASCII escapes and a marker in a `.png` pass).

P4-29 (`plans/P4-29.md` §4) appends three sets for the feed's delta menu; no version moves:

- `cases.json` gains 28 `feedContentCases` (48 → 76), each the P4-13 base feed plus one `deltas`
  mutation. `expect.content` keeps the three P4-13 members, so every older runner passes them
  unchanged, and the menu goes in a sibling `expect.deltas`. A runner that reads the menu compares
  `content.deltas` with `expect.deltas ?? null` on every case, so the 48 older cases pin `null`.
- `plan-matrix.json` gains `feedDeltaCases` (13), after `targetCases`:
  `{id, description, variant, recordSha256, filesIndex, chunkIndex, deltas, installed, caps,
expect: {feedIds, target, plan}}`. A runner computes `withFeedDeltas(variant, deltas)`, then
  `planTarget` over the merged variant and `plan`, and compares by canonical JSON.
- `content/cases.json` gains `feedDeltaApplyCases` (4), after `dataOnlyCases`: the payload-delta
  shape plus `deltas`, over the committed v1 → v2 frame. A runner merges, then runs `applyDelta`
  on the merged variant's delta whose id is `feedIds[0]`.

The only edit outside the new sections is the `feedContentCases` count, 48 → 76, in every runner.

## HTTP transcripts

Registration, activation and sync are conversations, not pure functions, so the corpus cannot
pin them. `conformance/transcripts/*.json` does instead: each file is one conversation — the
requests a client must send and the Worker's real answers — recorded through the production
router by the Worker's own scenario tests and replayed by every SDK against a fake server that
serves the recorded responses and asserts each request.

| Piece                  | Where                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Format (documented)    | `packages/worker/test/transcripts/format.ts`                                                       |
| Recorder and scenarios | `packages/worker/test/transcripts/` (`recorder.ts`, `determinism.ts`, `scenarios/`)                |
| Drift check            | `packages/worker/test/transcripts.test.ts`, wrapped by `pnpm gen:transcripts`                      |
| Swift mirror           | `sdks/swift/Tests/PolarisKeyTests/Resources/transcripts/` (generator-owned, like `v2/`)            |
| Godot mirror           | `sdks/godot/tests/transcripts/` (generator-owned; an exported pack reads only `res://`)            |
| Node replayer          | `conformance/runners/node/transcripts.test.ts` over `transcriptReplay.ts`                          |
| React replayer         | `packages/sdk-react/test/transcripts.test.ts` (the same engine; discovery, update and chunk range) |
| Python replayer        | `sdks/python/tests/test_transcripts.py` over `transcript_replay.py`                                |
| Swift replayer         | `sdks/swift/Tests/PolarisKeyTests/TranscriptTests.swift` over `TranscriptReplay.swift`             |
| Godot replayer         | `sdks/godot/tests/suite_transcripts.gd` over `support/transcript_replay.gd`                        |
| Kotlin replayer        | `sdks/kotlin/conformance/…/TranscriptTest.kt` over `TranscriptReplay.kt` (in place)                |

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
pnpm gen:transcripts            # re-record every scenario, write the files and both mirrors
pnpm gen:transcripts -- --check # the drift guard — exit 1 if anything is stale
```

Never hand-edit a transcript: change the scenario and re-record. A Worker change that alters a
recorded response regenerates the transcripts in the same change; if an SDK replayer then
fails, that SDK has to follow. To add a conversation, add a scenario under
`packages/worker/test/transcripts/scenarios/`, list it in `scenarios/index.ts`, run
`pnpm gen:transcripts`, and map any new action in each SDK's replayer.

A replayer decides whether a transcript applies **before** it maps any step's action. A transcript
whose features an SDK has not implemented can therefore use an action that SDK's replayer does
not know yet, and it is skipped, never failed.

### The SP-00 conversations

`plans/SP-00.md` added five transcripts beside the existing ones (none was re-recorded). Each one
is inert in every SDK until that SDK's task marks its feature `implemented` and maps the new
action in its replayer:

| Transcript                         | Proves                 | Steps                                                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activate-refusals.json`           | `license.refusals`     | `enroll` refused `403 enroll_claimed`, then `403 license_disabled`; `activate` with an expired licence's key (`401 unauthorized` today), on drifted hardware (`409 hardware_mismatch`) and with the client's budget spent (`429 rate_limited`, no `Retry-After`) |
| `boot-cold-register.json`          | `ui.boot`              | One `boot` on a fresh install of an open-registration product: discovery, keyless registration, trust, the config document and the report, ending at the stage machine's `ready` with the gate `not-applicable`                                                  |
| `release-fetch-gated.json`         | `release.fetch`        | `discover`, then `releaseFetch` under licensed delivery: the whole payload (200), a resumed one with `Range` and `If-Range` (206), and, once the licence is disabled, `401 download_auth_required`                                                               |
| `distribution-download-model.json` | `release.distribution` | `downloadModel`: the public `GET /<p>/distribution/download.json`, its platform groups and the group for `initial.platform`                                                                                                                                      |
| `telemetry-report-updates.json`    | `telemetry.updates`    | Two `report` calls over a seventeen-event `initial.updateJournal`: sixteen events (the per-report cap), then the last one                                                                                                                                        |

The three new actions are documented in `format.ts`:

- `boot` is the SDK's one-call boot, with every request its stages make and `expect.bootOutcome`,
  the stage machine's terminal outcome (`stage-matrix.json`'s `vocabulary.outcomes`).
- `releaseFetch` takes a release record's build entry (`version`, `platform`, `arch`, `build`,
  `size`, `sha256`) and an optional `partial`, the byte count of a partial download the replayer
  seeds. It expands discovery's `distribution.endpoints.builds` template and reports the
  verified `size` and `sha256`.
- `downloadModel` is `distribution.downloadModel()`, with `expect.platforms` and `expect.current`.

Two refusals in SDK-PARITY-PASS §3.1 are not recorded, because no route answers them today:
`license_expired` (activation refuses every unusable licence as `unauthorized`) and
`attestation_required` (activation and enrolment are not trust operations).
