// The desktop chrome's rules (UK-06): every rule scoped to data-pk-platform="windows" | "gnome" |
// "macos", in the order they had in styles.ts. They are their own module so the React kit's web
// entry does not carry them: it loads this on demand for a desktop variant (kit/lazy.ts), and the
// full sheet (dist/styles.css, the shadow-DOM elements) is KIT_CSS then DESKTOP_CSS.

export const DESKTOP_CSS = String.raw`

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
/* A dialog shorter than its content scrolls its body above a pinned response row, as AdwDialog
   does: the suggested action stays in the window (a 390 px tall window with three lines of notes). */
.pk-root[data-pk-platform="gnome"][data-shape] dialog.sheet .stage .card > .actions:not([data-group]) {
  position: sticky;
  inset-block-end: 0;
  z-index: 1;
  margin-block-end: calc(-1 * var(--pk-kit-card-pad));
  padding-block-end: var(--pk-kit-card-pad);
  background: var(--pk-surface-raised);
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
/* The Settings sheet holds a bare pane, not a card: the dialog is capped to the window, the pane
   scrolls its body and Done stays pinned under it (like the card rules above). */
.pk-root[data-pk-platform="windows"] dialog.sheet[open]:has(> .pane),
.pk-root[data-pk-platform="macos"] dialog.sheet[open]:has(> .pane),
.pk-root[data-pk-platform="gnome"] dialog.sheet[open]:has(> .pane) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  max-block-size: calc(100dvh - 3rem);
}
.pk-root[data-pk-platform="macos"] dialog.sheet[open]:has(> .pane) {
  max-block-size: calc(100dvh - 4.25rem);
}
.pk-root[data-pk-platform="windows"] dialog.sheet > .pane,
.pk-root[data-pk-platform="macos"] dialog.sheet > .pane,
.pk-root[data-pk-platform="gnome"] dialog.sheet > .pane {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow: hidden auto;
  padding-block-end: 0;
  border-radius: inherit;
  background: none;
  box-shadow: none;
}
.pk-root[data-pk-platform="windows"] dialog.sheet > .pane > .actions,
.pk-root[data-pk-platform="macos"] dialog.sheet > .pane > .actions,
.pk-root[data-pk-platform="gnome"] dialog.sheet > .pane > .actions {
  position: sticky;
  inset-block-end: 0;
  z-index: 1;
  margin-inline: calc(-1 * var(--pk-space-6));
  padding: var(--pk-space-4) var(--pk-space-6);
  background: var(--pk-surface-raised);
  border-block-start: 1px solid var(--pk-border-subtle);
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
/* A short window's docked bar: the default last in the DOM, so a plain row (no reversing) puts it
   at the trailing edge and Tab runs left to right. */
.pk-root[data-pk-platform="macos"][data-shape="short"] .stage[data-kind="screen"] .card > .actions[data-primary="last"] {
  flex-direction: row;
  justify-content: flex-end;
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
  .pk-root[data-pk-platform="macos"][data-theme] {
    --pk-border-subtle: var(--pk-text-strong);
    --pk-border-strong: var(--pk-text-strong);
  }
}
.pk-root[data-contrast="more"][data-pk-platform="macos"][data-theme] {
  --pk-border-subtle: var(--pk-text-strong);
  --pk-border-strong: var(--pk-text-strong);
}
@media (forced-colors: active) {
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
`;
