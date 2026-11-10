// The one check a Cloud Sync sign-in URL passes before it reaches app code. The rule is the same in
// every SDK and pinned by the corpus's `signInUrlCases` (tools/sync-scenarios.ts), which each
// runner replays; it uses no URL library, so no parser's quirks can differ between languages.

/** Any character outside 0x21..0x7E (control, space, DEL, C1, non-ASCII), and the backslash a
 *  browser reads as a slash. */
const FORBIDDEN = /[^\x21-\x7e]|\\/;

/** `https://host[:port]` as `[host, port]` (lower-case host, port 443 when none), else null. */
function parseOrigin(origin: string): [string, string] | null {
  const m = /^https:\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(
    origin.toLowerCase(),
  );
  return m === null ? null : [m[1]!, String(Number(m[2] ?? "443"))];
}

/**
 * A sign-in URL fit to hand to the app: https on the Worker's `origin` (`https://host[:port]`),
 * normalised, else null. `https://` or `//` start an authority that must be exactly the Worker's
 * host (and port; 443 is the default); any other `scheme:`, userinfo, a trailing dot, a lookalike
 * host, a backslash, whitespace or a control or non-ASCII character answers null. Anything else is
 * a path on the origin. There is no path restriction.
 */
export function safeSignInUrl(
  url: string | null,
  origin: string | undefined,
): string | null {
  if (typeof url !== "string" || url === "" || origin === undefined)
    return null;
  if (FORBIDDEN.test(url)) return null;
  const base = parseOrigin(origin);
  if (base === null) return null;
  const [host, port] = base;
  let tail: string;
  const rest = /^https:\/\//i.test(url)
    ? url.slice(8)
    : url.startsWith("//")
      ? url.slice(2)
      : null;
  if (rest !== null) {
    const end = rest.search(/[/?#]/);
    const authority = (end < 0 ? rest : rest.slice(0, end)).toLowerCase();
    const allowed =
      port === "443" ? [host, `${host}:443`] : [`${host}:${port}`];
    if (!allowed.includes(authority)) return null;
    tail = end < 0 ? "" : rest.slice(end);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) {
    return null;
  } else {
    tail = url;
  }
  return `https://${host}${port === "443" ? "" : `:${port}`}${
    tail.startsWith("/") ? tail : `/${tail}`
  }`;
}
