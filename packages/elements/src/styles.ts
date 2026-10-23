// The shared stylesheet of the web kits (UI-KITS.md §3.2, §7.1): owned here, adopted into every
// shadow root through `adoptedStyleSheets`, and written to `dist/styles.css` for React (UK-05),
// which renders the same `data-part` DOM. Every measure is a `--pk-*` token (DL3), every
// property logical (RTL-safe, §1.5), type in rem (DL11); the cascade layer `polaris-key` lets a
// host's own rule win without `!important`.

import { tokenCss } from "./tokens.js";

const KIT_CSS = String.raw`
@layer polaris-key {
:host {
  display: block;
  box-sizing: border-box;
}
:host([hidden]) {
  display: none;
}
*,
*::before,
*::after {
  box-sizing: border-box;
}

/* ── The kit root ─────────────────────────────────────────────────────────────────────────── */
.pk-root {
  container: pk / inline-size;
  position: relative;
  color: var(--pk-text-default);
  font-family: var(--pk-kit-type-body-family);
  font-size: var(--pk-kit-type-body-size);
  line-height: var(--pk-kit-type-body-line-height);
  font-weight: var(--pk-kit-type-body-weight);
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  --pk-primary: var(--pk-accent, var(--pk-text-strong));
  --pk-primary-on: var(--pk-accent-on, var(--pk-surface-page));
  --pk-ring: var(--pk-accent-focus, var(--pk-text-strong));
  --pk-selected: var(--pk-accent-subtle, var(--pk-surface-sunken));
  --pk-gap: var(--pk-space-3);
}
.pk-root[data-density="compact"] {
  --pk-kit-control-height: var(--pk-kit-control-height-compact);
  --pk-kit-radius-control: var(--pk-kit-radius-control-compact);
  --pk-gap: var(--pk-space-2);
}
.pk-root[data-density="spacious"] {
  --pk-kit-control-height: var(--pk-kit-control-height-coarse);
  --pk-gap: var(--pk-space-4);
}
@media (pointer: coarse) {
  .pk-root {
    --pk-kit-control-height: var(--pk-kit-control-height-coarse);
  }
}
/* native (§3.4): the host's font, Canvas neutrals, the host's accent, no ambient. */
.pk-root[data-preset="native"] {
  font-family: inherit;
  --pk-kit-type-body-family: initial;
  --pk-kit-type-title-family: initial;
  --pk-kit-type-display-family: initial;
  --pk-kit-type-label-family: initial;
  --pk-kit-type-button-family: initial;
  --pk-kit-type-meta-family: initial;
  --pk-surface-page: Canvas;
  --pk-surface-raised: Canvas;
  --pk-surface-overlay: Canvas;
  --pk-surface-sunken: color-mix(in srgb, CanvasText 6%, Canvas);
  --pk-text-strong: CanvasText;
  --pk-text-default: CanvasText;
  --pk-text-muted: color-mix(in srgb, CanvasText 74%, Canvas);
  --pk-text-subtle: color-mix(in srgb, CanvasText 66%, Canvas);
  --pk-border-subtle: color-mix(in srgb, CanvasText 16%, Canvas);
  --pk-primary: var(--pk-accent, AccentColor);
  --pk-primary-on: var(--pk-accent-on, AccentColorText);
  --pk-ring: var(--pk-accent-focus, AccentColor);
  --pk-selected: var(--pk-accent-subtle, color-mix(in srgb, AccentColor 14%, Canvas));
}

/* DL2, DL18: the drop-in gate's blocking screen owns the window with no layout code from the host. */
.pk-root[data-fill] {
  display: grid;
  min-block-size: 100dvh;
}

/* ── Stage: a blocking screen owns its box on an opaque ground with the product ambient ───── */
.stage {
  position: relative;
  isolation: isolate;
  display: grid;
  align-content: start;
  justify-items: center;
  min-block-size: 100%;
  padding-block: clamp(var(--pk-space-6), 12cqi, var(--pk-space-20)) var(--pk-space-8);
  padding-inline: var(--pk-space-6);
  background: var(--pk-surface-page);
  overflow: clip;
}
.ambient {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: radial-gradient(
      60% 55% at 50% 30%,
      var(--pk-accent-subtle, transparent),
      transparent 70%
    ),
    radial-gradient(40% 40% at 72% 70%, var(--pk-accent-subtle, transparent), transparent 70%);
}
[data-theme="dark"] .ambient img {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 50%;
  inline-size: min(60cqi, 40rem);
  aspect-ratio: 1;
  translate: -50% -20%;
  filter: blur(100px);
  opacity: 0.4;
}
[data-theme="light"] .ambient img {
  display: none;
}

/* ── Card: every gate step in one card (§1.4 Web) ─────────────────────────────────────────── */
.card {
  position: relative;
  inline-size: min(27.5rem, 100%);
  padding: var(--pk-kit-card-pad);
  border-radius: var(--pk-kit-radius-card);
  background: var(--pk-surface-raised);
  box-shadow:
    inset 0 0 0 1px var(--pk-border-subtle),
    inset 0 1px 0 0 var(--pk-kit-highlight),
    var(--pk-elevation-3);
  display: grid;
  gap: var(--pk-space-6);
  text-align: center;
}
.card[data-align="start"] {
  text-align: start;
}
.card:focus {
  outline: none;
}
/* DL3: on a card taller than its window the primary stays in reach, on the card's own surface
   (its own padding, drawn into the gap, so nothing moves while everything fits). */
.stage[data-kind="screen"] .card > .actions {
  position: sticky;
  inset-block-end: 0;
  z-index: 1;
  padding-block: var(--pk-space-2);
  margin-block: calc(-1 * var(--pk-space-2));
  background: var(--pk-surface-raised);
}
@container pk (max-width: 34.99rem) {
  .stage {
    padding: 0;
    align-content: stretch;
  }
  .card {
    inline-size: 100%;
    min-block-size: 100%;
    border-radius: 0;
    box-shadow: none;
    padding: var(--pk-kit-card-pad-full-bleed);
    padding-block-end: max(var(--pk-kit-card-pad-full-bleed), env(safe-area-inset-bottom));
    align-content: start;
  }
  .stage[data-kind="screen"] .card {
    display: flex;
    flex-direction: column;
    gap: var(--pk-space-6);
  }
  /* The actions dock at the bottom of a full-bleed screen (§1.4 Web), and stay there over
     content that scrolls (DL1 tall; DL3: the primary never gives way). */
  .stage[data-kind="screen"] .card > .actions {
    margin-block-start: auto;
    position: sticky;
    inset-block-end: 0;
    z-index: 1;
    margin-inline: calc(-1 * var(--pk-kit-card-pad-full-bleed));
    padding-inline: var(--pk-kit-card-pad-full-bleed);
    padding-block: var(--pk-space-3)
      max(var(--pk-space-3), env(safe-area-inset-bottom));
    background: var(--pk-surface-raised);
    box-shadow: none;
  }
}


/* DL1: two panes in a landscape box from 52.5rem, the identity panel at the start. */
.split {
  display: contents;
}
/* A window-filling screen centres its card with an upper-third bias (DL1): the free space
   under the card is a little more than the space over it. */
.pk-root[data-shape="landscape"][data-fill] .stage {
  align-content: center;
  padding-block: var(--pk-space-8) clamp(var(--pk-space-8), 18dvh, 14rem);
}
/* DL1: the two-pane row is the surface itself (capped near 1040, a 48 gutter), not a card. */
.pk-root[data-shape="landscape"] .stage[data-split] .card {
  inline-size: min(65rem, 100%);
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  column-gap: var(--pk-space-12);
  row-gap: 0;
  align-items: start;
  text-align: start;
  padding: 0;
  border-radius: 0;
  background: none;
  box-shadow: none;
}
/* The end pane's rows are spaced by margin, so the panel can span them all without the
   empty rows' gaps stretching it past the content. */
.pk-root[data-shape="landscape"] .stage[data-split] .card > :not(.passport) {
  grid-column: 2;
}
.pk-root[data-shape="landscape"] .stage[data-split] .card > :not(.passport):not(.shimmer) ~ :not(.passport):not(.shimmer) {
  margin-block-start: var(--pk-space-6);
}
.pk-root[data-shape="landscape"] .stage[data-split] .card > .actions {
  position: static;
  padding-block: 0;
  margin-block-end: 0;
  background: none;
}
.pk-root[data-shape="landscape"] .stage[data-split] .passport {
  grid-column: 1;
  grid-row: 1 / span 20;
  align-self: stretch;
  display: grid;
  place-items: center;
  min-block-size: 18rem;
  border-radius: var(--pk-kit-radius-card);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  background: linear-gradient(
    155deg,
    var(--pk-accent-subtle, var(--pk-surface-sunken)),
    color-mix(in srgb, var(--pk-accent-subtle, var(--pk-surface-sunken)) 45%, var(--pk-surface-raised))
  );
}
.pk-root[data-shape="landscape"][data-theme="dark"] .stage[data-split] .passport {
  background: radial-gradient(
      90% 80% at 50% 38%,
      color-mix(in srgb, var(--pk-accent, var(--pk-accent-subtle, transparent)) 22%, var(--pk-surface-sunken)),
      var(--pk-surface-sunken)
    );
}
/* DL1 dark: the icon ambient fills the identity panel (the icon blurred under the icon). */
.passport-ambient {
  display: none;
}
.pk-root[data-shape="landscape"] .stage[data-split] .passport {
  position: relative;
  isolation: isolate;
  overflow: clip;
}
.pk-root[data-shape="landscape"][data-theme="dark"]:not([data-preset="native"]) .stage[data-split] .passport-ambient {
  display: block;
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}
.passport-ambient img {
  position: absolute;
  inset: -20%;
  inline-size: 140%;
  block-size: 140%;
  object-fit: cover;
  filter: blur(56px) saturate(1.15);
  opacity: 0.5;
}
.pk-root[data-shape="landscape"][data-preset="native"] .stage[data-split] .passport {
  background: var(--pk-surface-sunken);
}
.pk-root[data-shape="landscape"] .stage[data-split] .passport .icon {
  --pk-icon-size: 7.5rem;
}
/* DL1, DL5: the identity panel holds art or the icon and nothing else; the product header
   (icon, name, tier) heads the end pane. The hero's icon is the panel's, so the header keeps
   only what the title does not say. */
.panel-icon {
  display: none;
}
.pk-root[data-shape="landscape"] .stage[data-split] .panel-icon,
.pk-root[data-shape="short"] .stage[data-split] .panel-icon {
  display: contents;
}
.pk-root[data-shape="landscape"] .stage[data-split] .identity[data-size="hero"] .icon,
.pk-root[data-shape="short"] .stage[data-split] .identity[data-size="hero"] .icon {
  display: none;
}
.pk-root[data-shape="landscape"] .stage[data-split] .identity[data-size="hero"]:not(:has(.name)):not(:has(.by)),
.pk-root[data-shape="short"] .stage[data-split] .identity[data-size="hero"]:not(:has(.name)):not(:has(.by)) {
  display: none;
}
.pk-root[data-shape="landscape"] .stage[data-split] .actions,
.pk-root[data-shape="landscape"] .stage[data-split] .links {
  justify-content: start;
}
.pk-root[data-shape="landscape"] .stage[data-split] .links {
  margin-inline-start: calc(-1 * var(--pk-space-1));
}
.pk-root[data-shape="short"] .stage {
  padding-block: var(--pk-space-4);
}
/* DL1 short landscape (under 30rem tall): two columns as well, with no inner scroll; the start
   column sticks, so the identity stays in view if the window still scrolls. */
.pk-root[data-shape="short"] .card {
  gap: var(--pk-space-3);
  padding: var(--pk-space-5);
}
.pk-root[data-shape="short"] .stage[data-split] .card {
  inline-size: min(65rem, 100%);
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  column-gap: var(--pk-space-6);
  row-gap: 0;
  align-items: start;
  text-align: start;
}
.pk-root[data-shape="short"] .stage[data-split] .card > :not(.passport) {
  grid-column: 2;
}
.pk-root[data-shape="short"] .stage[data-split] .card > :not(.passport):not(.shimmer) ~ :not(.passport):not(.shimmer) {
  margin-block-start: var(--pk-space-3);
}
.pk-root[data-shape="short"] .stage[data-split] .passport {
  grid-column: 1;
  grid-row: 1 / span 20;
  align-self: stretch;
  display: grid;
  place-items: center;
  border-radius: var(--pk-kit-radius-group);
  background: var(--pk-accent-subtle, var(--pk-surface-sunken));
}
.pk-root[data-shape="short"] .stage[data-split] .passport .icon {
  --pk-icon-size: 4rem;
  position: sticky;
  inset-block-start: var(--pk-space-4);
}
.pk-root[data-shape="short"] .stage[data-split] .actions {
  justify-content: start;
}
/* The docked bar of a short window is one row (two buttons side by side), on the card's own
   opaque ground, so the screen above it keeps most of the 390 px (DL1, DL3). */
.pk-root[data-shape="short"] .stage[data-kind="screen"] .card > .actions {
  position: sticky;
  inset-block-end: 0;
  z-index: 1;
  flex-direction: row-reverse;
  flex-wrap: wrap;
  justify-content: start;
  padding-block: var(--pk-space-2);
  margin-block: calc(-1 * var(--pk-space-2));
  background: var(--pk-surface-raised);
}
/* The docked bar's opaque ground spans the whole window, so content scrolling under it is hidden
   edge to edge, never sliced at the bar's own width (the stage clips it to the window). */
.pk-root[data-shape="short"]:not([data-tight]) .stage[data-kind="screen"] .card > .actions::before {
  content: "";
  position: absolute;
  inset-block: 0;
  inset-inline: -100vw;
  z-index: -1;
  background: var(--pk-surface-raised);
}
/* A window under 34rem tall (large text), or a short one under 18rem: the bar scrolls with the
   content, never over it. After the short rule above, which it overrides. */
.pk-root[data-tight] .stage[data-kind="screen"] .card > .actions,
.pk-root[data-tight][data-shape="short"] .stage[data-kind="screen"] .card > .actions {
  position: static;
  margin-block: 0;
  padding-block: 0;
}
/* Height is what a short window lacks: a group of links is two columns, not a column. */
.pk-root[data-shape="short"] .links:has(> :nth-child(3)) {
  display: grid;
  grid-template-columns: repeat(2, max-content);
  justify-content: start;
  justify-items: start;
  gap: 0 var(--pk-space-6);
}
.pk-root[data-shape="short"] .stage[data-kind="screen"] .card > .actions .btn {
  inline-size: auto;
  flex: 1 1 10rem;
}

/* UpdatePrompt: the primary takes the first line, Later and Restart when ready share the next. */
.pk-root[data-component="UpdatePrompt"] .card .actions[data-layout="row"] {
  justify-content: stretch;
}
.pk-root[data-component="UpdatePrompt"] .card .actions[data-layout="row"] .btn {
  flex: 1 1 8rem;
}
.pk-root[data-component="UpdatePrompt"] .card .actions[data-layout="row"] .btn[data-variant="primary"] {
  flex-basis: 100%;
}

/* ── Product header (DL5) ─────────────────────────────────────────────────────────────────── */
.identity {
  display: grid;
  justify-items: center;
  gap: var(--pk-space-1_5);
}
.identity[data-size="compact"] {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--pk-space-3);
}
.card[data-align="start"] .identity[data-size="compact"] {
  justify-content: start;
}
.card[data-align="start"] .identity[data-size="medium"] {
  justify-items: start;
}
/* A pane starts at the host's start edge (DL2): its identity header too, over a start-aligned title. */
.pane .identity[data-size="compact"] {
  justify-content: start;
}
.pane .identity[data-size="medium"] {
  justify-items: start;
}
.icon {
  inline-size: var(--pk-icon-size, 6rem);
  block-size: var(--pk-icon-size, 6rem);
  border-radius: 22%;
  object-fit: cover;
  flex: none;
}
.identity[data-size="compact"] .icon {
  --pk-icon-size: 2rem;
}
/* A hero icon never takes more than a fifth of the window, so large text still shows the lede. */
.identity[data-size="hero"] .icon {
  --pk-icon-size: min(6rem, 18dvh);
}
.identity[data-size="medium"] .icon {
  --pk-icon-size: 3.5rem;
}
.monogram {
  display: grid;
  place-items: center;
  background: var(--pk-surface-sunken);
  color: var(--pk-text-strong);
  font-weight: 600;
  font-size: calc(var(--pk-icon-size, 6rem) * 0.46);
  line-height: 1;
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
}
.name {
  color: var(--pk-text-strong);
  font-weight: 500;
}
.identity[data-size="hero"] .name {
  margin-block-start: var(--pk-space-3);
}
.by {
  color: var(--pk-text-subtle);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
}
.tier {
  color: var(--pk-text-muted);
  font-weight: 400;
}

/* ── Type ─────────────────────────────────────────────────────────────────────────────────── */
h1,
h2,
p {
  margin: 0;
}
.title {
  color: var(--pk-text-strong);
  font-family: var(--pk-kit-type-title-family);
  font-size: var(--pk-kit-type-title-size);
  line-height: var(--pk-kit-type-title-line-height);
  font-weight: var(--pk-kit-type-title-weight);
  text-wrap: balance;
}
.title:focus,
.pk-root[data-keyboard] .title:focus-visible {
  outline: none;
}
.title[data-size="display"] {
  font-family: var(--pk-kit-type-display-family);
  font-size: var(--pk-kit-type-display-size);
  line-height: var(--pk-kit-type-display-line-height);
  letter-spacing: var(--pk-kit-type-display-tracking);
}
.title[data-size="section"] {
  font-size: 1.25rem;
  line-height: 1.75rem;
}
/* The subhead under the h1: a fact that heads the content (DeviceLimit's count). */
.title[data-size="sub"] {
  font-family: var(--pk-kit-type-body-family);
  font-size: 1.125rem;
  line-height: 1.625rem;
  font-weight: 500;
}
.lede,
.body {
  color: var(--pk-text-muted);
  text-wrap: pretty;
}
.texts {
  display: grid;
  gap: var(--pk-space-2);
}
.meta,
.footnote,
.status-line {
  color: var(--pk-text-subtle);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
}
.status-line {
  color: var(--pk-text-muted);
}
/* UI-KITS §1.6: the Locker micro mark (16 px) and the phrase, in live text; or the 320 x 104
   badge where 320 px is free (the wrapper is the container), else the line. */
.powered-by-line {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  text-align: center;
  gap: var(--pk-space-2);
  margin: 0;
}
.powered-by-line svg {
  flex: none;
  inline-size: max(16px, 1.25em);
  block-size: max(16px, 1.25em);
}
.powered-by {
  container-type: inline-size;
}
.powered-by-badge {
  display: none;
}
.powered-by-badge svg {
  display: block;
  margin-inline: auto;
  max-inline-size: 100%;
  block-size: auto;
}
@container (min-width: 320px) {
  .powered-by-badge {
    display: block;
  }
  .powered-by[data-variant="badge"] .powered-by-line {
    display: none;
  }
}
.label {
  color: var(--pk-text-default);
  font-size: var(--pk-kit-type-label-size);
  line-height: var(--pk-kit-type-label-line-height);
  font-weight: var(--pk-kit-type-label-weight);
}
.num {
  font-variant-numeric: tabular-nums;
}
bdi {
  unicode-bidi: isolate;
}

/* DL6: a refusal the person can resolve is a neutral callout. DL7: an error is danger. */
.callout {
  display: grid;
  gap: var(--pk-space-1);
  padding: var(--pk-space-3) var(--pk-space-4);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-sunken);
  color: var(--pk-text-default);
  text-align: start;
}
.callout[data-tone="danger"] {
  background: var(--pk-danger-subtle);
  box-shadow: inset 0 0 0 1px var(--pk-danger-border);
}
.callout .callout-title {
  color: var(--pk-text-strong);
  font-weight: 500;
}
.message[data-tone="danger"] {
  color: var(--pk-danger);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
}

/* ── Controls (§1.5 rules 7 and 10, DL4) ─────────────────────────────────────────────────── */
.actions {
  display: flex;
  flex-direction: column;
  gap: var(--pk-gap);
}
.actions[data-layout="row"] {
  flex-direction: row-reverse;
  justify-content: end;
  flex-wrap: wrap;
}
.links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--pk-space-2) var(--pk-space-5);
}
.card[data-align="start"] .links {
  justify-content: start;
}
/* DL4: a group of three or more stacks whole, never a row that wraps 3 + 1. */
.links:has(> :nth-child(3)) {
  flex-direction: column;
  align-items: center;
  gap: 0;
}
.card[data-align="start"] .links:has(> :nth-child(3)),
.pk-root[data-shape="landscape"] .stage[data-split] .links:has(> :nth-child(3)),
.pane .links:has(> :nth-child(3)) {
  align-items: start;
}
/* §4.3 Welcome: the extras are one quiet row of links where the end pane is wide enough
   (the capped two-pane row), and stack whole where it is not (DL4). */
@container pk (min-width: 70rem) {
  .pk-root[data-shape="landscape"] .stage[data-split] .links:has(> :nth-child(3)):not(:has(> :nth-child(5))) {
    flex-direction: row;
    align-items: center;
    gap: var(--pk-space-2) var(--pk-space-4);
    margin-inline-start: 0;
  }
  .pk-root[data-shape="landscape"] .stage[data-split] .links:has(> :nth-child(3)):not(:has(> :nth-child(5))) .btn {
    padding-inline: 0;
  }
}
.btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--pk-space-2);
  min-block-size: var(--pk-kit-control-height);
  min-inline-size: 6rem;
  padding-block: var(--pk-space-2);
  padding-inline: var(--pk-space-5);
  border: 1px solid transparent;
  border-radius: var(--pk-kit-radius-control);
  font-family: var(--pk-kit-type-button-family);
  font-size: var(--pk-kit-type-button-size);
  line-height: var(--pk-kit-type-button-line-height);
  font-weight: var(--pk-kit-type-button-weight);
  text-decoration: none;
  cursor: pointer;
  transition:
    transform var(--pk-duration-fast) var(--pk-ease-standard),
    background-color var(--pk-duration-micro) var(--pk-ease-standard);
}
.actions .btn {
  inline-size: 100%;
}
.actions[data-layout="row"] .btn {
  inline-size: auto;
}
.btn[data-variant="primary"] {
  background: var(--pk-primary);
  color: var(--pk-primary-on);
}
.btn[data-variant="secondary"] {
  background: color-mix(in oklab, var(--pk-text-strong) 8%, var(--pk-surface-raised));
  color: var(--pk-text-strong);
}
.btn[data-variant="danger"] {
  background: var(--pk-kit-danger-solid);
  color: var(--pk-kit-danger-on);
}
.btn[data-variant="link"] {
  min-inline-size: 0;
  min-block-size: 2.75rem;
  padding-inline: var(--pk-space-1);
  background: none;
  color: var(--pk-text-default);
  font-weight: 400;
}
/* Hover only where a pointer hovers: on touch it would stay lit after a tap. The primary
   darkens (away from its text colour), so its text keeps its contrast. */
@media (hover: hover) {
  .btn[data-variant="primary"]:hover {
    background: color-mix(in oklab, var(--pk-primary) 86%, black);
    background: color-mix(
      in oklab,
      var(--pk-primary) 86%,
      oklch(from var(--pk-primary-on) calc(1 - l) 0 0)
    );
  }
  .btn[data-variant="secondary"]:hover {
    background: color-mix(in oklab, var(--pk-text-strong) 13%, var(--pk-surface-raised));
  }
  .btn[data-variant="link"]:hover {
    color: var(--pk-text-strong);
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
}
.btn:active:not([aria-disabled="true"]) {
  transform: scale(var(--pk-motion-scale-press));
}
.btn[aria-disabled="true"] {
  opacity: 0.42;
  cursor: not-allowed;
}
.btn .glyph {
  inline-size: 1em;
  block-size: 1em;
  flex: none;
}
.ring {
  inline-size: 1rem;
  block-size: 1rem;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-inline-end-color: transparent;
  animation: pk-turn 0.8s linear infinite;
}

/* DL9: the ring on keyboard focus only, after a key since load; in the resolved accent. */
:focus {
  outline: none;
}
.pk-root[data-keyboard] :focus-visible {
  outline: var(--pk-kit-focus-width) solid var(--pk-ring);
  outline-offset: var(--pk-kit-focus-offset);
}
.pk-root[data-keyboard] .field input:focus-visible,
.pk-root[data-keyboard] .field textarea:focus-visible {
  outline-offset: 0;
}

/* ── Fields (§1.5 rule 1: filled, no boxed forms) ────────────────────────────────────────── */
.field {
  display: grid;
  gap: var(--pk-space-1_5);
  text-align: start;
}
.field input,
.field textarea,
.field select {
  inline-size: 100%;
  min-block-size: var(--pk-kit-control-height);
  padding-inline: var(--pk-space-4);
  border: 1px solid transparent;
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  color: var(--pk-text-strong);
  font: inherit;
}
.field input:focus-visible,
.field textarea:focus-visible {
  box-shadow: none;
  outline: var(--pk-kit-focus-width) solid var(--pk-ring);
  outline-offset: 0;
}
.field input[data-mono],
.mono {
  font-family: var(--pk-font-mono);
  letter-spacing: 0.02em;
}
.field input[aria-invalid="true"] {
  box-shadow: inset 0 0 0 1px var(--pk-danger-border);
  /* The focus ring of a refused field is danger too, so the refusal stays readable in focus. */
  --pk-ring: var(--pk-danger);
}
.field input[aria-invalid="true"]:focus-visible {
  box-shadow: inset 0 0 0 1px var(--pk-danger-border);
}
/* The field and Paste share a line until the field would shrink below ten characters' worth
   (large text, a narrow window): then Paste stacks under it. */
.field-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pk-space-2);
}
.field-row input {
  flex: 1 1 10rem;
  min-inline-size: min(10rem, 100%);
}
/* §4.3 Activate: the paste control sits inside the key field, at its inline end. */
.field-paste {
  position: relative;
  display: block;
}
.field-paste input {
  padding-inline-end: var(--pk-kit-control-height);
}
.field-paste .paste {
  position: absolute;
  inset-block: 0;
  inset-inline-end: 0;
  min-inline-size: var(--pk-kit-control-height);
  padding-inline: 0;
  color: var(--pk-text-muted);
}
.field-paste .paste:hover {
  color: var(--pk-text-strong);
}

/* ── User code (§2.1 Code) ───────────────────────────────────────────────────────────────── */
.code {
  font-family: var(--pk-kit-type-code-family);
  font-size: clamp(1.75rem, 1rem + 4cqi, var(--pk-kit-type-code-size));
  line-height: 1.2;
  font-weight: var(--pk-kit-type-code-weight);
  letter-spacing: var(--pk-kit-type-code-tracking);
  color: var(--pk-text-strong);
  overflow-wrap: anywhere;
}
.code-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pk-space-3);
}
/* A Copy button beside text sits on the text's own centre line, not on its baseline. */
.body:has(> .btn) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: var(--pk-space-2);
}
.code-row .btn,
.body .btn {
  min-inline-size: var(--pk-kit-control-height);
  padding-inline: var(--pk-space-3);
}
/* QR (DL14): black on a white tile with its quiet zone, a size a phone camera reads across a desk. */
.qr {
  margin: 0;
  inline-size: fit-content;
}
.qr svg {
  display: block;
  inline-size: clamp(8.5rem, 28cqi, 11rem);
  aspect-ratio: 1;
  border-radius: var(--pk-kit-radius-control);
}
.url {
  color: var(--pk-accent-fg, var(--pk-text-strong));
  font-weight: 500;
  word-break: keep-all;
}

/* ── Lists and rows (§1.5 rule 1: inset grouped lists) ───────────────────────────────────── */
.list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border-radius: var(--pk-kit-radius-group);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  overflow: clip;
  text-align: start;
}
/* Past six rows the list scrolls in its own box, so the callout and the primary stay in view
   (its focusable rows make the box keyboard-reachable). */
.list[data-scroll] {
  max-block-size: min(24rem, 55dvh);
  overflow-y: auto;
  overscroll-behavior: contain;
  /* A row is as tall as its content: a two-line name never runs into the next row. */
  grid-auto-rows: max-content;
}
.row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--pk-space-3);
  min-block-size: 3.5rem;
  padding: var(--pk-space-3) var(--pk-space-4);
}
.row + .row {
  border-block-start: 1px solid var(--pk-border-subtle);
}
/* §4.3 DeviceLimit: 64 px rows, hairlines inset past the glyph. */
.row[data-part="device-row"] {
  position: relative;
  min-block-size: 4rem;
}
.row[data-part="device-row"] + .row[data-part="device-row"] {
  border-block-start: 0;
}
.row[data-part="device-row"] + .row[data-part="device-row"]::before {
  content: "";
  position: absolute;
  inset-block-start: 0;
  inset-inline: calc(var(--pk-space-4) + 1.25rem + var(--pk-space-3)) 0;
  block-size: 1px;
  background: var(--pk-border-subtle);
}
.row[aria-checked="true"],
.row[data-selected] {
  background: var(--pk-selected);
}
.row[role="radio"] {
  cursor: pointer;
}
.row .row-title {
  color: var(--pk-text-strong);
}
.row[data-part="settings-row"] {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--pk-space-2) var(--pk-space-3);
}
.row[data-part="settings-row"] > .row-text {
  flex: 1 1 10rem;
}
.row[data-part="settings-row"] > .row-value {
  flex: 0 0 auto;
  margin-inline-start: auto;
}
.row-text {
  display: grid;
  gap: var(--pk-space-0_5);
  min-inline-size: 0;
}
.row-value {
  display: inline-flex;
  align-items: center;
  gap: var(--pk-space-1_5);
  color: var(--pk-text-muted);
  text-align: end;
}
.row-value .glyph {
  inline-size: 1rem;
  block-size: 1rem;
}
.group {
  display: grid;
  gap: var(--pk-space-2);
}
.group-label {
  margin: 0;
  padding-inline: var(--pk-space-1);
  color: var(--pk-text-muted);
}
.row .row-actions {
  display: flex;
  gap: var(--pk-space-1);
}
.row .row-actions .btn {
  min-block-size: 2.5rem;
  min-inline-size: 0;
  padding-inline: var(--pk-space-3);
}
/* A license row: the tier pill is one width down the list so the text lines up; a full license's Replace sits under its text. */
.row[data-part="license-row"] > .pill:first-child {
  min-inline-size: 4rem;
  justify-content: center;
}
.row[role="group"][data-part="license-row"] {
  grid-template-columns: auto minmax(0, 1fr);
}
.row[role="group"][data-part="license-row"] > .btn {
  grid-column: 1 / -1;
  inline-size: 100%;
}
/* A narrow box (large text on a phone): the tier sits above the counts, in one column, so no
   count is clipped. */
@container pk (max-width: 18rem) {
  .row[data-part="license-row"] {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .row[data-part="license-row"] > .pill:first-child {
    grid-column: 1 / -1;
    justify-self: start;
    min-inline-size: 0;
  }
  .row[role="group"][data-part="license-row"] {
    grid-template-columns: minmax(0, 1fr);
  }
}
.meta-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pk-space-0_5) var(--pk-space-2);
}
.check {
  inline-size: 1.25rem;
  block-size: 1.25rem;
  color: var(--pk-accent-fg, var(--pk-text-strong));
}
.row-glyph {
  inline-size: 1.25rem;
  block-size: 1.25rem;
  color: var(--pk-text-muted);
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: var(--pk-space-1);
  padding: var(--pk-space-0_5) var(--pk-space-2);
  border-radius: var(--pk-radius-full);
  background: var(--pk-surface-sunken);
  color: var(--pk-text-default);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
  font-weight: 500;
  inline-size: fit-content;
}
/* §4.3 DeviceLimit k-tag: quiet and neutral, text-strong at 9 %. */
.row[data-part="device-row"] .pill:not([data-status]) {
  background: color-mix(in srgb, var(--pk-text-strong) 9%, transparent);
  color: var(--pk-text-strong);
  margin-inline-start: var(--pk-space-1);
}
.pill[data-status="warning"] {
  background: var(--pk-warning-subtle);
  color: var(--pk-warning);
}
.pill[data-status="danger"] {
  background: var(--pk-danger-subtle);
  color: var(--pk-danger);
}
.pill[data-status="success"] {
  background: var(--pk-success-subtle);
  color: var(--pk-success);
}

/* Seat meter (§1.5 rule 9): neutral segments, never a warning at the limit. */
.seats {
  display: grid;
  gap: var(--pk-space-1_5);
}
/* §4.1 LicenseChoice: the seat meter under a license row's count is a short bar. */
.row .seats {
  max-inline-size: 8rem;
  margin-block: var(--pk-space-1);
}
.seat-bar {
  display: flex;
  gap: var(--pk-space-1);
}
.seat-bar span {
  flex: 1;
  block-size: 0.375rem;
  border-radius: var(--pk-radius-full);
  background: color-mix(in srgb, var(--pk-text-strong) 10%, transparent);
}
.seat-bar span[data-used] {
  background: color-mix(in srgb, var(--pk-text-strong) 80%, transparent);
}

/* Progress: determinate only for counted bytes (DL7). */
.progress {
  block-size: 0.375rem;
  border-radius: var(--pk-radius-full);
  background: color-mix(in srgb, var(--pk-text-strong) 10%, transparent);
  overflow: clip;
}
.progress > span {
  display: block;
  block-size: 100%;
  inline-size: calc(var(--pk-fraction, 0) * 100%);
  background: var(--pk-primary);
  transition: inline-size var(--pk-duration-base) var(--pk-ease-standard);
}

/* Unknown size (a desktop install whose driver reports no total): a sweep, never a percentage.
   Standing still, centred, under reduced motion. */
.progress[data-indeterminate] > span {
  position: relative;
  inline-size: 40%;
  transition: none;
  animation: pk-sweep var(--pk-duration-shimmer) var(--pk-ease-standard) infinite;
}
.pk-root[data-motion="reduced"] .progress[data-indeterminate] > span {
  animation: none;
  inset-inline-start: 30%;
}

/* §1.5 rule 4: the indeterminate 2 px shimmer along the container's top edge. */
.shimmer {
  position: absolute;
  inset-block-start: 0;
  inset-inline: 0;
  block-size: 2px;
  overflow: clip;
  border-start-start-radius: inherit;
  border-start-end-radius: inherit;
}
.shimmer::before {
  content: "";
  position: absolute;
  inset-block: 0;
  inline-size: 40%;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--pk-text-strong) 45%, transparent),
    transparent
  );
  animation: pk-sweep var(--pk-duration-shimmer) var(--pk-ease-standard) infinite;
}
.pk-root[data-motion="reduced"] .shimmer::before,
.pk-root[data-motion="reduced"] .ring {
  animation: none;
  inset-inline-start: 30%;
}
.skeleton {
  display: grid;
  gap: var(--pk-space-2);
}
.skeleton span[data-short] {
  inline-size: 70%;
}
.skeleton span {
  block-size: 0.75rem;
  border-radius: var(--pk-radius-full);
  background: color-mix(in srgb, var(--pk-text-strong) 8%, transparent);
}

/* ── Panes (DL2): start edge, at most 40rem, opaque controls ─────────────────────────────── */
.pane {
  position: relative;
  display: grid;
  gap: var(--pk-space-5);
  max-inline-size: 40rem;
  padding: var(--pk-space-6);
  border-radius: var(--pk-kit-radius-group);
  background: var(--pk-surface-raised);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  text-align: start;
}
:host([bare]) .pane {
  padding: 0;
  background: none;
  box-shadow: none;
}
.pane > * {
  min-inline-size: 0;
}
/* A form's actions sit at the pane's end, the primary last (row-reverse puts the first in the
   DOM, the primary, at the end edge). */
.pane .actions {
  flex-direction: row-reverse;
  flex-wrap: wrap;
  justify-content: flex-start;
}
/* A narrow box (or large text) puts a row's actions under its text, never squeezing it. */
@container pk (max-width: 30rem) {
  .row:has(> .row-actions) {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .row .row-actions {
    grid-column: 2;
    flex-wrap: wrap;
    margin-inline-start: calc(-1 * var(--pk-space-1));
  }
}
.pane .actions .btn {
  inline-size: auto;
}
/* A pane starts at the host's start edge, its links too (DL2). */
.pane .links {
  justify-content: start;
}

/* ── Banner, toast, inline status ────────────────────────────────────────────────────────── */
.banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pk-space-3) var(--pk-space-4);
  padding: var(--pk-space-3) var(--pk-space-4);
  border-radius: var(--pk-kit-radius-group);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  /* Inset from the host's edge, so the frame never touches the window. */
  margin: var(--pk-space-3);
}
.banner .texts {
  flex: 1 1 16rem;
  gap: var(--pk-space-0_5);
}
.banner .actions {
  flex-direction: row;
  gap: var(--pk-space-2);
}
.banner .actions .btn {
  inline-size: auto;
}
.toast {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--pk-space-3);
  inline-size: min(26rem, 100%);
  padding: var(--pk-space-3) var(--pk-space-4);
  border-radius: var(--pk-kit-radius-group);
  background: var(--pk-surface-overlay);
  box-shadow:
    inset 0 0 0 1px var(--pk-border-subtle),
    var(--pk-elevation-2);
  overflow: clip;
}
.toast .texts {
  flex: 1;
}
/* The toast an existing license leaves in the page when its sheet closes: low, over the app,
   for a few seconds. */
.toast.pk-flash {
  position: fixed;
  inset-block-end: max(var(--pk-space-6), env(safe-area-inset-bottom));
  /* §4.1 Toast: bottom right, and the full width of a phone along the bottom. */
  inset-inline: auto var(--pk-space-6);
  z-index: 5;
  animation: pk-rise var(--pk-duration-slow) var(--pk-ease-enter) both;
}
@media (max-width: 35rem) {
  .toast.pk-flash {
    inset-inline: var(--pk-space-3);
    inline-size: auto;
  }
}
.toast .timer {
  position: absolute;
  inset-block-end: 0;
  inset-inline-start: 0;
  block-size: 2px;
  inline-size: 100%;
  background: color-mix(in srgb, var(--pk-text-strong) 30%, transparent);
}
.status-glyph {
  inline-size: 1.25rem;
  block-size: 1.25rem;
  flex: none;
}
[data-status="success"] .status-glyph {
  color: var(--pk-success);
}
[data-status="warning"] .status-glyph {
  color: var(--pk-warning);
}
[data-status="danger"] .status-glyph {
  color: var(--pk-danger);
}
.inline-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pk-space-2) var(--pk-space-3);
  color: var(--pk-text-muted);
}

/* ── Dialog (DL2): over the scrim, a bottom sheet under 35rem ────────────────────────────── */
dialog {
  border: 0;
  padding: 0;
  background: transparent;
  max-inline-size: 100%;
  overflow: visible;
}
dialog::backdrop {
  background: var(--pk-kit-scrim);
  backdrop-filter: blur(var(--pk-kit-scrim-blur));
}
dialog[open] .card {
  transition:
    opacity var(--pk-duration-slow) var(--pk-ease-enter),
    transform var(--pk-duration-slow) var(--pk-ease-enter);
}
@starting-style {
  dialog[open] .card {
    opacity: 0;
    transform: scale(var(--pk-motion-scale-enter));
  }
}
dialog[open]::backdrop {
  transition: opacity var(--pk-duration-base) var(--pk-ease-standard);
}
@starting-style {
  dialog[open]::backdrop {
    opacity: 0;
  }
}
/* presentation="sheet" (D-79): the one form in a modal dialog over the scrim, the host inert. */
dialog.sheet {
  margin: auto;
  inline-size: min(27.5rem, 100% - 2 * var(--pk-space-4));
  max-block-size: calc(100% - 2 * var(--pk-space-6));
  overflow: auto;
  color: inherit;
}
dialog.sheet .stage {
  grid-template-columns: minmax(0, 1fr);
  min-block-size: 0;
  padding: 0;
  background: none;
  overflow: visible;
}
dialog.sheet .ambient,
dialog.sheet .passport-ambient {
  display: none;
}
dialog.sheet .card,
.pk-root[data-shape] dialog.sheet .stage[data-split] .card {
  background: var(--pk-surface-raised);
  inline-size: 100%;
  min-block-size: 0;
  /* One column that may shrink: at large text a long word wraps, the card never outgrows the sheet. */
  grid-template-columns: minmax(0, 1fr);
  border-radius: var(--pk-kit-radius-card);
  padding: var(--pk-kit-card-pad);
  /* The dialog box clips an outer shadow into a lighter square at the corners; the scrim already
     lifts the card. */
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
}
.pk-root[data-shape] dialog.sheet .stage[data-split] .passport {
  display: contents;
}
.pk-root[data-shape] dialog.sheet .stage[data-split] .passport .panel-icon {
  display: none;
}
.pk-root[data-shape] dialog.sheet .stage[data-split] .identity[data-size="hero"] .icon {
  display: revert;
}
/* In the sheet the identity is the compact header over the title, never the wide panel. */
.pk-root[data-shape] dialog.sheet .stage[data-split] .passport .identity {
  display: flex;
  justify-content: start;
  text-align: start;
}
.pk-root[data-shape] dialog.sheet .stage[data-split] .passport .icon {
  --pk-icon-size: 2rem;
}
/* Under 35rem the sheet docks to the bottom edge, past the home indicator (DL2, DL17). */
@media (max-width: 35rem) {
  dialog.sheet {
    margin-block-end: 0;
    inline-size: 100%;
    max-inline-size: 100%;
  }
  dialog.sheet .card,
  .pk-root[data-shape] dialog.sheet .stage[data-split] .card {
    border-end-start-radius: 0;
    border-end-end-radius: 0;
    padding-block-end: max(var(--pk-kit-card-pad), env(safe-area-inset-bottom));
  }
}
.pk-root[data-motion="reduced"] dialog[open] .card,
.pk-root[data-motion="reduced"] dialog[open]::backdrop {
  transition: none;
}

/* ── GNOME (libadwaita, UK-06.7): 34 px controls at radius 8, cards and lists at 12, pill actions,
   the sheet an AdwDialog, the update prompt an AdwAlertDialog, message screens an AdwStatusPage,
   every surface opaque. The measures are the variant's tokens (tokens.ts writes them from brand);
   this block is structure, and every rule is scoped to data-pk-platform="gnome". The suggested
   action is last in a row of two and first in a stack, in the DOM order too, so Tab follows the eye.
   ───────────────────────────────────────────────────────────────────────────────────────────── */
.pk-root[data-pk-platform="gnome"] {
  --pk-kit-radius-card: 0.75rem;
  --pk-kit-radius-group: 0.75rem;
  --pk-gap: var(--pk-space-2);
  --pk-gnome-edge: rgb(255 255 255 / 0.08);
  --pk-gnome-shadow: rgb(0 0 0 / 0.45);
  --pk-gnome-pill: max(2.5rem, var(--pk-kit-control-height));
}
/* In light the edge is a 7 % ink hairline; in dark it is a light hairline, never a dark outline. */
/* Touch wins per variant: the variant's own 34 px would otherwise beat the coarse-pointer rule. */
@media (pointer: coarse) {
  .pk-root[data-pk-platform="gnome"] {
    --pk-kit-control-height: var(--pk-kit-control-height-coarse);
  }
}
.pk-root[data-pk-platform="gnome"][data-theme="light"] {
  --pk-gnome-edge: rgb(0 0 6 / 0.07);
  --pk-gnome-shadow: rgb(0 0 6 / 0.18);
}
.pk-root[data-pk-platform="gnome"] .btn[data-variant="secondary"] {
  background: color-mix(in oklab, var(--pk-text-strong) 10%, var(--pk-surface-raised));
}
.pk-root[data-pk-platform="gnome"] .btn:active:not([aria-disabled="true"]) {
  transform: none;
}
/* The responses of a form, a dialog or a message are pills (the suggested action and its
   siblings); every other control keeps the 34 px / radius 8 measure. */
.pk-root[data-pk-platform="gnome"] .actions .btn:not([data-variant="link"]) {
  border-radius: 9999px;
  min-block-size: var(--pk-gnome-pill);
  padding-inline: var(--pk-space-6);
}
/* The ring is the text colour (it holds 3:1 against the accent fill and the page); a field's is
   inset, as libadwaita draws it. */
.pk-root[data-pk-platform="gnome"][data-keyboard] :focus-visible {
  outline: var(--pk-kit-focus-width) solid var(--pk-text-strong);
  outline-offset: 2px;
}
.pk-root[data-pk-platform="gnome"][data-keyboard] .field input:focus-visible,
.pk-root[data-pk-platform="gnome"][data-keyboard] .field textarea:focus-visible {
  outline-offset: var(--pk-kit-focus-offset);
}
/* Stacked by default: one column in the DOM order, the suggested action first and on top (first in
   Tab order). Two responses in a landscape or short box are a row at equal width, the suggested
   action last at the trailing end (the renderer puts it last in the DOM, so no CSS reordering);
   a label wider than its half cannot shrink, so the pair wraps rather than wrapping a label. */
.pk-root[data-pk-platform="gnome"] .actions {
  flex-direction: column;
  flex-wrap: nowrap;
}
.pk-root[data-pk-platform="gnome"] .actions .btn:not([data-variant="link"]) {
  flex: none;
  inline-size: 100%;
  min-inline-size: 0;
}
.pk-root[data-pk-platform="gnome"][data-shape="short"] .stage[data-kind="screen"] .card > .actions {
  flex-direction: row;
  flex-wrap: wrap;
}
.pk-root[data-pk-platform="gnome"] .actions[data-primary="last"],
.pk-root[data-pk-platform="gnome"][data-shape="short"] .stage[data-kind="screen"] .card > .actions[data-primary="last"] {
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: stretch;
}
.pk-root[data-pk-platform="gnome"] .actions[data-primary="last"] .btn:not([data-variant="link"]) {
  flex: 1 1 calc(50% - var(--pk-gap) / 2);
  min-inline-size: max-content;
  inline-size: auto;
}
.pk-root[data-pk-platform="gnome"][data-component="UpdatePrompt"] .card .actions[data-primary="last"] {
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: stretch;
}
.pk-root[data-pk-platform="gnome"][data-component="UpdatePrompt"] .card .actions[data-primary="last"] .btn:not([data-variant="link"]) {
  flex: 1 1 calc(50% - var(--pk-gap) / 2);
  min-inline-size: max-content;
  inline-size: auto;
}
.pk-root[data-pk-platform="gnome"][data-component="UpdatePrompt"] .card .actions:not([data-primary="last"]) {
  flex-direction: column;
  flex-wrap: nowrap;
}
.pk-root[data-pk-platform="gnome"][data-component="UpdatePrompt"] .card .actions:not([data-primary="last"]) .btn:not([data-variant="link"]) {
  flex: none;
  inline-size: 100%;
}
/* A window narrower than 20 rem (200 % text on a phone) cannot hold a label's whole line: it wraps. */
@container pk (max-width: 19.99rem) {
  .pk-root[data-pk-platform="gnome"] .actions[data-primary="last"] .btn:not([data-variant="link"]) {
    min-inline-size: 0;
  }
}
/* The two-pane gate keeps its response bar in the window: pinned to the bottom edge on the page's
   own ground, so a window shorter than the form (900 x 600) never hides the suggested action. */
.pk-root[data-pk-platform="gnome"][data-shape="landscape"] .stage[data-split] .card > .actions {
  position: sticky;
  inset-block-end: 0;
  z-index: 1;
  padding-block: var(--pk-space-3);
  margin-block-end: calc(-1 * var(--pk-space-3));
  background: var(--pk-surface-page);
}
/* AdwBanner: a content-sized row at the trailing end of a strip (Reconnect a pill, Dismiss flat);
   under a narrow window it drops below the text. */
.pk-root[data-pk-platform="gnome"] .banner .actions {
  flex-direction: row;
  flex-wrap: nowrap;
  margin-inline-start: auto;
}
.pk-root[data-pk-platform="gnome"] .banner .actions .btn:not([data-variant="link"]) {
  flex: none;
  inline-size: auto;
  min-inline-size: 0;
}
.pk-root[data-pk-platform="gnome"] .banner .actions .btn[data-variant="secondary"] {
  background: none;
}
/* Links are accent text. */
.pk-root[data-pk-platform="gnome"] .btn[data-variant="link"] {
  color: var(--pk-accent-fg, var(--pk-text-strong));
}
/* AdwDialog (the sheet): centred at 28.75 rem, radius 14 with a soft shadow and a hairline edge
   on the dialog box itself (its own overflow cannot clip it), opaque. Narrow, it docks to the
   bottom edge as a sheet, rounded on top only. */
.pk-root[data-pk-platform="gnome"] dialog.sheet {
  inline-size: min(28.75rem, 100% - 2 * var(--pk-space-4));
  border-radius: var(--pk-kit-radius-dialog);
  background: var(--pk-surface-raised);
  box-shadow:
    0 0 0 1px var(--pk-gnome-edge),
    0 2px 14px 3px var(--pk-gnome-shadow),
    0 16px 40px var(--pk-gnome-shadow);
}
.pk-root[data-pk-platform="gnome"][data-shape] dialog.sheet .stage .card {
  padding: var(--pk-kit-card-pad);
  border-radius: var(--pk-kit-radius-dialog);
  background: var(--pk-surface-raised);
  box-shadow: none;
}
/* A window that fills (landscape, data-fill) pads its stage; the dialog's stage never does. */
.pk-root[data-pk-platform="gnome"] dialog.sheet {
  scroll-padding-block-end: 6rem;
}
.pk-root[data-pk-platform="gnome"][data-shape] dialog.sheet .stage {
  padding: 0;
  min-block-size: 0;
  align-content: start;
}
/* AdwAlertDialog: the update prompt, a narrower dialog with its title and body centred. */
.pk-root[data-pk-platform="gnome"][data-component="UpdatePrompt"] dialog.sheet {
  inline-size: min(25rem, 100% - 2 * var(--pk-space-4));
}
@media (max-width: 35rem) {
  .pk-root[data-pk-platform="gnome"] dialog.sheet {
    inline-size: 100%;
    border-end-start-radius: 0;
    border-end-end-radius: 0;
  }
  .pk-root[data-pk-platform="gnome"][data-shape] dialog.sheet .stage .card {
    border-end-start-radius: 0;
    border-end-end-radius: 0;
  }
}
.pk-root[data-pk-platform="gnome"] dialog::backdrop {
  backdrop-filter: none;
}
/* AdwStatusPage: a message screen has no card, only the icon, the title, the body and the
   responses, stacked and centred, the suggested action first. */
.pk-root[data-pk-platform="gnome"]:is([data-component="StatusScreen"], [data-component="Boot"]:is([data-state="blocked"], [data-state="error"], [data-state="offline"], [data-state="declined"], [data-state="rolled-back"])) .stage[data-kind="screen"] .card {
  inline-size: min(35rem, 100%);
  background: transparent;
  box-shadow: none;
  text-align: center;
}
.pk-root[data-pk-platform="gnome"]:is([data-component="StatusScreen"], [data-component="Boot"]:is([data-state="blocked"], [data-state="error"], [data-state="offline"], [data-state="declined"], [data-state="rolled-back"])) .stage[data-kind="screen"] {
  align-content: center;
}
.pk-root[data-pk-platform="gnome"]:is([data-component="StatusScreen"], [data-component="Boot"]:is([data-state="blocked"], [data-state="error"], [data-state="offline"], [data-state="declined"], [data-state="rolled-back"])) .stage[data-kind="screen"] .card {
  min-block-size: 0;
  align-content: center;
}
.pk-root[data-pk-platform="gnome"]:is([data-component="StatusScreen"], [data-component="Boot"]:is([data-state="blocked"], [data-state="error"], [data-state="offline"], [data-state="declined"], [data-state="rolled-back"])) .stage[data-kind="screen"] .card > .actions::before {
  display: none;
}
.pk-root[data-pk-platform="gnome"]:is([data-component="StatusScreen"], [data-component="Boot"]:is([data-state="blocked"], [data-state="error"], [data-state="offline"], [data-state="declined"], [data-state="rolled-back"])) .stage[data-kind="screen"] .card > .actions {
  position: static;
  margin-block: 0;
  margin-inline: auto;
  padding-block: 0;
  background: none;
  flex-direction: column;
  align-items: stretch;
  justify-self: center;
  inline-size: min(100%, 15rem);
}
.pk-root[data-pk-platform="gnome"]:is([data-component="StatusScreen"], [data-component="Boot"]:is([data-state="blocked"], [data-state="error"], [data-state="offline"], [data-state="declined"], [data-state="rolled-back"])) .stage[data-kind="screen"] .card > .actions .btn {
  flex: none;
  inline-size: 100%;
}
@media (forced-colors: active) {
  .pk-root[data-pk-platform="gnome"][data-keyboard] :focus-visible {
    outline-color: Highlight;
  }
  .pk-root[data-pk-platform="gnome"] dialog.sheet {
    border: 1px solid CanvasText;
    box-shadow: none;
  }
}

/* ── Windows (Fluent 2, UK-06.6): 32 px controls at radius 4, overlays at radius 8, the sheet as a
   ContentDialog (a centred 30 rem dialog with its own shadow, the body scrolling above a pinned
   footer), the two-tone focus ring. The measures are the variant's tokens (tokens.ts writes them
   from brand); this block is structure. There is no accent rule: the primary's fill is the only
   accent on a control, and links are accent text. ────────────────────────────────────────── */
.pk-root[data-pk-platform="windows"] {
  --pk-kit-radius-card: var(--pk-kit-radius-overlay);
  --pk-kit-radius-group: var(--pk-kit-radius-control);
  --pk-gap: var(--pk-space-2);
}
/* 32 px: a 1 px border, 5 px, the 20 px line, 5 px. Only the filled buttons take side padding. */
.pk-root[data-pk-platform="windows"] .btn {
  padding-block: 0.3125rem;
}
.pk-root[data-pk-platform="windows"] .btn:is([data-variant="primary"], [data-variant="secondary"], [data-variant="danger"]) {
  padding-inline: var(--pk-space-4);
}
.pk-root[data-pk-platform="windows"] .btn[data-variant="secondary"] {
  border-color: var(--pk-border-subtle);
  background: color-mix(in oklab, var(--pk-text-strong) 6%, var(--pk-surface-raised));
}
.pk-root[data-pk-platform="windows"] .btn[data-variant="link"] {
  color: var(--pk-accent-fg, var(--pk-text-strong));
}
/* Fluent presses in place: no scale. */
.pk-root[data-pk-platform="windows"] .btn:active:not([aria-disabled="true"]) {
  transform: none;
}
/* Paste is a square inside the field, as tall as the field. */
.pk-root[data-pk-platform="windows"] .field-paste .paste {
  padding: 0;
  min-block-size: 0;
  block-size: 100%;
  inline-size: var(--pk-kit-control-height);
}
/* The ring: 2 px in the strongest text colour with a 1 px gap in the surface inside it, so it
   holds against the accent fill and the page alike (an accent ring on an accent button vanishes). */
.pk-root[data-pk-platform="windows"][data-keyboard] :focus-visible {
  outline: var(--pk-kit-focus-width) solid var(--pk-text-strong);
  outline-offset: var(--pk-kit-focus-inner);
  box-shadow: 0 0 0 var(--pk-kit-focus-inner) var(--pk-surface-raised);
}
.pk-root[data-pk-platform="windows"][data-keyboard] .field input:focus-visible,
.pk-root[data-pk-platform="windows"][data-keyboard] .field textarea:focus-visible {
  outline-offset: 0;
  box-shadow: none;
}
/* In page content a choice between actions is content-sized, primary first (Fluent buttons are at
   least 120 px wide); equal widths are the dialog footer's convention. */
.pk-root[data-pk-platform="windows"] .actions[data-layout="row"] {
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: flex-start;
}
.pk-root[data-pk-platform="windows"] .actions[data-layout="row"] .btn {
  flex: 0 0 auto;
  inline-size: auto;
  min-inline-size: 7.5rem;
}
/* The sheet is a ContentDialog: centred (never docked to the bottom), 30 rem, radius 8 and its
   own shadow. The card scrolls its body; the footer is pinned to the card's bottom edge. */
.pk-root[data-pk-platform="windows"] dialog.sheet {
  margin: auto;
  inline-size: min(30rem, 100% - 2 * var(--pk-space-4));
  max-inline-size: none;
  max-block-size: none;
  overflow: visible;
  border-radius: var(--pk-kit-radius-overlay);
  box-shadow:
    0 0 0 1px var(--pk-border-subtle),
    0 2px 21px color-mix(in srgb, black 37%, transparent),
    0 32px 64px color-mix(in srgb, black 37%, transparent);
}
.pk-root[data-pk-platform="windows"][data-shape] dialog.sheet .stage .card {
  container: pkdlg / inline-size;
  gap: var(--pk-space-4);
  padding: var(--pk-kit-card-pad) var(--pk-kit-card-pad) 0;
  border-radius: var(--pk-kit-radius-overlay);
  overflow: hidden auto;
  max-block-size: calc(100dvh - 3rem);
  box-shadow: none;
}
.pk-root[data-pk-platform="windows"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) {
  position: sticky;
  inset-block-end: 0;
  z-index: 1;
  flex-direction: row;
  flex-wrap: nowrap;
  justify-content: stretch;
  margin: 0 calc(-1 * var(--pk-kit-card-pad));
  padding: var(--pk-kit-card-pad);
  background: color-mix(in oklab, var(--pk-text-strong) 4%, var(--pk-surface-raised));
  border-block-start: 1px solid var(--pk-border-subtle);
  box-shadow: none;
}
.pk-root[data-pk-platform="windows"][data-theme="dark"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) {
  background: color-mix(in oklab, black 14%, var(--pk-surface-raised));
}
/* A footer label never wraps: the buttons share the footer's width equally, and stack (primary on
   top) when there are three or more or the dialog is narrower than 22 rem. */
.pk-root[data-pk-platform="windows"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) .btn {
  flex: 1 1 0;
  inline-size: auto;
  min-inline-size: 0;
  white-space: nowrap;
}
.pk-root[data-pk-platform="windows"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]):has(> :nth-child(3)) {
  flex-direction: column;
}
@container pkdlg (max-width: 22rem) {
  .pk-root[data-pk-platform="windows"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) {
    flex-direction: column;
  }
}
.pk-root[data-pk-platform="windows"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]):has(> :nth-child(3)) .btn,
.pk-root[data-pk-platform="windows"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) .btn:only-child {
  flex: none;
  inline-size: 100%;
}
/* No round close beside a footer that already has Cancel or Close (Escape still closes). */
.pk-root[data-pk-platform="windows"] dialog.sheet:has(.card > .actions .btn:is([data-key="common.cancel"], [data-key="common.close"])) .sheet-close {
  display: none;
}
.pk-root[data-pk-platform="windows"] dialog::backdrop {
  backdrop-filter: none;
}

/* ── Controls of the panes: switch, segmented choice, steps, notes ───────────────────────── */
.switch-wrap {
  display: inline-flex;
  align-items: center;
  gap: var(--pk-space-2);
}
.switch {
  position: relative;
  inline-size: 2.75rem;
  block-size: 1.5rem;
  min-block-size: 1.5rem;
  padding: 0;
  border: 0;
  border-radius: var(--pk-radius-full);
  background: var(--pk-border-strong, var(--pk-text-muted));
  cursor: pointer;
  /* A 24 px target in a row that is itself 56 px tall. */
}
.switch[aria-checked="true"] {
  background: var(--pk-primary);
}
.switch[aria-disabled="true"] {
  opacity: 0.5;
  cursor: not-allowed;
}
.switch-thumb {
  position: absolute;
  inset-block-start: 0.125rem;
  inset-inline-start: 0.125rem;
  inline-size: 1.25rem;
  block-size: 1.25rem;
  border-radius: var(--pk-radius-full);
  background: var(--pk-primary-on, var(--pk-surface-page));
  transition: translate var(--pk-duration-base) var(--pk-ease-standard);
}
.switch[aria-checked="true"] .switch-thumb {
  translate: 1.25rem 0;
}
:dir(rtl) .switch[aria-checked="true"] .switch-thumb {
  translate: -1.25rem 0;
}
.pk-root[data-motion="reduced"] .switch-thumb {
  transition: none;
}
.segmented {
  display: inline-flex;
  padding: var(--pk-space-0_5);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
}
.segmented button {
  min-block-size: 2rem;
  padding-inline: var(--pk-space-3);
  border: 0;
  border-radius: var(--pk-kit-radius-control);
  background: none;
  color: var(--pk-text-default);
  font: inherit;
  cursor: pointer;
}
.segmented button[aria-checked="true"] {
  background: var(--pk-surface-page);
  color: var(--pk-text-strong);
  box-shadow: 0 0 0 1px var(--pk-border-subtle);
}
.segmented button[aria-disabled="true"] {
  opacity: 0.6;
  cursor: not-allowed;
}
.steps {
  display: grid;
  gap: var(--pk-space-4);
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: pk-step;
  text-align: start;
}
.step-item {
  display: grid;
  gap: var(--pk-space-2);
  counter-increment: pk-step;
  padding-inline-start: var(--pk-space-8, 2rem);
  position: relative;
}
.step-item::before {
  content: counter(pk-step);
  position: absolute;
  inset-inline-start: 0;
  inset-block-start: 0;
  display: grid;
  place-items: center;
  inline-size: 1.5rem;
  block-size: 1.5rem;
  border-radius: var(--pk-radius-full);
  background: var(--pk-surface-sunken);
  color: var(--pk-text-strong);
  font-size: var(--pk-kit-type-meta-size);
  font-weight: 600;
}
.step-item .body {
  margin: 0;
}
.notes {
  margin: 0;
  padding-inline-start: var(--pk-space-5, 1.25rem);
  text-align: start;
  color: var(--pk-text-default);
}
.row .field {
  min-inline-size: 0;
}
.row-value .field input {
  inline-size: 7rem;
}
.row-value .field input[type="text"],
.row-value .field select {
  inline-size: 12rem;
}
/* A bounded number: the slider, with its value read out beside it (§4.1). */
.slider {
  display: inline-flex;
  align-items: center;
  gap: var(--pk-space-3);
}
.slider input[type="range"] {
  inline-size: 9rem;
  min-block-size: 1.5rem;
  accent-color: var(--pk-primary);
}
.slider output {
  min-inline-size: 2.5ch;
  text-align: end;
  font-variant-numeric: tabular-nums;
}
.sheet-close {
  position: absolute;
  inset-block-start: var(--pk-space-3);
  inset-inline-end: var(--pk-space-3);
  display: grid;
  place-items: center;
  inline-size: var(--pk-kit-control-height);
  block-size: var(--pk-kit-control-height);
  border: 0;
  border-radius: var(--pk-radius-full);
  background: var(--pk-surface-sunken);
  color: var(--pk-text-strong);
  cursor: pointer;
  z-index: 3;
}
/* The close button sits in the sheet's corner: the header keeps clear of it, whatever the text size. */
dialog.sheet .identity {
  padding-inline-end: calc(var(--pk-kit-control-height) + var(--pk-space-2));
  /* A name too wide for the line beside the icon goes under it, never under the close button. */
  flex-wrap: wrap;
}
.sheet-close .glyph {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}

/* ── Motion: the step morph (View Transitions, §4.8) ─────────────────────────────────────── */
@keyframes pk-sweep {
  from {
    inset-inline-start: -40%;
  }
  to {
    inset-inline-start: 100%;
  }
}
@keyframes pk-turn {
  to {
    rotate: 1turn;
  }
}
@keyframes pk-enter {
  from {
    opacity: 0;
    translate: 0 var(--pk-motion-distance-md);
  }
}
.step {
  animation: pk-enter var(--pk-duration-base) var(--pk-ease-standard);
}
/* stagger-list (§3.18): rows rise in, a step apart, at most six steps. */
@keyframes pk-rise {
  from {
    opacity: 0;
    translate: 0 var(--pk-motion-distance-sm);
  }
}
.pk-stagger > * {
  animation: pk-rise var(--pk-duration-base) var(--pk-ease-enter) backwards;
}
.pk-stagger > :nth-child(2) {
  animation-delay: var(--pk-stagger-step);
}
.pk-stagger > :nth-child(3) {
  animation-delay: calc(2 * var(--pk-stagger-step));
}
.pk-stagger > :nth-child(4) {
  animation-delay: calc(3 * var(--pk-stagger-step));
}
.pk-stagger > :nth-child(5) {
  animation-delay: calc(4 * var(--pk-stagger-step));
}
.pk-stagger > :nth-child(n + 6) {
  animation-delay: calc(5 * var(--pk-stagger-step));
}
/* success (§3.18): the check draws once, the mark settles from 0.9; never the accent. */
.success {
  justify-self: center;
  inline-size: 3.5rem;
  block-size: 3.5rem;
  color: var(--pk-success);
}
.card[data-align="start"] .success {
  justify-self: start;
}
.success svg {
  inline-size: 100%;
  block-size: 100%;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  animation: pk-pop var(--pk-duration-moderate) var(--pk-ease-enter);
}
.success path {
  stroke-dasharray: 40;
  animation: pk-draw var(--pk-duration-moderate) var(--pk-ease-enter) var(--pk-duration-micro) backwards;
}
@keyframes pk-draw {
  from {
    stroke-dashoffset: 40;
  }
}
@keyframes pk-pop {
  from {
    opacity: 0;
    scale: var(--pk-motion-scale-pop);
  }
}
/* Reduced motion (DL16): every step an instant swap, no fade, rise, draw or scale. */
.pk-root[data-motion="reduced"] .step,
.pk-root[data-motion="reduced"] .pk-stagger > *,
.pk-root[data-motion="reduced"] .success svg,
.pk-root[data-motion="reduced"] .success path {
  animation: none;
}

/* ── macOS (UK-06.8): Mac scale (13 pt body, 22 pt titles, 26 pt on Welcome, 28 pt capsule controls),
   grouped sections at radius 10 and the sheet a floating glass panel inset below the title-bar
   row, rounded on every side and not dimming the parent. The measures are the variant's tokens
   (tokens.ts); this block is structure. Button wording is the catalog's macos variants. ───── */
.pk-root[data-pk-platform="macos"] {
  --pk-kit-radius-group: var(--pk-kit-radius-form);
  --pk-kit-radius-card: var(--pk-kit-radius-sheet);
  --pk-gap: var(--pk-space-2);
}
.pk-root[data-pk-platform="macos"] .btn {
  min-inline-size: 4.5rem;
  padding-block: 0;
  line-height: 1;
}
.pk-root[data-pk-platform="macos"] .btn:is([data-variant="primary"], [data-variant="secondary"], [data-variant="danger"]) {
  padding-inline: 0.875rem;
}
/* The Welcome hero's push button is the one 36 pt control. */
.pk-root[data-pk-platform="macos"][data-component="Welcome"] .btn[data-variant="primary"] {
  min-block-size: var(--pk-kit-control-height-hero);
}
.pk-root[data-pk-platform="macos"] .btn[data-variant="secondary"] {
  background: color-mix(in oklab, var(--pk-text-strong) 12%, var(--pk-surface-raised));
  box-shadow:
    inset 0 0.5px 0 color-mix(in oklab, var(--pk-text-strong) 14%, transparent),
    0 0 0 0.5px color-mix(in oklab, var(--pk-text-strong) 14%, transparent);
}
.pk-root[data-pk-platform="macos"] .btn:active:not([aria-disabled="true"]) {
  transform: none;
}
/* The system focus ring: a soft 3 pt halo in the accent, on keyboard focus only. */
.pk-root[data-pk-platform="macos"][data-keyboard] :focus-visible {
  outline: 3px solid color-mix(in srgb, var(--pk-ring) 55%, transparent);
  outline-offset: 0;
}
/* The sheet is the dialog box itself: floating below the title-bar row, 440 pt wide, radius 24
   on every side, its own shadow and glass ground; the parent stays lit (no scrim) and it never
   docks to the bottom edge. The card scrolls its body above a pinned footer. */
.pk-root[data-pk-platform="macos"] dialog.sheet {
  margin-block: 3.25rem auto;
  margin-inline: auto;
  inline-size: min(27.5rem, 100% - 2 * var(--pk-space-4));
  max-inline-size: none;
  max-block-size: none;
  overflow: visible;
  border-radius: 1.5rem;
  background: color-mix(in oklab, var(--pk-surface-raised) 86%, transparent);
  backdrop-filter: blur(40px) saturate(1.6);
  box-shadow:
    inset 0 0 0 0.5px var(--pk-border-subtle),
    0 18px 40px -8px color-mix(in srgb, black 45%, transparent);
}
.pk-root[data-pk-platform="macos"] dialog::backdrop {
  background: transparent;
  backdrop-filter: none;
}
.pk-root[data-pk-platform="macos"][data-shape] dialog.sheet .stage .card {
  container: pkdlg / inline-size;
  padding: 1.375rem 1.375rem 0;
  border-radius: inherit;
  background: none;
  box-shadow: none;
  overflow: hidden auto;
  max-block-size: calc(100dvh - 4.25rem);
}
/* Only the filled buttons take side padding; links sit on the column's edge. */
.pk-root[data-pk-platform="macos"] .btn:is([data-variant="link"]) {
  min-inline-size: 0;
  padding-inline: 0;
}
/* Paste is a square inside the field, as tall as the field. */
.pk-root[data-pk-platform="macos"] .field-paste .paste {
  padding: 0;
  min-block-size: 0;
  min-inline-size: 0;
  block-size: 100%;
  inline-size: var(--pk-kit-control-height);
}
/* Welcome's two buttons are one height. */
.pk-root[data-pk-platform="macos"][data-component="Welcome"] .btn[data-variant="secondary"] {
  min-block-size: var(--pk-kit-control-height-hero);
}
/* A dialog's footer: Cancel then the default at the trailing edge (the DOM is in that order, so
   Tab follows the eye), pinned to the card's bottom; labels never wrap, and it stacks when the
   dialog is narrow. The choices the person makes stay in the body, full width. */
.pk-root[data-pk-platform="macos"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) {
  position: sticky;
  inset-block-end: 0;
  z-index: 1;
  flex-direction: row;
  flex-wrap: nowrap;
  justify-content: flex-end;
  margin: 0 -1.375rem;
  padding: 0.75rem 1.375rem 1.125rem;
  background: color-mix(in oklab, var(--pk-surface-raised) 94%, transparent);
  box-shadow: none;
}
.pk-root[data-pk-platform="macos"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) .btn {
  inline-size: auto;
  flex: 0 0 auto;
  white-space: nowrap;
}
@container pkdlg (max-width: 22rem) {
  .pk-root[data-pk-platform="macos"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) {
    flex-direction: column;
  }
  .pk-root[data-pk-platform="macos"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) .btn {
    inline-size: 100%;
  }
}
.pk-root[data-pk-platform="macos"][data-shape] dialog.sheet .stage .card > .actions[data-group] .btn {
  inline-size: 100%;
}
/* A choice between actions in page content: content-sized at the trailing edge, in DOM order. */
.pk-root[data-pk-platform="macos"] .actions[data-layout="row"] {
  flex-direction: row;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.pk-root[data-pk-platform="macos"] .actions[data-layout="row"] .btn {
  inline-size: auto;
}
/* The update prompt's web layout gives the primary a line of its own; on the Mac the buttons sit
   in one trailing row, each as wide as its label. */
.pk-root[data-pk-platform="macos"][data-component="UpdatePrompt"] .card .actions[data-layout="row"] {
  justify-content: flex-end;
}
.pk-root[data-pk-platform="macos"][data-component="UpdatePrompt"] .card .actions[data-layout="row"] .btn,
.pk-root[data-pk-platform="macos"][data-component="UpdatePrompt"] .card .actions[data-layout="row"] .btn[data-variant="primary"] {
  flex: 0 0 auto;
}
/* Increase Contrast: every hairline at full contrast. */
@media (prefers-contrast: more) {
  .pk-root[data-pk-platform="macos"] {
    --pk-border-subtle: var(--pk-text-strong);
    --pk-border-strong: var(--pk-text-strong);
  }
}

/* ── Forced colours: system colours, borders where fills carried the shape ───────────────── */
@media (forced-colors: active) {
  .card,
  .pane,
  .list,
  .banner,
  .toast,
  .callout {
    border: 1px solid CanvasText;
  }
  .btn[data-variant="primary"] {
    forced-color-adjust: none;
    background: Highlight;
    color: HighlightText;
  }
  .btn[data-variant="link"] {
    color: LinkText;
  }
  .pk-root[data-keyboard] :focus-visible,
  .field input:focus-visible {
    outline-color: Highlight;
  }
  .pk-root[data-pk-platform="windows"][data-keyboard] :focus-visible {
    outline-color: Highlight;
    box-shadow: none;
  }
  .pk-root[data-pk-platform="windows"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) {
    border-block-start-color: CanvasText;
  }
  .pk-root[data-pk-platform="windows"] .btn[data-variant="link"] {
    color: LinkText;
  }
  .seat-bar span[data-used],
  .progress > span {
    forced-color-adjust: none;
    background: CanvasText;
  }
  .row[aria-checked="true"] {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }
  /* The blurred icon is decoration: under forced colours it goes, with the tinted grounds. */
  .ambient,
  .passport-ambient {
    display: none !important;
  }
  .pk-root .stage[data-split] .passport {
    background: Canvas;
  }
}
@media (prefers-contrast: more) {
  .pk-root {
    --pk-border-subtle: var(--pk-border-strong);
    --pk-text-muted: var(--pk-text-default);
    --pk-text-subtle: var(--pk-text-default);
  }
}
@media (prefers-reduced-transparency: reduce) {
  .ambient img,
  .passport-ambient {
    display: none !important;
  }
  dialog::backdrop {
    backdrop-filter: none;
    background: var(--pk-surface-page);
  }
}
/* The desktop host's own report (the bridge host facts, UK-06) draws what the media features draw:
   Increase Contrast, and Reduce Transparency, which makes the glass sheet and the scrim opaque. */
.pk-root[data-contrast="more"] {
  --pk-border-subtle: var(--pk-border-strong);
  --pk-text-muted: var(--pk-text-default);
  --pk-text-subtle: var(--pk-text-default);
}
.pk-root[data-contrast="more"][data-pk-platform="macos"] {
  --pk-border-subtle: var(--pk-text-strong);
  --pk-border-strong: var(--pk-text-strong);
}
.pk-root[data-transparency="reduce"] :is(.ambient img, .passport-ambient) {
  display: none !important;
}
.pk-root[data-transparency="reduce"] dialog::backdrop {
  backdrop-filter: none;
  background: var(--pk-surface-page);
}
.pk-root[data-transparency="reduce"] dialog.sheet {
  backdrop-filter: none;
  background: var(--pk-surface-raised);
}
.visually-hidden {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
/* The step morph (§1.4 Web): while a step change runs, the one card is the transition's named
   surface (in a shadow root the host is, named inline from outside). Only one kit at a time
   carries the attribute, so two never share the name. */
.pk-root[data-morphing] .card {
  view-transition-name: pk-card;
}
}
`;

