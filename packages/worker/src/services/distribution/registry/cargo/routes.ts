/// <reference types="@cloudflare/workers-types" />
/**
 * The Cargo feed's routes on the registry host (F-30, plans/F-01.md §6.2 and §6.8): a sparse
 * index (Cargo's "Registry Index" reference, RFC 2789), read-only.
 *
 *   GET|HEAD /cargo/<owner>/config.json                         the registry's configuration
 *   GET|HEAD /cargo/<owner>/{1,2}/<name>                        a crate's index file …
 *   GET|HEAD /cargo/<owner>/3/<c>/<name>                        … by the length of its name
 *   GET|HEAD /cargo/<owner>/<ab>/<cd>/<name>                    … (four characters and more)
 *   GET|HEAD /cargo/<owner>/files/<sha256>/<crate>-<version>.crate   a crate (`dl`)
 *
 * EVERY ANSWER GOES THROUGH `serveFeedRead`, so the ladder (kill switch, Distribution,
 * `packageFeeds`, the feed, the mode) runs before the cache and before anything is disclosed. A
 * path naming no crate or file still runs the feed-level check (`deliverableId: null`) and then
 * answers the not-found, so an unknown name answers exactly what a feed that is off, or a
 * non-public feed, answers for a known one. Cargo reads a 404 as "no such crate".
 *
 * AUTHENTICATION (F-21): Cargo fetches `config.json` without a token first; a non-public feed
 * answers it 401, Cargo retries with the registry token in a bare `Authorization: <token>`
 * (the ladder's `raw` credential), and the admitted answer says `auth-required: true`, so Cargo
 * then sends the token on every index and download request. A public feed's answer leaves the key
 * out. Which one a request gets is the ladder's decision (`cache`), never a second settings read.
 *
 * NO PUBLISH API: `config.json` carries no `api`, so `cargo publish` refuses this registry. A
 * crate is published with `pkey release publish` (F-03), which uploads the `.crate` and its
 * extracted metadata through Release like every other package.
 */

import { sha256Hex } from "../../../../platform/hash.js";
import type {
  RegistryRoute,
  RegistryRouteContext,
} from "../../../../core/registryHost.js";
import type { CatalogPackageDeliverable } from "../../../../core/hooks.js";
import { registryNotFound } from "../../../../core/registryHost.js";
import { registryOrigin } from "../../../../core/registryHostname.js";
import { blobKey, blobResponse, hasRef } from "../../../../core/blobs.js";
import { registryCacheHeaders } from "../cache.js";
import { freshRegistryObject, registryPackageOf } from "../catalogSource.js";
import { feedRoute } from "../serve.js";
import type {
  PackageFile,
  RegistryPackage,
  RegistryRenderer,
} from "../materialise.js";
import {
  CARGO_INDEX_TYPE,
  configJson,
  crateFileName,
  crateOf,
  indexKey,
  indexPath,
  isCrateName,
  renderCargo,
} from "./render.js";

/** An owner segment: a product slug. */
const OWNER = "([a-z0-9-]{1,64})";

/** The renderer the read path re-renders with (routes are not needed to render). */
const RENDER_ONLY: RegistryRenderer = {
  ecosystem: "cargo",
  routes: [],
  render: (pkg, ctx) => renderCargo(pkg, ctx),
};

/** The owner's Cargo package deliverables, or `[]` when Release is off for it. */
async function crates(
  ctx: RegistryRouteContext,
): Promise<CatalogPackageDeliverable[]> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return [];
  return (await catalog.packageDeliverables()).filter(
    (d) => d.ecosystem === "cargo",
  );
}

/**
 * One crate as the renderer sees it, every version in every state, oldest publication first;
 * `null` when Release is off or nothing has been published. Cargo has no tags.
 */
async function loadCrate(
  ctx: RegistryRouteContext,
  crate: CatalogPackageDeliverable,
): Promise<RegistryPackage | null> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  const versions = await catalog.packageVersions(crate.id);
  if (versions.length === 0) return null;
  return registryPackageOf(ctx.product.slug, "cargo", crate, versions, []);
}

/** What a path names, looked up before the ladder. */
type Named<T> = { readonly kind: "absent" } | ({ readonly kind: "found" } & T);

function namedId<T extends { crate: { id: string } }>(
  _params: Record<string, string>,
  state: Named<T>,
): string | null {
  return state.kind === "found" ? state.crate.id : null;
}

// ── config.json ───────────────────────────────────────────────────────────────────────────────

const config: RegistryRoute = feedRoute({
  name: "cargo.config",
  ecosystem: "cargo",
  match(pathname) {
    const m = new RegExp(`^/cargo/${OWNER}/config\\.json$`).exec(pathname);
    return m ? { owner: m[1]!, params: {} } : null;
  },
  // The feed's own document: only the feed's mode decides (§6.6 step 3).
  deliverableId: () => null,
  async serve(_req, ctx, cache) {
    const origin = registryOrigin(ctx.env);
    if (origin === null) return registryNotFound("cargo");
    // A private answer is an admitted credential on a non-public feed: say so, so Cargo keeps
    // sending its token.
    const body = configJson(origin, ctx.product.slug, cache === "private");
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": CARGO_INDEX_TYPE,
        ...registryCacheHeaders(cache, "index", await sha256Hex(body)),
      },
    });
  },
});

