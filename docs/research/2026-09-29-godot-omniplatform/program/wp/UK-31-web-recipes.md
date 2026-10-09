# UK-31 UI-kit recipes: Vue, Svelte, Angular, Solid, htmx, Tauri, your own design system

| Field       | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (could) |
| Size        | 1–1.5 engineer-weeks                                                          |
| Depends on  | [UK-04](UK-04-web-components.md)                                              |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                        |
| Role        | `pkey-implementer`                                                            |
| Plan mode   | no                                                                            |
| Gates       | docs link check                                                               |
| Human input | none                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                     |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Required: the one Recipes package (Vue, Svelte, Angular, Solid, Preact, htmx, Tauri, bring your own design system) over the elements, each with a sample built in CI (SP-36 layout).

- Title: was "Optional: recipes over the elements for SolidJS, Preact, Qwik, htmx and plain pages (a Solid signals adapter only if demanded)".
- Required now (was optional).
- Estimate: 1–1.5 engineer-weeks (was 0.5–1).
- Absorbs UK-22 (split; this package takes its share): Tailwind v4 preset to UK-04, the CSS-variable 'bring your own design system' recipe to UK-31; the shadcn registry route and the MUI, Mantine and Chakra theme objects are parked.

## Owner direction (2026-10-08)

- **Two implementation paths.** An integrator drops in the kit or builds their own UI on the SDK. The in-app experience leads with the drop-in kit and links to the docs for integrating directly with your own UI. The docs present both paths.

## Design language v2 (2026-10-08)

This package follows the [design language](../../../../design/UI-KITS.md#design-language-v2-2026-10-08) (rules DL1–DL18). Its row of the [application matrix](../../../../design/UI-KITS-LANGUAGE-MATRIX.md):

- **Rules:** DL2, DL3, DL5, DL8, DL12, DL13 and DL18 checked in each recipe; the rest come with the elements.
- **In this kit:** Each recipe uses the elements as shipped. The bring-your-own-design-system recipe maps the host's tokens onto `--pk-*` and keeps the spacing scale, the three weights and the contrast the resolver guarantees. No recipe styles into a shadow root.
- **Minimum check:** Each example at phone portrait and desktop in both schemes passes `pnpm ui:lint` (with UK-55's rules once they land); one UX review across the recipes.
- **Acceptance:** the matrix rows above pass, and a UX review (`pkey-ux-reviewer`) of the built screens gives each a quality verdict of good or better.

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

Docs recipes show the elements in SolidJS, Preact, Qwik, htmx and plain pages, each verified by a tiny runnable example.

## Why

These are could rows of §5.1: recipes, not kits. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §5.1 could rows
- The UK-04 elements

## Scope

**In:**

- One recipe page per framework in `build/ui/` with a runnable example under `examples/ui/recipes/`.

**Out** (and where it belongs instead):

- New packages (none unless demand appears).

## Design notes

- None beyond the spec.

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] Each example renders the gate in both themes and passes `pnpm ui:lint`.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `<StatesToHandle>` from the fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31.
- [ ] The acceptance in "Design language v2 (2026-10-08)" above holds.
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

None.

The role agent sets `--set UK-31 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-31 done`.
