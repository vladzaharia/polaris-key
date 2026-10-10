/// <reference types="@cloudflare/workers-types" />
/**
 * The npm feed's routes on the registry host (F-04, plans/F-01.md §6.2, §6.7 and §6.8).
 *
 *   GET|HEAD /npm/<owner>/@scope%2fname          the packument (`%2f` and `%2F` are one key)
 *   GET|HEAD /npm/<owner>/@scope/name            the packument, unescaped (Bun, hand-typed URLs)
 *   GET|HEAD /npm/<owner>/@scope/name/-/<file>   a tarball (also under `@scope%2fname/-/`)
 *
 * SCOPED NAMES ONLY, and the scope must be the feed's (`dist_registry_feeds.namespace_json`
 * `{scope}`), the namespace rule ingest already enforces (§6.7). An unscoped name matches no
 * route; a name under another scope, an unknown name, an unknown version and a missing object
 * all answer the host's one not-found.
 *
 * EVERY READ GOES THROUGH `serveFeedRead` (each route is built by `feedRoute`), so the access ladder runs before the Cache API and a
 * refusal is the not-found or npm's native `401` with `WWW-Authenticate: Basic` (tier 1).
 *
 * NEGOTIATION. The packument is the abbreviated document (`application/vnd.npm.install-v1+json`)
 * when `Accept` asks for it first, i.e. lists it with a quality at least that of an explicit
 * `application/json` (and before it on a tie), as npm, pnpm, Yarn and Bun do for installs; else
 * the full document (`application/json`), as for `npm view`. Wildcards never pick the full
 * document over an explicitly listed abbreviated one. The answer carries `Vary: Accept`, and the
 * Cache API key carries `Accept` (`cache.ts`).
 *
 * TARBALLS are the content-addressed blob of the version's `npm-tarball` file, served as
 * `application/octet-stream` (the host forces `attachment`) with the immutable headers and the
 * SHA-256 as ETag. A yanked version's tarball is still served: npm has no yank, and a lockfile
 * naming it must keep installing (§6.7).
 */

import type { ReleaseCatalog } from "../../../../core/hooks.js";
import { blobKey } from "../../../../core/assets/blobs.js";
import { registryOrigin } from "../../../../core/registry/registryHostname.js";
import {
  registryNotFound,
  type RegistryRoute,
  type RegistryRouteContext,
  type RegistryRouteMatch,
} from "../../../../core/registry/registryHost.js";
import { registryCacheHeaders } from "../cache.js";
import {
  catalogPackageSource,
  findPackageDeliverable,
  freshRegistryObject,
} from "../catalogSource.js";
import type { RegistryRenderer } from "../materialise.js";
import { feedRoute } from "../serve.js";
import { cachedRegistrySettings, d1RegistrySettings } from "../settings.js";
import {
  NPM_ABBREVIATED_TYPE,
  packumentKey,
  tarballFileName,
  tarballOf,
} from "./render.js";

/** One segment of an npm name (the manifest's grammar: lower case, `._~-`). */
const PART = "[a-z0-9][a-z0-9._~-]*";
/** `@scope%2fname` (either case of the escape) or `@scope/name`, captured as scope and name. */
const NAME = `@(${PART})(?:%2[fF]|/)(${PART})`;
const OWNER = "([a-z0-9][a-z0-9-]*)";

const PACKUMENT_PATH = new RegExp(`^/npm/${OWNER}/${NAME}/?$`);
const TARBALL_PATH = new RegExp(`^/npm/${OWNER}/${NAME}/-/([^/]+\\.tgz)$`);

function matchPackument(pathname: string): RegistryRouteMatch | null {
  const m = PACKUMENT_PATH.exec(pathname);
  return m ? { owner: m[1]!, params: { name: `@${m[2]}/${m[3]}` } } : null;
}

function matchTarball(pathname: string): RegistryRouteMatch | null {
  const m = TARBALL_PATH.exec(pathname);
  if (!m) return null;
  let file: string;
  try {
    file = decodeURIComponent(m[4]!);
  } catch {
    return null;
  }
  if (file.includes("/")) return null;
  return { owner: m[1]!, params: { name: `@${m[2]}/${m[3]}`, file } };
}

interface MediaRange {
  type: string;
  q: number;
  index: number;
}

