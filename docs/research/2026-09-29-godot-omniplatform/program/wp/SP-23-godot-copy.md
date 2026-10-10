# SP-23 Godot copy API (`core.copy`): `copy.message(code)` and `copy.title(code)` over `PKeyCoreCopy` with fallback and placeholder fill; the kit's `PKeyUiCopy` reads it

| Field       | Value                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                            |
| Size        | 0.3–0.5 engineer-weeks                                                               |
| Depends on  | none                                                                                 |
| Unblocks    | none                                                                                 |
| Role        | `pkey-godot-engineer`                                                                |
| Plan mode   | no                                                                                   |
| Gates       | the Godot runner; `gen constants --check`; `parity:check`; the generated parity page |
| Human input | none                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                            |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Merged (084693d4f).

- Status: stamped `done` (was `in-review`).

## Goal

`PKeyCore` exposes `copy.message(code)` and `copy.title(code)` over `core/copy_generated.gd` (`PKeyCoreCopy`) with React's code-versus-activation table rule, `COPY_FALLBACK` and placeholder fill, plus a host override layer, and the kit's `PKeyUiCopy` uses it instead of its own table.

## Why

The generated GDScript table exists but nothing reads it. The parity rows it owns: `core.copy` in `sdks/godot/parity.json`; their `note` fields give the current state. It absorbs the parity note's the API half of SP-G03 and SP-G13 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.2.
- `sdks/godot/addons/polaris_key/core/copy_generated.gd`; the kit's `PKeyUiCopy` (`sdks/godot/addons/polaris_key/ui/`).
- `packages/sdk-react/src/core/copy.ts` (the rule).

## Scope

**In:**

- The API and a unit test.
- `PKeyUiCopy` reads it where the key exists.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- `.po` generation from the copy catalogs (SP-G13 in the note).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- Godot's lenient JSON parsing does not apply: the table is generated GDScript.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature core.copy` tests in `sdks/godot/tests`: every table, the fallback, placeholders and the activation-versus-code split.
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- UK-11's Godot kit reads copy through this API.

The role agent sets `--set SP-23 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-23 done`.
