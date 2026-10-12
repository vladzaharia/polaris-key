/**
 * The one check behind every sign-in flow's `returnTo`: where may the browser be sent after a
 * successful sign-in without this being an open redirect?
 *
 * ONE implementation (P0-15). The three copies it replaced agreed on the core rule (the target
 * must be same-origin with the request) but not on three details, and each detail is reachable
 * from a crafted link, so each caller names the policy it had instead of inheriting a merged
 * one. There is deliberately no default policy: a new flow has to choose.
 *
 * The console is never a customer's return target: the product and portal sign-ins both refuse a
 * path under `/manage`, so no customer-facing flow can be aimed at the admin console's landing
 * page.
 *
 * Every policy also refuses, before anything is parsed, a value that is over-long, carries
 * whitespace, a control character or a backslash, or names a path with an empty or `.`/`..`
 * segment, whether written plainly or percent-encoded. The WHATWG parser would strip, rewrite or
 * collapse most of those silently, so the value that was checked would not be the value the
 * caller wrote, and a consumer that decodes the stored target (`%2F%2Fevil.example`) would read a
 * different path than the one that was checked.
 *
 * A leaf module: it imports nothing else in `src/`.
 */

export interface ReturnToPolicy {
  /** Resolve a relative value against the request URL; otherwise only an absolute URL is read. */
  readonly relative: boolean;
  /** Refuse any path under `/manage`: the console is never a customer's return target. */
  readonly refuseConsole: boolean;
  /** Answer path + query + fragment instead of the absolute URL. */
  readonly pathOnly: boolean;
}

/** Product OIDC sign-in (`services/identity/oidc.ts`): an absolute same-origin URL, never under `/manage`. */
export const PRODUCT_SIGNIN_RETURN_TO: ReturnToPolicy = {
  relative: false,
  refuseConsole: true,
  pathOnly: false,
};

/** Portal and hosted-provider sign-in: an absolute same-origin URL, never under `/manage`. */
export const PORTAL_SIGNIN_RETURN_TO: ReturnToPolicy = {
  relative: false,
  refuseConsole: true,
  pathOnly: false,
};

/** Sign-in card (email, passkey): absolute or relative, outside the console, as a path. */
export const CARD_RETURN_TO: ReturnToPolicy = {
  relative: true,
  refuseConsole: true,
  pathOnly: true,
};

/**
 * The longest raw value any policy takes. A return target is a page of an app, not a payload; the
 * bound keeps an untrusted query value from becoming a long-lived flow record and redirect.
 */
const RETURN_TO_MAX_LENGTH = 512;

/**
 * Whitespace, C0/C1 controls and `\`. None appears in a legitimate target, and each is a
 * header-splitting or path-confusion primitive somewhere (a browser reads `\` as `/`).
 */
const FORBIDDEN_RAW = /[\s\\\u0000-\u001f\u007f-\u009f]/;

/** `scheme://` at the head of a raw value. */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * The path the caller LITERALLY wrote, before `new URL()` collapses dot segments.
 *
 * Checking only the parsed `pathname` would be checking the wrong string: the parser resolves
 * `/docs/../manage/api` to `/manage/api`, a path that then satisfies a rule the input never did.
 * The traversal rules therefore run on this value as well.
 */
function literalPath(raw: string): string {
  let rest = raw;
  const scheme = raw.match(SCHEME_PREFIX);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    rest = slash === -1 ? "/" : rest.slice(slash);
  } else if (rest.startsWith("//")) {
    // Protocol-relative. The same-origin check refuses it; the path is still read honestly.
    const slash = rest.indexOf("/", 2);
    rest = slash === -1 ? "/" : rest.slice(slash);
  }
  const cut = rest.search(/[?#]/);
  return cut === -1 ? rest : rest.slice(0, cut);
}

/** Traversal and empty-segment rules, applied to a path AND to its percent-decoded form. */
function pathShapeOk(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is not a path we can reason about.
    return false;
  }
  for (const candidate of [pathname, decoded]) {
    if (!candidate.startsWith("/")) return false;
    if (candidate.includes("//")) return false;
    if (candidate.includes("\\")) return false;
    if (candidate.split("/").some((seg) => seg === "." || seg === ".."))
      return false;
  }
  return true;
}

/** A permitted return target for `raw` under `policy`, or `undefined` to fall back. */
export function safeReturnTo(
  req: Request,
  raw: unknown,
  policy: ReturnToPolicy,
): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (raw.length > RETURN_TO_MAX_LENGTH) return undefined;
  if (FORBIDDEN_RAW.test(raw)) return undefined;
  if (!pathShapeOk(literalPath(raw))) return undefined;
  try {
    const parsed = policy.relative ? new URL(raw, req.url) : new URL(raw);
    const here = new URL(req.url);
    if (parsed.origin !== here.origin) return undefined;
    if (!pathShapeOk(parsed.pathname)) return undefined;
    if (policy.refuseConsole && parsed.pathname.startsWith("/manage"))
      return undefined;
    if (!policy.pathOnly) return parsed.toString();
    // A path that starts `//` or `/\` is protocol-relative once it is a Location
    // (`https://here//evil.com` parses same-origin, its path `//evil.com` does not stay local).
    const path = parsed.pathname + parsed.search + parsed.hash;
    return /^\/(?![/\\])/.test(path) ? path : undefined;
  } catch {
    return undefined;
  }
}
