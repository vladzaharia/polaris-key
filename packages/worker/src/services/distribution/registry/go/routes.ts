/// <reference types="@cloudflare/workers-types" />
/**
 * The Go feed's routes on the registry host (F-31, plans/F-01.md §6.2, §6.8): a module proxy,
 * `GOPROXY=https://pkg.plrs.im/go/<owner>` (https://go.dev/ref/mod#goproxy-protocol).
 *
 *   GET|HEAD /go/<owner>/<module>/@v/list               the versions (rendered)
 *   GET|HEAD /go/<owner>/<module>/@latest               the stable head's info (rendered)
 *   GET|HEAD /go/<owner>/<module>/@v/<version>.info     a version's info, or a channel tag's
 *                                                       canonical version (rendered)
 *   GET|HEAD /go/<owner>/<module>/@v/<version>.mod      the version's go.mod (bytes)
 *   GET|HEAD /go/<owner>/<module>/@v/<version>.zip      the version's module zip (bytes)
 *
 * `<module>` and `<version>` are case-encoded as the go command sends them (`!x` for `X`); a
 * path that is not a valid encoding of a module path matches no route. The module is looked up by
 * its exact path (Go paths are case-sensitive). Everything unknown answers the host's one
 * not-found, a 404, which is what tells the go command to try the next GOPROXY entry, so a path
 * the feed does not hold (another module, or a package path's parent directories, which the go
 * command probes) falls through to the public proxy.
 *
 * EVERY READ GOES THROUGH `serveFeedRead` (each route is built by `feedRoute`): the access ladder
 * first, then the Cache API for a public feed; a non-public feed answers `401` with
 * `WWW-Authenticate: Basic` (the go command answers it from `.netrc` or GOAUTH).
 *
 *   - The rendered documents are read stamp-checked (`freshRegistryObject`): a publish, yank or
 *     channel move shows on the next uncached read, `public, max-age=60` with a strong ETag.
 *   - `.mod` and `.zip` are the release's own blobs, by SHA-256, through `blobResponse` (Range,
 *     strong ETag, immutable for a year): a version's bytes never change, and Go's go.sum would
 *     refuse them if they did. Only canonical versions name bytes; a tag never does.
 */

import type {
  CatalogPackageDeliverable,
  ReleaseCatalog,
} from "../../../../core/hooks.js";
import { blobKey, blobResponse } from "../../../../core/blobs.js";
import { registryOrigin } from "../../../../core/registryHostname.js";
import {
  registryNotFound,
  type RegistryRoute,
  type RegistryRouteContext,
  type RegistryRouteMatch,
} from "../../../../core/registryHost.js";
import { GO_MODULE_PATH } from "@polaris-key/manifest";
import { catalogPackageSource, freshRegistryObject } from "../catalogSource.js";
import type { RegistryRenderer } from "../materialise.js";
import { feedRoute } from "../serve.js";
import {
  goFileOf,
  goKeyOf,
  goModuleKey,
  goUnescape,
  releaseVersionOf,
} from "./render.js";

const OWNER = "([a-z0-9][a-z0-9-]*)";
/** The escaped module path: the go command's characters, never `@` (which ends it). */
const MODULE = "([a-z0-9!][A-Za-z0-9!._~/-]*)";
const VERSION = "([A-Za-z0-9!._~+-]+)";

const LIST_PATH = new RegExp(`^/go/${OWNER}/${MODULE}/@v/list$`);
const LATEST_PATH = new RegExp(`^/go/${OWNER}/${MODULE}/@latest$`);
const FILE_PATH = new RegExp(
  `^/go/${OWNER}/${MODULE}/@v/${VERSION}\\.(info|mod|zip)$`,
);

/** The module path an escaped path names, when it is a valid module path. */
function modulePath(escaped: string): string | null {
  const path = goUnescape(escaped);
  return path !== null && path.length <= 255 && GO_MODULE_PATH.test(path)
    ? path
    : null;
}

function matchList(pathname: string): RegistryRouteMatch | null {
  const m = LIST_PATH.exec(pathname);
  const module = m && modulePath(m[2]!);
  return m && module ? { owner: m[1]!, params: { module } } : null;
}

function matchLatest(pathname: string): RegistryRouteMatch | null {
  const m = LATEST_PATH.exec(pathname);
  const module = m && modulePath(m[2]!);
  return m && module ? { owner: m[1]!, params: { module } } : null;
}

