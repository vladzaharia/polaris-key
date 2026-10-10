# ST-07 SettingsRow v2: the one settings engine

| Field       | Value                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 2: experience)                                                                                                                                                                                                            |
| Size        | 0.8–1.1 engineer-weeks                                                                                                                                                                                                                                                          |
| Depends on  | [ST-05a](ST-05a-one-settings-read-write-path.md), [P0-39](P0-39-console-sections-move-page-budget-lead.md)                                                                                                                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-10](P2-10-product-access-page-who-gets-what.md), [U-11a](U-11a-console-data-settings.md), [ST-08](ST-08-product-settings-hub.md), [ST-09](ST-09-platform-settings-area.md), [LX-44](LX-44-license-console-v2-tiers-entitlements.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                              |
| Plan mode   | no                                                                                                                                                                                                                                                                              |
| Gates       | visual baselines (both themes, phone); console CSP parity                                                                                                                                                                                                                       |
| Human input | none                                                                                                                                                                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                       |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> SettingsRow v2 is the one settings engine in ui/settings/ for both scopes: useSettingWrite with conflict and Revert, read-only through useCan with Request access, the duplicated confirmLevel/formatSettingValue deleted. No new settings page before it lands. A console 'now' item: starts after the lead's window (P0-39).

- Title: was "Console `SettingsRow` v2: unified SourceBadge, history drawer, pre-save diff, confirmation level from the registry".
- Depends on: added ST-05a and P0-39; removed ST-05.
- UX rows that name this package: UX-28 (dropped: merged into ST-07 (pre-save diff) and ST-16 (fan-out confirm)).

## Goal

The console's `SettingsRow` v2 renders any registry setting with one SourceBadge vocabulary, a history drawer, a pre-save diff and the confirmation level the registry declares.

## Why

The UX audit found five source vocabularies and inconsistent confirmations ([S-18 §2.6](../../notes/S-18-settings-architecture.md#26-ux-audit-from-the-captures)); [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux) specifies the row.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [S-18 owner decisions](../../notes/S-18-settings-architecture.md) (the 2026-10-04 header block; it wins over the sections below it).
- [S-18 §2.6](../../notes/S-18-settings-architecture.md#26-ux-audit-from-the-captures), [S-18 §4.9](../../notes/S-18-settings-architecture.md#49-console-ux), [S-18 §6.2](../../notes/S-18-settings-architecture.md#62-work-packages) row ST-07.
- `docs/design/ADMIN.md` T4.

## Scope

**In:**

- `SettingsRow` v2 component, SourceBadge, history drawer, pre-save diff, confirm level from the registry.
- Unit and a11y tests; visual baselines in both themes and at phone width.

**Out** (and where it belongs instead):

- The hub and Platform area pages (→ ST-08, ST-09).

## Design notes

- Claim and Revert copy follows model C (owner D2).

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

## Steps

1. Component.
2. Tests and baselines.

## Acceptance criteria

- [x] Unit and a11y tests pass.
- [x] Visual baselines exist for both themes and phone width. (Real-browser renders of the kit gallery's T4 settings story, dark and light at 1440 and 390: default, changed, locked, error, invalid, conflict, reloaded, confirm. No console or portal baseline changed.)
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

## Hand-off

- ST-08, ST-09 and ST-12 compose pages from it.

The role agent sets `--set ST-07 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-07 done`.

## Build notes (ST-07)

- Corrections to the brief: there was no `ui/settings/` and no `useSettingWrite`; the row logic was
  duplicated in `ProductSettingsSection` and `platformSettings.tsx`. The engine now lives in
  `packages/admin/src/ui/settings/` (`model`, `useSettingWrite`, `SettingRow`, `SettingsRow` layout,
  history drawer, conflict note). Both scopes use it; the duplicated `confirmLevel` and
  `formatSettingValue` are deleted. `templates/Settings.tsx` re-exports the layout row.
- One source vocabulary in `SourceBadge`, neutral ink (B17); `platform` and `derived` added.
- Not done, no owner in this package: read-only through `useCan` with Request access (no permission
  hook exists yet; rows take `locked` and `lockedAction` slots for it, ST-29/ST-48); a product-scope
  history drawer (no per-setting history API; platform rows have one from `platform_audit`).
- Save reads "Save…" when a confirmation follows and "Save" when it does not.
