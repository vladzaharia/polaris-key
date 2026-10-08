# SP-17 Swift copy and crash tags: `ErrorCopy` serves the generated `Copy.generated.swift` tables with fallback and placeholder fill (`core.copy`), and `crashTags()` (`crash.tags`)

| Field       | Value                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                           |
| Size        | 0.4–0.6 engineer-weeks                                                              |
| Depends on  | none                                                                                |
| Unblocks    | none                                                                                |
| Role        | `pkey-sdk-porter`                                                                   |
| Plan mode   | no                                                                                  |
| Gates       | `swift test`; `gen:constants -- --check`; `parity:check`; the generated parity page |
| Human input | none                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                           |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Merged (b141fa858).

- Status: stamped `done` (was `in-review`).

## Goal

`PolarisKeyCore`'s copy API (`copy.message(code)`, `copy.title(code)`) reads `COPY_CODES`, `COPY_GATE`, `COPY_ACTIVATION` and `COPY_FALLBACK` from `Copy.generated.swift` with React's code-versus-activation table rule and placeholder fill, the hand-written `ErrorCopy` table is gone (host English overrides kept as a layer), and `crashTags()` returns release, build, outlet and channel tags.

## Why

The generated Swift copy module is read by nothing, and `ErrorCopy` differs from `copy.en.json` with no placeholder filling. No Swift `crashTags()` exists. The parity rows it owns: `core.copy`, `crash.tags` in `sdks/swift/parity.json`; their `note` fields give the current state. It absorbs the parity note's the serving half of SP-S13 and the Swift crash-tags task of `plans/SP-00.md` §5 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.2 and §3.14.
- `sdks/swift/Sources/PolarisKeyCore/ErrorCopy.swift`, `Copy.generated.swift`; `sdks/swift/Sources/PolarisKeyUI/PolarisKitCopy.swift`.
- The reference rule: `packages/sdk-react/src/core/copy.ts` (error code, then gate status, then activation result; activation results read only the activation table).
- `packages/worker/src/services/distribution/sentry.ts` (the tag vectors).

## Scope

**In:**

- The copy API over the generated tables, with `COPY_FALLBACK` and placeholder fill; a host override layer.
- `PolarisKitCopy` and the kit read the API rather than their own strings where the key exists.
- `crashTags()` / `crashTagsFor()` on the umbrella client.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- The `.xcstrings` localisation catalog (the rest of SP-S13, with UK-07).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- The generated files are output (`AGENTS.md` generated-file table); change the emitter, never the file.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [x] `@pkey-feature core.copy` unit tests: every generated table, the fallback, placeholders and the activation-versus-code split.
- [x] `@pkey-feature crash.tags` unit tests over the Sentry vectors.
- [x] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [x] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [x] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
( cd sdks/swift && swift build && swift test )
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- UK-07's SwiftUI kit reads copy through this API.

The role agent sets `--set SP-17 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-17 done`.
