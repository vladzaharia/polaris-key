// Focus a control without leaving it under the docked action bar (WCAG 2.4.11). The kits focus
// with `preventScroll` so a screen never jumps; at a short window (the 400 % zoom row) the
// sticky bar then covers a field near the foot. The control gets a bottom scroll margin as tall
// as the bar and scrolls into view only if it is not already (`nearest`), so a later Tab into it
// clears the bar the same way.

/** Focus without a jump, then keep the control clear of the card's action bar. */
export function focusClear(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  const bar = el
    .closest(".card")
    ?.querySelector<HTMLElement>(":scope > .actions");
  if (!bar) return;
  el.style.scrollMarginBottom = `${bar.offsetHeight + 8}px`;
  el.scrollIntoView({ block: "nearest" });
}
