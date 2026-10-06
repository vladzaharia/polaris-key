# SP-24 Godot device-local overrides (`config.local`): `config.set`, `config.setting` and `config.clear` with S-17's names, validated against the catalog type, over `PKeyConfigFileStore`

| Field       | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)   |
| Size        | 0.3–0.5 engineer-weeks                                      |
| Depends on  | none                                                        |
| Unblocks    | none                                                        |
| Role        | `pkey-godot-engineer`                                       |
| Plan mode   | no                                                          |
| Gates       | the Godot runner; `parity:check`; the generated parity page |
| Human input | none                                                        |
| Repo        | `vladzaharia/polaris-key`                                   |

## Goal

Godot's config service exposes `set(key, value)`, `clear(key)`, `clear_all()` and `setting(key)` with S-17's names over the persisted `PKeyConfigFileStore`, refuses a value of the wrong catalog type or an admin-managed key, and emits `config_changed` per write.

## Why

Overrides persist and a store write emits `config_changed`, but there is no public API with the registry's names and nothing type-checks a write. The parity rows it owns: `config.local` in `sdks/godot/parity.json`; their `note` fields give the current state. It absorbs the parity note's the API half of SP-G05 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.11; `notes/S-17` §5.11.
- `sdks/godot/addons/polaris_key/services/config.gd`; `tests/config/test_store.gd`.
- Node's `client.config` local API as the reference.

## Scope

**In:**

- The API, type validation against the delivered catalog, the admin-managed refusal.
- Tests.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Settings scenes (UK-11).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- Godot's JSON is lenient (ints arrive as floats): type-check against the catalog's declared type, not the parsed Variant type alone.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature config.local` tests: persist and reload, clear, a type mismatch refused, an admin-managed key refused, one signal per write.
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

- UK-11's settings scene writes through this API.

The role agent sets `--set SP-24 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-24 done`.
