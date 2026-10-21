import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { discoverGrid } from "../src/portal/components/tileGrid.js";
import { LibraryKeyTile } from "../src/portal/components/LibraryKeyTile.js";
import { SectionNav } from "../src/portal/components/product/SectionNav.js";
import { DataRow } from "../src/portal/components/DataRow.js";

/**
 * Markup half of stabilization package E2 (B-077, B-078, B-079, B-080, B-081, B-088): the layout
 * rules that jsdom cannot measure are pinned by their classes, and `e2e/portalLibraryBugs` and
 * `portalResolutions` measure the same fixes in a browser.
 */
afterEach(cleanup);

describe("Discover's grid (B-080)", () => {
  it("four offers are two by two until four columns fit, never three and one", () => {
    const four = discoverGrid(4);
    expect(four).toContain("min-[400px]:grid-cols-2");
    expect(four).toContain("wide:grid-cols-4");
    expect(four).not.toContain("desk:grid-cols-3");
  });
  it("other counts keep their columns", () => {
    expect(discoverGrid(3)).toContain("desk:grid-cols-3");
    expect(discoverGrid(5)).toContain("desk:grid-cols-3");
    expect(discoverGrid(1)).toContain("max-w-sm");
    expect(discoverGrid(2)).toContain("max-w-3xl");
  });
});

describe("the key tile (B-077)", () => {
  it("is one line from 36 rem, its button is capped, and the icon stacks above the title when tiny", () => {
    render(
      <ul>
        <LibraryKeyTile count={3} />
      </ul>,
    );
    const li = screen.getByRole("listitem");
    const box = li.firstElementChild as HTMLElement;
    expect(box.className).toContain("@xl:flex-row");
    expect(box.className).not.toContain("@2xl");
    const button = within(li).getByRole("button", {
      name: "Activate a license",
    });
    expect(button.className).toContain("max-w-64");
    expect(
      (
        within(li).getByRole("heading", { level: 3 })
          .parentElement as HTMLElement
      ).className,
    ).toContain("@max-[13rem]:flex-col");
  });
});

describe("the product's section pills (B-081)", () => {
  it("are 44 px tall on a coarse pointer", () => {
    render(
      <SectionNav
        variant="pills"
        sections={["license", "devices"]}
        current="license"
        onPick={() => undefined}
        hrefFor={(s) => `#${s}`}
      />,
    );
    for (const a of screen.getAllByRole("link"))
      expect(a.className).toContain("pointer-coarse:h-11");
  });
});

describe("a Your data row's extra lines (B-088)", () => {
  it("sit in the text column beside the icon, as the action does", () => {
    render(
      <DataRow
        icon={<span />}
        title="Support code"
        description="d"
        below={<p>below</p>}
      >
        <button type="button">Get code</button>
      </DataRow>,
    );
    expect(screen.getByText("below").parentElement!.className).toContain(
      "ml-13",
    );
    expect(screen.getByRole("button").parentElement!.className).toContain(
      "ml-13",
    );
  });
});
