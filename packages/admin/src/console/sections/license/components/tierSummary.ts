/** Tier facts shared by the Tiers page and the tier record: usage counts and their wording. */

import * as React from "react";
import { useLicenses } from "./shared.js";

/** Licenses per tier id, or `null` while the licenses are unknown. */
export function useTierUsage(slug: string): Map<string, number> | null {
  const q = useLicenses(slug);
  return React.useMemo(() => {
    if (!q.data) return null;
    const m = new Map<string, number>();
    for (const l of q.data.licenses ?? [])
      if (l.tier) m.set(l.tier, (m.get(l.tier) ?? 0) + 1);
    return m;
  }, [q.data]);
}

export const usedByText = (n: number) =>
  `Used by ${n} ${n === 1 ? "license" : "licenses"}`;

/** "57 licenses", the count under a tier in the list. */
export const licenseCountText = (n: number) =>
  `${n} ${n === 1 ? "license" : "licenses"}`;

/** The save bar's consequence: a change reaches every license on the tier. */
export const reachesText = (n: number | null) =>
  n === null
    ? ""
    : n === 0
      ? "No license is on this tier."
      : `Reaches ${licenseCountText(n)}.`;