// ── Index files ───────────────────────────────────────────────────────────────────────────────

type IndexState = Named<{ readonly crate: CatalogPackageDeliverable }>;

const index: RegistryRoute = feedRoute<IndexState>({
  name: "cargo.index",
  ecosystem: "cargo",
  match(pathname) {
    const m = new RegExp(
      `^/cargo/${OWNER}/((?:1|2)/[^/]+|3/[^/]/[^/]+|[^/]{2}/[^/]{2}/[^/]+)$`,
    ).exec(pathname);
    if (!m) return null;
    const path = m[2]!;
    return {
      owner: m[1]!,
      params: { path, name: path.slice(path.lastIndexOf("/") + 1) },
    };
  },
  async resolve(_req, ctx): Promise<IndexState> {
    const name = ctx.params.name!;
    // Cargo asks for the lower-case name under its own prefix; any other spelling is absent.
    if (
      !isCrateName(name) ||
      name !== name.toLowerCase() ||
      indexPath(name) !== ctx.params.path
    )
      return { kind: "absent" };
    // Lower-case match only, with no `-`/`_` folding (ingest's crateNorm uses that folding only
    // to refuse colliding names). This matches crates.io: the index file sits at the published
    // spelling, and Cargo retries the `-`/`_` variants itself when a lookup misses.
    const crate = (await crates(ctx)).find(
      (d) => d.name.toLowerCase() === name,
    );
    return crate ? { kind: "found", crate } : { kind: "absent" };
  },
  deliverableId: namedId,
  async serve(_req, ctx, cache, state) {
    if (state.kind !== "found") return registryNotFound("cargo");
    const origin = registryOrigin(ctx.env);
    const pkg = await loadCrate(ctx, state.crate);
    if (!pkg || origin === null) return registryNotFound("cargo");
    const res = await freshRegistryObject(
      {
        bucket: ctx.env.BLOBS,
        renderer: RENDER_ONLY,
        origin,
        ...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
      },
      pkg,
      indexKey(pkg.name),
      cache,
    );
    return res ?? registryNotFound("cargo");
  },
});

// ── Crate files (`dl`) ──────────────────────────────────────────────────────────────────────

/** The crate `<sha256>/<filename>` names in `pkg`: its version's `.crate`, by hash and name. */
export function crateIn(
  pkg: RegistryPackage,
  sha256: string,
  filename: string,
): PackageFile | null {
  for (const v of pkg.versions) {
    const crate = crateOf(v);
    if (
      crate &&
      crate.sha256 === sha256 &&
      crateFileName(pkg.name, v.version) === filename
    )
      return crate;
  }
  return null;
}

type FileState = Named<{
  readonly crate: CatalogPackageDeliverable;
  readonly file: PackageFile;
  readonly filename: string;
}>;

const files: RegistryRoute = feedRoute<FileState>({
  name: "cargo.files",
  ecosystem: "cargo",
  match(pathname) {
    const m = new RegExp(
      `^/cargo/${OWNER}/files/([0-9a-f]{64})/([^/]+\\.crate)$`,
    ).exec(pathname);
    return m ? { owner: m[1]!, params: { sha256: m[2]!, file: m[3]! } } : null;
  },
  async resolve(_req, ctx): Promise<FileState> {
    let filename: string;
    try {
      filename = decodeURIComponent(ctx.params.file!);
    } catch {
      return { kind: "absent" };
    }
    // `<crate>-<version>.crate`: the crates whose name the file starts with, longest first.
    const candidates = (await crates(ctx))
      .filter((d) => filename.startsWith(`${d.name}-`))
      .sort((a, b) => b.name.length - a.name.length);
    for (const crate of candidates) {
      const pkg = await loadCrate(ctx, crate);
      const file = pkg ? crateIn(pkg, ctx.params.sha256!, filename) : null;
      if (file) return { kind: "found", crate, file, filename };
    }
    return { kind: "absent" };
  },
  deliverableId: namedId,
  async serve(req, ctx, cache, state) {
    if (state.kind !== "found") return registryNotFound("cargo");
    const bucket = ctx.env.BLOBS;
    if (!bucket) return registryNotFound("cargo");
    // The bytes are this owner's: the crate names them, and the owner must hold the ref too
    // (`hasRef`), so no feed can serve an object it never published.
    for (const gated of [false, true]) {
      const key = blobKey(state.file.sha256, { gated });
      if (!(await hasRef(ctx.db, ctx.product.slug, key))) continue;
      const res = await blobResponse(req, bucket, key, {
        sha256: state.file.sha256,
        gated: gated || cache !== "public",
        env: ctx.env,
        host: "console",
        filename: state.filename,
      });
      return res.status === 404 ? registryNotFound("cargo") : res;
    }
    return registryNotFound("cargo");
  },
});

/** Every Cargo route, in match order (`config.json` before the index's two-segment shapes). */
export const CARGO_ROUTES: readonly RegistryRoute[] = [config, index, files];
