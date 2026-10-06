import { reducedMotion } from "./reducedMotion.js";

/**
 * Same-document View Transitions (notes/S-23 D2, §6.3). The names live in src/motion.css and
 * apply only under `html[data-vt="<type>"]`, which this sets for the length of one transition.
 */

/** The kinds of transition motion.css knows (S-23 §6.3). */
export type ViewTransitionType =
  | "route"
  | "forward"
  | "back"
  | "tab"
  | "list"
  | "dialog"
  | "theme";

export interface ViewTransitionOptions {
  /** Sets `html[data-vt]`, which selects the names and the animation (default `route`). */
  type?: ViewTransitionType;
  /**
   * One-shot shared elements: each element gets the `view-transition-name` for the old snapshot
   * only (through the CSSOM); the new end is named by its class in motion.css (`pk-vt-hero`…).
   */
  shared?: ReadonlyArray<readonly [Element | null | undefined, string]>;
  /** The list whose rows move, enter and leave (type `list`). */
  list?: Element | null;
}

export interface ViewTransitionHandle {
  /** The new state is in the DOM: move focus now (never after the animation). */
  updateCallbackDone: Promise<void>;
  /** The animation has ended (or was skipped). */
  finished: Promise<void>;
}

/** Rows a list transition names before it switches to naming only the rows on screen (D7). */
export const LIST_BUDGET = 30;

interface RunningTransition {
  updateCallbackDone: Promise<unknown>;
  finished: Promise<unknown>;
  skipTransition(): void;
}
type StartViewTransition = (update: () => void) => RunningTransition;

function starter(): StartViewTransition | null {
  if (typeof document === "undefined") return null;
  const start = (document as { startViewTransition?: unknown })
    .startViewTransition;
  return typeof start === "function"
    ? (start.bind(document) as StartViewTransition)
    : null;
}

/** True when the browser runs same-document View Transitions. */
export function viewTransitionsSupported(): boolean {
  return starter() !== null;
}

/**
 * Mark `<html data-vt-supported>` when the API exists, so motion.css can give the browsers
 * without it a plain fade-in of the new route (`.pk-route-in`). Run once at import.
 */
export function markViewTransitionSupport(): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  if (viewTransitionsSupported()) html.dataset.vtSupported = "";
  else delete html.dataset.vtSupported;
}
markViewTransitionSupport();

let current: RunningTransition | null = null;
let currentList: Element | null = null;

/** Report an error from inside a transition's update without leaving an unhandled rejection. */
function report(error: unknown): void {
  const reportError = (globalThis as { reportError?: (e: unknown) => void })
    .reportError;
  if (typeof reportError === "function") reportError(error);
  else console.error(error);
}

const resolved = (): ViewTransitionHandle => {
  const done = Promise.resolve();
  return { updateCallbackDone: done, finished: done };
};

/**
 * Run `update` (a synchronous DOM or state change; React callers wrap their state updates in
 * `flushSync` inside it) in a same-document View Transition.
 *
 * - Without the API, or under reduced motion, `update` runs right here and both promises are
 *   already resolved: an instant swap (the new route fades in through `.pk-route-in` where the
 *   API is missing).
 * - A transition already running is skipped to its end first: the page takes no input during a
 *   View Transition (S-23 §3.3), so a fast second click must never wait.
 * - A `list` of up to LIST_BUDGET rows takes part whole (`.pk-vt-list`); a longer list names only
 *   the rows on screen, so the cost is bounded by the viewport, not the data (S-23 §3.5).
 */
export function viewTransition(
  update: () => void,
  options: ViewTransitionOptions = {},
): ViewTransitionHandle {
  const start = starter();
  if (!start || reducedMotion()) {
    update();
    return resolved();
  }
  const { type = "route", shared = [], list = null } = options;
  const html = document.documentElement;

  current?.skipTransition();

  for (const [el, name] of shared)
    (el as HTMLElement | null | undefined)?.style?.setProperty(
      "view-transition-name",
      name,
    );
  html.dataset.vt = type;

  // The budget is judged on each side of the update: a list that grows past LIST_BUDGET (Clear
  // filters on a long table) names only its on-screen rows in the new state (MO-09).
  const nameRows = (): void => {
    if (!list) return;
    if (list.children.length <= LIST_BUDGET) {
      list.classList.add("pk-vt-list");
      return;
    }
    list.classList.remove("pk-vt-list");
    const vh = window.innerHeight;
    for (const row of Array.from(list.children)) {
      const r = row.getBoundingClientRect();
      const style = (row as HTMLElement).style;
      if (r.bottom > 0 && r.top < vh) {
        style.setProperty("view-transition-name", "match-element");
        style.setProperty("view-transition-class", "pk-row");
      } else {
        style.removeProperty("view-transition-name");
        style.removeProperty("view-transition-class");
      }
    }
  };
  nameRows();

  let failed = false;
  const t = start(() => {
    for (const [el] of shared)
      (el as HTMLElement | null | undefined)?.style?.removeProperty(
        "view-transition-name",
      );
    try {
      update();
    } catch (error) {
      failed = true;
      throw error;
    }
    nameRows();
  });
  current = t;
  currentList = list;

  const cleanup = (): void => {
    const latest = current === t;
    if (latest) {
      current = null;
      currentList = null;
      delete html.dataset.vt;
    }
    // A newer transition over the same list keeps its names.
    if (list && (latest || currentList !== list)) {
      list.classList.remove("pk-vt-list");
      for (const row of Array.from(list.children)) {
        const style = (row as HTMLElement).style;
        style?.removeProperty("view-transition-name");
        style?.removeProperty("view-transition-class");
      }
    }
  };
  const finished = t.finished.then(
    () => undefined,
    () => undefined,
  );
  void finished.then(cleanup);
  return {
    updateCallbackDone: t.updateCallbackDone.then(
      () => undefined,
      (error: unknown) => {
        // A skipped transition rejects its promises with an AbortError; only a failed update is
        // worth reporting.
        if (failed) report(error);
      },
    ),
    finished,
  };
}
