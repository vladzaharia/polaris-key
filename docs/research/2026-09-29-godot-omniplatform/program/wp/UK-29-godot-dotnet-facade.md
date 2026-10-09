# UK-29 Godot .NET (C#) facade: generated typed wrappers over the GDScript scenes and controllers, typed signals, options records, `PKeyBrand.generated.cs`, NuGet/addon folder, C# demo twin

| Field       | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (should)                 |
| Size        | 2–3 engineer-weeks                                                                             |
| Depends on  | [UK-11](UK-11-godot-kit.md)                                                                    |
| Unblocks    | none                                                                                           |
| Role        | `pkey-godot-engineer`                                                                          |
| Plan mode   | no                                                                                             |
| Gates       | the C# wrapper generator's drift check; the C# demo's screenshots match the GDScript baselines |
| Human input | none                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                      |

## Consolidation 2026-10-07

> **Parked 2026-10-07 (DX consolidation).** Optional and `deferred`, so `--ready` and `--critical`
> skip it. Revive with X-01. Re-read this brief against the code before reviving it.

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **parked** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Godot .NET facade. Revive with X-01.

- Optional now (was required).

## Owner direction (2026-10-08)

- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL1–DL18, inherited from UK-11 (see [hosted surfaces](../../../../design/UI-KITS-LANGUAGE-MATRIX.md#hosted-surfaces)).
- **In this kit:** Typed C# wrappers over UK-11's scenes and controllers: no C# scene, theme or layout, so nothing to adapt. Signals keep the busy and focus semantics.
- **Minimum check:** The C# demo pixel-equal to the GDScript baselines at the Godot rows in both schemes; a gamepad walk of the demo.
- **Acceptance:** the matrix rows above pass; UK-11's UX review covers the screens, and this package's review covers the demo's gamepad walk.

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

A Godot C# project uses the same kit with typed C# APIs, with no second implementation of any scene.

## Why

Godot .NET is a should row of §5.1. It is a facade over the GDScript kit and does not depend on X-01 (the full C# SDK), which stays optional (owner, 2026-10-05). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §5.1 Godot rows
- The UK-11 kit; X-01 brief (what stays out)

## Scope

**In:**

- Generated typed C# wrappers over the scenes and controllers, typed signals, options records.
- `PKeyBrand.generated.cs` (UK-01 target) wired in.
- Optional addon folder and NuGet package; C# twin of the demo project.

**Out** (and where it belongs instead):

- A C# SDK core (→ X-01, optional).

## Design notes

- None beyond the spec.

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] The C# demo renders the same baselines as the GDScript demo in both themes.
- [ ] The wrapper generator has a `--check` mode in the Godot lane.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
sdks/godot/tools/run_tests.sh
```

## Hand-off

None.

The role agent sets `--set UK-29 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-29 done`.
