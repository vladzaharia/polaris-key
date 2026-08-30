/**
 * The ONE `return_to` validator (A3-04).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * "Where may a completed sign-in land the browser?" was answered four times: the product OIDC
 * flow (`services/identity/oidc.ts`), its portal twin (`services/identity/portal/auth.ts`), the
 * admin console (`admin/auth.ts`) and — through that last one — the gated docs site. Three were
 * textually near-identical and one was strictly weaker: the product copy checked the ORIGIN and
 * nothing else, so it happily parked a product sign-in on `/manage/…`, which the portal copy
 * refused by name. An open-redirect rule that four files each state slightly differently is a
 * rule that holds wherever somebody last remembered it.
 *
 * The realms genuinely differ in what they must PERMIT, so the shared thing is the policy
 * engine, not one frozen answer:
 *
 *   - the product and portal flows return to a page inside a single-page app, so a same-origin
 *     ABSOLUTE URL with its query and fragment intact is a legitimate target
 *     (`window.location.href` is literally what the React SDK and the portal SPA send);
 *   - the admin/docs realm returns to a bare PATH under `/manage` or `/docs`, so it affords a
 *     conservative charset and no query or fragment at all.
 *
 * Every check that costs no realm a legitimate target applies to BOTH: a length bound; no
 * whitespace, control character or backslash anywhere in the raw value (header splitting, and
 * `\`-as-`/` browser quirks); same-origin only; and no `//` or `.`/`..` path segment — tested
 * against the path the caller LITERALLY wrote, against the parser's normalised form, and
 * against the percent-decoded form of each, so neither `..` nor `%2e%2e` can walk out of an
 * allowed prefix and neither can hide behind the WHATWG parser having already collapsed it.
 */

const RETURN_TO_MAX_LENGTH = 512;

/** Whitespace, C0/C1 controls and `\`. None appears in a legitimate target, and each is a
 *  header-splitting or path-confusion primitive somewhere. */
const FORBIDDEN_RAW = /[\s\\\u0000-\u001f\u007f-\u009f]/;

/** The conservative charset the PATH form keeps — no `%`, `?`, `#`, `:` or `@`. */
const SAFE_PATH_CHARS = /^\/[A-Za-z0-9\-._~/]*$/;

/** `scheme://` at the head of a raw value. */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export interface ReturnToPolicy {
  /** Whole-segment path prefixes the value MAY start with. Omitted = any path. */
  allow?: readonly string[];
  /** Whole-segment path prefixes the value may NOT start with. */
  deny?: readonly string[];
  /**
   * `"absolute"` — a same-origin absolute URL, query and fragment preserved (the SPA realms).
   * `"path"`     — an origin-relative path, conservative charset, no query or fragment.
   */
  form: "absolute" | "path";
}

/** Does `path` sit under `prefix` as a WHOLE segment? `/docsevil` is not under `/docs`. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The path the caller LITERALLY wrote, before `new URL()` collapses dot segments.
 *
 * Checking only the parsed `pathname` would be checking the wrong string: the WHATWG parser
 * resolves `/docs/../manage/api` to `/manage/api` — a path that then satisfies an allowlist the
 * input never did. The traversal rules therefore run on this value as well.
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

/** Traversal / empty-segment rules, applied to a path AND to its percent-decoded form. */
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
    if (candidate.split("/").some((seg) => seg === "." || seg === "..")) {
      return false;
    }
  }
  return true;
}

/**
 * Validate a caller-supplied `return_to`, or return `null`.
 *
 * `origin` is the origin of the request being answered — the only origin any realm may land on.
 */
export function safeReturnTo(
  origin: string,
  raw: string | null | undefined,
  policy: ReturnToPolicy,
): string | null {
  if (!raw) return null;
  if (raw.length > RETURN_TO_MAX_LENGTH) return null;
  if (FORBIDDEN_RAW.test(raw)) return null;
  if (!pathShapeOk(literalPath(raw))) return null;

  let parsed: URL;
  try {
    // A base is supplied so a relative path is a legal input in either form; anything that
    // resolves off-origin — `//evil.test/x` included, and every non-http scheme, whose origin
    // is the string `"null"` — fails the equality below.
    parsed = new URL(raw, origin);
  } catch {
    return null;
  }
  if (parsed.origin !== origin) return null;
  if (!pathShapeOk(parsed.pathname)) return null;

  const path = parsed.pathname;
  if (policy.allow && !policy.allow.some((p) => underPrefix(path, p))) {
    return null;
  }
  if (policy.deny?.some((p) => underPrefix(path, p))) return null;

  if (policy.form === "path") {
    if (parsed.search || parsed.hash) return null;
    if (!SAFE_PATH_CHARS.test(path)) return null;
    return path;
  }
  return parsed.toString();
}

/**
 * `/manage` is not a sign-in destination for a CUSTOMER-facing flow.
 *
 * The portal copy of the old validator excluded it by name and the product copy did not, which
 * is the whole of A3-04's severity: a product sign-in could be aimed at the admin console, whose
 * landing page is the one surface that reads an operator's session. Both customer realms refuse
 * it now; the admin realm reaches `/manage` through its own allowlist instead.
 */
export const CUSTOMER_RETURN_TO_DENY = ["/manage"] as const;

/** The product/portal realm: a same-origin absolute URL that is not under `/manage`. */
export function safeReturnUrl(
  req: Request,
  raw: string | null | undefined,
): string | undefined {
  let origin: string;
  try {
    origin = new URL(req.url).origin;
  } catch {
    return undefined;
  }
  return (
    safeReturnTo(origin, raw, {
      deny: CUSTOMER_RETURN_TO_DENY,
      form: "absolute",
    }) ?? undefined
  );
}

/** The admin/docs realm: a bare path under `/manage` or `/docs`, nothing else. */
export const ADMIN_RETURN_TO_ALLOW = ["/docs", "/manage"] as const;

export function sanitizeReturnTo(raw: string | null): string | null {
  // The admin console and the gated docs site are the same host by construction, so a
  // placeholder origin is enough to drive the shared engine: only the PATH survives into the
  // response, and an input naming any other origin is refused before that.
  return safeReturnTo("https://return-to.invalid", raw, {
    allow: ADMIN_RETURN_TO_ALLOW,
    form: "path",
  });
}
