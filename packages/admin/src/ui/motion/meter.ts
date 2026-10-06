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
  el.style.setProperty("--pk-meter", String(v));
}
