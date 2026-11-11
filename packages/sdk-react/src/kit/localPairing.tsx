"use client";
// Pair with a Code, styled (CC-29K): `<LocalPairing>` (two devices of one app on one network pair
// by an 8-digit code or a QR, with no account) and `<PairedDevices>` (what they paired, with
// Rename and Forget in the row and the Can connect switches). The headless half is connectHooks.ts
// (`useLocalPairing`, `usePairedDevices`), the views are ui-core's `localPairingView` and
// `pairedDevicesView`, and the machines `LocalPairingModel` and `PairedDevicesModel`. They load on
// demand (connectLazy.tsx), so the gate's entry carries none of it.
//
// Rules (UI-KITS 4.3 LocalPairing, UI-KITS 4.4): the code is the largest text on the show screen,
// drawn as served in two groups of four and spelled out for a screen reader; in a window 600 px or
// wider the QR sits beside it, narrower under it (the same reading and focus order either way), and
// a window under 480 tall drops the kit's logo so nothing scrolls; the categories come before Pair
// in the DOM, so pressing Pair is the person's yes; Pair is aria-disabled, never `disabled`, so a
// press still answers its reason; a name the other device sent is isolated in `<bdi>`; Escape is
// Not now on a prompt, Cancel on a window or a busy Pair, Back on the field.

import {
  Fragment,
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  connectEscape,
  type LocalLinksLike,
  type PairedDeviceInput,
  type PairedDevicesInput,
  type View,
} from "@polaris-key/ui-core";

import {
  usePairedDevices,
  useLocalPairing,
  type UseLocalPairingOptions,
} from "./connectHooks.js";
import { Categories, PAIR_SHARED_CSS, Screen } from "./connect.js";
import { spellOut } from "./contract.js";
import type { KitAction, KitProps } from "./component.js";
import {
  GLYPHS,
  button,
  callout,
  plain,
  qrCode,
  since,
  text,
  type Chrome,
  type KitCtx,
} from "./parts.js";

// ── Rules ────────────────────────────────────────────────────────────────────────────────────

/**
 * The window rule of `localPairingLayout` (ui-core): two panes from 600 px at the root text size, so
 * 200 % text keeps one column; a window under 480 tall drops the logo; narrow and short, the one
 * column scrolls with the notice before the QR. The ui-matrix `localLayout` rows pin the rule.
 */
