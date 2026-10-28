// BR-lockups guard rail (docs/design/BRAND.md §1.4 and the Don'ts: "Don't set the wordmark in live
// text: use a generated lockup"; Locker guide p.7: horizontal lockup minimum 180 px wide, "for
// crowded navigation use the mark alone with an accessible label"; Key guide p.2: a mark under
// 48 px takes the compact lockup). The console top bar and the portal header draw the product name
// from an outlined lockup SVG, never as visible text beside a mark.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { Logo } from "../src/components/brand/Logo.js";
import { HeaderBrand, Lockup } from "../src/portal/components/Lockup.js";

const src = (p: string) =>
  readFileSync(join(import.meta.dirname, "..", p), "utf8");
const BRAND_SOURCES = [
  "src/console/shell/BrandBlock.tsx",
  "src/console/shell/TopBar.tsx",
  "src/components/brand/Logo.tsx",
  "src/portal/components/PortalShell.tsx",
  "src/portal/components/Lockup.tsx",
];

describe("brand blocks never set the name in live text", () => {
  it.each(BRAND_SOURCES)(
    "%s has no JSX text reading Polaris Key or Polaris Locker",
    (f) => {
      // JSX text nodes only: `>…Polaris Key…<`. (aria-labels, comments and titles are attributes.)
      // PortalShell: the header only (its footer's plain "Polaris Locker" is not beside a mark).
      const all = src(f);
      const scope = f.endsWith("PortalShell.tsx")
        ? all.slice(all.indexOf("<header"), all.indexOf("</header>"))
        : all;
      const text = [
        ...scope.matchAll(
          />([^<>{}]*Polaris(?:&nbsp;|\s)+(?:Key|Locker)[^<>{}]*)</g,
        ),
      ];
      expect(text.map((m) => m[1])).toEqual([]);
    },
  );

  it("Logo is the outlined Key compact lockup, 56 px tall, with the suffix as its own label", () => {
    const { container } = render(<Logo subtitle="console" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Polaris Key");
    expect(svg.getAttribute("height")).toBe("56");
    // The kit's canvas as supplied, uncropped: the mark-to-wordmark ratio is the kit's.
    expect(svg.getAttribute("viewBox")).toBe("0 0 222 64");
    expect(Number(svg.getAttribute("width"))).toBeGreaterThanOrEqual(180);
    expect(
      [...container.querySelectorAll("span")]
        .filter((e) => e.children.length === 0)
        .map((e) => e.textContent),
    ).toEqual(["console"]);
    expect(container.querySelector("text")).toBeNull();
  });

  it("the portal header lockup is the trimmed Locker lockup at or above 180 px; the mark stands alone below", () => {
    const { container } = render(<HeaderBrand />);
    const svgs = [...container.querySelectorAll("svg")];
    expect(container.textContent).toBe("");
    const lockups = svgs.filter(
      (s) => s.getAttribute("viewBox") === "8 41.5 379.79 46.2",
    );
    expect(lockups).toHaveLength(2);
    for (const s of lockups)
      expect(Number(s.getAttribute("width"))).toBeGreaterThanOrEqual(180);
    // The link around them names the brand; the mark alone is the narrow fallback.
    expect(
      svgs.filter((s) => s.getAttribute("viewBox") !== "8 41.5 379.79 46.2"),
    ).toHaveLength(1);
  });

  it("the focused-flow header draws the same lockup as the Library header (one shared size)", () => {
    const flow = src("src/portal/components/FocusedFlow.tsx");
    expect(flow).toMatch(/<HeaderBrand\b/);
    expect(flow).not.toMatch(/<Lockup\b/);
    expect(src("src/portal/components/PortalShell.tsx")).toContain(
      "<HeaderBrand container />",
    );
  });

  it("Lockup is trimmed by default and reaches 180 px from 22 px tall", () => {
    const { container } = render(<Lockup height={22} />);
    expect(
      Number(container.querySelector("svg")!.getAttribute("width")),
    ).toBeGreaterThanOrEqual(180);
  });
});
