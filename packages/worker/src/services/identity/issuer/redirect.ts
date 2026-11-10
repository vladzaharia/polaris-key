/**
 * Redirect URI matching and building for registered clients (I-21.6; V5 §12.13.2; threat IS-3).
 *
 * A presented `redirect_uri` or `post_logout_redirect_uri` matches only by string equality with a
 * registered one: no case folding, percent-decoding, default port or trailing slash (RFC 9700
 * §4.1.3). The one exception is the loopback port (RFC 8252 §7.3): a presented
 * `http://127.0.0.1:<port>/<path>` or `http://[::1]:<port>/<path>` with an explicit port 1 to
 * 65535 and no leading zero matches a registered loopback URI once that port is removed. A
 * presented `localhost`, fragment or userinfo URI matches nothing, because no registered URI holds
 * one. Matching never parses the presented string into something else first, so a URL-parser
 * quirk cannot make two different strings equal.
 *
 * Every redirect built here appends to the REGISTERED string (the match), never to anything else
 * the request sent, and joins a registered query with `&`.
 */

import type { RegisteredClientType } from "@polaris-key/protocol/identity";
import { constantTimeEqual } from "../../../platform/compare.js";

const LOOPBACK_WITH_PORT =
  /^(http:\/\/(?:127\.0\.0\.1|\[::1\])):([1-9][0-9]{0,4})(\/[^\s#]*)$/;

/**
 * The registered URI `presented` matches, or `null`. `type` is the client's: a loopback port is
 * free only for a `native` client.
 */
export function matchRedirectUri(
  registered: readonly string[],
  presented: string,
  type: RegisteredClientType,
): string | null {
  if (presented === "" || presented.length > 2048) return null;
  for (const r of registered) if (constantTimeEqual(r, presented)) return r;
  if (type !== "native") return null;
  const m = LOOPBACK_WITH_PORT.exec(presented);
  if (!m || Number(m[2]) > 65_535) return null;
  const withoutPort = `${m[1]}${m[3]}`;
  for (const r of registered)
    if (constantTimeEqual(r, withoutPort)) return presented;
  return null;
}

/**
 * `uri` with `params` appended as a query: `?` or, onto a registered query, `&`. The registered
 * string is kept byte for byte. A fragment never appears (registered URIs hold none), so nothing
 * is delivered in one.
 */
export function withQuery(
  uri: string,
  params: Readonly<Record<string, string>>,
): string {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${uri}${uri.includes("?") ? "&" : "?"}${query}`;
}
