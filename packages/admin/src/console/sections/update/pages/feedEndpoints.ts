/**
 * The update feed's endpoint rows, split out of UpdateChannelsPage.tsx (page budget): which
 * platforms the releases ship, and which updater feeds that makes the Endpoints section list.
 */

import type { ReleaseStoreResponse } from "../../../../api.js";

/** The platforms the product's releases ship a build or a file for (`RELEASE_PLATFORMS`). */
export function shippedPlatforms(
  store: ReleaseStoreResponse | undefined,
): string[] {
  const set = new Set<string>();
  for (const rel of store?.releases ?? []) {
    for (const b of rel.builds) if (b.platform) set.add(b.platform);
    for (const a of rel.artifacts) if (a.platform) set.add(a.platform);
  }
  return [...set].sort();
}

/** The endpoints every product serves, whatever its releases: listed while they load. */
export const BASE_ENDPOINTS: readonly { label: string; path: string }[] = [
  { label: "Discovery", path: ".well-known/polaris.json" },
  { label: "Version check", path: "update/version" },
];

/**
 * The endpoint rows for these channels and shipped platforms. Discovery, the version check and
 * the signed feed serve every platform; the Sparkle appcasts are listed only when macOS ships and
 * WinSparkle only when Windows does. With no platform known yet, every updater is listed.
 */
export function endpointRows(
  channels: readonly string[],
  platforms: readonly string[],
): { label: string; path: string }[] {
  const known = platforms.length > 0;
  const mac = !known || platforms.includes("macos");
  const win = !known || platforms.includes("windows");
  return [
    ...BASE_ENDPOINTS,
    ...(mac ? [{ label: "Sparkle appcast", path: "update/appcast.xml" }] : []),
    ...channels.flatMap((c) => [
      { label: `Signed feed · ${c}`, path: `update/${c}/feed.jws` },
      ...(mac
        ? [{ label: `Sparkle appcast · ${c}`, path: `update/${c}/appcast.xml` }]
        : []),
      ...(win
        ? [{ label: `WinSparkle · ${c}`, path: `update/${c}/winsparkle.xml` }]
        : []),
    ]),
  ];
}

/**
 * What the Endpoints section says about the updater feeds it leaves out, or null when it lists
 * them all. It names only what is missing and when it appears, never the platforms that ship.
 */
export function updaterNote(platforms: readonly string[]): string | null {
  if (platforms.length === 0) return null;
  const mac = platforms.includes("macos");
  const win = platforms.includes("windows");
  if (mac && win) return null;
  if (mac) return "WinSparkle appears once a release ships for Windows.";
  if (win) return "Sparkle appears once a release ships for macOS.";
  return "Sparkle and WinSparkle appear once a release ships for macOS or Windows.";
}
