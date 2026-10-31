---
title: "The conformance corpus"
description: "One generator and its family modules, the language runners, the generator-owned Godot mirror, the files and case families, and the HTTP transcripts recorded beside it."
sidebar:
  order: 5
  label: "Corpus"
type: "reference"
lastReviewed: "2026-10-16"
---

`conformance/corpus/v2/` is **one signer's** golden output — encoded documents plus their
expected verify outcomes — that every independent implementation checks itself against
byte-for-byte. It is how every language agrees on the wire without one interpretation of the
same prose per language.

One generator, `tools/sign-corpus.ts` (run via `pnpm gen corpus`), signs every vector from a
fixed keypair and a fixed case list. It is a driver: each corpus file and each `cases.json`
section is built by its own family module in `tools/corpus/` (`gate.ts`, `stage.ts`, `jws.ts`,
`feed.ts`, `update.ts` and so on, over the shared fixtures in `common.ts`, `release-records.ts`,
`pack-records.ts` and `content-fixture.ts`), and every verdict is recomputed by the generator's
independent reference implementations in `tools/corpus/reference/`. If you port the wire contract
to another language, the corpus is your acceptance test. The runners a contributor touches most:

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
  `HeadersTests.swift`, `ConfigMatrixTests.swift`, and more, reading `conformance/corpus/v2/` in
  place through `CorpusLocator` (no mirror).
- **Godot** — `sdks/godot/tests/`: `suite_conformance.gd` covers every `cases.json` family, the
  `fingerprint.json` device ids and both `headers.json` sections, and `config/test_matrix.gd`
  runs `config-matrix.json` with the environment layer on and off (the gate and stage matrices
  follow with the license client and the boot stage machine), run by
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
- **The Worker** — three slices. `packages/worker/test/core/headersCorpus.test.ts` runs every
  `headers.json` row through the normaliser that stores the client metadata headers. `packages/worker/test/core/fingerprintCorpus.test.ts` covers the
  fingerprint/device-id vectors: the Worker recomputes a submitted device's `hwid` server-side
  rather than trusting the client's copy, so it has to agree with what every SDK computes
  client-side. `packages/worker/test/core/gateMatrixCorpus.test.ts` replays every `gate-matrix.json`
  row through the server's own `checkBuildGate`, which makes the server the oracle for the
  build-gate ports the Node, Python and Swift runners carry. It is not a runner for the signed
  cases: it is a signer for license, config, and trust documents in production, not an
  independent verifier of pre-signed ones.

Node, Python, and Swift each assert byte-identical verify outcomes against the whole corpus;
the Worker's slice is narrower but no less load-bearing, since a drifted `hwid` formula would
silently stop matching a returning machine to its existing free-tier enrollment.

## The files

The files, in one directory, so a runner can point at `corpus/v2/` and find everything it needs:

