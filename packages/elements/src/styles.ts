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
  --pk-kit-type-body-family: inherit;
  --pk-kit-type-title-family: inherit;
  --pk-kit-type-display-family: inherit;
  --pk-kit-type-label-family: inherit;
  --pk-kit-type-button-family: inherit;
  --pk-kit-type-meta-family: inherit;
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
  /* The actions dock at the bottom of a full-bleed screen (§1.4 Web). */
  .stage[data-kind="screen"] .card > .actions {
    margin-block-start: auto;
  }
}

/* DL1: two panes in a landscape box from 52.5rem, the identity panel at the start. */
.split {
  display: contents;
}
.pk-root[data-shape="landscape"] .stage[data-split] .card {
  inline-size: min(65rem, 100%);
  grid-template-columns: minmax(0, 1fr) minmax(28rem, 1fr);
  column-gap: var(--pk-space-12);
  align-items: start;
  text-align: start;
}
.pk-root[data-shape="landscape"] .stage[data-split] .passport {
  grid-row: 1 / span 6;
  align-self: stretch;
  display: grid;
  place-items: center;
  min-block-size: 18rem;
  border-radius: var(--pk-kit-radius-group);
  background: var(--pk-accent-subtle, var(--pk-surface-sunken));
}
.pk-root[data-shape="landscape"][data-theme="dark"] .stage[data-split] .passport {
  background: radial-gradient(closest-side, var(--pk-accent-subtle, var(--pk-surface-sunken)), var(--pk-surface-sunken));
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
.pk-root[data-shape="landscape"] .stage[data-split] .passport .identity {
  display: grid;
}
.pk-root[data-shape="landscape"] .stage[data-split] .passport .name,
.pk-root[data-shape="landscape"] .stage[data-split] .passport .by {
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
.title:focus {
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
.btn[data-variant="primary"]:hover {
  background: color-mix(in oklab, var(--pk-primary) 88%, var(--pk-primary-on));
}
.btn[data-variant="secondary"] {
  background: color-mix(in oklab, var(--pk-text-strong) 8%, var(--pk-surface-raised));
  color: var(--pk-text-strong);
}
.btn[data-variant="secondary"]:hover {
  background: color-mix(in oklab, var(--pk-text-strong) 13%, var(--pk-surface-raised));
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
  color: var(--pk-text-muted);
  font-weight: 400;
}
.btn[data-variant="link"]:hover {
  color: var(--pk-text-strong);
  text-decoration: underline;
  text-underline-offset: 0.2em;
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
}
.field-row {
  display: flex;
  gap: var(--pk-space-2);
}
.field-row input {
  flex: 1;
  min-inline-size: 0;
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
.code-row .btn,
.body .btn {
  min-inline-size: var(--pk-kit-control-height);
  padding-inline: var(--pk-space-3);
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
  grid-template-columns: minmax(0, 1fr) auto;
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
.check {
  inline-size: 1.25rem;
  block-size: 1.25rem;
  color: var(--pk-accent-fg, var(--pk-text-strong));
}
.row-glyph {
  inline-size: 1.5rem;
  block-size: 1.5rem;
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
.pane .actions {
  flex-direction: row;
  flex-wrap: wrap;
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
  inline-size: 100%;
  min-block-size: 0;
  grid-template-columns: none;
  border-radius: var(--pk-kit-radius-card);
  padding: var(--pk-kit-card-pad);
  box-shadow:
    inset 0 0 0 1px var(--pk-border-subtle),
    var(--pk-elevation-3);
}
dialog.sheet .passport {
  display: contents;
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
.visually-hidden {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
}
`;

/** The whole stylesheet: tokens, then the kit's rules in the `polaris-key` layer. */
export function stylesCss(): string {
  return `${tokenCss()}\n\n${KIT_CSS.trim()}\n`;
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
