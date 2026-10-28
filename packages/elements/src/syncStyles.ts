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
