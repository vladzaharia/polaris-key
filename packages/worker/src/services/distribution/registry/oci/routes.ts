/// <reference types="@cloudflare/workers-types" />
/**
 * The OCI feed's pull routes on the registry host (F-08, plans/F-01.md §6.2, §6.7 and §6.8), the
 * read side of the OCI Distribution Specification
 * (https://github.com/opencontainers/distribution-spec/blob/main/spec.md#pull):
 *
 *   GET/HEAD /v2/<owner>/<repository…>/manifests/<tag | sha256:…>   end-3, end-2
 *   GET/HEAD /v2/<owner>/<repository…>/blobs/<sha256:…>              end-2 (Range: 206, 416)
 *   GET/HEAD /v2/<owner>/<repository…>/tags/list[?n=&last=]          end-8a, end-8b
 *
 * `GET /v2/` is the dispatcher's own fixed answer (F-02), and `/v2/token` is the plain OCI
 * not-found until F-21 issues tokens: no route here matches it.
 *
 * EVERY READ GOES THROUGH `serveFeedRead`, so the access ladder (kill switch, `packageFeeds`,
 * the feed, the access mode) runs before any cache lookup or object read, and a refusal is
 * OCI's `NAME_UNKNOWN` or its Bearer challenge. The repository is resolved to its package
 * deliverable BEFORE the ladder (that is a D1 read, not a cache read) so the ladder can apply
 * the package's own delivery mode; an unknown repository passes `null` and is judged by the
 * feed's mode alone, then answers `NAME_UNKNOWN` like an unknown owner.
 *
 * HEADERS (§6.7): manifests by digest and blobs are immutable (`public, max-age=31536000,
 * immutable`, ETag the SHA-256); manifests by tag and tag lists are index documents (60 s with
 * `stale-while-revalidate`, ETag the body's SHA-256, which for a manifest is its digest); every
 * error is `no-store`. Every answer here also carries `Docker-Distribution-API-Version:
 * registry/2.0`, and a manifest or blob `Docker-Content-Digest`.
 *
 * Blobs skip the Cache API (`cacheApi: false`): they are up to 5 GiB, must honour `Range`, and
 * `core/blobs.ts` `blobResponse` already answers them with immutable headers, `Range`,
 * `If-Range` and `If-None-Match` straight from R2.
 */

import type {
  RegistryRoute,
  RegistryRouteContext,
} from "../../../../core/registryHost.js";
import { registryOrigin } from "../../../../core/registryHost.js";
import { blobKey, blobResponse, checksumHex } from "../../../../core/blobs.js";
import { json } from "../../../../core/errors.js";
import { registryCacheHeaders } from "../cache.js";
import {
  RENDER_STAMP_META,
  materialise,
  registryCounters,
  registryObjectKey,
  renderStamp,
  type RegistryPackage,
} from "../materialise.js";
import { feedRoute } from "../serve.js";
import {
  OCI_DIGEST_RE,
  OCI_MANIFEST_FILE_TYPES,
  OCI_MANIFEST_TYPES,
  OCI_REPOSITORY_RE,
  OCI_TAG_RE,
  ociName,
  refsKey,
  renderOci,
  tagsKey,
  type OciRef,
  type OciTagList,
} from "./render.js";
import { ociDeliverable, ociPackage } from "./source.js";

/** The distribution API version header every `/v2/` answer carries. */
export const OCI_API_VERSION = "registry/2.0";

/** The longest `<owner>/<repository>` (the reference grammar's 255-character name limit). */
const MAX_NAME = 255;

/** The most tags one `tags/list` page returns, whatever `n` asks for. */
export const MAX_TAGS_PAGE = 1000;

const MANIFESTS = /^\/v2\/([^/]+)\/(.+)\/manifests\/([^/]+)$/;
const BLOBS = /^\/v2\/([^/]+)\/(.+)\/blobs\/([^/]+)$/;
const TAGS = /^\/v2\/([^/]+)\/(.+)\/tags\/list$/;