const LOCAL_CSS = `${PAIR_SHARED_CSS}
@layer polaris-key {
.pk-root[data-component="LocalPairing"] .pair-show,
.pk-root[data-component="LocalPairing"] .pair-stack,
.pk-root[data-component="PairedDevices"] .pair-stack {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--pk-space-3);
  justify-items: stretch;
  text-align: start;
}
.pk-root .pair-lit {
  border-radius: 0.2em;
  animation: pk-pair-lit 1s ease-out 1 both;
}
@keyframes pk-pair-lit {
  from {
    background: var(--pk-accent-subtle, var(--pk-surface-sunken));
  }
  to {
    background: transparent;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pk-root .pair-lit {
    animation: none;
  }
}
.pk-root .pair-codeblock {
  display: grid;
  gap: var(--pk-space-2);
  justify-items: center;
}
.pk-root .pair-code {
  inline-size: 100%;
  box-sizing: border-box;
  padding: var(--pk-space-3) var(--pk-space-2);
  border-radius: var(--pk-kit-radius-control);
  /* A raised tile, not a sunken one: a sunken tile reads as the field Enter a code draws. */
  background: color-mix(in oklab, var(--pk-text-strong) 7%, var(--pk-surface-raised));
  font-family: var(--pk-kit-type-code-family);
  font-weight: var(--pk-kit-type-code-weight);
  font-size: clamp(1.75rem, 1rem + 5cqi, var(--pk-kit-type-code-size));
  line-height: 1.2;
  letter-spacing: var(--pk-kit-type-code-tracking);
  font-variant-numeric: tabular-nums;
  color: var(--pk-text-strong);
  text-align: center;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  column-gap: 0.45em;
}
.pk-root .pair-group {
  white-space: nowrap;
}
.pk-root .pair-code:focus-visible {
  outline: var(--pk-kit-focus-width) solid var(--pk-ring);
  outline-offset: 2px;
}
/* The window is opening: the tile holds its place, and the bars appear after the DL7 delay so a
   fast start does not flash. */
.pk-root .pair-code[data-wait] {
  min-block-size: calc(1.2em + 2 * var(--pk-space-3));
  align-items: center;
  gap: var(--pk-space-2);
}
.pk-root .pair-show [data-ghost] {
  visibility: hidden;
}
.pk-root .pair-show .qr[data-ghost] {
  inline-size: 11.5rem;
  aspect-ratio: 1;
  margin: 0;
}
@container pk (max-height: 30rem) {
  .pk-root .pair-show .qr[data-ghost] {
    inline-size: 10rem;
  }
}
.pk-root .pair-skel {
  display: block;
  inline-size: 3.5ch;
  block-size: 0.9em;
  border-radius: 0.2em;
  background: var(--pk-border-subtle);
  opacity: 0;
  animation: pk-pair-skel 1.6s ease-in-out 0.3s infinite both;
}
@keyframes pk-pair-skel {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 0.8;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pk-root .pair-skel {
    animation: none;
    opacity: 0.5;
    animation-delay: 0s;
  }
}
.pk-root .pair-time {
  display: flex;
  align-items: center;
  gap: var(--pk-space-2);
  margin: 0;
  color: var(--pk-text-muted);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
  font-variant-numeric: tabular-nums;
}
.pk-root .pair-ring {
  flex: none;
  inline-size: 1.25rem;
  block-size: 1.25rem;
  transform: rotate(-90deg);
}
.pk-root .pair-ring circle {
  fill: none;
  stroke-width: 2;
}
.pk-root .pair-ring .track {
  stroke: var(--pk-border-subtle);
}
.pk-root .pair-ring .left {
  stroke: var(--pk-accent-fg);
  stroke-linecap: round;
}
.pk-root .pair-show .qr {
  justify-self: center;
}
.pk-root .pair-show .qr svg {
  inline-size: 11.5rem;
}
.pk-root .pair-live {
  display: contents;
}
.pk-root .pair-notice .callout-title {
  display: block;
}
/* The notice's actions read as actions: underlined at rest, as a link in a pane is. */
.pk-root .pair-notice .btn[data-variant="link"],
.pk-root .pair-stack .links .btn[data-variant="link"],
.pk-root .pair-foot .links .btn[data-variant="link"],
.pk-root .pair-actions .btn[data-variant="link"] {
  color: var(--pk-accent-fg);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
.pk-root .pair-notice {
  position: relative;
}
.pk-root .pair-notice .notice-glyph {
  position: absolute;
  inset-inline-start: var(--pk-space-4);
  inset-block-start: var(--pk-space-3);
  inline-size: 1rem;
  block-size: 1rem;
}
.pk-root .pair-notice[data-glyph] {
  padding-inline-start: calc(var(--pk-space-4) + 1.5rem);
}
.pk-root .pair-notice .btn[data-variant="link"] {
  justify-self: start;
  min-block-size: 1.5rem;
}
.pk-root .pair-notice[data-lone] {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  column-gap: var(--pk-space-3);
}
.pk-root .pair-wait {
  padding: var(--pk-space-3) var(--pk-space-4);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-accent-subtle, var(--pk-surface-sunken));
}
.pk-root .pair-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pk-space-2);
}
/* Twice the stack's gap between what is agreed to and the button that agrees. */
.pk-root .pair-shares + .pair-actions {
  margin-block-start: var(--pk-space-3);
}
/* The wait after Too many tries is the one thing the button says: full contrast, not dimmed. */
.pk-root .btn[data-wait][aria-disabled="true"][data-variant="primary"] {
  opacity: 1;
  background: none;
  color: var(--pk-text-strong);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  cursor: default;
}
.pk-root .pair-actions .btn {
  inline-size: auto;
}
.pk-root .pair-choose {
  display: grid;
  gap: var(--pk-space-2);
}
.pk-root .pair-choose .btn {
  inline-size: 100%;
}
.pk-root .pair-field .label {
  color: var(--pk-text-strong);
}
.pk-root .pair-field input.pair-input {
  min-block-size: 4.5rem;
  font-family: var(--pk-kit-type-code-family);
  font-weight: var(--pk-kit-type-code-weight);
  font-size: clamp(1.75rem, 1rem + 5cqi, var(--pk-kit-type-code-size));
  letter-spacing: var(--pk-kit-type-code-tracking);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.pk-root .pair-field input.pair-input::placeholder {
  color: var(--pk-text-muted);
  opacity: 0.4;
  font-size: 0.6em;
  letter-spacing: 0.3em;
}
.pk-root .pair-error {
  margin: 0;
  color: var(--pk-danger);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
}
.pk-root .pair-hint {
  margin: 0;
  color: var(--pk-text-muted);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
}
.pk-root .pair-field input.pair-input[aria-invalid="true"] {
  background: var(--pk-danger-subtle);
}
.pk-root .pair-title-name,
.pk-root[data-component="LocalPairing"] h1 {
  overflow-wrap: anywhere;
}
.pk-root .btn[aria-disabled="true"][data-variant="primary"] {
  opacity: 0.6;
}
@container pk (min-width: 37.5rem) {
  .pk-root[data-component="LocalPairing"]:is([data-state="show"], [data-state="opening"]) .stage[data-kind="screen"] .card {
    inline-size: min(46rem, 100%);
  }
  .pk-root .pair-show {
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: var(--pk-space-6);
    align-items: start;
  }
  .pk-root .pair-show > * {
    grid-column: 1;
  }
  .pk-root .pair-show > .pair-codeblock {
    align-self: center;
  }
  .pk-root .pair-show > .qr {
    grid-column: 2;
    grid-row: 1;
    align-self: center;
  }
  .pk-root .pair-show > .pair-codeblock {
    grid-row: 1;
  }
}
/* Short windows drop the kit's logo: the window already shows its own. Short and wide keeps both
   panes beside each other and the QR beside the code and the waiting row, so nothing scrolls;
   short and narrow keeps one column that scrolls, with the notice before the QR so a wrong code is
   not left under it. */
.pk-root .pair-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--pk-space-1) var(--pk-space-3);
}
@media (max-height: 480px) {
  .pk-root[data-component="LocalPairing"] [data-part="header"],
  .pk-root[data-component="LocalPairing"] .passport {
    display: none;
  }
  /* The field and the stack give back height, so Pair is whole in the first view. */
  .pk-root .pair-field input.pair-input {
    min-block-size: 3.5rem;
  }
  .pk-root[data-component="LocalPairing"] .pair-stack {
    gap: var(--pk-space-2);
  }
  @container pk (min-width: 37.5rem) {
    .pk-root[data-component="LocalPairing"]:is([data-state="show"], [data-state="opening"]) .stage[data-kind="screen"] {
      align-content: start;
      padding-block: var(--pk-space-3);
    }
    .pk-root[data-component="LocalPairing"]:is([data-state="show"], [data-state="opening"]) .card {
      gap: var(--pk-space-2);
      padding-block: var(--pk-space-4);
    }
    .pk-root .pair-show {
      row-gap: var(--pk-space-2);
    }
    .pk-root .pair-show > .qr {
      grid-row: 1 / span 2;
    }
    .pk-root .pair-show .qr svg {
      inline-size: 10rem;
    }
    /* A notice is one line: its words side by side and its action at the end, and the waiting
       row is as tall as its text, so Cancel stays in the first view. */
    .pk-root .pair-show .pair-notice {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      column-gap: var(--pk-space-3);
      row-gap: 0;
      padding-block: var(--pk-space-2);
    }
    .pk-root .pair-show .pair-notice .notice-glyph {
      inset-block-start: var(--pk-space-3);
    }
    .pk-root .pair-show .pair-notice .btn[data-variant="link"] {
      margin-inline-start: auto;
      min-block-size: 1.5rem;
    }
    .pk-root .pair-show .pair-wait {
      padding-block: var(--pk-space-1);
    }
  }
  @container pk (max-width: 37.49rem) {
    .pk-root[data-component="LocalPairing"] .stage[data-kind="screen"] {
      align-content: start;
      overflow-y: auto;
    }
    .pk-root .pair-show > .pair-codeblock {
      order: 1;
    }
    .pk-root .pair-show .pair-notice {
      order: 2;
    }
    .pk-root .pair-show > .qr {
      order: 3;
    }
    .pk-root .pair-show > .pair-wait,
    .pk-root .pair-show > .pair-foot {
      order: 4;
    }
  }
}
/* Paired devices. */
.pk-root .pair-rows[data-loading] .pair-row {
  min-block-size: 3.75rem;
}
.pk-root .pair-rows[data-loading] .pair-skel {
  inline-size: 40%;
  block-size: 1em;
}
.pk-root .pair-rows {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border-radius: var(--pk-kit-radius-group);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  text-align: start;
}
.pk-root .pair-rows[data-scroll] {
  max-block-size: min(24rem, 55dvh);
  overflow-y: auto;
}
.pk-root .pair-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  column-gap: var(--pk-space-2);
  padding: var(--pk-space-2) var(--pk-space-2) var(--pk-space-2) var(--pk-space-4);
  position: relative;
}
.pk-root .pair-row + .pair-row {
  border-block-start: 1px solid var(--pk-border-subtle);
}
.pk-root .pair-row[data-editing] {
  grid-template-columns: minmax(0, 1fr);
  padding-block: var(--pk-space-3);
  padding-inline: var(--pk-space-4);
  gap: var(--pk-space-2);
  background: color-mix(in srgb, var(--pk-accent-fg) 8%, transparent);
}
/* The tint follows the list's rounded corners (the list cannot clip: an upward menu leaves it). */
.pk-root .pair-row[data-editing]:first-child {
  border-start-start-radius: var(--pk-kit-radius-group);
  border-start-end-radius: var(--pk-kit-radius-group);
}
.pk-root .pair-row[data-editing]:last-child {
  border-end-start-radius: var(--pk-kit-radius-group);
  border-end-end-radius: var(--pk-kit-radius-group);
}
.pk-root .pair-name {
  display: block;
  color: var(--pk-text-strong);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pk-root .pair-meta {
  display: block;
  margin: 0;
  color: var(--pk-text-muted);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pk-root .pair-colhead {
  display: flex;
  justify-content: end;
  padding-inline-end: calc(var(--pk-kit-control-height) + var(--pk-space-3));
  margin: 0;
  color: var(--pk-text-muted);
  font-size: var(--pk-kit-type-meta-size);
}
@container pk (max-width: 29.99rem) {
  .pk-root .pair-colhead {
    display: none;
  }
}
.pk-root .pair-switch {
  appearance: none;
  position: relative;
  inline-size: 2.75rem;
  block-size: 1.5rem;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--pk-radius-full);
  background: color-mix(in srgb, var(--pk-text-strong) 14%, transparent);
  cursor: pointer;
}
.pk-root .pair-switch[aria-checked="true"] {
  background: color-mix(in srgb, var(--pk-accent-fg) 30%, transparent);
}
.pk-root .pair-switch::after {
  content: "";
  position: absolute;
  inset-block: 0.25rem;
  inset-inline-start: 0.25rem;
  inline-size: 1rem;
  border-radius: var(--pk-radius-full);
  background: var(--pk-text-muted);
  transition: transform var(--pk-duration-fast) var(--pk-ease-standard);
}
.pk-root .pair-switch[aria-checked="true"]::after {
  background: var(--pk-accent-fg);
  transform: translateX(1.25rem);
}
.pk-root .pair-switch:dir(rtl)[aria-checked="true"]::after {
  transform: translateX(-1.25rem);
}
.pk-root .pair-switch[aria-disabled="true"] {
  opacity: 0.5;
  cursor: default;
}
.pk-root .pair-switch:focus-visible,
.pk-root .pair-more:focus-visible {
  outline: var(--pk-kit-focus-width) solid var(--pk-ring);
  outline-offset: 2px;
}
.pk-root .pair-more {
  appearance: none;
  display: inline-grid;
  place-items: center;
  inline-size: var(--pk-kit-control-height);
  block-size: var(--pk-kit-control-height);
  border: 0;
  border-radius: var(--pk-kit-radius-control);
  background: none;
  color: var(--pk-text-muted);
  cursor: pointer;
}
.pk-root .pair-more svg {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}
.pk-root .pair-menu {
  position: absolute;
  inset-inline-end: var(--pk-space-2);
  inset-block-start: calc(100% - var(--pk-space-2));
  z-index: 2;
  display: grid;
  min-inline-size: 9rem;
  padding: var(--pk-space-1);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-raised, var(--pk-surface-sunken));
  box-shadow: 0 0 0 1px var(--pk-border-subtle), 0 6px 20px color-mix(in srgb, var(--pk-text-strong) 18%, transparent);
}
.pk-root .pair-menu[hidden] {
  display: none;
}
/* Near the bottom of a scrolling list the menu opens upward, so it is never clipped. */
.pk-root .pair-menu[data-up] {
  inset-block-start: auto;
  inset-block-end: calc(100% - var(--pk-space-2));
}
.pk-root .pair-menu .btn:focus-visible {
  outline: var(--pk-kit-focus-width) solid var(--pk-ring);
  outline-offset: -2px;
}
.pk-root .pair-menu .btn {
  justify-content: start;
  inline-size: 100%;
  min-block-size: 2.75rem;
  background: none;
  color: var(--pk-text-default);
  font-weight: 400;
}
.pk-root .pair-menu .btn[data-danger] {
  color: var(--pk-danger);
}
}
`;

