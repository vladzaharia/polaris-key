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
import { ConfirmStep } from "../src/portal/components/ActivateDialog.js";
import { FlowCard } from "../src/portal/components/FocusedFlow.js";

/**
 * Product art on the library and the product page: the icon image is its own frame, the card
 * keeps no developer byline, and the status sits on a padded plate over the art. Wherever the
 * icon overlaps the art (library card, focused flow, the activate dialog's confirm), a product
 * without art shows its letter once: on the icon's letter tile, never again on the cover.
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
  const other = license({ product: "ember", productName: "Ember Tactics" });

  it("names the product without the developer byline, and puts an issue on a padded plate", async () => {
    // Healthy is silence on art (UX-03): only an issue gets the plate (owner's padding).
    const lapsed = license({
      product: "djdl",
      productName: "DJDL",
      expiresAt: Math.floor(Date.now() / 1000) - 3 * 86_400,
    });
    mockFetch(
      signedIn([lapsed, other], {
        "/api/library": libraryFor([lapsed, other], undefined, {
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
    expect(plate.outerHTML).toMatch(/px-3\.5/);
    const healthy = await screen.findByRole("article", {
      name: "Ember Tactics",
    });
    expect(within(healthy).queryByText("Active")).toBeNull();
  });
});

describe("an art-less cover never repeats the icon's letter", () => {
  /** The text of each fallback (cover art first, then the icon's letter tile). */
  const fallbacks = (root: ParentNode): (string | null)[] =>
    [...root.querySelectorAll("[data-art='fallback']")].map(
      (el) => el.textContent,
    );

  it("on the library card", async () => {
    const djdl = license({ product: "djdl", productName: "DJDL" });
    const other = license({ product: "ember", productName: "Ember Tactics" });
    mockFetch(signedIn([djdl, other]));
    renderPortal();
    const card = await screen.findByRole("article", { name: "DJDL" });
    // An art-less tile has no icon row over the art: the letter shows once, in the art.
    expect(fallbacks(card)).toEqual(["D"]);
  });

  it("on a focused flow's card", () => {
    render(
      <FlowCard
        slug="orbit-survey"
        name="Orbit Survey"
        developer="Parallax Nine"
        tint={null}
        iconUrl={null}
        headerUrl={null}
      >
        <p>Your license is on 2 of 2 devices</p>
      </FlowCard>,
    );
    expect(fallbacks(document)).toEqual(["", "O"]);
  });

  it("on the activate dialog's confirm step", () => {
    render(
      <ConfirmStep
        preview={{
          verdict: "addable",
          product: {
            slug: "mossgarden",
            name: "Mossgarden",
            developerName: "Little Fern",
            iconUrl: null,
            headerUrl: null,
          },
        }}
        licenseKey="pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4zWq"
        adding={false}
        onBack={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(fallbacks(document)).toEqual(["", "M"]);
  });
});
