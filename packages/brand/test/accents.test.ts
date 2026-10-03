// The per-section accents and the status colours against the brand rules: no blue or indigo, no
// rose, a clear distance from the gold signing bit, and pairwise distinctness.

import { describe, expect, it } from "vitest";

import { deltaE2000, deltaEOK, hexToOklch, hslHue } from "../src/color.js";
import { SERVICE_ACCENTS, THEME_TOKENS } from "../src/generated/tokens.js";
import { BRAND } from "../src/tokens/primitives.js";
import { COLOR_RULES, colorViolations } from "../src/tokens/rules.js";
import {
  ACCENT_FAMILIES,
  SERVICE_FAMILY,
  SERVICE_IDS,
  STATUS_IDS,
  THEMES,
} from "../src/tokens/source.js";

const cases = THEMES.flatMap((theme) =>
  SERVICE_IDS.flatMap((id) =>
    (["solid", "fg"] as const).map((part) => [theme, id, part] as const),
  ),
);

describe("section accents obey the colour rules", () => {
  it.each(cases)("%s %s.%s: not blue/indigo, not rose", (theme, id, part) => {
    // Section accents are exempt from the gold distance since 2026-10-03: the core K carries no
    // gold bit, so gold is only the kit's signed artwork, the kit lockups and the signed UI
    // indicator (docs/design/BRAND.md §5.1). Config's yellow sits next to the gold on purpose.
    const hex = SERVICE_ACCENTS[theme][id][part];
    expect(colorViolations(hex, theme, { gold: false })).toEqual([]);
  });

  it("the forbidden bands catch what they should", () => {
    // The old console indigo (#5b7cfa), a plain blue, the kit rose and the kit gold all fail.
    expect(colorViolations("#5b7cfa", "dark").map((v) => v.rule)).toContain(
      "blue-indigo",
    );
    expect(colorViolations("#3b82f6", "dark").map((v) => v.rule)).toContain(
      "blue-indigo",
    );
    expect(colorViolations("#6366f1", "light").map((v) => v.rule)).toContain(
      "blue-indigo",
    );
    expect(
      colorViolations(BRAND.rose.dark, "dark").map((v) => v.rule),
    ).toContain("rose");
    expect(colorViolations("#f472b6", "dark").map((v) => v.rule)).toContain(
      "rose",
    );
    expect(
      colorViolations(BRAND.gold.dark, "dark").map((v) => v.rule),
    ).toContain("gold");
    expect(colorViolations("#f59e0b", "dark").map((v) => v.rule)).toContain(
      "gold",
    );
    // The kit violet is the platform accent and passes.
    expect(colorViolations(BRAND.violet.dark, "dark")).toEqual([]);
    expect(colorViolations(BRAND.violet.light, "light")).toEqual([]);
  });

  it("the platform accent is the kit violet, exactly", () => {
    for (const theme of THEMES) {
      expect(SERVICE_ACCENTS[theme].core.solid).toBe(BRAND.violet[theme]);
      expect(SERVICE_ACCENTS[theme].core.fg).toBe(BRAND.violet[theme]);
    }
  });
});

describe("pairwise distinctness", () => {
  const pairs = THEMES.flatMap((theme) =>
    ACCENT_FAMILIES.flatMap((a, i) =>
      ACCENT_FAMILIES.slice(i + 1).map((b) => [theme, a, b] as const),
    ),
  );
  // ΔEOK stays as a second metric; CIEDE2000 (below) governs. Re-derived 2026-10-03 (see
  // COLOR_RULES.accentMinDeltaE): measured minimum 0.090, light Config vs Update.
  it.each(pairs)(
    `%s: %s vs %s, ΔEOK >= ${COLOR_RULES.accentMinDeltaE}`,
    (theme, a, b) => {
      const fa = THEME_TOKENS[theme].accent[a].solid;
      const fb = THEME_TOKENS[theme].accent[b].solid;
      expect(deltaEOK(fa, fb)).toBeGreaterThanOrEqual(
        COLOR_RULES.accentMinDeltaE,
      );
    },
  );

  it("every section has its own family (Distribution and Update no longer share green)", () => {
    const families = SERVICE_IDS.map((id) => SERVICE_FAMILY[id]);
    expect(new Set(families).size).toBe(SERVICE_IDS.length);
    expect([...families].sort()).toEqual([...ACCENT_FAMILIES].sort());
    expect(SERVICE_FAMILY.update).toBe("tangerine");
    expect(SERVICE_FAMILY.config).toBe("yellow");
    expect(SERVICE_FAMILY.license).toBe("chartreuse");
    expect(SERVICE_ACCENTS.dark.distribution.solid).toBe("#39d075");
    expect(SERVICE_ACCENTS.light.distribution.solid).toBe("#05773b");
  });

  it("no service accent is the platform violet's neighbour", () => {
    for (const theme of THEMES)
      for (const id of SERVICE_IDS.filter((s) => s !== "core"))
        expect(
          deltaEOK(SERVICE_ACCENTS[theme][id].solid, BRAND.violet[theme]),
        ).toBeGreaterThanOrEqual(COLOR_RULES.accentMinDeltaE);
  });
});

