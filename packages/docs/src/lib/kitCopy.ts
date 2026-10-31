/**
 * The kit copy as the `build/ui/` pages show it: the generated English table (every kit key and
 * every `core.*` key, flat), its platform variants, and the launch locales. All of it is the
 * committed output of `pnpm gen brand` (packages/brand/src/generated/kit-copy/), read here rather
 * than through the package's dist so the docs need no brand build to render it.
 */

import {
  KIT_COPY_EN as CATALOG_EN,
  KIT_COPY_CORE_FALLBACK,
  KIT_COPY_LOCALES,
  KIT_COPY_VARIANTS,
} from "../../../brand/src/generated/kit-copy/index";

export { KIT_COPY_CORE_FALLBACK, KIT_COPY_LOCALES, KIT_COPY_VARIANTS };

/** A reason's bold lead is marked `**like this**` in the catalog; a docs table shows the text. */
export const stripLead = (s: string): string => s.replaceAll("**", "");

export const KIT_COPY_EN: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CATALOG_EN).map(([k, v]) => [k, stripLead(v)]),
);

/** Display names for the platform keys a variant may carry (plans/UK-02.md §3.1). */
export const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  macos: "macOS",
  ios: "iOS",
  android: "Android",
  windows: "Windows",
  linux: "Linux",
  web: "Web",
  godot: "Godot",
  terminal: "Terminal",
  tv: "TV",
};
