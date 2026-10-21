import * as React from "react";
import { useLocation } from "./router.js";
import { SETTINGS_INDEX } from "./settings.generated.js";

/** Dispatched when a jump names the setting the page is already on: land on it again. */
export const LAND_EVENT = "pk-land";

/**
 * Scroll to an element, focus it and mark it for a moment, so a pointer user sees where they
 * arrived as well as a keyboard user (`:focus-visible` is false after a click). The mark is a
 * Web Animation (an accent wash and an outline that fade out), so it needs no inline style and
 * CSP allows it; under reduced motion it holds and then goes, with no fade.
 */
export function landOnElement(el: HTMLElement): void {
  el.scrollIntoView?.({ block: "center" });
  if (
    !el.hasAttribute("tabindex") &&
    !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
  )
    el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  if (typeof el.animate !== "function") return;
  const reduce = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  el.animate(
    [
      {
        backgroundColor: "var(--pk-accent-subtle)",
        outline: "2px solid var(--pk-focus)",
        outlineOffset: "-2px",
      },
      {
        backgroundColor: "var(--pk-accent-subtle)",
        outline: "2px solid var(--pk-focus)",
        outlineOffset: "-2px",
        offset: 0.7,
      },
      {
        backgroundColor: "transparent",
        outline: "2px solid transparent",
        outlineOffset: "-2px",
      },
    ],
    { duration: 2500, easing: reduce ? "step-end" : "ease-out" },
  );
}

/**
 * Wait for the first of `rows` to be drawn and land on it; when none appears within `rowWaitMs`,
 * land on `fallback` (the section that holds the row) if that is there. Gives up after `timeoutMs`.
 * Returns a cancel function.
 */
export function landOn(
  rows: string[],
  fallback: string | null,
  { rowWaitMs = 1500, timeoutMs = 5000 } = {},
): () => void {
  const started = Date.now();
  let frame = 0;
  let timer = 0;
  let cancelled = false;
  const settle = (el: HTMLElement): void => {
    // One more turn, so the route's heading focus and a dialog's focus return have settled.
    timer = window.setTimeout(() => {
      if (!cancelled) landOnElement(el);
    }, 50);
  };
  const tick = (): void => {
    if (cancelled) return;
    for (const id of rows) {
      const el = document.getElementById(id);
      if (el) return settle(el);
    }
    const waited = Date.now() - started;
    if (waited > rowWaitMs && fallback) {
      const el = document.getElementById(fallback);
      if (el) return settle(el);
    }
    if (waited < timeoutMs) frame = window.requestAnimationFrame(tick);
  };
  frame = window.requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}

/** The element ids a page may draw a setting's row under, for a key and its older spellings. */
export const ROW_ID_PREFIXES = [
  "setting-",
  "asset-setting-",
  "all-setting-",
  "platform-setting-",
] as const;

/** The key and its older spellings (A-13's `LAZY_DELTAS` and the like). */
export function namesOf(key: string): string[] {
  return [key, ...(SETTINGS_INDEX.find((e) => e.key === key)?.aliases ?? [])];
}

/**
 * The one deep-link convention (ST-10, ST-08n): `?setting=<key>` lands on the setting's row, or,
 * when the page draws none, on `section` (the element that holds it). Runs on arrival and again
 * whenever a jump names the same setting (`LAND_EVENT`). `ready` says the page's rows are drawn.
 * `idOf` narrows the row ids a page uses; with none, every known row prefix is tried.
 */
export function useSettingTarget(
  ready = true,
  idOf?: (name: string) => string,
  section?: (key: string) => string | null,
): void {
  const key = useLocation().route.query.get("setting");
  const [again, setAgain] = React.useState(0);
  React.useEffect(() => {
    const on = (): void => setAgain((n) => n + 1);
    window.addEventListener(LAND_EVENT, on);
    return () => window.removeEventListener(LAND_EVENT, on);
  }, []);
  React.useEffect(() => {
    if (!ready || !key) return;
    const names = namesOf(key);
    const rows = idOf
      ? names.map(idOf)
      : names.flatMap((n) => ROW_ID_PREFIXES.map((p) => `${p}${n}`));
    return landOn(rows, section?.(key) ?? null);
    // `idOf` and `section` are module-level functions at each caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key, again]);
}
