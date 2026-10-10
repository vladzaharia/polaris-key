import { describe, expect, it } from "vitest";
import { keyTileSpan } from "../src/portal/components/LibraryKeyTile.js";

/** The key tile fills the rest of its row, so the grid never ends half empty (B12). */
describe("the key tile's span", () => {
  it.each([
    // [products, two columns, three columns]
    [2, 2, 1],
    [3, 1, 3],
    [4, 2, 2],
    [5, 1, 1],
    [6, 2, 3],
    [7, 1, 2],
  ])("%i products: %i of 2, %i of 3", (n, two, three) => {
    expect(keyTileSpan(n, 2)).toBe(two);
    expect(keyTileSpan(n, 3)).toBe(three);
  });

  it("negative control: products plus the tile always fill whole rows", () => {
    for (let n = 2; n <= 7; n++)
      for (const cols of [2, 3] as const)
        expect((n + keyTileSpan(n, cols)) % cols).toBe(0);
  });
});