| File                       | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cases.json`               | JWS cases, license/config documents, trust manifests, clock-floor sequences, offline bundles, and (wire contract v4) channel feeds and release records. A case whose payload holds a number that cannot be a wire integer lists those pointers in `nonWireIntegers`, beside `expect`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `gate-matrix.json`         | The client gate's decision table — every input combination and the state it must produce (`rows`) — and, in `entitlementRows`, what `isEntitled` answers in each license state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fingerprint.json`         | Hardware-fingerprint and device-id derivation vectors, and the §6.1 source rules: `windowsCim` (with `windowsCimCommand`), `linuxAnchor`, `ramBuckets`. Node and Python run all three; Swift runs `ramBuckets`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `stage-matrix.json`        | The boot stage machine (client boot behavior, outside the wire contract): rows, guard cases and (version 2) boot-confirmation cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `headers.json`             | WIRE-CONTRACT-V4 §5.2: each runtime spelling of a platform or arch and its canonical header value, or none. The rows are the `PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` tables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `config-matrix.json`       | WIRE-CONTRACT-V4 §2.2.1: config precedence, the variable name, the strict environment value and the user-visible list, each with a no-environment answer where it differs (`expectNoEnv`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `update-matrix.json`       | WIRE-CONTRACT-V4 §11.1: version comparisons, capability narrowing, the decision's outlet, rollout buckets and every update-decision row with its boot value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `outlet-matrix.json`       | WIRE-CONTRACT-V4 §11.2: outlet capability defaults and narrowing, the listing-URL prefixes, the detection signals and every detection row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `plan-matrix.json`         | WIRE-CONTRACT-V4 §11.4: the install planner's rows, variant selection and target mapping (packs v1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `feed-url-matrix.json`     | The app-updater feed URLs (`appcast`, `winsparkle`, `velopack`, `appInstaller`, `zsync`) expanded from discovery's `update.endpoints` templates, or `{unsupported: "product"}` when a template is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sync-scenarios.json`      | WIRE-CONTRACT-V4 §11.5: the Cloud Sync client scenarios, literal data written by hand in `tools/sync-scenarios.ts` (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `device-label.json`        | WIRE-CONTRACT-V4 §12.7.1 (PX-W13): raw device labels and their normalised form, or none. Every SDK runs every row, and the Worker runs them through `/identity/auth/device/start`. Non-ASCII code points are written escaped; no row holds U+0000, which a Godot `String` cannot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `presentation-matrix.json` | WIRE-CONTRACT-V4 §5.5: discovery's `core.presentation` parsed field by field (`parseCases`), the icon size chosen for a pixel size, scale and decodable set (`pickCases`), and icon bytes checked against their SHA-256 (`verifyCases`, base64 bytes). ASCII only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `portal-matrix.json`       | WIRE-CONTRACT-V4 §5.7: discovery's `core.portal` parsed as a whole (`parseCases`) and the one product page link a terminal kit draws, from the response's own link, the member or the legacy guess (`linkCases`). ASCII only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ui-matrix.json`           | The UI kits' layer-(c) state matrix: for each of the eight component families an input and the component, state, copy keys and actions every kit's headless model answers; the `theme` resolution and the `i18n` lookup and formatter; and `cli`, the terminal drop-in contract. Generated, unsigned, ASCII only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `backend-matrix.json`      | WIRE-CONTRACT-V4 §14: product backends. `verdict` (the verdict on `X-PKey-License`, signed license documents inside), `problem` (the refusal body, its challenge and its locale, written from the copy catalog) and `client` (the refresh-and-retry rule). Server cores replay `verdict` and `problem`, client halves `client`. ASCII only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sync-vectors.json`        | WIRE-CONTRACT-V5 §13.10: Cloud Sync end-to-end known answers, recomputed by an independent `node:crypto` reference. `hkdfCases` (every key label, anchored by RFC 5869), `envelopeCases` (`pkey-sync-value/1`: seal, open, padding, tamper, wrong name, alias, and the record names of a value, a field and an element with a swapped id or field), `blindCases`, `transferPlanCases`, `hpkeAnchor` (the RFC 9180 vector for the wrap suite), `wrapCases` (`pkey-sync-wrap/1`), `recoveryCodeCases`, `adoptCases`, `cdcCases` (cut points), `cdcEditCases` (an insert, delete or overwrite at the start, middle and end, and a one-byte change: which chunk ids change and which stay), `deltaCases` (the chunks a transfer must move between two manifests), `chunkCases`, `fileStreamCases`, `manifestCases` and `canonicalJsonCases`. The Node and browser runners read the sections they implement. ASCII only. |
| `noise-vectors.json`       | WIRE-CONTRACT-V5 §15.5: the `pkey-peer/1` Noise known answers: RFC 7748 X25519, the low-order points, AES-256-GCM, the three handshake modes with fixed ephemerals, rekey, the refusals and external `Noise_XX_25519_AESGCM_SHA256` anchors. ASCII only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `peer-matrix.json`         | WIRE-CONTRACT-V5 §15.4 to §15.7: `pkey-peer/1` byte-level rules from an independent `node:crypto` reference. `adverts` (instance names, the product tag, TXT parsing, browsing), `prologue`, `psk`, `sas` (the code, commit and reveal), `frames`, `records` (flags, `MORE`, critical and mode rules, the 1 MiB limit), `relayEnvelopes` and `handshakePayloads`. A runner reads the sections it implements. ASCII only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `device-proof.json`        | WIRE-CONTRACT-V5 §12.11.1, §15.8: the device proof `pkey-proof/1`, recomputed by an independent `node:crypto` reference. `cases` has a valid row for each of the nine purposes and a refusal for each rule: a field that breaks the line format, a proof moved to another purpose, product, device, token hash or value, a non-canonical signature (S, R, spelling, length), a signing key of small order or not canonical, a bad agreement key and the `keys` skew window; `keyValueCases` builds the `keys` value. A runner answers true or false; `reason` is documentation. ASCII only.                                                                                                                                                                                                                                                                                                                         |
| `content/`                 | WIRE-CONTRACT-V4 §2.6: `content/cases.json` (path rules, the files index, the chunk index, full, delta, file and chunk apply, `packSetId`, the content stamp, `frameWindow`) over the committed blobs in `content/blobs/`. Source only, not mirrored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

There is exactly one corpus: v1 was deleted when wire contract v2 shipped, so there is no
dual-shape ambiguity for a runner to pick the wrong side of. Version constants travel with the
files themselves — `corpusVersion` **2**, `gateMatrixVersion` **2**, `fingerprintVersion` **1**,
`stageMatrixVersion` **3**, `headersVersion` **2**, `configMatrixVersion` **1**,
`updateMatrixVersion` **1**, `outletMatrixVersion` **1**, `planMatrixVersion` **2**,
`feedUrlMatrixVersion` **1**, `syncScenariosVersion` **2**, `deviceLabelVersion` **1**,
`contentCorpusVersion` **2**, `deviceProofVersion` **1**, `noiseVectorsVersion` **1**, `peerMatrixVersion` **1**, `presentationMatrixVersion` **1**, `uiMatrixVersion` **4** — and case counts, generated
straight from the corpus files, live at
[Conformance corpus v2](/docs/reference/corpus/).

## Swift reads the checkout

The Swift tests read `conformance/corpus/v2/` (and `conformance/transcripts/`) in place.
`CorpusLocator` (`sdks/swift/Tests/PolarisKeyTests/CorpusLocator.swift`) finds the repository
root from its own `#filePath`, which is fixed at compile time, so `swift test` finds the files
from any working directory as long as the package sits in a monorepo checkout; nothing is copied
into the test bundle. The former generator-owned mirror under
`sdks/swift/Tests/PolarisKeyTests/Resources/v2` and `…/Resources/transcripts` are retired, and the drift checks fail if
either directory reappears (an older branch can merge a file back into it).

## The Godot resource mirror

An exported Godot pack can read only `res://`, its own project directory, so the generator also
writes every file into `sdks/godot/tests/corpus/v2/`. The editor run and the
release-template run both read that mirror, and the drift check guards it like the source.
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

Content corpus v2 adds the chunk blobs: `chunks/v1.pkc` (stored raw),
`chunks/v2.pkc` and its zstd frame `chunks/v2.pkc.zst` (the object `djdl.levels@1.2.0` pins, so
the two corpora join by hash), the synthetic `chunks/dup.pkc` (t1's first three files with the
first repeated, so duplicate records exist), and `bundles/<sha256>`: v2's new bundles, the one
v1 bundle the repair case refetches from, and the dup bundle. The rebuild's reference chunker is
`fastcdc-2016-nc1` with the file-aware segments and the 64-byte padding rule, at a 64 KiB average, with per-chunk `zstd -19` frames stored raw when not smaller. The
corpus bundle target is 256 KiB (production CI uses 4 MiB) so request runs cross bundles and
only one v1 bundle ships; v2's bundles are laid out shared after v1's.

The only writer of either is the explicit rebuild mode, never part of the gate:

```sh
pnpm gen corpus -- --rebuild-content-blobs   # needs `zstd -V` to report exactly 1.5.7
pnpm gen corpus                              # then rebuild cases.json, plan-matrix.json and the signed records
```

The rebuild computes every blob in memory and then **adds only**: it throws, writing nothing, when
an existing blob's bytes would change or disappear, or when an existing `refs.json` entry would
change (`tools/gen-content-corpus.test.ts` proves it on a
temporary copy). A rebuild that reproduces every committed frame adds nothing, so a new blob can
land with the feature that needs it; changing an existing blob still changes the hashes signed
over it and needs a PR of its own with the guard deliberately relaxed. `.prettierignore` and `.gitattributes` (`binary`) cover `content/blobs/` so that
`pnpm format` and `core.autocrlf` never change a hashed byte.

## Never hand-edit the generated files

`cases.json`, `gate-matrix.json`, `fingerprint.json`, `stage-matrix.json`, `headers.json`,
`config-matrix.json`, `update-matrix.json`, `outlet-matrix.json`, `plan-matrix.json`,
`feed-url-matrix.json`, `sync-scenarios.json`, `device-label.json`, `presentation-matrix.json`,
`portal-matrix.json`, `ui-matrix.json`, `backend-matrix.json`, `sync-vectors.json`, `noise-vectors.json`, `peer-matrix.json`, `device-proof.json`, `content/cases.json`, and the Godot
mirror are all output.
`pnpm gen corpus --check` regenerates every one of them **in memory** and fails if any
committed file differs — the mirror included. A red drift job means a wire-affecting change wasn't
reflected in the corpus; regenerate and commit the result in the same PR:

```sh
pnpm gen corpus            # write the corpus (and the Godot mirror)
pnpm gen corpus --check # the drift guard — exit 1 if anything is stale
```

Never weaken a runner to make a change "pass." If a runner disagrees with the corpus, either the
runner has a bug or the corpus is missing a case for the behavior you actually intended — not a
reason to loosen an assertion.

## One generator

```
tools/sign-corpus.ts  →  conformance/corpus/v2/cases.json
                         conformance/corpus/v2/gate-matrix.json
                         conformance/corpus/v2/fingerprint.json
                         conformance/corpus/v2/stage-matrix.json
                         conformance/corpus/v2/headers.json
                         conformance/corpus/v2/config-matrix.json
                         conformance/corpus/v2/update-matrix.json
                         conformance/corpus/v2/outlet-matrix.json
                         conformance/corpus/v2/feed-url-matrix.json
                         conformance/corpus/v2/sync-scenarios.json  (literal, tools/sync-scenarios.ts)
                         conformance/corpus/v2/device-label.json
                      →  sdks/godot/tests/corpus/v2/                      (Godot mirror)

tools/gen-content-corpus.ts (called from sign-corpus.ts's main)
  reads   conformance/corpus/v2/content/blobs/            (inputs: zstd blobs, refs.json)
  writes  conformance/corpus/v2/content/cases.json        (source only, not mirrored)
          conformance/corpus/v2/plan-matrix.json          (mirrored like every top-level file)
```

One signer produces the canonical vectors. Ed25519 is deterministic, so re-signing the same
inputs reproduces the same bytes — which is what makes a drift check possible at all.
`sign-corpus.ts` is the driver: each file and each `cases.json` section has its own family
module in `tools/corpus/`, and the generator's independent reference implementations, which
recompute every verdict, live in `tools/corpus/reference/`.

The one mirror exists because one runner cannot reach up the monorepo at test time: an exported
Godot pack can read only `res://`, its own project directory. The `v2/` path segment is preserved
so the mirror path matches the source path one-for-one. The generator writes every file into
every target in one list (`CORPUS_TARGETS`), and the drift gate guards the mirror exactly like
the source. A JSON file in a target that the generator does not write fails the gate as a stray.
Every other runner reads `conformance/` in place; the Swift tests find it through
`CorpusLocator`, which resolves the repository root from its own `#filePath`.

The corpus is signed with **two committed test keypairs**, `djdl-test-2026` and
`pkey-test-prod-2026`. They exist only to sign the corpus. They are not production keys, they
are not secret, and nothing outside the corpus and its generator-owned mirror should ever
reference them.

`corpus/v1` is **deleted** — v2 is the only corpus. Its fifteen gate-matrix rows were inlined
into the v2 generator before deletion. Fourteen are still carried; the fifteenth, which pinned
the dev-build bypass R3-01 removed, was retired by an approved plan, and its successor
row pins the opt-in bypass instead.

## The case families in `cases.json`

| Family               | Contract section | What it drives                                                                                                                                    |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jwsCases`           | §1–§2            | Raw compact-JWS verification: alphabet, caps, duplicate keys, `alg`, `typ`, tampering                                                             |
| `licenseDocCases`    | §3               | Claim validation on `pkey-license+jws`                                                                                                            |
| `configDocCases`     | §3               | Claim validation on `pkey-config+jws`, including "no license fields"                                                                              |
| `trustCases`         | §1               | Trust merge, prune, substitution, revocation                                                                                                      |
| `clockFloorCases`    | §4.2             | The reload path and the monotonic floor over three artifacts                                                                                      |
| `bundleCases`        | §7               | Offline bundle import, pinned to the **numbered step** that refuses                                                                               |
| `feedCases`          | §2.4, §3.4       | Channel feeds: signature, claims, the canonical channel and the `seq` floor                                                                       |
| `releaseRecordCases` | §2.5, §3.5       | Release records: the hash before the signature, the release keys, the claims, the pin                                                             |
| `packRecordCases`    | §2.5.1, §2.5.2   | `kind: pack` records and an app record's `content` and `builds[].embeds`, one case per registered claim check, over the content set's object refs |
| `markerCases`        | §2.7, §3.7       | Embedded-pack markers, in the marker verification order                                                                                           |
| `licenseUserCases`   | §2.1, §3.2       | The signed-in subject, `profile.user`, read beside the claims by `licenseUserOf`; never refuses a document                                        |

Live case counts are generated from the corpus files themselves and published at
[Conformance corpus v2](/docs/reference/corpus/). The fingerprint constants those vectors pin
are at [Fingerprint constants](/docs/reference/fingerprint-constants/).

## The runners

Every runner reads the **same** files and drives the **shipped** verifier — never an inline
reference implementation written for the test.

| Runner  | Path                                                      | Drives                                                                                             |
| ------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Node    | `conformance/runners/node/corpusV2.test.ts`               | `@polaris-key/client-core` — the reference client                                                  |
| Browser | `conformance/runners/browser/corpusV2.browser.test.ts`    | The same suites as Node (`conformance/runners/node/suites.ts`), in Chromium, Firefox and WebKit    |
| Python  | `sdks/python/tests/test_conformance.py`                   | `verify_jws`, `verify_license_doc`, `verify_config_doc`, `verify_trust_manifest`, `inspect_bundle` |
| Swift   | `sdks/swift/Tests/PolarisKeyTests/ConformanceTests.swift` | The Swift SDK, reading `conformance/corpus/v2/` in place through `CorpusLocator`                   |
| React   | `packages/sdk-react/test/gateMatrixParity.test.ts`        | `gate-matrix.json` through `licenseState` **and** the React projection                             |
| Godot   | `sdks/godot/tests/suite_conformance.gd`                   | The addon's core, from the `res://` mirror, on an editor **and** an exported template              |
| Kotlin  | `sdks/kotlin/conformance/src/test/…/CorpusV2Test.kt`      | `:core` and the service modules, reading `conformance/corpus/v2/` in place, on JCA and on Tink     |
| Worker  | `packages/worker/test/core/gateMatrixCorpus.test.ts`      | `gate-matrix.json` through the server's own `checkBuildGate`: the oracle for every runner's port   |

### Runtimes and version floors

One runtime is not proof: decoder behavior can show only on the lowest supported version. CI therefore runs the corpus on more than one build of each runtime, and
every runner prints its runtime and library versions at the top of its log, so a failure is
attributable to the build that produced it.

| CI job            | Runs                                                                                                    | Banner                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `js`              | every JS suite, the Node runner included, on Node 22                                                    | `process.versions`: node, openssl, v8                    |
| `node-floor`      | the Node runner, `@polaris-key/client-core` and `@polaris-key/node` on exactly the `engines.node` floor | the same, plus a check that the runtime is the floor     |
| `browser`         | the browser runner in Chromium (Playwright 1.63.0)                                                      | `navigator.userAgent`                                    |
| `browser-firefox` | the browser runner in Firefox 155.0, Linux (`mcr.microsoft.com/playwright:v1.63.0-noble`)               | `navigator.userAgent`                                    |
| `browser-webkit`  | the browser runner in WebKit 26.6, macOS 15                                                             | `navigator.userAgent`                                    |
| `python`          | the Python suite on CPython 3.9 and 3.14 (Linux) and 3.12 (macOS)                                       | `sys.version`, cryptography (with its OpenSSL) and httpx |

The browser runner drives the Node runner's own suites, so `cases.json`, `gate-matrix.json`,
`update-matrix.json` and `outlet-matrix.json` verify through WebCrypto's Ed25519 and SHA-256
instead of Node's. It loads the files through Vite rather than `node:fs`. `fingerprint.json`
stays Node-only, because the web has no fingerprint. There is no Linux WebKit job: Linux
Playwright WebKit, like WebKitGTK with libgcrypt, kills the web process when WebCrypto verifies
an Ed25519 message of about 64 KiB or more, so the two at-cap vectors would fail on every run.
That failure is correct, and no row is skipped or capped to hide it. The job can exist only
once `shared-jws` gains a size-aware Ed25519 fallback, which no work package owns yet.

`stage-matrix.json` has its own runners too: `conformance/runners/node/stageMatrix.test.ts`
(through `@polaris-key/client-core/stages`, which React shares),
`sdks/python/tests/test_stage_matrix.py` and
`sdks/swift/Tests/PolarisKeyTests/StageMatrixTests.swift`. Each replays every row, sends every
probe of the file's `accepts` table at every state the rows reach, and checks every guard case.

The React runner is the odd one out on purpose. The gate itself is proven by the Node runner;
what only the React suite can prove is that the React state machine feeds it the right
inputs — `licenseServiceEnabled` from the capability map, `activation` from the transport,
`highWaterMark` from the clock floor. It does not carry its own port of the gate to diverge
from.

The Godot runner covers every `cases.json` family and the `deviceIds` vectors; the gate matrix
follows with the license client. Its platform has one declared representation limit
(WIRE-CONTRACT-V4 §10): a GDScript `String` cannot hold U+0000. The Godot verifier decodes the escape `\u0000` as U+FFFD on every engine, and
for each `jwsCases` string that contains U+0000 the generator writes `expect.docNulReplaced`, a
map from the value's RFC 6901 pointer to its U+FFFD form. The Godot runner compares those values
exactly; every other runner ignores the field. Verdicts are unaffected.

The Node, Python and Swift gate-matrix runners each carry a **port** of the server's build gate
(WIRE-CONTRACT-V4 §5.1), built from that SDK's own semver and channel helpers; the Worker runner
replays the same rows through the real gate, so a port that drifts, or a doctored `expect`,
fails on the server side too.

`headers.json` has a runner in every SDK and one in the Worker:
`conformance/runners/node/headers.test.ts` (through `client-core`'s `canonicalPlatform` and
`canonicalArch`, which React shares), `packages/sdk-react/test/headers.test.ts` (the `web` rows
against the captured request), `sdks/python/tests/test_headers.py`,
`sdks/swift/Tests/PolarisKeyTests/HeadersTests.swift`, the `platformCases`/`archCases` section
of `sdks/godot/tests/suite_conformance.gd`, and `packages/worker/test/core/headersCorpus.test.ts`,
which runs every row through the normaliser that stores the headers. Each runner also asserts
that its generated `PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` table equals the rows.

`device-label.json` has a runner in every SDK and one in the Worker:
`conformance/runners/node/deviceLabel.test.ts` (through `client-core`'s `normalizeDeviceLabel`,
which React shares), `sdks/python/tests/test_device_label.py`,
`sdks/swift/Tests/PolarisKeyTests/DeviceLabelTests.swift`, the device-label section of
`sdks/godot/tests/suite_conformance.gd`, the Kotlin `DeviceLabelTest`, and
`packages/worker/test/services/identity/deviceLabelCorpus.test.ts`, which sends every row through
`/identity/auth/device/start` and checks the echoed label.

`config-matrix.json` has one runner per SDK: `conformance/runners/node/configMatrix.test.ts`
(`client-core`'s `resolveValue`, `resolveSource` and `listUserEntries`),
`packages/sdk-react/test/configMatrix.test.ts` (every row against its no-environment answer,
`expectNoEnv` where present), `sdks/python/tests/test_config_matrix.py`,
`sdks/swift/Tests/PolarisKeyTests/ConfigMatrixTests.swift` and
`sdks/godot/tests/config/test_matrix.gd` (with the environment layer on and off). Two declared
representation limits (WIRE-CONTRACT-V4 §10) touch only parsed values, never verdicts: Swift
keeps the first of two canonically equivalent member names, and Godot's number reader is not
correctly rounded.

`fingerprint.json` has its own runners alongside these — `conformance/runners/node/fingerprint.test.ts`,
`sdks/python/tests/test_fingerprint_conformance.py`,
`sdks/swift/Tests/PolarisKeyTests/FingerprintConformanceTests.swift`, and the `deviceIds` section of
`sdks/godot/tests/suite_conformance.gd` — plus
`packages/worker/test/core/fingerprintCorpus.test.ts`, because the server derives the same digests
the clients do.

## The drift gate

```sh
pnpm gen corpus              # write the corpus (and the Godot mirror)
pnpm gen corpus --check   # re-emit in memory; exit 1 if any committed file drifted
```

The `--check` form is wired into two places:

- `.github/workflows/ci.yml`, as a step in the JS/TS job.
- `.husky/pre-commit`, so drift is caught before it is committed.

It fails if the source files **or** a mirror differ from what the generator would produce right
now, or if a mirror holds a JSON file the generator does not write. That is what stops the
copies from silently parting company, and what
stops a "small fix" to a fixture from becoming a rule nobody wrote down.

Note the `--` in the pnpm invocation. Without it the flag is consumed by pnpm rather than
passed to the script, and the command silently _rewrites_ the corpus instead of checking it.

:::danger[Never hand-edit a corpus file]
The vectors are signed. Editing `cases.json` by hand either breaks a signature (and every
runner fails with an error that points at the wrong thing) or is silently reverted the next
time anyone runs `gen corpus` — and `--check` fails CI in the meantime.

Change the generator (`tools/sign-corpus.ts` and its family modules in `tools/corpus/`),
regenerate, and commit the regenerated files together with the generator change.
:::

## What the corpus cannot do

Worth stating plainly, so it is not over-trusted:

- It pins **verification**, not signing. There is exactly one signer, so agreement among
  signers is not a question the corpus is asked.
- It pins the **client-side** contract, plus two server functions: the build gate, which the
  Worker replays over `gate-matrix.json`, and the client metadata normaliser, which it runs over
  `headers.json`. Other server behavior reaches it only through the artifacts the generator
  mints in the server's shape.
- It is a set of vectors, not a proof. A rule with no case is a rule the implementations may
  quietly disagree about — which is exactly how the divergence ledger got its first entries.

## Where to go next

- [Add a corpus case](/docs/contribute/corpus-cases/) — the add-a-case loop, each hand-authored matrix, and the HTTP transcripts.
- [The envelope](/docs/reference/protocol/envelope/) — the rules `jwsCases`, `licenseDocCases` and
  `configDocCases` pin.
- [Trust](/docs/reference/protocol/trust/) — `trustCases`.
- [Cache and clock](/docs/reference/protocol/cache-and-clock/) — `clockFloorCases`.
- [Offline bundles](/docs/reference/protocol/bundles/) — `bundleCases`.
- [Pack byte formats](/docs/reference/protocol/packs/) — the content corpus.
