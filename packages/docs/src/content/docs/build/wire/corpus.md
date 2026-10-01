---
title: "The conformance corpus"
description: "One generator signs every vector; four runners verify them; a CI drift gate keeps the committed files and the Swift mirror honest."
sidebar:
  order: 10
---

The corpus is the only automated cross-language enforcement this contract has. The spec is
prose; the SDKs are four codebases in four languages with four JSON parsers and four base64
implementations. What proves they agree is a set of committed, signed vectors that every one of
them runs.

If you are porting the wire contract to a fifth language, the corpus is your acceptance test —
and the moment your runner passes it, it becomes part of the gate that keeps the other four
honest.

Spec references: §6 (mandatory corpus additions, carried from v2), §9 (version counters),
§10 (the divergence ledger).

## One generator

```
tools/sign-corpus.ts  →  conformance/corpus/v2/cases.json
                         conformance/corpus/v2/gate-matrix.json
                         conformance/corpus/v2/fingerprint.json
                         conformance/corpus/v2/stage-matrix.json
                      →  sdks/swift/Tests/PolarisKeyTests/Resources/v2/   (mirror)
```

One signer produces the canonical vectors. Ed25519 is deterministic, so re-signing the same
inputs reproduces the same bytes — which is what makes a drift check possible at all.

The Swift mirror exists because the Swift test target bundles its fixtures as copied resources
and cannot reach up the monorepo at test time. The `v2/` path segment is preserved so the mirror
path matches the source path one-for-one, and the generator writes every file into every
directory of one list (`CORPUS_TARGETS`), so a new file reaches the mirror by construction. The
drift gate guards the mirror exactly like the source.

The corpus is signed with **two committed test keypairs**, `djdl-test-2026` and
`pkey-test-prod-2026`. They exist only to sign the corpus. They are not production keys, they
are not secret, and nothing outside `conformance/` should ever reference them.

`corpus/v1` is **deleted** — v2 is the only corpus. Its fifteen gate-matrix rows were inlined
into the v2 generator before deletion, so nothing it pinned was dropped.

## The four files

| File                | What it pins                                                                                    | Contract section                              |
| ------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `cases.json`        | Six case families covering verification end to end, plus the two test keys                      | §1–§4, §7                                     |
| `gate-matrix.json`  | Every gate transition, as pure input/expected-status rows                                       | §5                                            |
| `fingerprint.json`  | Component order, per-component and composite digest lengths, and the device-id derivations      | Fingerprint v1                                |
| `stage-matrix.json` | The boot stage machine: rows of host events with the exact emits each produces, and guard cases | client boot behaviour, not a contract section |

### The case families in `cases.json`

| Family            | Contract section | What it drives                                                                        |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `jwsCases`        | §1–§2            | Raw compact-JWS verification: alphabet, caps, duplicate keys, `alg`, `typ`, tampering |
| `licenseDocCases` | §3               | Claim validation on `pkey-license+jws`                                                |
| `configDocCases`  | §3               | Claim validation on `pkey-config+jws`, including "no license fields"                  |
| `trustCases`      | §1               | Trust merge, prune, substitution, revocation                                          |
| `clockFloorCases` | §4.2             | The reload path and the monotonic floor over three artifacts                          |
| `bundleCases`     | §7               | Offline bundle import, pinned to the **numbered step** that refuses                   |

Live case counts are generated from the corpus files themselves and published at
[Conformance corpus v2](/docs/reference/corpus/). The fingerprint constants those vectors pin
are at [Fingerprint constants](/docs/reference/fingerprint-constants/).

## Four runners

Every runner reads the **same** files and drives the **shipped** verifier — never an inline
reference implementation written for the test.

| Runner | Path                                                      | Drives                                                                                             |
| ------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Node   | `conformance/runners/node/corpusV2.test.ts`               | `@polaris-key/client-core` — the reference client                                                  |
| Python | `sdks/python/tests/test_conformance.py`                   | `verify_jws`, `verify_license_doc`, `verify_config_doc`, `verify_trust_manifest`, `inspect_bundle` |
| Swift  | `sdks/swift/Tests/PolarisKeyTests/ConformanceTests.swift` | The Swift SDK, against the mirrored `Resources/v2/`                                                |
| React  | `packages/sdk-react/test/gateMatrixParity.test.ts`        | `gate-matrix.json` through `licenseState` **and** the React projection                             |

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

`fingerprint.json` has its own runners alongside these — `conformance/runners/node/fingerprint.test.ts`,
`sdks/python/tests/test_fingerprint_conformance.py`,
`sdks/swift/Tests/PolarisKeyTests/FingerprintConformanceTests.swift` — plus
`packages/worker/test/fingerprintCorpus.test.ts`, because the server derives the same digests
the clients do.

## The drift gate

```sh
pnpm gen:corpus              # write the corpus (and every mirror)
pnpm gen:corpus -- --check   # re-emit in memory; exit 1 if any committed file drifted
```

The `--check` form is wired into two places:

- `.github/workflows/ci.yml`, as a step in the JS/TS job.
- `.husky/pre-commit`, so drift is caught before it is committed.

It fails if the source files **or** any mirror differ from what the generator would
produce right now. That is what stops the two copies from silently parting company, and what
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
2. Run `pnpm gen:corpus`. Commit the regenerated `conformance/corpus/v2/*.json` **and** every
   mirror alongside the generator change.
3. Run all four runners. A vector that only the language you were working in agrees with is
   the finding, not a flake.
4. Fix the divergence.

If the change alters a document shape or the transport around it, it is a wire break: bump
`PROTOCOL_VERSION` too. See [The wire contract](/docs/build/wire/) for who owns which counter.

## What the corpus cannot do

Worth stating plainly, so it is not over-trusted:

- It pins **verification**, not signing. There is exactly one signer, so agreement among
  signers is not a question the corpus is asked.
- It pins the **client-side** contract. Server behaviour reaches it only through the artifacts
  the generator mints in the server's shape.
- It is a set of vectors, not a proof. A rule with no case is a rule four implementations may
  quietly disagree about — which is exactly how the divergence ledger got its first entries.

## Where to go next

- [The envelope](/docs/build/wire/envelope/) — the rules `jwsCases`, `licenseDocCases` and
  `configDocCases` pin.
- [Trust](/docs/build/wire/trust/) — `trustCases`.
- [Cache and clock](/docs/build/wire/cache-and-clock/) — `clockFloorCases`.
- [Offline bundles](/docs/build/wire/bundles/) — `bundleCases`.
