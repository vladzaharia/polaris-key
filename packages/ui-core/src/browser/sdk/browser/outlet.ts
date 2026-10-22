// The web runtime's outlet signals (plans/P3-01.md §2.9; notes/S-06 §8).
//
// A browser page is a `web` outlet by construction: it has no export-time stamp, so the adapter
// synthesises one (`WEB_OUTLET_STAMP`, `outletKind: "web"`), and the only signal a page can read
// is how it is displayed. `web.displayMode` is `standalone` when the page runs in an app window:
//
//   * `matchMedia('(display-mode: standalone)')` — Chromium's installed-PWA window (it also
//     matches an app window that was never installed, so it means "runs in an app window");
//   * `navigator.standalone === true` — iOS Safari's home-screen app (desktop WebKit has the
//     property too, set to `false`, so only the value counts);
//   * a `document.referrer` of `android-app://…` — a Trusted Web Activity's launch.
//
// and `browser` otherwise. Where none of the three can be read (server rendering, a worker) the
// signal is absent. The mapping is client-core's `detectOutlet`; this file only reads.

import type { OutletSignals } from "@polaris-key/client-core";

/** What the reader looks at. Every member is optional; the defaults are the page's globals. */
export interface WebOutletEnvironment {
  matchMedia?: ((query: string) => { matches: boolean }) | null;
  navigator?: { standalone?: unknown } | null;
  referrer?: string | null;
}

/** The page's own globals, read defensively (none of them exists under server rendering). */
export function pageOutletEnvironment(): WebOutletEnvironment {
  const g = globalThis as {
    matchMedia?: (query: string) => { matches: boolean };
    navigator?: { standalone?: unknown };
    document?: { referrer?: string };
  };
  return {
    matchMedia:
      typeof g.matchMedia === "function" ? g.matchMedia.bind(globalThis) : null,
    navigator: g.navigator ?? null,
    referrer:
      typeof g.document?.referrer === "string" ? g.document.referrer : null,
  };
}

/** Read the web runtime's outlet signals: `{"web.displayMode": "standalone" | "browser"}`, or
 *  nothing where the page's display cannot be read. Never throws. */
export function readOutletSignals(
  env: WebOutletEnvironment = pageOutletEnvironment(),
): OutletSignals {
  let readable = false;
  let standalone = false;
  try {
    if (typeof env.matchMedia === "function") {
      readable = true;
      if (env.matchMedia("(display-mode: standalone)").matches === true)
        standalone = true;
    }
  } catch {
    // A matchMedia that throws reads as no display information.
  }
  if (env.navigator && typeof env.navigator === "object") {
    readable = true;
    if (env.navigator.standalone === true) standalone = true;
  }
  if (typeof env.referrer === "string") {
    readable = true;
    if (env.referrer.startsWith("android-app://")) standalone = true;
  }
  return readable
    ? { "web.displayMode": standalone ? "standalone" : "browser" }
    : {};
}