/** The whole stylesheet: tokens, then the kit's rules, all in the `polaris-key` layer (an
 *  unlayered token block would outrank every layered rule, `native`'s surfaces included). */
export function stylesCss(): string {
  return `@layer polaris-key {\n${tokenCss()}\n}\n\n${KIT_CSS.trim()}\n`;
}

let shared: CSSStyleSheet | null = null;

/** The one constructed sheet every shadow root adopts (null where constructable sheets are not
 *  supported; Lit then falls back to a `<style>` per root). */
export function sharedSheet(): CSSStyleSheet | null {
  if (shared) return shared;
  if (
    typeof CSSStyleSheet !== "function" ||
    !("replaceSync" in CSSStyleSheet.prototype)
  )
    return null;
  shared = new CSSStyleSheet();
  shared.replaceSync(stylesCss());
  return shared;
}

// ── The step morph ───────────────────────────────────────────────────────────────────────────
// A View Transition on the one card when the step changes: a cross-fade and an 8 px slide at the
// `base` duration token, `ease-standard` (DL16). The pseudo-elements belong to the document, so
// their rules ride a document sheet of their own (adopted, never a `<style>`, for a strict CSP).

/** The document-level rules of the morph; the duration and easing come from the root's tokens. */
export const MORPH_CSS = `::view-transition-group(pk-card),
::view-transition-group(pk-host) {
  animation-duration: var(--pk-morph-ms, 0ms);
  animation-timing-function: var(--pk-morph-ease, ease);
}
::view-transition-old(pk-card),
::view-transition-old(pk-host) {
  animation: pk-morph-out var(--pk-morph-ms, 0ms) var(--pk-morph-ease, ease) both;
}
::view-transition-new(pk-card) {
  animation: pk-morph-in var(--pk-morph-ms, 0ms) var(--pk-morph-ease, ease) both;
}
::view-transition-new(pk-host) {
  animation: pk-morph-fade var(--pk-morph-ms, 0ms) var(--pk-morph-ease, ease) both;
}
@keyframes pk-morph-out {
  to {
    opacity: 0;
  }
}
@keyframes pk-morph-fade {
  from {
    opacity: 0;
  }
}
@keyframes pk-morph-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(pk-card),
  ::view-transition-old(pk-card),
  ::view-transition-new(pk-card),
  ::view-transition-group(pk-host),
  ::view-transition-old(pk-host),
  ::view-transition-new(pk-host) {
    animation: none;
  }
}`;

