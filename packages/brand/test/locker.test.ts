// Polaris Locker (docs/design/BRAND.md §15): the coral tokens and their measured facts, the
// namespace (a subbrand, never a service), the two-cut mark rule, and the API's refusals.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { contrastRatio, deltaE2000, deltaEOK } from "../src/color.js";
import {
  LOCKER_TOKENS,
  SERVICE_ACCENTS,
  THEME_TOKENS,
} from "../src/generated/tokens.js";
import { PolarisLockup, PolarisMark } from "../src/react.js";
import { badgeSvg, lockupSvg, markSvg } from "../src/svg.js";
import { LOCKER_BADGE_LABELS } from "../src/generated/locker.js";
import { LOCKER_BADGE_KINDS } from "../src/marks/locker.js";
import { opticalCut } from "../src/marks/core.js";
import { BRAND, LOCKER, LOCKER_TRIM } from "../src/tokens/primitives.js";
import { resolveLocker } from "../src/tokens/resolve.js";
import { SERVICE_IDS, THEMES } from "../src/tokens/source.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const PKG = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(PKG, p), "utf8");

describe("the grounds are Key's; only accent and onAccent are new", () => {
  it.each(THEMES)("%s", (theme) => {
    const t = THEME_TOKENS[theme];
    expect(LOCKER.page[theme]).toBe(t.surface.page);
    expect(LOCKER.surface[theme]).toBe(t.surface.raised);
    expect(LOCKER.text[theme]).toBe(t.text.default);
    expect(LOCKER.muted[theme]).toBe(t.text.muted);
  });
});

describe("generated tokens", () => {
  it("LOCKER_TOKENS equals the resolver", () => {
    expect(LOCKER_TOKENS).toEqual(resolveLocker());
  });
  it.each(THEMES)(
    "%s: solid and on are the kit's accent and onAccent",
    (theme) => {
      expect(LOCKER_TOKENS[theme].solid).toBe(LOCKER.accent[theme]);
      expect(LOCKER_TOKENS[theme].on).toBe(LOCKER.onAccent[theme]);
    },
  );
  it("css/tokens.css carries --pk-locker-* per theme and the data-brand scope", () => {
    const css = read("css/tokens.css");
    for (const k of ["accent", "fg", "on", "subtle", "hover"] as const)
      for (const theme of THEMES)
        expect(css).toContain(
          `--pk-locker-${k}: ${LOCKER_TOKENS[theme][k === "accent" ? "solid" : k]};`,
        );
    const scope = /\[data-brand="locker"\] \{([^}]*)\}/.exec(css)![1]!;
    for (const v of [
      "--pk-accent:",
      "--pk-accent-fg:",
      "--pk-accent-on:",
      "--pk-accent-subtle:",
      "--pk-focus:",
    ])
      expect(scope).toContain(v);
    expect(scope).not.toMatch(/--pk-action[a-z-]*:/);
    // a data-service still wins: its block comes after the Locker scope
    expect(css.indexOf('[data-brand="locker"]')).toBeLessThan(
      css.indexOf('[data-service="license"]'),
    );
  });
  it("css/theme.css maps --color-locker-*", () => {
    const css = read("css/theme.css");
    for (const k of ["accent", "fg", "on", "subtle", "hover"])
      expect(css).toContain(`--color-locker-${k}: var(--pk-locker-${k});`);
  });
  it("tokens.json carries locker", () => {
    expect(JSON.parse(read("tokens.json")).locker).toEqual(LOCKER_TOKENS);
  });
});