// CIEDE2000 floors (owner requests 2026-10-03), re-derived after Config became yellow, Update
// light a bright orange and Release the cyan optimum. Each floor sits just under the minimum the
// approved palette measures (scripts/tune-accents.ts; the matrices are on
// preview/proofs/accents-{dark,light}.png and in docs/design/BRAND.md §5.1), so any change that
// brings two colours closer fails here:
//   * service vs service: 17.5. Measured minimum 18.0 (light Config yellow vs Update orange; the
//     dark minimum is 20.4, Config vs License). ΔE00 ≈ 20 reads as a different colour at a glance.
//   * the platform violet vs any service: 13. Measured 13.2 (light Identity orchid), the
//     documented tightest fit between the violet and the reserved rose (§5.3).
//   * any service vs the kit rose and the danger tokens: 17.5. Measured 17.9 (light Identity vs
//     rose) and 18.2 (light Update vs the danger border). The kit gold and the signed colour left
//     this set with the gold rule.
export const DE00_FLOORS = { services: 17.5, platform: 13, references: 17.5 };

describe("CIEDE2000 distinctness", () => {
  const services = SERVICE_IDS.filter((s) => s !== "core");
  const pairs = THEMES.flatMap((theme) =>
    services.flatMap((a, i) =>
      services.slice(i + 1).map((b) => [theme, a, b] as const),
    ),
  );
  it.each(pairs)(
    `%s: %s vs %s, ΔE00 >= ${DE00_FLOORS.services}`,
    (theme, a, b) => {
      expect(
        deltaE2000(
          SERVICE_ACCENTS[theme][a].solid,
          SERVICE_ACCENTS[theme][b].solid,
        ),
      ).toBeGreaterThanOrEqual(DE00_FLOORS.services);
    },
  );

  it.each(THEMES)(
    `%s: the platform violet vs every service, ΔE00 >= ${DE00_FLOORS.platform}`,
    (theme) => {
      for (const id of services)
        expect(
          deltaE2000(SERVICE_ACCENTS[theme][id].solid, BRAND.violet[theme]),
          id,
        ).toBeGreaterThanOrEqual(DE00_FLOORS.platform);
    },
  );

  it.each(THEMES)(
    `%s: every service vs rose and danger, ΔE00 >= ${DE00_FLOORS.references}`,
    (theme) => {
      const t = THEME_TOKENS[theme];
      const refs = {
        rose: BRAND.rose[theme],
        danger: t.status.danger.fg,
        dangerBorder: t.status.danger.border,
      };
      for (const id of services)
        for (const [k, v] of Object.entries(refs))
          expect(
            deltaE2000(SERVICE_ACCENTS[theme][id].solid, v),
            `${id} vs ${k}`,
          ).toBeGreaterThanOrEqual(DE00_FLOORS.references);
    },
  );
});

