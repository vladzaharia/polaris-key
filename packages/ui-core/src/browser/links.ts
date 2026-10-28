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
