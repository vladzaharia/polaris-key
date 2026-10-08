# UK-41 UI kits must-tier close-out (reduced matrix)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                                                                                                                                                                                                                                                                     |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Depends on  | [UK-04](UK-04-web-components.md), [UK-05](UK-05-react-kit.md), [UK-06](UK-06-electron-kit.md), [UK-07](UK-07-swiftui-ios.md), [UK-08](UK-08-swiftui-macos.md), [UK-09](UK-09-compose-android.md), [UK-10](UK-10-compose-desktop.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md), [UK-13](UK-13-python-terminal.md), [UK-14](UK-14-node-terminal.md), [UK-16](UK-16-ui-docs-scaffold.md), [HA-13](HA-13-sdks-presentation.md), [HA-14](HA-14-godot-presentation.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Gates       | `pnpm ui:report`; `pnpm parity:check -- --check`; docs link check                                                                                                                                                                                                                                                                                                                                                                                                                |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Close-out on the reduced must matrix (elements, React, Electron, SwiftUI iOS and macOS, Compose Android and Desktop, Godot, Qt Quick, two terminals); verifies SP-33b's goldens render each kit's drop-in and api.json's ui.\* symbols.

- Title: was "UI kits must-tier close-out: presentation accent and icon verified end to end in every must kit, `pnpm ui:report` review, `ui.*` parity rows proven, docs complete".

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at the committed matrix: phone portrait and landscape, small landscape 640 × 360, tablet, desktop 1440 and 1920, and TV where relevant, each also at 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **For this package.** Confirm each must-tier kit meets the five rules above, with its matrix renders in the close-out report.

## Goal

The must tier is done as one system: every must kit takes the product's registered accent and icon with zero integrator code against a real discovery document, the side-by-side report is reviewed, and the parity rows say so.

## Why

Kits were built against the presentation seam before HA-13 and HA-14 landed; this is where the real accessor is proven in each kit (owner decision: one path, no kit-side fetch). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §1.2, §7.4, §10 (presentation seam)
- `plans/HA-11.md`, HA-13 and HA-14 PRs

## Scope

**In:**

- Per must kit: a test against a recorded discovery transcript with `core.presentation` showing the accent and verified icon with no integrator code, and today's fallback without it.
- `pnpm ui:report` across all must kits reviewed against the mockups; findings fixed or filed.
- `ui.*` parity rows confirmed proven for every must kit (each kit records its own proofs; this package checks none is left `planned`).
- Docs component pages complete for every must kit.

**Out** (and where it belongs instead):

- Should and could kits (they verify the same in their own packages).

## Design notes

- None beyond the spec.

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] Every must kit has the end-to-end presentation test and it passes.
- [ ] `pnpm parity:check -- --check` passes with the `ui.*` rows proven for the must kits.
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm ui:report
mise exec node@22 -- pnpm parity:check -- --check
```

## Hand-off

The should tier proceeds on a verified must tier.

The role agent sets `--set UK-41 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-41 done`.
