# DOC-02a Shared components

| Field       | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (site design)                         |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                     |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md), [UK-58](UK-58-brand-expression-tokens.md), [UK-57](UK-57-brand-assets.md)                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [DOC-02b](DOC-02b-chrome.md), [DOC-02c](DOC-02c-search.md), [DOC-13](DOC-13-site-code-examples.md) |
| Role        | `pkey-implementer`                                                                                                                         |
| Plan mode   | no                                                                                                                                         |
| Gates       | `human-approval`, `docs-generated`, `docs-links`, `ui-snapshots`                                                                           |
| Human input | the lead approves the components.md §7 and BRAND.md §2 lines (D7, plan mode)                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                                  |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-02a (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.

## Scope

**In:** §8.2: `ui/theme.css` split out of the console's `styles.css`; `@astrojs/react` renders the static components; `ui/classes.ts` constants; Expressive Code themes and frame; the table wrapper; DOC-03a's MDX components restyled on these; components.md §7 and the BRAND.md §2 line

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`packages/admin/src/{styles.css,ui/*,lib/highlight.ts}`; `packages/brand/css/*`, `tokens.json`; components.md; EXPERIENCE.md §3

## Design notes

- D7: the docs render the console's own `ui/` components at build time and share class constants for interactive parts; no new brand stylesheet, and the mockup kit is not extracted (§8.2). DOC-03a's MDX components keep their props; this package only restyles them.
- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

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
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- The docs landing and section heroes use `@polaris-key/brand/marketing.css` (display scale, tracking, eyebrow) and the service icon set (`icons/services`); article pages and tables never use display tokens. No new brand stylesheet beyond these exports. Depends on UK-58 and UK-57. (brand-33, site-07)
- CodeBlock and LanguageTabs share one anatomy with the console: filename bar, Copy with a live region and a select fallback, notes footer, logo tabs, URL state `?language=` so a docs link opens the right tab, tabs wrap at 390 px, ligatures off. (brand-33, site-07)

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] Console and portal baselines unchanged (the split is a pure move).
- [ ] A test renders each listed component in the docs build.
- [ ] `docs-classes.test.ts` (§8.5).
- [ ] Syntax-role contrast ≥ 4.5:1 on the code ground.
- [ ] `pkey-ux-reviewer` passes the rendered pages in built mode, both themes and phone (§6.3).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs test
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

The role agent sets `--set DOC-02a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-02a done`.
