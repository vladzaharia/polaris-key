// The phone breakpoints of the sign-in card: the Polaris Locker card goes edge to edge on the raised
// surface under 40 rem (the React AuthCard's max-sm); the console card keeps its floating 22 px
// card down to 30 rem and its page-coloured strip below that.
import { describe, expect, it } from "vitest";
import { renderAuthCard } from "../../src/core/brandHtml.js";
import { renderConsoleSignin } from "../../src/console/signinPage.js";

/** The `@media (max-width: X)` blocks that make `main.ac` a full-bleed strip, keyed by X. */
function fullBleed(html: string): Array<{ at: string; rule: string }> {
  const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)![1]!;
  return [
    ...css.matchAll(
      /@media \(max-width: ([\d.]+rem)\)\{((?:[^{}]|\{[^{}]*\})*)\}/g,
    ),
  ]
    .filter((m) => m[2]!.includes("main.ac{max-width:none"))
    .map((m) => ({ at: m[1]!, rule: m[2]! }));
}

describe("sign-in card phone breakpoints", () => {
  it("the console card is a full-bleed strip only under 30 rem, on the page colour", () => {
    const html = renderConsoleSignin({
      state: "signin",
      returnTo: null,
      issuerHost: "idp.example",
    } as Parameters<typeof renderConsoleSignin>[0]);
    const strips = fullBleed(html);
    expect(strips.length).toBeGreaterThan(0);
    for (const s of strips) {
      expect(s.at).toBe("30rem");
      expect(s.rule).toContain("background:var(--page)");
    }
    // At 520 px (above 30 rem) no rule flattens the card: it stays the floating 22 px card.
    expect(html).toContain("border-radius:1.375rem");
    expect(html).not.toContain("39.99rem");
  });

  it("the Locker card is a full-bleed strip on the raised surface under 40 rem", () => {
    const html = renderAuthCard({ title: "t", heading: "h", body: "<p>x</p>" });
    const at40 = fullBleed(html).filter((s) => s.at === "39.99rem");
    expect(at40).toHaveLength(1);
    expect(at40[0]!.rule).toContain(
      "[data-brand=locker] main.ac{max-width:none",
    );
    expect(at40[0]!.rule).toContain("background:var(--raised)");
    expect(at40[0]!.rule).toContain(".ac-links a{min-height:2.75rem");
  });
});
