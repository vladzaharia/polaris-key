/**
 * What a product ships on (A-20.2): `productPlatforms` answers, per platform, the arches and
 * formats it ships and WHERE each fact comes from. Read-only; never throws for an absent service.
 *
 * Sources, in the order a fact gets firmer:
 * - `planned`: the operator's `distribution.intendedPlatforms`, before any build exists;
 * - `outlet`: an outlet that names its platforms (`direct` with `identity.platforms`). A bare
 *   `direct` serves everything in principle and widens nothing here (SETUP K1), so
 *   `outletPlatformsOf`'s default is NOT used;
 * - `declared`: the app declaration's artifact map, published or not;
 * - `builds`: the newest non-yanked app release on each release channel.
 *
 * Release off (`hooks.releaseCatalog()` is null) leaves `builds` and `declared` empty.
 */

import type { Db } from "../../db/types.js";
import type { ServiceHooks } from "../../core/hooks.js";
import { parseJsonColumn } from "../../platform/json.js";
import { listOutlets } from "./outlets.js";

export const INTENDED_PLATFORMS_KEY = "distribution.intendedPlatforms";

export type PlatformSource = "builds" | "declared" | "outlet" | "planned";

export interface ProductPlatform {
  platform: string;
  arches: string[];
  formats: string[];
  sources: PlatformSource[];
}

export interface ProductPlatforms {
  platforms: ProductPlatform[];
  /** The deliverable kinds the product has (`app`, `pack`); `[]` while Release is off. */
  kinds: string[];
}

export interface FactsContext {
  db: Db;
  product: string;
  hooks: ServiceHooks;
  /** Epoch seconds; an expired setting row is no row. */
  now: number;
}

const SOURCE_ORDER: readonly PlatformSource[] = [
  "builds",
  "declared",
  "outlet",
  "planned",
];

export async function productPlatforms(
  ctx: FactsContext,
): Promise<ProductPlatforms> {
  const { db, product, hooks } = ctx;
  const acc = new Map<
    string,
    { arches: Set<string>; formats: Set<string>; sources: Set<PlatformSource> }
  >();
  const entry = (platform: string, source: PlatformSource) => {
    let e = acc.get(platform);
    if (!e) {
      e = { arches: new Set(), formats: new Set(), sources: new Set() };
      acc.set(platform, e);
    }
    e.sources.add(source);
    return e;
  };

  let kinds: string[] = [];
  const catalog = hooks.releaseCatalog();
  if (catalog) {
    kinds = [...new Set((await catalog.deliverables()).map((d) => d.kind))];

    for (const b of await catalog.declaredBuilds()) {
      const e = entry(b.platform, "declared");
      e.arches.add(b.arch);
      e.formats.add(b.format);
    }

    const seen = new Set<string>();
    for (const channel of await catalog.knownChannels()) {
      const history = await catalog.channelReleases("app", channel);
      const newest = history?.releases.find((r) => !r.yanked);
      if (!newest || seen.has(newest.releaseId)) continue;
      seen.add(newest.releaseId);
      for (const b of await catalog.builds(newest.releaseId)) {
        if (b.platform === null) continue;
        const e = entry(b.platform, "builds");
        e.arches.add(b.arch);
        if (b.format !== null) e.formats.add(b.format);
      }
    }
  }

  for (const o of await listOutlets(db, product)) {
    if (o.removed_at !== null || o.kind !== "direct") continue;
    const identity = parseJsonColumn(o.identity_json);
    const listed =
      identity && typeof identity === "object" && !Array.isArray(identity)
        ? (identity as Record<string, unknown>).platforms
        : undefined;
    if (!Array.isArray(listed)) continue;
    for (const p of listed) if (typeof p === "string") entry(p, "outlet");
  }

  const planned = await db.first<{
    value_json: string | null;
    expires_at: number | null;
  }>(
    "SELECT value_json, expires_at FROM product_settings WHERE product = ? AND key = ?",
    product,
    INTENDED_PLATFORMS_KEY,
  );
  if (
    planned &&
    (planned.expires_at === null || planned.expires_at > ctx.now)
  ) {
    const list = parseJsonColumn(planned.value_json);
    if (Array.isArray(list))
      for (const p of list) if (typeof p === "string") entry(p, "planned");
  }

  return {
    platforms: [...acc.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([platform, e]) => ({
        platform,
        arches: [...e.arches].sort(),
        formats: [...e.formats].sort(),
        sources: SOURCE_ORDER.filter((s) => e.sources.has(s)),
      })),
    kinds: kinds.sort(),
  };
}
