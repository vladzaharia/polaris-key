import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  HEADER_LADDER,
  rungFor,
  variantUrl,
  widthOf,
} from "../src/portal/model/artVariant.js";
import { ProductArt } from "../src/portal/components/ProductArt.js";
import { initialsOf } from "../src/portal/components/Avatar.js";

const SHA = "a".repeat(64);
const url = (w: number): string => `https://img.example/p/a/${SHA}/${w}.webp`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("art variant choice (B4)", () => {
  it("is at least drawn width times devicePixelRatio, whichever rung that takes", () => {
    for (const px of [120, 320, 390, 640, 700, 1024, 1180, 1440, 1900]) {
      for (const dpr of [1, 1.5, 2, 3]) {
        const w = rungFor(px, dpr)!;
        expect(HEADER_LADDER).toContain(w);
        // Never smaller than needed unless the ladder tops out.
        expect(w >= px * dpr || w === HEADER_LADDER.at(-1)).toBe(true);
        // And the narrowest such rung.
        const below = HEADER_LADDER.filter((r) => r < w);
        for (const r of below) expect(r).toBeLessThan(px * dpr);
      }
    }
  });

  it("never stretches a tile-sized variant into a banner", () => {
    // The Worker hands the library 1280; a 1440 px hero at 2x needs the widest rung.
    expect(widthOf(variantUrl(url(1280), 850, 2))).toBe(1920);
    expect(widthOf(variantUrl(url(1280), 850, 1))).toBe(1280);
    expect(widthOf(variantUrl(url(1280), 300, 1))).toBe(640);
  });

  it("leaves originals, proxy paths and unmeasured boxes alone", () => {
    const original = `https://img.example/p/a/${SHA}`;
    expect(variantUrl(original, 800, 2)).toBe(original);
    expect(variantUrl("/media/p/header?v=1", 800, 2)).toBe(
      "/media/p/header?v=1",
    );
    expect(variantUrl(url(1280), 0, 2)).toBe(url(1280));
  });

  it("ProductArt requests the rung for its box and the screen density", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 700,
      height: 394,
    } as DOMRect);
    const { container } = render(
      <ProductArt
        slug="p"
        name="P"
        tint={null}
        variant="banner"
        src={url(1280)}
        fit="contain"
      />,
    );
    const imgs = [...container.querySelectorAll("img")];
    // The blurred cover copy and the art itself, both at 1920 (700 × 2 = 1400).
    expect(imgs).toHaveLength(2);
    for (const i of imgs) expect(i.getAttribute("src")).toBe(url(1920));
    expect(container.querySelector("img[data-blur]")).not.toBeNull();
  });

  it("shows no blurred copy for cover art, and no text over any art", () => {
    const { container } = render(
      <ProductArt
        slug="p"
        name="P"
        tint={null}
        variant="tile"
        src="/media/p/header?v=1"
      />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.textContent).toBe("");
  });
});

describe("Avatar initials", () => {
  it("does not throw on a missing name or email", () => {
    expect(initialsOf(null, null)).toBe("?");
    expect(initialsOf(undefined, "a@b.c")).toBe("A");
    expect(initialsOf("Ada Lovelace", null)).toBe("AL");
  });
});
