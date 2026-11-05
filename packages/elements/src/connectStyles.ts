// The inter-account screens' rules (CC-19.L): the pairing code, the line that says which device
// reported it, the categories, the wait, the offered file. Their own module, as syncStyles.ts is;
// the React twin (sdk-react/src/kit/connect.tsx) draws the same DOM with the same rules.

/** The panes' rules for the states that split (UI-KITS "LinkPairing and TransferOffer"): the start
 *  pane (title, lede, the code or the offer card) and the end pane (the reported device, the
 *  categories, the actions), top-aligned and stacked full width with the primary first. One grid,
 *  the numbers of the React twin (sdk-react/src/kit/connect.tsx `panes`); the DOM, the reading order
 *  and the focus order stay the one column's. `root` narrows the rule: any kit root in a short
 *  window, only a TV's elsewhere. */
function panes(root: string, tv: boolean): string {
  const on = [
    `${root}[data-component="LinkPairing"][data-state="code"]`,
    `${root}[data-component="LinkPairing"][data-state="confirm"]`,
    `${root}[data-component="TransferOffer"][data-state="ask"]`,
  ];
  const stage = on.map((r) => `${r} .stage[data-kind="screen"]`).join(",\n");
  const card = on.map((r) => `${r} .stage[data-kind="screen"] .card`);
  const each = (tail: string): string =>
    card.map((c) => `${c}${tail}`).join(",\n");
  const end = (tail: string): string =>
    [
      ...card.slice(0, 2).map((c) => `${c} > .pair-end${tail}`),
      `${card[2]} > .actions${tail}`,
    ].join(",\n");
  // A TV keeps its title-safe area (5 % each side) at any text size.
  const safe = tv
    ? `
  padding-inline: max(var(--pk-space-6), 5vw);
  padding-block: max(var(--pk-space-6), 5vh);`
    : "";
  return `${stage} {
  /* safe: a card taller than the window starts at its top edge and the window scrolls. */
  align-content: safe center;${safe}
}
${each("")} {
  inline-size: min(46rem, 100%);
  padding-inline: var(--pk-space-5);
  padding-block: var(--pk-space-4);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-rows: auto auto 1fr;
  column-gap: var(--pk-space-6);
  row-gap: var(--pk-space-3);
  align-items: start;
  align-content: start;
  min-block-size: 0;
  text-align: start;
}
${each(" > *")} {
  grid-column: 1;
}
${end("")} {
  grid-column: 2;
  grid-row: 1 / -1;
  display: grid;
  gap: var(--pk-space-3);
  align-content: start;
}
${each(" > .pair-end > .pair-actions")} {
  display: contents;
}
${each(" > .actions")},
${each(" > .pair-end > .pair-actions > .actions")} {
  position: static;
  margin: 0;
  padding: 0;
  background: none;
  box-shadow: none;
  display: grid;
  gap: var(--pk-space-3);
  flex-direction: column;
  justify-content: stretch;
  grid-template-columns: minmax(0, 1fr);
}
${each(" > .actions::before")},
${each(" > .pair-end > .pair-actions > .actions::before")} {
  content: none;
}
${each(" > .actions .btn")},
${each(" > .pair-end > .pair-actions > .actions .btn")} {
  inline-size: 100%;
  flex: none;
  white-space: normal;
}
`;
}

export const CONNECT_CSS = `
.pair-code {
  display: block;
  padding: var(--pk-space-4);
  border-radius: var(--pk-kit-radius-control);
  background: var(--pk-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--pk-border-subtle);
  font-family: var(--pk-kit-type-code-family);
  font-weight: var(--pk-kit-type-code-weight);
  font-size: 2rem;
  line-height: 1.2;
  letter-spacing: 0.08em;
  color: var(--pk-text-strong);
  text-align: center;
  overflow-wrap: anywhere;
}
.pair-reported {
  margin: 0;
  color: var(--pk-text-strong);
  overflow-wrap: anywhere;
}
.pair-actions,
.pair-end {
  display: contents;
}
.pair-offer {
  display: grid;
  gap: var(--pk-space-1);
}
.pair-meta {
  margin: 0;
  color: var(--pk-text-muted);
  overflow-wrap: anywhere;
}
.pair-file {
  margin: 0;
  color: var(--pk-text-strong);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}
.pair-shares {
  display: grid;
  gap: var(--pk-space-2);
}
.pair-shares .label {
  margin: 0;
}
.pair-cats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--pk-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.pair-cats li {
  padding: var(--pk-space-1) var(--pk-space-3);
  border-radius: var(--pk-radius-full);
  background: color-mix(in srgb, var(--pk-text-strong) 9%, transparent);
  color: var(--pk-text-strong);
  overflow-wrap: anywhere;
}
.pair-wait {
  display: flex;
  align-items: center;
  gap: var(--pk-space-3);
  margin: 0;
  color: var(--pk-text-muted);
}
.pair-wait:empty {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.pair-dot {
  flex: none;
  inline-size: 0.75rem;
  block-size: 0.75rem;
  border-radius: var(--pk-radius-full);
  background: var(--pk-accent-fg);
  animation: pk-pair-pulse 1.4s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .pair-dot {
    animation: none;
  }
}
@keyframes pk-pair-pulse {
  50% {
    opacity: 0.35;
  }
}
/* Two panes: a window at least 600px wide (the container counts rem at the page's root size, so
   200% text keeps one column) and under 480px tall; a TV or console in any size, at any text size. */
@media (max-height: 480px) {
  @container pk (min-width: 37.5rem) {
${panes(".pk-root", false)}  }
}
${panes(".pk-root[data-tv]", true)}`;
