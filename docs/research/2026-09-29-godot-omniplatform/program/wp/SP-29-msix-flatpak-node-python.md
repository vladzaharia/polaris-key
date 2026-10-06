# SP-29 MSIX optional-package and Flatpak extension pack transports (`packs.transport.msix`, `packs.transport.flatpak`): the `pkey transport` build generators and the Node and Python transports

| Field       | Value                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                                                                                           |
| Size        | 1.5–2.5 engineer-weeks                                                                                                                              |
| Depends on  | [P5-08](P5-08-platform-pack-transports.md)                                                                                                          |
| Unblocks    | [SP-30](SP-30-godot-msix-flatpak.md)                                                                                                                |
| Role        | `pkey-sdk-porter`                                                                                                                                   |
| Plan mode   | no                                                                                                                                                  |
| Gates       | Node and Python suites; the CLI reference freshness check; a device run on Windows and a Flatpak desktop; `parity:check`; the generated parity page |
| Human input | a code-signing certificate for MSIX test packages; test devices (Windows 10/11 and a Linux desktop with Flatpak)                                    |
| Repo        | `vladzaharia/polaris-key`                                                                                                                           |

## Goal

A pack can ship as an MSIX optional package or a Flatpak extension: `pkey transport msix-optional` and `pkey transport flatpak-ext` generate the package manifests around a pack, and the Node and Python `msix-optional` and `flatpak-ext` transports find the installed package or extension, verify the pack marker and hand the payload to the pack engine.

## Why

P5-08 left both transports unsupported and no package owns them (program README §9), so Node, Python and Godot carry unowned rows. The parity rows it owns: `packs.transport.msix`, `packs.transport.flatpak` in `packages/sdk-node/parity.json`; `packs.transport.msix`, `packs.transport.flatpak` in `sdks/python/parity.json`; their `note` fields give the current state. It absorbs the parity note's none (program README §9: the `msix-optional` and `flatpak-ext` transports) ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `wp/P5-08-platform-pack-transports.md` (its Out list and the transport contract).
- Microsoft's optional-package docs (related sets, `Package.Current.Dependencies`); Flatpak extension points (`add-extensions`, `/app/extensions`).
- Each SDK's existing transports.

## Scope

**In:**

- The two CLI generators, with template tests.
- Node transports (Windows `Package.Current` through a small native helper or PowerShell, Linux `/app/extensions` paths) and Python transports.
- A recorded device run on Windows and on a Flatpak desktop.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Godot's transports (→ SP-30).
- Microsoft Store add-ons (program README §9, Stores).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- The marker layout matches the other transports; SP-30 follows what this package defines, so write it into the CLI reference.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] `@pkey-feature packs.transport.msix` and `packs.transport.flatpak` tests in Node and Python over fake installs, and device runs recorded in the PR.
- [ ] Both generators have template tests, and the CLI reference is current.
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/node test
( cd sdks/python && .venv/bin/python -m pytest -q )
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- SP-30 reuses the generators and the layout.

The role agent sets `--set SP-29 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-29 done`.
