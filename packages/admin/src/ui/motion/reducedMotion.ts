import * as React from "react";

/**
 * Reduced motion (notes/S-23 D3, §6.6): motion is an instant swap when the OS asks for it
 * (`prefers-reduced-motion: reduce`) **or** the in-app preference has set
 * `data-motion="reduce"` on `<html>` (MO-12). The tokens collapse in CSS on their own; this is for
 * the JavaScript half of the layer (a View Transition, a count, a burst), which must not start.
 */

const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;
}

/** True when motion should be an instant swap: the OS setting or the in-app preference. */
export function reducedMotion(): boolean {
  if (typeof document === "undefined") return true;
  return (
    document.documentElement.dataset.motion === "reduce" ||
    media()?.matches === true
  );
}

function subscribe(onChange: () => void): () => void {
  const mq = media();
  mq?.addEventListener?.("change", onChange);
  const observer =
    typeof MutationObserver === "function"
      ? new MutationObserver(onChange)
      : null;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-motion"],
  });
  return () => {
    mq?.removeEventListener?.("change", onChange);
    observer?.disconnect();
  };
}

/** `reducedMotion()` as React state: re-renders when the OS setting or the preference changes. */
export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribe, reducedMotion, () => true);
}

/**
 * A motion token in milliseconds, read from the computed style of `<html>` (so it is already 0 under
 * reduced motion). `fallback` covers environments without computed custom properties (jsdom).
 */
export function tokenMs(name: string, fallback: number): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function")
    return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) return fallback;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
}
