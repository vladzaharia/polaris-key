/**
 * The Library's and Discover's tile grid (PX-35): two compact columns on phones, three from
 * 761 px, four from 1180 px, five from 1700 px. Keep in step with `keyTileSpan`.
 */
export const TILE_GRID =
  "grid grid-cols-2 gap-3 desk:grid-cols-3 desk:gap-4 wide:grid-cols-4 xxl:grid-cols-5";

/**
 * Discover's grid: one column under about 400 px, where two cannot hold a tile; and one or two
 * offers get a centred, wider layout instead of sitting left in dead space.
 */
export function discoverGrid(count: number): string {
  if (count === 1) return "mx-auto grid w-full max-w-sm grid-cols-1 gap-4";
  if (count === 2)
    return "mx-auto grid w-full max-w-3xl grid-cols-1 gap-4 min-[400px]:grid-cols-2";
  return "grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 desk:grid-cols-3 desk:gap-4 wide:grid-cols-4 xxl:grid-cols-5";
}
