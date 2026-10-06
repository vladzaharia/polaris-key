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
 * Whether `page`'s list may stagger: only on the page's first mount in this document, only with
 * its data still `pending` when it mounts (it arrives while the person watches), never while a
 * View Transition is running, and only until the first render with the data has been committed.
 * The first load is one moment: a list that mounts after it (a refetch that turns the empty state
 * into a grid, or one product into two, or seven into eight) is not part of it.
 */
export function useFirstLoad(page: string, pending: boolean): boolean {
  const [first] = React.useState(
    () => pending && !loadedPages.has(page) && !viewTransitionRunning(),
  );
  const shown = React.useRef(false);
  React.useEffect(() => {
    loadedPages.add(page);
  }, [page]);
  React.useEffect(() => {
    if (!pending) shown.current = true;
  }, [pending]);
  return first && !shown.current;
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
 * - on a refetch: items keep their keys, so none remounts and no animation restarts; and a list
 *   that a refetch mounts (the layout changes tier: empty → a grid, 1 → 2 products, 7 → 8 or
 *   8 → 7) mounts without it, because `firstLoad` is false by then and the hook turns off when
 *   it renders that way before any list of its own has attached;
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
  // Has a list of this hook's been committed? Then its stagger is the first load's own.
  const attached = React.useRef(false);
  const allowed =
    view === initialView &&
    !viewTransitionRunning() &&
    (firstLoad || attached.current);
  // Off for good when the view changes (also once it is back where it started), when a View
  // Transition runs as the list renders, or when the first load ended before this hook's list
  // ever attached (a refetch that changed the layout). Done while rendering (React's "adjust
  // state while rendering" pattern): the render is redone at once, so the list never commits
  // with the class.
  if (on && !allowed) setOn(false);
  const ref = React.useCallback((el: HTMLElement | null) => {
    if (!el) return;
    attached.current = true;
    if (typeof el.getAnimations !== "function") return;
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
    className: on && allowed ? "pk-stagger" : undefined,
    ref,
  };
}
