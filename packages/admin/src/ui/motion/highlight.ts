import { tokenMs } from "./reducedMotion.js";

/**
 * Tint a new or changed row, then let the tint fade (`.pk-row` / `.pk-row-highlight` in
 * motion.css). The hold is `--pk-delay-highlight` (1.6 s), a delay rather than motion, so it stays
 * under reduced motion: the tint still comes and goes, as an instant swap. Returns a function that
 * clears the tint early.
 */
export function highlight(el: Element | null | undefined): () => void {
  if (!el) return () => undefined;
  el.classList.add("pk-row", "pk-row-highlight");
  const clear = (): void => {
    clearTimeout(timer);
    el.classList.remove("pk-row-highlight");
  };
  const timer = setTimeout(clear, tokenMs("--pk-delay-highlight", 1600));
  return clear;
}
