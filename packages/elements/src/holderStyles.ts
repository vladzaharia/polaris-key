// The holder screens' rules (UK-42.7): ActivateDone's recommendation card and AddToAccount's form.
// Their own module, as the Cloud Sync screens' is, so the React kit's first load leaves them out
// and adopts them with the screens. The check and the morph are the kit's own (`.success`, the
// step morph); the reasons rise in with `.pk-stagger`, three at most.

export const HOLDER_CSS = `
/* ── Holder screens (UK-42.7): the recommendation card, the name and email form ───────────── */
.holder-card {
  display: grid;
  gap: var(--pk-space-4);
  padding: var(--pk-space-4);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  text-align: start;
}
.holder-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--pk-space-2);
}
.holder-head .title {
  margin: 0;
}
.holder-badge {
  padding: var(--pk-space-0_5) var(--pk-space-2);
  border-radius: var(--pk-radius-full);
  background: var(--pk-selected);
  color: var(--pk-text-strong);
  font-size: var(--pk-kit-type-meta-size);
  line-height: var(--pk-kit-type-meta-line-height);
  font-weight: var(--pk-kit-type-label-weight);
}
.holder-reasons {
  display: grid;
  gap: var(--pk-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.holder-reasons li {
  display: flex;
  align-items: flex-start;
  gap: var(--pk-space-3);
  color: var(--pk-text-default);
}
.holder-icon {
  flex: none;
  display: grid;
  place-items: center;
  block-size: 1lh;
  color: var(--pk-accent-fg);
}
.holder-glyph {
  inline-size: 1.25rem;
  block-size: 1.25rem;
}
.holder-skip {
  margin: 0;
}
.holder-form {
  display: grid;
  gap: var(--pk-space-4);
}
.holder-form[hidden] {
  display: none;
}
.holder-form input[readonly] {
  color: var(--pk-text-muted);
}
`;
