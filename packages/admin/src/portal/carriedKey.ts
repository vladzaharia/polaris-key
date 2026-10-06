import { KEY_PATTERN } from "./model/key.js";
import { carriesKey } from "./model/returnUrl.js";
import { setParams } from "./router.js";

/**
 * A license key carried through sign-in (`#/?activate=<key>`: the KeyStep on-ramp and the
 * `/activate#key=…` deep link) never leaves the browser (SIGN-IN.md §3.9).
 *
 * - `returnUrl()` is the page's URL with the key taken out of the hash (`activate=` stays, empty,
 *   so the modal still opens on return, with the link's `product=`/`next=`/`return=`; PX-17),
 *   and with every other parameter that carries a key dropped, in the hash or the query, however
 *   it got there (`carriesKey`). It is what every sign-in sends as its return URL (the email
 *   start body, `return_to` on the single sign-on and provider links), so the key is never in a
 *   request, a Worker log or a flow record.
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

/**
 * Empty `activate` and drop every other parameter whose name or value carries a key. Returns
 * whether anything changed.
 */
function stripKeys(params: URLSearchParams): boolean {
  let changed = false;
  for (const [name, value] of [...params]) {
    if (name === "activate") {
      if (value !== "") {
        params.set("activate", "");
        changed = true;
      }
    } else if (carriesKey(name) || carriesKey(value)) {
      params.delete(name);
      changed = true;
    }
  }
  return changed;
}

/** The current URL without the carried key (an empty `activate=` keeps the modal's place). */
export function returnUrl(loc: Location = window.location): string {
  const { path, params } = hashParams(loc.hash);
  const search = new URLSearchParams(loc.search);
  const pathKey = carriesKey(loc.pathname);
  const hashPathKey = carriesKey(path);
  const searchChanged = stripKeys(search);
  const hashChanged = stripKeys(params);
  if (!pathKey && !hashPathKey && !searchChanged && !hashChanged)
    return loc.href;
  const q = params.toString();
  const hash = loc.hash
    ? `${hashPathKey ? "#/" : path}${q ? `?${q}` : ""}`
    : "";
  const s = search.toString();
  return `${loc.origin}${pathKey ? "/" : loc.pathname}${s ? `?${s}` : ""}${hash}`;
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
  // A key already in the hash wins; an empty `activate=` (the return URL's) takes this one.
  if (hashParams(loc.hash).params.get("activate")) return;
  setParams({ activate: key });
}
