/// <reference types="@cloudflare/workers-types" />
/**
 * The Swift registry's read endpoints (F-06, plans/F-01.md §6.8; SwiftPM `Registry.md` §4) on
 * the registry host, under `/swift/<owner>/` — the URL a client passes to
 * `swift package-registry set --scope <scope>`:
 *
 *   GET /swift/<owner>/<scope>/<name>[.json]                         list releases (§4.1)
 *   GET /swift/<owner>/<scope>/<name>/<version>[.json]               release metadata (§4.2)
 *   GET /swift/<owner>/<scope>/<name>/<version>/Package.swift        manifest (§4.3), with
 *                                                     `?swift-version=` and its 303
 *   GET /swift/<owner>/<scope>/<name>/<version>.zip                  source archive (§4.4)
 *   GET /swift/<owner>/identifiers?url=                              identifiers (§4.5)
 *
 * `POST /swift/<owner>/login` answers 501 until F-21 and `PUT` (publish, §4.6) 405 until F-22;
 * both are the host dispatcher's (`core/registryHost.ts`), because tier 1 routes are read-only.
 *
 * EVERY READ GOES THROUGH `serveFeedRead`: the access ladder first, then the Cache API, then the
 * work here. The answers:
 *   - `Content-Version: 1` on every one, a refusal, a not-found or a 304 included (§3.5);
 *   - `Accept` checked before anything else: 400 for an invalid version or media type, 415 for
 *     an unsupported one (`protocol.ts`);
 *   - errors as `application/problem+json`; an unknown package, version or owner, a disabled
 *     feed and a missing object all answer the host's one not-found;
 *   - documents from the renders (`render.ts`), read through `readRegistryObject`, so a lost
 *     object is rendered again from D1 on the read;
 *   - manifests and archives from the blob store by SHA-256 (`blobResponse`): the SIGNED manifest
 *     copies the CLI uploaded, never copies taken from the zip (§5.3), immutable for a year;
 *   - `Link` headers built from the registry origin when answering: `latest-version` on the
 *     list; `latest-version`, `predecessor-version` and `successor-version` on a release; one
 *     `alternate` per `Package@swift-*.swift` on the manifest;
 *   - the signature on the archive as `X-Swift-Package-Signature-Format` and
 *     `X-Swift-Package-Signature` (§4.4), and in the metadata's `signing` (§4.2.1).
 */

import { blobKey, blobResponse } from "../../../../core/blobs.js";
import type { ReleaseCatalog } from "../../../../core/hooks.js";
import {
  registryNotFound,
  registryOrigin,
  type RegistryRoute,
  type RegistryRouteContext,
} from "../../../../core/registryHost.js";
import { authorizeFeedRead, feedPrincipal } from "../authorize.js";
import { registryCacheHeaders } from "../cache.js";
import {
  readRegistryObject,
  renderedObjectResponse,
  type MaterialiseDeps,
  type RegistryRenderer,
} from "../materialise.js";
import { serveFeedRead } from "../serve.js";
import { cachedRegistrySettings, d1RegistrySettings } from "../settings.js";
import {
  SWIFT_NAME,
  SWIFT_SCOPE,
  SWIFT_VERSION,
  normaliseRepositoryUrl,
  swiftAcceptRefusal,
  swiftIdentity,
  swiftProblem,
  withContentVersion,
  type SwiftMediaType,
} from "./protocol.js";
import { renderSwift, swiftKeys, type SwiftRouting } from "./render.js";
import { catalogPackageSource, findPackageDeliverable } from "./source.js";

const OWNER = "[a-z0-9-]{1,64}";
const SEG = "[^/]+";

const lower = (name: string): string => name.toLowerCase();

/** The renderer the read path renders a miss with (only Swift packages reach these routes). */
const SWIFT_ONLY: ReadonlyMap<"swift", RegistryRenderer> = new Map([
  ["swift", { ecosystem: "swift", render: renderSwift, routes: [] }],
]);

/** The package a path names: `scope` and `name` as typed, the identity, and the version. */
interface SwiftTarget {
  readonly scope: string;
  readonly name: string;
  readonly version?: string;
}

function target(params: Record<string, string>): SwiftTarget | null {
  const { scope, name, version } = params;
  if (!scope || !name || !SWIFT_SCOPE.test(scope) || !SWIFT_NAME.test(name))
    return null;
  if (version !== undefined && !SWIFT_VERSION.test(version)) return null;
  return { scope, name, ...(version !== undefined ? { version } : {}) };
}

/** `https://pkg.plrs.im/swift/<owner>` for the answer's links. */
function baseUrl(req: Request, ctx: RegistryRouteContext): string {
  const origin = registryOrigin(ctx.env) ?? new URL(req.url).origin;
  return `${origin}/swift/${ctx.product.slug}`;
}

