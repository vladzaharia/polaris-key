// Refusal links (PX-W8, WIRE-CONTRACT-V4 §5.3): the `manageUrl` the Worker puts on the
// `device_limit` (and, with Identity, `key_entry_limit`) refusal, and the two things a client
// may add to it.
//
// Pure functions: no I/O, no signing, no change to any error type. The link is never an auth
// failure, so nothing here wipes state or asks for a retry; a host opens it only behind a user
// action ("Free up a device").

import { MANAGE_URL_MAX_LENGTH } from "@polaris-key/protocol/license";

export { MANAGE_URL_MAX_LENGTH };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseManage(raw: string): URL | null {
  if (raw.length === 0 || raw.length > MANAGE_URL_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

/** Is `raw` a link a client may show: an absolute `https:` URL (or `http:` to a loopback host,
 *  for local development), with no userinfo, at most `MANAGE_URL_MAX_LENGTH` characters? */
export function isManageUrl(raw: unknown): raw is string {
  return typeof raw === "string" && parseManage(raw) !== null;
}

/**
 * The `manageUrl` of a refusal body, or `undefined`.
 *
 * Reads the top-level member (the flat refusal bodies) and, failing that, one nested under
 * `error` (an `{ error: { code, … } }` envelope). Anything that is not a valid link — a
 * `javascript:` URL, userinfo, an overlong value, a non-string — is dropped, never repaired.
 */
export function readManageUrl(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const top = (body as Record<string, unknown>).manageUrl;
  if (isManageUrl(top)) return top;
  const nested = (body as Record<string, unknown>).error;
  if (nested !== null && typeof nested === "object") {
    const inner = (nested as Record<string, unknown>).manageUrl;
    if (isManageUrl(inner)) return inner;
  }
  return undefined;
}

/**
 * The `application/x-www-form-urlencoded` byte serializer (WHATWG URL §5.2): UTF-8, then
 * `A-Z a-z 0-9 * - . _` as themselves, space as `+`, every other byte as `%XX` (upper-case).
 * Every SDK spells this the same way, so the links they build are byte-identical.
 */
export function manageFormEncode(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9*\-._]/.test(c)) out += c;
    else if (byte === 0x20) out += "+";
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** `path?query` with every earlier `name` pair dropped and `name=value` appended; the other
 *  pairs are kept byte-for-byte, never re-serialized. */
function appendParam(target: string, name: string, encoded: string): string {
  const q = target.indexOf("?");
  const path = q === -1 ? target : target.slice(0, q);
  const pairs = (q === -1 ? "" : target.slice(q + 1))
    .split("&")
    .filter((p) => p !== "" && p !== name && !p.startsWith(`${name}=`));
  pairs.push(`${name}=${encoded}`);
  return `${path}?${pairs.join("&")}`;
}

function splitFragment(url: string): { base: string; fragment: string | null } {
  const h = url.indexOf("#");
  return h === -1
    ? { base: url, fragment: null }
    : { base: url.slice(0, h), fragment: url.slice(h + 1) };
}

/**
 * Add the app's return URL as `return=`. When the fragment holds a portal route (`#/…`), the
 * parameter joins the query inside the fragment; otherwise it joins the URL's query. Any
 * earlier `return` is replaced and every other byte of the link is kept. The portal accepts it
 * only against the product's declared return targets, so an undeclared one is ignored there,
 * not here. Returns `url` unchanged when it is not a valid link or `returnUrl` is empty.
 */
export function withManageReturn(url: string, returnUrl: string): string {
  if (!parseManage(url) || returnUrl === "") return url;
  const encoded = manageFormEncode(returnUrl);
  const { base, fragment } = splitFragment(url);
  if (fragment !== null && fragment.startsWith("/"))
    return `${base}#${appendParam(fragment, "return", encoded)}`;
  const withQuery = appendParam(base, "return", encoded);
  return fragment === null ? withQuery : `${withQuery}#${fragment}`;
}

/**
 * Add the licence key as the fragment `#key=<key>` on an `/activate` link, so the portal can
 * fill its Activate field. A fragment never reaches a server or a log. A link that is not an
 * `/activate` link (the free-device route), or an invalid one, is returned unchanged: the key is
 * never put anywhere else.
 */
export function withManageKey(url: string, key: string): string {
  const parsed = parseManage(url);
  if (!parsed || key === "") return url;
  if (parsed.pathname.replace(/\/+$/, "") !== "/activate") return url;
  const { base, fragment } = splitFragment(url);
  if (fragment !== null && fragment.startsWith("/")) return url;
  return `${base}#key=${manageFormEncode(key)}`;
}
