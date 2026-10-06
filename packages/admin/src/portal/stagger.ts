import * as React from "react";

/** A View Transition is running: the motion layer sets `html[data-vt]` for its length. */
function viewTransitionRunning(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-vt")
  );
}

/** The pages whose list has had its first load in this document. */
const loadedPages = new Set<string>();

/**
 * Whether `page`'s list may stagger, decided once when the page mounts: only on the page's first
 * mount in this document, only with its data still `pending` (it arrives while the person
 * watches), and never while a View Transition is running.
 */
export function useFirstLoad(page: string, pending: boolean): boolean {
  const [first] = React.useState(
    () => pending && !loadedPages.has(page) && !viewTransitionRunning(),
  );
  React.useEffect(() => {
    loadedPages.add(page);
  }, [page]);
  return first;
}

/** Forget which pages have loaded: for tests, where every render stands for a fresh document. */
export function forgetLoadedPages(): void {
  loadedPages.clear();
}

/**
 * The stagger-list pattern on the portal's grids and lists (notes/S-23 §6.1; MO-07): the items rise
 * in one after another (`.pk-stagger` in src/motion.css, 30 ms apart, at most 6 steps, so 180 ms
 * for the twelve-product Library) on the list's **first load only**: the first time its page
 * mounts in this document, with its data still on the way (`useFirstLoad`). Never:
 *
 * - inside a View Transition (`html[data-vt]`): a route change, or Back from a product, whose tile
 *   morph (MO-05) a stagger would fight. A page that mounts during one never staggers, and a list
 *   that would start staggering while one runs does not;
 * - on a return to the page, cached or not (the page has loaded once in this document);
 * - on a refetch: the items keep their keys, so none remounts and no animation restarts;
 * - after a search, filter, sort or grid ↔ list switch: pass those as `view`, and any change turns
 *   the stagger off for good (the grid ↔ list switch is a View Transition of its own).
 *
 * The class also comes off once the stagger's own animations have finished, so an item that turns
 * up later (a filter undone) appears in place instead of rising in by itself. Timers never decide
 * that (S-23 §6.2 rule 6): it waits on the animations. Under reduced motion there are none, so it
 * comes off at once; without the Web Animations API (jsdom) it stays until `view` changes.
 *
 * Put `className` on the container whose children are the items (a `ul`, a `tbody`) and `ref` on
 * the same element.
 */
export function useFirstLoadStagger(
  firstLoad: boolean,
  view = "",
): {
  className: string | undefined;
  ref: React.RefCallback<HTMLElement>;
} {
  const [on, setOn] = React.useState(firstLoad);
  const [initialView] = React.useState(view);
  // A changed view ends it for good, also once the view is back where it started, and so does a
  // View Transition running when the list renders (React's "adjust state while rendering"
  // pattern: this render is redone at once, before anything is committed).
  if (on && (view !== initialView || viewTransitionRunning())) setOn(false);
  const ref = React.useCallback((el: HTMLElement | null) => {
    if (!el || typeof el.getAnimations !== "function") return;
    // getAnimations() resolves styles first, so the stagger's animations exist by now. Only the
    // items' own: a spinner inside an item loops and would never finish.
    const stagger = el
      .getAnimations({ subtree: true })
      .filter(
        (a) =>
          (a.effect as KeyframeEffect | null)?.target?.parentElement === el,
      );
    void Promise.allSettled(stagger.map((a) => a.finished)).then(() =>
      setOn(false),
    );
  }, []);
  return {
    className:
      on && view === initialView && !viewTransitionRunning()
        ? "pk-stagger"
        : undefined,
    ref,
  };
}
