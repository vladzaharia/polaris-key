// Media queries a primitive follows live: a coarse pointer (touch) and reduced motion.

import { useSyncExternalStore } from "react";

function subscribeTo(query: string) {
  return (onChange: () => void): (() => void) => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return () => undefined;
    const mql = window.matchMedia(query);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  };
}

const subscriptions = new Map<string, (cb: () => void) => () => void>();

/** Whether `query` matches now, re-rendering when it changes; `false` on a server render. */
export function useMediaQuery(query: string): boolean {
  let subscribe = subscriptions.get(query);
  if (!subscribe) {
    subscribe = subscribeTo(query);
    subscriptions.set(query, subscribe);
  }
  return useSyncExternalStore(
    subscribe,
    () => matches(query),
    () => false,
  );
}

/** Whether `query` matches now (no subscription). */
export function matches(query: string): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches
  );
}

export const COARSE_POINTER = "(pointer: coarse)";
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
export const FORCED_COLORS = "(forced-colors: active)";
