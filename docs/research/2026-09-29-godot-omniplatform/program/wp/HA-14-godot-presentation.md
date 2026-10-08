# HA-14 Godot SDK and UI kit read presentation: icon fetched, verified (SHA-256 in the SDK's own hasher) and cached under `user://`, `ui_accent` default

| Field       | Value                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 5: presentation in SDKs)                                                                                      |
| Size        | 0.5–0.8 engineer-weeks                                                                                                                                                                |
| Depends on  | [HA-11](HA-11-presentation-discovery-plan.md), [HA-12](HA-12-presentation-discovery.md)                                                                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-35](SP-35-sdk-api-registry-api-json-0-9.md), [SP-35b](SP-35b-sdk-api-renames-godot-swift-kotlin.md), [UK-41](UK-41-must-tier-closeout.md) |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                                                                                                              |
| Plan mode   | yes: executes the approved [`plans/HA-11.md`](../plans/HA-11.md)                                                                                                                      |
| Gates       | plan mode; corpus and transcript runners; UI snapshots                                                                                                                                |
| Human input | none                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                             |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Godot side of HA-13.

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

## Approved plan (2026-10-06)

[`plans/HA-11.md`](../plans/HA-11.md) is approved. This package does row 6 of the plan's §5.

- **Seam.** Port the parse, size-choice and verify rules and the `PresentationSource` seam as
  `PKeyPresentationSource` (`core/presentation.gd`): `current()`, `icon(px, scale)` and a
  `changed` signal. UK-11 imports it.
- **Fetch.** `HTTPRequest` with `max_redirects = 0` and no auth or `X-PKey-*` headers, a 10 s
  timeout and a 10 MiB cap. Hash with `HashingContext` SHA-256, and cache at
  `user://polaris_key/presentation/<sha256>` with `presentation.json` beside it.
- **Decodable types.** The Godot `decodable` set is `image/png`, `image/jpeg` and `image/webp`.
  An AVIF or GIF original with no sizes falls back to the monogram.
- **Tests.** A matrix runner for `presentation-matrix.json` from `tests/corpus/v2/`, and replay
  of `discovery-presentation.json`. Flip `core.presentation` to `implemented`.

**Amended by [`plans/HA-12.md`](../plans/HA-12.md) (approved 2026-10-06).**

- The contract text is `WIRE-CONTRACT-V4.md` **§5.5**, not §5.3.
- The usable-URL rule pins no host; staging and dev serve images from `img-staging` and `img-dev`
  (not `media-staging` and `media-dev`).
- Read every limit from the generated `constants_generated.gd` (Q6), never a literal: the
  `PRESENTATION_*` text, URL, size, width, dimension, byte, timeout and cache-file limits and
  `PRESENTATION_ICON_TYPES`.
- The §5.5 text rule drops a `name` or `developerName` holding a C0 control, DEL, a C1 control
  or a lone surrogate, and nothing else, so bidi controls survive (Q5). The URL rule is §5.5
  rule 5 as HA-12 tightened it in review (port, host and `{w}` placement). The kit renders
  `name` and `developerName` bidi-isolated (wrapped in FSI…PDI, U+2068…U+2069).

## Steps

1. Per the plan.

## Acceptance criteria

- [ ] The Godot runner passes `presentation-matrix.json` with the Godot `decodable` set.
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
