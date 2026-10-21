import { describe, expect, it } from "vitest";
import { keyTileSpan } from "../src/portal/components/LibraryKeyTile.js";

/**
 * The key tile fills the rest of the products' last row, so no row is left half empty; with a
 * row to itself (the products fill theirs) it is one line.
 */
describe("the key tile's span", () => {
  it.each([
    // [products, columns 2, 3, 4, 5]
    [2, 2, 1, 2, 3],
    [3, 1, 3, 1, 2],
    [4, 2, 2, 4, 1],
    [5, 1, 1, 3, 5],
    [6, 2, 3, 2, 4],
    [7, 1, 2, 1, 3],
  ])("%i products: %i of 2, %i of 3, %i of 4, %i of 5", (n, a, b, c, d) => {
    expect(keyTileSpan(n, 2)).toBe(a);
    expect(keyTileSpan(n, 3)).toBe(b);
    expect(keyTileSpan(n, 4)).toBe(c);
    expect(keyTileSpan(n, 5)).toBe(d);
  });
});
