# HA-13 SDKs and UI kits read presentation: client-core, React, Node, Python, Swift, Kotlin (icon verified by SHA-256, accent default, integrator override wins)

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Phase       | HA: Hosted assets: Polaris Key hosts every file it serves (S-20) (phase 5: presentation in SDKs) |
| Size        | 1–1.5 engineer-weeks                                                                             |
| Depends on  | [HA-11](HA-11-presentation-discovery-plan.md), [HA-12](HA-12-presentation-discovery.md)          |
| Unblocks    | [UK-41](UK-41-must-tier-closeout.md)                                                             |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                             |
| Plan mode   | yes: executes the approved [`plans/HA-11.md`](../plans/HA-11.md)                                 |
| Gates       | plan mode; all SDKs; corpus and transcript runners; UI snapshots                                 |
| Human input | none                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                        |

## Goal

Each SDK exposes the product's presentation from discovery. React, Swift and Kotlin UI kits default their logo to the verified icon, and their accent to the product accent, when the integrator passes nothing. Parity manifests are updated.

## Why

It completes "zero integrator work" for every non-Godot SDK ([S-20 §6.9](../../notes/S-20-hosted-assets.md#69-sdks-and-ui-kits-icon-and-accent-with-zero-integrator-work)).

## Read first

- AGENTS.md (always) and CLAUDE.md.
- [notes/S-20](../../notes/S-20-hosted-assets.md). Its owner-decisions header (delegated, 2026-10-05) wins over the sections below it.
- `plans/HA-11.md`.
- PARITY.md; each kit's theme (`sdk-react/src/components/brand.tsx`, `PolarisTheme.swift`, `PolarisTheme.kt`).

## Scope

**In:**

- Discovery types, icon fetch and cache keyed by `sha256`, kit defaults, UI snapshots.

**Out** (and where it belongs instead):

- Godot (→ HA-14).

## Design notes

- A failed or mismatched icon falls back to the letter tile silently.
- **UI kits (owner decision, 2026-10-05).** This package is the only path by which presentation reaches a kit. Expose it as each SDK's presentation accessor and implement the kit core's `PresentationSource` seam: `@polaris-key/ui-core` (UK-03), the Swift presentation core (UK-07), Kotlin `commonMain` (UK-09) and `polaris_key.ui.core` (UK-12). Where a UK kit has not landed yet, wire today's kit theme as planned; the UK kit then reads the same accessor. No kit fetches discovery or caches the icon itself. UK-41 verifies the default end to end ([UI-KITS.md](../../../../design/UI-KITS.md) §1.2, §10).

## Steps

1. Per the plan, in its SDK order.

## Acceptance criteria

- [ ] Transcript replayers pass in every SDK.
- [ ] UI snapshots show the product icon for a fixture with presentation, and today's output without it.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm test
```

## Hand-off

None.

The role agent sets `--set HA-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set HA-13 done`.