// The warning status moved to amber (2026-10-03) so it cannot be taken for the Config yellow or
// the Update tangerine. A status always sits next to an icon and a word, so its floor is lower
// than the accents' and is set per theme from the data (scripts/tune-accents.ts):
//   * dark: >= 16 from Config and Update (solid and fg). Measured 16.6 (Update solid).
//   * light: >= 10. Measured 10.5 (Update fg). At 4.5:1 on the light grounds every warm text
//     colour is a dark amber-to-brown, so light has far less room; 10.5 is the best the window
//     allows with a vivid amber (chroma >= 0.10, lightness 0.47-0.58). The suggested 12 is not
//     reachable in light without a muddy brown (the unconstrained optimum, #713d29 at chroma 0.08).
//   * danger: >= 20 in both themes (measured 31.7 dark, 24.2 light).
export const WARNING_FLOORS = {
  accents: { dark: 16, light: 10 },
  danger: 20,
} as const;

describe("the warning status is its own amber", () => {
  it.each(THEMES)("%s: clear of Config and Update, and of danger", (theme) => {
    const t = THEME_TOKENS[theme];
    const w = t.status.warning.fg;
    for (const id of ["config", "update"] as const)
      for (const part of ["solid", "fg"] as const)
        expect(
          deltaE2000(w, SERVICE_ACCENTS[theme][id][part]),
          `${id}.${part}`,
        ).toBeGreaterThanOrEqual(WARNING_FLOORS.accents[theme]);
    expect(deltaE2000(w, t.status.danger.fg)).toBeGreaterThanOrEqual(
      WARNING_FLOORS.danger,
    );
  });
});

describe("status colours stay clear of the brand rules", () => {
  it.each(THEMES)("%s: info is violet, never blue", (theme) => {
    const info = THEME_TOKENS[theme].status.info.fg;
    const { h } = hexToOklch(info);
    expect(h).toBeGreaterThanOrEqual(285);
    expect(h).toBeLessThan(310);
    expect(
      colorViolations(info, theme).filter((v) => v.rule === "blue-indigo"),
    ).toEqual([]);
  });

  it.each(THEMES)("%s: no status colour is blue/indigo or rose", (theme) => {
    for (const s of STATUS_IDS) {
      const hex = THEME_TOKENS[theme].status[s].fg;
      const rules = colorViolations(hex, theme).map((v) => v.rule);
      expect(rules, `${s} ${hex}`).not.toContain("blue-indigo");
      expect(rules, `${s} ${hex}`).not.toContain("rose");
    }
  });

  it.each(THEMES)(
    "%s: warning is distinct from signed (and from the kit gold)",
    (theme) => {
      const t = THEME_TOKENS[theme];
      expect(
        deltaEOK(t.status.warning.fg, t.signed.solid),
      ).toBeGreaterThanOrEqual(COLOR_RULES.goldMinDeltaE);
      expect(
        deltaEOK(t.status.warning.fg, t.signed.mark),
      ).toBeGreaterThanOrEqual(COLOR_RULES.goldMinDeltaE);
      expect(
        deltaEOK(t.status.warning.border, t.signed.border),
      ).toBeGreaterThan(0.05);
    },
  );

  it.each(THEMES)("%s: only the signed tokens are gold", (theme) => {
    const t = THEME_TOKENS[theme];
    for (const s of STATUS_IDS)
      expect(deltaEOK(t.status[s].fg, t.signed.solid)).toBeGreaterThanOrEqual(
        COLOR_RULES.goldMinDeltaE,
      );
  });

  it("the signed mark is the kit gold, exactly", () => {
    for (const theme of THEMES)
      expect(THEME_TOKENS[theme].signed.mark).toBe(BRAND.gold[theme]);
    expect(THEME_TOKENS.dark.signed.solid).toBe(BRAND.gold.dark);
    // The light UI indicator is the kit gold's hue, deepened just enough for 3:1 on sunken.
    const kit = hexToOklch(BRAND.gold.light);
    const ui = hexToOklch(THEME_TOKENS.light.signed.solid);
    expect(Math.abs(ui.h - kit.h)).toBeLessThan(2);
    expect(
      deltaEOK(BRAND.gold.light, THEME_TOKENS.light.signed.solid),
    ).toBeLessThan(0.05);
  });

  it("HSL hue of every accent is outside the blue band too (belt and braces)", () => {
    for (const theme of THEMES)
      for (const id of SERVICE_IDS) {
        const h = hslHue(SERVICE_ACCENTS[theme][id].solid);
        expect(h >= 190 && h < 260, `${theme} ${id} hsl ${h}`).toBe(false);
      }
  });
});
