/// <reference types="@cloudflare/workers-types" />
/**
 * Where the PyPI routes get Release's state and the rendered pages (F-05).
 *
 *   - RELEASE STATE comes only through the read-only `releaseCatalog` hook (F-03:
 *     `packageDeliverables`, `packageVersions`), never Release's tables (rule 6). With Release off
 *     for the owner the hook is `null` and every project reads as absent.
 *   - THE PAGES are F-02's render-on-write objects (`materialise.ts`), read FRESH through the
 *     shared `freshRegistryObject` (`../catalogSource.ts`): a stored page is served only when its
 *     render stamp matches the state just read; a stale or missing page is rendered again from
 *     that state, answered from memory and written back (after the answer when the runtime
 *     allows). The queue drain that re-renders on publish is not wired into the composition root
 *     yet, so this check is what keeps a yank or a new version from being hidden behind an old
 *     object. Without a blob store the page is rendered and served from memory.
 */

import type { RegistryRouteContext } from "../../../../core/registryHost.js";
import type { CatalogPackageDeliverable } from "../../../../core/hooks.js";
import { freshRegistryObject, registryPackageOf } from "../catalogSource.js";
import type { RegistryPackage, RegistryRenderer } from "../materialise.js";
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
  return registryPackageOf(
    ctx.product.slug,
    "pypi",
    project,
    versions,
    [],
    normalizeProjectName(project.name),
  );
}

/**
 * One rendered page of `pkg` (`key` relative to the owner's prefix) as an answer: its own type,
 * the index `Cache-Control` and a strong ETag of the body's SHA-256 (§6.7), from R2 when the
 * stored render is current, else rendered now and written back (`freshRegistryObject`). `null`
 * when the package renders no such page.
 */
export function freshPageResponse(
  ctx: RegistryRouteContext,
  pkg: RegistryPackage,
  key: string,
  cache: "public" | "private",
): Promise<Response | null> {
  return freshRegistryObject(
    {
      bucket: ctx.env.BLOBS,
      renderer: RENDER_ONLY,
      origin: ctx.env.PKG_ORIGIN ?? "",
      ...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
    },
    pkg,
    key,
    cache,
  );
}
