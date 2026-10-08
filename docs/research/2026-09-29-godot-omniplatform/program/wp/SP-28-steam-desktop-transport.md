# SP-28 Steam depot pack transport for desktop SDKs (`packs.transport.steam`): Node, Python, Swift (macOS) and Kotlin (JVM) read an installed depot or DLC through P5-08's `steam` transport contract

| Field       | Value                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                                                                               |
| Size        | 1.5–2.5 engineer-weeks                                                                                                                  |
| Depends on  | [P5-08](P5-08-platform-pack-transports.md)                                                                                              |
| Unblocks    | none                                                                                                                                    |
| Role        | `pkey-sdk-porter`                                                                                                                       |
| Plan mode   | no                                                                                                                                      |
| Gates       | each SDK's suite; a device run on a Steam test branch; `parity:check`; the generated parity page                                        |
| Human input | Steamworks partner account (P5-08's test app, build account and test branch); test devices (a Steam client on macOS, Windows and Linux) |
| Repo        | `vladzaharia/polaris-key`                                                                                                               |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive when such a product ships; P4-33's auto then picks it. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Steam depot transport for non-Godot desktop SDKs. Revive when such a product ships; P4-33's auto then picks it.

- Optional now (was required).

## Goal

A desktop app built with Node, Python, Swift (macOS) or Kotlin (JVM) takes a pack from an installed Steam depot or DLC: the `steam` transport locates the install directory, checks DLC ownership where the pack is gated, verifies the pack marker exactly as Godot's `transport_steam.gd` does, and hands the payload to the pack engine.

## Why

P5-08 built Steam depots for Godot only, so four desktop SDKs carry an unowned `packs.transport.steam` row. The parity rows it owns: `packs.transport.steam` in `packages/sdk-node/parity.json`; `packs.transport.steam` in `sdks/python/parity.json`; `packs.transport.steam` in `sdks/swift/parity.json`; `packs.transport.steam` in `sdks/kotlin/parity.json`; their `note` fields give the current state. It absorbs the parity note's none (P5-08 covered Godot only) ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `wp/P5-08-platform-pack-transports.md` and `sdks/godot/addons/polaris_key/packs/transport_steam.gd`.
- Each SDK's `PackObjectTransport` (or equivalent) interface and its existing transports.
- `notes/E3` §B3 (SteamPipe, DLC).

## Scope

**In:**

- A `steam` transport per SDK, with Steamworks reached through an optional dependency (steamworks.js / steamworks-py / a host closure in Swift and Kotlin) and a typed `dependency` N/A when absent.
- Unit tests over a fake install directory and ownership oracle.
- One recorded device run per OS on the test branch.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Building depots (P5-08's `pkey transport steam-depot vdf`).
- MSIX and Flatpak (→ SP-29, SP-30).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- The marker check is shared with Godot: same file names, same verdicts. Do not invent a second layout.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] Each of the four SDKs has `@pkey-feature packs.transport.steam` tests over the fake install, and the PR records a device run per OS.
- [ ] Rows on runtimes Steam cannot serve keep or gain the registry's N/A (`ios`, `android`, `web`).
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/node test
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :sdk:test :conformance:test )
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- Desktop pack docs list Steam for every SDK.

The role agent sets `--set SP-28 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-28 done`.