/** An OCI error code (distribution-spec "Error Codes"). */
export type OciErrorCode =
  | "BLOB_UNKNOWN"
  | "MANIFEST_UNKNOWN"
  | "NAME_UNKNOWN"
  | "UNSUPPORTED";

const MESSAGES: Record<OciErrorCode, string> = {
  BLOB_UNKNOWN: "blob unknown to registry",
  MANIFEST_UNKNOWN: "manifest unknown",
  NAME_UNKNOWN: "repository name not known to registry",
  UNSUPPORTED: "The operation is unsupported.",
};

/** OCI's error JSON, `no-store`. */
export function ociError(status: number, code: OciErrorCode): Response {
  return json(
    { errors: [{ code, message: MESSAGES[code] }] },
    { status, headers: { "docker-distribution-api-version": OCI_API_VERSION } },
  );
}

/** The answer with the distribution API version header added. */
function withApiVersion(res: Response): Response {
  if (res.headers.get("docker-distribution-api-version") === OCI_API_VERSION)
    return res;
  const headers = new Headers(res.headers);
  headers.set("docker-distribution-api-version", OCI_API_VERSION);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** `owner`, `repository` and the last segment, when the path is one of ours and well formed. */
function matchRepository(
  re: RegExp,
  pathname: string,
): { owner: string; params: Record<string, string> } | null {
  const m = re.exec(pathname);
  if (!m) return null;
  const owner = m[1]!;
  const repository = m[2]!;
  if (!OCI_REPOSITORY_RE.test(repository)) return null;
  if (owner.length + 1 + repository.length > MAX_NAME) return null;
  return {
    owner,
    params: { repository, ...(m[3] !== undefined ? { last: m[3] } : {}) },
  };
}

type Catalog = NonNullable<
  ReturnType<RegistryRouteContext["hooks"]["releaseCatalog"]>
>;

interface Located {
  readonly catalog: Catalog;
  readonly deliverable: { id: string; name: string };
}

/** The repository's package deliverable, or `null` (Release off, or no such package). */
async function locate(ctx: RegistryRouteContext): Promise<Located | null> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  const deliverable = await ociDeliverable(catalog, ctx.params.repository!);
  return deliverable ? { catalog, deliverable } : null;
}

type Compute = (
  req: Request,
  ctx: RegistryRouteContext,
  loc: Located,
  cache: "public" | "private",
) => Promise<Response>;

/**
 * One OCI route: locate (before the ladder), then `serveFeedRead` (`feedRoute`), then the API
 * version header on whatever answered, a refusal or a cache hit included, after `check`.
 */
