/// <reference types="@cloudflare/workers-types" />
/**
 * The Godot feed's routes on the registry host (F-09, plans/F-01.md §6.2 and §6.8). Every read
 * goes through `serveFeedRead` (F-02): the access ladder first, then the Cache API, then the work.
 *
 *   /godot/<owner>/asset-library/api/configure              ≤ 4.6  categories
 *   /godot/<owner>/asset-library/api/asset?…                 ≤ 4.6  search (in memory)
 *   /godot/<owner>/asset-library/api/asset/<id>              ≤ 4.6  asset, with download_hash
 *   /godot/<owner>/store/api/v1/                             4.7+   API overview (repository check)
 *   /godot/<owner>/store/api/v1/tags/                        4.7+   tags (none)
 *   /godot/<owner>/store/api/v1/licenses/                    4.7+   licenses in use
 *   /godot/<owner>/store/api/v1/search/query/?…              4.7+   search (in memory)
 *   /godot/<owner>/store/api/v1/assets/<publisher>/<asset>/  4.7+   asset
 *   /godot/<owner>/store/api/v1/releases/<publisher>/<asset>/ 4.7+  releases
 *   /godot/<owner>/index.json                                GodotEnv and scripted installs
 *   /godot/<owner>/files/<sha256>/<name>.zip                 addon zips (content-addressed)
 *   /godot/<owner>/icons/<sha256>.png                        icons (content-addressed)
 *
 * The editor appends paths to the URL in Editor Settings (`asset_library/available_urls` up to
 * 4.6, `asset_store/available_urls` from 4.7), so the two bases are
 * `https://pkg.plrs.im/godot/<owner>/asset-library/api` and `…/store/api/v1`, with no trailing
 * slash. The store paths answer with or without their trailing slash.
 *
 * WHAT IS COMPUTED PER REQUEST: the two searches filter the owner's short list in memory (the
 * only per-request computation the brief allows), and the other owner-wide documents
 * (`configure`, `tags/`, `licenses/`, `index.json`) are composed from the same list; all of them
 * sit behind the Cache API for 60 s. The per-package documents are rendered into R2
 * (`render.ts`) and read through `readFreshRegistryObject`, which re-renders one whose stamp no
 * longer matches D1 and the feed settings, so a publish, yank or settings change is never hidden
 * behind a stale render (no drain is wired yet; see the brief's corrections).
 *
 * A package stricter than the feed (its own `dist_access` mode) is left out of every list
 * (§6.6 step 3), and its own documents answer the ladder's refusal.
 */

import type { ReleaseCatalog } from "../../../../core/hooks.js";
import { blobKey, blobResponse, hasRef } from "../../../../core/blobs.js";
import {
  registryNotFound,
  registryOrigin,
  type RegistryRoute,
  type RegistryRouteContext,
} from "../../../../core/registryHost.js";
import { authorizeFeedRead, feedPrincipal } from "../authorize.js";
import { registryCacheHeaders } from "../cache.js";
import {
  readFreshRegistryObject,
  renderedObjectResponse,
  type MaterialiseDeps,
  type PackageFile,
  type RegistryPackage,
} from "../materialise.js";
import { serveFeedRead } from "../serve.js";
import { cachedRegistrySettings, d1RegistrySettings } from "../settings.js";
import {
  LEGACY_QUERY_NAMES,
  STORE_QUERY_NAMES,
  assetIdsOf,
  filterReleases,
  godotFeedView,
  godotIndex,
  legacyConfigure,
  legacyQueryOf,
  legacySearch,
  queryFlag,
  storeLicenses,
  storeOverview,
  storeQueryOf,
  storeSearch,
  type GodotFeedView,
  type ListedPackage,
} from "./documents.js";
import {
  jsonBody,
  legacyAssetKey,
  renderGodot,
  storeAssetKey,
  storeReleasesKey,
} from "./render.js";
import { catalogPackageSource, loadPackages } from "./source.js";

const ECO = "godot" as const;
const OWNER = "([a-z0-9-]{1,64})";
const HEX64 = "([0-9a-f]{64})";
const SLUG = "([a-z0-9][a-z0-9_-]{0,63})";

const notFound = (): Response => registryNotFound(ECO);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A composed JSON document with the index-document headers of §6.7 (strong ETag = body hash). */
async function jsonAnswer(
  value: unknown,
  cache: "public" | "private",
): Promise<Response> {
  const body = jsonBody(value);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...registryCacheHeaders(cache, "index", await sha256Hex(body)),
    },
  });
}

