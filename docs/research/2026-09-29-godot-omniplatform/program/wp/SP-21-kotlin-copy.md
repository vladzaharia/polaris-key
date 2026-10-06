# SP-21 Kotlin copy API (`core.copy`): `copy.message(code)` and `copy.title(code)` over `Copy.generated.kt` with fallback and placeholder fill; the Android kit's `PolarisCopy` reads it

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                                            |
| Size        | 0.3–0.5 engineer-weeks                                                                               |
| Depends on  | none                                                                                                 |
| Unblocks    | none                                                                                                 |
| Role        | `pkey-sdk-porter`                                                                                    |
| Plan mode   | no                                                                                                   |
| Gates       | Kotlin JVM and Android suites; `gen:constants -- --check`; `parity:check`; the generated parity page |
| Human input | none                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                            |

## Goal

`:core` serves `copy.message(code)` and `copy.title(code)` from `Copy.generated.kt` with React's code-versus-activation table rule, `COPY_FALLBACK` and placeholder fill, plus a host override layer, and the Android kit's `PolarisCopy` uses it instead of its own strings.

## Why

The generated tables exist but no API reads them, and the kit carries its own strings. The parity rows it owns: `core.copy` in `sdks/kotlin/parity.json`; their `note` fields give the current state. It absorbs the parity note's the Kotlin copy task of §3.2 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.2.
- `Copy.generated.kt`; the `:ui` kit's `PolarisCopy` (and `PolarisCopyMappingTest`).
- `packages/sdk-react/src/core/copy.ts` (the rule).

## Scope

**In:**

- The API and a unit test of fallback and placeholders.
- `PolarisCopy` reads it where the key exists.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Android string resources and translations (UK-09).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- Change the emitter, never the generated file.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature core.copy` unit tests: every table, the fallback, placeholders and the activation-versus-code split.
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :sdk:test :conformance:test )
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- UK-09 and UK-10 read copy through this API.

The role agent sets `--set SP-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-21 done`.