/** `<scope>/<Name>` of a declared `scope.Name`. */
function idPath(id: string): string {
  const dot = id.indexOf(".");
  return `${id.slice(0, dot)}/${id.slice(dot + 1)}`;
}

function link(url: string, rel: string, extra = ""): string {
  return `<${url}>; rel="${rel}"${extra}`;
}

function withHeaders(
  res: Response,
  set: Record<string, string | null | undefined>,
): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(set))
    if (v !== null && v !== undefined && v !== "") headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** What a package read has once its deliverable is known. */
interface PackageRead {
  readonly catalog: ReleaseCatalog;
  readonly deliverableId: string;
  readonly deps: MaterialiseDeps;
  readonly identity: string;
}

/**
 * The shared shape of every package endpoint: `Accept` first, then the deliverable the path
 * names, then `serveFeedRead`, then `work`. A package that does not exist still goes through
 * `serveFeedRead` (as a list read) and answers the same not-found as a feed that is off.
 */
async function packageRead(
  req: Request,
  ctx: RegistryRouteContext,
  want: SwiftMediaType,
  queryNames: readonly string[],
  work: (
    read: PackageRead,
    t: SwiftTarget,
    cache: "public" | "private",
  ) => Promise<Response>,
): Promise<Response> {
  const refusal = swiftAcceptRefusal(req, want);
  if (refusal) return refusal;
  const t = target(ctx.params);
  const catalog = ctx.hooks.releaseCatalog();
  const decl =
    t && catalog
      ? await findPackageDeliverable(
          catalog,
          "swift",
          swiftIdentity(t.scope, t.name),
          lower,
        )
      : null;
  const res = await serveFeedRead(
    req,
    ctx,
    { deliverableId: decl?.id ?? null, queryNames },
    async (cache) => {
      const bucket = ctx.env.BLOBS;
      if (!t || !catalog || !decl || !bucket) return registryNotFound("swift");
      return work(
        {
          catalog,
          deliverableId: decl.id,
          identity: swiftIdentity(t.scope, t.name),
          deps: {
            bucket,
            renderers: SWIFT_ONLY,
            source: catalogPackageSource(catalog, "swift", lower),
            origin: registryOrigin(ctx.env) ?? new URL(req.url).origin,
          },
        },
        t,
        cache,
      );
    },
  );
  return withContentVersion(res);
}

/** One rendered object of the package, or `null`. */
function readObject(
  read: PackageRead,
  ctx: RegistryRouteContext,
  key: string,
): Promise<R2ObjectBody | null> {
  return readRegistryObject(read.deps, {
    ecosystem: "swift",
    owner: ctx.product.slug,
    key,
    deliverableId: read.deliverableId,
  });
}

async function readRouting(
  read: PackageRead,
  ctx: RegistryRouteContext,
): Promise<SwiftRouting | null> {
  const obj = await readObject(read, ctx, swiftKeys(read.identity).routing);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as SwiftRouting;
  } catch {
    return null;
  }
}

/**
 * The version a path names: exactly, else case-insensitively (identifiers are case-insensitive
 * in SwiftPM, and the swiftlang compatibility suite flips the case of the whole path, version
 * included), and for the metadata endpoint also without a trailing `.json` (§4.2).
 */
function resolveVersion(
  routing: SwiftRouting,
  raw: string | undefined,
  allowJsonSuffix = false,
): string | null {
  if (raw === undefined) return null;
  const candidates = [raw];
  if (allowJsonSuffix && raw.toLowerCase().endsWith(".json"))
    candidates.push(raw.slice(0, -5));
  for (const c of candidates) {
    if (Object.hasOwn(routing.versions, c)) return c;
    const folded = Object.keys(routing.versions).filter(
      (v) => v.toLowerCase() === c.toLowerCase(),
    );
    if (folded.length === 1) return folded[0]!;
  }
  return null;
}

// ── The endpoints ────────────────────────────────────────────────────────────────────────────

async function listReleases(
  req: Request,
  ctx: RegistryRouteContext,
): Promise<Response> {
  return packageRead(req, ctx, "json", [], async (read, _t, cache) => {
    const routing = await readRouting(read, ctx);
    const obj = await readObject(read, ctx, swiftKeys(read.identity).releases);
    // A declared package with nothing published is not found: the declaration is not public.
    if (!routing || !obj || Object.keys(routing.versions).length === 0) {
      await obj?.body.cancel().catch(() => undefined);
      return registryNotFound("swift");
    }
    const base = `${baseUrl(req, ctx)}/${idPath(routing.id)}`;
    return withHeaders(renderedObjectResponse(obj, cache), {
      link: routing.latest
        ? link(`${base}/${routing.latest}`, "latest-version")
        : null,
    });
  });
}

