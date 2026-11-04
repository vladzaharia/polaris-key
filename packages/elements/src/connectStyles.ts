// The inter-account screens' rules (CC-19.L): the pairing code, the line that says which device
// reported it, the categories, the wait, the offered file. Their own module, as syncStyles.ts is;
// the React twin (sdk-react/src/kit/connect.tsx) draws the same DOM with the same rules.

/** The panes' rules for the states that split (UI-KITS "LinkPairing and TransferOffer"): the start
 *  pane (title, lede, the code or the offer card) and the end pane (the reported device, the
 *  categories, the actions). CSS columns with a forced break after the start pane, so the DOM, the
 *  reading order and the focus order stay the one column's. `root` narrows the rule: any kit root
 *  in a short window, only a TV's elsewhere. */
function panes(root: string, short: boolean): string {
  const on = [
    `${root}[data-component="LinkPairing"][data-state="code"]`,
    `${root}[data-component="LinkPairing"][data-state="confirm"]`,
    `${root}[data-component="TransferOffer"][data-state="ask"]`,
  ];
  const card = on.map((r) => `${r} .stage[data-kind="screen"] .card`);
  const each = (tail: string): string =>
    card.map((c) => `${c}${tail}`).join(",\n");
  const stage = on.map((r) => `${r} .stage[data-kind="screen"]`).join(",\n");
  return `${
    short
      ? `${stage} {
  padding-inline: var(--pk-space-1);
  padding-block: var(--pk-space-2);
  align-content: start;
}
`
      : ""
  }${each("")} {
  display: block;
  column-count: 2;
  column-gap: var(--pk-space-6);
  column-fill: balance;
  inline-size: min(48rem, 100%);
  min-block-size: 0;
  padding-inline: var(--pk-space-4);
  padding-block: var(--pk-space-3);
}
${each(" > *")} {
  break-inside: avoid;
  margin-block: 0 var(--pk-space-3);
}
${each(" > .pair-code")},
${each(" > .pair-offer")} {
  break-after: column;
}
${each(" > .actions")},
${each(" > .pair-actions > .actions")} {
  position: static;
  margin-inline: 0;
  margin-block: 0 var(--pk-space-3);
  padding: 0;
  background: none;
  box-shadow: none;
  gap: var(--pk-space-2);
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
.pair-actions {
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
   200% text keeps one column) and under 480px tall, and a TV in any height. */
@media (max-height: 480px) {
  @container pk (min-width: 37.5rem) {
${panes(".pk-root", true)}  }
}
@container pk (min-width: 37.5rem) {
${panes(".pk-root[data-tv]", false)}}
`;
