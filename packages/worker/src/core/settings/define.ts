/**
 * `setting()`: the one constructor every slice uses, so the shared fields (`since`,
 * `sensitivity`, `readers`, the default `rbacArea`) are filled the same way everywhere.
 * Its own module so the slices and the registry do not import each other.
 */

import { SERVICE_AREA, type AreaId } from "../rbac/areas.js";
import type { SettingDef } from "./types.js";

/** The area a setting's owner defaults it to (ST-28 plan §3): its service's, else Core's. */
export function ownerArea(def: Pick<SettingDef, "scope" | "service">): AreaId {
  if (def.scope === "platform" || def.service === "platform") return "platform";
  if (def.service === "core") return "core";
  return SERVICE_AREA[def.service];
}

/** Fill the fields every entry shares, so slices stay readable (`since`, `sensitivity`, …). */
export function setting(
  def: Omit<SettingDef, "rbacArea" | "sensitivity" | "since" | "readers"> &
    Partial<Pick<SettingDef, "rbacArea" | "sensitivity" | "since" | "readers">>,
): SettingDef {
  return {
    sensitivity: "config",
    since: "ST-03",
    readers: [],
    rbacArea: ownerArea(def),
    ...def,
  };
}
