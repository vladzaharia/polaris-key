// The kit's one link validator (UI-KITS DL14): a server or integrator link is shown,
// copied, or opened only when it is HTTPS (with loopback HTTP for local sign-in). The scheme and
// host rule is `isSecureTransportUrl`, the same one the browser adapter holds its `baseUrl` to.

import { isSecureTransportUrl } from "./sdk/core/types.js";
import { openUrl } from "./sdk/core/signIn.js";

/** The link as a normalized string when it is safe to show and open, else `null`. */
export function safeLink(value: string | null | undefined): string | null {
  if (!value || !isSecureTransportUrl(value)) return null;
  const url = new URL(value);
  return url.username || url.password ? null : url.href;
}

/** Open a validated link: through the desktop bridge's `openExternal` when the host has one,
 *  else in a new tab. Only ever called from a click. */
export function openLink(href: string): void {
  void openUrl(href);
}

// ── A tab opened inside the click (popup blockers) ───────────────────────────────────────────
// A sign-in's address is known only after a request, and a tab opened after that is no longer
// inside the press, so a blocker may stop it. The press arms a blank tab first; the sign-in
// navigates it once the address is there, and falls back to `openLink` when no tab was armed.

let armed: Window | null = null;

/** Open a blank tab now. Call it synchronously from the press that starts a sign-in. A desktop
 *  host with a bridge opens the system browser itself, so nothing is armed there. */
export function armTab(): void {
  disarmTab();
  if (typeof window === "undefined" || typeof window.open !== "function")
    return;
  if (
    typeof (window as { polarisKey?: { openExternal?: unknown } }).polarisKey
      ?.openExternal === "function"
  )
    return;
  try {
    const w = window.open("about:blank", "_blank");
    if (!w) return;
    w.opener = null;
    armed = w;
  } catch {
    armed = null;
  }
}

/** Let the armed tab go: the sign-in did not start, or was cancelled. */
export function disarmTab(): void {
  const w = armed;
  armed = null;
  try {
    w?.close();
  } catch {
    // Already gone.
  }
}

/** Open `href` in the armed tab, or in a new one when none was armed (or it was closed). */
export function openArmed(href: string): Promise<boolean> {
  const w = armed;
  armed = null;
  if (w && !w.closed && safeLink(href)) {
    try {
      w.location.href = href;
      return Promise.resolve(true);
    } catch {
      // Fall through to a new tab.
    }
  }
  return openUrl(href);
}
