import { SERVICE_ACCENTS } from "../generated/tokens.js";
import type { ServiceId, Theme } from "./source.js";

/** A section's accent in a theme: `solid` (indicators), `fg` (text), `on`, `subtle`, `bit`. */
export function serviceAccent(id: ServiceId, theme: Theme = "dark") {
  return SERVICE_ACCENTS[theme][id];
}

/**
 * The colour of the K's terminal bit in a service section's console header, or `null` for core:
 * the platform (core) pages draw no bit at all (owner decision 2026-10-03, docs/design/BRAND.md
 * §6, "The section bit"). Only ever drawn on the display cut at >= 48 px.
 */
export function sectionBit(
  id: ServiceId,
  theme: Theme = "dark",
): string | null {
  return SERVICE_ACCENTS[theme][id].bit;
}