/** The origin absolute URLs are built on: `PKG_ORIGIN`, or the request's own on a test host. */
function originOf(req: Request, ctx: RegistryRouteContext): string {
  return registryOrigin(ctx.env) ?? new URL(req.url).origin;
}

/** What every Godot read needs: the catalog (Release on) and the feed view (a publisher set). */
interface GodotRead {
  readonly catalog: ReleaseCatalog;
  readonly view: GodotFeedView;
  readonly deps: MaterialiseDeps | null;
}

async function godotRead(
  req: Request,
  ctx: RegistryRouteContext,
): Promise<GodotRead | null> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  const owner = ctx.product.slug;
  const source = d1RegistrySettings(ctx.db);
  const feedOf = async () => {
    const { feed } = await cachedRegistrySettings(source, owner, ECO);
    return feed ? { namespace: feed.namespace, ext: feed.ext } : null;
  };
  const origin = originOf(req, ctx);
  const view = godotFeedView(owner, origin, await feedOf());
  if (!view) return null;
  const bucket = ctx.env.BLOBS;
  return {
    catalog,
    view,
    deps: bucket
      ? {
          bucket,
          renderers: new Map([
            [ECO, { ecosystem: ECO, render: renderGodot, routes: [] }],
          ]),
          source: catalogPackageSource(catalog, owner, ECO),
          origin,
          feed: feedOf,
        }
      : null,
  };
}

/**
 * The packages a list may show: every Godot package of the owner whose own access decision is
 * the list's (§6.6 step 3: a package stricter than the feed is omitted), with its legacy id.
 */
async function listedPackages(
  req: Request,
  ctx: RegistryRouteContext,
  g: GodotRead,
  cache: "public" | "private",
): Promise<ListedPackage[]> {
  const pkgs = await loadPackages(g.catalog, ctx.product.slug, ECO);
  const ids = assetIdsOf(pkgs.map((p) => p.deliverableId));
  const out: ListedPackage[] = [];
  for (const pkg of pkgs) {
    const decision = await authorizeFeedRead(
      { db: ctx.db, services: ctx.product.services },
      feedPrincipal(req),
      ctx.product.slug,
      ECO,
      pkg.deliverableId,
    );
    if (!decision.ok || decision.cache !== cache) continue;
    const assetId = ids.get(pkg.deliverableId);
    if (assetId !== undefined) out.push({ pkg, assetId });
  }
  return out;
}

/**
 * The request the cache key is taken from: the same request with its query normalised, so a
 * repeated parameter (the store's `licenses`) or a valueless flag (`reverse`) cannot make two
 * different answers share one key. `registryCacheKey` reads one value per name and drops empty
 * ones, so repeated values are joined (sorted) and a present flag becomes `1`.
 */
function keyRequest(
  req: Request,
  repeated: readonly string[],
  flags: readonly string[],
): Request {
  const url = new URL(req.url);
  let changed = false;
  for (const name of repeated) {
    const all = url.searchParams.getAll(name);
    if (all.length > 1) {
      url.searchParams.delete(name);
      url.searchParams.set(name, [...all].sort().join("\n"));
      changed = true;
    }
  }
  for (const name of flags)
    if (url.searchParams.has(name) && !url.searchParams.get(name)) {
      url.searchParams.set(name, "1");
      changed = true;
    }
  return changed ? new Request(url.toString(), req) : req;
}

// ── Route builders ───────────────────────────────────────────────────────────────────────────

function route(
  name: string,
  pattern: RegExp,
  params: readonly string[],
  handle: (
    req: Request,
    ctx: RegistryRouteContext,
    params: Record<string, string>,
  ) => Promise<Response>,
): RegistryRoute {
  return {
    name,
    service: "distribution",
    ecosystem: ECO,
    match(pathname) {
      const m = pattern.exec(pathname);
      if (!m) return null;
      const out: Record<string, string> = {};
      params.forEach((p, i) => (out[p] = m[i + 2]!));
      return { owner: m[1]!, params: out };
    },
    handle: (req, ctx) => handle(req, ctx, ctx.params),
  };
}

