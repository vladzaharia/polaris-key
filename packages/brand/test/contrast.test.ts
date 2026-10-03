// WCAG AA, table-driven: every text token on every surface (and on the tinted surfaces it can
// sit on) clears 4.5:1; every UI token that bounds a control or signals state clears 3:1.
// The table is the documentation: BRAND.md's contrast column is generated from the same numbers.

import { describe, expect, it } from "vitest";

import { contrastRatio } from "../src/color.js";
import { SERVICE_ACCENTS, THEME_TOKENS } from "../src/generated/tokens.js";
import { BRAND } from "../src/tokens/primitives.js";
import {
  SERVICE_IDS,
  STATUS_IDS,
  THEMES,
  type Theme,
} from "../src/tokens/source.js";

interface Pair {
  theme: Theme;
  fg: string;
  bg: string;
  fgHex: string;
  bgHex: string;
  min: 4.5 | 3;
}

function pairs(): Pair[] {
  const out: Pair[] = [];
  const add = (
    theme: Theme,
    fg: string,
    fgHex: string,
    bg: string,
    bgHex: string,
    min: 4.5 | 3,
  ) => out.push({ theme, fg, bg, fgHex, bgHex, min });
  for (const theme of THEMES) {
    const t = THEME_TOKENS[theme];
    const surfaces = Object.entries(t.surface);
    for (const [sn, s] of surfaces) {
      const bg = `surface.${sn}`;
      for (const k of ["strong", "default", "muted", "subtle"] as const)
        add(theme, `text.${k}`, t.text[k], bg, s, 4.5);
      add(theme, "border.strong", t.border.strong, bg, s, 3);
      add(theme, "focus", t.focus, bg, s, 3);
      for (const id of SERVICE_IDS) {
        const a = SERVICE_ACCENTS[theme][id];
        add(theme, `service.${id}.fg`, a.fg, bg, s, 4.5);
        add(theme, `service.${id}.solid`, a.solid, bg, s, 3);
      }
      for (const st of STATUS_IDS)
        add(theme, `${st}.fg`, t.status[st].fg, bg, s, 4.5);
      add(theme, "signed.solid", t.signed.solid, bg, s, 3);
    }
    add(
      theme,
      "text.onAccent",
      t.text.onAccent,
      "service.core.solid",
      SERVICE_ACCENTS[theme].core.solid,
      4.5,
    );
    for (const id of SERVICE_IDS) {
      const a = SERVICE_ACCENTS[theme][id];
      add(theme, `service.${id}.on`, a.on, `service.${id}.solid`, a.solid, 4.5);
      add(
        theme,
        `service.${id}.fg`,
        a.fg,
        `service.${id}.subtle`,
        a.subtle,
        4.5,
      );
      add(
        theme,
        `service.${id}.solid`,
        a.solid,
        `service.${id}.subtle`,
        a.subtle,
        3,
      );
      add(
        theme,
        "text.default",
        t.text.default,
        `service.${id}.subtle`,
        a.subtle,
        4.5,
      );
      add(
        theme,
        "text.strong",
        t.text.strong,
        `service.${id}.subtle`,
        a.subtle,
        4.5,
      );
      // The section bit sits on the console header, which is the page or raised surface. Core
      // draws no bit (owner decision 2026-10-03), so it has nothing to test.
      if (a.bit !== null) {
        add(
          theme,
          `service.${id}.bit`,
          a.bit,
          "surface.page",
          t.surface.page,
          3,
        );
        add(
          theme,
          `service.${id}.bit`,
          a.bit,
          "surface.raised",
          t.surface.raised,
          3,
        );
      }
    }
    for (const st of STATUS_IDS) {
      const s = t.status[st];
      add(theme, `${st}.on`, s.on, `${st}.fg`, s.fg, 4.5);
      add(theme, `${st}.fg`, s.fg, `${st}.subtle`, s.subtle, 4.5);
      add(theme, "text.default", t.text.default, `${st}.subtle`, s.subtle, 4.5);
      add(theme, `${st}.border`, s.border, "surface.page", t.surface.page, 3);
      add(theme, `${st}.border`, s.border, `${st}.subtle`, s.subtle, 3);
    }
    const sg = t.signed;
    add(theme, "signed.on", sg.on, "signed.solid", sg.solid, 4.5);
    add(theme, "signed.solid", sg.solid, "signed.subtle", sg.subtle, 3);
    add(theme, "text.default", t.text.default, "signed.subtle", sg.subtle, 4.5);
    add(theme, "signed.border", sg.border, "surface.page", t.surface.page, 3);
    add(theme, "signed.border", sg.border, "signed.subtle", sg.subtle, 3);
    // The kit's own pairs, as the marks use them.
    add(
      theme,
      "brand.violet (mark)",
      BRAND.violet[theme],
      "brand.page",
      BRAND.page[theme],
      3,
    );
    add(
      theme,
      "brand.gold (bit)",
      BRAND.gold[theme],
      "brand.page",
      BRAND.page[theme],
      3,
    );
  }
  return out;
}

describe("WCAG AA contrast", () => {
  it.each(
    pairs().map(
      (p) => [`${p.theme}: ${p.fg} on ${p.bg} >= ${p.min}:1`, p] as const,
    ),
  )("%s", (_, p) => {
    expect(contrastRatio(p.fgHex, p.bgHex)).toBeGreaterThanOrEqual(p.min);
  });

  it("the dark page ground is the kit's and light text on it clears AAA", () => {
    expect(THEME_TOKENS.dark.surface.page).toBe(BRAND.page.dark);
    expect(THEME_TOKENS.light.surface.page).toBe(BRAND.page.light);
    expect(
      contrastRatio(THEME_TOKENS.dark.text.default, BRAND.page.dark),
    ).toBeGreaterThan(7);
    expect(
      contrastRatio(THEME_TOKENS.light.text.default, BRAND.page.light),
    ).toBeGreaterThan(7);
  });

  it("text tokens step down in contrast: strong > default > muted > subtle", () => {
    for (const theme of THEMES) {
      const t = THEME_TOKENS[theme];
      const c = (x: string) => contrastRatio(x, t.surface.page);
      expect(c(t.text.strong)).toBeGreaterThan(c(t.text.default));
      expect(c(t.text.default)).toBeGreaterThan(c(t.text.muted));
      expect(c(t.text.muted)).toBeGreaterThan(c(t.text.subtle));
    }
  });

  it("surfaces layer from the page ground without gradients (opaque, distinct steps)", () => {
    for (const theme of THEMES) {
      const s = THEME_TOKENS[theme].surface;
      for (const v of Object.values(s)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
      expect(new Set([s.page, s.raised, s.sunken]).size).toBe(3);
    }
  });
});
