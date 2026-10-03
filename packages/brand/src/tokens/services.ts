import { SERVICE_ACCENTS } from "../generated/tokens.js";
import type { ServiceId, Theme } from "./source.js";

/** A section's accent in a theme: `solid` (indicators), `fg` (text), `on`, `subtle`, `bit`. */
export function serviceAccent(id: ServiceId, theme: Theme = "dark") {
  return SERVICE_ACCENTS[theme][id];
}

/**
 * The colour of the K's terminal bit in a section's console header: the kit gold on the
 * platform (core) pages, the section's accent everywhere else (docs/design/BRAND.md, "The section
 * bit"). Only ever drawn on the display cut at >= 48 px.
 */
export function sectionBit(id: ServiceId, theme: Theme = "dark"): string {
  return SERVICE_ACCENTS[theme][id].bit;
}
