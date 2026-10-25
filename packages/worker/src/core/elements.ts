/**
 * The Elements CDN module (UK-04b; UI-KITS §5.3): the built `@polaris-key/elements` bundle,
 * served at `/elements/<version>/<file>` so a page can write
 * `<script type="module" src="https://key.plrs.im/elements/1/pk.js">`.
 *
 * ── WHAT IS SERVED ──────────────────────────────────────────────────────────────────────────
 *
 * Only files the build produced. `scripts/assemble-assets.mjs` runs the package's `bundle:cdn`
 * into `assets/elements/`, so the tree holds, per build:
 *
 *   - `<exact version>/pk.js`, `chunks/*.js` (content-hashed names), `fonts/*`, `integrity.json`
 *     (the sha384 of every file): the bytes of one release, **immutable** for that URL;
 *   - `<major>/pk.js`, a one-line shim, `export * from "../<exact version>/pk.js"`, plus its own
 *     `integrity.json`. The shim is the floating URL; everything it loads is under the exact
 *     version, so a cached shim never meets a chunk that a later deploy removed.
 *
 * The segment after `/elements/` is a bare major (`1`) or an exact version (`1.4.2`,
 * `1.4.2-beta.3`). Nothing else matches: no traversal, no dot-files, no extension outside
 * {@link CONTENT_TYPES}. The Worker reads the file from the ASSETS binding at the same path;
 * what is not in the tree is a 404, never a fallback to the nearest version.
 *
 * An unstamped `0.0.0` (a local or CI build; `bundle-cdn.mjs` refuses it under CI unless the job
 * opts in, and deploy.yml stamps the tag's version) is served `no-cache`, never immutable.
 * A prerelease deploy (`PKEY_ELEMENTS_FLOAT=0`) writes no major shim, so the major URL does not
 * move to a prerelease: it answers 404 until a stable deploy.
 *
 * ── HEADERS ─────────────────────────────────────────────────────────────────────────────────
 *
 *   - exact version: `public, max-age=31536000, immutable`; a release's bytes never change, so
 *     the integrity hash an integrator pins never goes stale;
 *   - major: `public, max-age=300`: a new release reaches pages within minutes, and a page that
 *     needs fixed bytes pins the exact version instead (an `integrity` attribute is only
 *     meaningful there);
 *   - `Content-Type` from the extension (a module script needs a JavaScript MIME type), with
 *     `X-Content-Type-Options: nosniff` so a browser never reinterprets it;
 *   - `Access-Control-Allow-Origin: *`, no credentials: a module script (and any script with an
 *     `integrity` attribute) is fetched in CORS mode. The files are public bytes any client can
 *     already fetch; `*` never combines with cookies, and the answer carries no `Vary`
 *     dependence on the caller. `Cross-Origin-Resource-Policy: cross-origin` lets a page that
 *     is cross-origin isolated embed it.
 *
 * This route shares the console's origin, and so its cookie. It sets no cookie, reads no
 * session and touches no database; a `Set-Cookie` the assets layer might add is dropped.
 * THREAT-MODEL.md, "The Elements CDN module", covers cache poisoning, pinning and what a
 * compromised module could do.
 */

import type { Env } from "../platform/env.js";
import { isSafeAssetPath } from "../platform/http.js";
import { methodNotAllowed, notFound } from "./errors.js";

/** The path prefix, no trailing slash. */
export const ELEMENTS_PREFIX = "/elements";

/** `max-age` for the floating major URL, in seconds. */
export const ELEMENTS_MAJOR_MAX_AGE = 300;

/** Cache-Control of a file under an exact version. */
export const ELEMENTS_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/** Cache-Control of the unstamped `0.0.0` build (a local or CI build): never cached as immutable. */
export const ELEMENTS_UNSTAMPED_CACHE = "no-cache";

/** The file types the bundle contains, and the type each is served as. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

const MAJOR = /^[0-9]{1,4}$/;
const EXACT = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,40})?$/;
const FILE =
  /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

export interface ElementsPath {
  /** The URL segment: a major (`1`) or an exact version (`1.4.2`). */
  version: string;
  exact: boolean;
  /** The file under it, e.g. `pk.js` or `chunks/en-LCI2QGKD.js`. */
  file: string;
  /** The extension, lower case, one of {@link CONTENT_TYPES}. */
  ext: string;
}

/** Parse `/elements/<version>/<file>`; `null` for anything this route does not serve. */
export function parseElementsPath(pathname: string): ElementsPath | null {
  if (!pathname.startsWith(`${ELEMENTS_PREFIX}/`)) return null;
  const rest = pathname.slice(ELEMENTS_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const version = rest.slice(0, slash);
  const file = rest.slice(slash + 1);
  const exact = EXACT.test(version);
  if (!exact && !MAJOR.test(version)) return null;
  if (!FILE.test(file) || !isSafeAssetPath(`/${file}`)) return null;
  const dot = file.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.slice(dot + 1).toLowerCase();
  if (!Object.hasOwn(CONTENT_TYPES, ext)) return null;
  return { version, exact, file, ext };
}

/** Headers every answer carries, success or not (the CORS and sniffing story). */
function baseHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
    "x-content-type-options": "nosniff",
  });
}

/** `If-None-Match` against one ETag: `*`, or any listed tag (weak comparison). */
function ifNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return (
    header.trim() === "*" ||
    header.split(",").some((t) => strip(t) === strip(etag))
  );
}

export async function handleElements(
  req: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    const headers = baseHeaders();
    headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    headers.set("access-control-max-age", "86400");
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();

  const parsed = parseElementsPath(url.pathname);
  const missing = (): Response => {
    const res = notFound();
    const headers = new Headers(res.headers);
    for (const [k, v] of baseHeaders()) headers.set(k, v);
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: 404, headers });
  };
  if (!parsed || !env.ASSETS) return missing();

  const asset = new URL(url);
  asset.search = "";
  asset.pathname = `${ELEMENTS_PREFIX}/${parsed.version}/${parsed.file}`;
  const res = await env.ASSETS.fetch(
    new Request(asset, { method: "GET", headers: {} }),
  );
  // The assets layer answers a missing file with 404 (html_handling = "none"); anything but a
  // whole 200 is not served, and never cached.
  if (res.status !== 200) return missing();

  const headers = baseHeaders();
  const etag = res.headers.get("etag");
  if (etag) headers.set("etag", etag);
  headers.set("content-type", CONTENT_TYPES[parsed.ext]!);
  headers.set(
    "cache-control",
    parsed.version === "0.0.0"
      ? ELEMENTS_UNSTAMPED_CACHE
      : parsed.exact
        ? ELEMENTS_IMMUTABLE_CACHE
        : `public, max-age=${ELEMENTS_MAJOR_MAX_AGE}`,
  );
  // A conditional request the asset still satisfies is a 304 (the ETag is the assets layer's).
  if (etag && ifNoneMatch(req.headers.get("if-none-match"), etag))
    return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : res.body, {
    status: 200,
    headers,
  });
}
