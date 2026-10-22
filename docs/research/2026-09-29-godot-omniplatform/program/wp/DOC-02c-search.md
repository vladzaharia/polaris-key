# DOC-02c Search

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (site design) |
| Size        | 0.3–0.4 engineer-weeks                                                                                             |
| Depends on  | [DOC-02a](DOC-02a-shared-components.md), [DOC-03b](DOC-03b-public-access.md)                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                             |
| Role        | `pkey-implementer`                                                                                                 |
| Plan mode   | no                                                                                                                 |
| Gates       | `docs-generated`, `docs-links`                                                                                     |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Owner decision (2026-10-08): public developer docs

The developer sections (`start/`, `build/`, `features/`, `reference/`) are public (owner decision, 2026-10-08; [docs plan](../../../2026-10-08-docs/README.md) D2). Operate → Console stays member-only; Operate → Platform, Contribute and the runbook stay admin-only. Where the text below assumes members-only developer pages, this wins.

- The public bundles (Help, Developers) load without a session, and "Search all docs" shows to everyone; only the member and admin bundles are fetched behind their gates.

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-02c (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.

## Scope

**In:** The ⌘K dialog on the Pagefind JS API: merged tier bundles, grouped by door, `?q=`, code jump, Help-only default

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

console `CommandPalette`; DOC-03b's bundles

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [x] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [x] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [x] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes (dark and light rendered and contrast-measured, 7.7:1 or better for the smallest text; forced-colors and reduced-transparency rules written, not rendered; no custom product accent on this surface): dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [x] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [x] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [x] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [x] Native (kits): not applicable (a web dialog; no kit ships this). Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Corrections (verified against the code, DOC-02c build)

- The plan's per-door bundles are amended to **one public bundle with a door filter**: `pagefind`
  holds Help and the developer door, and every page carries a `door` filter
  (`data-pagefind-filter`, PageTitle.astro). "Help only" is that filter. The Help-only bundle
  `pagefind-help` (LX-help) stays for the customer host, which serves nothing else; no
  `pagefind/developers` bundle is built.
- Starlight's Pagefind UI is replaced (`components.Search`, src/components/Search.astro and
  search.ts) and the `pk-help-search-bundle` Vite rewrite is gone; the dialog speaks to the JS API.
- The reader's tier comes from `/manage/api/me` (`permissions.platform.view`: `docs` is admin,
  `console` is member), asked only when the dialog opens on the console host. The customer host is
  detected by a `redirect: "manual"` probe of the public bundle (an opaque redirect).
- The code jump reads `/docs/help/codes.json` (src/pages/help/codes.json.ts), a public file under
  `help/`, fetched only when the query looks like a message id.

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [x] The common definition of done in the docs plan §6.3 holds.
- [x] Keyboard-only test.
- [x] A gated bundle is never fetched without a session.
- [x] The bundles are nested (public in member in admin): load exactly one bundle per tier, the highest the reader can fetch, and never `mergeIndex` them (a merge returns each public page twice). The "Help only" default is a filter on that bundle (the public bundle also holds the developer door). Carried from the DOC-03b review.
- [x] The plan's per-door bundles (`pagefind/help`, `pagefind/developers`) are built, or the plan is amended to one public bundle with a door filter.
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

The role agent sets `--set DOC-02c in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-02c done`.
