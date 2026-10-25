/**
 * Reserved display names at the Worker (plans/PX-W13.md §3, §8 Q4 as amended; G28).
 *
 * What a reserved or invalid display name is, is decided in ONE place, `@polaris-key/manifest`'s
 * `displayName.ts`. This module only answers the platform's severity for a reserved one: the
 * platform setting `identity.reservedDisplayNames` (stored as `IDENTITY_RESERVED_DISPLAY_NAMES`),
 * `warn` until the lead flips it after the S-19 decision-15 window. Manifest ingest (link, resync,
 * the platform deploy hook) and the console's listing claims read it here.
 *
 * Neither mode changes what the sign-in card shows: its render-time re-check puts a reserved name
 * in the neutral frame either way. The setting decides only whether such a name is accepted with
 * a warning or refused.
 */

import type {
  ReservedDisplayNamesMode,
  ValidationOptions,
} from "@polaris-key/manifest";
import type { Db } from "../../db/types.js";
import type { SettingsEnv } from "../platformSettings.js";
import { platformSetting } from "../settings/platformRead.js";
import type { SettingsRegistry } from "../settings/registry.js";
import { resolveProductSetting } from "../settings/resolve.js";

/** The platform's severity for a reserved display name. */
export function reservedDisplayNamesMode(
  env: SettingsEnv,
  db: Db,
): Promise<ReservedDisplayNamesMode> {
  return platformSetting(env, db, "identity.reservedDisplayNames");
}

/**
 * PX-W13b: the product approval `identity.displayNameApproved` lives in Identity's settings slice,
 * which Core cannot import. The composition root hands Core the assembled registry once, as
 * `ServiceContext.settings` is handed to a handler; until then (a hand-built context) no product
 * is approved, which is the safe answer.
 */
let approvalRegistry: SettingsRegistry | undefined;
export function setDisplayNameRegistry(registry: SettingsRegistry): void {
  approvalRegistry = registry;
}

/** The platform's extra reserved terms (`identity.reservedDisplayTerms`); the code floor stays. */
export function reservedDisplayTerms(
  env: SettingsEnv,
  db: Db,
): Promise<readonly string[]> {
  return platformSetting(env, db, "identity.reservedDisplayTerms");
}

/** Did the operator approve this product's display names (`identity.displayNameApproved`)? */
export async function displayNameApproved(
  env: SettingsEnv,
  db: Db,
  slug: string | null | undefined,
): Promise<boolean> {
  if (
    !slug ||
    !approvalRegistry?.get("identity.displayNameApproved", "product")
  )
    return false;
  const r = await resolveProductSetting(
    { env, db, registry: approvalRegistry },
    slug,
    "identity.displayNameApproved",
  );
  return r?.value === true;
}

/**
 * What the manifest validator needs of the display-name policy: the severity, the extra terms
 * and, for a product that already exists (`slug`), its approval. A product being created has no
 * approval yet, so its first ingest is judged without one.
 */
export async function displayNameOptions(
  env: SettingsEnv,
  db: Db,
  slug?: string | null,
): Promise<
  Required<
    Pick<
      ValidationOptions,
      "reservedDisplayNames" | "reservedDisplayTerms" | "displayNameApproved"
    >
  >
> {
  return {
    reservedDisplayNames: await reservedDisplayNamesMode(env, db),
    reservedDisplayTerms: await reservedDisplayTerms(env, db),
    displayNameApproved: await displayNameApproved(env, db, slug),
  };
}

/** The `checkDisplayName` options of the Worker's own checks (listing claims, the card). */
export async function displayCheckOptions(
  env: SettingsEnv,
  db: Db,
  slug: string,
): Promise<{
  slug: string;
  extraTerms: readonly string[];
  approved: boolean;
}> {
  return {
    slug,
    extraTerms: await reservedDisplayTerms(env, db),
    approved: await displayNameApproved(env, db, slug),
  };
}