/** `@v/<version>.<ext>` for one extension: the module, the escaped and the plain version. */
function matchFile(ext: "info" | "mod" | "zip") {
  return (pathname: string): RegistryRouteMatch | null => {
    const m = FILE_PATH.exec(pathname);
    if (!m || m[4] !== ext) return null;
    const module = modulePath(m[2]!);
    const version = goUnescape(m[3]!);
    if (!module || version === null || version === "") return null;
    return {
      owner: m[1]!,
      params: { module, escapedVersion: m[3]!, version },
    };
  };
}

/** What a request names, looked up before the ladder. */
type GoRead = {
  catalog: ReleaseCatalog;
  deliverable: CatalogPackageDeliverable;
} | null;

/** The deliverable declared as exactly this module path in the owner's Go feed. */
async function resolveGo(
  _req: Request,
  ctx: RegistryRouteContext,
): Promise<GoRead> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  const module = ctx.params.module!;
  const deliverable = (await catalog.packageDeliverables()).find(
    (d) => d.ecosystem === "go" && d.name === module,
  );
  return deliverable ? { catalog, deliverable } : null;
}

/** One rendered document of the module (`key` under the module's prefix). */
async function servedDocument(
  ctx: RegistryRouteContext,
  cache: "public" | "private",
  found: GoRead,
  renderer: () => RegistryRenderer,
  key: string,
): Promise<Response> {
  if (!found) return registryNotFound("go");
  const pkg = await catalogPackageSource(
    found.catalog,
    ctx.product.slug,
  ).package(ctx.product.slug, found.deliverable.id);
  if (!pkg || pkg.ecosystem !== "go") return registryNotFound("go");
  const res = await freshRegistryObject(
    {
      bucket: ctx.env.BLOBS,
      renderer: renderer(),
      origin: registryOrigin(ctx.env) ?? "",
      ...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
    },
    pkg,
    `${goModuleKey(pkg.name)}/${key}`,
    cache,
  );
  return res ?? registryNotFound("go");
}

/** Strip the validator a public answer must not be computed with: the Cache API stores the full
 *  200 and `serveFeedRead` turns a matching `If-None-Match` into the 304 itself. */
function forCache(req: Request): Request {
  if (!req.headers.has("if-none-match")) return req;
  const headers = new Headers(req.headers);
  headers.delete("if-none-match");
  return new Request(req.url, { method: req.method, headers });
}

/** The `.mod` or `.zip` bytes of one canonical version. */
function bytesRoute(ext: "mod" | "zip"): RegistryRoute {
  return feedRoute<GoRead>({
    name: `go.${ext}`,
    ecosystem: "go",
    match: matchFile(ext),
    resolve: resolveGo,
    deliverableId: (_params, found) => found?.deliverable.id ?? null,
    async serve(req, ctx, cache, found) {
      const bucket = ctx.env.BLOBS;
      const release = releaseVersionOf(ctx.params.version!);
      if (!found || !bucket || release === null) return registryNotFound("go");
      const v = (
        await found.catalog.packageVersions(found.deliverable.id)
      ).find((x) => x.version === release);
      const file = v && goFileOf(v, ext === "mod" ? "go-mod" : "go-zip");
      if (!file) return registryNotFound("go");
      return blobResponse(
        cache === "public" ? forCache(req) : req,
        bucket,
        blobKey(file.sha256),
        {
          sha256: file.sha256,
          gated: cache === "private",
          env: ctx.env,
          filename: `${ctx.params.version}.${ext}`,
        },
      );
    },
  });
}

/** The Go feed's routes, given its renderer (late-bound: the renderer lists these routes). */
export function goRoutes(renderer: () => RegistryRenderer): RegistryRoute[] {
  const list = feedRoute<GoRead>({
    name: "go.list",
    ecosystem: "go",
    match: matchList,
    resolve: resolveGo,
    deliverableId: (_params, found) => found?.deliverable.id ?? null,
    serve: (_req, ctx, cache, found) =>
      servedDocument(ctx, cache, found, renderer, "@v/list"),
  });
  const latest = feedRoute<GoRead>({
    name: "go.latest",
    ecosystem: "go",
    match: matchLatest,
    resolve: resolveGo,
    deliverableId: (_params, found) => found?.deliverable.id ?? null,
    serve: (_req, ctx, cache, found) =>
      servedDocument(ctx, cache, found, renderer, "@latest"),
  });
  const info = feedRoute<GoRead>({
    name: "go.info",
    ecosystem: "go",
    match: matchFile("info"),
    resolve: resolveGo,
    deliverableId: (_params, found) => found?.deliverable.id ?? null,
    serve: (_req, ctx, cache, found) =>
      servedDocument(
        ctx,
        cache,
        found,
        renderer,
        `@v/${goKeyOf(ctx.params.escapedVersion!)}.info`,
      ),
  });
  return [list, latest, info, bytesRoute("mod"), bytesRoute("zip")];
}