const sheet = LOCAL_CSS;

// ── Glyphs (decorative, aria-hidden) ─────────────────────────────────────────────────────────

function Icon(props: { cls?: string; children: ReactNode }): ReactNode {
  return (
    <svg
      className={props.cls ?? "glyph"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

const ICONS = {
  qr: () => (
    <Icon>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3M21 14v.01M14 21h.01M17 21h4v-4" />
    </Icon>
  ),
  keyboard: () => (
    <Icon>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </Icon>
  ),
  plus: () => (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  ),
  // Three dots of 3 px across, side by side: the "more" mark (a menu), not a stroke of dashes.
  more: () => (
    <svg
      className=""
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="5" cy="12" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="19" cy="12" r="1.9" />
    </svg>
  ),
};

// ── Parts ────────────────────────────────────────────────────────────────────────────────────

const has = (c: KitCtx, k: string): boolean => c.view.copy.includes(k);

/** A notice: one neutral callout, a glyph at its start, its words, and at most one quiet action. */
function Notice(props: {
  c: KitCtx;
  title: string;
  body?: string;
  glyph?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  const { c, title, body, glyph, action } = props;
  return (
    <div
      className="callout pair-notice"
      data-part="callout"
      data-tone="neutral"
      data-glyph={glyph ? "" : undefined}
      data-lone={action && !body ? "" : undefined}
    >
      {glyph}
      <span className="callout-title" data-key={title}>
        {text(c, title)}
      </span>
      {body ? <span data-key={body}>{text(c, body)}</span> : null}
      {action ?? null}
    </div>
  );
}

/** The words a screen reader is told when a notice appears (a polite status that is always in the
 *  page, so its changes are announced). It holds the notice's words only, never its action. */
function Announce(props: { children?: ReactNode }): ReactNode {
  return (
    <div className="visually-hidden" role="status">
      {props.children}
    </div>
  );
}

/** A sentence without its closing full stop, so joining sentences never doubles it. */
const unstop = (s: string): string => s.replace(/[.。]+\s*$/u, "");

/** The time left, spoken to the minute and never rounded up: "4:51" is "4:00", under a minute
 *  "0:30" or "0:00". */
function spokenTime(left: number): string {
  if (left >= 60) return `${Math.floor(left / 60)}:00`;
  return left >= 30 ? "0:30" : "0:00";
}

/** The 20 px ring and "Expires in 4:51". The ring is not announced; the minute is, once a minute. */
function TimeRow(props: { c: KitCtx }): ReactNode {
  const { c } = props;
  const left = Math.max(0, c.input.localPairing?.secondsLeft ?? 0);
  const r = 9;
  const whole = 2 * Math.PI * r;
  return (
    <>
      <p
        className="pair-time"
        data-key="localPairing.expires"
        aria-hidden="true"
      >
        <svg className="pair-ring" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="track" cx="12" cy="12" r={r} />
          <circle
            className="left"
            cx="12"
            cy="12"
            r={r}
            strokeDasharray={`${(Math.min(1, left / 300) * whole).toFixed(2)} ${whole.toFixed(2)}`}
          />
        </svg>
        <span>{text(c, "localPairing.expires")}</span>
      </p>
      <span className="visually-hidden" role="status">
        {plain(c, "localPairing.expires", { time: spokenTime(left) })}
      </span>
    </>
  );
}

/** The code, lit where it changed, as two groups of four that stay whole (at 200 % text they wrap
 *  between the groups). The reader is told the whole code; the digits are not read twice. The tile
 *  takes focus (`tabIndex` -1) when the control the person pressed left the page. */
const Code = forwardRef<
  HTMLSpanElement,
  { c: KitCtx; changed: readonly number[]; rotation: number }
>(function Code(props, ref) {
  const { c, changed, rotation } = props;
  const code = c.input.localPairing?.code ?? "";
  const lit = new Set(changed);
  let at = 0;
  return (
    <span
      ref={ref}
      className="pair-code"
      role="text"
      tabIndex={-1}
      data-key="a11y.linkCode"
      aria-label={plain(c, "a11y.linkCode", { code: spellOut(code) })}
    >
      {code.split(" ").map((group, g) => {
        const from = at;
        at += group.length + 1;
        return (
          <Fragment key={g}>
            {g > 0 ? " " : null}
            <span className="pair-group">
              {[...group].map((ch, i) =>
                lit.has(from + i) ? (
                  <span key={`${rotation}:${i}`} className="pair-lit">
                    {ch}
                  </span>
                ) : (
                  ch
                ),
              )}
            </span>
          </Fragment>
        );
      })}
    </span>
  );
});

function Waiting(props: { c: KitCtx }): ReactNode {
  return (
    <p
      className="pair-wait"
      role="status"
      data-key="localPairing.waitingDevice"
    >
      <span className="pair-dot" aria-hidden="true" />
      <span>{text(props.c, "localPairing.waitingDevice")}</span>
    </p>
  );
}

/** Pair: aria-disabled, never `disabled`, so a press still answers its reason; a busy Pair keeps its
 *  label with a ring. */
function PairButton(props: {
  c: KitCtx;
  busy?: boolean;
  disabled?: boolean;
  describedBy?: string;
  onPress?: () => void;
}): ReactNode {
  const { c, busy, disabled, describedBy, onPress } = props;
  return (
    <button
      type="button"
      className="btn"
      data-part="primary"
      data-variant="primary"
      data-key="localPairing.pair"
      aria-disabled={busy || disabled ? "true" : undefined}
      aria-describedby={describedBy}
      onClick={() => (onPress ? onPress() : c.act("localPairing.pair"))}
    >
      {busy ? <span className="ring" aria-hidden="true" /> : null}
      <span>{text(c, "localPairing.pair")}</span>
    </button>
  );
}

/** A button that may sit unavailable with its label (aria-disabled, never `disabled`, so focus and
 *  its reason stay reachable). Pressed unavailable it does nothing; `busy` adds the ring. */
function Disabled(props: {
  c: KitCtx;
  k: string;
  variant: "primary" | "secondary" | "link";
  glyph?: ReactNode;
  off?: boolean;
  busy?: boolean;
  wait?: boolean;
  describedBy?: string;
}): ReactNode {
  const { c, k, variant, glyph, off, busy, wait, describedBy } = props;
  return (
    <button
      type="button"
      className="btn"
      data-part={variant}
      data-variant={variant}
      data-key={k}
      data-wait={wait ? "" : undefined}
      aria-disabled={off || busy ? "true" : undefined}
      aria-describedby={describedBy}
      onClick={() => (off || busy ? undefined : c.act(k))}
    >
      {busy ? <span className="ring" aria-hidden="true" /> : null}
      {glyph}
      <span>{text(c, k)}</span>
    </button>
  );
}

// ── LocalPairing ─────────────────────────────────────────────────────────────────────────────

/** What a driven screen knows beyond the view: the lit digits, the name field, the labels. */
export interface LocalExtras {
  changed: readonly number[];
  rotation: number;
  name: string;
  labels?: Readonly<Record<string, string>>;
}

function ChooseBody(props: { c: KitCtx }): ReactNode {
  const { c } = props;
  const p = c.input.localPairing!;
  const full = p.full === true;
  return (
    <div className="pair-stack">
      {full ? (
        <Notice
          c={c}
          title="core.codes.local-links-full.title"
          body="core.codes.local-links-full.message"
          glyph={GLYPHS.info("notice-glyph")}
          action={button(c, "localPairing.pairedDevices", "link")}
        />
      ) : null}
      <div className="pair-choose" data-part="choices">
        <Disabled
          c={c}
          k="localPairing.show"
          variant="secondary"
          glyph={ICONS.qr()}
          off={full}
        />
        <Disabled
          c={c}
          k="localPairing.enter"
          variant="secondary"
          glyph={ICONS.keyboard()}
          off={full}
        />
      </div>
      {has(c, "localPairing.prePrompt") ? (
        <p className="pair-hint" data-key="localPairing.prePrompt">
          {text(c, "localPairing.prePrompt")}
        </p>
      ) : null}
      <div className="pair-actions">
        {button(c, "common.cancel", "secondary")}
      </div>
    </div>
  );
}

/** Cancel and Enter a code instead, on one row (the window's two ways out). */
function ShowFoot(props: { c: KitCtx }): ReactNode {
  const { c } = props;
  return (
    <div className="pair-foot">
      <div className="pair-actions">
        {button(c, "common.cancel", "secondary")}
      </div>
      <div className="links" data-part="links">
        {button(c, "localPairing.toEnter", "link")}
      </div>
    </div>
  );
}

/** The window is opening: the code tile holds its place (its bars appear after the DL7 delay), so a
 *  slow start is never mistaken for nothing happening. */
function OpeningBody(props: { c: KitCtx }): ReactNode {
  const { c } = props;
  return (
    <div className="pair-show" data-opening="">
      <div className="pair-codeblock">
        <span className="pair-code" data-wait="" aria-busy="true">
          <span className="pair-skel" aria-hidden="true" />
          <span className="pair-skel" aria-hidden="true" />
        </span>
        <p className="pair-time" data-ghost="" aria-hidden="true">
          <span className="pair-ring" />
          <span>{plain(c, "localPairing.expires", { time: "5:00" })}</span>
        </p>
      </div>
      <figure className="qr" data-ghost="" aria-hidden="true" />
      <p className="pair-wait" data-ghost="" aria-hidden="true">
        <span className="pair-dot" />
        <span>{plain(c, "localPairing.waitingDevice")}</span>
      </p>
      <ShowFoot c={c} />
    </div>
  );
}

function ShowBody(props: { c: KitCtx; x: LocalExtras }): ReactNode {
  const { c, x } = props;
  const p = c.input.localPairing!;
  const n = p.notice;
  const renewing = p.busy === "new-code";
  const tile = useRef<HTMLSpanElement | null>(null);
  const seen = useRef(x.rotation);
  // A new code can remove the control the person pressed (the notice's action); focus then falls to
  // the page, so it goes to the code, which is what changed.
  useEffect(() => {
    if (seen.current === x.rotation) return;
    seen.current = x.rotation;
    const at = document.activeElement;
    if (!at || at === document.body) tile.current?.focus();
  }, [x.rotation]);
  const again = (
    <Disabled
      c={c}
      k="localPairing.showNew"
      variant="link"
      off={renewing}
      busy={renewing}
    />
  );
  const words: Record<string, readonly [string, string]> = {
    rotated: ["localPairing.rotatedTitle", "localPairing.rotatedBody"],
    declined: ["localPairing.notPairedWith", "localPairing.rotatedBody"],
    blocked: ["localPairing.blockedTitle", "localPairing.blockedBody"],
    guessing: ["localPairing.rotatedTitle", "localPairing.tooManyAgainBody"],
  };
  const said = n ? words[n] : undefined;
  return (
    <div className="pair-show" data-notice={n}>
      <div className="pair-codeblock">
        <Code ref={tile} c={c} changed={x.changed} rotation={x.rotation} />
        <TimeRow c={c} />
      </div>
      {qrCode(c, p.qr ?? null, "a11y.qrPairing")}
      <div className="pair-live">
        {n === "rotated" || n === "declined" || n === "guessing" ? (
          <Notice
            c={c}
            title={said![0]}
            body={said![1]}
            glyph={
              n === "guessing"
                ? GLYPHS.warning("notice-glyph")
                : GLYPHS.info("notice-glyph")
            }
            action={again}
          />
        ) : null}
        {n === "blocked" ? (
          <Notice
            c={c}
            title="localPairing.blockedTitle"
            body="localPairing.blockedBody"
            glyph={GLYPHS.warning("notice-glyph")}
          />
        ) : null}
      </div>
      {/* What a screen reader is told, apart from the notice so its action is not read as news. */}
      <Announce>
        {said ? (
          <>
            {unstop(plain(c, said[0]))}. {unstop(plain(c, said[1]))}.{" "}
            {n !== "blocked" ? (
              <span data-key="a11y.newCode">
                {plain(c, "a11y.newCode", { code: spellOut(p.code ?? "") })}
              </span>
            ) : null}
          </>
        ) : null}
      </Announce>
      <Waiting c={c} />
      <ShowFoot c={c} />
    </div>
  );
}

function ClosedBody(props: { c: KitCtx }): ReactNode {
  const { c } = props;
  const cooling = has(c, "localPairing.showNewIn");
  const k = cooling ? "localPairing.showNewIn" : "localPairing.showNew";
  return (
    <div className="pair-stack">
      {has(c, "localPairing.tooManyAgainTitle") ? (
        <Notice
          c={c}
          title="localPairing.tooManyAgainTitle"
          body="localPairing.tooManyAgainBody"
          glyph={GLYPHS.warning("notice-glyph")}
        />
      ) : null}
      <div className="pair-actions">
        <Disabled c={c} k={k} variant="primary" off={cooling} wait={cooling} />
        {button(c, "common.close", "secondary")}
      </div>
    </div>
  );
}

function EnterBody(props: { c: KitCtx; x: LocalExtras }): ReactNode {
  const { c, x } = props;
  const p = c.input.localPairing!;
  const busy = c.view.state === "joining";
  const hint = useId();
  const e = p.error;
  const spent = has(c, "localPairing.spentCode");
  const invalid = !busy && (e === "wrong" || e === "not-a-code");
  const cooldown = has(c, "localPairing.cooldownTitle");
  const notFound = has(c, "localPairing.notFoundTitle");
  return (
    <div className="pair-stack">
      {cooldown ? (
        <Notice
          c={c}
          title="localPairing.cooldownTitle"
          body="localPairing.cooldownBody"
          glyph={GLYPHS.info("notice-glyph")}
        />
      ) : null}
      {notFound ? (
        <Notice
          c={c}
          title="localPairing.notFoundTitle"
          body="localPairing.notFoundBody"
          glyph={GLYPHS.info("notice-glyph")}
        />
      ) : null}
      {/* The late answers are told as they arrive: the region is in the page before they do. */}
      <Announce>
        {cooldown
          ? `${plain(c, "localPairing.cooldownTitle")}. ${plain(c, "localPairing.cooldownBody")}`
          : notFound
            ? `${plain(c, "localPairing.notFoundTitle")}. ${plain(c, "localPairing.notFoundBody")}`
            : null}
      </Announce>
      <div className="field pair-field" data-part="code-field">
        <label className="label" htmlFor="pk-pair-code">
          {text(c, "localPairing.codeLabel")}
        </label>
        <input
          id="pk-pair-code"
          className="pair-input"
          data-key="localPairing.codeLabel"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          value={p.entry ?? ""}
          readOnly={busy}
          placeholder={
            has(c, "localPairing.codePlaceholder")
              ? plain(c, "localPairing.codePlaceholder")
              : ""
          }
          aria-invalid={invalid ? "true" : "false"}
          aria-describedby={hint}
          onChange={(ev) => c.edit("entry", ev.currentTarget.value)}
          onKeyDown={(ev: KeyboardEvent<HTMLInputElement>) => {
            if (ev.key === "Enter") c.act("localPairing.pair");
          }}
        />
        <div id={hint} className="pair-hints">
          {!busy && e === "wrong" ? (
            <p
              className="pair-error"
              role="alert"
              data-key="localPairing.wrongCode"
            >
              {text(c, "localPairing.wrongCode")}
            </p>
          ) : null}
          {!busy && e === "not-a-code" ? (
            <p
              className="pair-error"
              role="alert"
              data-key="localPairing.notACode"
            >
              {text(c, "localPairing.notACode")}
            </p>
          ) : null}
          {!busy && spent ? (
            <p
              className="pair-hint"
              role="status"
              data-key="localPairing.spentCode"
            >
              {text(c, "localPairing.spentCode")}
            </p>
          ) : null}
          {has(c, "localPairing.triesLeft") ? (
            <p className="pair-hint" data-key="localPairing.triesLeft">
              {text(c, "localPairing.triesLeft")}
            </p>
          ) : null}
        </div>
      </div>
      <Categories c={c} labels={x.labels} cats={p.categories} />
      <div className="pair-actions">
        <PairButton
          c={c}
          busy={busy}
          disabled={p.pairDisabled === true}
          describedBy={hint}
        />
      </div>
      {busy ? null : (
        <div className="links" data-part="links">
          {button(c, "localPairing.toShow", "link")}
        </div>
      )}
    </div>
  );
}

/** Pair on the prompt is ignored for 250 ms after it appears, so Enter on arrival never pairs. Pair
 *  leads (the order of reading); the first focus is Not now. A press is answered at once: both
 *  controls wait, and the one pressed shows its ring. */
function ConfirmBody(props: { c: KitCtx; x: LocalExtras }): ReactNode {
  const { c, x } = props;
  const [armed, arm] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => arm(true), 250);
    return () => clearTimeout(t);
  }, []);
  const busy = c.input.localPairing?.busy;
  return (
    <div className="pair-stack">
      <Categories
        c={c}
        labels={x.labels}
        cats={c.input.localPairing?.categories}
      />
      <div className="pair-actions">
        <PairButton
          c={c}
          busy={busy === "pair"}
          disabled={busy !== undefined}
          onPress={() => armed && !busy && c.act("localPairing.pair")}
        />
        <Disabled
          c={c}
          k="common.notNow"
          variant="secondary"
          off={busy === "pair"}
          busy={busy === "not-now"}
        />
      </div>
    </div>
  );
}

function PairedBody(props: { c: KitCtx; x: LocalExtras }): ReactNode {
  const { c, x } = props;
  const p = c.input.localPairing!;
  const hint = useId();
  return (
    <div className="pair-stack">
      {p.cantConnect ? (
        <Notice
          c={c}
          title="localPairing.cantConnectTitle"
          body="localPairing.cantConnectBody"
          glyph={GLYPHS.info("notice-glyph")}
        />
      ) : null}
      <div className="field pair-field" data-part="name-field">
        <label className="label" htmlFor="pk-pair-name">
          {text(c, "localPairing.nameLabel")}
        </label>
        <input
          id="pk-pair-name"
          data-key="localPairing.nameLabel"
          type="text"
          autoComplete="off"
          spellCheck={false}
          dir="auto"
          value={x.name}
          aria-invalid={p.nameError ? "true" : "false"}
          aria-describedby={hint}
          onChange={(ev) => c.edit("name", ev.currentTarget.value)}
          onKeyDown={(ev: KeyboardEvent<HTMLInputElement>) => {
            if (ev.key === "Enter") c.act("common.done");
          }}
        />
        <div id={hint}>
          {p.nameError ? (
            <p
              className="pair-error"
              role="alert"
              data-key="devices.renameFailed"
            >
              {text(c, "devices.renameFailed")}
            </p>
          ) : null}
          <p className="pair-hint" data-key="localPairing.nameHint">
            {text(c, "localPairing.nameHint")}
          </p>
        </div>
      </div>
      <div className="pair-actions">
        {button(c, "common.done", "primary")}
        {p.cantConnect ? button(c, "localPairing.pairedDevices", "link") : null}
      </div>
    </div>
  );
}

/** A refusal or an end: its reason is the header's lede (under the title, as every screen draws
 *  one), then the way out here. Close is the filled control only where the view says so. */
function ClosingBody(props: { c: KitCtx; keys: string[] }): ReactNode {
  const { c, keys } = props;
  const primary = c.view.decisions.primary;
  return (
    <div className="pair-stack">
      <div className="pair-actions">
        {keys.map((k) => button(c, k, k === primary ? "primary" : "secondary"))}
      </div>
    </div>
  );
}

function localBody(c: KitCtx, x: LocalExtras): ReactNode {
  switch (c.view.state) {
    case "choose":
      return <ChooseBody c={c} />;
    case "opening":
      return <OpeningBody c={c} />;
    case "show":
      return <ShowBody c={c} x={x} />;
    case "closed":
      return <ClosedBody c={c} />;
    case "enter":
    case "joining":
      return <EnterBody c={c} x={x} />;
    case "confirm":
      return <ConfirmBody c={c} x={x} />;
    case "waiting":
      return (
        <div className="pair-stack">
          <Categories
            c={c}
            labels={x.labels}
            cats={c.input.localPairing?.categories}
          />
          <div className="pair-actions">
            {button(c, "common.cancel", "secondary")}
          </div>
        </div>
      );
    case "paired":
      return <PairedBody c={c} x={x} />;
    case "failed":
      return <ClosingBody c={c} keys={["common.tryAgain", "common.close"]} />;
    case "network-blocked":
      return (
        <ClosingBody
          c={c}
          keys={[
            ...(has(c, "localPairing.openSettings")
              ? ["localPairing.openSettings"]
              : []),
            "common.tryAgain",
            "common.close",
          ]}
        />
      );
    case "off":
      return <ClosingBody c={c} keys={["common.close"]} />;
    default:
      return null;
  }
}

export interface LocalPairingProps extends KitProps {
  /** Drive the screen: `client.cloudConnect.localLinks`, or any `LocalLinksLike`. Without it the part
   *  draws `input.localPairing` and the host does the rest. */
  driver?: LocalLinksLike;
  /** The data categories this app asks both people to approve (ids). Listed before Pair. */
  categories?: readonly string[];
  /** The name each category goes by on screen, by id; an id without one is drawn as it is. */
  categoryLabels?: Readonly<Record<string, string>>;
  /** This device's label, sent to the other device. */
  label?: string;
  /** The system has not asked about the local network yet (macOS, Windows): the choose screen says
   *  what to allow. */
  prePrompt?: boolean;
  /** The platform can open its settings from the network-blocked answer. */
  canOpenSettings?: boolean;
  /** Open the platform's settings. */
  onOpenSettings?: () => void;
  /** Open Paired devices (from the No room notice, and from a pairing kept switched off). */
  onPairedDevices?: () => void;
  /** Close, Done, Cancel on the entry or Escape there: the host closes the screen. */
  onClose?: () => void;
}

/** Escape: the shared rule, except on the paired screen, where it leaves with the name as it was
 *  (Done is what saves an edited one). */
function localEscape(view: View): string | null {
  return (view.component as string) === "LocalPairing" &&
    view.state === "paired"
    ? "common.close"
    : connectEscape(view);
}

/** The chrome of a step: Back above the card on the field, Cancel in its place while it looks. */
function chromeOf(step: string | undefined): Chrome | undefined {
  if (step === "enter") return { back: true };
  if (step === "joining") return { back: true, backKey: "common.cancel" };
  return undefined;
}

/**
 * Pair with a Code: one device shows the code and a QR, the other types or scans it, the shower is
 * asked to confirm, and both store the pairing. Given a `driver` it runs the screens itself and
 * withdraws any code on unmount; given an `input` it is the plain part and the host drives it.
 * Hidden without `input.localPairing` or a driver.
 */
export function LocalPairing(props: LocalPairingProps): ReactNode {
  return props.driver ? (
    <DrivenPairing {...props} driver={props.driver} />
  ) : (
    <Screen
      {...props}
      css={sheet}
      name="LocalPairing"
      input={props.input ?? {}}
      escape={localEscape}
      chrome={chromeOf(props.input?.localPairing?.step)}
      body={(c) =>
        localBody(c, {
          changed: [],
          rotation: 0,
          name: "",
          labels: props.categoryLabels,
        })
      }
      route={(a) => plainRoute(a, props)}
    />
  );
}

function plainRoute(a: KitAction, props: LocalPairingProps): void {
  if (a.key === "common.close" || a.key === "common.done") props.onClose?.();
  if (a.key === "localPairing.openSettings") props.onOpenSettings?.();
  if (a.key === "localPairing.pairedDevices") props.onPairedDevices?.();
}

function DrivenPairing(
  props: LocalPairingProps & { driver: LocalLinksLike },
): ReactNode {
  const { driver, categories, label, prePrompt, canOpenSettings, onClose } =
    props;
  const options: UseLocalPairingOptions = {
    driver,
    categories: categories ?? [],
    label,
    prePrompt,
    canOpenSettings,
    base: props.input,
  };
  const pair = useLocalPairing(options);
  const { model, snapshot } = pair;
  const told = useRef(false);
  useEffect(() => {
    if (snapshot.left && !told.current) {
      told.current = true;
      onClose?.();
    }
  }, [snapshot.left, onClose]);
  const x: LocalExtras = {
    changed: snapshot.changed,
    rotation: snapshot.rotation,
    name: snapshot.name,
    labels: props.categoryLabels,
  };
  return (
    <Screen
      {...props}
      css={sheet}
      name="LocalPairing"
      input={pair.input}
      escape={localEscape}
      chrome={chromeOf(snapshot.step)}
      onInput={(field, value) => {
        if (field === "entry") model.setEntry(value);
        if (field === "name") model.setName(value);
        props.onInput?.(field, value);
      }}
      body={(c) => localBody(c, x)}
      route={(a) => {
        const step = snapshot.step;
        switch (a.key) {
          case "localPairing.show":
            void model.show();
            break;
          case "localPairing.enter":
          case "localPairing.toEnter":
            void model.enter();
            break;
          case "localPairing.toShow":
            void model.toShow();
            break;
          case "localPairing.showNew":
          case "localPairing.showNewIn":
            void model.showNew();
            break;
          case "localPairing.pair":
            void (step === "confirm" ? model.confirm() : model.pair());
            break;
          case "common.notNow":
            void model.notNow();
            break;
          case "common.cancel":
            void model.cancel();
            break;
          case "common.back":
            void model.backToChoose();
            break;
          case "common.tryAgain":
            void model.retry();
            break;
          case "common.done":
            void model.done();
            break;
          case "common.close":
            void model.close(true);
            break;
          case "localPairing.openSettings":
            props.onOpenSettings?.();
            break;
          case "localPairing.pairedDevices":
            props.onPairedDevices?.();
            break;
        }
      }}
    />
  );
}

// ── PairedDevices ────────────────────────────────────────────────────────────────────────────

/**
 * The row's menu, as the menu pattern: the button opens it and focus goes to its first item (the
 * last, with the up arrow); the arrows, Home and End move between the items; Escape closes it and
 * returns to the button; Tab closes it. Near the bottom of a scrolling list it opens upward, so it
 * is never clipped.
 */
function RowMenu(props: {
  c: KitCtx;
  d: PairedDeviceInput;
  name: string;
}): ReactNode {
  const { c, d, name } = props;
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const first = useRef<"first" | "last">("first");
  const items = (): HTMLElement[] =>
    Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
  useEffect(() => {
    if (!open) return;
    const away = (ev: MouseEvent): void => {
      if (!ref.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  // Place the menu before it is painted: upward when the room below, inside the list that scrolls
  // (or the window), is less than the menu is tall and the room above is more. Then focus the item.
  useLayoutEffect(() => {
    const m = menu.current;
    const t = trigger.current;
    if (!open || !m || !t) return;
    const list = t.closest<HTMLElement>("[data-scroll]");
    const edge = list?.getBoundingClientRect();
    const bottom = Math.min(edge?.bottom ?? Infinity, window.innerHeight);
    const top = Math.max(edge?.top ?? 0, 0);
    const at = t.getBoundingClientRect();
    const tall = m.offsetHeight;
    const below = bottom - at.bottom;
    setUp(below < tall && at.top - top > below);
    const all = items();
    (first.current === "last" ? all[all.length - 1] : all[0])?.focus({
      preventScroll: true,
    });
  }, [open]);
  const close = (back: boolean): void => {
    setOpen(false);
    if (back) trigger.current?.focus();
  };
  const pick = (k: string): void => {
    setOpen(false);
    c.act(k, { id: d.id, menu: true });
  };
  const move = (ev: KeyboardEvent<HTMLElement>): void => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to: Record<string, number> = {
      ArrowDown: (at + 1) % all.length,
      ArrowUp: (at - 1 + all.length) % all.length,
      Home: 0,
      End: all.length - 1,
    };
    if (ev.key in to) {
      ev.preventDefault();
      all[to[ev.key]!]?.focus();
    } else if (ev.key === "Escape") {
      // The menu's own: nothing behind it closes.
      ev.preventDefault();
      ev.stopPropagation();
      close(true);
    } else if (ev.key === "Tab") setOpen(false);
  };
  return (
    <div
      ref={ref}
      onKeyDown={(ev) => {
        if (open) move(ev);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="pair-more"
        data-key="a11y.deviceOptions"
        aria-label={plain(c, "a11y.deviceOptions", { device: name })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          first.current = "first";
          setOpen(!open);
        }}
        onKeyDown={(ev) => {
          if (open || (ev.key !== "ArrowDown" && ev.key !== "ArrowUp")) return;
          ev.preventDefault();
          first.current = ev.key === "ArrowUp" ? "last" : "first";
          setOpen(true);
        }}
      >
        {ICONS.more()}
      </button>
      {/* Always in the DOM, hidden until opened: the row's actions are found by a host and a test. */}
      <div
        ref={menu}
        id={id}
        className="pair-menu"
        role="menu"
        aria-label={plain(c, "a11y.deviceOptions", { device: name })}
        data-up={up && open ? "" : undefined}
        hidden={!open}
      >
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="btn"
          data-key="devices.rename"
          onClick={() => pick("devices.rename")}
        >
          {text(c, "devices.rename")}
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="btn"
          data-danger=""
          data-key="pairedDevices.forget"
          onClick={() => pick("pairedDevices.forget")}
        >
          {text(c, "pairedDevices.forget")}
        </button>
      </div>
    </div>
  );
}

/** The line under the rename field, by why the name was refused. */
const RENAME_ERRORS = {
  long: "pairedDevices.renameLong",
  empty: "pairedDevices.renameEmpty",
  failed: "devices.renameFailed",
} as const;

function nameOf(c: KitCtx, d: PairedDeviceInput): string {
  return d.label?.trim() ? d.label : plain(c, "devices.unnamed");
}

function Row(props: {
  c: KitCtx;
  d: PairedDeviceInput;
  x: PairedExtras;
  switches: boolean;
  waits: boolean;
}): ReactNode {
  const { c, d, x, switches, waits } = props;
  const p = c.input.pairedDevices!;
  const name = nameOf(c, d);
  const editing = p.target === d.id && p.step === "renaming";
  const asking = p.target === d.id && p.step === "forgetting";
  const hint = useId();
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);
  if (editing)
    return (
      <li className="pair-row" data-editing="rename" data-row={d.id}>
        <div className="field pair-field">
          <label className="label" htmlFor={`pk-name-${d.id}`}>
            {text(c, "devices.renameLabel")}
          </label>
          <input
            id={`pk-name-${d.id}`}
            ref={field}
            data-key="devices.renameLabel"
            type="text"
            autoComplete="off"
            spellCheck={false}
            dir="auto"
            value={x.draft ?? d.label ?? ""}
            aria-invalid={p.renameError ? "true" : "false"}
            aria-describedby={hint}
            onChange={(ev) => c.edit("draft", ev.currentTarget.value)}
            onKeyDown={(ev) => {
              if (ev.key !== "Enter") return;
              // Saved from the keydown, which is then consumed: a store that answers at once moves
              // focus to the row's button inside this event, and the keypress that follows would
              // press it and reopen the menu.
              ev.preventDefault();
              c.act("common.save");
            }}
          />
        </div>
        <div id={hint}>
          {p.renameError ? (
            <p
              className="pair-error"
              role="alert"
              data-key={RENAME_ERRORS[p.renameError]}
            >
              {text(c, RENAME_ERRORS[p.renameError], { device: name })}
            </p>
          ) : null}
          <p className="pair-hint" data-key="localPairing.nameHint">
            {text(c, "localPairing.nameHint")}
          </p>
        </div>
        <div className="pair-actions">
          {button(c, "common.save", "primary")}
          {button(c, "common.cancel", "secondary")}
        </div>
      </li>
    );
  if (asking)
    return (
      <li className="pair-row" data-editing="forget" data-row={d.id}>
        <p className="callout-title" data-key="pairedDevices.forgetConfirm">
          {text(c, "pairedDevices.forgetConfirm", { device: name })}
        </p>
        <p className="pair-hint" data-key="pairedDevices.forgetBody">
          {text(c, "pairedDevices.forgetBody")}
        </p>
        {p.forgetError ? (
          <p
            className="pair-error"
            role="alert"
            data-key="pairedDevices.forgetFailed"
          >
            {text(c, "pairedDevices.forgetFailed", { device: name })}
          </p>
        ) : null}
        <div className="pair-actions">
          {button(c, "pairedDevices.forget", "danger", {
            detail: { id: d.id, confirm: true },
          })}
          {button(c, "common.cancel", "secondary")}
        </div>
      </li>
    );
  const off = !d.reachable;
  const stuck = off && waits;
  return (
    <li className="pair-row" data-row={d.id}>
      <div>
        <span className="pair-name" data-key="pairedDevices.name">
          <bdi>{name}</bdi>
        </span>
        {d.lastSeen !== null && has(c, "pairedDevices.lastSeen") ? (
          <span className="pair-meta" data-key="pairedDevices.lastSeen">
            <bdi>
              {plain(c, "pairedDevices.lastSeen", {
                when: since(d.lastSeen, c.copy.locale),
              })}
            </bdi>
          </span>
        ) : null}
      </div>
      {switches ? (
        <button
          type="button"
          role="switch"
          className="pair-switch"
          data-key="a11y.letConnect"
          aria-checked={d.reachable}
          aria-disabled={stuck ? "true" : undefined}
          aria-describedby={stuck ? "pk-pair-reachable-full" : undefined}
          aria-label={plain(c, "a11y.letConnect", { device: name })}
          onClick={() =>
            !stuck && c.act("a11y.letConnect", { id: d.id, on: !d.reachable })
          }
        />
      ) : null}
      <RowMenu c={c} d={d} name={name} />
    </li>
  );
}

/** Where focus goes: a row's button, or the heading. */
type FocusAt = { kind: "row"; id: string } | { kind: "title" };

/** What a driven list knows beyond the view: the draft name, where focus goes after Forget. */
export interface PairedExtras {
  /** The rename field's text; null draws the name now held. */
  draft: string | null;
  focus: FocusAt | null;
}

/** The host's answers about a device, said by the status region that is always in the page (the
 *  notice itself comes and goes, so its own appearing would not be announced). */
function pairedAnnounce(c: KitCtx): ReactNode {
  const n = c.input.pairedDevices?.notice;
  const say = (...keys: string[]): ReactNode =>
    keys.map((k, i) => (
      <Fragment key={k}>
        {i > 0 ? " " : null}
        {unstop(plain(c, k))}.
      </Fragment>
    ));
  return (
    <Announce>
      {n?.kind === "not-found"
        ? say("pairedDevices.notFoundTitle", "pairedDevices.notFoundBody")
        : n?.kind === "busy"
          ? say("pairedDevices.busyTitle")
          : n?.kind === "unknown"
            ? say(
                "core.codes.link-unknown.title",
                "core.codes.link-unknown.message",
              )
            : null}
    </Announce>
  );
}

function pairedBody(c: KitCtx, x: PairedExtras): ReactNode {
  return (
    <>
      {pairedInner(c, x)}
      {pairedAnnounce(c)}
    </>
  );
}

function pairedInner(c: KitCtx, x: PairedExtras): ReactNode {
  const p = c.input.pairedDevices!;
  const devices = p.devices ?? [];
  const state = c.view.state;
  const full = has(c, "core.codes.local-links-full.title");
  const primary = c.view.decisions.primary;
  const done = button(
    c,
    "common.done",
    primary === "common.done" ? "primary" : "secondary",
  );
  const pairAnother = (
    <button
      type="button"
      className="btn"
      data-part={primary === "pairedDevices.pair" ? "primary" : "secondary"}
      data-variant={primary === "pairedDevices.pair" ? "primary" : "secondary"}
      data-key="pairedDevices.pair"
      aria-disabled={full ? "true" : undefined}
      onClick={() => !full && c.act("pairedDevices.pair")}
    >
      {ICONS.plus()}
      <span>{text(c, "pairedDevices.pair")}</span>
    </button>
  );
  if (state === "loading")
    return (
      <div className="pair-stack">
        <ul
          className="pair-rows"
          data-part="devices"
          data-loading=""
          aria-hidden="true"
        >
          {[0, 1, 2].map((i) => (
            <li key={i} className="pair-row">
              <span className="pair-skel" />
            </li>
          ))}
        </ul>
        <div className="pair-actions">{done}</div>
      </div>
    );
  if (state === "empty")
    return (
      <div className="pair-actions">
        {pairAnother}
        {done}
      </div>
    );
  if (state === "load-failed")
    return (
      <div className="pair-stack">
        {callout(c, ["pairedDevices.loadFailed"])}
        <div className="pair-actions">
          {button(c, "common.tryAgain", "primary")}
          {done}
        </div>
      </div>
    );
  if (state === "off")
    return (
      <div className="pair-stack">
        <Notice
          c={c}
          title="core.codes.local-pairing-off.title"
          body="pairedDevices.offBody"
          glyph={GLYPHS.info("notice-glyph")}
        />
        {devices.length ? (
          <Rows c={c} x={x} switches={false} waits={false} />
        ) : null}
        <div className="pair-actions">{done}</div>
      </div>
    );
  const switches = has(c, "pairedDevices.canConnect");
  const waits = has(c, "pairedDevices.reachableFullTitle");
  const notice = p.notice;
  return (
    <div className="pair-stack">
      {full ? (
        <Notice
          c={c}
          title="core.codes.local-links-full.title"
          body="pairedDevices.fullBody"
          glyph={GLYPHS.info("notice-glyph")}
        />
      ) : null}
      {waits ? (
        <div id="pk-pair-reachable-full">
          <Notice
            c={c}
            title="pairedDevices.reachableFullTitle"
            body="pairedDevices.reachableFullBody"
            glyph={GLYPHS.info("notice-glyph")}
          />
        </div>
      ) : null}
      {notice?.kind === "not-found" ? (
        <Notice
          c={c}
          title="pairedDevices.notFoundTitle"
          body="pairedDevices.notFoundBody"
          glyph={GLYPHS.info("notice-glyph")}
        />
      ) : null}
      {notice?.kind === "busy" ? (
        <Notice
          c={c}
          title="pairedDevices.busyTitle"
          glyph={GLYPHS.info("notice-glyph")}
          action={button(c, "common.tryAgain", "link", {
            detail: { id: notice.id },
          })}
        />
      ) : null}
      {notice?.kind === "unknown" ? (
        <Notice
          c={c}
          title="core.codes.link-unknown.title"
          body="core.codes.link-unknown.message"
          glyph={GLYPHS.info("notice-glyph")}
        />
      ) : null}
      {switches ? (
        <p className="pair-colhead" data-key="pairedDevices.canConnect">
          {text(c, "pairedDevices.canConnect")}
        </p>
      ) : null}
      <Rows c={c} x={x} switches={switches} waits={waits} />
      <div className="pair-actions">
        {pairAnother}
        {done}
      </div>
    </div>
  );
}

function Rows(props: {
  c: KitCtx;
  x: PairedExtras;
  switches: boolean;
  waits: boolean;
}): ReactNode {
  const { c, x, switches, waits } = props;
  const devices = c.input.pairedDevices?.devices ?? [];
  const list = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    const root = list.current?.closest(".pk-root");
    const to = x.focus;
    if (!root || !to) return;
    // After the kit has moved focus to the title for the step that changed: the row's button wins.
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      const row =
        to.kind === "row"
          ? root.querySelector<HTMLElement>(`[data-row="${to.id}"] .pair-more`)
          : null;
      (
        row ?? root.querySelector<HTMLElement>("h1,h2,[data-part=title]")
      )?.focus();
    });
    return () => {
      live = false;
    };
  }, [x.focus]);
  return (
    <ul
      ref={list}
      className="pair-rows"
      data-part="devices"
      data-scroll={devices.length > 6 ? "" : undefined}
    >
      {devices.map((d) => (
        <Row key={d.id} c={c} d={d} x={x} switches={switches} waits={waits} />
      ))}
    </ul>
  );
}