/** True where the browser can run the morph and the person has not asked for less motion. */
export function canMorph(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    !(
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
  );
}

let morphSheet: CSSStyleSheet | null = null;
let running = 0;

/**
 * Run `swap` (which changes the card's content, synchronously) inside the morph. Where the browser
 * has no View Transitions, the person prefers less motion or the root's `base` duration is 0
 * (reduced motion in the theme), it is an instant swap: `swap` runs now, with no error. A kit in a
 * shadow root passes its `host`: the transition names the host (a fade), and the incoming card
 * slides its 8 px itself.
 */
export function morph(root: Element, swap: () => void, host?: Element): void {
  const cs = getComputedStyle(root);
  const ms = Number.parseFloat(cs.getPropertyValue("--pk-duration-base"));
  if (!canMorph() || !(ms > 0)) return swap();
  const doc = document;
  const named = host ?? root;
  try {
    if (!morphSheet && "adoptedStyleSheets" in doc) {
      morphSheet = new CSSStyleSheet();
      morphSheet.replaceSync(MORPH_CSS);
    }
    if (morphSheet && !doc.adoptedStyleSheets.includes(morphSheet))
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, morphSheet];
    const style = doc.documentElement.style;
    style.setProperty("--pk-morph-ms", `${ms}ms`);
    const ease = cs.getPropertyValue("--pk-ease-standard").trim() || "ease";
    style.setProperty("--pk-morph-ease", ease);
    named.setAttribute("data-morphing", "");
    // A name declared inside a shadow tree is scoped to it: the host's own, from outside, is not.
    if (host) (host as HTMLElement).style.viewTransitionName = "pk-host";
    running++;
    const done = () => {
      named.removeAttribute("data-morphing");
      if (host) (host as HTMLElement).style.viewTransitionName = "";
      // The document's variables go when the last of overlapping morphs ends.
      if (--running > 0) return;
      style.removeProperty("--pk-morph-ms");
      style.removeProperty("--pk-morph-ease");
    };
    doc
      .startViewTransition(() => {
        swap();
        if (host)
          root
            .querySelector(".card")
            ?.animate?.([{ opacity: 0, transform: "translateY(8px)" }, {}], {
              duration: ms,
              easing: ease,
            });
      })
      .finished.then(done, done);
  } catch {
    named.removeAttribute("data-morphing");
    if (host) (host as HTMLElement).style.viewTransitionName = "";
    swap();
  }
}
