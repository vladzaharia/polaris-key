import * as React from "react";

/**
 * The in-app reduce-motion preference (notes/S-23 D3, §6.6; WCAG 2.3.3): System (follow the OS's
 * `prefers-reduced-motion`) or Reduced (instant swaps whatever the OS says).
 *
 *   preference "system" → no data-motion on <html>; the tokens follow the OS media query
 *   preference "reduce" → data-motion="reduce"; brand tokens.css and motion.css collapse every
 *                         duration to 0 ms, and ui/motion's reducedMotion() stops the JS half
 *
 * Stored like the theme (components/theme.tsx): localStorage, per browser, one key shared by the
 * console and the portal (same origin). It is applied by `applyStoredMotionPreference()` from both
 * entry modules before the first render, not by the hashed pre-paint script in index.html /
 * manage.html, so packages/worker/src/adminCsp.ts does not change. That is early enough: nothing
 * animates before the first interaction.
 *
 * The attribute on <html> is the single source of truth after start-up; `useMotionPreference()`
 * reads it through a MutationObserver, so every control showing the preference stays in step
 * without a provider. A change in another tab (a `storage` event) is applied here too.
 */
export type MotionPreference = "system" | "reduce";

export const MOTION_STORAGE_KEY = "pk-admin-motion";

function parse(value: string | null | undefined): MotionPreference {
  return value === "reduce" ? "reduce" : "system";
}

/** The stored preference; "system" when nothing (or something unknown) is stored. */
export function readMotionPreference(): MotionPreference {
  try {
    return parse(window.localStorage.getItem(MOTION_STORAGE_KEY));
  } catch {
    // storage unavailable (private mode): follow the system
    return "system";
  }
}

/** Mirror a preference onto <html data-motion> (attribute only: no style, CSP-safe). */
function apply(preference: MotionPreference): void {
  const root = document.documentElement;
  if (preference === "reduce") root.setAttribute("data-motion", "reduce");
  else root.removeAttribute("data-motion");
}

/** Read the stored preference and apply it. Called from both entry modules before render. */
export function applyStoredMotionPreference(): MotionPreference {
  const preference = readMotionPreference();
  apply(preference);
  return preference;
}

/** Apply a preference at once and persist it for this browser. */
export function setMotionPreference(preference: MotionPreference): void {
  apply(preference);
  try {
    // "system" is stored too, so an explicit return to system survives a reload.
    window.localStorage.setItem(MOTION_STORAGE_KEY, preference);
  } catch {
    // storage may be unavailable (private mode): the preference still applies for the session
  }
}

function current(): MotionPreference {
  return parse(document.documentElement.getAttribute("data-motion"));
}

function subscribe(onChange: () => void): () => void {
  const observer =
    typeof MutationObserver === "function"
      ? new MutationObserver(onChange)
      : null;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-motion"],
  });
  const onStorage = (e: StorageEvent): void => {
    if (e.key === MOTION_STORAGE_KEY) apply(parse(e.newValue));
  };
  window.addEventListener("storage", onStorage);
  return () => {
    observer?.disconnect();
    window.removeEventListener("storage", onStorage);
  };
}

/** The preference as React state, with its setter. */
export function useMotionPreference(): [
  MotionPreference,
  (preference: MotionPreference) => void,
] {
  const preference = React.useSyncExternalStore(
    subscribe,
    current,
    () => "system" as const,
  );
  return [preference, setMotionPreference];
}

const OS_QUERY = "(prefers-reduced-motion: reduce)";

/** Whether the OS asks for reduced motion now (live), for the "System" row's hint. */
export function useSystemReducedMotion(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const mq = window.matchMedia(OS_QUERY);
      mq.addEventListener?.("change", onChange);
      return () => mq.removeEventListener?.("change", onChange);
    },
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(OS_QUERY).matches,
    () => false,
  );
}
