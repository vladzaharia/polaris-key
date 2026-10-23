/**
 * The Library's and Discover's tile grid (PX-35): on phones one or two columns, three from
 * 761 px, four from 1180 px, five from 1700 px.
 *
 * The phone track is rem-based (WCAG 1.4.4): a tile is never narrower than 8.5 rem, so two
 * columns hold at 100 % text from 320 px up (the minimum is then half the row less half the gap)
 * and the grid drops to one column when text is enlarged, instead of breaking names mid-word.
 * Never more than two: the `max()` keeps a wide phone or a small tablet at two.
 */
export const TILE_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(max(8.5rem,calc(50%_-_0.5rem)),1fr))] gap-3 desk:grid-cols-3 desk:gap-4 wide:grid-cols-4 xxl:grid-cols-5";

/**
 * Discover's grid: one column under about 400 px, where two cannot hold a tile; and one or two
 * offers get a centred, wider layout instead of sitting left in dead space.
 */
export function discoverGrid(count: number): string {
  if (count === 1) return "mx-auto grid w-full max-w-sm grid-cols-1 gap-4";
  if (count === 2)
    return "mx-auto grid w-full max-w-3xl grid-cols-1 gap-4 min-[400px]:grid-cols-2";
  // Four offers are two and two until four columns fit, never three and one (B-080).
  if (count === 4)
    return "grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 desk:gap-4 wide:grid-cols-4 xxl:grid-cols-4";
  return "grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 desk:grid-cols-3 desk:gap-4 wide:grid-cols-4 xxl:grid-cols-5";
}
