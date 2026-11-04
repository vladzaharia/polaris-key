// The phone breakpoint of the sign-in card (SIGNIN-REDESIGN §8): both brands, the Polaris Locker card
// and the console card, go full bleed on the raised surface under 40 rem, with no card chrome. The
// console's separate 30 rem page-coloured strip is gone.
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

describe("sign-in card phone breakpoint", () => {
  it("the console card is a full-bleed strip on the raised surface under 40 rem, with no 30 rem strip", () => {
    const html = renderConsoleSignin({
      state: "signin",
      returnTo: null,
      issuerHost: "idp.example",
    } as Parameters<typeof renderConsoleSignin>[0]);
    const strips = fullBleed(html);
    expect(strips).toHaveLength(1);
    expect(strips[0]!.at).toBe("39.99rem");
    expect(strips[0]!.rule).toContain(
      "[data-brand=console] main.ac{max-width:none",
    );
    expect(strips[0]!.rule).toContain("background:var(--raised)");
    expect(strips[0]!.rule).not.toContain("background:var(--page)");
    // Above 40 rem the card is the floating 18 px card (the --pk-radius-xl token).
    expect(html).toContain("border-radius:1.125rem");
    expect(html).not.toContain("border-radius:1.375rem");
  });

  it("the Locker card is a full-bleed strip on the raised surface under 40 rem", () => {
    const html = renderAuthCard({ title: "t", heading: "h", body: "<p>x</p>" });
    const at40 = fullBleed(html).filter((s) => s.at === "39.99rem");
    expect(at40).toHaveLength(1);
    expect(at40[0]!.rule).toContain(
      "[data-brand=locker] main.ac{max-width:none",
    );
    expect(at40[0]!.rule).toContain("background:var(--raised)");
    // The brand row carries no hairline on a phone, and the footer follows the content.
    expect(at40[0]!.rule).toContain("margin:0;border:0}");
    expect(at40[0]!.rule).toContain("safe-area-inset-bottom");
    expect(fullBleed(html)).toHaveLength(1);
  });
});
