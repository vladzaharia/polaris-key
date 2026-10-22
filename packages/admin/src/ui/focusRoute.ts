import { CLOSING_OVERLAYS, OPEN_OVERLAYS } from "../lib/router-core.js";
import { announce } from "./LiveRegion.js";

/**
 * Route-change focus (WCAG 2.4.3, ADMIN.md §5.6): after a navigation settles, move focus to the
 * page's `h1` and announce "{title}, page loaded" once, so a screen-reader user lands where a
 * sighted one looks. No consumer yet (P0-34.5, P0-34.6 call it from the console and the portal).
 *
 * It waits, polling, for the page to be ready:
 * - a closing overlay (`data-state="closed"`, still in its exit) holds it, because its focus
 *   return would land after ours;
 * - a loading placeholder (`[aria-busy="true"]` inside `root`) holds it, because the real heading
 *   is not there yet (a skeleton's `h1` is not the page's);
 * - no heading yet holds it.
 * An OPEN overlay ends the wait with no focus and no announcement: the dialog keeps focus.
 * The deadline stops the wait: the heading is focused if there is one and nothing is open, else
 * nothing happens. `alive()` returning `false` cancels a superseded wait (a newer navigation).
 */
export interface FocusRouteOptions {
  /** The announced name; default the heading's text. */
  title?: string;
  /** Where the page renders; default the document. */
  root?: ParentNode;
  /** Return `false` once this call is superseded. */
  alive?: () => boolean;
  /** Give up after this many ms. Default 1500. */
  deadline?: number;
}

export type FocusRouteResult = "focused" | "kept" | "cancelled" | "timeout";

const HEADING = "h1, [aria-level='1']";
const BUSY = "[aria-busy='true']";
const POLL_MS = 40;
export const FOCUS_DEADLINE_MS = 1500;

export function focusRoute(
  opts: FocusRouteOptions = {},
): Promise<FocusRouteResult> {
  const { title, alive, deadline = FOCUS_DEADLINE_MS } = opts;
  const root: ParentNode | undefined =
    opts.root ?? (typeof document === "undefined" ? undefined : document);
  if (!root) return Promise.resolve("cancelled");
  const doc = root instanceof Document ? root : (root as Node).ownerDocument!;
  const started = Date.now();

  return new Promise((resolve) => {
    const step = (): void => {
      if (alive && !alive()) return resolve("cancelled");
      if (doc.querySelector(OPEN_OVERLAYS)) return resolve("kept");
      const expired = Date.now() - started >= deadline;
      const heading = root.querySelector<HTMLElement>(HEADING);
      const ready =
        heading !== null &&
        !doc.querySelector(CLOSING_OVERLAYS) &&
        !root.querySelector(BUSY);
      if (ready || (expired && heading)) {
        if (!heading.hasAttribute("tabindex"))
          heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
        const name = (title ?? heading.textContent ?? "").trim();
        announce(name ? `${name}, page loaded` : "Page loaded");
        return resolve("focused");
      }
      if (expired) return resolve("timeout");
      setTimeout(step, POLL_MS);
    };
    step();
  });
}
