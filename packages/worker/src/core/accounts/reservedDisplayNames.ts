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

import {
  checkDisplayName,
  type ReservedDisplayNamesMode,
  type ValidationOptions,
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

/**
 * The app name a screen or an email may show before the person consents (DISPLAY-NAME-INVISIBLE
 * D-8): `name` when it passes {@link checkDisplayName} for this product, else the slug, the
 * neutral frame. It is the same answer in both `identity.reservedDisplayNames` modes: the mode
 * decides what is accepted at write time, never what a person is shown. Every surface that prints
 * a product or listing name to an end user goes through this.
 */
export async function shownAppName(
  env: SettingsEnv,
  db: Db,
  slug: string,
  name: string,
): Promise<string> {
  const check = await displayCheckOptions(env, db, slug);
  return checkDisplayName(name, check) === null ? name : slug;
}

/** The developer's name a screen may show: `name` when it passes the same check, else `null`. */
export async function shownDeveloperName(
  env: SettingsEnv,
  db: Db,
  slug: string,
  name: string | null | undefined,
): Promise<string | null> {
  if (!name) return null;
  const check = await displayCheckOptions(env, db, slug);
  return checkDisplayName(name, check) === null ? name : null;
}

/**
 * A product row as a notice names it: the same row with `name` replaced by the checked name
 * (`shownAppName`), or `null` when there is no row. Emails take their product name from here, so a
 * subject and the sender name ("<App> via Polaris Locker") agree.
 */
export async function shownProductRow<T extends { slug: string; name: string }>(
  env: SettingsEnv,
  db: Db,
  row: T | null | undefined,
): Promise<(T & { name: string }) | null> {
  if (!row) return null;
  return { ...row, name: await shownAppName(env, db, row.slug, row.name) };
}
