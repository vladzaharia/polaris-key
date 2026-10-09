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

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/UK-02b.md`](../plans/UK-02b.md) §8: retires `ui.kit`, `ui.kit.manage` and `ui.kit.keyentry` once the ten rows are implemented, on the reduced matrix; checks the two terminal kits against `ui.cli` and the states their verbs reach (D12).

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1, including 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **For this package.** Confirm each must-tier kit meets the five rules above, with its matrix renders in the close-out report.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18.
- **In this kit:** None: this package checks the must kits against the language.
- **Minimum check:** Each must kit's matrix renders in the close-out report, with its UK-55 debt at zero if UK-55 has landed.
- **Acceptance:** every must kit's matrix rows pass, and a UX review of each must kit's gate, sign-in, device-limit, update and settings flows gives each screen a quality verdict of good or better.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- `B14.7`: UK-41 requires an evidence ledger: a matrix cell is complete only with runtime evidence or a documented N/A.

## Acceptance criteria

- [ ] Every must kit has the end-to-end presentation test and it passes.
- [ ] `pnpm parity:check -- --check` passes with the `ui.*` rows proven for the must kits.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `<StatesToHandle>` from the fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
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
