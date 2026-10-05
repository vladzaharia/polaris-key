/**
 * `setting()`: the one constructor every slice uses, so the shared fields (`since`,
 * `sensitivity`, `readers`, the default `capability`) are filled the same way everywhere.
 * Its own module so the slices and the registry do not import each other.
 */

import type { SettingDef } from "./types.js";

/** Fill the fields every entry shares, so slices stay readable (`since`, `sensitivity`, …). */
export function setting(
  def: Omit<SettingDef, "capability" | "sensitivity" | "since" | "readers"> &
    Partial<
      Pick<SettingDef, "capability" | "sensitivity" | "since" | "readers">
    >,
): SettingDef {
  const owner = def.scope === "platform" ? "platform" : def.service;
  return {
    sensitivity: "config",
    since: "ST-03",
    readers: [],
    capability: `settings.${def.scope}.${owner}.write`,
    ...def,
  };
}