describe("contrast (BRAND §5.1)", () => {
  for (const theme of THEMES) {
    const t = THEME_TOKENS[theme];
    const l = LOCKER_TOKENS[theme];
    const surfaces = Object.entries(t.surface);
    it.each(surfaces)(
      `${theme}: accent is >= 3:1 as UI on surface.%s`,
      (_, s) => {
        expect(contrastRatio(l.solid, s)).toBeGreaterThanOrEqual(3);
      },
    );
    it.each([...surfaces, ["subtle", l.subtle] as const])(
      `${theme}: fg is >= 4.5:1 as text on %s`,
      (_, s) => {
        expect(contrastRatio(l.fg, s)).toBeGreaterThanOrEqual(4.5);
      },
    );
    it(`${theme}: on is >= 4.5:1 on a coral fill`, () => {
      expect(contrastRatio(l.on, l.solid)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: the neutral ring is >= 3:1 on the page and the selected fill`, () => {
      expect(
        contrastRatio(t.text.strong, t.surface.page),
      ).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t.text.strong, l.subtle)).toBeGreaterThanOrEqual(3);
    });
    it(`${theme}: text is >= 4.5:1 on the selected and hover fills`, () => {
      for (const fill of [l.subtle, l.hover]) {
        expect(contrastRatio(t.text.default, fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.text.strong, fill)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
  it("the measured values (kit contrast-report.json)", () => {
    expect(contrastRatio(LOCKER.accent.dark, BRAND.page.dark)).toBeCloseTo(
      7.714,
      2,
    );
    expect(contrastRatio(LOCKER.accent.light, BRAND.page.light)).toBeCloseTo(
      4.677,
      2,
    );
    expect(
      contrastRatio(LOCKER.onAccent.light, LOCKER.accent.light),
    ).toBeCloseTo(4.963, 2);
  });
});

// §0.5 of plans/LK-00.md: coral cannot be a section accent. Pinned so a palette change reopens
// D9 (coral stays identity, nav marker, focus and links; the primary action stays neutral ink).
describe("why coral is not a section accent or a status (D9)", () => {
  const near = (a: number, b: number, d = 0.1) => Math.abs(a - b) <= d;
  it.each(THEMES)("%s: the distances", (theme) => {
    const c = LOCKER.accent[theme];
    const t = THEME_TOKENS[theme];
    const expected = {
      dark: { danger: 8.9, update: 20.1, rose: 0.091 },
      light: { danger: 5.8, update: 16.3, rose: 0.131 },
    }[theme];
    expect(near(deltaE2000(c, t.status.danger.fg), expected.danger)).toBe(true);
    expect(near(deltaE2000(c, t.accent.tangerine.solid), expected.update)).toBe(
      true,
    );
    expect(near(deltaEOK(c, BRAND.rose[theme]), expected.rose, 0.001)).toBe(
      true,
    );
  });
  it("it is under the 17.5 accent floor against danger in both themes", () => {
    for (const theme of THEMES)
      expect(
        deltaE2000(LOCKER.accent[theme], THEME_TOKENS[theme].status.danger.fg),
      ).toBeLessThan(17.5);
  });
  it("light coral is under 4.5:1 on surface.sunken (so fg is a lower lightness)", () => {
    expect(
      contrastRatio(LOCKER.accent.light, THEME_TOKENS.light.surface.sunken),
    ).toBeLessThan(4.5);
    expect(LOCKER_TOKENS.light.fg).not.toBe(LOCKER.accent.light);
  });
  it("the neutral action role is untouched (primary stays ink)", () => {
    expect(THEME_TOKENS.dark.action.fill).toBe(BRAND.page.light);
    expect(THEME_TOKENS.light.action.fill).toBe(BRAND.page.dark);
  });
});

// D9a: coral is identity only. The state tokens in the Locker scope are neutral ink, and where
// they are tints they sit well clear of the danger callout (before: subtle was ΔE00 0.6 light and
// 1.7 dark from danger-subtle, light link text 2.8 from danger text, the ring 4.6 from the danger
// border).
describe("D9a: states inside data-brand=locker are not coral", () => {
  const css = read("css/tokens.css");
  const scope = /\[data-brand="locker"\] \{([^}]*)\}/.exec(css)![1]!;
  const decl = (name: string) =>
    new RegExp(`${name}: ([^;]+);`).exec(scope)?.[1];
  it("coral appears only as the accent (nav marker) and the context edge", () => {
    const coral = [
      ...scope.matchAll(/(--pk-[a-z-]+): var\(--pk-locker-(accent|fg)\)/g),
    ].map((m) => m[1]);
    expect(coral.sort()).toEqual(["--pk-accent", "--pk-state-context-edge"]);
  });
  it("focus, selection, hover, links and checked controls take neutral sources", () => {
    expect(decl("--pk-focus")).toBe("var(--pk-text-strong)");
    expect(decl("--pk-state-ring")).toBe("var(--pk-text-strong)");
    expect(decl("--pk-accent-fg")).toBe("var(--pk-text-strong)");
    expect(decl("--pk-state-selected-fill")).toBe("var(--pk-locker-subtle)");
    expect(decl("--pk-state-hover-tint")).toBe("var(--pk-locker-hover)");
    expect(decl("--pk-state-checked-fill")).toBe("var(--pk-action)");
    expect(decl("--pk-state-checked-edge")).toBe("var(--pk-action)");
    expect(decl("--pk-state-checked-on")).toBe("var(--pk-action-on)");
    expect(decl("--pk-state-context-edge")).toBe("var(--pk-locker-accent)");
  });
  it.each(THEMES)(
    "%s: the tints and the ink are far from the danger tokens",
    (theme) => {
      const t = THEME_TOKENS[theme];
      const l = LOCKER_TOKENS[theme];
      // the core accent-vs-danger floor is 17.5 for a hue; a neutral tint only has to read as not-error
      expect(deltaE2000(l.subtle, t.status.danger.subtle)).toBeGreaterThan(5);
      expect(deltaE2000(l.hover, t.status.danger.subtle)).toBeGreaterThan(5);
      expect(deltaE2000(t.text.strong, t.status.danger.fg)).toBeGreaterThan(
        17.5,
      );
      expect(deltaE2000(t.text.strong, t.status.danger.border)).toBeGreaterThan(
        17.5,
      );
      expect(deltaE2000(t.action.fill, t.status.danger.fg)).toBeGreaterThan(
        17.5,
      );
    },
  );
});

describe("Locker is a subbrand, not a service", () => {
  it("is not a section id, accent or services.json slug", () => {
    expect(SERVICE_IDS as readonly string[]).not.toContain("locker");
    for (const theme of THEMES)
      expect(Object.keys(SERVICE_ACCENTS[theme])).not.toContain("locker");
    const table = JSON.parse(
      readFileSync(join(PKG, "../../tools/services.json"), "utf8"),
    ) as {
      services: { slug: string }[];
    };
    expect(table.services.map((s) => s.slug)).not.toContain("locker");
  });
});

describe("two optical cuts", () => {
  it.each([
    [16, "micro"],
    [20, "micro"],
    [23.9, "micro"],
    [24, "master"],
    [32, "master"],
    [96, "master"],
  ] as const)("size %s uses the %s cut", (size, cut) => {
    expect(opticalCut(size, "locker")).toBe(cut);
    const svg = markSvg({ kind: "locker", size });
    expect(svg).toContain(
      cut === "micro" ? 'viewBox="0 0 16 16"' : 'viewBox="0 0 128 128"',
    );
  });
  it("the Key rule is unchanged", () => {
    expect(opticalCut(23)).toBe("favicon");
    expect(opticalCut(24)).toBe("service");
    expect(opticalCut(40)).toBe("display");
  });
});

describe("the API", () => {
  it("refuses a bit and the signed gold", () => {
    expect(() => markSvg({ kind: "locker", signed: true })).toThrow(/no bit/);
    expect(() => markSvg({ kind: "locker", bit: "gold" })).toThrow(/no bit/);
    expect(() => markSvg({ kind: "locker", bit: "license" })).toThrow(/no bit/);
    expect(() => lockupSvg({ kind: "locker", signed: true })).toThrow(/no bit/);
    expect(() => lockupSvg({ kind: "locker", bit: "section" })).toThrow(
      /no bit/,
    );
    expect(() =>
      renderToStaticMarkup(
        createElement(PolarisMark, { kind: "locker", bit: "gold" }),
      ),
    ).toThrow();
    expect(markSvg({ kind: "locker", bit: "none" })).toContain("<path");
  });
  it("draws coral on dark and deep coral on light; mono follows the text", () => {
    expect(markSvg({ kind: "locker", size: 48 })).toContain('fill="#ff7869"');
    expect(markSvg({ kind: "locker", size: 48, theme: "light" })).toContain(
      'fill="#c44438"',
    );
    expect(markSvg({ kind: "locker", size: 48, theme: "mono" })).toContain(
      'fill="currentColor"',
    );
  });
  it("names the mark only when asked", () => {
    expect(markSvg({ kind: "locker" })).toContain('aria-hidden="true"');
    expect(markSvg({ kind: "locker", title: "Polaris Locker" })).toContain(
      'aria-label="Polaris Locker"',
    );
  });
  it("lockups render in every layout and ink; the React and string markup agree", () => {
    for (const layout of ["horizontal", "compact", "stacked"] as const)
      for (const theme of [
        "dark",
        "light",
        "mono",
        "mono-black",
        "mono-white",
        "coral",
      ] as const) {
        const svg = lockupSvg({ kind: "locker", layout, theme });
        expect(svg).toContain('aria-label="Polaris Locker"');
        expect(
          renderToStaticMarkup(
            createElement(PolarisLockup, { kind: "locker", layout, theme }),
          ),
        ).toBe(svg);
      }
  });
  it("the coral ink is Locker's alone, and trim is horizontal-only", () => {
    expect(() => lockupSvg({ theme: "coral" })).toThrow();
    expect(() =>
      lockupSvg({ kind: "locker", layout: "compact", trim: true }),
    ).toThrow();
  });
  it("the React mark equals the string mark", () => {
    for (const size of [16, 32, 64])
      expect(
        renderToStaticMarkup(
          createElement(PolarisMark, { kind: "locker", size, title: "x" }),
        ),
      ).toBe(markSvg({ kind: "locker", size, title: "x" }));
  });
  it("badges: 16 labels, named for the label, 320 CSS px minimum", () => {
    expect(LOCKER_BADGE_KINDS.length).toBe(16);
    for (const kind of LOCKER_BADGE_KINDS) {
      const svg = badgeSvg({ kind });
      expect(svg).toContain(
        `aria-label="${LOCKER_BADGE_LABELS[kind.slice(7) as keyof typeof LOCKER_BADGE_LABELS]} Polaris Locker"`,
      );
      expect(svg).toContain('viewBox="0 0 320 104"');
      expect(svg).toContain('width="320" height="104"');
    }
    expect(badgeSvg({ kind: "locker-open-in" })).toContain(
      'aria-label="Open in Polaris Locker"',
    );
    expect(badgeSvg({ kind: "locker-sync-with" })).toContain(
      'aria-label="Sync with Polaris Locker"',
    );
    // below the floor it is raised, never shrunk
    expect(badgeSvg({ kind: "locker-open-in", width: 160 })).toContain(
      'width="320" height="104"',
    );
    expect(badgeSvg({ kind: "locker-open-in", width: 240 })).toContain(
      'width="320"',
    );
    expect(badgeSvg({ kind: "locker-open-in", width: 640 })).toContain(
      'width="640" height="208"',
    );
    expect(badgeSvg({ kind: "locker-open-in", title: "" })).toContain(
      'aria-hidden="true"',
    );
    expect(() => badgeSvg({ kind: "locker-nope" as never })).toThrow();
  });
});

describe("exports", () => {
  const pkg = JSON.parse(read("package.json")) as {
    exports: Record<string, string>;
    files: string[];
  };
  /** Node's rule: the longest matching pattern key; every `*` in the target takes the match. */
  const resolve = (spec: string) => {
    if (pkg.exports[spec]) return pkg.exports[spec];
    const best = Object.keys(pkg.exports)
      .filter((k) => k.includes("*") && spec.startsWith(k.split("*")[0]!))
      .sort((a, b) => b.length - a.length)[0]!;
    return pkg.exports[best]!.replaceAll(
      "*",
      spec.slice(best.split("*")[0]!.length),
    );
  };
  it.each([
    ["./locker.css", "css/locker.css"],
    [
      "./marks/locker/dark-micro.svg",
      "locker-kit/logos/svg/locker-mark-dark-micro.svg",
    ],
    [
      "./marks/locker/coral-master.svg",
      "locker-kit/logos/svg/locker-mark-coral-master.svg",
    ],
    [
      "./lockups/locker/horizontal-dark.svg",
      "locker-kit/logos/svg/locker-horizontal-dark.svg",
    ],
    [
      "./badges/locker/open-in-dark-sticker.svg",
      "locker-kit/badges/locker-open-in-dark-sticker.svg",
    ],
    [
      "./social/locker/social-square.svg",
      "locker-kit/social/social-square.svg",
    ],
    [
      "./app-icons/locker/platform/locker.icns",
      "locker-kit/icons/platform/locker.icns",
    ],
    ["./web/locker/site.webmanifest", "web/locker/site.webmanifest"],
    ["./locker-kit/README.md", "locker-kit/README.md"],
  ])("%s resolves to a shipped file", (spec, file) => {
    const target = resolve(spec)!.replace(/^\.\//, "");
    expect(target).toBe(file);
    expect(() => readFileSync(join(PKG, target))).not.toThrow();
    expect(
      pkg.files.some((f) => target === f || target.startsWith(`${f}/`)),
    ).toBe(true);
  });
  it("GENERATED.sha256 pins the Locker files", () => {
    const sums = read("GENERATED.sha256");
    for (const f of [
      "css/locker.css",
      "web/locker/site.webmanifest",
      "locker-kit/tokens/locker.css",
      "locker-kit/logos/svg/locker-mark-dark-micro.svg",
    ])
      expect(sums).toContain(`  ${f}\n`);
  });
});

describe("the trimmed Locker horizontal lockup", () => {
  const kit = lockupSvg({
    kind: "locker",
    layout: "horizontal",
    theme: "dark",
  });
  const trim = lockupSvg({
    kind: "locker",
    layout: "horizontal",
    theme: "dark",
    trim: true,
    height: 40,
  });
  const inner = (s: string) => s.slice(s.indexOf(">") + 1);

  it("is the kit's artwork under a cropped viewBox, nothing redrawn", () => {
    expect(inner(trim)).toBe(inner(kit));
    expect(trim).toContain(
      `viewBox="${LOCKER_TRIM.x} ${LOCKER_TRIM.y} ${LOCKER_TRIM.width} ${LOCKER_TRIM.height}"`,
    );
  });

  it("keeps the mark art and the wordmark inside the crop (Chromium-measured: x 8..443)", () => {
    expect(LOCKER_TRIM.x).toBeLessThanOrEqual(8);
    expect(LOCKER_TRIM.x + LOCKER_TRIM.width).toBeGreaterThanOrEqual(443);
    expect(LOCKER_TRIM.y).toBeLessThanOrEqual(23.67);
    expect(LOCKER_TRIM.y + LOCKER_TRIM.height).toBeGreaterThanOrEqual(102);
    expect(LOCKER_TRIM.x + LOCKER_TRIM.width).toBeLessThanOrEqual(460);
  });

  it("meets the guide's 180 px minimum from 33 px tall up; stacked refuses trim", () => {
    const w = (h: number) =>
      Number(
        /width="([\d.]+)"/.exec(
          lockupSvg({ kind: "locker", trim: true, height: h }),
        )![1],
      );
    expect(w(32)).toBeLessThan(180);
    expect(w(33)).toBeGreaterThanOrEqual(180);
    expect(() =>
      lockupSvg({ kind: "locker", layout: "stacked", trim: true }),
    ).toThrow(RangeError);
  });
});