/** A list-level (owner-wide) document: the ladder with `deliverableId: null`. */
function listRoute(
  name: string,
  pattern: RegExp,
  queryNames: readonly string[],
  build: (
    req: Request,
    ctx: RegistryRouteContext,
    g: GodotRead,
    cache: "public" | "private",
  ) => Promise<unknown>,
  key: (req: Request) => Request = (r) => r,
): RegistryRoute {
  return route(name, pattern, [], async (req, ctx) =>
    serveFeedRead(
      key(req),
      ctx,
      { deliverableId: null, queryNames },
      async (cache) => {
        const g = await godotRead(req, ctx);
        if (!g) return notFound();
        return jsonAnswer(await build(req, ctx, g, cache), cache);
      },
    ),
  );
}

/** The Godot package deliverable a predicate picks, by its declaration (no version rows read). */
async function findDeliverable(
  ctx: RegistryRouteContext,
  pick: (d: { id: string; name: string }, ids: Map<string, string>) => boolean,
): Promise<string | null> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  const decls = (await catalog.packageDeliverables()).filter(
    (d) => d.ecosystem === ECO,
  );
  const ids = assetIdsOf(decls.map((d) => d.id));
  return decls.find((d) => pick(d, ids))?.id ?? null;
}

/** A rendered per-package document, read fresh. */
async function renderedAnswer(
  req: Request,
  ctx: RegistryRouteContext,
  deliverableId: string,
  key: (g: GodotRead) => string | null,
  cache: "public" | "private",
  transform?: (body: unknown, g: GodotRead) => unknown,
): Promise<Response> {
  const g = await godotRead(req, ctx);
  if (!g?.deps) return notFound();
  const k = key(g);
  if (k === null) return notFound();
  const obj = await readFreshRegistryObject(g.deps, {
    ecosystem: ECO,
    owner: ctx.product.slug,
    key: k,
    deliverableId,
  });
  if (!obj) return notFound();
  if (!transform) return renderedObjectResponse(obj, cache);
  const body: unknown = JSON.parse(
    new TextDecoder().decode(await obj.arrayBuffer()),
  );
  return jsonAnswer(transform(body, g), cache);
}

/** A content-addressed file of one of the owner's Godot packages: `godot-zip` or `godot-icon`. */
async function fileOwner(
  ctx: RegistryRouteContext,
  type: "godot-zip" | "godot-icon",
  sha256: string,
  name: string | null,
): Promise<{ pkg: RegistryPackage; file: PackageFile } | null> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  for (const pkg of await loadPackages(catalog, ctx.product.slug, ECO))
    for (const v of pkg.versions)
      for (const file of v.files)
        if (
          file.type === type &&
          file.sha256 === sha256 &&
          (name === null || file.name === name)
        )
          return { pkg, file };
  return null;
}

function byteRoute(
  name: string,
  pattern: RegExp,
  params: readonly string[],
  type: "godot-zip" | "godot-icon",
  contentType: string,
): RegistryRoute {
  return route(name, pattern, params, async (req, ctx, p) => {
    let fileName: string | null = null;
    if (p.file !== undefined) {
      try {
        fileName = decodeURIComponent(p.file);
      } catch {
        return notFound();
      }
    }
    const owned = await fileOwner(ctx, type, p.sha256!, fileName);
    if (!owned) return notFound();
    return serveFeedRead(
      req,
      ctx,
      { deliverableId: owned.pkg.deliverableId },
      async () => {
        const bucket = ctx.env.BLOBS;
        const key = blobKey(owned.file.sha256);
        if (!bucket || !(await hasRef(ctx.db, ctx.product.slug, key)))
          return notFound();
        const res = await blobResponse(req, bucket, key, {
          sha256: owned.file.sha256,
          gated: false,
          env: ctx.env,
          filename: owned.file.name,
        });
        if (res.status !== 200 && res.status !== 206) return res;
        const headers = new Headers(res.headers);
        headers.set("content-type", contentType);
        return new Response(res.body, { status: res.status, headers });
      },
    );
  });
}

// ── The routes ───────────────────────────────────────────────────────────────────────────────

const legacy = (rest: string) =>
  new RegExp(`^/godot/${OWNER}/asset-library/api/${rest}$`);
const store = (rest: string) =>
  new RegExp(`^/godot/${OWNER}/store/api/v1/${rest}$`);

