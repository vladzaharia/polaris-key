/**
 * What a licence grants, in the customer's words: the catalog flags the developer marked
 * `userGrant`, exactly as the licence document carries them, plus its release channels.
 * Shared by the licence views (`api.ts`) and the library and product views (`library.ts`, PX-W1).
 *
 * LX-04 (S-19 G14): the values come from `resolveEntitlements`, the function the licence document
 * route signs, so the portal cannot show a grant the device does not hold or miss one it does.
 * Two drifts this closes: the view used to fall back to a catalog flag's `default` (the layer
 * stack carries catalog defaults for `config` only, so no document ever includes one), and it read
 * channels from the licence row alone (the document unions tier and licence channels, plus any a
 * profile or override authors). The resolver-based portal (several contributing licences and
 * grants) is LX-15; until then this is the one place the portal turns a licence into grants.
 */

import { Catalog } from "@polaris-key/catalog";
import type { ConfigEntry } from "@polaris-key/catalog";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { Db } from "../../../db/types.js";
import { getActiveSchema } from "../../../repo.js";
import { resolveEntitlements } from "../../../core/authz.js";
import type { PortalLicenseRow } from "./repo.js";

/** The reserved entitlement the document carries a licence's release channels in. */
const CHANNELS_KEY = "channels";

export interface EntitlementViewItem {
  key: string;
  label: string;
  value: unknown;
}

export async function visibleCatalogFlags(
  db: Db,
  product: string,
): Promise<Map<string, ConfigEntry>> {
  const row = await getActiveSchema(db, product);
  if (!row) return new Map();
  try {
    const catalog = new Catalog(JSON.parse(row.catalog_json));
    return new Map(
      catalog.entries
        .filter((entry) => entry.kind === "flag" && entry.userGrant === true)
        .map((entry) => [entry.key, entry]),
    );
  } catch {
    return new Map();
  }
}

/**
 * Turn a licence document's `entitlements` into the portal's grant list. Pure, so the agreement
 * with the document is testable key by key.
 *
 * A flag absent from the document is not granted, whatever its catalog `default` says: the device
 * reads the document, and an absent flag is `false` there. `false` and `null` are not listed.
 * Channels come from the document's `channels` entry, listed once, under the catalog's
 * `grantLabel` when the product declares `channels` as a `userGrant` flag (djdl does).
 */
export function grantsFromEntitlements(
  entitlements: Record<string, ManagedEntry>,
  flags: Map<string, ConfigEntry>,
): EntitlementViewItem[] {
  const out: EntitlementViewItem[] = [];
  for (const [key, entry] of flags) {
    if (key === CHANNELS_KEY) continue;
    const value = entitlements[key]?.value;
    if (value === undefined || value === false || value === null) continue;
    out.push({ key, label: entry.grantLabel ?? entry.label ?? key, value });
  }
  const channels = entitlements[CHANNELS_KEY]?.value;
  if (Array.isArray(channels) && channels.length > 0) {
    const entry = flags.get(CHANNELS_KEY);
    out.push({
      key: CHANNELS_KEY,
      label: entry?.grantLabel ?? entry?.label ?? "Release channels",
      value: channels,
    });
  }
  return out;
}

/**
 * The licence's release channels and version window, as the document carries them: `channels`
 * (tier and licence unioned, plus any a profile or override authors), `app.minVersion` and
 * `app.maxVersion` (the tighter of tier and licence). The licence row's own columns are only one
 * input to each, so the portal must not show them as the answer.
 */
export function documentWindow(entitlements: Record<string, ManagedEntry>): {
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
} {
  const channels = entitlements[CHANNELS_KEY]?.value;
  const str = (key: string): string | null => {
    const value = entitlements[key]?.value;
    return typeof value === "string" ? value : null;
  };
  return {
    channels: Array.isArray(channels)
      ? channels.filter((c): c is string => typeof c === "string")
      : [],
    minVersion: str("app.minVersion"),
    maxVersion: str("app.maxVersion"),
  };
}

/** Everything the portal shows about what a licence grants, from one document resolution. */
export async function licenseGrants(
  db: Db,
  license: PortalLicenseRow,
  now: number,
): Promise<
  { entitlements: EntitlementViewItem[] } & ReturnType<typeof documentWindow>
> {
  const entitlements = await resolveEntitlements(
    db,
    license.product,
    license,
    null,
    now,
  );
  const flags = await visibleCatalogFlags(db, license.product);
  return {
    entitlements: grantsFromEntitlements(entitlements, flags),
    ...documentWindow(entitlements),
  };
}

export async function entitlementView(
  db: Db,
  license: PortalLicenseRow,
  now: number,
): Promise<EntitlementViewItem[]> {
  return (await licenseGrants(db, license, now)).entitlements;
}
