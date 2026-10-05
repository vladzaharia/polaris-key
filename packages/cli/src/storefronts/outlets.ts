/**
 * `.pkey/` as a storefront step reads it (A-18h): the product slug and the outlet whose identity
 * binds the step's parameters (itch's `target`, a snap's `channels`, the Microsoft Store
 * `productId`).
 */

import { parseManifest } from "@polaris-key/manifest";
import { loadManifest, validateLoadedManifest } from "../manifest.js";

export interface StepOutlet {
  id: string;
  kind: string;
  identity: Record<string, unknown>;
}

export interface StepProduct {
  slug: string;
  outlets: StepOutlet[];
}

/** Load, validate and parse `.pkey/`; `product` (a flag) must match its slug when given. */
export async function loadStepProduct(
  cwd: string,
  product?: string,
): Promise<StepProduct> {
  const loaded = await loadManifest(cwd);
  const validation = validateLoadedManifest(loaded);
  if (!validation.ok)
    throw new Error(
      `.pkey/ is invalid; run pkey validate:\n${validation.errors
        .map((e) => `  ${e.file}${e.path}: ${e.message}`)
        .join("\n")}`,
    );
  const files: Record<string, string> = {};
  for (const [name, doc] of Object.entries({
    product: loaded.product,
    schema: loaded.schema,
    release: loaded.release,
    distribution: loaded.distribution,
  }))
    if (doc !== undefined) files[name] = JSON.stringify(doc);
  const parsed = parseManifest(files);
  if (!parsed.ok)
    throw new Error(`.pkey/ does not parse:\n  ${parsed.errors.join("\n  ")}`);
  const m = parsed.manifest;
  if (product && product !== m.product.slug)
    throw new Error(
      `--product ${product} does not match .pkey/product's slug ${m.product.slug}.`,
    );
  return {
    slug: m.product.slug,
    outlets: (m.distribution?.outlets ?? []).map((o) => ({
      id: o.id,
      kind: o.kind,
      identity: { ...(o.identity as Record<string, unknown>) },
    })),
  };
}

/**
 * The outlet a step runs for: `--outlet <id>` (which must be one of `kinds`), else the only
 * declared outlet of those kinds.
 */
export function pickOutlet(
  p: StepProduct,
  kinds: readonly string[],
  outletId: string | undefined,
  label: string,
): StepOutlet {
  if (outletId) {
    const o = p.outlets.find((x) => x.id === outletId);
    if (!o)
      throw new Error(
        `--outlet ${outletId} is not declared in .pkey/distribution.`,
      );
    if (!kinds.includes(o.kind))
      throw new Error(
        `--outlet ${outletId} is a ${o.kind} outlet, not a ${label} one (${kinds.join(", ")}).`,
      );
    return o;
  }
  const matching = p.outlets.filter((o) => kinds.includes(o.kind));
  if (matching.length === 1) return matching[0]!;
  throw new Error(
    matching.length === 0
      ? `.pkey/distribution declares no ${label} outlet (${kinds.join(", ")}).`
      : `.pkey/distribution declares ${matching.length} ${label} outlets (${matching.map((o) => o.id).join(", ")}); pass --outlet.`,
  );
}
