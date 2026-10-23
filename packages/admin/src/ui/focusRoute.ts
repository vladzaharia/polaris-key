import { CLOSING_OVERLAYS, OPEN_OVERLAYS } from "../lib/router-core.js";
import { announce } from "./LiveRegion.js";

/**
 * Route-change focus (WCAG 2.4.3, ADMIN.md §5.6): after a navigation settles, move focus to the
 * page's `h1` and announce "{title}, page loaded" once, so a screen-reader user lands where a
 * sighted one looks. Used by the portal and the console on a route change.
 *
 * It waits, polling, for the page to be ready:
 * - a closing overlay (`data-state="closed"`, still in its exit) holds it, because its focus
 *   return would land after ours;
 * - a heading that is a loading placeholder (inside an `aria-busy` skeleton) holds it, because the
 *   real heading is not there yet. A busy panel elsewhere on the page does not: the heading is
 *   real and the page can be read while the panel loads;
 * - no heading yet holds it.
 * An OPEN overlay ends the wait with no focus and no announcement: the dialog keeps focus.
 * Focus is taken only from `body`, from the element that had it when the call began, or from a
 * node that has since left the page: never from a control the person has reached meanwhile.
 *
 * The deadline releases a wait held by a closing overlay (the real heading is focused anyway). A
 * placeholder is never focused or announced: past the deadline the wait goes on, for a call with
 * an `alive()`, until the call is superseded (`alive()` returns `false`), up to `MAX_WAIT_FACTOR`
 * deadlines; it then ends silently. Without `alive()` it ends silently at the deadline.
 */
export interface FocusRouteOptions {
  /** The announced name only when the page has no heading; the heading's accessible name wins. */
  title?: string;
  /** Where the page renders; default the document. */
  root?: ParentNode;
  /** Return `false` once this call is superseded. */
  alive?: () => boolean;
  /** Stop holding for an overlay after this many ms. Default 1500. */
  deadline?: number;
}

export type FocusRouteResult =
  | "focused"
  | "kept"
  | "moved"
  | "cancelled"
  | "timeout";

const HEADING = "h1, [aria-level='1']";
const BUSY = "[aria-busy='true']";
const POLL_MS = 40;
export const FOCUS_DEADLINE_MS = 1500;
/** An `alive()` call keeps waiting for a real heading this many deadlines at most. */
export const MAX_WAIT_FACTOR = 10;

/**
 * The heading's accessible name: its `aria-label` if present, else its text with `aria-hidden` and
 * `hidden` parts left out (badges and chips marked decorative), `img` alt text kept.
 */
export function headingName(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label;
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return n.textContent ?? "";
    if (n.nodeType !== 1) return "";
    const e = n as Element;
    if (e.getAttribute("aria-hidden") === "true" || e.hasAttribute("hidden"))
      return "";
    const own = e.getAttribute("aria-label")?.trim();
    if (own) return ` ${own} `;
    if (e.tagName === "IMG") return ` ${e.getAttribute("alt") ?? ""} `;
    return Array.from(e.childNodes).map(walk).join("");
  };
  return Array.from(el.childNodes)
    .map(walk)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function focusRoute(
  opts: FocusRouteOptions = {},
): Promise<FocusRouteResult> {
  const { title, alive, deadline = FOCUS_DEADLINE_MS } = opts;
  const root: ParentNode | undefined =
    opts.root ?? (typeof document === "undefined" ? undefined : document);
  if (!root) return Promise.resolve("cancelled");
  const doc = root instanceof Document ? root : (root as Node).ownerDocument!;
  // performance.now(): monotonic, and not pinned by a test harness that freezes Date.
  const started = performance.now();
  const initial = doc.activeElement;

  return new Promise((resolve) => {
    const step = (): void => {
      if (alive && !alive()) return resolve("cancelled");
      if (doc.querySelector(OPEN_OVERLAYS)) return resolve("kept");
      const elapsed = performance.now() - started;
      const expired = elapsed >= deadline;
      const heading = root.querySelector<HTMLElement>(HEADING);
      const real = heading !== null && !heading.closest(BUSY);
      if (real && (expired || !doc.querySelector(CLOSING_OVERLAYS))) {
        const now = doc.activeElement;
        if (now && now !== doc.body && now !== initial && now.isConnected)
          return resolve("moved");
        if (!heading.hasAttribute("tabindex"))
          heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
        const name = (headingName(heading) || (title ?? "")).trim();
        announce(name ? `${name}, page loaded` : "Page loaded");
        return resolve("focused");
      }
      if (expired && (!alive || elapsed >= deadline * MAX_WAIT_FACTOR))
        return resolve("timeout");
      setTimeout(step, POLL_MS);
    };
    step();
  });
}
