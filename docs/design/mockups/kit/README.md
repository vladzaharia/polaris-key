# Mockup kit

One stylesheet, `mockup.css`, draws every mockup screen: the console, the customer portal,
terminal output, SDK code and in-app UI kits. It carries the brand tokens from
`packages/brand/css`, Rubik and JetBrains Mono as `data:` fonts, and the console's lucide icons, so
a screen needs no other file and makes no request.

To see every component in both themes and at all four sizes, render the gallery:

```sh
mise exec node@22 -- node tools/mockups/shoot.mjs --gallery --out /Users/vlad/Repos/pk-wt/_mockups/shots/kit
```

`kit/gallery.html` is also the place to copy markup from. Every snippet below is in it.

## Rules

- **Kit classes first.** Draw with the classes on this page. A screen may add a `<style>` block,
  scoped as `[data-screen="<id>"] .thing`, for what the kit doesn't cover. Colours in it come
  from tokens (`var(--pk-*)`, `var(--mk-*)`), never hex values, so both themes work.
- **No spacing in screens.** A screen never sets `margin`, `padding` or `gap`: not in a
  `style=""` attribute, not in its `<style>` block. Spacing comes from the primitives and
  components in "Spacing and layout" below. If a layout needs a spacing the kit doesn't have, add
  the primitive to `mockup.css` (on the scale, documented here) and use it.
- **Both themes.** The renderer sets `data-theme="dark"` or `"light"` on `<html>`. Dark is the
  brand default. Never style for one theme only.
- **Four sizes, and every screen adapts to each** (the owner, 2026-10-08). `shoot.mjs` renders
  wide 1920×1080, desktop 1440×900, tablet 1024×768 and phone 390×844, dark and light; look at all
  eight. A screen doesn't just shrink or barely fit:
  - **Wide, 1600px and up:** use the width. `.page.columns` puts secondary blocks (activity,
    setup) in a 400px aside beside the main column; `.page` caps at 1760px; prose caps at 72ch, so
    no line of text stretches.
  - **Desktop, 1280–1599px:** as drawn, 240px sidebar, 32px gutters.
  - **Tablet, 1024–1279px:** the sidebar is the console's 56px icon rail (AppShell defaultRail), so
    a 1024 screen has 920px of content; grids drop a column.
  - **640–1023px:** the sidebar folds into the menu button.
  - **Phone, under 640px:** everything stacks.
  - Device-code, QR and activation screens go side by side in landscape and stack in portrait
    (`.kit-split`).

  The body is a size container named `screen`, and every `.card` is a size container too. In a
  screen's own style block use `@container screen (…)` for the page and `@container (max-width:
559px)` for a row inside a card, never `@media`.

- **Weights.** 400 body, 500 labels, buttons, tabs, nav and row titles, 600 headings, titles and
  values; never 700 (BRAND §1.6, DL12, lead decision B7). Radii: controls 6px, tiles 10–14px,
  cards 18px, pills fully round.
- **Pills mean attention.** A pill is an issue or a neutral fact, always with an icon or a dot. A
  healthy state is `.status` text, never a pill (ADMIN.md §5.11).
- **Accent.** `data-service` on any element re-points the accent (`--pk-accent*`) and the service
  glyph for its subtree: `core`, `license`, `config`, `release`, `distribution`, `update`,
  `identity`, `sync`, `commerce` (commerce takes the Distribution green and the shopping-bag glyph,
  B1). Inside `[data-service="commerce"]` `.link` and `.btn.link` are drawn in the strong text
  colour, because that green is close to the success green: the accent stays on chrome only.
  **The accent marks context and interaction, never an action or a status** (B2, B17): the canvas
  rule, the selected nav marker, the orientation chip and the masthead tile, links, and every
  focus ring, hover tint, checked control and selection, each in the accent of the service it
  references (see "Interaction follows the service" below). The one filled primary is ink; danger
  stays red. Text and thin edges in the accent use `--pk-accent-fg` (the light theme's text-safe
  step), fills, rings and rules `--pk-accent`, tints `--pk-accent-subtle`.
- **Ship builds is one identity** (B5): Releases, Release tracks, Rollouts, Channels (and each
  channel), Packages, Updates and Health all take `data-service="release"` (the Package glyph,
  Release cyan) on the console, the nav group and every dialog they open. No per-page green or
  tangerine accent inside it; Distribution green stays on Commerce surfaces. Cloud Sync, a
  one-page feature, is one nav row (`.nav-group.single`).
- **Nothing glows** (B6): no gradient, glow, wash or coloured shadow in product chrome, no section
  numerals (a number marks a real order only: wizard and setup steps), no uppercase transform on
  a label, a table head, an id or a name. Product-owned art (covers, icons, save thumbnails) is
  exempt.
- **Content.** Real names only: Polaris Key (the system product), DJDL and Diceroll; people on
  `example.com`; dates in October 2026. No lorem ipsum. Copy follows EXPERIENCE.md, ADMIN.md and
  PORTAL.md, in the words of the consolidation glossary.
- **Say it once, and briefly** (the owner, 2026-10-08: "be careful with verbosity and duplication
  of content on a page or in a section").
  - Each fact appears once per page, where it is most useful. No sub-line repeats a count shown
    in a card, the sidebar or a tile; no tile repeats a list; no table column repeats the row
    title or another column; a status lives in one cell, not also in a sentence beside it.
  - No sentence that narrates the layout ("below", "on the right") or the mechanism; say the
    outcome in the reader's terms. No subtitle that restates the title, no "This page shows…".
  - One sentence where one will do. A meta line carries one or two facts. Helper text only where
    it changes what the person does next. Empty, error and dialog states: one sentence of what
    happened and one of what to do.
  - The owner's examples: "Tiers, licenses and device limits, starting with the Free tier below."
    → "Tiers, licenses and device limits". "Needs Licensing, which is chosen" → "Needs Licensing".
    "Your license covers versions released until Sep 30, 2026. 4.1.3 is the newest of those, and
    it keeps working." → "Your license covers versions in 4.1.x, the latest of which is 4.1.3".
  - Remove repetition and padding words, never information the screen needs to do its job.
  - **No explainer subtitles** (the owner, 2026-10-09: "remove all extraneous comments or
    subtitles"). A card, section, dialog or drawer heading stands alone: "Anyone with the key"
    loses "No email or account: whoever enters the key gets the license on that device." A
    sub-line stays only when it carries a fact the reader needs to decide (a limit, a unit, a
    source, a consequence). If the heading reads ambiguous alone, tighten the heading instead of
    keeping both. The same holds for page ledes, field hints that restate the label, captions that
    narrate the frame, and "You can…" or reassurance lines. Kept: labels, errors, statuses, the
    consequence line before a destructive action, metadata, catalog strings and the one short
    empty-state sentence.
  - **One fact per line** (the owner, 2026-10-09). A line that packs facts together with commas,
    "and", "too", semicolons, "·" or parentheses (a limit plus a behaviour, a status plus a
    consequence plus a count) is rewritten and split: each fact its own short line, label and
    value row, or hint, where the reader needs it. "Keys the game adds itself sync too, up to 256
    keys and 64 KiB per player" → "Keys the game adds itself also sync", then "Keys per player: up
    to 256" and "Size per player: up to 64 KiB". A meta line of plain values (an email and a date)
    stays one line.

## Brand v2 (lead decisions B1–B16, 2026-10-09)

The kit was re-skinned once to the brand and transition decisions (`_brand/DECISIONS.md`); every
screen inherits it. Our mockups, DL1–DL18 and the owner's notes win over the Transition Guide's
pictures; the guide is a reference edition. What changed, and the classes that draw it:

| Decision         | What a screen gets                                                                                                                                                                                                                                            | Classes                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| B2 ink primary   | the one filled primary is `--mk-action` ink (light: #060912 / white; dark: #f6f8ff / #060912); danger stays red; selections follow the service (B17)                                                                                                          | `.btn.primary`                                                                                              |
| B3 nav           | the selected item is the accent's subtle fill with a 3px marker; group labels neutral with a 3px accent bar; a one-page feature is one row                                                                                                                    | `.nav-item.active`, `.nav-label`, `.nav-group.single`                                                       |
| B4 canvas        | `.console > .main` is the raised canvas: radius 18, hairline, 3px rule in the console's `data-service`, inset 16 from the window's end and bottom from 1024px, full-bleed below; the sidebar is one viewport tall with its foot pinned and its list scrolling | (automatic)                                                                                                 |
| B4 masthead      | one orientation line (chip + crumbs), h1 36/44 or 32/40 (`.is-record`), the 48px tile on landing and product pages from 1024px                                                                                                                                | `.crumbs`, `.crumb-chip` (`.product`, `.platform`), `.page-head.is-record`, `.page-icon.mast`, `.mast-tile` |
| B4 bands         | card heads on `--mk-band`, dialog and drawer heads on `--mk-band-overlay`, a hairline under each; no numerals                                                                                                                                                 | `.card-head`, `.dialog-head`, `.drawer-head`                                                                |
| B4 workbench     | filters and table in one bordered container; 56px rows; the table a labelled focusable region with its first column pinned from 640 to 1279                                                                                                                   | `.workbench` > `.toolbar` + `.table-card[role=region]`                                                      |
| B4 overlays      | 3px rule on dialogs and drawers (none on `.danger` / `.caution`), one leading glyph, titles ≤ 20/28, blurred scrim with a reduced-transparency fallback                                                                                                       | `.dialog`, `.drawer`, `.overlay`                                                                            |
| B5 Ship builds   | Releases, Release tracks, Rollouts, Channels, Packages, Updates, Health: `data-service="release"` on the console, the group and the dialogs; no `update` or `distribution` accent in the console                                                              | `areas.json` (distribution and packages are `release`)                                                      |
| B6 nothing glows | no wash, glow, gradient or coloured shadow in chrome; no text under 12px; no uppercase transform on labels; annotation pins and rating stars neutral                                                                                                          | `.eyebrow` is 13/20 500 sentence case                                                                       |
| B7 weights       | 400 body, 500 labels/buttons/tabs/nav/row titles, 600 headings and values; no 700 left in the kit                                                                                                                                                             | (automatic)                                                                                                 |
| B8 hosted card   | a neutral header strip; the passport in a landscape window ≥ 960px; equal Allow/Deny; neutral refusals; white provider buttons in light                                                                                                                       | `.hosted-card.passport`, `.hosted-art`, `.hosted-actions.equal`, `.hosted-callout`, `.code-entry`           |
| B12 portal       | display h1 48/52 (32/36 phone); the focused task frame (identity row, centred column, two columns on a short desktop)                                                                                                                                         | `.portal-page.task`, `.task-frame`, `.task-aside`, `.task-main`, `.identity-row`, `.hash-row`               |

**Masthead tile allow-list** (lead answer 3, round 2): one 48px tile per service, on its landing
page only, from 1024px: Cloud Sync; Catalog (its read and Edit states); Channels (Ship builds);
Packages; App sign-in; Commerce's first run and Storefronts. A product's own Core pages
(Overview, Integration, Access, Devices, Users, Activity, Settings) carry the product's icon. Never
on a workbench or list (Licenses, Tiers, Offers, Purchases, Release tracks, Releases, Rollouts,
Updates, Members), a record, a wizard step or a dialog.

**Round 2 (UX review FIX-FIRST)** adds: the accent never encodes a state (changed rows and fields,
overrides, "new" marks, recommendations, timeline dots, meters, info pills are ink or neutral;
status keeps success, warning and danger; selections and focus follow the service since B17);
`--mk-action` aliases `--pk-action-neutral` with hover, pressed and disabled steps;
`:focus-visible` draws the ring on every control; tables
at tablet widths take `--table-min` (860px) and scroll in a labelled region with a pinned first
column; the sidebar rests on its active item; `.art.noart` (a large icon on the stored tint),
`.hosted-row.choice-row`, `.item-row.profile`, `.label-wide` (a toolbar button's word from 1600px)
and `.task-title`. `check.mjs` also asserts: no table wider than twice its scroll region, no button
label overflowing its box, the active sidebar item inside the sidebar's viewport, no text under
12px and no weight 700.

Also new: `.page.columns.split` (Home: attention 2/3 beside Platform ready 1/3 from 1280px),
`.product-card > .art.banner` (`.flat` for the stored tint), `:is(.mk-grid-2, .mk-grid-3).top`
(cards keep their own height), `.docs-doors`, the opt-in `portrait` size (834×1194) in
`shoot.mjs` and the page, and `tools/mockups/check.mjs` (sideways scroll at 13 widths from 320 to
2560, axe at 390/1024/1440/1920 in both themes, and the spacing rule). Screen-level spacing that
predated the rule now lives in the kit, scoped to its screen, at the end of `mockup.css`.

The copy pass and the owner's notes (2026-10-09) added: `.choice[data-service]` (a feature card
edged in its feature's accent; chosen, the tint, the 2px edge and the tick), a search placeholder that ends in
an ellipsis, the device-following `.ua-desk` / `.ua-phone` actions for every portal tile, an empty
collection (a page head, then one empty-state card) centred across and down the canvas, an empty
portal page's following strip at its foot, a `.hosted-callout` sentence per line, a 72px
`.card-head.h56.sub` only while its subtitle is there, and `.hint-slot` reserving nothing in one
column. The published page now renders each frame with its `data-screen`, so screen-scoped rules
apply there as they do in `shoot.mjs` and `check.mjs`.

## Interaction follows the service (owner rule B17, 2026-10-09)

"Focus, active, hover, checked, border and accent follow the service they are referencing." The
nearest `data-service` decides; the kit draws every state from it, so a screen only puts the
attribute on the right element:

- **Where.** The page root (`.console`, `.board`, `.hosted`, `.portal`), each sidebar group, and in
  a page any row, card, chip, field group, section, dialog or drawer whose subject is one other
  service's object (a Config row in a mixed list is config yellow; a release-track picker in a tier
  is release cyan). The console's top bar and sidebar are `core`; platform pages, the portal and
  the hosted pages are `core`. Never `update` or `distribution` in product chrome (B5).
- **What follows it.** The focus ring (`--pk-focus` is `--pk-accent`), the hover tint (`--mk-hover`,
  the subtle tint), checked controls (`.check`, `.radio`, `.switch`, `.segmented`, `.tab`, `.chip`,
  `.filter`, `.choice`, done `.step`s), selections (`.nav-item.active`, `.list-nav-item.active`,
  `.toc-nav .on`, `tr.selected`, `.item-row.marked[aria-current]`, `.card.selected`, `.pick-tile`,
  `.role-tile`, `.jump-nav`, `.hosted-row.choice-row`, the portal's phone bar), context rules and
  accent marks. Fills and rings `--pk-accent`, text and 1px edges `--pk-accent-fg`, tints
  `--pk-accent-subtle`.
- **What does not.** Status (success, warning, danger, info, signed) keeps its tone and never takes
  a service accent; the one filled primary stays ink; unsaved, override, "new", "next" and
  "recommended" marks stay ink (B2); the links inside commerce and config pages stay strong text
  (green and gold read as status); in-app UI kit frames keep `--kit-accent` (DL13).
- **Cue.** A selected or checked state never rests on colour: a check, the radio's ring, the knob's
  side, a 3px bar, a 2px edge or a label says it.
- **Checked.** `check.mjs` (B17 audit, 390 and 1440, both themes): each checked, selected, active
  and focused element paints its state in its nearest service's accent (base or `-fg`), never in
  ink; no status element paints a service accent; rings, edges and bars at least 3:1 against what
  they sit on and accent text 4.5:1. `--contrast-report` prints the lowest ratio per theme,
  service and kind.

## Tokens

| Group      | Tokens                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ------- | ----- | --------------------------------------------------------------- |
| Surfaces   | `--pk-surface-page` `-raised` `-sunken` `-overlay`                                                                                                         |
| Text       | `--pk-text-strong` `-default` `-muted` `-subtle` `--pk-text-on-accent`                                                                                     |
| Lines      | `--mk-line` (hairlines), `--pk-border-strong` (controls)                                                                                                   |
| Tone       | `--pk-success` `--pk-warning` `--pk-danger` `--pk-info`, each with `-subtle` `-border` `-on`; `--pk-signed*`                                               |
| Accent     | `--pk-accent` `-fg` (text on the page) `-on` (text on the accent) `-subtle`; per service `--pk-service-<name>` with the same suffixes                      |
| Kit only   | `--mk-fill` (hover, secondary button), `--mk-fill-strong`, `--mk-card-shadow`, `--mk-pop-shadow`, `--mk-scrim`, `--mk-code-*`, `--mk-syn-*`, `--mk-term-*` |
| Type       | `--pk-font-sans`, `--pk-font-mono`                                                                                                                         |
| Radius     | `--pk-radius-sm` `-md` `-lg` `-xl` `-full`                                                                                                                 |
| Elevation  | `--pk-elevation-1` … `-3`                                                                                                                                  |
| In-app kit | `--pk-kit-*` and the platform presets `data-pk-platform="ios                                                                                               | macos | android | windows | gnome | godot"`(packages/brand/css/kit.css) for`surface: "kit"` screens |

## Spacing and layout

One spacing scale, one page rhythm, one card inset, one row height per density, one media column.
`products.overview` and `products.home` are the reference screens: they set no spacing of their
own, and they show every size.

### The scale

A 4px base. Every `margin`, `padding` and `gap` in `mockup.css` is one of these tokens (or `0`,
`auto`, or a 1px hairline overlap); nothing in the kit is off the scale.

| Token      | px  | Use                                                                      |
| ---------- | --- | ------------------------------------------------------------------------ |
| `--sp-0-5` | 2   | Micro, inside a control only (segmented, nav list). Never between blocks |
| `--sp-1`   | 4   | A title to its one-line text; icon to label in a pill or filter          |
| `--sp-2`   | 8   | Icon to label (16px glyphs); label → control → help; buttons in a row    |
| `--sp-3`   | 12  | Items in a row (avatar → text); crumbs → title                           |
| `--sp-4`   | 16  | Cards in a grid; section title → content; card head and band padding     |
| `--sp-5`   | 20  | Tile padding (stats, product cards); fields in a form                    |
| `--sp-6`   | 24  | Card inset (`--card-px`, `--card-pad`); dialog padding                   |
| `--sp-8`   | 32  | Between page sections (`--section-gap`); page gutter                     |
| `--sp-10`  | 40  | Between two meters side by side; empty-state padding                     |
| `--sp-12`  | 48  | Board padding                                                            |
| `--sp-16`  | 64  | Page bottom                                                              |

Negative space is `calc(-1 * var(--sp-N))`; a hanging indent is the glyph plus its gap, e.g.
`calc(var(--card-media) + var(--sp-3))`; centring a box on a line is computed from the two, e.g.
`calc((var(--lh-section) - var(--card-media)) / 2)`. A strip's 1px gap is a hairline.

### Layout tokens

| Token                    | Wide    | Desktop | Tablet  | Phone   | What it sets                                                                |
| ------------------------ | ------- | ------- | ------- | ------- | --------------------------------------------------------------------------- |
| `--sidebar-w`            | 240     | 240     | 56      | 0       | The console sidebar (tablet: the icon rail; phone and 640–1023: the drawer) |
| `--page-max`             | 1760    | 1760    | 1760    | 1760    | The widest `.page` gets; it centres beyond that                             |
| `--aside-w`              | 400     | –       | –       | –       | The aside column of `.page.columns`                                         |
| `--page-gutter`          | 32      | 32      | 24      | 16      | `.page` side padding (24 from 640 to 1279)                                  |
| `--page-top` / `-bottom` | 32 / 64 | 32 / 64 | 32 / 64 | 20 / 40 | `.page` top and bottom (top 24 from 640 to 1023)                            |
| `--section-gap`          | 32      | 32      | 32      | 24      | Between page-level blocks, and between main and aside                       |
| `--section-head-gap`     | 16      | 16      | 16      | 12      | A section title to its content                                              |
| `--grid-gap`             | 16      | 16      | 16      | 12      | Between cards and tiles in a grid                                           |
| `--card-px`              | 24      | 24      | 24      | 16      | A card's inline edge: head, body, rows, table cells, foot                   |
| `--card-pad`             | 24      | 24      | 24      | 16      | A card body's padding (`.card.compact`: 16)                                 |
| `--card-media`           | 28      | 28      | 28      | 28      | The one media column: task marks, list avatars, row tiles, head tiles       |
| `--tile-pad`             | 20      | 20      | 20      | 16      | Stat tiles and product cards                                                |
| `--row-h`                | 56      | 56      | 56      | 56      | Table rows, list rows, attention rows, card rows                            |
| `--row-h-compact`        | 40      | 40      | 40      | 40      | `.table.compact`, `.list.compact`                                           |
| `--row-h-head`           | 40      | 40      | 40      | 40      | Table header (56 when it holds a `.meter-head`)                             |

The values per size come from the tokens changing (`@container screen`), so no component has its
own padding per size.

### Four sizes: how the primitives reflow

| Primitive             | Wide ≥ 1600                               | Desktop 1280–1599 | Tablet 1024–1279                                                                 | Phone < 640                                                                          |
| --------------------- | ----------------------------------------- | ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Console frame         | 240 sidebar                               | 240 sidebar       | 56px icon rail (words hidden, 40×40 items, a feature group is its service glyph) | menu drawer (also 640–1023)                                                          |
| `.page`               | `.columns`: main + 400 aside; max 1760    | one column        | one column                                                                       | one column                                                                           |
| `.page-head`          | one line                                  | one line          | one line                                                                         | title row + its one icon action; freshness under the h1; each text action full width |
| `.mk-tiles`, `.stats` | min 200, a short last row fills           | same              | same                                                                             | two up, a short last row fills                                                       |
| `.stats.strip`        | one row of cells (min 160)                | one row           | one row at 920                                                                   | 56px rows                                                                            |
| `.product-cards`      | min 300 (three at 1184)                   | three             | two plus one                                                                     | one column, pips beside the name                                                     |
| `.mk-grid-N`          | N                                         | N                 | N (`-4`: two below 1024)                                                         | one column                                                                           |
| Rows in a card        | stacked in the aside (a card under 560px) | one line          | one line, text wraps                                                             | stacked                                                                              |

**Narrow cards.** A `.card` is a size container. Under 560px of card width (the 400px aside, a
half-width grid cell, a drawer, a phone) its rows take their stacked layouts with no screen code:
attention rows stack, a list row's time drops 4px under its text, a task's action drops under its
text, `.table.stack-phone` stacks behind 80px `.cell-label`s, a `.stats.strip` becomes 56px rows,
and a card head's action drops under the title. `.show-narrow` / `.hide-narrow` show or hide an
element at the same point (a band that replaces a table header's counts).

### Primitives: which to use where

```html
<div class="page">…</div>
<!-- the page container: gutters, --section-gap between children, max 1760 -->
<div class="page columns">
  …
  <section class="card aside span-2">…</section>
  …
</div>
<!-- wide: main + aside -->
<section class="section">
  <!-- a titled group: head, then content --section-head-gap below -->
  <div class="section-head">
    <div>
      <h2>Features</h2>
      <p>…</p>
    </div>
    <a class="btn link" href="#">Manage features</a>
  </div>
  …
</section>
<div class="mk-stack-4">…</div>
<!-- a column: 1 2 3 4 5 6 8 10 12 -->
<div class="mk-cluster">…</div>
<!-- a wrapping row, gap 8; -1 -3 -4 -6; .baseline; .no-wrap -->
<div class="mk-split">
  <div>title block</div>
  <div>actions</div>
