/**
 * A product's hosted-asset settings (HA-10; notes/S-20 §6.10, owner decisions 6 and 9), resolved
 * through the settings registry (ST-03) and its resolver (ST-04):
 *
 *   assets.releases.mirror      product, operator   switch, default on   mirror the product's
 *                                                                        release files (HA-08)
 *   assets.quota.mediaBytes     product, operator   bytes, 512 MiB       hosted images (HA-01)
 *   assets.quota.releaseBytes   product, operator   bytes, 100 GiB       mirrored release files
 *
 * Both quotas inherit the platform entry of the same key live (`inherits: "platform"`), so a
 * product without its own value follows the platform default, and that, until an operator sets
 * one, is the code default. The platform kill switch `assets.hosting.enabled` is read by
 * `core/assets/assetHosting.ts`. Every value is written through `writeSetting()`
 * (`console/handlers/hostedAssets.ts`), never here.
 *
 * Core owns the `assets` namespace (`core/settings/registry.ts`), so every `assets.*` entry is in
 * the platform or Core slice: the registry these reads use is built from those two alone, and
 * Core never imports the composition root or a service (AGENTS.md rule 6). It is the same data
 * `mount.ts`' `SETTINGS` holds for these keys.
 *
 * Reads are per call and never cached across requests, like every product settings read (S-18
 * §4.3): the products row, the product's `product_settings` rows, and the platform store's
 * 30-second copy. The asset paths that ask (an ingest, a mirror, the console) are rare.
 */

import type { Db } from "../../db/types.js";
import type { SettingsEnv } from "../platformSettings.js";
import {
  buildSettingsRegistry,
  type SettingsRegistry,
} from "../settings/registry.js";
import {
  resolveProductSettings,
  type ProductFacts,
  type ResolvedSetting,
} from "../settings/resolve.js";

export const RELEASE_MIRROR_KEY = "assets.releases.mirror";
export const MEDIA_QUOTA_KEY = "assets.quota.mediaBytes";
export const RELEASE_QUOTA_KEY = "assets.quota.releaseBytes";

/** The product-scope hosted-asset settings, in the order the console shows them. */
export const ASSET_PRODUCT_KEYS = [
  RELEASE_MIRROR_KEY,
  MEDIA_QUOTA_KEY,
  RELEASE_QUOTA_KEY,
] as const;
export type AssetProductKey = (typeof ASSET_PRODUCT_KEYS)[number];

export function isAssetProductKey(key: string): key is AssetProductKey {
  return (ASSET_PRODUCT_KEYS as readonly string[]).includes(key);
}

let registry: SettingsRegistry | null = null;

/** The registry these reads use: the platform and Core slices, which hold every `assets.*` key. */
export function assetSettingsRegistry(): SettingsRegistry {
  registry ??= buildSettingsRegistry([]);
  return registry;
}

export interface ProductAssetSettings {
  /** Does the product mirror its release files (`assets.releases.mirror` is `on`)? */
  releaseMirror: boolean;
  /** The media quota in bytes. */
  mediaQuota: number;
  /** The release-file quota in bytes. */
  releaseQuota: number;
  /** Each key as the resolver answered it: value, source chain, version. */
  resolved: Readonly<Record<AssetProductKey, ResolvedSetting>>;
}

function defaultOf(key: AssetProductKey): unknown {
  return assetSettingsRegistry().get(key, "product")!.defaultValue;
}

/** A resolved quota as a byte count (the registry default when it is somehow not an integer). */
function bytesOf(r: ResolvedSetting | undefined, key: AssetProductKey): number {
  const v = r?.value;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : (defaultOf(key) as number);
}

/**
 * `product`'s hosted-asset settings, or `null` when there is no such product. `product` is a
 * slug or the `products` row the caller already holds.
 */
export async function productAssetSettings(
  env: SettingsEnv,
  db: Db,
  product: string | ProductFacts,
): Promise<ProductAssetSettings | null> {
  const resolved = await resolveProductSettings(
    { env, db, registry: assetSettingsRegistry() },
    product,
    { keys: ASSET_PRODUCT_KEYS },
  );
  if (resolved.length === 0) return null;
  const byKey = Object.fromEntries(resolved.map((r) => [r.key, r])) as Record<
    AssetProductKey,
    ResolvedSetting
  >;
  return {
    releaseMirror:
      (byKey[RELEASE_MIRROR_KEY]?.value ?? defaultOf(RELEASE_MIRROR_KEY)) ===
      "on",
    mediaQuota: bytesOf(byKey[MEDIA_QUOTA_KEY], MEDIA_QUOTA_KEY),
    releaseQuota: bytesOf(byKey[RELEASE_QUOTA_KEY], RELEASE_QUOTA_KEY),
    resolved: byKey,
  };
}

/**
 * The value a product's own setting falls back to when it has none (what "Reset" leaves): the
 * resolver's chain without the product's stored layer, i.e. the platform value it inherits, the
 * deploy value, or the default.
 */
export function inheritedValue(r: ResolvedSetting): unknown {
  for (let i = r.chain.length - 1; i >= 0; i--) {
    const step = r.chain[i]!;
    if (step.ignored) continue;
    if (step.source === "console" || step.source === "manifest") continue;
    return step.value;
  }
  return undefined;
}
