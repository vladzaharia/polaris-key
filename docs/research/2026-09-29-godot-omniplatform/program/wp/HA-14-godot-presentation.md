# HA-14 Godot SDK and UI kit read presentation: icon fetched, verified (SHA-256 in the SDK's own hasher) and cached under `user://`, `ui_accent` default

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 5: presentation in SDKs) |
| Size        | 0.5–0.8 engineer-weeks                                                                           |
| Depends on  | [HA-11](HA-11-presentation-discovery-plan.md), [HA-12](HA-12-presentation-discovery.md)          |
| Unblocks    | [UK-41](UK-41-must-tier-closeout.md)                                                             |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                         |
| Plan mode   | yes: executes the approved [`plans/HA-11.md`](../plans/HA-11.md)                                 |
| Gates       | plan mode; corpus and transcript runners; UI snapshots                                           |
| Human input | none                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                        |

## Goal

The Godot SDK parses `core.presentation`. The UI kit's brand node and `ui_accent` default to the product's verified icon and accent.

## Why

Godot is the program's primary engine. Its kit today shows only bundled marks ([S-20 §4.1](../../notes/S-20-hosted-assets.md#41-product-presentation) P8).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- `plans/HA-11.md`.
- `sdks/godot/addons/polaris_key/ui/theme/pkey_ui_theme.gd`, `pkey_ui_view.gd`, `settings/settings_controller.gd`; the measured Godot constraints (redirect auth leak; no SHA-512).

## Scope

**In:**

- Parse, fetch (no auth header; the media host is public), verify, cache, defaults, snapshots.

**Out** (and where it belongs instead):

- Other SDKs (→ HA-13).

## Design notes

- Use the SDK's existing SHA-256 path. Never follow a redirect away from the media origin.
- **UI kit (owner decision, 2026-10-05).** This package is the only path by which presentation reaches the Godot kit: the modernised kit (UK-11) reads it through its `ProductIdentity` seam into `ui_accent` and the brand node. If UK-11 has landed, plug into that seam; if not, wire today's `pkey_ui_theme` and UK-11 keeps the same accessor. UK-41 verifies the default end to end ([UI-KITS.md](../../../../design/UI-KITS.md) §1.2, §10).

## Steps

1. Per the plan.

## Acceptance criteria

- [ ] The Godot transcript runner passes, and kit snapshots show the icon.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
See the Godot test lane in AGENTS.md.
```

## Hand-off

None.

The role agent sets `--set HA-14 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-14 done`.
