# SP-22 Python copy over the generated catalog (`core.copy`): `polaris_key.copy` serves `copy_generated.py` with React's code-versus-activation table rule and `COPY_FALLBACK`, keeping host English overrides

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                     |
| Size        | 0.2–0.4 engineer-weeks                                                        |
| Depends on  | none                                                                          |
| Unblocks    | none                                                                          |
| Role        | `pkey-sdk-porter`                                                             |
| Plan mode   | no                                                                            |
| Gates       | pytest; `gen:constants -- --check`; `parity:check`; the generated parity page |
| Human input | none                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                     |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Merged (93d25e485).

- Status: stamped `done` (was `in-review`).

## Goal

`polaris_key.copy.message()` and `title()` read `copy_generated.py` (error code, then gate status, then activation result; activation results only from the activation table), fall back to `COPY_FALLBACK`, fill placeholders, and keep a host English override layer as React and Node do, so the hand-kept EN table is deleted.

## Why

`copy.py` still reads a hand-kept table whose strings and fallback differ from `copy.en.json`. The parity rows it owns: `core.copy` in `sdks/python/parity.json`; their `note` fields give the current state. It absorbs the parity note's the copy half of SP-P14 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.2.
- `sdks/python/src/polaris_key/copy.py`, `copy_generated.py`.
- `packages/sdk-react/src/core/copy.ts` and its host override layer (commit 3f6538aef).

## Scope

**In:**

- Switch `copy.py` to the generated catalog with the override layer.
- Callers in the CLI and Qt kits keep working.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- French or other locales (later SP work).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- The generated module is output; change the emitter if a shape is missing.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature core.copy` unit tests: every table, the fallback, placeholders, the activation-versus-code split and an override.
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
( cd sdks/python && .venv/bin/python -m pytest -q )
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- Python UI kits read copy through this module.

The role agent sets `--set SP-22 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-22 done`.
