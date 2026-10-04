/// <reference types="@cloudflare/workers-types" />
/**
 * Release's package state as the renderers see it, and a rendered object read that is never
 * stale (F-04, plans/F-01.md §6.5). Shared by every ecosystem's routes; nothing here is
 * npm-specific.
 *
 *   - `catalogPackageSource` is the `PackageSource` over Release's read-only `releaseCatalog`
 *     hook (`packageDeliverables`, `packageVersions`, `packageChannelHeads`). Channels become
 *     tags here, once for every ecosystem: `stable` → `latest`, any other channel → a tag of its
 *     own name. A head that names a version the package does not list is dropped.
 *   - `freshRegistryObject` answers one rendered object. It compares the stored object's render
 *     stamp with the stamp of the package's CURRENT rows: a match is served from R2; a missing or
 *     stale object is rendered from those rows, answered at once and written back (the whole
 *     package, through `materialise`), and counted as a render miss.
 *
 * WHY THE STAMP CHECK ON READ. The render queue's drain (`drainRegistry`, the composition root's
 * `registryMaterialiser`) is not wired yet, so nothing re-renders a package after a publish, a
 * yank or a channel move; without the check a feed would serve its first render forever. The
 * cost is the package's rows per Cache API miss (at most one per minute per edge and document,
 * §6.7). Once the drain runs, a stamp match is simply the common case.
 */

import type {
  CatalogPackageDeliverable,
  ReleaseCatalog,
} from "../../../core/hooks.js";
import {
  isRegistryEcosystem,
  type RegistryEcosystem,
} from "../../../core/registryHost.js";
import { registryCacheHeaders } from "./cache.js";
import {
  RENDER_STAMP_META,
  materialise,
  registryCounters,
  registryObjectKey,
  renderStamp,
  renderedObjectResponse,
  type PackageSource,
  type RegistryPackage,
  type RegistryRenderer,
} from "./materialise.js";

/** The tag a channel maps to (plans/F-01.md §6.3: `stable` → `latest`). */
export function channelTag(channel: string): string {
  return channel === "stable" ? "latest" : channel;
}

/** One package deliverable of `ecosystem` by name, compared case-insensitively, or `null`. */
export async function findPackageDeliverable(
  catalog: ReleaseCatalog,
  ecosystem: RegistryEcosystem,
  name: string,
): Promise<CatalogPackageDeliverable | null> {
  const wanted = name.toLowerCase();
  return (
    (await catalog.packageDeliverables()).find(
      (d) => d.ecosystem === ecosystem && d.name.toLowerCase() === wanted,
    ) ?? null
  );
}

/** Release's package state for `product`, read through its catalog hook. */
export function catalogPackageSource(
  catalog: ReleaseCatalog,
  product: string,
): PackageSource {
  return {
    async package(owner, deliverableId) {
      if (owner !== product) return null;
      const decl = (await catalog.packageDeliverables()).find(
        (d) => d.id === deliverableId,
      );
      if (!decl || !isRegistryEcosystem(decl.ecosystem)) return null;
      const rows = await catalog.packageVersions(deliverableId);
      const heads = await catalog.packageChannelHeads(deliverableId);
      const listed = new Set(rows.map((r) => r.version));
      const tags: Record<string, string> = {};
      for (const h of heads)
        if (listed.has(h.version)) tags[channelTag(h.channel)] = h.version;
      return {
        product,
        ecosystem: decl.ecosystem,
        deliverableId,
        name: decl.name,
        nameNorm: rows[0]?.nameNorm ?? decl.name.toLowerCase(),
        versions: rows.map((r) => ({
          version: r.version,
          state: r.state,
          stateMessage: r.stateMessage,
          files: r.files,
          metadata: r.metadata,
          publishedAt: r.publishedAt,
        })),
        tags,
      };
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface FreshReadDeps {
  /** The blob bucket; without one (a test, an unbound environment) nothing is stored. */
  readonly bucket: R2Bucket | undefined;
  readonly renderer: RegistryRenderer;
  readonly origin: string;
  /** Finish the write-back after answering; absent, it runs before the answer. */
  readonly waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * One rendered object of `pkg` as a 200 with the index-document headers (§6.7), or `null` when
 * the package does not render `key`. Served from R2 when the stored render's stamp is the
 * current one; otherwise rendered now, answered, and the package written back.
 */
export async function freshRegistryObject(
  deps: FreshReadDeps,
  pkg: RegistryPackage,
  key: string,
  cache: "public" | "private",
): Promise<Response | null> {
  const stamp = await renderStamp(pkg);
  const objectKey = registryObjectKey(pkg.ecosystem, pkg.product, key);
  if (deps.bucket) {
    const hit = await deps.bucket.get(objectKey);
    if (hit && hit.customMetadata?.[RENDER_STAMP_META] === stamp)
      return renderedObjectResponse(hit, cache);
    if (hit) await hit.body.cancel().catch(() => undefined);
    registryCounters.renderMiss++;
  }
  const objects = await deps.renderer.render(pkg, { origin: deps.origin });
  const obj = objects.find((o) => o.key === key);
  if (deps.bucket) {
    const write = materialise(
      {
        bucket: deps.bucket,
        renderers: new Map([[pkg.ecosystem, deps.renderer]]),
        // The rows just read, so the write-back renders exactly what was answered.
        source: { package: async () => pkg },
        origin: deps.origin,
      },
      pkg.product,
      pkg.deliverableId,
    ).catch(() => undefined);
    if (deps.waitUntil) deps.waitUntil(write);
    else await write;
  }
  if (!obj) return null;
  const bytes =
    typeof obj.body === "string"
      ? new TextEncoder().encode(obj.body)
      : obj.body;
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": obj.contentType,
      ...registryCacheHeaders(cache, "index", await sha256Hex(bytes)),
    },
  });
}
