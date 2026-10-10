/**
 * Release-track read model, pure helpers (P2-08). No route exposes them yet; the Release tracks
 * screens read them through the package that adds one.
 *
 * A track is called out only when it is behind the track it falls back to: its newest build is
 * older than the fallback track's newest. Not having moved for a while is not a state, so no
 * helper here looks at a date.
 */

import { compareSemver } from "../../core/entitlements.js";

export type TrackFallbackState =
  /** The track has no build of its own: it serves its fallback, which is not "behind". */
  | "empty"
  /** The track's newest build is the fallback's newest or newer, or there is no fallback build. */
  | "current"
  /** The track's newest build is older than the fallback track's newest. */
  | "behind";

/**
 * `behind` only when `newest` (the track's newest version) is older than `fallbackNewest` (the
 * newest version of the track it falls back to). Versions that are not semver never compare, so
 * they are `current`.
 */
export function trackFallbackState(
  newest: string | null,
  fallbackNewest: string | null,
  compare: (a: string, b: string) => number = compareSemver,
): TrackFallbackState {
  if (newest === null) return "empty";
  if (fallbackNewest === null) return "current";
  return compare(newest, fallbackNewest) < 0 ? "behind" : "current";
}

/**
 * How many of `versions` are newer than `current` (a track's builds against the version a
 * promotion would start from): "Dev is 11 builds ahead".
 */
export function buildsAhead(
  versions: readonly string[],
  current: string,
  compare: (a: string, b: string) => number = compareSemver,
): number {
  return versions.filter((v) => compare(v, current) > 0).length;
}
