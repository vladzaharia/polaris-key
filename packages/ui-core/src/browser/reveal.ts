// Focus a control without leaving it under the docked action bar (WCAG 2.4.11). The kits focus
// with `preventScroll` so a screen never jumps; at a short window (the 400 % zoom row) the
// sticky bar then covers a field near the foot. The control gets a bottom scroll margin as tall
// as the bar (no more: at the shortest windows the heading must stay in view) and scrolls into
// view only if it is not already (`nearest`), so a later Tab into it clears the bar the same way.

/** Focus without a jump, then keep the control clear of the card's action bar. The bar settles
 *  over the first frames (its buttons stack until the box is measured), and a scroll for the
 *  taller bar would stay after it shrinks and push the heading out of view: the scroll waits
 *  until the bar has held its size for two frames. */
export function focusClear(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  const bar = el
    .closest(".card")
    ?.querySelector<HTMLElement>(":scope > .actions");
  // A control inside the bar is always on screen: it needs no margin, and scrolling for it would
  // push the heading out of the first viewport.
  if (!bar || bar.contains(el)) return;
  // A bar that is not docked (a two-pane card's end pane lays it out in the grid) covers nothing:
  // there is no margin to keep, and scrolling for it would push the card's top out of view.
  if (getComputedStyle(bar).position === "static") return;
  const clear = (): void => {
    el.style.scrollMarginBottom = `${bar.offsetHeight}px`;
    // A screen taller than a short window keeps its title in the first viewport (DL1): a button
    // or link may scroll the window only as far as the title's own top, less half a line so the
    // screen's last settling (its rise-in) cannot push the title off. A field is typed into, so
    // it always clears the bar (WCAG 2.4.11).
    const heading = (el.getRootNode() as ParentNode).querySelector?.("h1");
    const room = heading
      ? heading.getBoundingClientRect().top -
        parseFloat(getComputedStyle(heading).fontSize) / 2
      : -1;
    const { scrollX, scrollY } = window;
    // jsdom has no scrollIntoView.
    el.scrollIntoView?.({ block: "nearest" });
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (!field && room >= 0 && window.scrollY - scrollY > room)
      window.scrollTo(scrollX, scrollY + room);
  };
  if (typeof ResizeObserver !== "function") return clear();
  el.style.scrollMarginBottom = `${bar.offsetHeight}px`;
  let frame = 0;
  const settle = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        ro.disconnect();
        clear();
      });
    });
  };
  // The observer's first call is the bar as it is now.
  const ro = new ResizeObserver(settle);
  ro.observe(bar);
}
