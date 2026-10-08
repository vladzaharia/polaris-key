# SP-30 Godot MSIX optional-package and Flatpak extension pack transports (`packs.transport.msix`, `packs.transport.flatpak`) over SP-29's layout

| Field       | Value                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                                                  |
| Size        | 1–1.5 engineer-weeks                                                                                       |
| Depends on  | [SP-29](SP-29-msix-flatpak-node-python.md)                                                                 |
| Unblocks    | none                                                                                                       |
| Role        | `pkey-godot-engineer`                                                                                      |
| Plan mode   | no                                                                                                         |
| Gates       | the Godot runner; a device run on Windows and a Flatpak desktop; `parity:check`; the generated parity page |
| Human input | test devices (Windows 10/11 and a Linux desktop with Flatpak)                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                  |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive condition (the note): Godot side of SP-29. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Godot side of SP-29.

- Optional now (was required).

## Goal

A Godot desktop export takes packs from an MSIX optional package (through `pkey_win.dll`'s package-identity calls) or a Flatpak extension (`/app/extensions/...`), verifying the marker exactly as SP-29's layout defines.

## Why

Godot is the only SDK with `packs.transport.msix` and `flatpak` rows beside Node and Python, and P5-08 left both unsupported. The parity rows it owns: `packs.transport.msix`, `packs.transport.flatpak` in `sdks/godot/parity.json`; their `note` fields give the current state. It absorbs the parity note's none (program README §9) ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- SP-29's CLI reference and transports.
- `sdks/godot/addons/polaris_key/packs/transport*.gd` (`transport_steam.gd`, `transport_platform.gd`); `pkey_win.dll`.

## Scope

**In:**

- `transport_msix.gd` and `transport_flatpak.gd` and their selection.
- Tests over fake installs; a recorded device run each.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Building the packages (SP-29's generators).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- The MSIX identity read shares `pkey_win.dll` with the outlet's MSIX reader (SP-G15 in the note).

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature packs.transport.msix` and `packs.transport.flatpak` tests in `sdks/godot/tests`, and device runs recorded in the PR.
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

- Godot export docs list both transports.

The role agent sets `--set SP-30 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-30 done`.
