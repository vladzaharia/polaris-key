/**
 * What a licence grants, in the customer's words: the catalog flags the developer marked
 * `userGrant`, as the licence's effective payload resolves them, plus its release channels.
 * Shared by the licence views (`api.ts`) and the library and product views (`library.ts`, PX-W1).
 */

import { Catalog } from "@polaris-key/catalog";
import type { ConfigEntry } from "@polaris-key/catalog";
import type { Db } from "../../../core/platform.js";
import { getActiveSchema } from "../../../core/data.js";
import { resolveEffective } from "../../../core/authz.js";
import { tighterMax, tighterMin } from "../../../core/entitlements.js";
import type { PortalLicenseRow } from "./repo.js";

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function visibleCatalogFlags(
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

export async function entitlementView(
  db: Db,
  license: PortalLicenseRow,
  now: number,
): Promise<Array<{ key: string; label: string; value: unknown }>> {
  const payload = await resolveEffective(
    db,
    license.product,
    license,
    null,
    now,
    { tighterMin, tighterMax },
  );
  const flags = await visibleCatalogFlags(db, license.product);
  const out: Array<{ key: string; label: string; value: unknown }> = [];
  for (const [key, entry] of flags) {
    const managed = payload.entitlements[key];
    const value = managed?.value ?? entry.default ?? false;
    if (value === false || value == null) continue;
    out.push({ key, label: entry.grantLabel ?? entry.label ?? key, value });
  }
  const channels = parseJson<string[]>(license.channels_json, []);
  if (channels.length > 0) {
    out.push({ key: "channels", label: "Release channels", value: channels });
  }
  return out;
}
