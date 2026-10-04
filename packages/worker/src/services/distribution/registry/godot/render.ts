/**
 * The Godot feed's renderer (F-09, plans/F-01.md §6.5): the per-package documents, written into
 * R2 under `registry/godot/<owner>/` by F-02's materialiser and served from there.
 *
 *   asset-library/api/asset/<id>               Godot ≤ 4.6 `asset/<id>` (the shown version)
 *   store/api/v1/assets/<publisher>/<asset>    Godot 4.7+ `assets/<publisher>/<asset>/`
 *   store/api/v1/releases/<publisher>/<asset>  Godot 4.7+ `releases/<publisher>/<asset>/`
 *
 * They depend on the feed's settings (the publisher, category, support level and license), so
 * the render needs `RenderContext.feed`; without it, or without a publisher, it renders nothing
 * and the routes' freshness check (`readFreshRegistryObject`) renders it again with them. A
 * package with no listed version (all yanked) renders nothing, so its documents read as absent.
 *
 * The owner-wide documents (`configure`, both searches, the store's `tags/` and `licenses/`,
 * `index.json`) span every package of the feed, so `routes.ts` composes them per request from the
 * same functions, behind the Cache API.
 */

import type {
  RenderContext,
  RenderedObject,
  RegistryPackage,
} from "../materialise.js";
import {
  godotFeedView,
  legacyAsset,
  legacyAssetId,
  storeAsset,
  storeReleases,
} from "./documents.js";

export const legacyAssetKey = (assetId: string) =>
  `asset-library/api/asset/${assetId}`;
export const storeAssetKey = (publisher: string, name: string) =>
  `store/api/v1/assets/${publisher}/${name}`;
export const storeReleasesKey = (publisher: string, name: string) =>
  `store/api/v1/releases/${publisher}/${name}`;

/** Deterministic JSON: the renderers' bodies are compared byte for byte (golden files, ETags). */
export function jsonBody(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function renderGodot(
  pkg: RegistryPackage,
  ctx: RenderContext,
): RenderedObject[] {
  if (pkg.ecosystem !== "godot") return [];
  const view = godotFeedView(pkg.product, ctx.origin, ctx.feed ?? null);
  if (!view) return [];
  const id = legacyAssetId(pkg.deliverableId);
  const legacy = legacyAsset(pkg, view, id);
  const asset = storeAsset(pkg, view);
  if (!legacy || !asset) return [];
  const contentType = "application/json";
  return [
    { key: legacyAssetKey(id), body: jsonBody(legacy), contentType },
    {
      key: storeAssetKey(view.publisher, pkg.name),
      body: jsonBody(asset),
      contentType,
    },
    {
      key: storeReleasesKey(view.publisher, pkg.name),
      body: jsonBody(storeReleases(pkg, view)),
      contentType,
    },
  ];
}
