# P6-05 Optional: the Kotlin SDK at full parity

| Field       | Value                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P6: Commerce, ops, web (optional)                                                                                                                                                     |
| Size        | 6–8 engineer-weeks                                                                                                                                                                    |
| Depends on  | [P5-06](P5-06-kotlin-aar.md), [P1b-01](P1b-01-parity-registry.md), [P3-02](P3-02-wire-v4-contract-corpus.md), [P1b-03](P1b-03-http-transcripts.md), [P1b-02](P1b-02-sdk-constants.md) |
| Unblocks    | none                                                                                                                                                                                  |
| Role        | `pkey-sdk-porter`                                                                                                                                                                     |
| Plan mode   | no for the SDK itself; any corpus case it finds missing goes to `pkey-wire-planner`                                                                                                   |
| Gates       | none listed. In practice: a new conformance runner, `parity:check`, the language lists in docs, `tools/gen-mirrors.ts`, and a new CI job and release workflow                         |
| Human input | none listed. In practice: a decision that native Android (or JVM) apps are in scope (decision 10), and a Maven Central publisher account with a signing key before the first release  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                             |

This is a kickoff brief for an optional, multi-PR package. The first PR is the skeleton, the corpus
runner and the parity manifest; each later PR closes a group of feature ids.

## Goal

A Kotlin SDK in `sdks/kotlin/`, for Android apps and JVM desktop, that reaches parity with Node and
Swift feature by feature: its `parity.json` starts with every feature `planned` and ends with every
row `implemented` or an allowed `na`, proven by the same corpus files, and by transcripts once
P1b-03 exists. It builds on P5-06's `platform` AAR for everything Android-specific.

## Why

- Decision 10 in [§11](../../README.md#11-decisions-needed): a Kotlin SDK if native Android apps are
  in scope; its AAR is the Godot Android backend either way.
- PARITY orders new SDKs and gives Kotlin +6–8 weeks
  ([PARITY §9](../../PARITY.md#9-new-sdks-order-and-shape) item 3); a new SDK starts with every
  feature `planned` and the gate shows its backlog ([PARITY §3.3](../../PARITY.md#33-the-wave-model-extended)).

## Read first

- `AGENTS.md` (the wave model, the green gate) and `.claude/agents/pkey-sdk-porter.md`.
- [PARITY §2](../../PARITY.md#2-what-parity-means), §4, [§5](../../PARITY.md#5-the-feature-inventory)
  and [§7](../../PARITY.md#7-runtime-limits-that-become-typed-nas); notes/E9 (the `KA` and `KJ` rows,
  items 16–17 of §10: Android JCA Ed25519 is API 33+, Tink below; JDK has EdDSA since 15).
- `sdks/swift/` as the structural model (targets per service, the corpus mirror) and
  `conformance/runners/node/` as the runner model; `tools/gen-mirrors.ts`.
- P5-06's `sdks/kotlin/platform` module and its flavours.

## Scope

**In:**

- Gradle modules beside `platform`, mirroring Swift's targets: `core`, `license`, `config`,
  `update`, and later `packs` and `ui` (Compose). Coroutines (`suspend`, `Flow`) per PARITY §2.3.
- A JUnit conformance runner reading `conformance/corpus/v2/` in place on the JVM (no mirror), and
  wire v4 and content corpora as they exist when this starts.
- `sdks/kotlin/parity.json`, all `planned` at first, registered in the `sdks` list of
  `conformance/parity/features.json`, and the `@pkey-feature` test tags.
- A catalog-mirror target in `tools/gen-mirrors.ts` and generated constants (P1b-02) for Kotlin.
- A CI job (JVM tests; Android unit tests) and a release workflow for Maven Central.
- Every place that lists the SDK languages (AGENTS.md, README, the docs pages, `test:all`), as the
  Godot SDK did (report §5.11).

**Out** (and where it belongs instead):

- Android platform edges (→ [P5-06](P5-06-kotlin-aar.md), already built).
- New corpus cases (→ plan mode with `pkey-wire-planner`).
- Kotlin Multiplatform for Apple targets (notes/E9: out of scope).

## Design notes

- **Crypto.** Ed25519 through JCA on the JVM (15+) and on Android API 33+, Tink below; the minimum
  Android API is a decision for the first PR. SHA-256 and HTTP from the platform; `zstd-jni` for
  deltas (its `.so` files must be 16 KB page aligned).
- **Typed N/As** as PARITY §2.2: the JVM has no install source or In-App Updates; Android has no
  hardware serials (an app-scoped id and the Keystore instead).
- **Order the work by the registry**, not by service: core verification and the corpus runner first,
  then licence and config, then devices and identity, then update and packs. Each PR flips rows in
  `parity.json` and must keep `parity:check` green.
- **Ask before starting.** This package is optional; the human decides whether native Android apps
  are in scope. Recommended start point: after the wire v4 corpus (P3-02) and transcripts (P1b-03)
  exist, so the SDK is built once against the final contract.

## Steps

1. Plan in the first PR: modules, minimum API levels, dependency list, publishing coordinates.
2. Skeleton, corpus runner, `parity.json`; CI job.
3. Feature groups in order, one PR each, with transcripts where they exist.
4. Docs page, language lists, release workflow.

## Acceptance criteria

- [ ] The Kotlin runner passes every `cases.json` and `gate-matrix.json` case it loads, and those
      of any corpus file present when the package closes.
- [ ] `sdks/kotlin/parity.json` has no `planned` row left, and every `na` is allowed by the registry.
- [ ] `parity:check` and the green gate pass (`AGENTS.md`), with the new Kotlin job green.

## Verify

```sh
( cd sdks/kotlin && ./gradlew test )
mise exec node@22 -- pnpm parity:check -- --check
```

## Hand-off

- A published Kotlin SDK whose Android backend is the same AAR Godot uses; Unity and MAUI Android
  can bind the same AAR.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P6-05 done`.

## Plan amendments (P4-10)

The approved [`plans/P4-10.md`](../plans/P4-10.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.
