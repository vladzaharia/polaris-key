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

import type { ReservedDisplayNamesMode } from "@polaris-key/manifest";
import type { Db } from "../db/types.js";
import { platformSetting, type SettingsEnv } from "./platformSettings.js";

/** The platform's severity for a reserved display name. */
export function reservedDisplayNamesMode(
  env: SettingsEnv,
  db: Db,
): Promise<ReservedDisplayNamesMode> {
  return platformSetting(env, db, "IDENTITY_RESERVED_DISPLAY_NAMES");
}
