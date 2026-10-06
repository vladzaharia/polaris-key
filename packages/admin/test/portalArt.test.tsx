import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  libraryFor,
  license,
  mockFetch,
  renderPortal,
  signedIn,
} from "./portalHarness.js";
import {
  iconShape,
  ProductIcon,
} from "../src/portal/components/ProductIcon.js";

/**
 * Product art on the library and the product page: the icon image is its own frame, the card
 * keeps no developer byline, and the status sits on a padded plate over the art.
 */

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProductIcon", () => {
  it("draws an icon image with no tile background, border, padding or radius", () => {
    render(
      <ProductIcon
        slug="djdl"
        name="DJDL"
        tint="#0e7490"
        src="/media/djdl/icon?v=1"
        size={64}
        lift
        className="relative"
        tileClassName="border-[3px] border-surface-raised"
      />,
    );
    const img = document.querySelector("img[data-art='image']")!;
    expect(img.getAttribute("style")).toBeNull();
    expect(img.className).not.toMatch(/\b(bg-|border|rounded|p-|ring)/);
    expect(img.className).toMatch(/drop-shadow/);
    expect(img.getAttribute("data-shape")).toBe("shaped");
  });

  it("keeps the tile (tint, radius, ring) for the letter fallback only", () => {
    render(
      <ProductIcon
        slug="djdl"
        name="DJDL"
        tint="#0e7490"
        size={64}
        tileClassName="border-[3px] border-surface-raised"
      />,
    );
    const tile = document.querySelector("[data-art='fallback']")!;
    expect(tile.textContent).toBe("D");
    expect(tile.className).toMatch(/rounded-2xl/);
    expect(tile.className).toMatch(/border-\[3px\]/);
    expect((tile as HTMLElement).style.backgroundColor).not.toBe("");
  });

  it("leaves the icon as drawn when its pixels can't be read", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(iconShape(new Image())).toBe("shaped");
  });
});

describe("library card", () => {
  const djdl = license({ product: "djdl", productName: "DJDL" });
  const other = license({ product: "ember", productName: "Ember Tactics" });

  it("without art shows the letter once: the tint field and the icon's letter tile", async () => {
    mockFetch(signedIn([djdl, other]));
    renderPortal();
    const card = await screen.findByRole("article", { name: "DJDL" });
    const fallbacks = card.querySelectorAll("[data-art='fallback']");
    expect(fallbacks).toHaveLength(2);
    // The art holds only the status plate, no letter of its own.
    expect(fallbacks[0]!.textContent).toBe("Active");
    expect(fallbacks[1]!.textContent).toBe("D");
  });

  it("names the product without the developer byline, and puts the status on a padded plate", async () => {
    mockFetch(
      signedIn([djdl, other], {
        "/api/library": libraryFor([djdl, other], undefined, {
          developerName: "Vlad Zaharia",
        }),
      }),
    );
    renderPortal();
    const card = await screen.findByRole("article", { name: "DJDL" });
    expect(within(card).queryByText("Vlad Zaharia")).toBeNull();
    expect(card.textContent).not.toContain("Vlad Zaharia");
    const plate = card.querySelector("[data-art] span.absolute > span")!;
    expect(plate.className).toMatch(/\bh-8\b/);
    expect(plate.className).toMatch(/px-3\.5/);
  });
});
