# SP-20 Kotlin one-call boot in `:sdk` (`ui.boot`): the boot driver moves out of `:ui`'s `PolarisBootState` so the `:conformance` replayer drives `boot-cold-register.json` on the JVM

| Field       | Value                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                                                                          |
| Size        | 0.5–0.8 engineer-weeks                                                                                                             |
| Depends on  | none                                                                                                                               |
| Unblocks    | none                                                                                                                               |
| Role        | `pkey-sdk-porter`                                                                                                                  |
| Plan mode   | no                                                                                                                                 |
| Gates       | Kotlin JVM suites, the Android `:ui` suites, `checkModuleBoundaries`; transcript replay; `parity:check`; the generated parity page |
| Human input | none                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                          |

## Goal

`:sdk` exposes `client.boot()` (discovery, keyless registration, trust, documents and report to a stage outcome) as plain coroutine code with no Android dependency; `:ui`'s `PolarisBootState.launch` becomes a thin state holder over it; and the `:conformance` replayer runs `boot-cold-register.json` and the `stage-matrix.json` outcomes on the JVM.

## Why

The one-call boot lives in `sdks/kotlin/ui/src/main/kotlin/im/plrs/key/ui/PolarisBoot.kt`, an Android library, so no JVM test can drive it and `ui.boot` cannot replay. The parity rows it owns: `ui.boot` in `sdks/kotlin/parity.json`; their `note` fields give the current state. It absorbs the parity note's SP-K06 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.4 and §5.5.
- `sdks/kotlin/ui/src/main/kotlin/im/plrs/key/ui/PolarisBoot.kt`, `PolarisKeyApp.kt`; `client.bootHost()`.
- `sdks/kotlin/conformance/`; Node's `client.boot()` as the reference.

## Scope

**In:**

- The driver moved to `:sdk` with its tests; `:ui` delegates.
- `bootHost()` defaults `fetch` to `PacksClient.bootFetch` and `guard` to the default slots where present.
- Replayer mapping for `boot-cold-register.json`.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Kit screens (UK-09, UK-10).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- `checkModuleBoundaries` must still pass: `:sdk` may not depend on `:ui` or Android.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [x] `@pkey-feature ui.boot` tests in `:conformance` replay `boot-cold-register.json` and the stage outcomes on the JVM.
- [x] `:ui`'s existing boot tests pass unchanged against the delegating holder.
- [x] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [x] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [x] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :sdk:test :conformance:test )
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- UK-09 and UK-10 call `client.boot()` through `:ui`'s holder.

The role agent sets `--set SP-20 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-20 done`.
