import { KEY_PATTERN } from "./model/key.js";
import { setParams } from "./router.js";

/**
 * A license key carried through sign-in (`#/?activate=<key>`: the KeyStep on-ramp and the
 * `/activate#key=…` deep link) never leaves the browser (SIGN-IN.md §3.9).
 *
 * - `returnUrl()` is the page's URL with `activate` taken out of the hash: it is what every
 *   sign-in sends as its return URL (the email start body, `return_to` on the single sign-on and
 *   provider links), so the key is never in a request, a Worker log or a flow record.
 * - Email-code sign-in finishes in this tab, so the key simply stays in the tab's URL.
 * - Single sign-on and provider sign-in navigate away: `stashCarriedKey()` keeps the key in this
 *   tab's sessionStorage first, and `restoreCarriedKey()` (run once at boot) puts it back into
 *   `#/?activate=` on return and clears it.
 */
const STORE_KEY = "pk-portal-carried-key";

function hashParams(hash: string): { path: string; params: URLSearchParams } {
  const raw = hash || "#/";
  const [path = "#/", query = ""] = raw.split("?", 2) as [string, string?];
  return { path, params: new URLSearchParams(query) };
}

/** The current URL without the carried key. */
export function returnUrl(loc: Location = window.location): string {
  const { path, params } = hashParams(loc.hash);
  if (!params.has("activate")) return loc.href;
  params.delete("activate");
  const q = params.toString();
  const hash = loc.hash ? `${path}${q ? `?${q}` : ""}` : "";
  return `${loc.origin}${loc.pathname}${loc.search}${hash}`;
}

/** Before a sign-in that navigates away: keep the carried key in this tab only. */
export function stashCarriedKey(loc: Location = window.location): void {
  const key = hashParams(loc.hash).params.get("activate");
  if (!key || !KEY_PATTERN.test(key)) return;
  try {
    window.sessionStorage.setItem(STORE_KEY, key);
  } catch {
    // Storage unavailable (private mode, blocked): the key is simply not carried.
  }
}

/** At boot: a key stashed before a navigating sign-in goes back into the hash, once. */
export function restoreCarriedKey(loc: Location = window.location): void {
  let key: string | null = null;
  try {
    key = window.sessionStorage.getItem(STORE_KEY);
    if (key !== null) window.sessionStorage.removeItem(STORE_KEY);
  } catch {
    return;
  }
  if (!key || !KEY_PATTERN.test(key)) return;
  if (hashParams(loc.hash).params.has("activate")) return;
  setParams({ activate: key });
}