async function releaseInfo(
  req: Request,
  ctx: RegistryRouteContext,
): Promise<Response> {
  return packageRead(req, ctx, "json", [], async (read, t, cache) => {
    const routing = await readRouting(read, ctx);
    const version = routing && resolveVersion(routing, t.version, true);
    if (!routing || !version) return registryNotFound("swift");
    const obj = await readObject(
      read,
      ctx,
      swiftKeys(read.identity).release(version),
    );
    if (!obj) return registryNotFound("swift");
    const route = routing.versions[version]!;
    const base = `${baseUrl(req, ctx)}/${idPath(routing.id)}`;
    const links = [
      routing.latest && link(`${base}/${routing.latest}`, "latest-version"),
      route.predecessor &&
        link(`${base}/${route.predecessor}`, "predecessor-version"),
      route.successor &&
        link(`${base}/${route.successor}`, "successor-version"),
    ].filter((l): l is string => typeof l === "string");
    return withHeaders(renderedObjectResponse(obj, cache), {
      link: links.join(", "),
    });
  });
}

async function manifest(
  req: Request,
  ctx: RegistryRouteContext,
): Promise<Response> {
  return packageRead(
    req,
    ctx,
    "swift",
    ["swift-version"],
    async (read, t, cache) => {
      const routing = await readRouting(read, ctx);
      const version = routing && resolveVersion(routing, t.version);
      if (!routing || !version) return registryNotFound("swift");
      const route = routing.versions[version]!;
      const unqualified = route.manifests[""];
      if (!unqualified) return registryNotFound("swift");
      const base = `${baseUrl(req, ctx)}/${t.scope}/${t.name}/${version}/Package.swift`;
      const wanted = new URL(req.url).searchParams.get("swift-version");
      if (wanted !== null) {
        const specific = Object.hasOwn(route.manifests, wanted)
          ? route.manifests[wanted]
          : undefined;
        if (!specific || wanted === "")
          // §4.3.1: no such version-specific manifest → 303 to the unqualified one.
          return new Response(null, {
            status: 303,
            headers: {
              location: base,
              "cache-control": registryCacheHeaders(cache, "index", "")[
                "cache-control"
              ]!,
            },
          });
        return manifestBlob(req, ctx, read, specific.sha256, specific.filename);
      }
      const alternates = Object.entries(route.manifests)
        .filter(([k]) => k !== "")
        .map(([k, m]) =>
          link(
            `${base}?swift-version=${k}`,
            "alternate",
            `; filename="${m.filename}"; swift-tools-version="${m.toolsVersion ?? k}"`,
          ),
        );
      return withHeaders(
        await manifestBlob(
          req,
          ctx,
          read,
          unqualified.sha256,
          unqualified.filename,
        ),
        { link: alternates.join(", ") },
      );
    },
  );
}

/** A signed manifest from the blob store, as `text/x-swift` with its filename. */
async function manifestBlob(
  req: Request,
  ctx: RegistryRouteContext,
  read: PackageRead,
  sha256: string,
  filename: string,
): Promise<Response> {
  const res = await blobResponse(req, read.deps.bucket, blobKey(sha256), {
    sha256,
    gated: false,
    env: ctx.env,
    host: "console",
    filename,
  });
  if (res.status !== 200 && res.status !== 206) {
    if (res.status === 404) return registryNotFound("swift");
    return res;
  }
  return withHeaders(res, {
    "content-type": "text/x-swift",
    "content-disposition": `attachment; filename="${filename}"`,
  });
}

async function sourceArchive(
  req: Request,
  ctx: RegistryRouteContext,
): Promise<Response> {
  return packageRead(req, ctx, "zip", [], async (read, t, _cache) => {
    const routing = await readRouting(read, ctx);
    const version = routing && resolveVersion(routing, t.version);
    const route = version ? routing!.versions[version]! : null;
    if (!routing || !version || !route?.archive)
      return registryNotFound("swift");
    const name = routing.id.slice(routing.id.indexOf(".") + 1);
    const filename = `${name}-${version}.zip`;
    const res = await blobResponse(
      req,
      read.deps.bucket,
      blobKey(route.archive.sha256),
      {
        sha256: route.archive.sha256,
        gated: false,
        env: ctx.env,
        host: "console",
        filename,
      },
    );
    if (res.status === 404) return registryNotFound("swift");
    const signed: Record<string, string | null> = route.signature
      ? {
          "x-swift-package-signature-format": route.signature.format,
          "x-swift-package-signature": route.signature.base64,
        }
      : {};
    if (res.status !== 200 && res.status !== 206)
      return withHeaders(res, signed);
    return withHeaders(res, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      ...signed,
    });
  });
}