function mediaRanges(accept: string): MediaRange[] {
  return accept
    .split(",")
    .map((part, index) => {
      const [type = "", ...params] = part.split(";").map((s) => s.trim());
      let q = 1;
      for (const p of params) {
        const m = /^q=([0-9.]+)$/i.exec(p);
        if (m) q = Number(m[1]);
      }
      return { type: type.toLowerCase(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((r) => r.type !== "");
}

/** Does `Accept` ask for the abbreviated packument first? (See the file comment.) */
export function wantsAbbreviated(accept: string | null): boolean {
  if (!accept) return false;
  const ranges = mediaRanges(accept);
  const abbreviated = ranges.find((r) => r.type === NPM_ABBREVIATED_TYPE);
  if (!abbreviated || abbreviated.q <= 0) return false;
  const full = ranges.find((r) => r.type === "application/json");
  if (!full || full.q <= 0) return true;
  return (
    abbreviated.q > full.q ||
    (abbreviated.q === full.q && abbreviated.index < full.index)
  );
}

/** Is `name`'s scope the feed's? Read through the 30-second settings cache. */
async function inFeedScope(
  ctx: RegistryRouteContext,
  name: string,
): Promise<boolean> {
  const { feed } = await cachedRegistrySettings(
    d1RegistrySettings(ctx.db),
    ctx.product.slug,
    "npm",
  );
  const scope = feed?.namespace.scope;
  return (
    typeof scope === "string" &&
    scope !== "" &&
    name.toLowerCase().startsWith(`${scope.toLowerCase()}/`)
  );
}

/** The catalog and the deliverable a request names, before any access decision. */
async function lookup(
  ctx: RegistryRouteContext,
  name: string,
): Promise<{ catalog: ReleaseCatalog; deliverableId: string } | null> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  const decl = await findPackageDeliverable(catalog, "npm", name);
  return decl ? { catalog, deliverableId: decl.id } : null;
}

/** What a packument or tarball request names, looked up before the ladder. */
type NpmRead = { catalog: ReleaseCatalog; deliverableId: string } | null;

/** The packument route, given the renderer whose documents it serves. */
function packumentRoute(renderer: () => RegistryRenderer): RegistryRoute {
  return feedRoute<NpmRead>({
    name: "npm.packument",
    ecosystem: "npm",
    match: matchPackument,
    resolve: (_req, ctx) => lookup(ctx, ctx.params.name!),
    deliverableId: (_params, found) => found?.deliverableId ?? null,
    async serve(req, ctx, cache, found) {
      const name = ctx.params.name!;
      const origin = registryOrigin(ctx.env);
      if (!found || origin === null || !(await inFeedScope(ctx, name)))
        return registryNotFound("npm");
      const pkg = await catalogPackageSource(
        found.catalog,
        ctx.product.slug,
      ).package(ctx.product.slug, found.deliverableId);
      if (!pkg || pkg.ecosystem !== "npm") return registryNotFound("npm");
      const res = await freshRegistryObject(
        {
          bucket: ctx.env.BLOBS,
          renderer: renderer(),
          origin,
          ...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
        },
        pkg,
        packumentKey(pkg.nameNorm, wantsAbbreviated(req.headers.get("accept"))),
        cache,
      );
      if (!res) return registryNotFound("npm");
      res.headers.set("vary", "Accept");
      return res;
    },
  });
}

/** The tarball route. */
const tarballRoute: RegistryRoute = feedRoute<NpmRead>({
  name: "npm.tarball",
  ecosystem: "npm",
  match: matchTarball,
  resolve: (_req, ctx) => lookup(ctx, ctx.params.name!),
  deliverableId: (_params, found) => found?.deliverableId ?? null,
  async serve(req, ctx, cache, found) {
    const name = ctx.params.name!;
    const file = ctx.params.file!;
    const bucket = ctx.env.BLOBS;
    if (!found || !bucket || !(await inFeedScope(ctx, name)))
      return registryNotFound("npm");
    const versions = await found.catalog.packageVersions(found.deliverableId);
    const version = versions.find(
      (v) =>
        v.ecosystem === "npm" && tarballFileName(v.name, v.version) === file,
    );
    const tarball = version && tarballOf(version);
    if (!tarball) return registryNotFound("npm");
    const key = blobKey(tarball.sha256);
    const headers = {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${file.replace(/["\\]/g, "")}"`,
      ...registryCacheHeaders(cache, "immutable", tarball.sha256),
    };
    if (req.method === "HEAD") {
      const head = await bucket.head(key);
      if (!head) return registryNotFound("npm");
      return new Response(null, {
        status: 200,
        headers: { ...headers, "content-length": String(head.size) },
      });
    }
    const obj = await bucket.get(key);
    if (!obj) return registryNotFound("npm");
    return new Response(obj.body, { status: 200, headers });
  },
});

/** The npm feed's routes, given its renderer (late-bound: the renderer lists these routes). */
export function npmRoutes(renderer: () => RegistryRenderer): RegistryRoute[] {
  return [packumentRoute(renderer), tarballRoute];
}
