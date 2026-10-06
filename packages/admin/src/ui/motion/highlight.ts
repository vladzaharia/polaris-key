import { tokenMs } from "./reducedMotion.js";

/** The latest highlight on each element: an earlier one's timers never touch a newer tint. */
const owners = new WeakMap<Element, symbol>();

/**
 * Tint a new or changed row, then let the tint fade (`.pk-row` / `.pk-row-highlight` in
 * motion.css). The hold is `--pk-delay-highlight` (1.6 s), a delay rather than motion, so it stays
 * under reduced motion: the tint still comes and goes, as an instant swap. Returns a function that
 * clears the tint early.
 *
 * `.pk-row` carries the fade's transition, so it goes too once the fade has ended (its
 * `transitionend`, or `--pk-duration-deliberate` when none fires, as under reduced motion): a row
 * tinted once must not keep a slower hover than its neighbours. A second highlight of the same
 * row takes both classes over, with a full hold of its own.
 */
export function highlight(el: Element | null | undefined): () => void {
  if (!el) return () => undefined;
  const me = Symbol("highlight");
  owners.set(el, me);
  el.classList.add("pk-row", "pk-row-highlight");
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = (): void => {
    clearTimeout(fadeTimer);
    el.removeEventListener("transitionend", onFadeEnd);
    if (owners.get(el) !== me) return;
    owners.delete(el);
    el.classList.remove("pk-row");
  };
  function onFadeEnd(e: Event): void {
    if (
      e.target === el &&
      (e as TransitionEvent).propertyName === "background-color"
    )
      settle();
  }
  let cleared = false;
  const clear = (): void => {
    clearTimeout(holdTimer);
    if (cleared) return;
    cleared = true;
    // A newer highlight of this row owns both classes now.
    if (owners.get(el) !== me) return;
    el.classList.remove("pk-row-highlight");
    el.addEventListener("transitionend", onFadeEnd);
    fadeTimer = setTimeout(
      settle,
      tokenMs("--pk-duration-deliberate", 480) + 50,
    );
  };
  const holdTimer = setTimeout(clear, tokenMs("--pk-delay-highlight", 1600));
  return clear;
}
