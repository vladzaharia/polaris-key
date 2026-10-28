// BR-lockups guard rail (docs/design/BRAND.md §1.4 and the Don'ts: "Don't set the wordmark in live
// text: use a generated lockup"; Locker guide p.7: horizontal lockup minimum 180 px wide; Key guide
// p.2: a mark under 48 px takes the compact lockup). A Worker brand block draws the product name
// from an outlined lockup SVG with an accessible name, never as visible text beside a mark.
import { describe, expect, it } from "vitest";
import {
  renderAuthCard,
  renderBrandPage,
  themedLockup,
} from "../../src/core/brandHtml.js";
import { lockerLockup } from "../../src/core/assets/lockerShell.js";

/** The block's text once its SVGs (and their <title>) are removed: what a reader could see. */
function visibleText(block: string): string {
  return block
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");
}

function widthOf(svg: string): number {
  return Number(/<svg[^>]* width="([\d.]+)"/.exec(svg)![1]);
}

const blocks = (html: string): string[] =>
  [
    ...html.matchAll(
      /<(div class="brand"|header class="ac-brand[^"]*")[\s\S]*?<\/(div|header)>\s*(?=<(?:main|div class="app"|div class="card"))/g,
    ),
  ].map((m) => m[0]);

describe("Worker brand blocks draw the name from an outlined lockup", () => {
  const pages: Array<[string, string, number]> = [
    ["locker auth card", renderAuthCard({ title: "t", heading: "h" }), 180],
    [
      "locker auth card, in an app's context",
      renderAuthCard({
        title: "t",
        heading: "h",
        app: { name: "Tidewater", iconUrl: null },
      }),
      180,
    ],
    [
      "key page with a surface label",
      renderBrandPage({
        title: "t",
        heading: "h",
        brand: "key",
        surface: "console",
      }),
      180,
    ],
    [
      "key page",
      renderBrandPage({ title: "t", heading: "h", brand: "key" }),
      180,
    ],
  ];

  it.each(pages)("%s", (_name, html, minWidth) => {
    const found = blocks(html);
    expect(found).toHaveLength(1);
    const block = found[0]!;
    // The name is in no visible text node beside the mark.
    expect(visibleText(block)).not.toMatch(/polaris|locker|key/i);
    // It comes from an outlined lockup SVG with an accessible name, at least the guide minimum.
    const svg = /<svg[\s\S]*?<\/svg>/.exec(block)![0];
    expect(svg).toMatch(/role="img" aria-label="Polaris (Key|Locker)"/);
    expect(svg).toContain("<title>Polaris");
    expect(svg).not.toContain("<text");
    expect(widthOf(svg)).toBeGreaterThanOrEqual(minWidth);
  });

  it("the shared helpers refuse nothing below the guide minimum at their page sizes", () => {
    // Locker horizontal: 180 px minimum (guide p.7). Key: the glyph is 96 units tall in a 96 unit
    // canvas; Key uses the compact lockup as supplied (guide p.2), 52 px tall like plrs.im, 180 px wide.
    expect(widthOf(lockerLockup(56, "lockup", true))).toBeGreaterThanOrEqual(
      180,
    );
    expect(widthOf(lockerLockup(44, "lockup", true))).toBeGreaterThanOrEqual(
      180,
    );
    expect(
      widthOf(themedLockup("locker", "horizontal", 26, "mark", true)),
    ).toBeGreaterThanOrEqual(180);
    expect(
      widthOf(themedLockup("key", "compact", 52, "mark")),
    ).toBeGreaterThanOrEqual(180);
  });
});
