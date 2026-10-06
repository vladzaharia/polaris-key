import * as React from "react";

/**
 * The stagger-list pattern on the portal's grids and lists (notes/S-23 §6.1; MO-07): the items rise
 * in one after another (`.pk-stagger` in src/motion.css, 30 ms apart, at most 6 steps, so 180 ms
 * for the twelve-product Library) — on the list's **first load only**, meaning its data arrived
 * while the person watched (`firstLoad`: the page mounted with its query still pending). Never:
 *
 * - on a refetch: the items keep their keys, so none remounts and no animation restarts;
 * - after a search, filter, sort or grid ↔ list switch: pass those as `view`, and any change turns
 *   the stagger off for good (the grid ↔ list switch is a View Transition of its own);
 * - on a return to a page whose data is cached (`firstLoad` is false).
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
  // A changed view ends it for good, also once the view is back where it started (React's
  // "adjust state while rendering" pattern: this render is redone at once, before any commit).
  if (on && view !== initialView) setOn(false);
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
    className: on && view === initialView ? "pk-stagger" : undefined,
    ref,
  };
}
