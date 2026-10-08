/// <reference types="@cloudflare/workers-types" />
/**
 * Release's package state as the renderers see it, and a rendered object read that is never
 * stale (F-04, plans/F-01.md §6.5). The one copy every ecosystem's routes (F-04 to F-09) share;
 * nothing here is specific to one ecosystem. Distribution never reads Release's tables itself
 * (rule 6): everything goes through the read-only `releaseCatalog` hook.
 *
 *   - `registryPackageOf` turns the hook's rows into a `RegistryPackage`; `loadRegistryPackage`,
 *     `loadRegistryPackages` and `catalogPackageSource` (the materialiser's `PackageSource`) read
 *     them (`packageDeliverables`, `packageVersions`, `packageChannelHeads`). Channels become
 *     tags here, once for every ecosystem: `stable` → `latest`, any other channel → a tag of its
 *     own name. A head that names a version the package does not list is dropped.
 *   - `freshRegistryObject` answers one rendered object. It compares the stored object's render
 *     stamp with the stamp of the package's CURRENT rows: a match is served from R2; a missing or
 *     stale object is rendered from those rows, answered at once and written back (the whole
 *     package, through `materialise`), and counted as a render miss.
 *
 * WHY THE STAMP CHECK ON READ. The render queue's drain (`drainRegistry`, through Distribution's
 * `registryMaterialiser`) re-renders a package after a publish, a yank or a channel move, but
 * only once the request that enqueued has answered (or on the next cron tick). The check keeps a
 * read between the write and the drain from serving the previous render, and heals a lost or
 * failed render. The cost is the package's rows per Cache API miss (at most one per minute per
 * edge and document, §6.7); with the drain running, a stamp match is the common case.
 */

import { sha256Hex } from "../../../core/platform.js";
import type {
  CatalogPackageDeliverable,
  CatalogPackageVersion,
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
  type PackageVersion,
  type RegistryPackage,
  type RegistryRenderer,
} from "./materialise.js";

/** The tag a channel maps to (plans/F-01.md §6.3: `stable` → `latest`). */
export function channelTag(channel: string): string {
  return channel === "stable" ? "latest" : channel;
}

/** One package deliverable of `ecosystem` by name, compared case-insensitively, or `null`. */
export async function findPackageDeliverable(
  catalog: Pick<ReleaseCatalog, "packageDeliverables">,
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

/** The catalog readers a package source needs. */
export type PackageCatalog = Pick<
  ReleaseCatalog,
  "packageDeliverables" | "packageVersions" | "packageChannelHeads"
>;

/**
 * Release's state of one package as a renderer sees it: every version in every state, oldest
 * publication first, and the channel heads as tags (`channelTag`). A head that names a version
 * the package does not list is dropped. `nameNorm` defaults to the ingest's normalised name.
 */
export function registryPackageOf(
  owner: string,
  ecosystem: RegistryEcosystem,
  deliverable: { readonly id: string; readonly name: string },
  rows: readonly CatalogPackageVersion[],
  heads: ReadonlyArray<{ readonly channel: string; readonly version: string }>,
  nameNorm: string = rows[0]?.nameNorm ?? deliverable.name.toLowerCase(),
): RegistryPackage {
  const listed = new Set(rows.map((r) => r.version));
  const tags: Record<string, string> = {};
  for (const h of heads)
    if (listed.has(h.version)) tags[channelTag(h.channel)] = h.version;
  return {
    product: owner,
    ecosystem,
    deliverableId: deliverable.id,
    name: deliverable.name,
    nameNorm,
    versions: rows.map(
      (r): PackageVersion => ({
        version: r.version,
        state: r.state,
        stateMessage: r.stateMessage,
        files: r.files,
        metadata: r.metadata,
        publishedAt: r.publishedAt,
      }),
    ),
    tags,
  };
}

/**
 * One package deliverable of `product` as a `RegistryPackage`, or `null` when it is not a
 * package (of `ecosystem`, when given). `declared` skips the declaration lookup.
 */
export async function loadRegistryPackage(
  catalog: PackageCatalog,
  product: string,
  deliverableId: string,
  ecosystem?: RegistryEcosystem,
  declared?: CatalogPackageDeliverable,
): Promise<RegistryPackage | null> {
  const decl =
    declared ??
    (await catalog.packageDeliverables()).find((d) => d.id === deliverableId);
  if (!decl || !isRegistryEcosystem(decl.ecosystem)) return null;
  if (ecosystem !== undefined && decl.ecosystem !== ecosystem) return null;
  return registryPackageOf(
    product,
    decl.ecosystem,
    decl,
    await catalog.packageVersions(deliverableId),
    await catalog.packageChannelHeads(deliverableId),
  );
}

/** Every package of `ecosystem` the product declares, loaded, in deliverable-id order. */
export async function loadRegistryPackages(
  catalog: PackageCatalog,
  product: string,
  ecosystem: RegistryEcosystem,
): Promise<RegistryPackage[]> {
  const out: RegistryPackage[] = [];
  const decls = (await catalog.packageDeliverables())
    .filter((d) => d.ecosystem === ecosystem)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const d of decls) {
    const pkg = await loadRegistryPackage(catalog, product, d.id, ecosystem, d);
    if (pkg) out.push(pkg);
  }
  return out;
}

/**
 * Release's package state for `product`, read through its catalog hook (limited to `ecosystem`'s
 * packages when given). Another owner reads as absent.
 */
export function catalogPackageSource(
  catalog: PackageCatalog,
  product: string,
  ecosystem?: RegistryEcosystem,
): PackageSource {
  return {
    async package(owner, deliverableId) {
      if (owner !== product) return null;
      return loadRegistryPackage(catalog, product, deliverableId, ecosystem);
    },
    async deliverables(owner) {
      if (owner !== product) return [];
      return (await catalog.packageDeliverables())
        .filter(
          (d) =>
            isRegistryEcosystem(d.ecosystem) &&
            (ecosystem === undefined || d.ecosystem === ecosystem),
        )
        .map((d) => d.id)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    },
  };
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
