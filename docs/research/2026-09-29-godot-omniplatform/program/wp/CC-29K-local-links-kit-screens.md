# CC-29K Pair with a Code kit screens and QR scanning

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC                                                                                                                 |
| Size        | 0.15 engineer-weeks                                                                                                |
| Depends on  | [CC-29](CC-29-local-links.md), [CC-29b](CC-29b-local-links-android-godot.md), [CC-23L](CC-23L-local-links-plan.md) |
| Unblocks    | none                                                                                                               |
| Role        | `pkey-sdk-porter`                                                                                                  |
| Plan mode   | no                                                                                                                 |
| Gates       | pkey-ux-reviewer, ui-snapshots, modernity-lint                                                                     |
| Human input | an iPhone and an Android Play device                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

CC-29K.1: ui-core `LocalPairingModel` and `PairedDevicesModel`, kit copy, `ui-matrix` rows, the React kit. K.2: SwiftUI and Compose render both. K.3: QR scanning on iOS and iPadOS (AVFoundation) and Android, with the camera pre-prompt. K.4: the Godot kit (show with `ui/qr/`, enter, manage).

## Why

The labels are "Pair with a Code" and "Paired" (`plans/LOCKER-FEATURE-NAMES.md`). Every screen is UX-reviewed in BUILT mode.

## Read first

- `AGENTS.md` (always).
- The CC-23L plan §10 (CC-29K rows)
- `docs/design/UI-KITS.md`

## Acceptance criteria

- [ ] Every screen passes `pkey-ux-reviewer` in BUILT mode; `pnpm gen ui-matrix brand --check` and `pnpm ui:lint` are clean.
- [ ] Scanning is verified on an iPhone and an Android Play device (owner hardware).

## Hand-off

The role agent sets `--set CC-29K in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-29K done`.
