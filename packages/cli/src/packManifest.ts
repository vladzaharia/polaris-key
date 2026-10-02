/**
 * The `.pkey/release` facts a pack publish and a content stamp need (P4-03): the declared pack
 * deliverables (P4-02's `ManifestPackDeliverable`, defaults filled in), the release keys, the
 * app's `contentApi`, and each pack's declared variants with the directory name a variant's
 * payload lives under (`--dir`, `--out` and `--bases` share it).
 */

import {
  parseManifest,
  type ManifestAppDeliverable,
  type ManifestPackDeliverable,
  type ManifestReleaseKey,
} from "@polaris-key/manifest";
import { variantKey } from "@polaris-key/client-core/packs";
import type { CiClient } from "./ci.js";

/** The parsed `.pkey/release` facts a pack publish needs. */
export function packContext(docs: {
  product: unknown;
  schema?: unknown;
  release?: unknown;
  distribution?: unknown;
}): {
  packs: ManifestPackDeliverable[];
  releaseKeys: ManifestReleaseKey[];
  slug: string;
  app: ManifestAppDeliverable | null;
} {
  const files: Record<string, string> = {};
  for (const [name, doc] of Object.entries(docs))
    if (doc !== undefined) files[name] = JSON.stringify(doc);
  const res = parseManifest(files);
  if (!res.ok)
    throw new Error(`.pkey/ does not parse:\n  ${res.errors.join("\n  ")}`);
  return {
    packs: res.manifest.release?.packDeliverables ?? [],
    releaseKeys: res.manifest.release?.releaseKeys ?? [],
    slug: res.manifest.product.slug,
    app: res.manifest.release?.app ?? null,
  };
}

/** Every declared variant, as its axis object, in variant-key order (`{}` when none). */
export function declaredVariants(
  pack: Pick<ManifestPackDeliverable, "variants">,
): Record<string, string>[] {
  const axes = Object.keys(pack.variants).sort();
  let out: Record<string, string>[] = [{}];
  for (const axis of axes) {
    const values =
      (pack.variants as Record<string, string[] | undefined>)[axis] ?? [];
    out = out.flatMap((v) => values.map((x) => ({ ...v, [axis]: x })));
  }
  return out.sort((a, b) =>
    variantKey(a) < variantKey(b) ? -1 : variantKey(a) > variantKey(b) ? 1 : 0,
  );
}

/** The directory name of a variant: its key, `default` for `{}`. */
export function variantDirName(variant: Record<string, string>): string {
  return variantKey(variant) || "default";
}

/** What the product's discovery document says the Worker's Release service accepts. */
export interface PacksDiscovery {
  /** `services.release.chunks` (P4-22): the Worker ingests `variants[].chunks`. */
  chunks: boolean;
}

/**
 * The discovery check (plans/P4-01.md §6): a Worker that predates P4-02 neither ingests pack
 * records nor mirrors pins, so the CLI publishes no pack and stamps no `content` without
 * `services.release.packs: true` in the product's discovery document. The answer also says
 * whether the Worker ingests chunk indexes (`release.chunks`, plans/P4-10.md §6): without it a
 * pack publish omits `chunks`, so no record carrying one lands on a Worker that does not check it.
 */
export async function requirePacksDiscovery(
  client: CiClient,
  fetchImpl: typeof fetch = fetch,
): Promise<PacksDiscovery> {
  const url = client.url(".well-known/polaris.json");
  let body: {
    services?: { release?: { packs?: unknown; chunks?: unknown } };
  } = {};
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
    });
    if (res.ok) body = (await res.json()) as typeof body;
  } catch {
    // An unreachable discovery document reads as "no packs".
  }
  if (body.services?.release?.packs !== true)
    throw new Error(
      `${url} does not advertise release.packs: this Polaris Key does not ingest pack records or mirror an app release's pins yet (it predates P4-02). Nothing was published.`,
    );
  return { chunks: body.services.release.chunks === true };
}
