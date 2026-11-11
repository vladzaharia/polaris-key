# UK-67 Light Card QR presentation: ui-core choreography and golden frames, then React, SwiftUI, Compose, Godot and Qt renderers; terminal static

| Field       | Value                                       |
| ----------- | ------------------------------------------- |
| Phase       | UK: UI kits                                 |
| Size        | 0.3–0.5 engineer-weeks                      |
| Depends on  | [CC-29K](CC-29K-local-links-kit-screens.md) |
| Unblocks    | none                                        |
| Role        | `pkey-sdk-porter`                           |
| Plan mode   | x                                           |
| Gates       | x                                           |
| Human input | none                                        |
| Repo        | `vladzaharia/polaris-key`                   |

## Goal

The Light Card QR presentation: the ui-core choreography and golden frames first, then the React, SwiftUI, Compose, Godot and Qt renderers. The terminal draws it static.

## Why

The pairing screens of [CC-29K](CC-29K-local-links-kit-screens.md) show a QR; one choreography keeps every kit alike.

## Read first

- `AGENTS.md` (always).
- `docs/design/UI-KITS.md`

## Acceptance criteria

- [ ] Every renderer passes `pkey-ux-reviewer` in BUILT mode; `pnpm ui:lint` is clean.
- [ ] The golden frames match in every kit.

## Hand-off

The role agent sets `--set UK-67 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-67 done`.
