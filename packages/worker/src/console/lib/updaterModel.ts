/**
 * The Updates page's read model, pure (P2-11): which updaters a product's shipped platforms
 * can use and whether each platform's updater has been Verified. The labels, snippets and
 * endpoints are the console's; the worker answers ids and facts.
 */

import type {
  OutletChecks,
  ProductPlatform,
} from "../../services/distribution/public.js";

export const UPDATER_IDS = [
  "sparkle",
  "winsparkle",
  "velopack",
  "app-installer",
  "zsync",
  "signed-feed",
  "godot",
  "play",
  "store",
] as const;
export type UpdaterId = (typeof UPDATER_IDS)[number];

/** Per platform, the updaters it can use (the first is the usual one) and the outlets whose
 *  reports verify it. A platform missing here has no updater card (the web). */
const PLATFORM_UPDATERS: Readonly<
  Record<string, { updaters: UpdaterId[]; outletKinds: string[] }>
> = {
  macos: {
    updaters: ["sparkle", "velopack", "godot", "signed-feed"],
    outletKinds: ["direct"],
  },
  windows: {
    updaters: [
      "winsparkle",
      "velopack",
      "app-installer",
      "godot",
      "signed-feed",
    ],
    outletKinds: ["direct", "app-installer"],
  },
  linux: {
    updaters: ["zsync", "velopack", "godot", "signed-feed"],
    outletKinds: ["direct"],
  },
  android: {
    updaters: ["play"],
    outletKinds: ["play", "play-testing"],
  },
  ios: { updaters: ["store"], outletKinds: ["app-store", "testflight"] },
};

/** `unavailable`: the counters could not be read, which is no data, never "not seen". */
export type UpdaterState = "verified" | "failing" | "not_seen" | "unavailable";

export interface UpdaterPlatform {
  state: UpdaterState;
  platform: string;
  updaters: UpdaterId[];
  arches: string[];
  /** Distinct devices: those that reported an outcome on a matching outlet, and those that reverted. */
  devices: { reported: number; reverted: number };
}

export interface UpdatersView {
  platforms: UpdaterPlatform[];
}

/** Platforms with a build or a declared file or outlet: a planned platform has no updater yet. */
const shipped = (p: ProductPlatform) => p.sources.some((s) => s !== "planned");

export function updatersView(
  platforms: readonly ProductPlatform[],
  checks: { counting: boolean; outlets: readonly OutletChecks[] },
): UpdatersView {
  const out: UpdaterPlatform[] = [];
  for (const p of platforms) {
    const entry = PLATFORM_UPDATERS[p.platform];
    if (!entry || !shipped(p)) continue;
    let n = 0;
    let failures = 0;
    for (const o of checks.outlets)
      if (entry.outletKinds.includes(o.kind)) {
        n += o.checks;
        failures += o.failures;
      }
    out.push({
      platform: p.platform,
      arches: p.arches,
      updaters: entry.updaters,
      state: !checks.counting
        ? "unavailable"
        : failures > 0
          ? "failing"
          : n > 0
            ? "verified"
            : "not_seen",
      devices: { reported: n, reverted: failures },
    });
  }
  return { platforms: out };
}
