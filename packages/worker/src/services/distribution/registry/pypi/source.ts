/// <reference types="@cloudflare/workers-types" />
/**
 * Where the PyPI routes get Release's state and the rendered pages (F-05).
 *
 *   - RELEASE STATE comes only through the read-only `releaseCatalog` hook (F-03:
 *     `packageDeliverables`, `packageVersions`), never Release's tables (rule 6). With Release off
 *     for the owner the hook is `null` and every project reads as absent.
 *   - THE PAGES are F-02's render-on-write objects (`materialise.ts`), read FRESH: before a
 *     stored page is served, its render record's stamp is compared with the stamp of the state
 *     just read, and a stale or missing page is rendered again from that state, answered from
 *     memory and written back (after the answer when the runtime allows). The queue drain that
 *     re-renders on publish is not wired into the composition root yet (F-02 and F-03 each left
 *     it behind an interface), so this check is what keeps a yank or a new version from being
 *     hidden behind an old object; once the drain lands it is a cheap safety net (one R2 `head`
 *     per Cache API miss). Without a blob store the page is rendered and served from memory.
 */

import type { RegistryRouteContext } from "../../../../core/registryHost.js";
import type { CatalogPackageDeliverable } from "../../../../core/hooks.js";
import {
  CONTENT_TYPE_META,
  SHA256_META,
  materialise,
  registryCounters,
  registryObjectKey,
  renderIsStale,
  type MaterialiseDeps,
  type RegistryPackage,
  type RegistryRenderer,
} from "../materialise.js";
import { registryCacheHeaders } from "../cache.js";
import { normalizeProjectName, renderPypi } from "./render.js";

/** The renderer the read path re-renders with (routes are not needed to render). */
const RENDER_ONLY: RegistryRenderer = {
  ecosystem: "pypi",
  routes: [],
  render: (pkg) => renderPypi(pkg),
};

/** The owner's PyPI package deliverables, or `[]` when Release is off for it. */
export async function pypiProjects(
  ctx: RegistryRouteContext,
): Promise<CatalogPackageDeliverable[]> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return [];
  return (await catalog.packageDeliverables()).filter(
    (d) => d.ecosystem === "pypi",
  );
}

/** The deliverable whose project name normalises to `norm`, or `null`. */
export async function findProject(
  ctx: RegistryRouteContext,
  norm: string,
): Promise<CatalogPackageDeliverable | null> {
  return (
    (await pypiProjects(ctx)).find(
      (d) => normalizeProjectName(d.name) === norm,
    ) ?? null
  );
}

/**
 * One PyPI package as the renderer sees it, every version in every state, oldest publication
 * first; `null` when Release is off or nothing has been published. PyPI has no tags, so `tags`
 * is empty (pip and uv choose pre-releases by PEP 440 version, not by channel).
 */
export async function loadPypiPackage(
  ctx: RegistryRouteContext,
  project: CatalogPackageDeliverable,
): Promise<RegistryPackage | null> {
  const catalog = ctx.hooks.releaseCatalog();
  if (!catalog) return null;
  const versions = await catalog.packageVersions(project.id);
  if (versions.length === 0) return null;
  return {
    product: ctx.product.slug,
    ecosystem: "pypi",
    deliverableId: project.id,
    name: project.name,
    nameNorm: normalizeProjectName(project.name),
    versions: versions.map((v) => ({
      version: v.version,
      state: v.state,
      stateMessage: v.stateMessage,
      files: v.files,
      metadata: v.metadata,
      publishedAt: v.publishedAt,
    })),
    tags: {},
  };
}

async function sha256Hex(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One rendered page of `pkg` (`key` relative to the owner's prefix) as an answer: its own type,
 * the index `Cache-Control` and a strong ETag of the body's SHA-256 (§6.7), from R2 when the
 * stored render is current, else rendered now. `null` when the package renders no such page.
 */
export async function freshPageResponse(
  ctx: RegistryRouteContext,
  pkg: RegistryPackage,
  key: string,
  cache: "public" | "private",
): Promise<Response | null> {
  const bucket = ctx.env.BLOBS;
  const deps: MaterialiseDeps | null = bucket
    ? {
        bucket,
        renderers: new Map([["pypi", RENDER_ONLY]]),
        source: { package: async () => pkg },
        origin: ctx.env.PKG_ORIGIN ?? "",
      }
    : null;
  if (deps && bucket) {
    if (!(await renderIsStale(deps, pkg.product, pkg.deliverableId))) {
      const hit = await bucket.get(registryObjectKey("pypi", pkg.product, key));
      if (hit) {
        const meta = hit.customMetadata ?? {};
        const sha = meta[SHA256_META] ?? "";
        const type = meta[CONTENT_TYPE_META];
        if (type && /^[0-9a-f]{64}$/.test(sha))
          return new Response(hit.body, {
            status: 200,
            headers: {
              "content-type": type,
              ...registryCacheHeaders(cache, "index", sha),
            },
          });
        await hit.body.cancel().catch(() => undefined);
      }
      // A current record without its object: a lost object, healed below (§6.5 read path).
      registryCounters.renderMiss++;
    }
  }
  const obj = renderPypi(pkg).find((o) => o.key === key);
  if (!obj || typeof obj.body !== "string") return null;
  if (deps) {
    const write = materialise(deps, pkg.product, pkg.deliverableId).then(
      () => undefined,
      () => undefined,
    );
    if (ctx.waitUntil) ctx.waitUntil(write);
    else await write;
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": obj.contentType,
      ...registryCacheHeaders(cache, "index", await sha256Hex(obj.body)),
    },
  });
}
