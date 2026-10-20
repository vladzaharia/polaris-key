import { describe, expect, it } from "vitest";
import { keyTileSpan } from "../src/portal/components/LibraryKeyTile.js";

/** The key tile takes a whole row (one line) only when the products fill theirs, else one cell. */
describe("the key tile's span", () => {
  it.each([
    // [products, two columns, three columns]
    [2, 2, 1],
    [3, 1, 3],
    [4, 2, 1],
    [5, 1, 1],
    [6, 2, 3],
    [7, 1, 1],
  ])("%i products: %i of 2, %i of 3", (n, two, three) => {
    expect(keyTileSpan(n, 2)).toBe(two);
    expect(keyTileSpan(n, 3)).toBe(three);
  });
});
