// The Cloud Sync screens' rules (U-42.2): the recovery code, its note, the saved checkbox. Their own
// module so the React kit's web stylesheet leaves them out and adopts them with the screens.

export const SYNC_CSS = `
/* ── Cloud Sync screens (U-42.2): the recovery code, its note, the saved checkbox ──────────── */
.recovery-groups {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--pk-space-3) var(--pk-space-3);
  padding: var(--pk-space-4);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
}
/* Four groups to a row; two where the box is narrow or the text large. A group never breaks. */
@container (max-width: 20rem) {
  .recovery-groups {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.recovery-groups .g {
  font-family: var(--pk-kit-type-code-family);
  font-weight: var(--pk-kit-type-code-weight);
  font-size: 1.25rem;
  line-height: 1.3;
  letter-spacing: 0.04em;
  color: var(--pk-text-strong);
  text-align: center;
  white-space: nowrap;
}
[data-part="code"] > .recovery-groups + .btn {
  margin-block-start: var(--pk-space-3);
}
.field[hidden] {
  display: none;
}
/* SaveConflict (U-22.K2): the two copies side by side, one under the other where the box is narrow
   or the text large; neither is the default, so neither is stronger than the other. */
.save-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--pk-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
@container (max-width: 24rem) {
  .save-cards {
    grid-template-columns: minmax(0, 1fr);
  }
}
.save-card {
  display: flex;
  flex-direction: column;
  gap: var(--pk-space-2);
  min-inline-size: 0;
  padding: var(--pk-space-4);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  overflow-wrap: anywhere;
}
/* The choices have no primary, so their block is not docked: one run in reading order (the two
   choices, Keep both, its reason, then Cancel), never a bar over the cards or a second bar over
   the reason, and never reversed in a short window (row-reverse would swap the sides). The
   selectors out-weigh every docking rule, the short window's and the full-bleed screen's. */
.pk-root .stage[data-kind="screen"] .card > .actions[data-dock="none"][data-part="actions"] {
  position: static;
  flex-direction: column;
  flex-wrap: nowrap;
  justify-content: start;
  margin: 0;
  padding: 0;
  background: none;
  box-shadow: none;
}
.pk-root .stage[data-kind="screen"] .card > .actions[data-dock="none"][data-part="actions"]::before {
  content: none;
}
.pk-root .stage[data-kind="screen"] .card > .actions[data-dock="none"][data-part="actions"] .btn {
  flex: none;
  inline-size: 100%;
  white-space: normal;
}
.pk-root .stage[data-kind="screen"] .card > .actions[data-dock="none"][data-part="actions"] .btn[data-variant="link"] {
  inline-size: auto;
  align-self: center;
}
/* Newer: the tag on the card the app names; information only, it chooses nothing. */
.save-card .newer {
  align-self: start;
  padding: 0 var(--pk-space-2);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-raised, transparent);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  color: var(--pk-text-strong);
  font-weight: 600;
}
/* A short landscape window (under 480px tall, room for two panes of 18rem at the current text
   size): two panes both starting at the top. Left: title, lede and the cards, stacked. Right: the
   choices and Cancel, in the DOM order they already have. Taller windows and large text keep the
   one column, versions before choices. */
@media (max-height: 480px) and (min-width: 36rem) {
  .pk-root .stage[data-kind="screen"] .card:has(> .save-cards) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto auto 1fr;
    column-gap: var(--pk-space-5, 1.5rem);
    align-items: start;
    align-content: start;
  }
  .pk-root .stage[data-kind="screen"] .card:has(> .save-cards) > * {
    grid-column: 1;
  }
  .pk-root .stage[data-kind="screen"] .card:has(> .save-cards) > .save-cards {
    grid-template-columns: minmax(0, 1fr);
  }
  .pk-root .stage[data-kind="screen"] .card:has(> .save-cards) > .actions[data-part="actions"] {
    grid-column: 2;
    grid-row: 1 / -1;
  }
}
/* Delete it here too removes a save: the danger outline, quieter than a solid confirm. */
.btn[data-variant="danger"][data-key="saveConflict.acceptDelete"] {
  background: transparent;
  color: var(--pk-danger);
  box-shadow: inset 0 0 0 1px var(--pk-danger-border);
}
.body.note {
  color: var(--pk-text-strong);
  font-weight: 500;
}
/* The one fact to check on a changed ring: the device that set it up. */
[data-key="ringChange.body"] bdi {
  color: var(--pk-text-strong);
  font-weight: 600;
}
/* A two-line field, upper-cased as it shows, that wraps a 39-character code. */
.field-paste textarea {
  padding-inline-end: var(--pk-kit-control-height);
  resize: none;
  text-transform: uppercase;
  overflow-wrap: anywhere;
  line-height: 1.4;
  padding-block: var(--pk-space-3);
  font-family: var(--pk-font-mono);
  letter-spacing: 0.02em;
}
.field textarea[aria-invalid="true"] {
  box-shadow: inset 0 0 0 1px var(--pk-danger-border);
  --pk-ring: var(--pk-danger);
}
/* The destructive confirm: the brand's danger with its own label colour (never white on any red). */
.btn[data-variant="danger"][data-key="unlockSync.startOverConfirm"] {
  background: var(--pk-danger);
  color: var(--pk-danger-on);
}
.field-error {
  margin: var(--pk-space-2) 0 0;
  color: var(--pk-danger);
  font-size: var(--pk-kit-type-meta-size);
}
.check-row {
  display: flex;
  align-items: center;
  gap: var(--pk-space-3);
  min-block-size: 1.5rem;
  cursor: pointer;
}
.check-row input {
  flex: none;
  inline-size: 1.5rem;
  block-size: 1.5rem;
  margin: 0;
  accent-color: var(--pk-accent);
}
.check-row input:focus-visible {
  outline: var(--pk-kit-focus-width) solid var(--pk-ring);
  outline-offset: 2px;
}
`;