/**
 * §4.5: the identifiers the feed's `ext_json.repositoryUrls` (`{"scope.Name": [url, …]}`, an
 * operator setting) maps `url` to, compared without scheme, user, `.git` or case. Only packages
 * the feed holds, and that an anonymous reader may read, are listed; none is the not-found.
 */
async function identifiers(
  req: Request,
  ctx: RegistryRouteContext,
): Promise<Response> {
  const refusal = swiftAcceptRefusal(req, "json");
  if (refusal) return refusal;
  const raw = new URL(req.url).searchParams.get("url");
  const wanted = raw === null ? null : normaliseRepositoryUrl(raw);
  if (wanted === null)
    return swiftProblem(400, "the url query parameter is required");
  const res = await serveFeedRead(
    req,
    ctx,
    { deliverableId: null, queryNames: ["url"] },
    async (cache) => {
      const catalog = ctx.hooks.releaseCatalog();
      if (!catalog) return registryNotFound("swift");
      const source = d1RegistrySettings(ctx.db);
      const { feed } = await cachedRegistrySettings(
        source,
        ctx.product.slug,
        "swift",
      );
      const map = feed?.ext.repositoryUrls;
      const claimed = new Set<string>();
      if (map && typeof map === "object" && !Array.isArray(map))
        for (const [id, urls] of Object.entries(map))
          if (
            Array.isArray(urls) &&
            urls.some(
              (u) =>
                typeof u === "string" && normaliseRepositoryUrl(u) === wanted,
            )
          )
            claimed.add(id.toLowerCase());
      const found: string[] = [];
      for (const d of await catalog.packageDeliverables()) {
        if (d.ecosystem !== "swift" || !claimed.has(d.name.toLowerCase()))
          continue;
        const decision = await authorizeFeedRead(
          { db: ctx.db, services: ctx.product.services, settings: source },
          feedPrincipal(req),
          ctx.product.slug,
          "swift",
          d.id,
        );
        if (decision.ok) found.push(d.name);
      }
      if (found.length === 0) return registryNotFound("swift");
      const body = JSON.stringify({ identifiers: found.sort() });
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(body),
      );
      const sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return new Response(req.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...registryCacheHeaders(cache, "index", sha256),
        },
      });
    },
  );
  return withContentVersion(res);
}

// ── Matching ─────────────────────────────────────────────────────────────────────────────────

function matcher(re: RegExp, names: readonly string[]): RegistryRoute["match"] {
  return (pathname) => {
    const m = re.exec(pathname);
    if (!m) return null;
    const params: Record<string, string> = {};
    names.forEach((n, i) => {
      const v = m[i + 2];
      if (v !== undefined) params[n] = v;
    });
    return { owner: m[1]!, params };
  };
}

/** The Swift registry's routes, most specific first. */
export const SWIFT_ROUTES: readonly RegistryRoute[] = [
  {
    name: "swift.identifiers",
    service: "distribution",
    ecosystem: "swift",
    match: matcher(new RegExp(`^/swift/(${OWNER})/identifiers$`), []),
    handle: identifiers,
  },
  {
    name: "swift.manifest",
    service: "distribution",
    ecosystem: "swift",
    match: matcher(
      new RegExp(
        `^/swift/(${OWNER})/(${SEG})/(${SEG})/(${SEG})/Package\\.swift$`,
      ),
      ["scope", "name", "version"],
    ),
    handle: manifest,
  },
  {
    name: "swift.archive",
    service: "distribution",
    ecosystem: "swift",
    match: matcher(
      new RegExp(`^/swift/(${OWNER})/(${SEG})/(${SEG})/(${SEG})\\.zip$`),
      ["scope", "name", "version"],
    ),
    handle: sourceArchive,
  },
  {
    name: "swift.release",
    service: "distribution",
    ecosystem: "swift",
    match: matcher(
      new RegExp(`^/swift/(${OWNER})/(${SEG})/(${SEG})/(${SEG})$`),
      ["scope", "name", "version"],
    ),
    handle: releaseInfo,
  },
  {
    name: "swift.releases",
    service: "distribution",
    ecosystem: "swift",
    match: (pathname) => {
      const m = new RegExp(`^/swift/(${OWNER})/(${SEG})/(${SEG})$`).exec(
        pathname,
      );
      if (!m) return null;
      const name = m[3]!.endsWith(".json") ? m[3]!.slice(0, -5) : m[3]!;
      return { owner: m[1]!, params: { scope: m[2]!, name } };
    },
    handle: listReleases,
  },
];
