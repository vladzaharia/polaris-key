import type { QueryClient } from "@tanstack/react-query";
import { qk } from "../../../data/queries.js";

/** An element that can take focus back: connected, and not the page itself. */
const usable = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el !== document.body && el.isConnected;

/** Who had focus when the drawer opened; `null` when it was opened from a URL (focus on body). */
export const openerOf = (active: Element | null): HTMLElement | null =>
  usable(active) ? active : null;

/**
 * After the approve drawer closes, put focus where the operator can carry on. The recipe card
 * changes under the drawer (its opener becomes "View approval", or unmounts with its callout),
 * so wait for the refetch, then try the opener, the card's current opener and last the card's
 * "Recipe" label. A drawer opened from a URL has no opener and goes straight to the card.
 */
export function focusRecipeAnchor(
  queryClient: QueryClient,
  slug: string,
  opener: HTMLElement | null,
): void {
  const started = Date.now();
  const settle = (): void => {
    if (
      queryClient.isFetching({ queryKey: qk.mint(slug) }) > 0 &&
      Date.now() - started < 1500
    ) {
      window.setTimeout(settle, 40);
      return;
    }
    window.requestAnimationFrame(() => {
      const target =
        (usable(opener) ? opener : null) ??
        document.querySelector<HTMLElement>("[data-recipe-opener]") ??
        document.querySelector<HTMLElement>("[data-recipe-label]");
      target?.focus();
    });
  };
  window.setTimeout(settle, 80);
}
