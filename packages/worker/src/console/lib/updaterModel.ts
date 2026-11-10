/**
 * The Updates page's read model, pure (P2-11): which updaters a product's shipped platforms
 * can use, grouped by what verifies together. An update-health event names an outlet and a
 * channel but no platform, so Verified and failing belong to an outlet group (direct downloads,
 * Google Play), never to one platform of it. The labels, snippets and feed URLs are the console's.
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
  "godot",
  "play",
] as const;
export type UpdaterId = (typeof UPDATER_IDS)[number];

/** `unavailable`: the counters could not be read, which is no data, never "not seen". */
export type UpdaterState = "verified" | "failing" | "not_seen" | "unavailable";

export interface UpdaterGroup {
  id: "direct" | "play";
  state: UpdaterState;
  /** Update reports (a device counts once per release), and those that reverted. */
  reports: number;
  reverted: number;
  /** The version with the most reverts, when any. */
  release: string | null;
  platforms: { platform: string; arches: string[]; updaters: UpdaterId[] }[];
}

export interface UpdatersView {
  /** The app's delivery access mode: who can check for updates. */
  access: string | null;
  groups: UpdaterGroup[];
  /** Platforms the store updates; no self-updater. */
  store: string[];
}

/** The self-updaters per desktop platform, the usual one first; Godot's only for a Godot game. */
const DESKTOP: Record<string, UpdaterId[]> = {
  macos: ["sparkle", "velopack"],
  windows: ["winsparkle", "velopack", "app-installer"],
  linux: ["zsync", "velopack"],
};
/** The store outlets that update a platform by themselves. */
const STORE_KINDS: Record<string, string[]> = {
  macos: ["app-store", "testflight"],
  windows: ["ms-store"],
  ios: ["app-store", "testflight"],
};
const GROUP_KINDS = {
  direct: ["direct", "app-installer"],
  play: ["play", "play-testing"],
} as const;

/** Platforms with a build or a declared file or outlet: a planned platform has no updater yet. */
const shipped = (p: ProductPlatform) => p.sources.some((s) => s !== "planned");

export function updatersView(
  platforms: readonly ProductPlatform[],
  checks: { counting: boolean; outlets: readonly OutletChecks[] },
  ctx: { godot: boolean; access: string | null },
): UpdatersView {
  const kinds = new Set(checks.outlets.map((o) => o.kind));
  const direct: UpdaterGroup["platforms"] = [];
  const play: UpdaterGroup["platforms"] = [];
  const store: string[] = [];
  for (const p of platforms) {
    if (!shipped(p)) continue;
    const row = { platform: p.platform, arches: p.arches };
    const stores = STORE_KINDS[p.platform] ?? [];
    if (p.platform === "android") play.push({ ...row, updaters: ["play"] });
    else if (p.platform === "ios") store.push(p.platform);
    else if (DESKTOP[p.platform]) {
      if (!kinds.has("direct") && stores.some((k) => kinds.has(k)))
        store.push(p.platform);
      else
        direct.push({
          ...row,
          updaters: [
            ...DESKTOP[p.platform]!,
            ...(ctx.godot ? (["godot"] as const) : []),
          ],
        });
    }
  }
  const group = (
    id: UpdaterGroup["id"],
    list: UpdaterGroup["platforms"],
  ): UpdaterGroup[] => {
    if (list.length === 0) return [];
    let reports = 0;
    let reverted = 0;
    let release: string | null = null;
    let most = 0;
    for (const o of checks.outlets)
      if ((GROUP_KINDS[id] as readonly string[]).includes(o.kind)) {
        reports += o.checks;
        reverted += o.failures;
        if (o.failures > most) {
          most = o.failures;
          release = o.worstVersion;
        }
      }
    const state: UpdaterState = !checks.counting
      ? "unavailable"
      : reverted > 0
        ? "failing"
        : reports > 0
          ? "verified"
          : "not_seen";
    return [{ id, state, reports, reverted, release, platforms: list }];
  };
  return {
    access: ctx.access,
    groups: [...group("direct", direct), ...group("play", play)],
    store,
  };
}
