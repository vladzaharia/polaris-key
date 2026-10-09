# UK-61 Optional: native GNOME kit (PyGObject over polaris_key.ui.core)

| Field       | Value                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (could)                              |
| Size        | 1.5–2.5 engineer-weeks                                                                                     |
| Depends on  | [UK-12](UK-12-python-qt.md), [UK-02b](UK-02b-ui-fixtures-parity.md), [UK-56](UK-56-kit-mockups-refresh.md) |
| Unblocks    | none                                                                                                       |
| Role        | `pkey-sdk-porter`                                                                                          |
| Plan mode   | no (no wire change)                                                                                        |
| Gates       | ui-snapshots, modernity-lint                                                                               |
| Human input | none                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                  |

> **Parked.** Optional and `deferred`, so `--ready` and `--critical` skip it. parked 2026-10-09 beside UK-38: native GNOME kit; ui-core lets a host draw its own.

## Goal

GTK 4 and libadwaita widgets an Adw app embeds: AdwStatusPage for gate and states, AdwDialog for presentation 'sheet', AdwAlertDialog for the Replace confirm, AdwPreferencesPage for Account and license, with a Flatpak sample.

## Why

This is the only native GNOME path we can ship (there is no Rust or C SDK). UK-12 covers Qt, including its KDE form; GNOME is separate.

## Read first

- `AGENTS.md` and the relevant skill.
- [Brand transition decisions](../BRAND-TRANSITION.md), B10.
- The design docs the decisions amend: `docs/design/BRAND.md`, `docs/design/EXPERIENCE.md`, `docs/design/UI-KITS.md`, `docs/design/PORTAL.md` and `docs/design/ADMIN.md` as they apply.

## Scope

**In:**

- libadwaita 1.5 floor; accent from AdwStyleManager under native (1.6+); GLib main-loop marshalling; AT-SPI names.
- gettext catalogs UK-02a already generates.

**Out** (and where it belongs instead):

- Qt and KDE (→ UK-12).
- wxPython and Kivy (→ UK-38).

## Brand transition (2026-10-09)

New package from the brand and transition integration. Sources: Brand transition B10 (program/BRAND-TRANSITION.md); section change sdk-b-26. No wire change; do not derive APIs, entitlements or permissions from any mockup. Where the brand guide and a current mockup, design-language rule (DL1-DL18) or owner note disagree, the mockup, rule or note wins (B-decisions, source precedence).

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 3 mockup item(s):** `kitboard:linux:gate`, `kitboard:linux:activate-adwdialog`, `kitboard:linux:boot-status-error`.

## Acceptance criteria

- [ ] Revive only on the owner's go; re-read this brief against the code first.
- [ ] The Flatpak sample runs the activation flow through the OpenURI portal.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```
mise exec node@22 -- pnpm <the package's own tests>
```

## Hand-off

What downstream packages rely on from this one is listed in its Unblocks row. The role agent sets `--set UK-61 in-review` when it hands off; after review the lead adds the last commit `--set UK-61 done`.
