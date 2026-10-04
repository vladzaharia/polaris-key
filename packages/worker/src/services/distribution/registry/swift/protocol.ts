/**
 * The Swift package registry's wire conventions (F-06; SwiftPM `Registry.md` §3, SE-0292):
 * the API version header, `Accept` negotiation, problem details and the package identity rules.
 * Pure functions, so the routes, the renderer and the tests share one reading of the spec.
 *
 *   - `Content-Version: 1` on every answer (§3.5), not-found and refusals included;
 *   - `Accept` (§3.5): a request may name `application/vnd.swift.registry[.v<n>][+json|zip|swift]`.
 *     An unknown or invalid version (or media type) is 400; a valid but unsupported version, or a
 *     media type the endpoint does not serve, is 415. A request naming no registry type at all
 *     (curl's `*\/*`, no header) is served as version 1, which §3.5 allows;
 *   - every error is an RFC 7807 problem document (`application/problem+json`, §3.3), never cached.
 */

/** The one API version this registry speaks. */
export const SWIFT_API_VERSION = "1";

/** The media types of `Registry.md` §3.5, by endpoint kind. */
export type SwiftMediaType = "json" | "zip" | "swift";

const MEDIA_TYPES: ReadonlySet<string> = new Set(["json", "zip", "swift"]);

/** `Content-Version` and `Content-Language`, as every problem document carries them. */
const PROBLEM_HEADERS = {
  "content-type": "application/problem+json",
  "content-version": SWIFT_API_VERSION,
  "content-language": "en",
  "cache-control": "no-store",
} as const;

/** An RFC 7807 problem answer (`Registry.md` §3.3), `no-store`. */
export function swiftProblem(
  status: number,
  detail: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { ...PROBLEM_HEADERS, ...headers },
  });
}

/**
 * The refusal for `req`'s `Accept` on an endpoint serving `want`, or `null` when the request may
 * proceed. Only media ranges naming the registry's own type are judged; a request may list other
 * ranges beside them, and one acceptable registry range is enough.
 */
export function swiftAcceptRefusal(
  req: Request,
  want: SwiftMediaType,
): Response | null {
  const header = req.headers.get("accept");
  if (header === null) return null;
  let sawRegistry = false;
  let worst: 400 | 415 | null = null;
  for (const part of header.split(",")) {
    const range = (part.split(";")[0] ?? "").trim().toLowerCase();
    if (!range.startsWith("application/vnd.swift.registry")) continue;
    sawRegistry = true;
    const m =
      /^application\/vnd\.swift\.registry(?:\.v([^+]*))?(?:\+(.*))?$/.exec(
        range,
      );
    if (!m) {
      worst = 400;
      continue;
    }
    const [, version, media] = m;
    if (version !== undefined && !/^[0-9]+$/.test(version)) {
      worst = 400;
      continue;
    }
    if (media !== undefined && !MEDIA_TYPES.has(media)) {
      worst = 400;
      continue;
    }
    if (
      version !== undefined &&
      Number(version) !== Number(SWIFT_API_VERSION)
    ) {
      if (worst === null) worst = 415;
      continue;
    }
    // No media type means the default (json); §4.5's own example sends `…registry.v1` to a JSON
    // endpoint. A media type the endpoint does not serve is unsupported, not invalid.
    if (media !== undefined && media !== want) {
      if (worst === null) worst = 415;
      continue;
    }
    return null;
  }
  if (!sawRegistry || worst === null) return null;
  return worst === 400
    ? swiftProblem(400, "invalid API version")
    : swiftProblem(415, "unsupported API version");
}

/** The answer `res` with `Content-Version: 1` set (a 304 or a cached copy included). */
export function withContentVersion(res: Response): Response {
  if (res.headers.get("content-version") === SWIFT_API_VERSION) return res;
  const headers = new Headers(res.headers);
  headers.set("content-version", SWIFT_API_VERSION);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// ── Package identity (`Registry.md` §3.6) ────────────────────────────────────────────────────

/** §3.6.1: 1-39 of `[A-Za-z0-9-]`, no leading, trailing or doubled hyphen. */
export const SWIFT_SCOPE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
/** §3.6.2: 1-100 of `[A-Za-z0-9_-]`, no leading, trailing or doubled `-`/`_`. */
export const SWIFT_NAME =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|[-_](?=[a-zA-Z0-9])){0,99}$/;
/** A version path segment: the semver alphabet (`descriptor.ts` refuses anything else at ingest). */
export const SWIFT_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;

/** The case-insensitive identity of `scope.name` (§3.6), as `release_packages.name_norm` holds it. */
export function swiftIdentity(scope: string, name: string): string {
  return `${scope}.${name}`.toLowerCase();
}

/**
 * A repository URL reduced to what identifies it, for `/identifiers?url=` (§4.5): no scheme or
 * `user@`, the scp-like `host:path` folded to `host/path`, no trailing `/` or `.git`, lower case.
 * `https://github.com/Mona/LinkedList.git`, `git@github.com:mona/linkedlist` and
 * `ssh://git@github.com/mona/LinkedList/` are all `github.com/mona/linkedlist`.
 */
export function normaliseRepositoryUrl(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (s === "" || s.length > 2048) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^[^@/]*@/, "");
  // scp-like `host:path` (no scheme was present, and the colon is not a port).
  s = s.replace(/^([^/:]+):(?!\d+(?:\/|$))/, "$1/");
  s = s
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return s === "" ? null : s;
}
