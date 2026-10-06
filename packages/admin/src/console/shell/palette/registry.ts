/**
 * The palette's source registry (EXPERIENCE.md §0.3 J-1). One list, read in order; a later
 * source's row with an id an earlier one already offered is dropped.
 *
 * To add a source (UX-06b's entities and pasted keys, ST-10's settings): write it beside these in
 * `palette/`, append it to `PALETTE_SOURCES`, and give its heading a place in `PALETTE_GROUPS`.
 * A source owns its rows and nothing else: it never filters, re-ranks or re-labels another's.
 */

import { actionsPaletteSource } from "./actions.js";
import {
  navigationPaletteSource,
  productsPaletteSource,
} from "./navigation.js";
import { dedupe, type PaletteGroupSpec } from "./rank.js";
import type { PaletteContext, PaletteItem, PaletteSource } from "./types.js";

/**
 * Where each heading sits. The current product's pages lead, then the actions, then other
 * products; Platform shows only on a query match. Recent always comes first, before anything typed.
 * Gaps leave room: a pasted key belongs above everything (order 0), entities between pages and
 * actions, settings after actions.
 */
export const PALETTE_GROUPS: readonly PaletteGroupSpec[] = [
  { heading: "Recent", order: 5 },
  { heading: "Pages", order: 20 },
  { heading: "Actions", order: 40 },
  { heading: "Products", order: 60 },
  { heading: "Platform", order: 80, matchOnly: true },
];

/** The sources, in the order their rows are merged. A module constant: see `PaletteSource`. */
export const PALETTE_SOURCES: readonly PaletteSource[] = [
  navigationPaletteSource,
  actionsPaletteSource,
  productsPaletteSource,
];

/**
 * Every source's rows for this context and query, merged and de-duplicated. `extra` rows (what a
 * caller hands the palette directly) come after the sources', so a source's row wins an id clash.
 * The product on screen is already open, so no row offers to jump to it again.
 */
export function usePaletteItems(
  ctx: PaletteContext,
  query: string,
  extra: PaletteItem[] = [],
): PaletteItem[] {
  const rows: PaletteItem[] = [];
  for (const source of PALETTE_SOURCES)
    rows.push(...source.useItems(ctx, query));
  return dedupe([...rows, ...extra]).filter(
    (i) => !(ctx.slug && i.product?.slug === ctx.slug),
  );
}