function ociRoute(
  name: string,
  re: RegExp,
  opts: { queryNames?: readonly string[]; cacheApi?: false },
  compute: Compute,
  check?: (res: Response, req: Request) => Promise<Response>,
): RegistryRoute {
  return feedRoute<Located | null>({
    name,
    ecosystem: "oci",
    match: (p) => matchRepository(re, p),
    resolve: (_req, ctx) => locate(ctx),
    deliverableId: (_params, loc) => loc?.deliverable.id ?? null,
    repository: (params) => params.repository!,
    ...(opts.queryNames ? { queryNames: opts.queryNames } : {}),
    ...(opts.cacheApi === false ? { cacheApi: false as const } : {}),
    serve: (req, ctx, cache, loc) =>
      loc
        ? compute(req, ctx, loc, cache)
        : Promise.resolve(ociError(404, "NAME_UNKNOWN")),
    finish: async (res, req) =>
      withApiVersion(check ? await check(res, req) : res),
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One rendered document of `pkg` (`_tags.json` or `_refs.json`): the stored object when its
 * render stamp matches D1, else rendered now and written back through the materialiser (in the
 * background when the runtime allows). Reading the stamp on every read keeps the answer right
 * even when no drain has run since the package changed (render-on-miss, extended to stale).
 */
async function renderedBody(
  ctx: RegistryRouteContext,
  pkg: RegistryPackage,
  key: string,
): Promise<string> {
  const bucket = ctx.env.BLOBS;
  const stamp = await renderStamp(pkg);
  if (bucket) {
    const stored = await bucket
      .get(registryObjectKey("oci", pkg.product, key))
      .catch(() => null);
    if (stored && stored.customMetadata?.[RENDER_STAMP_META] === stamp)
      return stored.text();
    if (stored) await stored.body.cancel().catch(() => undefined);
    else registryCounters.renderMiss++;
  }
  const body = renderOci(pkg).find((o) => o.key === key)?.body;
  if (bucket) {
    const write = materialise(
      {
        bucket,
        renderers: new Map([
          ["oci", { ecosystem: "oci", render: renderOci, routes: [] }],
        ]),
        source: { package: async () => pkg },
        origin: registryOrigin(ctx.env) ?? "https://pkg.plrs.im",
      },
      pkg.product,
      pkg.deliverableId,
    ).catch(() => undefined);
    if (ctx.waitUntil) ctx.waitUntil(write);
    else await write;
  }
  return typeof body === "string" ? body : "";
}

/**
 * Is a manifest of `type` acceptable to the client? Yes unless its `Accept` names at least one
 * manifest type, not this one, and no wildcard: the client then cannot parse what is stored, so
 * it gets `MANIFEST_UNKNOWN` (distribution's answer), never a type it did not ask for.
 */
export function acceptsManifest(req: Request, type: string): boolean {
  const accept = req.headers.get("accept");
  if (accept === null || accept.trim() === "") return true;
  const listed = accept
    .split(",")
    .map((s) => (s.split(";")[0] ?? "").trim().toLowerCase())
    .filter((s) => s !== "");
  if (listed.some((t) => t === "*/*" || t === "application/*" || t === type))
    return true;
  return !listed.some((t) => OCI_MANIFEST_TYPES.has(t));
}

// ── manifests ────────────────────────────────────────────────────────────────────────────────

/** The manifest a reference names: by digest from any version's files (yanked included, so a
 *  pinned digest keeps working), by tag from the rendered pointers. */
async function manifestTarget(
  ctx: RegistryRouteContext,
  loc: Located,
  reference: string,
): Promise<{ hex: string; ref: OciRef; byDigest: boolean } | null> {
  const digest = OCI_DIGEST_RE.exec(reference)?.[1];
  if (digest !== undefined) {
    for (const v of await loc.catalog.packageVersions(loc.deliverable.id)) {
      const file = v.files.find(
        (f) => f.sha256 === digest && OCI_MANIFEST_FILE_TYPES.has(f.type),
      );
      if (file?.mediaType && OCI_MANIFEST_TYPES.has(file.mediaType))
        return {
          hex: digest,
          ref: {
            digest: reference,
            mediaType: file.mediaType,
            size: file.size,
          },
          byDigest: true,
        };
    }
    return null;
  }
  if (!OCI_TAG_RE.test(reference)) return null;
  const pkg = await ociPackage(loc.catalog, ctx.product.slug, loc.deliverable);
  let refs: Record<string, OciRef>;
  try {
    refs = JSON.parse(
      await renderedBody(ctx, pkg, refsKey(pkg.name)),
    ) as Record<string, OciRef>;
  } catch {
    return null;
  }
  const ref = Object.prototype.hasOwnProperty.call(refs, reference)
    ? refs[reference]
    : undefined;
  const hex = ref ? OCI_DIGEST_RE.exec(ref.digest)?.[1] : undefined;
  return ref && hex !== undefined ? { hex, ref, byDigest: false } : null;
}

const serveManifest: Compute = async (req, ctx, loc, cache) => {
  const reference = ctx.params.last!;
  const bucket = ctx.env.BLOBS;
  const target = await manifestTarget(ctx, loc, reference);
  if (!target || !bucket) return ociError(404, "MANIFEST_UNKNOWN");
  const key = blobKey(target.hex);
  const obj =
    req.method === "HEAD" ? await bucket.head(key) : await bucket.get(key);
  const body = (obj as Partial<R2ObjectBody> | null)?.body ?? null;
  if (!obj || checksumHex(obj) !== target.hex) {
    await body?.cancel().catch(() => undefined);
    return ociError(404, "MANIFEST_UNKNOWN");
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": target.ref.mediaType,
      "content-length": String(obj.size),
      "docker-content-digest": `sha256:${target.hex}`,
      ...registryCacheHeaders(
        cache,
        target.byDigest ? "immutable" : "index",
        target.hex,
      ),
    },
  });
};

/** A cached or fresh manifest the client's `Accept` cannot take is `MANIFEST_UNKNOWN`. */
async function checkManifestAccept(
  res: Response,
  req: Request,
): Promise<Response> {
  if (res.status === 200) {
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!acceptsManifest(req, type)) {
      await res.body?.cancel().catch(() => undefined);
      return ociError(404, "MANIFEST_UNKNOWN");
    }
  }
  return res;
}