export const GODOT_ROUTES: readonly RegistryRoute[] = [
  listRoute(
    "godotLegacyConfigure",
    legacy("configure"),
    ["type"],
    async (req) => legacyConfigure(new URL(req.url).searchParams.get("type")),
  ),
  listRoute(
    "godotLegacySearch",
    legacy("asset"),
    LEGACY_QUERY_NAMES,
    async (req, ctx, g, cache) =>
      legacySearch(
        await listedPackages(req, ctx, g, cache),
        g.view,
        legacyQueryOf(new URL(req.url).searchParams),
      ),
    (req) => keyRequest(req, [], ["reverse"]),
  ),
  route(
    "godotLegacyAsset",
    legacy("asset/([0-9]{1,10})"),
    ["id"],
    async (req, ctx, p) => {
      const id = p.id!;
      const deliverableId = await findDeliverable(
        ctx,
        (d, ids) => ids.get(d.id) === id,
      );
      if (!deliverableId) return notFound();
      return serveFeedRead(req, ctx, { deliverableId }, (cache) =>
        renderedAnswer(
          req,
          ctx,
          deliverableId,
          () => legacyAssetKey(id),
          cache,
        ),
      );
    },
  ),
  listRoute("godotStoreOverview", store("?"), [], async () => storeOverview()),
  listRoute("godotStoreTags", store("tags/?"), [], async () => []),
  listRoute(
    "godotStoreLicenses",
    store("licenses/?"),
    [],
    async (req, ctx, g, cache) =>
      storeLicenses(await listedPackages(req, ctx, g, cache), g.view),
  ),
  listRoute(
    "godotStoreSearch",
    store("search/query/?"),
    STORE_QUERY_NAMES,
    async (req, ctx, g, cache) =>
      storeSearch(
        await listedPackages(req, ctx, g, cache),
        g.view,
        storeQueryOf(new URL(req.url).searchParams),
      ),
    (req) => keyRequest(req, ["licenses"], []),
  ),
  route(
    "godotStoreAsset",
    store(`assets/${SLUG}/${SLUG}/?`),
    ["publisher", "asset"],
    async (req, ctx, p) => {
      const deliverableId = await findDeliverable(
        ctx,
        (d) => d.name === p.asset,
      );
      if (!deliverableId) return notFound();
      return serveFeedRead(req, ctx, { deliverableId }, (cache) =>
        renderedAnswer(
          req,
          ctx,
          deliverableId,
          (g) =>
            g.view.publisher === p.publisher
              ? storeAssetKey(g.view.publisher, p.asset!)
              : null,
          cache,
        ),
      );
    },
  ),
  route(
    "godotStoreReleases",
    store(`releases/${SLUG}/${SLUG}/?`),
    ["publisher", "asset"],
    async (req, ctx, p) => {
      const deliverableId = await findDeliverable(
        ctx,
        (d) => d.name === p.asset,
      );
      if (!deliverableId) return notFound();
      const q = new URL(req.url).searchParams;
      const stableOnly = queryFlag(q.get("stable_only"), false);
      const compatibility = q.get("compatibility");
      const filtered = stableOnly || compatibility !== null;
      return serveFeedRead(
        req,
        ctx,
        { deliverableId, queryNames: ["stable_only", "compatibility"] },
        (cache) =>
          renderedAnswer(
            req,
            ctx,
            deliverableId,
            (g) =>
              g.view.publisher === p.publisher
                ? storeReleasesKey(g.view.publisher, p.asset!)
                : null,
            cache,
            filtered
              ? (body, g) =>
                  filterReleases(
                    Array.isArray(body) ? body : [],
                    g.view,
                    stableOnly,
                    compatibility,
                  )
              : undefined,
          ),
      );
    },
  ),
  listRoute(
    "godotIndex",
    new RegExp(`^/godot/${OWNER}/index\\.json$`),
    [],
    async (req, ctx, g, cache) =>
      godotIndex(await listedPackages(req, ctx, g, cache), g.view),
  ),
  byteRoute(
    "godotZip",
    new RegExp(
      `^/godot/${OWNER}/files/${HEX64}/([A-Za-z0-9._%+-]{1,200}\\.zip)$`,
    ),
    ["sha256", "file"],
    "godot-zip",
    "application/zip",
  ),
  byteRoute(
    "godotIcon",
    new RegExp(`^/godot/${OWNER}/icons/${HEX64}\\.png$`),
    ["sha256"],
    "godot-icon",
    "image/png",
  ),
];
