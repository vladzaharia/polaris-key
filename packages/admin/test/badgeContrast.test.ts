import { describe, expect, it } from "vitest";
import { SERVICE_ACCENTS } from "@polaris-key/brand";
import { contrastRatio } from "@polaris-key/brand/color";
import { badgeVariants } from "../src/components/ui/Badge.js";

/**
 * The primary badge is section-coloured text on a section tint. It uses the brand's own pairing
 * (accent `fg` on accent `subtle`), which clears 4.5:1 in every section and both themes; an
 * ad-hoc alpha tint of the solid (the pre-brand `bg-primary/15`) does not guarantee that.
 */
describe("the primary badge", () => {
  it("is accent fg on accent subtle", () => {
    const classes = badgeVariants({ variant: "primary" }).split(/\s+/);
    expect(classes).toContain("bg-accent-subtle");
    expect(classes).toContain("text-accent-fg");
  });

  for (const theme of ["dark", "light"] as const)
    for (const [section, accent] of Object.entries(SERVICE_ACCENTS[theme]))
      it(`reaches 4.5:1 in ${section} (${theme})`, () => {
        expect(contrastRatio(accent.fg, accent.subtle)).toBeGreaterThanOrEqual(
          4.5,
        );
      });
});
