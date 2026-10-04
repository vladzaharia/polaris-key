---
title: "The conformance corpus"
description: "One generator signs every vector; every language runner verifies them; a CI drift gate keeps the committed files and their generator-owned mirrors honest."
sidebar:
  order: 11
---

The corpus is the only automated cross-language enforcement this contract has. The spec is
prose; the SDKs are separate codebases in separate languages, each with its own JSON parser and
base64 implementation. What proves they agree is a set of committed, signed vectors that every
one of them runs.

If you are porting the wire contract to another language, the corpus is your acceptance test —
and the moment your runner passes it, it becomes part of the gate that keeps the others honest.

Spec references: §6 (mandatory corpus additions, carried from v2), §9 (version counters),
§10 (the divergence ledger).

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
                      →  sdks/swift/Tests/PolarisKeyTests/Resources/v2/   (Swift mirror)
                      →  sdks/godot/tests/corpus/v2/                      (Godot mirror)

tools/gen-content-corpus.ts (called from sign-corpus.ts's main)
  reads   conformance/corpus/v2/content/blobs/            (inputs: zstd blobs, refs.json)
  writes  conformance/corpus/v2/content/cases.json        (source only, not mirrored)
          conformance/corpus/v2/plan-matrix.json          (mirrored like every top-level file)
```

One signer produces the canonical vectors. Ed25519 is deterministic, so re-signing the same
inputs reproduces the same bytes — which is what makes a drift check possible at all.

The mirrors exist because two runners cannot reach up the monorepo at test time. The Swift test
target bundles its fixtures as copied resources, and an exported Godot pack can read only
`res://`, its own project directory. The `v2/` path segment is preserved so each mirror path
matches the source path one-for-one. The generator writes every file into every target in one
list (`CORPUS_TARGETS`), and the drift gate guards the mirrors exactly like the source. A JSON
file in a target that the generator does not write fails the gate as a stray.

The corpus is signed with **two committed test keypairs**, `djdl-test-2026` and
`pkey-test-prod-2026`. They exist only to sign the corpus. They are not production keys, they
are not secret, and nothing outside the corpus and its generator-owned mirrors should ever
reference them.

`corpus/v1` is **deleted** — v2 is the only corpus. Its fifteen gate-matrix rows were inlined
into the v2 generator before deletion. Fourteen are still carried; the fifteenth, which pinned
the dev-build bypass R3-01 removed, was retired by an approved plan (P0-04), and its successor
row pins the opt-in bypass instead.

## The files

| File                 | What it pins                                                                                                                                                                                       | Contract section                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `cases.json`         | Six case families covering verification end to end, plus the two test keys                                                                                                                         | §1–§4, §7                                     |
| `gate-matrix.json`   | Every gate transition, as pure input/expected-status rows                                                                                                                                          | §5                                            |
| `fingerprint.json`   | Component order, per-component and composite digest lengths, the device-id derivations, and the three source rules (`windowsCim` with the pinned `windowsCimCommand`, `linuxAnchor`, `ramBuckets`) | Fingerprint v1, §6.1                          |
| `stage-matrix.json`  | The boot stage machine: rows of host events with the exact emits each produces, and guard cases                                                                                                    | client boot behaviour, not a contract section |
| `headers.json`       | Each runtime spelling of a platform or arch and its canonical `X-PKey-Platform` / `X-PKey-Arch` value, or none (`platformCases`, `archCases`)                                                      | §5.2                                          |
| `config-matrix.json` | Config precedence, the environment variable name, the strict environment value and the user-visible list (`resolveCases`, `envValueCases`, `listCases`), with each no-environment answer           | §2.2.1                                        |
| `update-matrix.json` | The update decision: version comparison, capability narrowing, the outlet, the rollout bucket and every decision row                                                                               | §11.1 (client behaviour)                      |
| `outlet-matrix.json` | Outlet capability defaults and narrowing, listing-URL prefixes, and outlet detection                                                                                                               | §11.2 (client behaviour)                      |
| `plan-matrix.json`   | The install planner (`rows`), variant selection (`variantCases`) and target mapping (`targetCases`)                                                                                                | §11.4 (client behaviour)                      |
| `content/cases.json` | The content corpus: path rules, the files index, full, delta and file apply, `packSetId`, the content stamp and `frameWindow`, over the committed blobs in `content/blobs/`                        | §2.6, §2.7                                    |

### The case families in `cases.json`

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

### The content corpus

`content/` is the one part of the corpus that holds bytes rather than signed text. Its blobs
(a real v1 → v2 pack pair, its file blobs, a whole-payload delta, the packed per-file delta set,
the same files as trees, a small tree pair, and since content corpus v2 the `pkey-chunks/1`
indexes and the chunk bundles they name) are **inputs**: zstd output is not stable across
libzstd versions, so a normal or `--check` run never compresses. It decodes the blobs with
`@polaris-key/zstd-wasm`, checks each against the `blobs` table in `content/cases.json`, and
rebuilds `content/cases.json` and `plan-matrix.json` from them. `content/blobs/refs.json` holds
the refs of the few objects the signed records pin but the corpus does not ship (they would pass
the 5 MB budget). Only `pnpm gen:corpus -- --rebuild-content-blobs`, which refuses any zstd but
1.5.7, writes the blobs or `refs.json`, and it may only add them: it throws, writing nothing,
when an existing blob or `refs.json` entry would change (`plans/P4-10.md` decision 15), so
changing an existing blob, which changes hashes, is a PR of its own.
`content/` is not mirrored: every runner reads it from the checkout. `.prettierignore` and
`.gitattributes` (`binary`) keep formatters and line-ending conversion away from the hashed
bytes.

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
| Swift   | `sdks/swift/Tests/PolarisKeyTests/ConformanceTests.swift` | The Swift SDK, against the mirrored `Resources/v2/`                                                |
| React   | `packages/sdk-react/test/gateMatrixParity.test.ts`        | `gate-matrix.json` through `licenseState` **and** the React projection                             |
| Godot   | `sdks/godot/tests/suite_conformance.gd`                   | The addon's core, from the `res://` mirror, on an editor **and** an exported template              |
| Kotlin  | `sdks/kotlin/conformance/src/test/…/CorpusV2Test.kt`      | `:core`, reading `conformance/corpus/v2/` in place, once on the JCA and once on the Tink backend   |
| Worker  | `packages/worker/test/gateMatrixCorpus.test.ts`           | `gate-matrix.json` through the server's own `checkBuildGate`: the oracle for every runner's port   |

### Runtimes and version floors

One runtime is not proof: notes/A7 found decoder behaviour that only shows on the lowest
supported version. CI therefore runs the corpus on more than one build of each runtime, and
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
follows with the licence client (P1-03). Its platform has one declared representation limit
(WIRE-CONTRACT-V3 §10): a GDScript `String` cannot hold U+0000. The Godot verifier decodes the escape `\u0000` as U+FFFD on every engine, and
for each `jwsCases` string that contains U+0000 the generator writes `expect.docNulReplaced`, a
map from the value's RFC 6901 pointer to its U+FFFD form. The Godot runner compares those values
exactly; every other runner ignores the field. Verdicts are unaffected.

The Node, Python and Swift gate-matrix runners each carry a **port** of the server's build gate
(WIRE-CONTRACT-V3 §5.1), built from that SDK's own semver and channel helpers; the Worker runner
replays the same rows through the real gate, so a port that drifts, or a doctored `expect`,
fails on the server side too.

`headers.json` has a runner in every SDK and one in the Worker:
`conformance/runners/node/headers.test.ts` (through `client-core`'s `canonicalPlatform` and
`canonicalArch`, which React shares), `packages/sdk-react/test/headers.test.ts` (the `web` rows
against the captured request), `sdks/python/tests/test_headers.py`,
`sdks/swift/Tests/PolarisKeyTests/HeadersTests.swift`, the `platformCases`/`archCases` section
of `sdks/godot/tests/suite_conformance.gd`, and `packages/worker/test/headersCorpus.test.ts`,
which runs every row through the normaliser that stores the headers. Each runner also asserts
that its generated `PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` table equals the rows.

`config-matrix.json` has one runner per SDK: `conformance/runners/node/configMatrix.test.ts`
(`client-core`'s `resolveValue`, `resolveSource` and `listUserEntries`),
`packages/sdk-react/test/configMatrix.test.ts` (every row against its no-environment answer,
`expectNoEnv` where present), `sdks/python/tests/test_config_matrix.py`,
`sdks/swift/Tests/PolarisKeyTests/ConfigMatrixTests.swift` and
`sdks/godot/tests/config/test_matrix.gd` (with the environment layer on and off). Two declared
representation limits (WIRE-CONTRACT-V3 §10) touch only parsed values, never verdicts: Swift
keeps the first of two canonically equivalent member names, and Godot's number reader is not
correctly rounded.

`fingerprint.json` has its own runners alongside these — `conformance/runners/node/fingerprint.test.ts`,
`sdks/python/tests/test_fingerprint_conformance.py`,
`sdks/swift/Tests/PolarisKeyTests/FingerprintConformanceTests.swift`, and the `deviceIds` section of
`sdks/godot/tests/suite_conformance.gd` — plus
`packages/worker/test/fingerprintCorpus.test.ts`, because the server derives the same digests
the clients do.

## The drift gate

```sh
pnpm gen:corpus              # write the corpus (and the Swift and Godot mirrors)
pnpm gen:corpus -- --check   # re-emit in memory; exit 1 if any committed file drifted
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
time anyone runs `gen:corpus` — and `--check` fails CI in the meantime.

Change `tools/sign-corpus.ts`, regenerate, and commit the regenerated files together with the
generator change.
:::

## Adding a case

The rule from §10 is: **an observed divergence gets a corpus case before it gets a fix.** A
difference that is fixed without being pinned comes back, usually in a different language.

The loop:

1. Add the vector to the appropriate family in `tools/sign-corpus.ts`, with a `description`
   that states the _rule_, not the symptom. The descriptions are read by whoever debugs a
   failure three years from now.
2. Run `pnpm gen:corpus`. Commit the regenerated `conformance/corpus/v2/*.json` **and** both
   mirrors alongside the generator change.
3. Run every runner, including the Godot one (`sdks/godot/tools/run_tests.sh`). A vector that only the language you were working in agrees with is
   the finding, not a flake.
4. Fix the divergence.

If the change alters a document shape or the transport around it, it is a wire break: bump
`PROTOCOL_VERSION` too. See [The wire contract](/docs/build/wire/) for who owns which counter.

## What the corpus cannot do

Worth stating plainly, so it is not over-trusted:

- It pins **verification**, not signing. There is exactly one signer, so agreement among
  signers is not a question the corpus is asked.
- It pins the **client-side** contract, plus two server functions: the build gate, which the
  Worker replays over `gate-matrix.json`, and the client metadata normaliser, which it runs over
  `headers.json`. Other server behaviour reaches it only through the artifacts the generator
  mints in the server's shape.
- It is a set of vectors, not a proof. A rule with no case is a rule the implementations may
  quietly disagree about — which is exactly how the divergence ledger got its first entries.

## Where to go next

- [The envelope](/docs/build/wire/envelope/) — the rules `jwsCases`, `licenseDocCases` and
  `configDocCases` pin.
- [Trust](/docs/build/wire/trust/) — `trustCases`.
- [Cache and clock](/docs/build/wire/cache-and-clock/) — `clockFloorCases`.
- [Offline bundles](/docs/build/wire/bundles/) — `bundleCases`.
- [Pack byte formats](/docs/build/wire/packs/) — the content corpus.
