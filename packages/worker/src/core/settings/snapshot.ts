/**
 * A claimable setting's value in ST-01a's manifest snapshot (`product_manifest_snapshot`, the
 * normalised `ParsedManifest` last applied): what Revert puts back (`settingsClaims.ts`) and what
 * the resolver compares a console claim with to report drift (`resolve.ts`, ST-04).
 *
 * The column-backed claim keys are listed; a row-backed key is found at its entry's manifest path
 * when the caller passes the entry; any other key answers `undefined` ("no manifest value
 * known"), so neither Revert nor drift ever guesses.
 */

/** The fields of a stored snapshot the claimable keys read. */
export interface SnapshotManifest {
  product?: {
    name?: unknown;
    defaultMaxOfflineDays?: unknown;
    defaultDeviceLimit?: unknown;
  };
  webOrigins?: unknown;
  catalog?: unknown;
}

function intAtLeast(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min;
}

/**
 * `key`'s value in `manifest`, or `undefined` when the snapshot carries no usable one. The checks
 * are the write path's own (a blank name, a non-integer limit is not a value).
 */
export function snapshotValue(
  key: string,
  manifest: unknown,
  def?: { manifest?: { path: string } },
): unknown {
  if (!manifest || typeof manifest !== "object") return undefined;
  const m = manifest as SnapshotManifest;
  const p = m.product ?? {};
  switch (key) {
    case "core.name":
      return typeof p.name === "string" && p.name.trim() !== ""
        ? p.name
        : undefined;
    case "license.defaults.maxOfflineDays":
      return intAtLeast(p.defaultMaxOfflineDays, 0)
        ? p.defaultMaxOfflineDays
        : undefined;
    case "license.defaults.deviceLimit":
      return intAtLeast(p.defaultDeviceLimit, 1)
        ? p.defaultDeviceLimit
        : undefined;
    case "core.web.origins":
      return Array.isArray(m.webOrigins)
        ? m.webOrigins.filter((o): o is string => typeof o === "string")
        : [];
    case "config.catalog":
      return m.catalog && typeof m.catalog === "object" ? m.catalog : undefined;
    default:
      return def ? valueAtPath(manifest, def) : undefined;
  }
}

/**
 * A row-backed key's value in the snapshot: the parsed product document keeps the manifest's own
 * paths (`licensing.<name>`, `oidc.syncTierOnSignIn`), so `product:<dotted path>` walks it (the
 * same walk as LX-06's `manifestValueAt`).
 */
function valueAtPath(
  manifest: object,
  def: { manifest?: { path: string } },
): unknown {
  const path = def.manifest?.path;
  if (!path?.startsWith("product:")) return undefined;
  let node: unknown = manifest;
  for (const seg of path.slice("product:".length).split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node))
      return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}
