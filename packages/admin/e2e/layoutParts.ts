/**
 * How `layoutSuite.ts` is split over test files (CS-1). Each entry is one part: the viewport labels
 * it owns in both themes, or `label/theme` for one theme. `layout.<n>.e2e.test.ts` runs part n.
 * Parts are sized by their test count (about 500 each); every viewport and theme sits in exactly
 * one part, which the suite checks when it loads, and the test names of all parts together are the
 * names the single file had. Add a viewport to `VIEWPORTS` and to a part here.
 */
export const LAYOUT_PARTS: readonly (readonly string[])[] = [
  [
    "desktop",
    "mac",
    "more-contrast",
    "forced-colors",
    "reduced-transparency",
    "desktop-text200-1280",
    "desktop-text200-1440",
  ],
  ["laptop", "tablet-700", "small-phone", "phone-text200"],
  ["tablet", "zoom200", "zoom400"],
  ["phone", "phone-text150-390", "phone-text150-360"],
  ["d7-laptop", "landscape-small"],
  ["d7-landscape", "zoom200-wide"],
  ["wide", "rail/dark"],
  ["ipad", "rail/light"],
];

/** The part that also runs the page-level checks after the viewport matrix. */
export const MISC_PART = 4;

/** Whether part `index` owns this viewport in this theme. */
export function partHolds(
  index: number,
  label: string,
  theme: "dark" | "light",
): boolean {
  const own = LAYOUT_PARTS[index] ?? [];
  return own.includes(label) || own.includes(`${label}/${theme}`);
}

// A label in two parts would run its tests twice.
{
  const seen = new Set<string>();
  for (const part of LAYOUT_PARTS)
    for (const entry of part) {
      const label = entry.split("/")[0]!;
      const themes = entry.includes("/")
        ? [entry]
        : [`${label}/dark`, `${label}/light`];
      for (const t of themes) {
        if (seen.has(t)) throw new Error(`layoutParts.ts lists ${t} twice`);
        seen.add(t);
      }
    }
}