</div>
<!-- first baselines aligned; .center -->
<div class="mk-tiles">…</div>
<!-- equal tiles, min --tile-min (200); .wide (300); 2-up on phone -->
<div class="mk-grid-2">…</div>
<!-- fixed columns: -2 -3 -4; one column on phone -->
```

- **Page:** `.page` > `.page-head`, then cards and sections. Never put a wrapper with its own
  margin between them: the page gap is the only vertical rhythm at that level.
- **Wide:** `.page.columns`. Below 1600px nothing changes (one column, source order is the narrow
  order). At 1600 and up the head spans both columns, every block sits in the main column, and a
  block marked `.aside` goes to the 400px right column and spans the blocks beside it (`.span-2`,
  `.span-3`, `.span-4`). The aside takes secondary blocks (Recent activity, Platform ready), never
  the page's most urgent one, and stays the shorter column.
- **Inside a card body:** `.mk-stack-4` for blocks, `.mk-stack-2` for a label over its value,
  `.mk-cluster` for chips, facts and buttons. A card part (`.card-head`, `.card-body`,
  `.card-body.tight` for a band, `.card-rows`, `.table`, `.card-foot`) already pads to
  `--card-px`; don't pad inside it again.
- **A title with its count, slug or status:** `.mk-cluster.baseline` (or `.page-heading`, which
  baseline-aligns a `.slug`).
- **A heading with actions on the right:** `.section-head` for sections, `.card-head` for cards,
  `.mk-split` anywhere else.
- **Tiles:** `.stats` for stat tiles, `.product-cards` for product cards, `.mk-tiles` for
  anything else equal-sized.
- **Rows:** a table (`.table`) when cells line up in columns; `.list-row` for avatar · text ·
  time; `.attn-row` for attention; `.setting-row` for text · control; `.card-row` for anything
  else. All take `--row-h`.

### Components on the scale

| Component    | Spacing                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page header  | the orientation line (chip + crumbs, 20 high) 12 above; title row 44px (40 on a record); description 8 below; `.page-icon` (the 48px masthead tile from 1024px) spans both; actions gap 8; at most 140px on a collection and 176px on a record at 1440 |
| Section      | title (18/24) → content 16; title → its description 4                                                                                                                                                                                                  |
| Card         | head 16 × 24 (56 high); body 24; `.tight` band 16 × 24; rows 8 × 24, min 56; foot 12 × 24; hairlines between parts. A count sits 8 after the title; the head's right side holds actions only                                                           |
| Media column | 28 (`--card-media`): task marks (20, centred), list avatars, row tiles, head tiles. Text after it starts at card-px + 28 + 12                                                                                                                          |
| Table        | header 40 (56 with a `.meter-head`); rows 56 (compact 40); cells 8 × 16, first and last cell 24 to line up with the card head                                                                                                                          |
| Stat tile    | padding 20; label (13/20) → value (24/32) 8; value → meta (12/16) 4                                                                                                                                                                                    |
| List row     | 28px avatar or icon · 12 · text · trailing meta; min 56                                                                                                                                                                                                |
| Form field   | label → control 8 → help 8; fields 20 apart (`.form`)                                                                                                                                                                                                  |
| Dialog       | head 24 (close button 16 from the corner); body 12 under the title, 24 sides and bottom; foot 16 × 24                                                                                                                                                  |
| Pill / count | 24 high, 8 sides, icon 4 from the word (`.sm` 20 high); tone counts are filled subtle chips                                                                                                                                                            |
| Links        | `.link` and `.btn.link` have a 24px hit height (a link inside a sentence keeps the line's)                                                                                                                                                             |
| Status words | 16px glyph, 8 to the word; a meta line under it hangs at 24 (`.status-stack`)                                                                                                                                                                          |
| Controls     | 36 high (`.sm` 32, `.xs` 28); 16 sides (`.sm` 12, `.xs` 8); icon 8 from the label; in a toolbar the field is 32, like the facets                                                                                                                       |

### Type scale

| Step  | Size / line                                                          | Weight                                                 | Where                                                                                                                                               |
| ----- | -------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page  | 36/44 collection, 32/40 record (`.page-head.is-record`), phone 24/32 | 600, -0.02em                                           | `.page-head h1`, `.type-page`; two lines at most, then an ellipsis (the console never uses a display size)                                          |
| Block | 18/24                                                                | 600, -0.01em                                           | Every page-level block title: `.section-head h2`, the h2 of a card straight on `.page` (or in its aside), dialog and wizard titles, `.type-section` |
| Stat  | 24/32                                                                | 600                                                    | `.stat-value`                                                                                                                                       |
| Card  | 16/24                                                                | 600                                                    | A nested card's title (in a section, grid, drawer or card), product card titles, `.type-card`                                                       |
| Body  | 14/20                                                                | 400 (600 for emphasis; 500 for a row title or a label) | Everything else, `.type-body`                                                                                                                       |
| Small | 13/20                                                                | 400                                                    | Descriptions, hints, cell subs, status words, `.type-small`                                                                                         |
| Meta  | 12/16                                                                | 400                                                    | Times, versions, counts, `.meta`, `.type-meta`; `.eyebrow` (a label over a block in a card) is 13/20 500, sentence case                             |
| Mono  | 13/20                                                                | 400                                                    | Ids, slugs in headings, code, `.type-mono`                                                                                                          |

Tokens: `--fs-page` `--lh-page`, `--fs-section` `--lh-section`, `--fs-card`, `--fs-stat`,
`--fs-body`, `--fs-small`, `--fs-meta`, `--fs-mono` (each with its `--lh-*`). **Peers share a step;
only nesting steps down.** Needs attention, Integration, Features and Products are peers on a page,
so they all title at 18/24; a card inside a section titles at 16/24. Prose caps at 72ch at every
size (`.card-head p`, `.section-head p`, `.callout-text`, `.empty p`, `.task-desc`, `.setting-desc`).

### Checking a screen

Render all four sizes and open the eight PNGs (`shoot.mjs` defaults to wide, desktop, tablet and
phone, dark and light).

```sh
# spacing written by a screen (should print nothing)
grep -nE 'style="[^"]*(margin|padding|gap)' docs/design/mockups/screens/<area>/*.html
grep -nE '^\s*(margin|padding|gap|row-gap|column-gap)[a-z-]*\s*:' docs/design/mockups/screens/<area>/*.html
```

## Layout and text utilities

The older helpers, on the same scale. New screens use the primitives above.

```html
<div class="row gap-2">…</div>
<!-- flex row, centred; .top .wrap .between -->
<div class="stack gap-3">…</div>
<!-- flex column -->
<div class="grid cols-3">…</div>
<!-- .cols-2 .cols-3 .cols-4 .auto (one column on phone) -->
<span class="grow"></span> <span class="ml-auto"></span>
<span class="mt-4"></span> <span class="muted small">Updated 1 min ago</span>
```

Gaps `.gap-0` `-1` `-2` `-3` `-4` `-6` `-8` (0–32px); margins `.mt-1` … `.mt-6`. Text `.strong`
`.muted` `.subtle` `.accent` `.text-success` `.text-warning` `.text-danger` `.bold` `.small` `.xs`
`.lg` `.mono` `.tnum` `.nowrap` `.truncate` `.center` `.right` `.sr-only`. `.hide-phone` and
`.show-phone` switch at 640px. `<code>` in prose and `<kbd>⌘K</kbd>` are styled.

## Icons and identity

```html
<i class="ic ic-key-round"></i>
<!-- 16px, currentColor; .xs .sm .lg .xl .xxl -->
<i class="svc" data-service="license"></i>
<!-- the service glyph in its accent; .sm .lg .xl -->
<i class="pk-mark"></i>
<!-- the Pinned K for the theme; .sm .lg -->
<span class="logo" data-product="djdl"></span>
<!-- product tile: djdl, diceroll, polaris-key -->
<span class="logo">T</span>
<!-- any other product: a monogram; .xs .sm .lg .xl -->
<div class="art" data-product="diceroll"></div>
<!-- portal cover art, 16:7 -->
<span class="avatar">MF</span>
<!-- .sm .lg .violet -->
```

`.svc` reads `data-service` from itself or any ancestor. Service glyphs: license key-round, config
sliders-horizontal, release package, distribution the Star Cut, update circle-arrow-up, identity
user-round, sync cloud, commerce shopping-bag. `ic-boxes` draws packs on marketing and docs pages
only; the console has no packs service (packs live under Releases, in Ship builds).

Platform and store marks: `ic-apple` `ic-windows` `ic-linux` `ic-android` `ic-steam` `ic-itch`
`ic-godot` `ic-app-store` `ic-google-play` `ic-microsoft-store`; brand: `ic-polaris` `ic-star-cut`.

Lucide icons (the console's set, so a mockup draws the glyph the built screen will): house boxes
box package package-check package-open key-round key key-square sliders-horizontal
sliders-vertical circle-arrow-up user-round users user-plus cloud cloud-upload cloud-download store
shopping-bag plug shield shield-check badge-check settings activity smartphone monitor laptop
layers git-branch git-pull-request git-commit-horizontal github search command book-open moon sun
chevron-down chevron-right chevron-left chevron-up chevrons-up-down arrow-right arrow-left
arrow-up-right arrow-down arrow-up external-link plus minus x check circle-check circle-check-big
circle circle-dot circle-plus circle-minus triangle-alert info circle-x ban clock circle-pause
refresh-cw copy download upload trash-2 pencil ellipsis ellipsis-vertical list-filter columns-3 eye
eye-off lock lock-open fingerprint mail globe link square-terminal terminal code-xml file-text
file-json file-code-2 file-lock folder inbox bell log-out panel-left-close panel-left-open menu
gamepad-2 disc-3 headphones music audio-waveform dice-5 rocket sparkles zap wand-sparkles server
database cpu wifi-off hourglass calendar calendar-clock timer repeat receipt credit-card wallet tag
ticket gift coins badge-percent circle-dollar-sign chart-line chart-column list list-checks
layout-grid table grip-vertical history send at-sign building-2 id-card qr-code archive puzzle
crown award flag toggle-right circle-help loader-circle image palette app-window workflow webhook
map-pin languages truck hammer wrench scroll-text layout-dashboard blocks monitor-smartphone
users-round lock-keyhole list-tree file-pen file-stack stamp waypoints grid-3x3 flask-conical
trending-up square-pen heart-pulse rss log-in server-cog gauge plug-zap arrow-right-left
circle-dashed git-merge user-check clipboard-check square wifi signal battery-full star.

Need another? Add its lucide file name to `LUCIDE_ICONS` in `tools/mockups/build-kit.mjs` and run
`mise exec node@22 -- node tools/mockups/build-kit.mjs`.

## Console frame

```html
<div class="console" data-service="core">
  <header class="topbar">
    <button class="btn ghost icon menu-btn" aria-label="Menu">
      <i class="ic ic-menu lg"></i>
    </button>
    <a class="brand" href="#"
      ><i class="pk-mark"></i><span>Polaris Key</span></a
    >
    <div class="topbar-search">
      <i class="ic ic-search"></i><span>Search or jump to…</span><kbd>⌘K</kbd>
    </div>
    <a class="topbar-link" href="#"><i class="ic ic-book-open"></i>Docs</a>
    <button class="btn ghost icon theme-btn" aria-label="Theme">
      <i class="ic ic-moon"></i>
    </button>
    <span class="avatar violet">AL</span>
  </header>
  <nav class="sidebar" aria-label="DJDL">
    <div class="ctx">
      <span class="logo sm" data-product="djdl"></span>
      <span class="ctx-text"
        ><span class="ctx-name">DJDL</span
        ><span class="ctx-sub mono">djdl</span></span
      >
      <i class="ic ic-chevrons-up-down"></i>
    </div>
    <a class="nav-item active" href="#"
      ><i class="ic ic-layout-dashboard"></i
      ><span class="nav-text">Overview</span></a
    >
    <div class="nav-group" data-service="license">
      <button class="nav-label" aria-expanded="true">
        Licensing<i class="ic ic-chevron-down sm"></i>
      </button>
      <a class="nav-item" href="#"
        ><i class="ic ic-key-round"></i><span class="nav-text">Licenses</span
        ><span class="count">240</span></a
      >
    </div>
    <div class="sidebar-foot">
      <a class="nav-item" href="#"
        ><i class="ic ic-settings"></i><span class="nav-text">Settings</span></a
      >
    </div>
  </nav>
  <main class="main"><div class="page">…</div></main>
</div>
```

- **Contexts (ST-45).** Platform: `.ctx` with `<span class="ctx-mark"><i class="ic ic-polaris"></i></span>`,
  "Platform", "3 products"; then Home, Members, Connections, Settings, Packages, Status, Activity.
  Product: the product's `.logo.sm`, name and slug; Overview, Integration, Access, Devices, Users,
  Activity, then one `.nav-group[data-service]` per enabled feature (`.closed` folds it to its
  label), Settings last in `.sidebar-foot`.
- A feature group's `.nav-label` is a `<button aria-expanded>`, 32px high, its chevron at the end:
  muted, sentence case, 13/20 500, no icon (a section header carries none); the 3px service bar is
  its only colour. A one-page feature (Cloud Sync) is one row: `<div class="nav-group closed single"
data-service="sync"><a class="nav-label" href="#">Cloud Sync</a></div>`, `.active` when open.
- The selected item (`.nav-item.active`) is the subtle accent fill with a 3px accent marker on its
  start edge, 500 (B3); never a solid accent pill. A count keeps its own status colour inside it.
- No "Workspace" label above the context switcher (it says Platform or the product already).
- `.sidebar-foot` sticks to the bottom of the first viewport, as in the console.
- Tablet (1024–1279): the sidebar is the 56px icon rail, drawn from the same markup. The words
  hide (they stay the accessible names), the context header is its logo, each item is a 40×40
  target with its tooltip, and each feature group draws as its service glyph.
- `.page.narrow` (960px) and `.page.form` (760px) cap the width. `.env` / `.env.dev` is the
  environment tag in the top bar. `.nav-sep` is a divider.
- Below 1024px the sidebar is hidden and the menu button shows. To draw the open drawer, add
  `.nav-open` to `.console`. On phone the brand keeps its name for screen readers.

## Page header

```html
<header class="page-head">
  <nav class="crumbs">
    <a href="#">Diceroll</a><i class="ic ic-chevron-right"></i>Offers
  </nav>
  <div class="page-heading">
    <h1>Licenses</h1>
    <span class="count">240</span>
  </div>
  <!-- No .page-sub by default. A subtitle is allowed only for live state shown nowhere else on
       the page (EXPERIENCE §2), never to repeat a count, a status or the title. -->
  <div class="page-actions">
    <span class="freshness">Updated 1 min ago</span>
    <button class="btn ghost icon" aria-label="Refresh, updated 1 min ago">
      <i class="ic ic-refresh-cw"></i>
    </button>
    <button class="btn primary"><i class="ic ic-plus"></i>New license</button>
  </div>
</header>

<!-- the orientation line leads every console page head (B4): a chip that names the context once
     (a feature's glyph, the product's icon on its own pages, the Pinned K on Platform), then the
     ancestors as links; the h1 is the page. Never an eyebrow that repeats the path. -->
<header class="page-head">
  <nav class="crumbs" aria-label="Breadcrumb">
    <span class="crumb-chip" data-service="license" aria-hidden="true"
      ><i class="svc"></i></span
    ><a href="#">DJDL</a><i class="ic ic-chevron-right"></i
    ><a href="#">Licensing</a>
  </nav>
  <div class="page-heading"><h1>Licenses</h1></div>
  <div class="page-actions">…</div>
</header>
<!-- .crumb-chip.product holds <span class="logo xs" data-product="djdl">; .crumb-chip.platform
     holds <i class="ic ic-polaris"></i>. A feature's landing page adds the 48px masthead tile, and
     a product's own pages (Overview … Settings) the product's icon; from 1024px the tile replaces
     the chip, below it hides: -->
<div class="page-icon mast" data-service="sync" aria-hidden="true">
  <span class="mast-tile"><i class="svc"></i></span>
</div>
<div class="page-icon mast" aria-hidden="true">
  <span class="logo lg" data-product="djdl"></span>
</div>
<!-- a record: .page-head.is-record (h1 32/40) -->

<!-- a record with its identity: the icon spans the title and the identity line -->
<header class="page-head">
  <div class="page-icon"><span class="logo lg" data-product="djdl"></span></div>
  <div class="page-heading">
    <h1>DJDL</h1>
    <span class="slug">djdl</span>
  </div>
  <p class="page-sub">A DJ app for macOS and Windows</p>
  <div class="page-actions">…</div>
</header>
```

The orientation line names the context once: never "Platform" on a product page, never an
eyebrow repeating the crumbs, never a 76px decorative tile; no tile on a dense data page (a
list), a record or a state page. The h1 wraps to two lines at most, then ends in an ellipsis.
The title row is as tall as the h1's line, so the title and the actions centre on one line. On phone
the title row ends in the header's one icon-only action (More, Refresh), where the thumb reaches
it after the primary; `.freshness` becomes the 12/16 meta line under the h1; then the
description; then each text action takes a full-width row. A header carries at most one icon
action on phone; more go in its ⋯ menu.

## Sections and cards

```html
<section class="section">
  <div class="section-head">
    <div class="mk-cluster baseline">
      <h2>Products</h2>
      <span class="count">3</span>
    </div>
    <button class="btn outline sm">…</button>
  </div>
  …
</section>

<section class="card">
  <div class="card-head">
    <div class="title mk-cluster baseline">
      <h2>Needs attention</h2>
      <span class="count danger">3</span>
    </div>
  </div>
  …
</section>

<section class="card">
  <div class="card-head">
    <span class="icon-tile" data-service="license"><i class="svc"></i></span>
    <!-- only when it names the subject -->
    <div class="title">
      <h2>Licensing</h2>
      <p>Gate DJDL on a license.</p>
    </div>
    <button class="btn outline sm">Change</button>
  </div>
  <div class="card-body">…</div>
  <!-- .tight: a 16px band (a meter row, a summary) -->
  <div class="card-rows">
    <div class="card-row">…</div>
    <div class="card-row">…</div>
  </div>
  <div class="card-split wide-end">
    <div>…</div>
    <div>…</div>
  </div>
  <!-- two panes, stacks on phone -->
  <div class="card-foot"><button class="btn primary">Save</button></div>
  <!-- .start .between -->
</section>
```

Card variants: `.compact` (16 inset) `.tile` `.flat` `.sunken` `.danger` `.accent-top` `.selected`;
`.card-head.plain` drops the rule.

- A head's count sits in the title cluster, 8 after the title; the head's right side holds
  actions only.
- A page-level card's head carries no decorative icon tile, so its title starts at the card
  edge like its peers. It keeps a 28px tile only when the tile names the card's subject (a
  feature, a product). With a description, the tile and the actions line up with the title's
  first line.
- On a narrow card a head's text action drops under the title, lined up with it; an icon button
  (`.btn.icon`) stays beside it. A `.progress-inline` in a head is a count and its bar (Platform
  ready's "8 of 9 done").

```html
<div class="card-rows">
  <!-- list rows: avatar or icon · text · meta -->
  <div class="list-row">
    <span class="avatar">MF</span>
    <span class="list-row-text"
      ><strong>Mara Fennick</strong> activated a MacBook Pro</span
    >
    <span class="list-row-meta">Today, 10:42</span>
  </div>
</div>
<div class="card-foot between">
  <span class="mk-cluster no-wrap type-small muted"
    ><i class="ic ic-code-xml"></i
    ><span>Last seen 4 min ago · Swift SDK 2.1.0 on macOS arm64</span></span
  >
  <button class="btn ghost sm"><i class="ic ic-eye-off"></i>Hide</button>
</div>
<!-- done steps: one disclosure row at every size; no eyebrow, no count (the head's meter has it) -->
<div class="done-list">
  <button
    class="btn link disclosure"
    aria-expanded="false"
    aria-controls="done"
  >
    <i class="ic ic-chevron-right"></i>Show done steps
  </button>
  <div class="done-items" id="done" hidden>
    <span><i class="ic ic-check"></i>Keyring configured</span>…
  </div>
</div>
```

Card parts after another part start with a hairline (the head draws its own). The done list's
chevron sits in the media column and its label on the text column; expanded, the items wrap from
the text column.

```html
<div class="stats">
  <div class="stat">
    <span class="stat-label"><i class="ic ic-key-round sm"></i>Licenses</span>
    <span class="stat-value">240</span
    ><span class="stat-foot"><span class="delta-up">+12</span> this week</span>
  </div>
</div>
<dl class="dl">
  <dt>Tier</dt>
  <dd>Standard</dd>
</dl>
<!-- .dl.cols: <div><dt/><dd/></div> in columns -->

<!-- stats inside a card: cells share the card surface, a hairline between them; each links home -->
<div class="stats strip">
  <div class="stat" data-service="config">
    <span class="stat-label"
      ><span class="glyph issue"><i class="svc"></i></span>
      <a href="#" aria-label="Managed config: 1 needs attention"
        >Managed config</a
      ></span
    >
    <span class="stat-value">v4 <small>catalog</small></span
    ><span class="stat-foot">12 settings · 3 secrets</span>
  </div>
</div>
```

Tiles (`.stats`, `.mk-tiles`) are at least `--tile-min` wide and a short last row fills the width,
at every size. A `.stats.strip` is the way to show stats inside a card: no borders of their own, a
1px line between cells, the label's link stretched over the cell with a hover fill and the focus
ring on the cell, `.glyph.issue` for an attention dot. On a narrow card each cell is a 56px row:
glyph and label left, value right, the foot under the label. A tile's foot never repeats a list on
the page (Needs attention says the problem; the tile carries the dot).

**Home product card** (ST-36, kept by ST-44): logo, name (the one link), slug, an attention pill
only when something needs attention (it names a single issue, "Missing secret", or counts several,
"2 need attention"), one row of feature glyphs; pips beside the name on phone, the pip row's
accessible name including the issue.

```html
<div class="product-cards">
  <article class="product-card">
    <div class="product-card-head">
      <span class="logo" data-product="diceroll"></span>
      <div class="grow">
        <h3><a href="#">Diceroll</a></h3>
        <div class="mk-cluster-1">
          <span class="slug">diceroll</span
          ><span
            class="pips"
            role="img"
            aria-label="Licensing, …, Ship builds: 2 need attention, …"
            ><i class="pip" data-service="license"></i>…</span
          >
        </div>
      </div>
      <span class="pill danger sm"
        ><i class="ic ic-circle-x"></i>2 need attention</span
      >
    </div>
    <div class="product-card-svcs">
      <div class="svcs">
        <a href="#" title="Licensing"
          ><i class="svc" data-service="license"></i
        ></a>
        <a href="#" class="issue danger" title="Release: resync failed"
          ><i class="svc" data-service="release"></i
        ></a>
      </div>
    </div>
  </article>
</div>
```

## Buttons

```html
<button class="btn primary"><i class="ic ic-plus"></i>New product</button>
<button class="btn">Cancel</button>
<!-- neutral fill -->
<button class="btn outline">Export CSV</button>
<button class="btn ghost">Refresh</button>
<button class="btn action">
  <i class="ic ic-rocket"></i>Promote to stable
</button>
<button class="btn danger">Revoke license</button>
<button class="btn danger-outline">Remove device</button>
<a class="btn link" href="#">Open Catalog<i class="ic ic-arrow-right"></i></a>
<button class="btn ghost icon" aria-label="More">
  <i class="ic ic-ellipsis"></i>
</button>
<div class="segmented"><span class="on">Cards</span><span>Table</span></div>
<!-- .sm -->
```

Sizes `.sm` `.xs` `.lg`; `.block` fills the width; states `.busy` `.disabled` (or `[disabled]`)
`.focus`; `.btn-row` lays out a group. `.link` is an inline text link with an arrow.

**The primary is ink** (B2): `--mk-action` (dark: #f6f8ff with #060912 label; light: #060912 with
a white label), the same in every section, in the console, the portal and the hosted card. The
accent never fills a button. One filled primary per screen; `.danger` stays red for a destructive
action; a disabled primary is a sunken fill with a 3:1 edge and muted words, and says why beside
it. In-app UI kit frames (`.kit-btn`) keep the host's or product's accent (DL13).

## Pills, status, counts

```html
<span class="pill warning"
  ><i class="ic ic-triangle-alert"></i>Expires in 9 days</span
>
<span class="pill"><i class="dot"></i>System</span>
<span class="status"><i class="ic ic-circle-check"></i>Live</span>
<span class="count">240</span>
<span class="id"
  ><i class="ic ic-key-round"></i>lic_8KQ2…7HJM<button
    class="btn ghost icon xs"
    aria-label="Copy lic_8KQ2…7HJM"
  >
    <i class="ic ic-copy"></i></button
></span>
<span class="slug">diceroll</span>
<span class="signed-badge"
  ><i class="signed-glyph" aria-hidden="true"></i>Signed by
  diceroll-rk-2026</span
>
<!-- SignedBadge -->
```

Pill tones `.warning` `.danger` `.info` `.success` `.accent` `.outline`, size `.sm`. `.pill.signed` is
retired for new screens (EXPERIENCE §6, §11.3: never a plated pill): signing is the
`.signed-badge`, the gold rhombus and muted words. A copy control in an `.id` (or a `.value-chip`)
is a real `btn ghost icon xs` with an aria-label naming the value, never a bare `ic-copy` glyph.
Status tones `.warning` `.danger` `.info` `.muted` (default is success). Count tones `.warning`
`.danger` `.accent`. `.dot` (`.lg`) takes the current colour.

## Tables

The **workbench** (B4) is one bordered container: the toolbar is the table's head band (search,
counted facet chips with a solid outline, then Columns and Export at the end), the table under a
hairline. Rows stay 56px (compact 40), heads sentence case at 500, never uppercase. The table is a
labelled focusable region; from 640 to 1279px a wide table scrolls inside it with the first
column pinned; below 640 it stacks (`.stack-phone`).

```html
<div class="workbench">
  <div class="toolbar">…</div>
  <div
    class="table-card"
    role="region"
    aria-label="Licenses table"
    tabindex="0"
  >
    …
  </div>
</div>
```

The toolbar alone (above a grid of cards, not a table):

```html
<div class="toolbar">
  <div class="search-field">
    <i class="ic ic-search"></i><span>Search licenses</span>
  </div>
  <span class="filter on"><i class="ic ic-check"></i>Tier: Standard</span>
  <span class="filter"><i class="ic ic-plus"></i>Holder</span>
  <div class="end"><button class="btn outline sm">Export</button></div>
</div>
<div class="table-card">
  <table class="table">
    <thead>
      <tr>
        <th>Holder</th>
        <th class="num">Devices</th>
        <th class="end"></th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>
          <div class="cell-with-logo">
            <span class="avatar sm">MF</span>
            <div>
              <div class="cell-title">Mara Fennick</div>
              <div class="cell-sub">mara@example.com</div>
            </div>
          </div>
        </td>
        <td class="num">2 of 5</td>
        <td class="end"><span class="pill sm warning">…</span></td>
      </tr>
    </tbody>
  </table>
  <div class="table-foot">240 licenses<span class="ml-auto">1–50</span></div>
</div>
```

`.table.compact`, `.table.fixed` with a `<colgroup>` giving each column its width
(`<col style="width: 22%">`; equal columns only when the content is equal), `tr.selected`,
`tr.hover`, `th.check-col` with a `.check`. The card scrolls sideways on phone. A table can also
sit straight in a `.card` under its head (or under a `.card-body.tight` band, where it draws its
own top rule).

```html
<!-- a count per column goes in that column's header, never in a band of meters above the table -->
<th>
  <div class="meter-head">
    <span class="platform-name"><i class="ic ic-apple"></i>macOS</span>
    <span class="meta">2 of 5</span>
    <div class="progress success" style="--v: 40%"></div>
  </div>
</th>
<!-- one state for a whole column: one top-aligned cell merged down the rows -->
<td rowspan="5" class="hide-narrow">
  <div class="status-stack">
    <span class="unseen">Not seen yet</span
    ><a class="link" href="#">Add the SDK</a>
  </div>
</td>
<!-- a lead path and a lesser one, side by side; two lines still fit a 56px row -->
<span class="links"
  ><a class="link" href="#">Drop-in kit</a
  ><a class="link quiet" href="#"
    >Your own UI<i class="ic ic-arrow-up-right"></i></a
></span>
```

Rows are one height (`--row-h`, 56; compact 40). A cell holds one line, or a title over one sub
line: `.cell-title` + `.cell-sub`, or a status over its meta:

```html
<td>
  <div class="status-stack">
    <span class="verified">Verified</span><span class="meta">Oct 7, 10:42</span>
  </div>
</td>
```

The meta (or a `.link`) hangs under the status word, past its glyph; a time never breaks.
`.table.stack-phone` turns each row into a block on a narrow card: the first cell is the title, the
others hang under it past the media column, each led by its `<span class="cell-label">` (hidden on
wider cards) in one 80px label column, so the values share one edge. `.stack-phone.no-media` is
for a title over one unlabelled value (a two-column reference table): the value starts on the
title's edge instead of hanging past a media column the row doesn't have.

## Forms

```html
<div class="form">
  <div class="field">
    <label class="field-label"
      >Slug <span class="optional">Can't change later</span></label
    >
    <div class="input mono"><span class="grow">diceroll</span></div>
    <span class="hint">Lowercase letters, digits and hyphens.</span>
  </div>
  <div class="field invalid">
    <div class="input">…</div>
    <span class="error-text"
      ><i class="ic ic-circle-x"></i>Say what went wrong and how to fix
      it.</span
    >
  </div>
  <div class="select">
    <span class="grow">Standard</span><i class="ic ic-chevrons-up-down"></i>
  </div>
  <div class="input">
    <span class="affix">$</span><span class="grow">4.99</span
    ><span class="affix">USD</span>
  </div>
  <div class="textarea"><span class="ph">Placeholder</span></div>
</div>
<span class="check on"
  ><span class="box"></span>Email the customer their key</span
>
<!-- .mixed -->
<span class="radio on"><span class="box"></span>Lifetime</span>
<span class="switch on"></span>
<!-- .disabled -->
<div class="choices">
  <div class="choice on">
    <div class="choice-title">…</div>
    <div class="choice-desc">…</div>
  </div>
</div>
<span class="chip on"><i class="ic ic-apple"></i>iOS</span>
<div class="setting-row">
  <div>
    <div class="setting-title">…</div>
    <div class="setting-desc">…</div>
  </div>
  <span class="switch on"></span>
</div>
```

Fields: `.input.readonly`, `.input.sm`, `.input.invalid`, `.ph` for placeholder text. Controls
are drawn, not real inputs. `.choice.disabled`, `.choice.nocheck`.

## Tabs

```html
<nav class="tabs">
  <a class="tab active" href="#">Licenses <span class="count">240</span></a
  ><a class="tab" href="#">Tiers</a>
</nav>
```

Route tabs are an underline tablist (B4): a 3px accent indicator under the selected tab (3:1 in
both themes), 500, never a boxed or segmented tray; the end fade shows only while the strip
scrolls. `.segmented` is for a view or filter switch, never navigation.

## Wizard, steps and progress

```html
<div class="wizard">
  <div class="wizard-head">
    <ol class="stepper">
      <li class="step done">
        <span class="step-mark"></span
        ><span class="step-label">Repository</span>
      </li>
      <li class="step current">
        <span class="step-mark"></span
        ><span class="step-label"
          >What it's for<small>Features and platforms</small></span
        >
      </li>
      <li class="step">
        <span class="step-mark"></span><span class="step-label">Create</span>
      </li>
    </ol>
  </div>
  <div class="wizard-body">
    <h2>What is Diceroll for?</h2>
    …
  </div>
  <div class="wizard-foot">
    <button class="btn ghost">Back</button
    ><button class="btn primary">Continue</button>
  </div>
</div>

<div class="tasks">
  <!-- .padded inside a card -->
  <div class="task done">
    <span class="task-mark"></span>
    <div class="task-title">Signing key</div>
    <div class="task-desc">…</div>
  </div>
  <div class="task">
    <span class="task-mark"></span>
    <div class="task-title">Connect Steam</div>
    <div class="task-desc">…</div>
    <div class="task-action">
      <button class="btn outline sm">Connect</button>
    </div>
  </div>
</div>
<div class="progress success" style="--v: 40%"></div>
<!-- .warning; default accent -->
<div class="meter"><i class="on"></i><i class="on"></i><i></i></div>
<div class="progress-stats">
  <div class="progress-stat">
    <!-- labelled meters side by side, 40 apart; never above a table -->
    <div class="progress-stat-head">
      <span class="platform-name"><i class="ic ic-apple"></i>macOS</span
      ><span class="meta">2 of 5 verified</span>
    </div>
    <div class="progress success" style="--v: 40%"></div>
  </div>
  …
</div>
<div class="progress-inline">
  <span>8 of 9 done</span>
  <div class="progress success" style="--v: 88.9%"></div>
</div>
```

Task states: none (to do), `.done`, `.waiting`, `.blocked`. The 20px mark is centred in the 28px
media column, so a task title starts on the card's text column; on a narrow card the action drops
under the text. `.stepper.vertical` stacks steps. A progress track is a visible hairline tone, so
an empty or partial bar shows its full extent.

## Features and Integration

```html
<span class="icon-tile" data-service="sync"><i class="svc"></i></span>
<!-- .sm .lg .muted -->
<p class="eyebrow">In the console<span class="end">…</span></p>

<div class="platform-checks">
  <p class="eyebrow">Verified</p>
  <div class="platform-check">
    <span class="platform-name"><i class="ic ic-apple"></i>macOS</span>
    <span class="verified">Verified</span><span class="meta">Oct 7, 10:42</span>
  </div>
  <div class="platform-check">
    <span class="platform-name"><i class="ic ic-windows"></i>Windows</span>
    <span class="unseen">Not seen yet</span>
  </div>
</div>

<section class="card feature-fold" data-service="config">
  <!-- .add: dashed, for an off feature -->
  <span class="icon-tile sm"><i class="svc"></i></span>
  <div class="title">
    <h2>Managed config</h2>
    <span class="status"
      ><i class="ic ic-circle-check"></i>Verified on macOS</span
    >
  </div>
  <button class="btn ghost sm">Show<i class="ic ic-chevron-down"></i></button>
</section>

<div class="setting-row with-icon" data-service="license">
  <span class="icon-tile"><i class="svc"></i></span>
  <div>
    <div class="setting-title">Licensing</div>
    <div class="setting-desc">…</div>
  </div>
  <span class="switch on"></span>
</div>
```

Verified has four looks: `.verified` (tick, then the time only; the SDK version only when it
differs from the latest sighting), `.waiting-dot` (a neutral clock, never the accent, "Waiting for
the first sign-in"), `.after-step` (an open ring, muted, never a link, "After the console step"),
`.unseen` (dashed ring, "Not seen yet"). Each is a 16px glyph 8px from its word; a long state wraps
and hangs past its glyph, so it never runs into the next column. The open console step itself is
the one link, verb first, beside an open ring: `<span class="open-step"><a class="link"
href="#">Add Sparkle signing key</a></span>` (two or more: "2 steps: Sparkle signing key, …").
`products.overview` and `products.integration` are the references.

In the console, each feature leads with the drop-in UI kit (the generated kit code, the fewest
lines that give working screens) and links to that SDK's docs for integrating directly with your
own UI (`.links`: "Drop-in kit", then a `.link.quiet` "Your own UI ↗"). No long library
walkthrough lives in the console.

## Callouts, attention, empty states

```html
<div class="callout warning">
  <i class="ic ic-triangle-alert"></i>
  <div class="grow">
    <div class="callout-title">The Play key expires on Oct 16</div>
    <div class="callout-text">Uploads to Google Play stop then.</div>
  </div>
  <button class="btn outline sm">Replace key</button>
</div>
<div class="attn-row">
  <span class="pill danger"><i class="ic ic-circle-x"></i>Error</span>
  <span class="attn-subject"
    ><span class="logo xs" data-product="diceroll"></span>Diceroll</span
  >
  <span class="attn-text">Resync from repo failed: …</span
  ><a class="link" href="#">Open error<i class="ic ic-arrow-right"></i></a>
</div>
<div class="empty">
  <span class="empty-icon"><i class="svc"></i></span>
  <h3>No offers yet</h3>
  <p>…</p>
  <div class="btn-row"><button class="btn primary">New offer</button></div>
</div>
<span class="skeleton" style="width: 40%"></span> <span class="spinner"></span>
```

Attention rows: the message wraps in full and is **never cut with an ellipsis** (it is the fact the
row exists to state); the pill, subject and link stay on its first line; a one-line row is 56 and
a wrapped row keeps 12 above and below. On a narrow card the row stacks: pill and subject as one group (8 apart), the message,
then the action.

Callout tones: none (neutral), `.info` `.warning` `.danger` `.success` `.accent`. On phone a
callout's action goes under its text. A callout's actions are `.btn.outline` (and `.btn.ghost`
for Dismiss), never `.primary`: the page header keeps the page's one primary. Attention rows
live in `.card-rows` or a card.

## Menus, tooltips, dialogs, drawers, toasts

```html
<div class="popover-anchor">
  <button class="btn ghost icon">…</button>
  <div class="popover right">
    <div class="menu">
      <span class="menu-label">DJDL</span>
      <a class="menu-item active" href="#"
        ><i class="ic ic-pencil"></i>Edit license<span class="end"
          ><kbd>E</kbd></span
        ></a
      >
      <div class="menu-sep"></div>
      <a class="menu-item danger" href="#"><i class="ic ic-ban"></i>Revoke</a>
    </div>
  </div>
</div>
<span class="tooltip">Managed config: 1 needs attention</span>

<!-- last child of .console or .portal -->
<div class="overlay">
  <div class="dialog">
    <!-- .sm .lg .danger -->
    <div class="dialog-head">
      <h2>Turn off Licensing?</h2>
      <button class="btn ghost icon sm"><i class="ic ic-x"></i></button>
    </div>
    <div class="dialog-body">
      <p>Commerce needs Licensing, so it turns off too, in the same change:</p>
      <ul class="bullets">
        <li><strong>Commerce</strong>: …</li>
      </ul>
    </div>
    <div class="dialog-foot">
      <button class="btn">Cancel</button
      ><button class="btn danger">Turn off Licensing and Commerce</button>
    </div>
  </div>
</div>

<!-- typed confirmation -->
<label class="field-label"
  >Type <span class="confirm-word">diceroll</span> to confirm</label
>
<div class="input mono focus"><span class="grow">dicer</span></div>

<div class="overlay end">
  <aside class="drawer">
    <div class="drawer-head"><h2>Device</h2></div>
    <div class="drawer-body">…</div>
    <div class="drawer-foot">…</div>
  </aside>
</div>

<div class="toasts">
  <div class="toast success">
    <i class="ic ic-circle-check"></i>
    <div class="grow">
      <div class="toast-title">Published catalog v4</div>
      <div class="toast-text">…</div>
    </div>
    <button class="btn ghost xs">Undo</button>
  </div>
</div>
```

A confirmation names what else changes (a requirement turning off its dependents) and its button
says exactly what happens. Toast tones `.success` `.danger` `.warning` `.info`; `.toasts` sits at
the bottom right of the first viewport (in a shot of a longer page, at the page's end). In dark, a neutral `.btn` (Cancel) inside a dialog, drawer
or popover takes `--mk-fill-strong` and a hairline, because the plain fill is the overlay surface.

**Heads** (B4): a dialog or drawer carries a 3px rule in its origin's accent along its top edge and
a head band (`--mk-band-overlay`) with a hairline under it; its title stays at or under 20/28; it
leads with ONE glyph or none: the severity glyph on a confirmation, the subject's mark (a store, a
provider) on a record, never a service tile beside it. A destructive or cautious confirmation
(`.danger`, `.caution`) has no rule: the severity glyph leads. The backdrop is blurred; with
`prefers-reduced-transparency` it is a flat scrim.

`.dialog.caution` (L1, ConfirmDialog `intent="caution"`) colours a leading `.ic` in the head
warning; `.dialog.danger` colours it danger.
`.confirm-word.neutral` is the typed word for an action that loses nothing (a price change).
`.sheet` on an overlay (`<div class="overlay sheet">`, `<div class="overlay end sheet">`) makes the
dialog or drawer a bottom sheet below 640px (ADMIN.md §Overlays): grab handle, rounded top, at most
90% of the screen tall with the body scrolling, buttons pinned at the bottom, primary on top.

## Code

```html
<div class="code">
  <div class="code-head">
    <div class="code-tabs">
      <span class="active">Swift<small>macOS</small></span
      ><span>Kotlin<small>Windows</small></span>
      <span class="more">More<i class="ic ic-chevron-down"></i></span>
    </div>
    <button class="btn ghost xs"><i class="ic ic-copy"></i>Copy</button>
  </div>
  <pre><span class="t-k">let</span> client = <span class="t-k">try await</span> <span class="t-t">PolarisKeyClient</span>.<span class="t-f">fromConfig</span>()</pre>
  <div class="code-foot">
    <i class="ic ic-info sm"></i><span>Written for DJDL.</span>
  </div>
</div>
<div class="cmd">
  <span>pnpm add @polaris-key/react</span
  ><button class="btn ghost icon xs"><i class="ic ic-copy"></i></button>
</div>
```

Tokens: `t-k` keyword, `t-s` string, `t-f` function, `t-t` type, `t-n` number, `t-c` comment,
`t-p` property, `t-o` punctuation, `t-v` variable; `<span class="hl">` highlights a line.
`.code-file` names a file instead of tabs. Start `<pre>` at column 0 so the code isn't indented.
On phone, Copy keeps only its icon and the code scrolls inside its block.

## Terminal

```html
<div class="term">
  <!-- .cols-80: exactly 80 columns -->
  <div class="term-bar">
    <span class="term-dots"><i></i><i></i><i></i></span
    ><span class="term-title">zsh — diceroll</span>
  </div>
  <pre class="term-body"><span class="c-prompt">❯</span> pkey doctor
  <span class="c-ok">✓</span> polaris-key.json  <span class="c-dim">found, product diceroll</span>
<span class="c-chip"> 1 problem </span> <span class="cursor"></span></pre>
</div>
```

ANSI roles (packages/brand/src/tokens/terminal.ts): `c-accent` cyan, `c-ok` green, `c-warn`
yellow, `c-err` red, `c-info` magenta, `c-dim`, `c-b` bold, `c-u` link, `c-chip` inverse,
`c-prompt`. ✓ ✗ ○ and braille fall back to the system mono face.

## Customer portal

```html
<div class="portal" data-service="core">
  <header class="portal-top">
    <a class="portal-brand" href="#"><i class="pk-mark sm"></i>Polaris Key</a>
    <nav class="portal-nav">
      <a class="active" href="#">Library <span class="count">3</span></a
      ><a href="#">Discover</a>
    </nav>
    <div class="portal-actions">
      <button class="btn outline sm">
        <i class="ic ic-key-round"></i>Activate license
      </button>
      <span class="account"
        ><span class="avatar sm">MF</span>Mara Fennick<i
          class="ic ic-chevron-down"
        ></i
      ></span>
    </div>
  </header>
  <main class="portal-page">
    <div class="mk-stack-2">
      <h1>Your library</h1>
      <p class="muted">Licenses for mara@example.com</p>
    </div>
    <div class="portal-grid">
      <article class="ptile">
        <div class="art" data-product="diceroll">
          <span class="pill success on-art"
            ><i class="ic ic-circle-check"></i>In your library</span
          >
        </div>
        <div class="ptile-head">
          <span class="logo lg" data-product="diceroll"></span>
          <div class="ptile-title">
            <h2><a href="#">Diceroll</a></h2>
            <span>Example Games</span>
          </div>
        </div>
        <div class="ptile-body">
          <div class="mk-stack-3">
            <div class="pill-row">
              <div class="mk-cluster">
                <span class="pill sm"
                  ><i class="ic ic-key-round"></i>Standard</span
                >
              </div>
              <span class="platforms"><i class="ic ic-apple"></i></span>
            </div>
            <ul class="icon-lines">
              <li><i class="ic ic-calendar-clock"></i><span>Lifetime</span></li>
            </ul>
          </div>
        </div>
        <div class="ptile-foot">
          <button class="btn outline">Download</button
          ><button class="btn outline icon" aria-label="More">
            <i class="ic ic-ellipsis"></i>
          </button>
        </div>
      </article>
      <aside class="ptile end-tile">
        <h2>Missing a license?</h2>
        <ul class="media-list">
          <li>
            <span class="icon-tile muted"><i class="ic ic-key-round"></i></span>
            <span
              ><strong>You have a license key</strong>Activate it to move it
              into your account.</span
            >
          </li>
        </ul>
        <div class="btn-row">
          <button class="btn outline">Activate license</button>
        </div>
      </aside>
    </div>
  </main>
  <footer class="portal-foot">Polaris Key · <a href="#">key.plrs.im</a></footer>
  <nav class="portal-tabbar">
    <a class="active" href="#"><i class="ic ic-layout-grid"></i>Library</a>
    <a class="act" href="#"><i class="ic ic-key-round"></i>Activate</a>
    <a href="#" aria-label="Discover, 1 to add"
      ><i class="ic ic-sparkles"></i>Discover<span
        class="dot"
        aria-hidden="true"
      ></span
    ></a>
  </nav>
</div>
```

The portal's real screens are in `packages/admin/e2e/__baselines__/portal/linux/`; match them.
`.portal-tabbar` shows only on phone, where the top nav hides: Library · Activate (`.act`, the
outlined pill, never a tab) · Discover (a `.dot` while there is something to add). In phone shots
the renderer draws the bar and any `.toasts` at the end of the page, the footer keeps clear of the
bar, and a toast sits above it.

**Page.** The portal's content is 1248px wide from a 1296px screen up (`--portal-max`), so wide
and desktop draw the same centred column: the portal's sensible max width, with no stretched line.
`.portal-page` stacks its blocks 24 apart. The title block is `.mk-stack-2`: the 40/44 h1, then at
most one muted line of live state shown nowhere else (the emails the library covers), never a
count the nav already shows.

**Tiles** (Library, Discover; the kit's portal parts, no screen spacing):

- `.portal-grid`: three tiles from 1280px, two from 640px, one on phone; 24 apart (16 on phone).
  An `.end-tile` that would start a row alone spans it, and its `.media-list` goes into columns.
- `.ptile`: the `.art` at its whole 16:9 frame from the tile's top edge, edge to edge, at most
  280px tall, never a cropped band (owner, 2026-10-08: the card image runs all the way), then
  `.ptile-head` (the 56px `.logo.lg` 20 over the art, 36 under it,
  and `.ptile-title`: the name at 18/24, the tiles being the page's blocks, with a quiet second fact
  such as the developer on its line), `.ptile-body` (one `.mk-stack-3`: a `.pill-row`, then
  `.icon-lines`, a reason `.callout`, store `.links`), and `.ptile-foot`, whose main action fills
  the row whichever button the device shows.
- `.pill-row`: a `.mk-cluster` of pills on the left and `.platforms` at the end of the first pill
  line; when the pills don't fit, a pill wraps under its neighbour and the glyphs stay put (never
  a line of glyphs on their own).
- `.on-art`: a state pill on the cover art's bottom right (In your library).
- `.icon-lines`: facts led by a 16px glyph, 8 from the text, lines 4 apart; a long one hangs past
  its glyph.
- `.ptile.end-tile`: the dashed last tile that says how things get here: an 18/24 title, a
  `.media-list`, actions at its foot level with the tiles' actions.
- `.media-list`: items led by a 28px `.icon-tile`, a bold 14/20 title over a 13/20 muted line; 16
  apart, columns (min 220px, 24 apart) when the list has the room. In the portal its links are
  underlined.
- `.ptile.end-tile.entry-tile` (`.entry-inner` > `.entry-art` with an `.entry-mark`, `.entry-text`,
  `.ptile-foot`): the Library's entry for a license key, last in the grid (owner, 2026-10-08:
  better styling for the have-a-license entry). Dashed and unfilled, as tall as the tiles beside
  it: a quiet well in the art's place with the key in a 64px accent tile, the question at 20/24,
  one line, and the action at the foot level with the tiles' actions. With a row to itself (640px
  of tile and up) it is one line: the 48px key, the text, the button. On a phone the 40px key sits
  beside the text and the button runs full width under them.
- The portal header hides the account's name from 640 to 899px (the avatar and chevron stay), and
  the footer's links are underlined.

**Product page** (`portal.license`, `portal.license-lapsed`):

```html
<main class="portal-page">
  <div>
    <a class="link" href="#"><i class="ic ic-arrow-left"></i>Library</a>
  </div>
  <header class="product-hero">
    <div class="art" data-product="djdl"></div>
    <div class="product-hero-row">
      <span class="logo" data-product="djdl"></span>
      <div class="product-hero-title">
        <h1>DJDL</h1>
        <p>by <a href="#">Example Audio</a></p>
      </div>
      <div class="product-hero-actions">
        <button class="btn primary lg">…</button
        ><button class="btn outline icon lg">…</button>
      </div>
      <p class="product-hero-note">
        A line for this device (phone: "We'll email you a link")
      </p>
    </div>
  </header>
  <div class="product-layout">
    <nav class="jump-nav" aria-label="On this page">
      <a class="on" href="#">License</a>…
    </nav>
    <!-- below 1280 -->
    <nav class="toc-nav" aria-label="On this page">
      <a class="on" href="#">License</a>…
    </nav>
    <!-- from 1280 -->
    <div class="product-col">…main cards…</div>
    <div class="product-col">…license column…</div>
  </div>
</main>
```

- `.product-hero`: a 3:1 band of the cover (max 416px; 16:9 full bleed on phone), the 112px icon
  (80 on phone) about a third over its lower edge, the name and maker beside it, 12 clear of the
  art (8 on phone), the actions on the right (full width on phone), `.product-hero-note` under
  them.
- `.product-layout`: from 1280px the in-page `.toc-nav` (148px), the main column and the 384px
  license column; tablet (1024–1279) two columns under the sticky `.jump-nav`; below 1024px one
  column, the screen ordering the cards with `order` (the columns become `display: contents`).
  Columns and cards are 24 apart, and every card in a `.product-col` titles at 18/24.
- `.jump-nav`: the page's sections as 32px pills, sticky under the 64px header, scrolling sideways
  with a faded edge, full bleed to the gutters.
- `.license-term`: a license's term on a timeline in a sunken box: the title and what happens
  after (`.mk-stack-1`), then `.term-chart` (`.term-today` label, `.term-track` with the covered
  `.progress`, the dashed `.term-after` (`.on` when today is past the end) and `.term-mark`, then
  `.term-scale`), then a `.status` or the one renew action. `--term-today` places the marker and
  label (a percentage of the chart), `--term-split` the end of the covered stretch (70%),
  `--term-anchor` where the label hangs from its marker (0%, 50%, 100%).
- `.table tr.recommended`: the build for this device, tinted, as the first row of one downloads
  table (never a second panel repeating it).
- `.progress-inline > .meter`: a head's count with a segmented meter (devices); `.dl.cols > .full`
  takes a whole row of a fact grid (a sentence, a list); `.md`: release notes drawn from Markdown
  (h3, list, link, emphasis).
- **License pages** (block `portal-license-pages`; `portal.license`, `portal.license-lapsed`): the
  portal's hero is the `--hero-h` band (220, 260 from 1700px, 160 under 1100, 112 on phone) with
  the 56px icon 20 over it (portal-multi-review), and `.product-hero-note` never ends on an orphan
  word. `.device-row` (a device or an account: 28px tile or avatar, `.device-name` over one
  `.device-meta` line whose `span` facts never break, the action at the end; `.this` ends the
  meta in the accent for this device). `.meter.neutral` and `.progress.neutral`: a device or
  storage meter in the strong text colour, never the accent or a warning (a limit, not an error,
  UI-KITS §1.5 rule 9). A `.card-head` holding a `.progress-inline` drops it under the title on a
  narrow card. `.card-foot.stack-phone`: buttons full width and stacked on a phone. Release notes
  in the portal take dash markers, never discs. One state per page: a healthy license has no
  pill; a lapse has one pill in the hero and explains itself in a neutral callout.
- `.license-card` and `.key-field` (`<div class="key-field"><span>pkey_djdl_7HJM…Q2KD</span></div>`,
  a key in a mono field on the accent tint) stay for a license that has a key.

## Frames and boards (surfaces kit, code, dialog)

```html
<div class="board">
  <div class="board-title">
    <h1>Diceroll paywall</h1>
    <p>The Godot kit on iOS and Android.</p>
  </div>
  <figure class="board-item">
    <div class="device">
      <div class="device-screen" data-pk-platform="ios">
        <div class="device-status">
          <span>9:41</span
          ><span class="row gap-1"
            ><i class="ic ic-signal"></i><i class="ic ic-wifi"></i
            ><i class="ic ic-battery-full"></i
          ></span>
        </div>
        <div class="device-body">…</div>
      </div>
    </div>
    <figcaption><strong>iOS</strong>Light</figcaption>
  </figure>
</div>
<div class="window">
  <div class="window-bar">
    <span class="term-dots"><i></i><i></i><i></i></span>DJDL
  </div>
  <div class="window-body">…</div>
</div>
<div class="window win">
  <div class="window-bar">
    DJDL<span class="window-controls"
      ><i class="ic ic-minus"></i><i class="ic ic-square"></i
      ><i class="ic ic-x"></i
    ></span>
  </div>
</div>
<div class="browser">
  <div class="browser-bar">
    <span class="term-dots"><i></i><i></i><i></i></span
    ><span class="url"><i class="ic ic-lock"></i>key.plrs.im/djdl</span>
  </div>
  …
</div>
<span class="anno">1</span>
<!-- numbered pin; .at + inline top/left to place it; refer to it in "compare" -->
```

`.device.android` is a 412×915 Android phone; `.device.landscape` holds either sideways (844×390,
915×412). A `data-pk-platform` preset on a frame's screen applies that platform's in-app kit
measures.

**UI-kit boards are responsive too.** A `.device-screen` is a size container, so a drop-in flow
adapts to its frame with the same markup. A board draws each flow in a landscape frame and a
portrait frame. Device-code, QR and activation screens use `.kit-split`: the two panels (the
product beside the form, the code beside its QR) sit side by side from 640px of frame width
(a landscape or tablet device frame; outside a device frame, the screen's width) and stack below
it (portrait).

```html
<div class="device landscape">
  <div class="device-screen" data-pk-platform="ios">
    …
    <div class="device-body">
      <div class="kit-split">
        <div>product</div>
        <div>form</div>
      </div>
    </div>
  </div>
</div>
```

**Board copy** (sdk multi-review, 2026-10-08). "Say it once, and briefly" on a board:

- **The lede is optional**: at most one sentence naming what is drawn ("`.polarisKeyGate(pk)` on
  iPhone."), never the mechanism. Drop it when the title and the section titles already say it.
- **A caption** is the bold state name plus at most one sentence of behaviour the frame can't show
  (what a variant reads, what is preselected and why). Never narrate what the frame shows.
- **Fixture facts** (what the product really ships, which features it has on) appear only in the
  callout, never again in a caption or a code note.
- **Rationale and programme references** (D-54, PORTAL §…, live-region and breathing-dot rules,
  "tonal", "morphs in place") belong in the screen's JSON compare list, not on the board.
- **Terminal titles** are what the shell shows (`zsh — djdl — 80×64`, `zsh — ~/Downloads — 80×12`);
  a state's name ("First run without --expect") goes in a bold figcaption under the window.
- **Controls are drawn at rest.** Hover states belong in the kit gallery, so a static frame never
  looks selected (a focus ring drawn on purpose is a state of its own, with its caption).

## Channels and downloads (distribution screens)

```html
<!-- nested nav entries under their parent: a hairline under the parent's icon, 32px items -->
<a class="nav-item" href="#"
  ><i class="ic ic-star-cut"></i><span class="nav-text">Channels</span></a
>
<!-- no count: the nested entries list them -->
<div class="nav-sub">
  <a class="nav-item active" href="#"
    ><i class="ic ic-app-store"></i><span class="nav-text">App Store</span></a
  >
  <a class="nav-item" href="#"
    ><i class="ic ic-google-play"></i><span class="nav-text">Google Play</span
    ><span class="nav-dot" title="Attention"></span
  ></a>
  <a class="nav-item" href="#"
    ><i class="ic ic-steam"></i><span class="nav-text">Steam</span
    ><span class="nav-note">2 of 4</span></a
  >
</div>

<span class="icon-tile sm neutral"><i class="ic ic-app-store"></i></span>
<!-- a store or platform mark; .xl is a page icon (56, phone 40) -->
<span class="value-chip"
  ><i class="ic ic-terminal"></i
  ><span class="mid"
    ><span>scoop install https://…/</span><span>stable.json</span></span
  ><button
    class="btn ghost icon xs"
    aria-label="Copy the Scoop install command"
  >
    <i class="ic ic-copy"></i></button
></span>
<div class="value-chip block">
  <i class="ic ic-external-link"></i><span>apps.apple.com/app/id6478123905</span
  ><button class="btn ghost icon xs">…</button>
</div>
<figure class="qr-figure">
  <span class="qr"><svg>…</svg></span>
  <figcaption>Scan with your iPhone</figcaption>
</figure>
<!-- .qr.sm 80 -->
<div class="mk-media">
  <figure class="qr-figure">…</figure>
  <div class="mk-stack-2">…</div>
</div>
<!-- a fixed thing beside text, 16 apart -->

<div class="card-rows">
  <!-- .flush in a dialog or drawer body -->
  <div class="item-row">
    <!-- .lead: a 16px check or state mark first; .top: align to the title's line -->
    <span class="icon-tile sm neutral"><i class="ic ic-itch"></i></span>
    <div class="item-text">
      <div class="item-title">itch.io <small>Windows</small></div>
      <div class="item-desc">…</div>
    </div>
    <div class="item-end">
      <button class="btn outline">Open itch.io</button>
    </div>
    <div class="item-more">
      <ol class="num-list">
        <li>
          <span>Install Diceroll:</span>
          <div class="cmd">…</div>
        </li>
      </ol>
    </div>
  </div>
</div>

<div class="copy-field">
  <span class="copy-label">App name</span
  ><span class="copy-value">Diceroll</span
  ><button class="btn ghost icon xs">…</button>
</div>
<div class="task running">
  <span class="task-mark"></span>
  <div class="task-title">Find Diceroll in Steamworks</div>
  <span class="task-meta">Steamworks Web API</span>
</div>

<div class="overlay top"><div class="dialog xl scroll">…</div></div>
<!-- starts 64 down; head and foot stay, the body scrolls -->
<section class="card tint">…</section>
<!-- the one recommended thing on a page -->

<main class="portal-page columns">
  <!-- from 1280: main + a 400px aside -->
  <section class="portal-hero span-all">
    <div class="art" data-product="diceroll"></div>
    <div class="portal-hero-body">
      <span class="logo xl" data-product="diceroll"></span>
      <div class="mk-stack-1">
        <h1>Diceroll</h1>
        <p>by …</p>
      </div>
      <p class="portal-hero-pitch">…</p>
    </div>
  </section>
  <section class="card tint aside">Recommended for your PC</section>
  <section class="section">Every way to get Diceroll</section>
</main>
```

- **Nested nav.** `.nav-sub` follows the item it belongs to; its entries are 32px in the small
  step, and `.nav-note` (a quiet "2 of 4") or `.nav-dot` (attention, `.danger`) sits at the end. A
  sidebar with a nested list keeps its foot after the last entry. On the tablet rail the nested
  entries hide and their parent draws as the active item.
- **Item rows** are for a media mark, a title over its description, and a trailing end (buttons,
  a QR code, a select, a state word): the download page's ways to get a product, the Publish
  dialog's channels. The media is the card's 28px column; one line is `--row-h`, a taller row keeps
  12 above and below; `.item-more` (steps, copy fields) sits under the text. On a card under
  560px the end drops under the text, on the text column.
- **Values.** `.value-chip` is a quiet outline (lighter than the states beside it); `.mid`
  truncates in the middle so the end of a URL or command survives. `.copy-field` is a labelled
  value to paste somewhere else; four of them sit in a `.mk-grid-4`.
- **QR codes** are dark on a light tile in both themes, 96px (`.sm` 80), with a 12/16 caption
  8 under them that says what to scan with. They hide on phone, where the visitor already is.
- **Tasks Polaris Key runs.** `.task.running` is the busy ring (the work is under way); `.waiting`
  stays the static clock. `.task-meta` names where the work happens, at the end of the title's
  line (under the text on a narrow card). A failed task is `.task.blocked` with the fix in its
  description and its Try again (EXPERIENCE §2's word, never "Retry") in a `.task-body`.
- **Portal hero.** Cover art 176 high (phone 112), the xl logo 48 over its edge (phone 72, 40
  over), the name at the page step beside the logo, the pitch under both at 72ch.
- **Even rail.** `.mk-rail.even` (in `.mk-with-rail`): below 1280px, where the rail's cards sit
  side by side under the main column, they share the row's height and a card's foot sits at its
  bottom (a channel page's What customers do, Sales and App). From 1280 nothing changes.
- **Scrolling dialog fade.** `.dialog.scroll.fade`: when the body is taller than the dialog allows
  (Publish on a 768px-high screen, the phone sheet), its last 24px fade out above the foot, so the
  cut reads as more to scroll, never as a clipped line. When everything fits, nothing changes.
- `distribution.channels`, `distribution.channel-app-store`, `distribution.channel-setup`,
  `distribution.download-page` and `distribution.publish` are the references.

**Multi-review additions (2026-10-08).** New primitives only; no existing value changed. All in
`mockup.css` between `BEGIN distribution-multi-review` and its `END`.

```html
<!-- a state mark whose words flow as one run, wrapped lines past the glyph -->
<span class="waiting-dot hang" role="status"
  >Moves on when Polaris Key finds Diceroll in Steamworks ·
  checked&nbsp;6&nbsp;s&nbsp;ago</span
>
<!-- an action link that may wrap; the arrow is glued to the last word -->
<a class="link wrap" href="#"
  >Upload it in
  <span class="nowrap">Steamworks<i class="ic ic-arrow-up-right"></i></span
></a>
<!-- a table whose rows open a page; a 16px chevron ends the title line on a narrow card -->
<table class="table fixed stack-phone row-links">
  …
  <div class="cell-with-logo">
    …<a class="cell-title" href="#">App Store</a>…<i
      class="ic ic-chevron-right row-go show-narrow"
      aria-hidden="true"
    ></i>
  </div>
  …
</table>
<!-- a warning attention row: no pill, the glyph leads the subject (a danger row keeps its pill) -->
<div class="attn-row bare">
  <span class="attn-subject"
    ><i class="ic ic-triangle-alert attn-glyph" aria-hidden="true"></i
    ><i class="ic ic-google-play" aria-hidden="true"></i>Google Play</span
  ><span class="attn-text">…</span
  ><a class="link" href="#">Replace key<i class="ic ic-arrow-right"></i></a>
</div>
<!-- meta facts with even dots; a rating's 16px star in brand gold, 4 from its number -->
<span class="meta-seps"
  ><span>Store</span><span>iOS</span
  ><span class="rating"
    ><i class="ic ic-star" aria-hidden="true"></i>4.6 from 1,284 ratings</span
  ></span
>
<!-- a dialog row whose leading part toggles a real checkbox; the select stays outside the label -->
<div class="item-row lead top">
  <label class="item-label"
    ><span class="check on"
      ><input class="sr-only" type="checkbox" checked /><span class="box"></span
    ></span>
    <span class="icon-tile neutral">…</span
    ><span class="item-text"
      ><span class="item-title">App Store</span
      ><span class="item-desc">…</span></span
    ></label
  >
  <div class="item-end">
    <div class="select sm" role="combobox" aria-label="App Store release">
      …
    </div>
  </div>
</div>
<!-- the typed confirmation pinned in a phone sheet's foot (from 640px the field ends the body) -->
<div class="dialog-foot">
  <div class="foot-confirm">
    <label class="field-label"
      >Type <span class="confirm-word neutral">1.9.0</span> to confirm …</label
    >
    <div class="input mono">…</div>
    <p class="hint">Store review can’t be undone.</p>
  </div>
  …
</div>
<!-- a whole-row disclosure in its own card -->
<button class="card fold-row" aria-expanded="false">
  <i class="ic ic-chevron-right"></i
  ><span class="fold-row-text"
    ><strong>3 more channels</strong><span>AltStore PAL, …</span></span
  >
</button>
<!-- the portal hero's download for this device, from 640px -->
<div class="portal-hero-body">
  …
  <div class="portal-hero-action">
    <div class="mk-stack-1">…</div>
    <button class="btn primary lg">…Download</button>
  </div>
</div>
```

- **State marks** `.hang` (on `.verified`, `.unseen`, `.waiting-dot`, `.after-step`): the glyph
  is positioned and the words hang past it, so text with an inline element (a `.nowrap` time, a
  link) flows as one run. The base looks stay a two-column grid, where a nested element becomes its
  own grid item and drops under the glyph; moving every area to the hanging indent would change an
  existing value, so it is opt-in until the lead decides.
- **Wrapping links** `.link.wrap` / `.btn.link.wrap`: may wrap, keeps a 24px target. **No action
  link may push a card or the page sideways at 360px**: glue the trailing ↗ or → to the last word
  with a `.nowrap` span.
- **Facts** `.dl.cols.stack`: one column under 560px of card width (a rail card, a phone), so two
  mono ids never meet; values wrap anywhere.
- **Rails** `.mk-rail.blocks`: on phone the stacked rail cards are `--section-gap` apart, like the
  main column's, not `--grid-gap`. A rail of secondary cards may be `.card.compact` so it stays the
  shorter column (`distribution.channel-app-store`).
- **Item rows.** A list of multi-line item rows uses `.top` on every row, so the status words share
  the title's line. `.select.sm` in a row's end (32 high) centres there too. `.item-label` wraps a
  row's check, media and text in a `<label>` (display: contents) so the whole row toggles a real
  checkbox. `.card-rows.fixed-actions` gives every row's buttons one width (`--item-action-w`, 236:
  "Download on the App Store"), so button edges and the QR column line up; on a narrow card they
  fill the text column. `.qr.xs` is a 64px code in a row, captioned once in the card head ("Scan
  with your phone"); such a row is 88 high. `.item-row.recommended` tints the row a visitor's
  device should use. `.card-rows.flush.snug` drops the first row's top and last row's bottom
  padding in a dialog body.
- **Dialogs.** `.dialog.scroll.fade` already fades at every size whenever the body overflows.
  `.foot-confirm` holds a typed confirmation (label, input, one hint) as the foot's first child; it
  shows only in an `.overlay.sheet` under 640px, above the stacked buttons. `.foot-note.first`
  reads before the buttons in a phone sheet.
- **Wizard.** `.stepper.fill`: connectors flex (`1 1 24px`), so the steps span the head.
  `.btn.ghost.hang-start` hangs a start-edge ghost button (Do this later) by its padding, so its
  label lines up with the content above. `.task-action.on-title` puts a task's action on its
  title's line when its blocks sit under it in a `.task-body`. Done steps stay one disclosure row
  at every size (`.done-list`); expanded, the hidden `.tasks` show each source.
- **Copy** in an `.id` or a `.value-chip` is a real `btn ghost icon xs` with an aria-label naming
  the value: it fills a value chip's end; an `.id` grows to 28, and on a narrow card the whole `.id`
  is the button's target, 32 high.
- **Rows that open a page** `.table.row-links`: the `.cell-title` link stretches over the row,
  controls inside it sit above; `.row-go` is the narrow card's chevron on the title line.
- **Attention** `.attn-row.bare`: a warning row leads with the glyph and subject, no "Warning"
  pill (EXPERIENCE §11.3); a danger row keeps its pill. In a list that mixes the two, the rows'
  columns differ, so a mixed list (products.home's Needs attention, commerce, the products
  overviews) still draws the pill until the lead picks a mixed-row layout.
- **SignedBadge** `.signed-badge`, **meta dots** `.meta-seps`, **rating** `.rating > .ic-star`, and
  `.meter > i.cur` (an outlined current segment in the accent's text tone, 3:1 against to-do
  segments in both themes).
- **Card heads** `.card-head.one-line`: a short title and one short text action stay on one line on a
  narrow card (a rail card's Open Sales). **Stacked labels** `.cell-label.on-chip` centre on a 24px
  chip value (a release track tag).
- **Disclosure card** `.card.fold-row`: the whole row is the button; chevron in the media column,
  title and the folded names on the text column.
- **Portal hero action** `.portal-hero-action`: from 640px the download for the visitor's device
  (what it is over a large primary) on the hero's right; under 640 it hides and the list tints the
  phone's own row instead (never a second panel repeating it).
- **For the lead: portal width at wide.** "Wide and desktop draw the same centred column" (Customer
  portal, Page) conflicts with the owner's 2026-10-08 rule that wide uses the width.
  `distribution.download-page` alone sets `--portal-max: 1440px` (and the page's max width) from
  1600px, with its platforms in two columns; every other portal screen still caps at 1248.

## Dashboard with a rail (products.overview-a)

```html
<div class="page">
  <header class="page-head">…</header>
  <div class="dash">
    <div class="dash-main">
      <section class="card alert" aria-label="Needs attention">…</section>
      <section class="card">…checklist…</section>
    </div>
    <div class="dash-rail">
      <section class="card">Features</section>
      <section class="card">Recent activity</section>
    </div>
  </div>
</div>

<!-- a feature checklist: the feature, its app paths, one mark per planned platform -->
<div class="checklist">
  <div class="check-row next">
    <div class="check-feature">
      <span class="icon-tile sm" data-service="release"
        ><i class="svc"></i
      ></span>
      <span class="check-name">Ship builds</span
      ><span class="check-sub">First CI publish Oct 6</span>
    </div>
    <span class="links"
      ><a class="link" href="#">Drop-in kit</a
      ><a class="link quiet" href="#"
        >Your own UI<i class="ic ic-arrow-up-right"></i></a
    ></span>
    <span class="plats"
      ><span class="plat after-step" title="macOS: After the console step"
        ><i class="ic ic-apple"></i> <span class="plat-name">macOS</span
        ><span class="sr-only">: After the console step</span></span
      >…</span
    >
    <div class="check-next">
      <button class="btn primary sm">Add Sparkle signing key</button>
    </div>
  </div>
</div>

<!-- per-platform counts in the card head; a platform never seen carries its one action -->
<div class="plat-tallies">
  <div class="plat-tally">
    <span class="platform-name"><i class="ic ic-apple"></i>macOS</span>
    <div class="progress success" style="--v: 40%"></div>
    <span>2 of 5</span>
  </div>
  …
</div>
```

- **`.dash`** is a main column and a rail. Desktop (1280–1599): one 360px rail column. Wide: the
  rail is two columns side by side, so the main column keeps a readable measure and the page
  stays one screen tall. 720–1279: the rail's cards sit two up under the main column. Phone: one
  column in source order. Every gap is `--section-gap`; cards in either column title at the block
  step. Urgent blocks go in `.dash-main`, facts and history in `.dash-rail`. (`.mk-with-rail` is
  the same idea for config screens, with one rail column at every width.)
- **`.card.alert`**: the page's one attention item without a head (the pill names it): a 3px
  warning edge and a light warning wash (`.danger` for an error). From 560 to 899px of card
  width the pill, subject and action share the first line and the message runs under them. Two
  or more items take the usual "Needs attention" head and count. An `.attn-row` may end in a
  `.btn.sm` (outline).
- **`.checklist`**: one `.check-row` per enabled feature. The feature (28px tile, name, at most
  one line of what's left: an `.open-step` link or a state), then `.links`, then `.plats`. Every row
  has the same paths and platforms, so they line up down the list. A row is done when all its
  marks are green. `.check-row.next` is the first open step: a 3px accent edge, an accent wash and
  the page's one primary in `.check-next`. Under 680px of card width the name and the marks share
  the tile's line and the paths and the step drop under the name.
- **`.plat`**: a platform's Verified state as a 24px mark: `.verified` (tick, success tone),
  `.waiting` (clock), `.after-step` (open ring), `.unseen` (dashed ring, no fill). Not a pill: the
  time is its tooltip and the state its `.sr-only` text. On a narrow card the name gives way to
  the platform glyph.
- **`.stat.off`**: a fact row for a feature that is off (Commerce): muted, its glyph grey.

## Guided setup (products.overview-c)

Appended for the guided-setup exploration of the Overview; all on the scale.

```html
<ol class="guide" aria-label="Integration steps" style="--guide-steps: 5">
  <!-- one step per feature, on a rail -->
  <li class="guide-step done">
    <div class="guide-row">
      <span class="guide-mark"></span>
      <div class="guide-title">
        <h3><button aria-expanded="false">Licensing</button></h3>
      </div>
      <span class="plat-badges"
        ><span
          class="plat-badge verified"
          role="img"
          aria-label="macOS: Verified Oct 7, 10:42"
          ><i class="ic ic-apple"></i
        ></span>
        <span
          class="plat-badge unseen"
          role="img"
          aria-label="Windows: Not seen yet"
          ><i class="ic ic-windows"></i></span
      ></span>
      <i class="ic ic-chevron-right guide-chevron"></i>
    </div>
  </li>
  <li class="guide-step current open">
    <div class="guide-row">
      …<span class="guide-sub">First CI publish Oct 6</span>…
    </div>
    <div class="guide-body">
      <div>In the console …</div>
      <div>Drop-in kit …</div>
    </div>
  </li>
  <li class="guide-step waiting">…</li>
  <li class="guide-step">
    …<span class="guide-sub"
      ><a class="link" href="#">Set storage per account</a></span
    >…
  </li>
</ol>
<div class="mk-pair">
  <section class="card">…</section>
  <section class="card aside span-3">…</section>
</div>
<div class="stats strip compact cols-3">
  …
  <div class="stat off" data-service="commerce">…</div>
</div>
<section class="card warning">…</section>
<div class="list-row wide-only">…</div>
```

- **`.guide`**: steps on a rail. `.done` (green tick, green rail after it), `.current` (accent ring;
  its row and its `.guide-body` share one tint, so the row reads as the pane's tab), `.waiting`
  (neutral clock), none (open ring: a console step is open). The 20px mark sits in the 28px media
  column; rows are `--row-h`. On a card of 560px and up the open step's `.guide-body` is a pane
  beside the 380px list, its parts side by side when each gets 300px; under 560px it is an
  accordion (the body under its row, a chevron on each row). `--guide-steps` is the number of steps.
- **`.plat-badge`**: a platform glyph on a 28px tile with its Verified state as a corner mark:
  `.verified` (green tile, tick), `.waiting` (clock), `.after` (open ring), `.unseen` (dashed, no
  mark). A tile, not a pill (a healthy state never takes pill shape); always `role="img"` with the
  full state as its name.
- **`.mk-pair`**: two blocks about 2:1 that wrap to one column; inside `.page.columns` at wide it
  opens up, so its `.aside` child goes to the aside and the other stays in the main column. Its
  cards title at the block step.
- **`.stats.strip.compact`** (16px rows, value at 18/24, cells on the card's inline edge) and
  **`.cols-3`** (three by two; two columns under 680px; rows under 560px). `.stat.off` mutes a
  feature that is off.
- **`.card.warning`**: a warning border for a card that holds attention. **`.wide-only`**: hidden
  below 1600px (extra list rows an aside has room for).

## Status board (products.overview-b)

A hero band over a board of feature cards. `--board-cols` (3 from 1280px, 2 from 640px, 1 on
phone) sets the board's columns and the hero's side pane, so the pane sits exactly on the
board's last column (at wide, inside the main column beside the aside).

```html
<div class="card hero attention">
  <!-- .attention: a warning wash while the next step is an issue -->
  <div class="hero-main">
    <header class="page-head">…logo, h1, slug, identity line, ⋯…</header>
    <section class="mk-stack-5" aria-labelledby="next">
      <h2 id="next" class="sr-only">Next step</h2>
      <div class="mk-stack-3">
        <div class="mk-cluster-3">
          <span class="pill warning">…</span><span class="attn-subject">…</span>
        </div>
        <p class="hero-statement">
          Required secret <code>…</code> has no value in the Default profile.
        </p>
      </div>
      <div class="mk-cluster">
        <a class="btn primary lg" href="#">Set secret</a>
      </div>
    </section>
  </div>
  <section class="hero-side" aria-labelledby="int">
    …a gauge: .meter-head per platform…
  </section>
</div>

<div class="feature-board">
  <article class="card feature-card">
    <!-- .issue: warning edge; .off: dashed, a feature that is off -->
    <div class="feature-card-head">
      <span class="icon-tile sm" data-service="license"
        ><i class="svc"></i
      ></span>
      <h3><a href="#">Licensing</a></h3>
    </div>
    <div class="feature-card-stat">
      <span class="stat-value">240 <small>licenses</small></span
      ><span class="stat-foot">Standard · 3 waiting</span>
    </div>
    <div class="feature-card-well">
      <!-- the sunken layer: one .well-row per question, the same rows in every card -->
      <div class="well-row">
        <span class="platform-name"><i class="ic ic-polaris"></i>Console</span
        ><span class="status">…Done</span>
      </div>
      <div class="well-row">
        <span class="platform-name"><i class="ic ic-app-window"></i>App</span
        ><span class="links">…</span>
      </div>
      <div class="well-row">
        <span class="platform-name"><i class="ic ic-apple"></i>macOS</span
        ><span class="verified">Verified</span>…
      </div>
    </div>
  </article>
  <article class="card feature-card off">
    …
    <div class="feature-card-foot"><span class="link">Turn on</span></div>
  </article>
</div>
```

- **`.hero`**: a card in two panes; `.hero-main` (identity 32 above the next step) and
  `.hero-side` (sunken, a hairline between), stacked on phone with the primary full width.
  `.hero-statement` is the block step (18/24) at regular weight, 56ch at most.
- **`.feature-card`**: the title's link stretches over the card (hover fill, focus ring on the
  card); the well's links sit above it. The stat area keeps a value-and-foot height, so wells in a
  board row start on one line. Put `data-service` on the icon tile, not the card, so links keep
  the console accent.
- **`.well-row`**: an 80px label (muted, with its glyph) and a state, 8 apart.
- Phone: each card is one line of name and value (as a narrow stat strip), the foot under the
  name, then the well.

## Rails, editors and record lists (config screens)

Layout primitives for a page with secondary cards beside its main block, and for an editor (a list
of records, the open record, a rail). `config.effective`, `config.entry-setting` and
`config.profile` are the references.

```html
<!-- main + rail: 320px rail (400 at wide), --section-gap between; below 1280 the rail drops under, its cards side by side -->
<div class="mk-with-rail">
  <div class="mk-main">…blocks, --section-gap apart…</div>
  <!-- or one card, or a .section (toolbar + table) -->
  <div class="mk-rail">
    <section class="card">…</section>
    <section class="card">…</section>
  </div>
</div>

<!-- editor: 240px list (260 at wide) · the open record · rail (beside it at wide only) -->
<div class="mk-editor">
  <nav class="card list-nav mk-editor-list" aria-label="Catalog entries">
    <div class="search-field">
      <i class="ic ic-search"></i><span>Search entries</span>
    </div>
    <p class="list-nav-label">Quality<span class="end">4</span></p>
    <a class="list-nav-item mono active" href="#" aria-current="page"
      ><i class="ic ic-sliders-horizontal"></i><span>quality.floor</span></a
    >
    <a class="list-nav-item two" href="#"
      ><i class="ic ic-layers"></i
      ><span
        ><strong>Default</strong><small>Applies to everyone</small></span
      ></a
    >
    <div class="list-nav-foot">…a key, Add entry…</div>
  </nav>
  <div class="select mk-editor-switch">…Entry quality.floor · 1 of 23…</div>
  <!-- phone only: the list folds into it -->
  <section class="card">…the open record…</section>
  <div class="mk-rail">…</div>
  <!-- optional -->
</div>
```

| Primitive       | Wide ≥ 1600                  | Desktop 1280–1599                    | Tablet 1024–1279                    | Phone < 640            |
| --------------- | ---------------------------- | ------------------------------------ | ----------------------------------- | ---------------------- |
| `.mk-with-rail` | main + 400 rail              | main + 320 rail                      | rail under main, cards side by side | one column             |
| `.mk-editor`    | 260 list · record · 400 rail | 240 list · record; rail under record | same                                | switcher, record, rail |

- Cards in `.mk-with-rail`, `.mk-main`, `.mk-rail` and `.mk-editor` are page-level blocks, so they
  title at the block step (18/24) like a card straight on `.page`.
- **`.list-nav`**: items 32px (`.two`, a name over one line: 56), 8 inside the card, the group
  label 12 above its items; the open item is a neutral fill with a 2px strong edge, never the
  accent alone; `.mono` for keys; a trailing `.dot` or glyph marks a changed item. The foot sits
  under a hairline.

Small components on the same scale:

```html
<div class="icon-line">
  <i class="ic ic-plus"></i><span>Text that may wrap hangs past the glyph</span>
</div>
<div class="fixed-value">
  <i class="ic ic-lock"></i><span class="mono">ES256</span
  ><span class="meta">Set by the template</span>
</div>
<del class="diff-old"><span>1 hour</span></del>
<ins class="diff-new">12 hours</ins>
<div class="choices cols-3">…</div>
<!-- .cols-2; one column on a card under 560px -->
<span class="chip"
  >flac<span class="chip-note">10 set it</span><i class="ic ic-x"></i
></span>
```

- **`.icon-line`**: the glyph centres on the first 20px line, 8 from the text; use it for facts,
  notes and errors that wrap (a callout's list, a drawer foot's error).
- **`.fixed-value`**: a value a form shows but can't change (set at publish, or by a template); as
  tall as a control so it lines up with the inputs beside it.
- **`.diff-old` / `.diff-new`**: a changed value, struck in a danger tint with a drawn −, then the
  new one bold in a success tint with a +, so the change reads without colour.
- **`.choices.cols-2` / `.cols-3`**: fixed columns of choices; each title keeps clear of the tick.
- **`.chip-note`**: who uses a chip's value, after a hairline.

Two more for config's second spacing pass:

```html
<div class="page capped">
  …
  <div class="mk-editor">…list · record, no rail…</div>
</div>
<div class="mk-pair loose">
  <section class="card">In your game</section>
  <section class="card aside span-3">Limits</section>
</div>
```

- **`.page.capped`**: an editor with no rail (a list and one record). At wide the page caps at
  1280px, left-aligned like `.page.narrow`, so the record keeps the ~900px it has beside a rail
  instead of stretching fields and code across 1300px. Below 1600px it changes nothing.
  `config.entry-minted-token` is the reference.
- **`.mk-pair.loose`**: a pair of page-level blocks, `--section-gap` apart side by side and
  stacked, so the pair keeps the page's rhythm (the plain pair is 16 apart). In a `.page.columns`
  at wide its `.aside` block goes to the aside as usual. `config.cloud-sync` (Limits in the aside)
  and `config.cloud-sync-usage` are the references.

## Records, values and unsaved edits (entitlements screens)

A record page (a tier, a license, an add-on): its facts with where each value comes from, a
timeline of what happens to it, and one save bar for its unsaved edits. `entitlements.duration`,
`entitlements.addon` and `entitlements.license-subscription` are the references.

```html
<span class="icon-text"><i class="ic ic-repeat"></i>Renews Oct 3</span>
<!-- a glyph and its words; .warning -->
<span class="icon-text inline"><i class="ic ic-toggle-right"></i>On/off</span> ·
Opens the pack
<!-- inside a sentence -->
<span class="val-on">On</span> <span class="val-off">Off</span>
<!-- an on/off value -->
<span class="source">Pro</span> <span class="source own">Set here</span>
<!-- where a value comes from -->
<dl class="kv-rows">
  <div>
    <dt>Device limit</dt>
    <dd>10<span class="source own">Set here</span></dd>
  </div>
</dl>
<ol class="timeline">
  <li class="timeline-item">
    <span class="timeline-when">Oct 7, 2026</span>
    <span class="timeline-what">Starts</span
    ><span class="timeline-desc">…</span>
  </li>
</ol>
<!-- .warning .ended .later -->
<div class="setting-row dense">
  <div>
    <div class="setting-title">Synced crates</div>
    <div class="setting-desc mono">crates</div>
  </div>
  <div class="input sm unit">
    <span class="grow tnum">500</span><span class="affix">crates</span>
  </div>
</div>
<div class="card-row">
  <button class="btn link"><i class="ic ic-plus"></i>Add an entitlement</button>
</div>
<label class="field-label">Offline days<span class="was">was 30</span></label>
<div class="input changed">…</div>
<div class="save-bar" role="region" aria-label="Unsaved changes">
  <p class="save-bar-msg"><i class="ic ic-info"></i><span>…</span></p>
  <button class="btn ghost">Discard</button
  ><button class="btn primary">Save Pro</button>
</div>
```

- **`.icon-text`**: a 14px glyph 8 from its word, in the subtle colour (a `.svc` keeps its accent);
  several in a row go in a `.mk-cluster-4`. Inside a sentence add `.inline`, so its words sit on
  the sentence's baseline instead of riding above it.
- **`.kv-rows`**: one fact per 40px row, the label in a 128px column, the value and its `.source`
  on one baseline. **`.dl.cols`** is the same facts as a grid when there are only a few.
- **`.setting-row.dense`**: a settings row whose text is a title over one line (a label over its
  key): 8 above and below, so it is 56 high, the table's row height. A list of entitlements with
  their controls uses it; a setting with a sentence of description keeps the plain 16.
- **`.input.unit`**: a number with its unit in a row (500 crates, 200 MB, +2): 128px, never
  stretched, so a column of them lines up and the value never truncates. (`.input.short` is 96px,
  for a value with a short unit or none: 14 days, 4.x.)
- **Add in a list**: the list's last row is a `.card-row` holding a `.btn.link` with a plus, so the
  glyph starts on the text edge of the rows above it (a ghost button would indent it by its own
  padding).
- **Unsaved edits**: a changed field takes `.changed` (the accent ring) and its label a `.was`; one
  `.save-bar` per record, drawn at the end of the page: what changed, its effect in numbers, then
  Discard and "Save <name>". On phone the message is its first line and the two buttons share the
  second.
- **`.card-row.top`**: a row whose text runs to several lines keeps its media, count and buttons
  on the first line. **`.mk-with-rail.equal`**: the main card and the rail's one card share a row
  at equal height; use it only when the two are close in height, never to stretch a short card.

## Feature rows, requirements and choices (products screens)

```html
<section class="card">
  <div class="feature-rows-head" aria-hidden="true">
    <span>Feature</span><span>Status</span>
  </div>
  <div class="feature-rows">
    <div class="feature-row">
      <!-- .off: a feature that is off -->
      <span class="icon-tile sm" data-service="config"
        ><i class="svc"></i
      ></span>
      <div class="feature-row-text">
        <div class="feature-row-name">Managed config</div>
        <p class="feature-row-desc">…</p>
        <div class="reqs">
          <span class="req" aria-label="Cloud Sync needs Managed config"
            >Needed by Cloud Sync</span
          >
        </div>
      </div>
      <div class="feature-row-status">
        <div class="status-stack">
          <span class="status"
            ><i class="ic ic-circle-check"></i>Catalog v6 published</span
          ><span class="meta">…</span>
        </div>
      </div>
      <span
        class="switch touch on"
        role="switch"
        aria-checked="true"
        aria-label="Managed config"
      ></span>
      <div class="feature-subs"><div class="setting-row">…</div></div>
      <!-- the feature's own settings; .setting-row.off dims one -->
    </div>
  </div>
</section>
<div class="reqs">
  <span>Needs</span
  ><span class="req met" aria-label="Managed config is on">Managed config</span>
  <span class="req unmet" aria-label="Sign-in is off">Sign-in</span>
</div>
<div class="choices multi cols-3" role="group">
  <div class="choice on" role="checkbox" aria-checked="true">
    <div class="choice-title">
      <span class="icon-tile sm" data-service="license"
        ><i class="svc"></i></span
      >Licensing
    </div>
    <div class="choice-desc">…</div>
    <div class="choice-foot">
      <b>Turns on</b> tiers, licenses and device limits
    </div>
  </div>
  <div class="choice locked" role="checkbox" aria-disabled="true">
    …
    <div class="reqs">…</div>
    <div class="choice-foot">…</div>
  </div>
</div>
<div class="change-list">
  <div class="change-item">
    <span class="icon-tile sm" data-service="license"><i class="svc"></i></span>
    <div class="change-title">Licensing</div>
    <span class="change-to">On<i class="ic ic-arrow-right"></i>Off</span>
    <p class="change-text">…</p>
    <p class="meta">…</p>
  </div>
</div>
<div class="card-split stack-narrow">…</div>
<!-- also stacks on a narrow card -->
<button class="btn ghost phone-inline"><i class="ic ic-x"></i>Cancel</button>
<!-- in .page-actions -->
```

- **Feature rows** (Settings → Features): the 28px media column · the text (3fr) · the status
  (at least 15rem, 2fr, 24 after the text) · the switch. Rows pad 20 × card-px; the glyph, the
  status's first line and the switch centre on the name's 24px line. Name 16/24 (the card step),
  description 13/20, requirements 12/16 8 below. `.feature-rows-head` names the columns like a
  table header (40 high, 13/20 700, the tinted band) and hides on a narrow card. `.feature-subs`
  is the feature's own settings in a sunken box from the text column to the switch column. Under
  560px of card the status drops under the text, the switch stays top right, the box takes the
  full width, and (under 480) a segmented control drops under its text.
- **Requirements** (`.reqs > .req`, scoped to `.reqs`, so `.domain.req` is untouched): a plain
  `.req` is the reverse direction with a link glyph ("Needed by Commerce"); `.met` a tick; `.unmet`
  a lock, bold. A 14px mark 4 from its word, items 8 apart. Never colour alone: each mark's state
  is in its `aria-label`. Say "Needs Licensing", never "Needs Licensing, which is chosen": the
  tick already says so.
- **`.choices.multi`**: a multi-select (role=checkbox) with rounded-square checks centred on the
  28px title tile. `.choice.locked` can't be chosen yet: dashed, a lock in the check's place, the
  words dimmed and the requirements at full contrast. `.choice-foot` is what choosing it turns
  on, after a hairline, pinned to the bottom so the feet line up across a row.
- **`.change-list`**: what a confirmation changes, one row per thing: its tile, its name and
  "On → Off" on the first line, then one sentence and a meta fact on the text column.
- **`.card-split.stack-narrow`**: the two panes also stack on a narrow card (under 560px: the
  400px aside, a half-width cell). A plain `.card-split` stacks only on phone.
- `.phone-inline` keeps a header text action on the title row on phone (a wizard's Cancel);
  `.switch.touch` is 44×24 on phone; `.regular` is 400 inside a bold line ("Optional" after a task
  title). A narrow card's head that holds only its icon tile and title keeps the title beside the
  tile.
- **`.sidebar-frame`**: a console sidebar drawn on its own on a board (sidebar contexts), with
  `.drawer` for the phone menu drawer over a dimmed page sketch.
- `products.features`, `products.new-product`, `products.turn-off-licensing` and
  `products.sidebar-contexts` are the references.

## Boards, the docs site and drop-in kits (sdk screens)

Pages of code, terminals and in-app frames, on the console's rhythm. `sdk.start-call`,
`sdk.pkey-doctor`, `sdk.docs-first-product`, `sdk.react-sign-in` and `sdk.swiftui-activate` are
the references.

```html
<div class="board">
  <div class="board-page">
    <header class="board-head">
      <h1>…</h1>
      <p>…</p>
      <div class="callout info">…</div>
    </header>
    <div class="board-grid">
      …
      <div class="board-col">…sections…</div>
      …
    </div>
    <!-- per-size columns -->
    <div class="board-aside">…cards…</div>
    <!-- side by side from 360 each -->
    <div class="frame-grid windows top">
      <!-- desktop windows -->
      <figure class="board-item">
        <div class="window win">…</div>
        <figcaption><strong>1 · Sign in.</strong> …</figcaption>
      </figure>
    </div>
    <div class="frame-grid devices">
      <!-- phones -->
      <figure class="board-item">…portrait…</figure>
      <div class="frame-stack span-2">
        <figure class="board-item hide-phone">…landscape…</figure>
        <figure class="board-item">…code…</figure>
      </div>
    </div>
  </div>
</div>
```

- **`.board-page`**: the head, then blocks `--section-gap` apart, `--page-max` wide. The head is
  the page-step title, an optional lede (at most one 72ch sentence naming what is drawn; see
  "Board copy"), and an optional callout (a fixture note) 16 under it.
- **`.board-head.split`**: from 1280 to 1599 the head is two columns, the title, lede and callout
  beside a code figure (`<figure class="board-item board-head-side">`), so a board's code panel
  never sits alone in a last row; below 1280 the figure stacks 16 under the callout. When the
  frame grid has room for the code at wide, mark the head's figure `.hide-wide` and put its twin
  in the grid as `.wide-only` (sdk.react-sign-in).
- **`.board-grid`**: one column by default. A screen sets the grid template per size with
  `--cols-tablet`, `--cols-desktop`, `--cols-wide` (a template, never a spacing); `.first-narrow`
  puts a column first while the grid is one column. Below 1280 an 80-column `.term.cols-80` fills
  its column, so it lines up with the cards under it.
- **`.frame-grid`**: frames share a row at least 440 wide, captions under them at 72ch.
  `.windows` (sign-in boards): each figure is a two-row subgrid, window then caption, so window
  bottoms and caption tops line up across a row, and every window on the board takes one height,
  the tallest step's at that size (the app's window doesn't resize between steps; the foot sits at
  the bottom). Shorten the tallest step to shorten them all. `.windows.top` keeps each window's own height, tops aligned (activation frames,
  which have no foot, so a short one is never an empty stretch of window). `.devices`: fixed 422
  cells, four at wide, three at desktop, two at tablet, one on phone; rows fill densely, so a
  portrait phone backfills the hole beside the first one when a landscape can't fit (tablet).
- **`.frame-stack`**: frames that share one cell, 40 apart (the grid's row gap): two landscape
  phones, or a landscape phone and the code, in a `.span-2` beside a portrait phone, so a short
  frame never leaves a hole under it.
- **`.kit-welcome`**: a drop-in window: the product's art beside the form from 560px of window
  (2:3; 1:2 under 720, so a window three up on a wide board keeps a 360px form), a 112px band
  above the form when narrower. A sign-in code (`.kit-code`) never breaks; a long key in
  `.kit-input.wrap` splits into even lines.
- **Docs** (`.docs`): the top bar, the sidebar, then a 760px article beside the 200px On this
  page. `.docs-steps` numbers the steps on a rail. `.lanes` is the two integration paths as equal
  lanes under one SDK tab row, "Drop-in UI kit" and "Your own UI on the library", side by side and
  stacked on phone. `.docs-cards` links the feature guides; `.docs-dl` is a short definition list.

Added by the sdk multi-review (2026-10-08), appended at the end of `mockup.css` in the
`sdk-multi-review` block; no earlier rule was edited:

- **`.cmd.one-line`**: a command that never wraps at any size. The row stays 40 high with `$` on
  the line, the command scrolls inside it, and its last 24px fade under the copy button, so an
  argument is never split at `-` or `@` (sdk.start-call's `pkey sdk add … --expect kid@sha256:…`).
- **`.span-all`** on a `.frame-grid` child: a card that closes a board across every column (Other
  answers). **`.span-2-desktop`**: two columns from 1280 to 1599, one at wide and tablet (a cell
  beside the last frame of a three-up desktop row).
- **`.hide-wide`**: hidden from 1600; the twin of a `.wide-only` block placed elsewhere at wide.
- **`.card-answers`** (`.card-answer` > `.card-answer-label`, the message, optional actions):
  answers that share one place in a flow. Rows of label · message · actions (160px label column)
  in a wide card, side by side from 1440px of card (label over message), stacked under 560.
- **Board cards title at the block step**: a card in `.board-aside`, or straight on
  `.board-page`, titles at 18/24 like the sections beside it. (`.board-col > .card` is left at
  16/24 for now: admin.cli-login draws its How it behaves card there, and changing it would
  restyle another area's screen.)
- **Terminals**: `.term-bar` is a 52 · title · 52 grid, so a long title ends in an ellipsis and
  never runs onto the dots. Inline code on boards (`.board-note`, `.bullet-list`) and in the docs
  article never splits (`polaris-key.json` stays whole).
- **Footnotes and tables**: a `.code-foot` or `.table-foot` glyph sits on the note's first line;
  a `.table` that opens or closes a `.card` rounds its header's (or last row's) outer corners to
  the card's, so the header tint follows the corner.
- **Docs**: `.lanes` rows are a subgrid (title, description, code, link), so code heads and links
  line up across the two lanes. `.docs-bleed` widens a step's figure to 920px at wide, right edge
  on the article's (the lanes and step 5's terminal, so wide Swift lines need no manual wrap; the
  wrapped and whole versions are `.hide-wide` / `.wide-only` twins). On this page folds into the
  44px bar from 1024 to 1279 too, its words on the article's edge. Under 640 a step's number is a
  24px badge 8 before its title; the rail is hidden and the body runs the full width.
- **In-app kit**: an errored `.kit-input.bad` has a 1.5px inset danger border over its tint (and
  keeps its ⊗ row), so an error never reads as a red product accent. `.kit-pill.neutral` is a
  neutral fact (Recommended): the fill with a dot, never the product accent. A license row
  (`.kit-option`) is the same in every kit: the title is where the license came from (Automatic
  grant, Steam purchase, Gift, Key ending …) and never wraps; the tier is a pill; the meta line is
  devices · duration, and a full license says `<span class="warn">No free devices</span>` in that
  slot, in the warning colour, instead of an end tag.

Added by the sdk spacing multi-review (2026-10-08), appended at the end of `mockup.css` in the
`sdk-spacing-multi-review` block; no earlier rule was edited:

- **`.board-head.rhythm`**: title, an optional one-line lede only when it adds a fact, then 24px to the
  first block. Rhythm on boards: 12px H2 to card, 16px between cards, 32px between sections.
- **`.callout.one-line`** in a `.board-head`: the fixture note as a compact one-line chip
  (`<strong>Kit preview:</strong> …`), never a 700px box.
- **`.board-aside.stack`** (one column, top-aligned) and **`.join-phone`** (the stacked cards are one
  card on a phone); **`.symbol-key.two-col`** (two pairs per row at tablet and wide).
- **`.board-item.cap-top`**: the caption is a label 8px above its window (`figcaption` is ordered first).
  Use a state label (strong) plus at most one clause, 13px.
- **`.wrap-phone`** on a `.code`, `.term` or `.cmd.one-line`: on a phone the mono block wraps
  (`pre-wrap`, `overflow-wrap:anywhere`, 12px/18px) and a `.cmd`'s Copy takes its own full-width 32px row.
  **`.table.sdk-reads`** and **`.table.sdk-checks`**: compact phone tables (fixed layout, 12px, small-caps
  header).
- **`.kit-welcome.fit`**: a drop-in window sized to content (min 380, not 560); art column
  `clamp(120px, 28%, 175px)` from 560px of window, a 56px strip below that and at tablet and narrower
  boards; form capped at 560px; key field 56px in every state; the last `.kit-actions` at the bottom.
  **`.frame-grid.cap-strip`**: captions share a two-line strip. **`.frame-grid.windows.top.fit-rows`**:
  windows in a row take the tallest content height (no board-wide height).
- **`.span-all.fill-4`** (takes the spare cell of a four-up device row at wide), **`.frame-stack.span-3-wide`**,
  **`.device.landscape.land-safe`** (24px more inset from the notch), **`.kit-form.safe-bottom`** (the
  last action 24px above a phone frame's bottom), **`.kit-scrim.soft`** (about 30% dim behind a sheet).
- **`.on-edge`** on a `.docs-section` or `.docs-foot`: starts on the steps' content edge so prose,
  figures, tables and the pager share one left edge. `.docs-bleed` is no longer used on
  `sdk.docs-first-product` (breakouts stay inside the column).

Kit changes from the lead's list not made because they change an existing value: card chrome (header 44,
16px padding, 28px rows), terminal side padding 10/16, grid `align-items:start` defaults for
`.frame-grid.windows`, `--mk-term-dim` in light (`#6b7389` to about `#596177`), caption and footer type to
12px in the secondary token, the Recommended badge at 11px/600, and a docs measure token. Each needs the
lead to flip an existing default.

## Sign-in, connections and accounts (identity screens)

The hosted sign-in card, connection records, account rows and a long settings page with its own
nav. `identity.sign-in`, `identity.consent`, `identity.connection`, `identity.connected-apps` and
`identity.app-sign-in` are the references.

```html
<!-- the hosted card: lockup, card, legal links on the star field; 456 wide, edge to edge on phone -->
<div class="hosted" data-service="core">
  <div class="hosted-brand"><i class="pk-mark sm"></i>Polaris Key</div>
  <main class="hosted-card">
    <header class="hosted-head">
      <span class="logo lg" data-product="djdl"></span>
      <div class="grow">
        <div class="hosted-title">
          <strong>DJDL</strong> wants you to sign in
        </div>
        <div class="hosted-sub">
          <span>Example Audio</span><span aria-hidden="true">·</span
          ><span><i class="ic ic-monitor sm"></i>on Studio Mac mini</span>
        </div>
      </div>
    </header>
    <div class="hosted-body">
      <!-- one column, 16 apart; a lede 8 under the h1 -->
      <h1>Sign in</h1>
      <p class="hosted-lede">…</p>
      <div class="field">
        <label class="field-label">Email</label>
        <div class="input focus">
          <span class="ph"><span class="caret"></span>name@example.com</span>
        </div>
      </div>
      <div class="hosted-or">or</div>
      <div class="provider-row">
        <a class="provider" href="#" aria-label="Continue with Google"
          ><i class="gmark lg"></i></a
        >…
      </div>
      <div class="hosted-links"><a href="#">Have a license key?</a>…</div>
      <!-- .plain: no rule; a <span> is muted text -->
      <div class="hosted-actions">
        <button class="btn primary block">…</button><span class="hint">…</span>
      </div>
    </div>
    <footer class="hosted-foot">
      <i class="ic ic-lock sm"></i><span>…</span>
    </footer>
  </main>
  <nav class="hosted-legal">…</nav>
</div>

<span class="id-chip"><span>dana@example.edu</span><a href="#">Change</a></span>
<!-- the typed address -->
<div class="hosted-org">
  <span class="icon-tile muted"><i class="ic ic-building-2"></i></span>
  <h1>Lakeside University</h1>
</div>
<div class="person-row">
  <span class="photo lg"></span>
  <div class="person-row-text">
    <strong>Mara Fennick</strong><span>mara@…</span>
  </div>
  <a class="link" href="#">Not you?</a>
</div>
<div class="code-cells"><span>4</span><span class="on"></span>…</div>
<!-- six 56px cells -->
<p class="hosted-note"><i class="ic ic-info sm"></i><span>…</span></p>
<div class="hosted-list">
  <div class="hosted-row">
    <i class="ic ic-mail"></i>
    <!-- rows in a box, 56 high -->
    <div class="hosted-row-text"><strong>Your email</strong><span>…</span></div>
    <span class="switch"></span>
  </div>
</div>
<div class="check-list">
  <span class="check"><span class="box"></span><span>I agree to …</span></span
  >…
</div>
<div class="pick-tiles">
  <div class="pick-tile on">
    <span class="photo lg badged"><i class="gmark sm"></i></span
    ><span>Google</span><span class="meta">In use</span>
  </div>
  <div class="pick-tile add">
    <span class="pick-media"><i class="ic ic-upload"></i></span
    ><span>Upload</span><span class="meta">PNG or JPEG</span>
  </div>
</div>
```

- **Hosted card.** Fields and block buttons are 48 (the card's touch size), the h1 is the stat
  step (24/32), field labels the small step. Wide, desktop and tablet draw the same centred
  card; phone draws it edge to edge under a 56px lockup row, with the quiet links as full-width
  44px rows. A card on a board (`.frame-grid > .board-item > .hosted-card`) fills its cell.
- **Rows in the card.** `.hosted-row`: a 16px glyph on the title's line (centred when the row has
  one line), the title over one small line, the control at the end; a row with no glyph starts
  at the box's edge. `.raw` on the small line truncates a raw value (an address).
- **Picking.** `.pick-tiles` are three across at every width; `.on` is the one in use, `.add` is
  dashed. `.check-list` boxes checks that are ticked together (terms); a check's meta line goes
  in a `.mk-stack-1` with its words.
- **Marks.** `.gmark` is Google's G in its own colours (`.sm` 14, `.lg` 24); `.photo` a drawn
  profile picture (24, `.lg` 40, `.xl` 48), `.badged` with its source's mark on the corner.

```html
<span class="domain req"
  ><i class="ic ic-shield-check"></i>example.edu<span class="domain-tag"
    >SSO only</span
  ></span
>
<!-- .wait: DNS pending -->
<dl class="record">
  <dt>Name</dt>
  <dd>
    <span>_polaris-key.music.example.edu</span
    ><button class="btn ghost icon sm">…</button>
  </dd>
</dl>
<tr class="detail">
  <td colspan="5">…the pending domain's record, right under its row…</td>
</tr>
<div class="choices fit">…</div>
<!-- three choices take the width -->
<span class="grant"><i class="ic ic-check"></i>Screen name</span
><span class="grant no"><i class="ic ic-eye-off"></i>Not your email</span>
<ol class="num-list alpha">
  …
</ol>
<!-- lettered, beside numbered pins -->
```

- **Grants** are what an app gets from an account: quiet 24px chips, a tick for granted, dashed
  with eye-off for declined. Facts, not states, so never pill-toned.
- **Account rows** (`identity.connected-apps`): `.item-row.top` led by a product's `.logo.sm`
  (centred on the title's line), the grants in `.item-more`, then `.item-end.fill`: a wide card
  keeps the actions at the end of the first line, a narrow one reads text, grants, then each
  button on a full-width row.

```html
<!-- a long settings page with its own nav: 200 nav · body (max 960) · aside at wide -->
<div class="with-toc">
  <nav class="jump-nav">…</nav>
  <!-- optional: the pills below 1280 -->
  <nav class="toc-nav">
    <p class="eyebrow">On this page</p>
    <a class="on" href="#s-status">Status</a>
    <a href="#s-methods"
      >Sign-in methods<span class="dot" aria-label="Unsaved changes"></span></a
    >…
  </nav>
  <div class="toc-body">…cards…</div>
  <div class="toc-aside">…secondary cards…</div>
  <!-- optional -->
  <div class="save-bar">…</div>
  <!-- optional: rests under the body -->
</div>
<div class="card-band">
  <p class="eyebrow">
    Inside the game<span class="end">Follows each store channel</span>
  </p>
</div>
<div class="setting-row changed">
  …
  <div class="changed-note">
    <i class="ic ic-pencil"></i>Not saved ·<a class="link" href="#"
      >Use the default</a
    >
  </div>
</div>
<div class="card-note"><div class="callout warning">…</div></div>
<!-- a caution about the row above -->
<div class="setting-title">Game Center<small>iOS</small></div>
<span class="share-line"
  ><span class="progress" style="--v: 48%"></span>Shared by 48% of players</span
>
<span class="swatch-chip"
  ><i style="--swatch: #ec4c55"></i>Accent<span class="mono"
    >#EC4C55</span
  ></span
>
```

| Primitive   | Wide ≥ 1600                       | Desktop 1280–1599              | Tablet and phone        |
| ----------- | --------------------------------- | ------------------------------ | ----------------------- |
| `.with-toc` | 200 nav · body · 400 `.toc-aside` | 200 nav · body, aside under it | one column; `.jump-nav` |

- Cards in `.toc-body` and `.toc-aside` are page-level blocks: they title at the block step. In
  the portal the body takes the rest of the 1248 page, so it ends where the header's actions end.
- **Dialogs over a page.** `.console.modal-open` (or `.portal.modal-open`) renders the first
  viewport, as a page with a dialog open can't scroll; `.overlay.center.sheet` centres the dialog
  and makes it a bottom sheet on phone.
- `.page.medium` (1200) caps a focused task with two panes; `.mk-grid-N.keep` keeps its columns
  on phone; `.dl.stack-narrow` puts each label over its value on a narrow card.

## Product overview (products.overview)

The final Overview: exploration B's hero and board on one column grid, so the hero, the board and
the last column share their edges, with exploration C's setup stepper (owner, 2026-10-08) as the
Integration steps in the last column under the hero's Integration pane.

```html
<div class="page">
  <div class="ov">
    <div class="ov-grid">
      <div class="card ov-hero attention">
        <!-- every column; .attention: 3px warning edge and wash -->
        <div class="ov-hero-main">
          <header class="page-head">…</header>
          <section class="mk-stack-5">…the next step…</section>
        </div>
        <section class="ov-hero-side">
          <!-- the last column: a sunken gauge -->
          <div class="ov-pane-head">
            <h2 class="type-card">
              <a href="#">Integration<i class="ic ic-arrow-right"></i></a>
            </h2>
            <button class="btn link quiet">Hide</button>
          </div>
          <div class="ov-gauge">
            <div class="meter-head">…macOS · 2 of 5 verified · bar…</div>
          </div>
          <p class="ov-seen">
            <i class="ic ic-code-xml"></i><span>Last seen 4 min ago · …</span>
          </p>
        </section>
      </div>
      <section class="section ov-main">
        …
        <div class="ov-board">
          <article class="card ov-feature">
            <!-- .issue .off -->
            <div class="ov-feature-main">
              <span class="icon-tile sm" data-service="license"
                ><i class="svc"></i
              ></span>
              <h3><a href="#">Licensing</a></h3>
              <span class="stat-value">240 <small>licenses</small></span
              ><span class="stat-foot">Standard · 3 waiting</span>
            </div>
          </article>
          …
        </div>
      </section>
      <section class="section ov-side span-rows">
        …
        <div class="card">
          <ol class="guide flat">
            …steps…
          </ol>
        </div>
      </section>
      <section class="section ov-main">…Recent activity…</section>
    </div>
  </div>
</div>
```

- **`.ov` / `.ov-grid`**: columns from the grid's own width, never the viewport: 4 from 1488px
  (360px columns and up), 3 from 976, 2 from 680, else 1. From 3 columns `.ov-main` takes every
  column but the last and `.ov-side` the last; `.ov-side.span-rows` spans two rows (the board's
  and the next `.ov-main`'s), so the hero's pane and the steps read down the last column. With 2
  columns the board takes both, then the block after the steps (column 1) sits beside the steps
  (column 2); in one column the source order holds. Rows are `--section-gap` apart, columns
  `--grid-gap`. No width cliff: a column never drops under about 300px.
- **`.ov-hero`**: the side pane is always the last column (its divider lines up with the last
  column), the panes stack under 800px of grid, and the lg primary is full width under 560.
  `.ov-gauge` is one platform: a `.meter-head` and one line under it. `.ov-seen` is pinned to the
  pane's bottom.
- **`.ov-board`**: `--ov-board-cols` columns. **`.ov-feature`**: the fact (`.ov-feature-main`:
  tile, name, number on the right, foot under the name; its link covers the card). Cards in a
  board row share a height; in one column a card is as tall as its lines. `.issue` warning border;
  `.off` dashed, only as tall as its line, with a `.link` in the number's place. (`.ov-feature-state`
  and `.current`, the per-card integration strip, stay in the kit for the explorations.)
- **`.guide.flat`**: the guided-setup stepper with no pane: rows only, each the step's mark, its
  name over at most one line of state or next action (one `.guide-sub` each; a second one holds
  `.links` for a step whose next work is in the app), and `.plat-badges`. No chevron, no row
  button: each link opens that feature on Integration. The mark and badges centre on the row's
  first 56px and a one- or two-line name block centres there too, so a taller row keeps its name
  level with its mark. Sub-line links keep a 24px target inside the 20px line.

## Toasts at the page's end, choice bodies, stacked facts (commerce screens)

```html
<div class="toasts at-end">
  <div class="toast success" role="status">
    <i class="ic ic-circle-check"></i>
    <div class="grow">
      <div class="toast-title">Commerce is on for DJDL</div>
      <div class="toast-text">…</div>
      <div class="toast-actions">
        <button class="btn outline xs">Undo</button
        ><button class="btn ghost xs">Open Storefronts</button>
      </div>
    </div>
  </div>
</div>
<div class="input medium">
  <span class="affix">$</span><span class="grow tnum">3.99</span
  ><span class="affix">USD</span>
</div>
<div class="choice on">
  <div class="choice-title">A new offer from …</div>
  <div class="choice-body mk-stack-2">
    <div class="mk-grid-2">…fields…</div>
    <span class="hint">…</span>
  </div>
</div>
<dl class="kv-rows stack-narrow">
  <div>
    <dt>Order</dt>
    <dd>
      <span class="id">GPA.3391-2284-1170-55120<i class="ic ic-copy"></i></span>
    </dd>
  </div>
</dl>
```

- **`.toasts.at-end`**: a toast about a row near the page's end (a switch just turned on) is
  drawn where it lands once the page has scrolled that row above it: at the page's end, bottom
  right, at every size, so it never covers a control; the page keeps clear of it.
  **`.toast-actions`**: Undo first, then the way on, 12 under the text, 8 apart.
- **`.input.medium`**: a value with its affixes (a price and its currency), 160px, never
  stretched (`.input.short`, 96px, is for a bare number).
- **`.choice-body`**: content under a choice's title (fields, a hint), 12 under it.
- **`.kv-rows.stack-narrow`**: on a card under 480px (a phone sheet) each label goes over its
  value, so a long value (an order id, an email) gets the row's full width.
- A channel's Sales tab is the channel page (`distribution.channel-app-store`): the xl store tile
  in `.page-icon`, the state beside the h1, then `.mk-with-rail`. A list of storefronts with one
  state each is `.item-row`s with the state and a chevron in `.item-end` (the chevron hides on a
  narrow card). Dialogs and drawers over a page use `.console.modal-open` and `.overlay.center`
  (`.drawer.scroll` keeps the head and foot in view). `commerce.features`, `commerce.sales` and
  `commerce.first-run` are the references.

## Account pages, packages tables and closing buttons (packages screens)

Small additions for `packages.portal-packages` (the portal's Account → Packages, the same frame as
`identity.connected-apps`), `packages.public-registry` and `packages.packs`. All on the scale.

```html
<!-- Account sections: the side nav from 1280px, the pill row from 640px, a picker on phone -->
<div class="with-toc">
  <nav class="toc-nav" aria-label="Account">
    …<a class="on" href="#" aria-current="page">Packages</a>…
  </nav>
  <nav class="jump-nav" aria-label="Account">
    …<a class="on" href="#">Packages</a>…
  </nav>
  <div
    class="select toc-select"
    role="button"
    aria-label="Account section: Packages"
  >
    <i class="ic ic-boxes"></i><span class="grow">Packages</span
    ><i class="ic ic-chevrons-up-down"></i>
  </div>
  <div class="toc-body">…cards…</div>
</div>

<!-- a stacked table keeps its group rows as tinted bands -->
<table class="table fixed stack-phone flow">
  <tbody>
    <tr class="group-row">
      <td colspan="3">…DJDL · Standard license</td>
    </tr>
    …
  </tbody>
</table>

<div class="code-tabs fade">…five tabs…</div>
<!-- scroll under a fade, clear of Copy -->
<div class="field fit">…a typed confirmation…</div>
<!-- at most 400px wide -->
<div class="card-foot actions">
  <button class="btn outline">Cancel</button
  ><button class="btn primary">…</button>
</div>
```

- **Sections that are pages.** A `.with-toc` holding both a `.jump-nav` and a `.toc-select` shows
  the pills from 640 to 1279px and the picker below 640px, where seven or eight pills don't fit and
  the open section would scroll out of view. With only a `.jump-nav` nothing changes.
- **Group rows on a narrow card.** In a `.table.stack-phone`, a `tr.group-row` stays one tinted
  band with its label on the card's text edge.
- **`.code-tabs.fade`**: tabs that may not fit fill the head and scroll under a fade that ends
  before its Copy (phone, a narrow block); where they fit, the fade falls on empty space.
- **`.field.fit`**: a field for a short typed value in a wide body, capped at 400px.
- **`.card-foot.actions`**: a card's closing buttons (Cancel, then the primary). On phone each
  takes the full width with the primary on top, as in a dialog's foot.
- For a short value over a sub line in a cell (a pill over a flag name, "Essential" over its
  note), use `.cell-stack`; `.status-stack` is for a status glyph and its hanging meta.

## People, roles and platform settings (admin screens)

The admin area's parts (`mockup.css`, between `BEGIN admin-kit` and `END admin-kit`). All on the
scale. `admin.members`, `admin.platform-settings` and `admin.cli-login` are the references.

```html
<!-- roles as tags; a narrowed role is one tag, its areas after a hairline -->
<span class="role-tags">
  <span class="role-tag super"><i class="ic ic-crown"></i>Superadmin</span>
  <span class="role-set"
    ><span class="role-tag"
      ><span class="logo xs" data-product="diceroll"></span>Diceroll admin</span
    >
    <span class="role-areas"
      ><i class="svc" data-service="release"></i>Ship builds</span
    ></span
  >
</span>
<span class="role-tags flow">…</span>
<!-- stays a wrapping row on a narrow card -->
<span class="faces"
  ><span class="avatar sm">NH</span><span class="avatar sm">FB</span></span
>
<span class="avatar pending"><i class="ic ic-mail"></i></span>
<!-- an invite: no sign-in yet -->

<!-- a row's ⋯ menu drawn open, with an item you can't use and why -->
<td class="row-menu">
  <div class="popover-anchor">
    …
    <div class="popover right">
      <div class="menu">
        <span class="menu-item disabled"
          ><i class="ic ic-lock"></i>Remove from console</span
        >
        <p class="menu-note">
          The root rule gives this role. Take Jonas out of polaris-admins at
          Pocket ID instead.
        </p>
      </div>
    </div>
  </div>
</td>

<div class="token-field focus">
  <span class="token">hana@example.com<i class="ic ic-x"></i></span
  ><span class="caret"></span>
</div>
<div class="field-row">
  <span class="field-row-label">Signs in with</span>
  <div class="select">…</div>
</div>
<span class="foot-note"
  ><i class="ic ic-fingerprint"></i>Asks for your passkey first</span
>
<!-- first in a foot or save bar -->

<!-- a settings row rendered from a registry -->
<div class="setting-row changed">
  <div>
    <div class="setting-title">
      Default release-file quota<span class="setting-key"
        >assets.quota.releaseBytes</span
      >
    </div>
    <div class="setting-desc">Builds, installers and packs, per product.</div>
    <div class="setting-meta">
      <span>2 products use this</span><span aria-hidden="true">·</span
      ><span>Diceroll sets 40 GB</span>
    </div>
    <div class="changed-note">Changed from 20 GB, not saved yet</div>
  </div>
  <div class="setting-control"><div class="input changed">…</div></div>
</div>
<div class="setting-control">
  <div class="setting-value">
    <span>8 hours</span><span class="meta">Set in code, not a setting</span>
  </div>
</div>
<div class="save-bar blocked">…</div>
<div class="save-bar saved">…</div>

<!-- a settings page: the section nav, the pills (tablet), the picker (phone); Platform ready in the aside at wide -->
<div class="with-toc">
  <nav class="toc-nav">
    …<a href="#ready">Platform ready<span class="meta">8 of 9</span></a
    ><a href="#jobs">Jobs<i class="dot"></i></a>
    <p class="toc-note">
      Members and SSO rules are in <a class="link" href="#">Members</a>…
    </p>
  </nav>
  <nav class="jump-nav">…</nav>
  <div class="select toc-select">…</div>
  <div class="toc-body columns">
    …
    <section class="card aside span-3">Platform ready</section>
    …
  </div>
</div>

<!-- other states under a console screen -->
<section class="board below">
  <div class="board-title"><h1>Other states</h1></div>
  <figure class="board-item">…</figure>
</section>

<!-- the hosted sign-in page inside a browser frame, and a code to check against the terminal -->
<div class="browser">
  <div class="browser-bar">…</div>
  <div class="hosted framed">
    <div class="hosted-brand">…</div>
    <main class="hosted-card">
      …
      <div class="match-code">
        <span>Check this matches your terminal</span><strong>QXKM-TPRW</strong>
      </div>
      …
    </main>
  </div>
</div>
```

- **Role tags** are 24 high like a pill. Under 560px of card width each role takes its own line
  and a set's areas drop under its tag, outside it (`.flow` keeps short tags in a row).
- **Row menus.** A `.table-card` holding an open `.popover` lets it out; in a stacked row the
  `td.row-menu` stays at the top right beside the title. A menu with a `.menu-note` is 320 wide.
- **`.foot-note`** starts a dialog, drawer or card foot (or a save bar) and pushes the buttons to
  the end; under 560px it takes its own line and the buttons share the next.
- **`.token`** is a removable value on its own too (a reserved term, an alert destination); an
  icon-only Add (`.btn.ghost.icon.xs`) keeps a short list on one line.
- **Settings rows**: the registry key in small mono beside the title (its own line on a narrow
  card), `.setting-meta` for who uses or overrides it (one or two facts), the control in
  `.setting-control` (inputs 160px; a `.field` with its error 240px; chips at most 400px). A
  changed row takes the accent edge and `.changed-note`; its section's `.save-bar` follows the
  card. A switch applies at once and stays at the right on phone.
- **`.toc-body.columns`**: at 1600 and up, blocks marked `.aside` (`.span-2`, `.span-3`) go to a
  400px column beside the cards; below that, source order. A `.toc-nav` entry can end in a
  `.meta` count or a `.dot` (unsaved changes).
- **`.card.aligned`** in a `.mk-grid-N`: the cards' bodies and feet share two rows (subgrid), so
  the feet's rules line up whatever each text's length. An aligned card is not a size container.
- **`.page.centered`** centres a capped page (`.page.medium` for a message page such as No access);
  **`.mk-with-rail.keep-rail`** keeps a rail that holds the page's way out beside the main column
  down to 1024px.
- **`.board.below`**: other states under a screen: a dashed rule, the page gutter, items in
  columns at least 420 wide; each item is a size container, and a dialog, drawer, menu or toast
  fills its item.
- **`.hosted.framed`** draws the hosted sign-in page inside a `.browser` frame (32 above, 24 at
  the sides, 40 under the card; edge to edge on phone). **`.match-code`** is a code to compare with
  another screen: the instruction, then the code in mono at 20/28 (under it on a narrow card).
- A device-code pair (the terminal beside the approval page) sits side by side from 1024px and
  stacks on phone; `admin.cli-login` places its frames with grid areas per size, letting a tall
  frame's extra height fall to a flexible row so no block hangs under a gap.

## Records, rules, editors and state boards (licenses screens)

Appended for the licenses area (2026-10-08); all on the scale. `licenses.list`, `licenses.tiers`,
`licenses.detail` and `licenses.access` are the references.

```html
<!-- an editor: an ordered list beside the open record (licenses.tiers) -->
<div class="mk-editor">
  <section class="card">
    <div class="card-head">…Order…</div>
    <div class="card-rows">
      <div class="item-row lead keep-end marked">
        <i class="ic ic-grip-vertical subtle"></i><span class="rank">3</span>
        <div class="item-text">
          <div class="item-title">Education<small>57 licenses</small></div>
          <div class="item-desc">…</div>
        </div>
        <div class="item-end"><button class="btn ghost icon xs">…</button></div>
      </div>
    </div>
  </section>
  <div class="mk-stack-4">
    <section class="card">
      <div class="form-section">
        <div class="form-section-label">
          <h3>Duration</h3>
          <p>…</p>
        </div>
        <div class="form">…</div>
      </div>
    </section>
    <div class="save-bar">…</div>
  </div>
</div>
<div class="radio-list">
  <div class="radio-option">
    <span class="radio on"
      ><span class="box"></span>Keeps the last version</span
    >
    <span class="radio-desc">…</span>
  </div>
</div>
<ul class="icon-list small">
  <li class="success">
    <i class="ic ic-check"></i><span>…</span><span>value</span
    ><span class="sub">…</span>
  </li>
</ul>
<div class="date-span" style="--v: 6%">
  <span>Sep 14, 2026</span>
  <div class="date-span-track">
    <div class="progress" style="--v: 6%"></div>
    <span class="date-span-today">Today · Oct 7</span>
  </div>
  <span class="strong">Sep 14, 2027</span>
</div>
<div class="segmented sm matrix">…four options…</div>
<!-- the same four columns on every row -->
<p class="eyebrow rows-label">Packs</p>
<!-- a group label inside .card-rows -->

<!-- a board of states drawn as slices of the page, dialogs or drawers -->
<div class="board cols-2 wide-3">
  <figure class="board-item">
    <div class="board-frame">…page-head, toolbar, card…</div>
    <figcaption>…</figcaption>
  </figure>
  <figure class="board-item">
    <div class="board-stage">
      <aside class="drawer">…</aside>
      <div class="overlay center"><div class="dialog sm">…</div></div>
    </div>
  </figure>
  <figure class="board-item full">…</figure>
</div>
```

- **`.mk-editor`** with a wider list: a screen may set `--list-w` (a width, not spacing); the
  tiers list is 360 (400 at wide) and stacks over the record below 1280.
- **`.item-row` additions**: `.rank` (a 20px number; `.marked` rows draw it in the accent) in the
  media column; `.marked` (accent wash and 2px edge: the open or changed row); `.item-meta` (a
  trailing value over its meta, right-aligned); `.keep-end` (the end, a ⋯ or a count, stays
  beside the text on a narrow card instead of dropping under it).
- **`.form-section`**: a record's group, its 200px label column 32 from the fields, a hairline
  between groups; the label goes over the fields under 720px of card width. The field column
  stops at 640px, and `.card-rows.flush` in it starts on the label's line.
- **`.radio-list` / `.radio-option`**: options 12 apart, each description (and a control it
  reveals) hanging past the box.
- **`.icon-list`**: statements led by a 16px glyph, 12 apart; a third child is a value on the
  right, `.sub` hangs under the text; tones `li.success` `.danger` `.warning` `.accent`; `.small`.
- **`.date-span`**: a fixed term on one line, today marked (`--v`) and labelled under its dot.
- **`.segmented.matrix`**: fixed option columns (`--seg-col`, 104), two by two on a narrow card;
  `.na` for an option that doesn't apply. A `.segmented` in any `.mk-cluster` never shrinks; the
  field beside it in a `.no-wrap` cluster takes the rest.
- **Tables**: `tr.note-row` (a note under the row above, `td.indent` on its text column),
  `tr.shaded` (a fallback row), `tr.marked`; `.table.stack-phone.flow` stacks a row as its title
  then one wrapping line of cells (`td.flow-end` takes its own line); `.cell-stack` is a value over
  one sub line, so a two-line cell keeps the 56 row.
- **`.avatar.md`**: a person in the 28px media column; `.pending` for a record with no person yet.
- **Save bar**: `.save-bar.danger` when fields need fixing (its link is the strong text colour).
- **Records**: `.kv-rows` rows take a `.kv-action` (Change) on their first line; `.dl.compact`
  lists values inside a value (each limit with its `.source`) and keeps two columns on phone; on a
  narrow card a `.source` and a `.diff-old`/`.diff-new` chip wrap rather than run past the card.
- **Drawers**: `.drawer.scroll` keeps head, `.drawer-band` (a `.stepper.compact`) and foot in view
  while the body scrolls, in a `.console.modal-open`; `.drawer-foot > .start` puts a quiet way on
  (Open batch) at the start.
- **Boards**: `.board.cols-2` (two a row from 1280, top-aligned rows; `.wide-3` three at wide;
  `.board-item.full` takes the row), `.board.cols-1` (one slice per row, full width).
  `.board-frame` is a framed slice of a page (24 inside, 24 between its parts; a `.toast` in it
  sits at its end on the right); `.board-stage` draws an overlay (`.overlay.center`) over one
  piece, and a drawer in a stage fills it. Frames and stages in a row share its height.
- Small fixes: a `.popover.right` keeps its text left-aligned; skeletons on a sunken card or a
  callout take the stronger fill; `.empty-icon.muted` / `.danger`; `.skeleton.media` /
  `.capsule` / `.inline`; `.chip.locked` (an always-on choice: a lock, a dashed edge);
  `.card-body.tinted` (a legend band); `.mk-with-rail.rail-first` (the rail first below 1280).

## Entitlements, multi-review: new primitives and the `.kit-next` defaults

Appended for the entitlements multi-review (2026-10-08), in `mockup.css` between `BEGIN
entitlements-multi-review` and `END entitlements-multi-review`. New primitives only: no existing
value changed. `entitlements.duration` (the tier record), `entitlements.license-subscription`,
`entitlements.new-major`, `entitlements.catalog` and `entitlements.addon` are the references.

### New primitives

```html
<!-- a reference legend: glyph in the media column, name (14/20 bold) over its rule (13/20 body) -->
<section class="card aside span-2">
  <div class="card-head">…Kinds…</div>
  <div class="ref-legend cols">
    <!-- .inline: name and rule on one 32px line; .cols (880+) / .cols-lg (1080+): equal columns -->
    <div class="legend-item">
      <i class="ic ic-toggle-right legend-glyph" aria-hidden="true"></i>
      <div class="legend-text">
        <span class="legend-name">On/off</span>
        <span class="legend-rule">Off unless …</span>
      </div>
    </div>
    …
  </div>
  <div class="card-foot start"><span>Applied in order: …</span></div>
</section>

<!-- a callout's dismiss in its corner -->
<div class="callout info">
  …
  <div class="btn-row">…two outline actions…</div>
  <button
    class="btn ghost icon sm callout-close"
    aria-label="Dismiss for everyone"
  >
    <i class="ic ic-x"></i>
  </button>
</div>

<!-- two header text actions that share one row on phone -->
<div class="page-actions">
  <button class="btn ghost icon" aria-label="More">…</button>
  <div class="action-pair">
    <button class="btn outline">Create codes…</button
    ><button class="btn outline">Comp to…</button>
  </div>
</div>

<!-- a row's value or control, its "was" mark and its remove ×, on the title's line -->
<div class="setting-row dense top">
  …
  <div class="end-control">
    <span class="was">was +1</span>
    <div class="input sm short changed">…</div>
    <button class="btn ghost icon xs" aria-label="Remove loadouts">…</button>
  </div>
</div>

<div class="card-split stack-md">
  …facts…
  <div>…History…</div>
</div>
<!-- side by side from 720px of card -->
<div class="stats strip quad">…four stats…</div>
<!-- 4 across; 2×2 under 680, tiles on phone -->
<table class="table no-head-phone">
  …
</table>
<!-- folded on phone: no lone header -->
<td class="end on-title"><button class="btn ghost icon xs">…</button></td>
<!-- phone: ⋯ on the title's line -->
<button class="btn ghost sm muted hang-start">Change to units…</button>
<!-- a quiet structural action -->
<div class="card-head">
  <div class="title fill">…a title over a line of facts…</div>
  <button class="btn outline icon sm">…</button>
</div>
```

- **`.ref-legend`** is the one component for reference legends (entitlement kinds, where add-ons
  come from). It is not the table-foot glyph key (`.legend`). In narrow cards, the 400px aside,
  tablet cards (with `.cols-lg`) and phone it is rows; `.cols` puts the entries in equal columns
  (`--legend-cols`, default 3) on a card from 880px, `.cols-lg` from 1080px (five entries). No
  numerals: a count belongs in the filter segment it counts (`On/off 5`). Below 1600 a legend card
  goes after the page's main table; from 1600 it is the `.aside` (`.page.columns` places it at the
  top of the aside). It may be dismissible (a × in its head).
- **`.callout-close`**: the callout keeps clear of the ×; on phone its text actions share one row
  in two equal columns (labels may wrap to two lines), running under the ×.
- **`.action-pair`**: from 640px just two buttons in the actions; on phone one row, two equal
  columns. A single text action stays full width.
- **`.end-control`** (in the existing **`.setting-row.top`**): the value or control stays on the title's line
  at every width, right-aligned, and the × keeps one x down the list; an on/off value takes a 40px
  slot, a quantity is `.input.short` (96); under 560px of card the "was" mark drops under the
  control as meta.
- **`.card-split.stack-md`**: two panes from 720px of card (a subscription's facts beside its
  History), stacked narrower. **`.stats.strip.quad`**: a balance and the three figures it adds up
  from, one row, 2×2 under 680px, still tiles on phone. **`.table.no-head-phone`**,
  **`td.on-title`** (phone only), **`.btn.ghost.muted`** and **`.title.fill`** (a card head whose
  title carries a line of facts shrinks before its icon button wraps) are small.
- **Tokens**: `--mk-warning-tint` (a warm warning wash: light `color-mix(--pk-signed 14%,
surface-raised)`, about `#f7ebdb`; dark `--pk-warning-subtle`) and `--control-max` (320, the
  widest a select in a form gets). For brand: the light `--pk-warning-subtle` (`#eae7e6`) reads grey.

### Status words: facts never break inside themselves

Each fact on a meta line (`.meta`, `.cell-sub`, list-row and item meta, kv and dl values) is
wrapped in `<span class="nowrap">`, and the separator is glued to the fact before it, so a line
breaks only between facts: `<span class="nowrap">App Store</span>&nbsp;· <span
class="nowrap">Oct 1</span>`. Hyphenated words in running text (`add-on`) take `.nowrap`. A
`.source` follows the last word of its value inside the same `.nowrap`, so it wraps only with that
word.

### `.kit-next`: the lead's new defaults, opt-in per screen

These change existing components, so they apply only under `.kit-next` on the screen's root
(`<div class="console kit-next">`). Every entitlements screen opts in. Making them the default for
every screen means changing existing values, which this pass did not do; until the lead flips
them, a screen without `.kit-next` renders as before.

| Default                                | Under `.kit-next`                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Link inside a sentence                 | Underlined: 1px, 3px offset, half the link's colour, in `p`, `.hint`, `.cell-sub`, `.setting-desc`, `.callout-text`, `.radio-desc`, `.item-desc`, `.timeline-desc`, `.error-text`, `.toast-text`, `.legend-rule`. A link with an arrow and a `.btn` stay bare (WCAG 1.4.1)                                                                                                       |
| `.callout.warning`, `.pill.warning`    | `--mk-warning-tint` background (light; dark unchanged). A screen's own warning rows (`tr.reversed`, a stale device) use the token too                                                                                                                                                                                                                                            |
| Phone touch targets                    | `.btn` at least 44; `.segmented` options 40 in a 44 control; an icon-only button in a row (`td`, `.item-end`, `.card-row`, `.setting-row`, `.list-row`, `.card-head`, `.end-control`) a 40×40 target that keeps the row 56; `.switch` a 44×44 hit area while it draws 36×20; a radio or check row at least 44                                                                    |
| Phone save bar                         | One 56px row: "N changes" (small, strong), Discard, Save. Markup: the sentence in `.hide-phone`, the count in `.show-phone`, Save's record name in `.hide-phone`. The sentence shows from 640px. For builders: `scroll-padding-bottom` = the bar's height + 16, so a focused field is never hidden behind it. (Replaces "message first line, buttons second" for these screens.) |
| Phone sheet foot, `.card-foot.actions` | Cancel and the primary side by side in two equal columns, in DOM order, so the visual order matches the tab order (replaces column-reverse with the primary on top)                                                                                                                                                                                                              |
| `.dialog.scroll.fade` sheet            | The body is a focusable scroll region (`tabindex="0"`, `role="region"` with a name); while it scrolls (mark `.overflows`) the foot is lifted by a shadow                                                                                                                                                                                                                         |
| Light switch and radio                 | The knob and the selected dot are the surface colour (white); the accent stays on the track and the ring. A real switch: `<button class="switch on" role="switch" aria-checked="true" aria-labelledby="…">`                                                                                                                                                                      |
| `.segmented > .on`                     | An inset 1px ring in `--pk-border-strong`, so the selected segment reaches 3:1 in both themes                                                                                                                                                                                                                                                                                    |
| `.choice-title`                        | The glyph on the title's first line                                                                                                                                                                                                                                                                                                                                              |
| `.val-on` / `.val-off`                 | Off reserves On's 14px tick slot, so On and Off start at one x in a column                                                                                                                                                                                                                                                                                                       |
| Status words in a table cell           | The cell's 14/20, on the row's baseline                                                                                                                                                                                                                                                                                                                                          |
| A select in a form                     | At most `--control-max` (320). A number is `.input.short` (96) or `.input.unit` (128), never a stretched input with an affix; text fields stop at the form-section's 640 column                                                                                                                                                                                                  |
| `.kv-rows` on a narrow card            | A 112px label column                                                                                                                                                                                                                                                                                                                                                             |
| `.avatar.sm`                           | Initials at 11px (initials are `aria-hidden`; the name is beside them)                                                                                                                                                                                                                                                                                                           |
| Tablet toolbar (1024–1279)             | The search is 240, so it and five facets fit 920px                                                                                                                                                                                                                                                                                                                               |

No sentence is set at `--fs-meta`: helper sentences, rules and sentence sub-lines use `--fs-small`
(13/20); `--fs-meta` is for dates, counts, column labels and source tags.

### Markup builders copy

- Switches: `<button class="switch" role="switch" aria-checked aria-labelledby="<row title id>">`,
  never a switch named "On".
- `.choices`, preset lists and `.radio-list`s: `role="radiogroup"` with `role="radio"` items;
  `.segmented` filters (kind, ledger, holder): `role="radiogroup"` (or `aria-pressed` buttons),
  never `role="tablist"` without tabs.
- Crumbs: `<nav class="crumbs" aria-label="Breadcrumb">`.
- A glyph that stands for a word on its own (a kind icon in a phone summary, a feature glyph):
  `role="img"` with an `aria-label`; a decorative glyph beside its word: `aria-hidden="true"`.
- Check with axe-core (in `node_modules`): the entitlements screens report 0 violations.

### Dialog geometry

Every dialog uses the overlay's default top (`.overlay.top`, documented under "Channels and
downloads" for distribution's Publish, is left as it is: that screen is outside this pass). The default
width is 480; `.lg` (640) is only for fields that genuinely sit side by side, so a field's error
flows under its own field. A phone sheet whose body can overflow is `.dialog.scroll.fade`.

### The tier record, the license record and the licenses list are drawn once

`entitlements.duration`, `-trial` and `-version` are states of the licenses.tiers editor (the
Order list beside the record; Duration, Limits, Includes, Profile as `.form-section`s with the
640px field column); `entitlements.license-subscription` is a state of licenses.detail;
`entitlements.new-major` is a state of licenses.list. A new screen of one of these records starts
from that frame. Follow-up for the licenses area: licenses.tiers takes the Duration group drawn in
`entitlements.duration` (six presets as a `.radio-list`, the chosen preset's settings, When it
ends, Versions, the worked timeline) in place of its three-segment control.

### Portal, multi-review: appended primitives

All appended to `mockup.css` under "portal-multi-review", scoped to `.portal`; no existing value was
changed (they win by coming later at equal specificity).

- `--hero-h` token on `.portal`: 220px, 260px from 1700px, 160px under 1100px, 112px on phone; the
  product hero's icon is 56px and overlaps the band by 20px.
- Tile art 16:7 capped at 140px (112px on phone; superseded by the owner's note of 2026-10-08: the
  whole 16:9 frame, at most 280px, block `portal-owner-notes`), tile body padding 16/20, `.ptile-links` row under the
  actions (min 76px so the primary buttons are level), `.page-note` muted line under a grid.
- Wide: from 1700px `--portal-max` 1520px and a 420px license rail; tile grids use
  `repeat(auto-fit, minmax(380px, 1fr))` from 640px (auto-fit rather than auto-fill, so two tiles do not
  leave an empty third). The portal toast sits on the content column's right edge.
- Card section header: 56px minimum, `.head-meta` on the right, 24px card padding. Title scale 28/20/14/12
  (`.page-title-row` for the title with the page's main action on the right).
- `.help-strip` / `.help-row`: quiet rows, 56px, link-only actions, no box.
- `.card-disclosure` (a `<details>` row), `.pill.this-device` for the current device.
- Chip strip: 36px chips under 1100px with a 24px edge fade; the product page is one column under 1100px;
  the right column is sticky from 1100px.
- Light theme: `--mk-line` darkened under `.portal`. Not done: the muted text token (already about 7:1 in
  light), because changing an existing value is out of bounds here.

### Multi-review additions 2 (distribution, 2026-10-08)

New primitives only, appended to `mockup.css` in the blocks `distribution-multi-review-2`, `-3` and
`-4`; no existing value changed.

- **Page cap** `.page.cap`: at most `--page-cap` (1280) of content plus the gutters, centred, so wide
  never stretches tables, feeds or steppers (`distribution.channels`, `-channel-app-store`,
  `-channel-setup`). The public download page sets its own `--portal-max` (960; 1440 at wide).
- **Table reflow** `.table.reflow` + `.cust` / `col.cust-col` + a `.row-chip` under the first cell's
  sub-line: at 1100px and below the copy chip leaves its column and sits under the versions line
  (up to 360px; full width on phone); `.value-chip .long` hides its long label there.
- **Equal-height cards** `.mk-grid-N.pinned`, `.card-foot.fixed` (a 56px row: one-line status at the
  start, one button at the end; two lines on a phone), `.card-body.two-line`, `.clamp-1`;
  `.mk-grid-N.top` is the size-to-content variant.
- **Compact toggles** `.show-compact` / `.hide-compact` (1100px and below), `.stepper.fill.capped`
  (connectors at most 160px).
- **Tertiary action** `.btn.ghost.accent-text` (a ghost button in the accent text tone).
- **Failed rows** `.task.blocked.fail-row` and `.item-row.fail-row`: red tint, 3px start bar;
  `.tag-inline` a 12px muted source tag beside a title; `.aside.sticky` a rail that stays in view at
  wide (top 88px).
- **Check target** `.check.lg`: a 24px box with the 16px mark.
- **Meta lines** `.meta-seps.stack-narrow`: one item per line with no dot on a narrow card.

Not changed (would alter an existing value): the muted text token's contrast, the 236px
`--item-action-w`, the `.overlay.top` default, and the tablet icon rail's tooltips. The per-screen
rules (the download page's 960 cap and two columns, the publish dialog's scale) live in each screen's
own style block.

## Products spacing pass 2 (`.kit-prod`, multi-review)

Opt-in per screen like `.kit-next`: put `.kit-prod` on the screen root (`<div class="console kit-prod">`,
`<div class="board kit-prod">`). Everything is appended in the `products-multi-review` block at the end
of `mockup.css`; no existing value changed, so a screen without `.kit-prod` renders as before. Used by
`products.home`, `.features`, `.integration`, `.new-product`, `.sidebar-contexts` and
`.turn-off-licensing`.

- **One page head.** `--page-top` is 24; a 20px breadcrumb row is always reserved (drawn, or an empty
  `::before` when a page has no crumbs), so the h1 sits at one y on every page.
- **Content width.** `.page.cap` stops the main column at 1200 and keeps it left-aligned with the title. A
  rail is allowed only if it is sticky (top = the 64px topbar + 16, 360 wide) and holds real content:
  `.int-rail` and `.np-sum`.
- **Type and targets.** Card title 18/24, `.eyebrow` 11px caps, `.meta` / `.hint` 12px at the muted token,
  `.btn.sm` and the code Copy button 32px tall.
- **Disabled and locked.** Dim only the control: `.switch.disabled` keeps its 3:1 edge and dims its knob;
  `.setting-row.off` and `.choice.locked` keep 4.5:1 text.
- **Status pill.** `.status-pill` (`.ok`, `.wait`, plain) is the one status in a card head; it replaces
  footer "Verified" strips.
- **Code blocks.** `pre` scrolls in x with a 24px right-edge fade; phone 12px type, pre-wrapped comments,
  labelled Copy.
- **Nested panel.** `.feature-subs` is the one panel for sub-groups (8px radius, 16px padding, 1px
  dividers) and reaches 17px past the text column so titles and controls align with the parent's. A
  phone feature row puts its status under the name and hides the description under 480px.
- **Integration.** `.int-grid` > `.int-main` (`.int-card` feature cards, `.fold-phone` to fold on phone) +
  `.int-rail` (from 1440) / `.int-summary` (below 1440, Add the SDK behind `.int-sdk-toggle`).
- **Wizard.** `.np-layout` (wizard + sticky `.np-sum`; the wizard caps at 1040 at 1920), `.np-sum-bar`
  (below 1280 the summary is one expandable `<details>` bar above the footer), `.stepper-progress` (phone
  "Step n of N: name" and a segmented bar), `.choice-hint`, a 2-line `.choice-foot` minimum, 2px phone
  connectors.
- **Specimen boards.** `.board-spec` (with `.kit-prod` on the board): a centred auto-fit 4-up grid capped at
  1360, 2 x 2 at tablet, the notes (`.rules`) as one full-width row beneath, panels sized to their content.
- **Dialog.** `On → Off` is a 12px pill, the X shares the title's centre line, phone Cancel is a ghost
  (`.cancel-btn`); no `autofocus`, so the focus ring appears only in an interaction state.

Not done: stretching the New product rail card to the wizard's height (it would recreate the void the
sticky rail removed). The Create button's "Opens Integration" caption belongs to step 3, which is not drawn.

### Identity, multi-review: appended primitives

All appended to `mockup.css` under "identity-multi-review" (parts 1 to 11). Nothing existing changed; each is
opt-in by a new class.

- **`.rhythm`** (on a `.page`): `--grid-gap` 24 (16 on phone), `--section-head-gap` 12, `--section-gap` 32
  (24 on phone), `--tile-pad` 24; card headers at least 56 high with 18/600 titles; a card after a card in a
  `.section` sits 24 apart. A page opts in; the global tokens are unchanged. Not done: changing the global
  `--grid-gap` (16), `--section-head-gap` (16) and `--tile-pad` (20), card title weight 700 and the
  card-head padding, because each is an existing value.
- **Wizard**: `.page.wizard-col` (one centred 960px column for the head and the wizard), `.wizard.centered`,
  `.step-line` ("Step 3 of 5 · Test sign-in" over a 4px `.progress`, shown under 640 instead of the
  circles), `.wizard-foot.foot-stack` (phone: reason, 48px primary, 48px secondary, centred ghost; desktop
  unchanged) with a `.foot-reason` for the disabled reason in the left slot, `.empty.strip` (a 120px icon-inline
  empty state), `.callout.actions-end` with `.callout-actions` (banner text fills, buttons right),
  `.mk-grid-2.stretch` (panes of one height).
- **Claims table** `.table.fixed.claims`: name and value stack under 640 (name 12px mono, value full width,
  `overflow-wrap: anywhere`), so a long name never prints over its value.
- **Two columns**: `.mk-with-rail.rail-360` (main plus a 360px rail from 1280, the rail sticky; one column
  below, the rail's cards side by side), with `.toc-nav.in-rail` as the sticky "On this page" list at the
  top of the rail and `.jump-nav.only-narrow` as the chip row under the title below 1280. Used by
  `identity.connection` and `identity.app-sign-in`. `.rhythm .mk-main` / `.mk-rail` gap is `--grid-gap`.
- **Rows**: `.segmented.fixed-224` (one 224px width for 3 or 4 options; 36px high on phone),
  `.dl.rows-40` (40px rows, 120px label column), `.stats.row-3` (three compact tiles in one row on phone),
  `.record.scroll` (a copyable value scrolls sideways, the 36px copy button pinned), `.btn.full-phone`,
  `.mk-grid-3.cards-strip` (the three-card strip: two columns at tablet, the odd last card across),
  `.card-foot.fixed` on each card of a `.pinned` row.
- **Account page**: `.cap-880` (capped, centred), `.btn.row-act` (one row-action size: 32 desktop, 44 phone;
  `.wide` 208px), `.btn.danger-text` (quiet destructive), `.jump-nav.fade-end`.
- **Portal card**: `.hosted-legal.centered`, `.hosted-links.row-14` (one centred 14px row, 44px targets),
  `.hosted-body.end-24`, `.check.quiet`, `.hosted-foot.echo` (same trust footer, same height, quieter after
  its first card on a board).
- **Boards**: `.rules-strip` (the rule list as a column strip above the cards; clamped to 3 lines per item
  on phone), `.frame-grid.fixed-cards` (400px cards on one top edge).
- **Dialogs**: white label on `.btn.danger` in dark; `.dialog-foot.safe-first` (phone: the safe action
  first, the destructive one second and outlined; no neutral fill on the safe button, so no first-render
  focus fill).
- Muted and meta text was already at least 12px and 4.5:1 in both themes (muted about 10:1 dark, 5.9:1 light),
  so no colour value was changed. The toggle track, the pill type size and the amber pill colours are
  existing values and stay.

### Licenses, multi-review: new primitives

Appended to `mockup.css` between `BEGIN licenses-multi-review` and `END licenses-multi-review`.
Every rule is gated by a new class, so no existing value changed and a screen that does not opt
in renders as before. Where the lead's list needed an existing value changed (card padding 24,
row height 56, card gap 32, the 14px body type, a global `.page` cap), nothing was edited: those
tokens already hold the lead's numbers, and a global width cap exists as `.page.cap`.

| Primitive                                                                 | What it does                                                                                                                                                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.page.cap` + `.cap-1180` / `.cap-1400` / `.cap-1440`                     | The distribution pass's content cap with a width per screen (tiers 1180, detail 1400, list 1440): wide adds margin, not an empty strip                                     |
| `.sticky-top`, `.sticky-1280`                                             | A side column (Order, the detail rail) that stays 88px under the top; `-1280` only where it sits beside the record                                                         |
| `.card-head.h56` (+ `.sub`)                                               | One head height: 56, or 72 with a subtitle; the action stays on the title's line; an icon button stays beside the title on a narrow card                                   |
| `.fld-rhythm`                                                             | 24 between field groups, 8 label to control, 6 control to helper                                                                                                           |
| `.btn.match`                                                              | A button at the control height (36), on an input's line                                                                                                                    |
| `.mk-editor.tiers`                                                        | Order list 300px (272 at tablet) beside the record; below 900px the list folds into `.mk-editor-switch`                                                                    |
| `.tabs.scroller`                                                          | Phone tab row: scroll-snap, a 56px edge fade                                                                                                                               |
| `.segmented.fit`, `.segmented.matrix.fit`                                 | Content-width segments that never ellipsize; on phone the matrix is a 2x2 of 44px cells with a filled selected state                                                       |
| `.table.two-line`                                                         | Phone key/value rows: label and value, then source and action, 44px targets. Cells in DOM order: label, value, source, action                                              |
| `.table.cards-phone`, `td.is-default`                                     | A list row as a three-line card on phone; default cells are not drawn                                                                                                      |
| `th.col-dur`, `th.col-dev`, `.meter-head.cap`                             | Fixed Duration (224) and Devices (136) columns; a meter capped at 96px                                                                                                     |
| `.quiet-cell`, `.btn.text`                                                | A default value in muted text; an action as quiet underlined text                                                                                                          |
| `.page.columns.rail-360` + `.rail-cards`                                  | The aside from 1280px (not 1600) at 360px, sticky, its cards sized to content; a `.full` block spans above it; below 1280 the cards sit in the flow, two across from 640px |
| `.board.cols-2.start`, `.board-item.dlg-center`, `.room-below`            | State boards: tiles size to their content; a dialog centres at 520px; a tile leaves 160px under a popover                                                                  |
| `.popover.anchor-below`                                                   | A popover or menu 8px under its trigger                                                                                                                                    |
| `.dialog-foot.std`, `.drawer-foot.std`                                    | 40px buttons, 12px gap; on phone Cancel beside the primary and a `.start` link above the pair                                                                              |
| `.floor` (on a console or board root)                                     | Helper and meta text at 13px, row icon actions 32px (44px on phone), 6px progress bars                                                                                     |
| `.save-bar.pinned`                                                        | A save bar drawn as pinned: lifted, with the safe-area inset under it (the built screen pins it)                                                                           |
| `.stepper.compact.lined`                                                  | Every step label kept at every width, a hairline between the marks                                                                                                         |
| `.toast.wrap-action`, `.item-title.wrap-name`, `.card.tint.neutral-phone` | A toast's action under its message on phone; a file name that wraps at hyphens; a tinted card neutral on phone                                                             |
| `.note-mock`                                                              | A board caption that reads as mock-only (defined, not yet applied to any caption)                                                                                          |

## Config screens, multi-review: new primitives and the `.kit-cfg` rules

Appended for the config multi-review (2026-10-08), in `mockup.css` between `BEGIN
config-multi-review` and `END config-multi-review` (three parts). Classes that did not exist are
global; rules that restyle existing components apply only under `.kit-cfg` on the screen's root
(`<div class="console kit-cfg">`), so no existing value changed. All 19 config screens opt in.

New classes: `.mk-pair.top` (align-items start, so a card keeps its height), `.rail-sticky`
(sticky at 80px), `.page.columns.cap-main` (main column capped at 1280px at wide),
`.mk-editor.cols-3` (list, form capped at 880px, 320px sticky rail at wide; the list folds into the
top selector from tablet down), `.mk-action-bar` (phone-only sticky bottom bar: secondary left,
primary right, 44px), `.step-compact` ("Step N of M · Name" text at phone, hides step labels),
`.segmented.iconed` with `.seg-help` (one helper line under it), `.hint-slot` (one reserved hint
line so a two-column grid aligns), `.table.row-48` (48px rows from 640px, em dash via `.dash`),
`.choices.brief` (a card shows its description only when selected), `.textarea.one`,
`.page-actions.row-phone` (a mode control beside the primary on phone), `.toast-clear`,
`.scroll-fade`.

Under `.kit-cfg`: card head title over subtitle with a 4px gap and ghost/link actions inset by
12px so label text ends at the 24px edge; pills 22px tall at 11px; one gap from a page head's meta
to its tabs; code blocks scroll sideways with a right-edge fade, the code tab strip fades, and at
phone a tab shows its language only; dialog and drawer feet are Cancel then primary side by side,
44px at phone (the primary takes twice the width and may wrap); toasts bottom-centre with 24px
clearance; light theme `--pk-text-subtle` and `--mk-syn-com` darkened to 4.5:1; inline code at
least 12px; crumbs, links and standalone links at least 24px tall.

Kept as they are (an existing value would have changed): the default `.mk-pair` stretch, the
default `.page-max`, and the unscoped light tokens. A screen that wants them uses the opt-in
classes above. The shoot tool also draws `.mk-action-bar` at the end of the page, like a pinned
save bar, so a full-page shot covers nothing.

Vocabulary used on config screens, unchanged but written down: locks are Read-only (a lock icon)
and Hidden (eye-off); the five-step strip (Catalog defaults, Default profile, tier profile, This
license, the account) is the only statement of order, and a pip ladder marks the step that sets a
value (neutral square), the step devices get it from (accent) and a set-but-not-applied step
(dashed); banners are warning (amber, one tier for stale and changed states), info and danger, with
no new banner colours; the Platform pill marks controls that act on every product.

## Packages, multi-review: new primitives (packages screens)

Appended to `kit/mockup.css` between `BEGIN/END packages-multi-review`; no existing value changed.

| Class                                                                                   | What it does                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.page.contained`                                                                       | A single-column page centred at 1280px (`.page.form.centered` for a 760 flow). Gutters (16 phone, 24 up) and card padding (16 phone, 24 up) were already the kit's.                                                  |
| `.page.columns.sticky-rail`                                                             | From 1600px the rail is 360px and sticky at `top: 88px`; below, its cards fall under the main column. Card pairs that must not stretch: `.mk-grid-2.top`.                                                            |
| `.fade-x`, `.wrap-phone`                                                                | Code, terminals: an edge fade while they scroll sideways (`tabindex="0"`, `role="region"` on the `<pre>`), soft wrap at 12px on phone.                                                                               |
| `.table-card.fade-edge`                                                                 | A table scrolling inside its card on tablet, with an edge fade (off from 1280px).                                                                                                                                    |
| `.card.lane-card`                                                                       | Equal-height lane: footer pinned (`margin-top:auto`); cap the list at 2 to 3 rows and put "View all" in the foot.                                                                                                    |
| `.attn-stack` / `.attn-line`                                                            | An attention row on two lines: pill, subject and the way on, then one muted sentence.                                                                                                                                |
| `.card-split.sticky-end`, `.code-first`, `.v-center`                                    | Sticky second pane beside a taller first; code above steps when stacked on phone; short pane centred.                                                                                                                |
| `.card-rows.cols-2`                                                                     | Rows in two columns from 640 to 1599px, one column in the rail and on phone.                                                                                                                                         |
| `.board-grid.equal`                                                                     | Columns that end on one line; captions are labels 8px above the pane.                                                                                                                                                |
| `.kv-grid`, `.split-line`, `.measure-70`, `.actions-under`                              | Parameter grid; a value pushed right; a 70ch measure; closing buttons directly under the field they confirm.                                                                                                         |
| `.em-dash`                                                                              | An empty cell as an em dash (`.dash` is the dashboard layout).                                                                                                                                                       |
| `.meta-line`                                                                            | Facts separated by a gap, not a dot character.                                                                                                                                                                       |
| `.btn.full-phone`, `.text-phone`, `.tap-44`, `.set-apart`, `.warn-fill`, `.is-disabled` | Full-width 44px CTA on phone; lower-emphasis Cancel on phone; 36px button with 44px hit area; 24px before a primary; warning-token confirm; muted disabled primary with `.hint-inline` ("Tick the box to continue"). |
| `.tap-row`, `.key-field.wrap-phone-token`, `.overlay.sheet > .dialog.sheet-90`          | 44px checkbox row; a key that wraps on phone; sheet at most 90vh.                                                                                                                                                    |

Not done: the sidebar active-bar clip and tablet-rail tooltips (shared console chrome, a separate kit
item), a 12px type floor and 4.5:1 contrast sweep across kit tokens (needs existing token values
changed), and the typed-confirm on "Delete 41 versions now" (a product question).

## Entitlements, multi-review round 2: spacing system and layout primitives

Appended 2026-10-08 in `mockup.css` between `BEGIN entitlements-multi-review-2` and its `END`. New primitives
only; every rule is under `.ent2` (set on a screen's root next to `.kit-next`: `<div class="console kit-next ent2">`)
or a new class, so no existing value changed and screens without `.ent2` render as before. Where a change would
have needed an existing value changed (the 13/20 helper size, the `.val-off` tick slot, `.radio-option`, the
`.overlay` padding, `.eyebrow`), it is overridden under `.ent2` only; the owner flips those to defaults later.

- **Spacing tokens (`.ent2`)**: 32px section gap (`--section-gap`, unchanged), card head 56px (72px with a
  subtitle), meta type 12/18 in `--pk-text-muted` (AA), sentence-case 12px semibold `.eyebrow` (the uppercase
  tracked kicker is not used), `.page.form-page` 1280 and `.page.table-page` 1600 content caps, `.foot-caption`.
- **Editor with aside**: `.mk-editor.sticky-list` (Order card sticky at 88px from 1280),
  `.form-section.stacked` (label over a 640px field column), `.form-section.stacked.with-aside` +
  `.form-aside` (a sticky 340px aside beside the controls where the card is 760px or wider; `.aside-title`),
  `.preset-settings` (the chosen preset's own settings), `.mk-with-rail.sticky-rail` (a rail that stays in view
  from 1280).
- **Save bar**: `.save-bar.pinned` is `position: sticky` to the window's bottom (16px, 12px on phone);
  `shoot.mjs` draws it at rest at the end of its record in full-page shots (`REST_PINNED`). The inline "was X"
  dirty marker is the existing `.was`; `.stepper-col` stacks it under a 96px stepper.
- **Radio row**: `.radio-list.rows` is one row component, 36px (44px on phone), 8px gap, one line with or without
  its 'then' helper; `.grid2` makes two columns where the card is 960px or wider.
- **Tables**: `.table.rows-57` / `.rows-44` fixed row heights, a 40px trailing action column, from 1280 the cells
  of a 57px row stay on one line; legends and definitions are a header tooltip, `.info-tip` (`data-tip`,
  newline-separated, a 40px target on phone), never a card; `.pill.muted`; On and Off in a value column are words
  at the header's edge (no tick slot); `.detail` / `.detail-text` stop at about 520px with an ellipsis.
- **Dialogs**: `.console.modal-host` makes the screen one viewport tall so the backdrop covers the viewport; the
  dialog sits at 12vh, max-height 90vh, its body scrolls under a pinned head and foot (`.scroll-shadow` adds a scroll
  shadow); `.sum-box` / `.sum-row` / `.sum-label` / `.sum-value` / `.sum-note` is the one label/value summary row
  (36px, 96px label column); `.input > .btn.suggest` is a field-level suggestion; `.dialog-foot > .link.start.tertiary`
  is the tertiary footer-left slot (its own row on phone). A phone dialog stays the kit's bottom sheet.
- **Phone rows and chips**: `.segmented.scroll-row` (one scrolling 40px chip row with an edge fade, replacing a
  2x2 grid), `.tabs.tight` (a tighter gap so a five-tab record fits 390), `.card-head.ghost-action` and
  `.btn.ghost.bordered` (a ghost action that stays on the title row and never wraps), `.link.tap` (a 44px target),
  `.card-row.wrap-phone`, `.setting-desc.one-line`, `.callout .btn-row` as two equal 44px columns.
- **Annotation**: `.mock-note` is a 12px caption for mockup notes, never a card; `.filter-anchor > .facet-menu`
  draws an open facet under its own chip (under the toolbar on phone).

Not done: a 2-column duration radio grid is only reached by a record card 960px or wider, which the 1280 form cap
does not produce; the light-theme primary token (olive, ux3) and a new breakpoint set are left to the owner.

## Admin screens, multi-review (2026-10-08)

Appended to `mockup.css` between `BEGIN admin-multi-review` and `END admin-multi-review`. No earlier
rule was edited. Rules that restyle an existing part are scoped to `[data-screen^="admin."]` (the
body carries the screen id), so no other area changes; everything else is a new class.

**Tokens (new only).** `--title-gap` 4px (a title to its subtitle), `--row-min-height` (= `--row-h`,
56), `--page-cap-table` 1280px, `--page-cap-form` 1136px, `--rail-adm` 288px. The page gutter (24),
block gap (32), card padding (24) and row height (56) already existed as `--page-gutter`,
`--section-gap`, `--card-px` and `--row-h`; nothing was redefined.

- **Caps.** `.page.cap-table` (tables), `.page.cap-form` and `.board-page.cap-form` (forms, settings,
  status pages), centred. `.page.gap-6` and `.section.gap-6` give one 24px gap between header, tabs,
  banner, filters and table.
- **`.page.rail`.** A main column and a rail from 1280px, one column in source order below. Head and
  tabs span both; a child marked `.rail-item` goes to the rail from row 3 for `--rail-rows` rows;
  `.full` spans both columns; `.equal` stretches the cards to one height. Below 1280px the rail item is
  an ordinary row (`.root-rule` draws as a 56px strip there and a stacked card in the rail).
- **Tables.** `.table.rows-56`: every row 56px, a cell holds one or two lines inside it (stacked rows
  on phone grow as before). `.cell-sub .fold` shows a hidden column's fact in the member's second line
  between 640 and 1279px. `.mk-stack-1.merge-phone` joins access sources into one flowing line per
  card on phone (dates and "Added by" drop).
- **Chips and toolbars.** `.filter.solid` (bordered pill), `.chip-row.fade` (one sideways-scrolling
  row on phone with a faded edge), `.segmented.match-input` (input height, 40 on phone).
- **Row menu.** `.btn.icon.hit` is 32px with a 44px hit area (44px on phone); `.menu.cap-300` is at
  most 300px wide.
- **Tabs.** `.tabs.follow-active` snaps the active tab into view; the existing `.tabs::after` fades
  the cut edge.
- **Text and buttons (admin screens).** Fact-bearing `.slug`, `.meta`, `.setting-key`, `.hint` and
  `.toc-note` draw at the muted token and 12px or more; the light subtle token is `#4f586d`; every
  token pair is at least 4.5:1 on every surface in both themes (dark muted 9.6:1+, subtle 6.7:1+;
  light muted 6.6:1+, subtle 6.1:1+). A disabled button keeps a visible border (opacity 0.6, 0.8 on
  primary). `.chg` pairs Adds and Joins with a glyph.
- **Settings rows (admin screens).** 56px floor, 12px padding, the key as a quiet chip at the end of
  the title line (copy glyph on hover or focus), helper text on one line (two on phone), usage on one
  muted line, inputs 160px at every width.
- **`.ready-banner`.** One row of two short lines for the single open step (Platform ready), wrapping
  on narrow screens.
- **Role tiles.** `.role-tiles` (phone only) are a 2x2 grid of `.role-tile` (`.on` = picked) that also
  pick the matrix column; `.role-detail` holds the picked role's words. `.choices.tiles-phone`
  does the same for the Invite drawer's role cards (its `.choice-note` shows the picked role's words
  once). `.matrix.centered` fixes the Area column and centres equal role columns; `.tick`, `.part`,
  `.legend` and `.foot-list` draw the marks, exceptions, legend and footnotes.
- **Drawer (admin screens).** The title is 20/28 (the console draws Rubik at 700 only, so not 600),
  field labels are 12px bold muted; `.drawer-foot.sticky-foot` is sticky on phone and
  `tools/mockups/shoot.mjs` rests it at the sheet's end in shots.
- **`.board.below.states-grid`.** Other states on equal columns (3 from desktop, 2 on tablet, 1 on
  phone), centred under the 1280px cap; captions name the state and its trigger.
- **Editor card.** `.card.editor-card` is a raised card; `.clauses-grid` puts two clauses side by side
  when the card is at least 1000px wide (the right column's fields share the left column's rows) and
  stacks them below.
- **Device-code story (cli-login).** `.story` is two rows of two equal-height frames; `.related` is the
  open Related commands block; `.strip-3` is the three-note strip; `.term-body.scroll-x` scrolls
  sideways on phone (give it `tabindex="0"`, `role="region"` and an `aria-label`).
- **Message pages.** `.mk-with-rail.g84` is an 8/4 grid whose rail link tile is as tall as its
  content, `.g-stretch` makes the rail card as tall as the main one, `.acct-line` carries the quiet
  "Use another account" link.
- **`.root-rule`, `.icon-hint`** (a tooltip glyph after a title), `.key-chip`.

Not done: the 1280px right rail for Platform ready on platform-settings. The 1136px form cap cannot
hold the 200px section nav, a usable settings column and a rail; the banner stays in the flow.

## Commerce, multi-review: new primitives (`.cm2`)

Appended for the commerce multi-review (2026-10-08), in `mockup.css` between `BEGIN
commerce-multi-review` and `END commerce-multi-review`. New primitives only: no existing value
changed, and every rule is under `.cm2` (put it on the screen's `.console` root) or is a new class.
The lead's asks that would have changed an existing value are made opt-in instead: the page cap
(`--page-max` stays 1760), the table header token and `--row-h` (already one token each; screens
share them), the muted text colour (already 4.5:1 or better in both themes), and the danger button
(`.btn.danger` already existed; only its disabled state is new). All commerce screens opt in.

- **Page cap**: from 1600px a `.cm2 .page` (not `.columns`, `.narrow`, `.form`) is 1280px, left-aligned.
  Attention rows cap their text at 72ch with the action beside it.
- **`.table.stack-md`**: below 1040px the table is card rows: title, then label (90px) and value, two
  columns from 640px, one under. `.table.stack-card` does the same keyed to a card narrower than
  900px (a table beside a rail). Both replace `.stack-phone` for wide tables; nothing is dropped.
- **Column helpers**: `.hide-md` (hidden under 1100), `.only-md` (hidden from 1100), `.hide-tablet`
  (hidden 640 to 1099), `.table.row-48`, `td.chev` (32px chevron column), `.na` (the one muted dash,
  its reason in a title), `.state-line` (a status and a muted count on one baseline). Pills and
  status words never wrap.
- **`.table.ledger-card`**: phone rows as 3-line cards (offer and state, account, store glyph, date,
  license). **`.table.lines-2`**: phone rows as two lines, no labels.
- **Disabled controls**: a disabled `.btn.primary` is an outline, a disabled `.btn.danger` stays red but
  locked, `.switch.disabled` / `[aria-disabled]` is 50% with `not-allowed`.
- **`.card.capped`**: an empty page's card, 640px max, offset under the title.
- **Rails**: `.page.rail-md` (360px rail from 1200px, source order is the narrow order), `.span-all`
  and `.span-rows-2/3` in `.page.columns`. Rule: a rail needs two or more cards (or a card as tall as
  the main block); otherwise the page stays one column.
- **`.mk-with-rail.conn-first`** with `.o0` to `.o4`: below 1280px one column in the order given, so a
  connection card comes before the ledgers; `.kv-rows.cols-2` puts facts in two columns on a wide card.
- **Feature rows**: no status column; the row's facts are one meta line under the description
  (`.reqs` for needs, `.feature-row-note` for a state, next step or failure). Nested switches use the
  row padding and a hairline (no inner box). Dependencies are shown only on the dependent row.
- **Dialogs and drawers**: title and close share one 32px row; `.tiles-24` makes the store icon tiles
  24px; mono values wrap (`overflow-wrap: anywhere`); `.copy-row` is a labelled copyable value;
  `.drawer-section-title`, `.kv-rows.dl-80` (80px label), a 24px fade above `.drawer.scroll` footers,
  `.drawer-foot.between`.
- **Small pieces**: `.pair-12`, `.inline-reason`, `.req-mark`, `.price-line` / `.price-changed`,
  `.btn.link.danger-text`, `.page-end`, `.card-foot.under-tasks`, 24px hit area on `.btn.icon.xs`,
  a 1px edge on an empty `.progress`.
- **Toast**: one line of text and at most one action (`Commerce turned on`, Undo).

Patterns the reviewers praised, to reuse: partial-success dialog rows (one row per store with its own
Changed or Not changed pill and the fix beside it, `commerce.offer-price-failed`), nearest-valid-price
chips (`commerce.offer-price-invalid`), the "In the same change" summary box
(`commerce.add-to-offer`), phone bottom-sheet dialogs with the primary above Cancel, the drawer
timeline (`commerce.purchase`), and typed-confirm gating (the primary disabled until the word is
typed, `commerce.offer-stop-selling`).

## Desktop kit flows by window shape (`uk56-desktop-kits`)

`sdk.macos-gate`, `sdk.windows-gate` and `sdk.gnome-gate` draw one fixture product's gate on a
desktop kit, in both presets, by window shape. Appended at the end of `mockup.css`; no earlier rule
was edited.

- **`.kit-welcome.shape`**: DL1 on a window. The panes read the window's own width (the
  `.kit-host` container), not the board's: two panes from 560, a 56px strip below. The start pane
  is `.art` (product art) under `polaris-key` and `.kit-pane` (the icon on `surface-sunken`) under
  `native`. The end pane is top-aligned. `.short` is a 300px landscape window with the header on one
  line (`.kit-head.inline`); `.sheet` inside a `.kit-stage` is the large window: a sheet-scale card
  on a flat ground.
- **`.window.mac`, `.window.win`, `.window.gnome`**: the host's window chrome (never the kit's).
  The kit draws no title bar and no static accent rule under it.
- **`.kit-host[data-pk-platform][data-pk-preset="native"]`**: the host's tint (the OS's own, not a
  brand colour), the macOS bordered field and the Fluent field. `polaris-key` is the default and
  needs no attribute: the product's accent drives every role.
- **`.kit-stack.cap`**: a stack of block buttons capped at 320. **`.kit-input.mid`**: a key that
  middle-elides at rest (the text carries the ellipsis).
- Order of buttons: macOS Cancel then the default; Windows the primary first; GNOME Cancel then the
  suggested pill at the end.
