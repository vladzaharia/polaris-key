# CC-29K Pair with a Code kit screens and QR scanning

| Field       | Value                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | CC                                                                                                                                                                |
| Size        | 0.175 engineer-weeks                                                                                                                                              |
| Depends on  | [CC-29](CC-29-local-links.md), [CC-29b](CC-29b-local-links-android-godot.md), [CC-23L](CC-23L-local-links-plan.md), [CC-29.15](CC-29.15-local-pairing-kit-api.md) |
| Unblocks    | [CC-31U](CC-31U-links-pipeline.md), [CC-30](CC-30-cloud-pairing.md), [UK-67](UK-67-light-card-qr.md)                                                              |
| Role        | `pkey-sdk-porter`                                                                                                                                                 |
| Plan mode   | no                                                                                                                                                                |
| Gates       | pkey-ux-reviewer, ui-snapshots, modernity-lint                                                                                                                    |
| Human input | an iPhone and an Android Play device                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                         |

## Goal

CC-29K.1 is two slices over the kit API of [CC-29.15](CC-29.15-local-pairing-kit-api.md): K.1a ui-core `LocalPairingModel` and `PairedDevicesModel`, kit copy and `ui-matrix` rows; K.1b the React kit and its `LocalLinksLike` driver. K.2: SwiftUI and Compose render both. K.3: QR scanning on iOS and iPadOS (AVFoundation) and Android, with the camera pre-prompt. K.2 also needs CC-29.15f and .15g. K.4: the Godot kit (show with `ui/qr/`, enter, manage).

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