export interface PairedDevicesProps extends KitProps {
  /** Drive the list: `client.cloudConnect.localLinks`, or any `LocalLinksLike`. Without it the part
   *  draws `input.pairedDevices` and the host does the rest. */
  driver?: LocalLinksLike;
  /** What the app's own connection to a device answered (not found, busy, no longer paired): said
   *  with the list. A driven list shows it beside the answers it holds itself. */
  notice?: PairedDevicesInput["notice"];
  /** Try again on a busy device's notice: the host connects to `id` again and clears the notice. */
  onRetry?: (id: string) => void;
  /** Pair with a Code, the one primary: the host opens `<LocalPairing>`. */
  onPair?: () => void;
  /** Done, or Escape: the host closes the list. */
  onClose?: () => void;
}

/**
 * The devices this one paired with by a code: their names, when each was last seen, and a switch
 * for each that can connect (shown only when more than 8 are paired or one is off). Rename and
 * Forget work in the row. Given a `driver` it reads the list and follows its changes; given an
 * `input` it is the plain part. Hidden without either.
 */
export function PairedDevices(props: PairedDevicesProps): ReactNode {
  if (props.driver) return <DrivenDevices {...props} driver={props.driver} />;
  return <PlainDevices {...props} />;
}

/** Try again on a device's answer removes the button that was pressed: focus goes to that device's
 *  button (or the heading if the device left), drawn after the answer is gone. A newer focus the
 *  list asks for (after Forget) wins. */
