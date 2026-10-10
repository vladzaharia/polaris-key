/**
 * Reserved entitlement names at the Worker (S-19 §7.4, decision 15; LX-05).
 *
 * What is reserved and what a compatible declaration looks like is decided in ONE place,
 * `@polaris-key/manifest`'s `reservedNames.ts`. This module only answers the platform's severity
 * for an incompatible declaration: the A-13 platform setting `LICENSING_RESERVED_NAMES`
 * (`licensing.reservedNames` in S-19), `warn` until LX-05b flips it. Manifest ingest (link,
 * resync, the platform deploy hook) and the console catalog writes read it here.
 *
 * Neither mode changes a signed document: the policy injection in `core/licensing/entitlements.ts` still
 * overwrites every system key after the merge. The setting only decides whether a declaration
 * that disagrees with the system key's type is accepted with a warning or refused.
 */

import {
  reservedNameDeclarations,
  type ReservedNameDeclaration,
  type ReservedNamesMode,
} from "@polaris-key/manifest";
import type { Db } from "../../db/types.js";
import type { SettingsEnv } from "../platformSettings.js";
import { platformSetting } from "../settings/platformRead.js";

/** The platform's severity for an incompatible reserved-name declaration. */
export function reservedNamesMode(
  env: SettingsEnv,
  db: Db,
): Promise<ReservedNamesMode> {
  return platformSetting(env, db, "licensing.reservedNames");
}

/** The incompatible reserved-name declarations of a catalog (empty when there are none). */
export function incompatibleReservedNames(
  catalog: unknown,
): ReservedNameDeclaration[] {
  return reservedNameDeclarations(catalog).filter((d) => !d.compatible);
}
