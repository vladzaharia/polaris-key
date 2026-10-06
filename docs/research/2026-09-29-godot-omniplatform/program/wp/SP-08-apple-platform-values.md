# SP-08 Canonical platform values `tvos`, `visionos` and `watchos` (wire item W8): `shared-protocol` platform enum, `headers.json` corpus rows, Worker acceptance, Swift sends them, Godot and React follow the enum

| Field       | Value                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (wire items)                                                                                                 |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                      |
| Depends on  | [P1b-04](P1b-04-headers-config-corpora.md)                                                                                                                  |
| Unblocks    | [UK-26](UK-26-visionos-kit.md), [UK-27](UK-27-tvos-kit.md), [UK-33](UK-33-watchos.md), [MO-06](MO-06-portal-device-activation-motion.md)                    |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                       |
| Plan mode   | yes: `pkey-wire-planner` writes `plans/SP-08.md` first; no code before a human approves it                                                                  |
| Gates       | plan mode; corpus (`headers.json`, Swift and Godot mirrors, `gen:corpus -- --check`); all SDKs (`parity:check`, `gen:constants -- --check`); `test:workerd` |
| Human input | none                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                   |

## Goal

`tvos`, `visionos` and `watchos` are canonical platform values: `shared-protocol`'s platform enum and
the `headers.json` corpus carry them, the Worker accepts them in `X-PKey-Platform` and the device
metadata, Swift sends them on those platforms, and Godot and React follow the enum.

## Why

Wire item W8 in [`notes/SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §6. The owner chose
canonical values over a mapping to `ios` on 2026-10-05 (the note's owner decisions, Q4).

## Read first

- `AGENTS.md` and `CLAUDE.md` (plan mode); `docs/security/WIRE-CONTRACT-V4.md` §5.2.
- `packages/shared-protocol`, `conformance/corpus/v2/headers.json`, `tools/sign-corpus.ts`.

## Scope

**In:** contract text, enum, corpus rows, Worker acceptance and storage, Swift, Godot and React
enums, and the compatibility story for old Workers (an unknown value today) and old SDKs (`ios`).

**Out:** new update feeds or outlets for these platforms.

## Steps

1. Plan, then contract and corpus, then Worker, then SDKs: the approved
   [`plans/SP-08.md`](../plans/SP-08.md) §2–§7. Build targets stay `RELEASE_PLATFORMS` (six
   values; contract §5.2 rule 5). Acceptance is the plan's §9.

## Corrections found in the code (implementer, 2026-10-05)

- **`headersVersion` goes to 2, not 1.** `PLATFORM_CASES` already held `swift-visionos`
  (`visionOS` → no value) and `swift-tvos` (`tvOS` → no value). The self-check refuses two rows
  that fold alike with different expects, so those two rows change in place: `swift-visionos`
  becomes `swift-godot-visionos` (`visionOS` → `visionos`, Godot's `OS.get_name()` confirmed as
  `"visionOS"` in `platform/visionos/os_visionos.mm`) and `swift-tvos` expects `tvos`. headers.json's
  own rule bumps the version for a changed row, so it is 2, and every runner's pin (Node, React,
  Worker, Python, Swift, Godot, Kotlin) follows. Four rows are appended: `canonical-tvos`,
  `canonical-visionos`, `canonical-watchos` and `swift-watchos`. `PROTOCOL_VERSION` stays 4.
- **Migration number is `0079`** (main's highest at the final gate was `0078_hosted_assets`); `LATEST_MIGRATION`
  follows. The 0040 replay test now applies 0040 and 0079 in order, because it compares against
  today's normaliser, which maps `tvOS` and `visionOS` now.
- **Python's rule 5 guard** lives in `update/client.py` as the module-level `update_platform()`.
- **Portal:** `FreeDevicePage` had a second copy of `DeviceGlyph`. Both use the new
  `deviceFamily()`, and device rows name the OS (`Apple TV`, `Apple Vision Pro`, `Apple Watch`)
  through `deviceOsName()`. The download vocabulary (`PlatformKey`) stays six.
- **Godot:** `devices.gd`'s device report keeps `PKeyHeaders.platform()` (device metadata, like the
  header). Every build-target call site reads `PKeyHeaders.update_platform()`.

## Acceptance criteria

- [x] `gen:corpus -- --check` and `parity:check` pass; the Worker accepts the three values.
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- Swift's tvOS and visionOS support, and the UI kit's Apple floors (iOS 18, macOS 15), rely on these values.

The role agent sets `--set SP-08 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-08 done`.
