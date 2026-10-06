import { describe, expect, it } from "vitest";
import { SERVICE_ACCENTS } from "@polaris-key/brand";
import { contrastRatio } from "@polaris-key/brand/color";

/**
 * Section-coloured text on a section tint (selected radio cards, filter chips, the info pill) uses
 * the brand's own pairing, accent `fg` on accent `subtle`, which clears 4.5:1 in every section and
 * both themes; an ad-hoc alpha tint of the solid (the pre-brand `bg-primary/15`) does not
 * guarantee that. (The legacy `Badge` this once checked went with the components/ui kit, UX-10.)
 */
describe("accent fg on accent subtle", () => {
  for (const theme of ["dark", "light"] as const)
    for (const [section, accent] of Object.entries(SERVICE_ACCENTS[theme]))
      it(`reaches 4.5:1 in ${section} (${theme})`, () => {
        expect(contrastRatio(accent.fg, accent.subtle)).toBeGreaterThanOrEqual(
          4.5,
        );
      });
});
