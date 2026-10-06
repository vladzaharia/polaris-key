import type { PaletteGroup, PaletteItem } from "./types.js";

/** A group's place in the palette and whether it shows before anything is typed. */
export interface PaletteGroupSpec {
  heading: PaletteGroup;
  order: number;
  /** Drawn only once the query matches one of its rows (Platform, EXPERIENCE.md §0.3 J-1). */
  matchOnly?: boolean;
}

/**
 * Every query word must appear in the label, the detail or the keywords. Label prefixes rank
 * first, then label matches, then the rest; ties keep the sources' order (the current product's
 * pages before Home and Products, for example).
 */
export function filterItems(
  items: PaletteItem[],
  query: string,
): PaletteItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  const scored: { item: PaletteItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    const hay = `${label} ${item.detail.toLowerCase()} ${item.keywords.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) return;
    const score = label.startsWith(words[0]!)
      ? 0
      : label.includes(words[0]!)
        ? 1
        : 2;
    scored.push({ item, score, index });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((s) => s.item);
}

/** Keep the first row of each id: a later source never duplicates an earlier one's row. */
export function dedupe(items: PaletteItem[]): PaletteItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
}

export interface RankedGroup {
  heading: PaletteGroup;
  items: PaletteItem[];
}

/**
 * Lay the palette out (EXPERIENCE.md §0.3 J-1):
 *
 * - **Untyped:** the recents, then every group that is not match-only, without match-only rows
 *   and without the rows already pinned under Recent.
 * - **Typed:** the recorded records that match, then each group's matches, best first. A row run
 *   recently shows in its own group; Recent holds only what no other group offers.
 *
 * Groups follow `groups`' order; a heading `groups` does not list goes last, in the order its rows
 * arrived, so a new source shows without editing this table.
 */
export function rankPalette(
  items: PaletteItem[],
  recents: PaletteItem[],
  query: string,
  groups: readonly PaletteGroupSpec[],
): RankedGroup[] {
  const typed = query.trim() !== "";
  const spec = new Map(groups.map((g) => [g.heading, g]));
  const headings: PaletteGroup[] = [
    ...[...groups].sort((a, b) => a.order - b.order).map((g) => g.heading),
  ];
  for (const i of items)
    if (!headings.includes(i.group)) headings.push(i.group);

  const recentIds = new Set(recents.map((i) => i.id));
  const recent = typed
    ? filterItems(
        recents.filter((i) => i.group === "Recent"),
        query,
      )
    : recents;
  const pool = typed
    ? filterItems(items, query)
    : items.filter((i) => !i.matchOnly && !recentIds.has(i.id));

  const out: RankedGroup[] = [];
  if (recent.length) out.push({ heading: "Recent", items: recent });
  for (const heading of headings) {
    if (heading === "Recent") continue;
    if (!typed && spec.get(heading)?.matchOnly) continue;
    const rows = pool.filter((i) => i.group === heading);
    if (rows.length) out.push({ heading, items: rows });
  }
  return out;
}
