/**
 * Set a meter's fill (0–1) through the `--pk-meter` custom property (the CSSOM, which the Worker's
 * `style-src 'self'` allows); `.pk-meter-fill` in motion.css turns it into a transform-only
 * `scaleX` with a token transition. Out-of-range values clamp; anything not a number empties it.
 */
export function setMeter(
  el: HTMLElement | SVGElement | null | undefined,
  value: number,
): void {
  if (!el) return;
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const first = el.style.getPropertyValue("--pk-meter") === "";
  el.style.setProperty("--pk-meter", String(v));
  // The first value is the meter's starting point, not a change: it appears at its value. When
  // anything forced a style recalculation between the rect's insertion and this write (a layout
  // read in a sibling's layout effect, a view transition capturing the new page), the browser has
  // already styled the fill at scaleX(0) and would glide it to `v`, a transition still running
  // after the page has landed. Reading the animations flushes style and starts that transition;
  // cancelling it snaps the fill to its value.
  if (first && typeof el.getAnimations === "function")
    for (const a of el.getAnimations())
      if (typeof CSSTransition !== "undefined" && a instanceof CSSTransition)
        a.cancel();
}