function useRetryFocus(
  asked: FocusAt | null,
): [FocusAt | null, (id: string) => void] {
  const [at, set] = useState<{ to: FocusAt; over: FocusAt | null } | null>(
    null,
  );
  const mark = (id: string) => set({ to: { kind: "row", id }, over: asked });
  return [at && at.over === asked ? at.to : asked, mark];
}

function PlainDevices(props: PairedDevicesProps): ReactNode {
  const [focus, mark] = useRetryFocus(null);
  const input =
    props.notice && props.input?.pairedDevices
      ? {
          ...props.input,
          pairedDevices: {
            ...props.input.pairedDevices,
            notice: props.notice,
          },
        }
      : (props.input ?? {});
  return (
    <Screen
      {...props}
      css={sheet}
      name="PairedDevices"
      input={input}
      escape={connectEscape}
      body={(c) => pairedBody(c, { draft: null, focus })}
      route={(a) => {
        if (a.key === "common.done") props.onClose?.();
        if (a.key === "pairedDevices.pair") props.onPair?.();
        if (a.key === "common.tryAgain" && typeof a.id === "string") {
          mark(a.id);
          props.onRetry?.(a.id);
        }
      }}
    />
  );
}

function DrivenDevices(
  props: PairedDevicesProps & { driver: LocalLinksLike },
): ReactNode {
  const list = usePairedDevices({
    driver: props.driver,
    base: props.input,
    notice: props.notice,
  });
  const { model, snapshot } = list;
  const [focus, mark] = useRetryFocus(snapshot.focus);
  const told = useRef(false);
  useEffect(() => {
    if (snapshot.left && !told.current) {
      told.current = true;
      props.onClose?.();
    }
  }, [snapshot.left, props]);
  return (
    <Screen
      {...props}
      css={sheet}
      name="PairedDevices"
      input={list.input}
      escape={connectEscape}
      onInput={(field, value) => {
        if (field === "draft") model.setDraft(value);
        props.onInput?.(field, value);
      }}
      body={(c) => pairedBody(c, { draft: snapshot.draft, focus })}
      route={(a) => {
        const id = typeof a.id === "string" ? a.id : undefined;
        switch (a.key) {
          case "devices.rename":
            if (id) model.startRename(id);
            break;
          case "pairedDevices.forget":
            if (a.confirm === true) void model.confirmForget();
            else if (id) model.askForget(id);
            break;
          case "common.save":
            void model.saveRename();
            break;
          case "common.cancel":
            model.cancelEdit();
            break;
          case "a11y.letConnect":
            if (id) void model.setReachable(id, a.on === true);
            break;
          case "common.tryAgain": {
            if (snapshot.step === "load-failed") {
              void model.refresh();
              break;
            }
            // Try again on a device's answer: the host connects again, the answer is dismissed.
            const id =
              typeof a.id === "string"
                ? a.id
                : (snapshot.notice?.id ?? props.notice?.id);
            model.report("", null);
            if (id) {
              mark(id);
              props.onRetry?.(id);
            }
            break;
          }
          case "pairedDevices.pair":
            model.requestPair();
            props.onPair?.();
            break;
          case "common.done":
            model.done();
            break;
        }
      }}
    />
  );
}