// ── blobs ────────────────────────────────────────────────────────────────────────────────────

const serveBlob: Compute = async (req, ctx, loc, cache) => {
  const hex = OCI_DIGEST_RE.exec(ctx.params.last!)?.[1];
  const bucket = ctx.env.BLOBS;
  if (hex === undefined || !bucket) return ociError(404, "BLOB_UNKNOWN");
  const versions = await loc.catalog.packageVersions(loc.deliverable.id);
  if (!versions.some((v) => v.files.some((f) => f.sha256 === hex)))
    return ociError(404, "BLOB_UNKNOWN");
  const res = await blobResponse(req, bucket, blobKey(hex), {
    sha256: hex,
    gated: cache === "private",
    env: ctx.env,
    filename: hex,
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return ociError(404, "BLOB_UNKNOWN");
  }
  const headers = new Headers(res.headers);
  if (res.status === 200 || res.status === 206 || res.status === 304)
    headers.set("docker-content-digest", `sha256:${hex}`);
  return new Response(res.body, { status: res.status, headers });
};

// ── tags/list ────────────────────────────────────────────────────────────────────────────────

/** `n` as a page size: a non-negative integer, at most `MAX_TAGS_PAGE`; anything else is absent. */
function pageSize(raw: string | null): number | null {
  if (raw === null || !/^\d{1,9}$/.test(raw)) return null;
  return Math.min(Number(raw), MAX_TAGS_PAGE);
}

const serveTags: Compute = async (req, ctx, loc, cache) => {
  const pkg = await ociPackage(loc.catalog, ctx.product.slug, loc.deliverable);
  const stored = await renderedBody(ctx, pkg, tagsKey(pkg.name));
  const url = new URL(req.url);
  const n = pageSize(url.searchParams.get("n"));
  const last = url.searchParams.get("last");
  let body = stored;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (n !== null || last !== null) {
    let list: OciTagList;
    try {
      list = JSON.parse(stored) as OciTagList;
    } catch {
      list = { name: ociName(pkg), tags: [] };
    }
    const after = last === null ? list.tags : list.tags.filter((t) => t > last);
    const page = n === null ? after : after.slice(0, n);
    if (n !== null && n > 0 && after.length > n) {
      const next = new URLSearchParams({
        n: String(n),
        last: page[page.length - 1]!,
      });
      headers.link = `<${url.pathname}?${next.toString()}>; rel="next"`;
    }
    body = `${JSON.stringify({ name: list.name, tags: page })}\n`;
  }
  return new Response(req.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      ...headers,
      "content-length": String(new TextEncoder().encode(body).length),
      ...registryCacheHeaders(cache, "index", await sha256Hex(body)),
    },
  });
};

// ── The routes ───────────────────────────────────────────────────────────────────────────────

export const OCI_ROUTES: readonly RegistryRoute[] = [
  ociRoute("oci.manifests", MANIFESTS, {}, serveManifest, checkManifestAccept),
  ociRoute("oci.blobs", BLOBS, { cacheApi: false }, serveBlob),
  ociRoute("oci.tags", TAGS, { queryNames: ["n", "last"] }, serveTags),
];
