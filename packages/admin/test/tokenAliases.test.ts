import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cn } from "../src/lib/cn.js";

/**
 * The token smoke test (docs/design/ADMIN.md §7.2, chunks 1 and 11).
 *
 * Tailwind v4 emits nothing for a colour utility whose `--color-*` token does not exist, so a
 * renamed or forgotten token is a silent unstyled element, not a build error. This sweeps every
 * class-shaped token in `src/` and requires each colour utility to resolve to a token that the
 * brand's `theme.css` defines (or `styles.css`'s one admin token, `hover`), and requires every
 * admin token to point at a custom property that actually exists.
 *
 * The pre-brand alias layer (bg-card, text-muted-foreground, bg-primary, border-input, ring-ring,
 * font-medium and font-semibold as Rubik's 400 and 700…) was deleted in chunk 11, so a view that
 * reaches for one of those names fails the last case here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const styles = readFileSync(join(pkg, "src", "styles.css"), "utf8");
const brandTheme = readFileSync(
  join(pkg, "..", "brand", "css", "theme.css"),
  "utf8",
);
const brandTokens = readFileSync(
  join(pkg, "..", "brand", "css", "tokens.css"),
  "utf8",
);

/** `--<ns>-<name>: <value>;` declarations inside a CSS file's `@theme` blocks. */
function themeDecls(css: string, ns: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of css.matchAll(/@theme[^{]*\{([\s\S]*?)\n\}/g))
    for (const m of block[1]!.matchAll(
      new RegExp(`--${ns}-([a-z0-9-]+):\\s*([^;]+);`, "g"),
    ))
      out.set(m[1]!, m[2]!.trim());
  return out;
}

const aliasColors = themeDecls(styles, "color");
const brandColors = themeDecls(brandTheme, "color");
const colors = new Set([...aliasColors.keys(), ...brandColors.keys()]);
const shadows = new Set([
  ...themeDecls(styles, "shadow").keys(),
  ...themeDecls(brandTheme, "shadow").keys(),
]);

/** CSS keywords Tailwind provides as colours without a theme token. */
const KEYWORD_COLORS = new Set(["transparent", "current", "inherit"]);
/** Tailwind's default palette entries still allowed (overlays only). */
const PALETTE_COLORS = new Set(["black", "white"]);

/**
 * Values of colour-capable prefixes that are NOT colours. A new non-colour value fails the test
 * until it is listed here, which is the point: every value is classified on purpose.
 */
const NOT_COLOR: Record<string, RegExp> = {
  text: /^([23]?xs|sm|md|base|lg|[2-9]?xl|display|code|headline|headline-lg|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|clip|ellipsis)$/,
  border: /^(\d+|collapse|separate|solid|dashed|dotted|double|none|hidden)$/,
  divide: /^(x|y|\d+|x-\d+|y-\d+|solid|dashed|dotted|none)$/,
  outline: /^(hidden|none|\d+|solid|dashed|dotted|double|offset-\d+)$/,
  ring: /^(\d+|inset|offset-\d+)$/,
  shadow: /^(xs|sm|md|lg|xl|2xl|none|inner)$/,
  bg: /^(fixed|local|scroll|clip-[a-z]+|origin-[a-z]+|no-repeat|repeat|cover|contain|center|top|bottom|left|right|none)$/,
};

const PREFIX_RE =
  /^(ring-offset|border-[trblxy]|bg|text|border|ring|divide|outline|fill|stroke|accent|placeholder|from|to|via|decoration|caret|shadow)-([a-z][a-z0-9-]*)(\/\d+)?$/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".generated.ts"))
      yield full;
  }
}

interface Use {
  prefix: string;
  value: string;
  file: string;
}

function colorUtilityUses(): Use[] {
  const uses: Use[] = [];
  for (const file of sourceFiles(join(pkg, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const raw of text.match(/[A-Za-z0-9_:[\]&>=.\-/!]+/g) ?? []) {
      const base = raw.split(":").pop()!.replace(/^!/, "");
      const m = PREFIX_RE.exec(base);
      if (!m) continue;
      let prefix = m[1]!;
      let value = m[2]!;
      // border-t-0 / border-r-transparent: the side is part of the prefix.
      if (prefix === "border") {
        const side = /^([trblxy])(?:-(.+))?$/.exec(value);
        if (side) {
          if (!side[2]) continue; // a bare side width: border-t
          prefix = `border-${side[1]}`;
          value = side[2];
        }
      }
      const kind = prefix.startsWith("border-") ? "border" : prefix;
      if (prefix === "ring-offset" && /^\d+$/.test(value)) continue;
      if (NOT_COLOR[kind]?.test(value)) continue;
      uses.push({ prefix, value, file: file.slice(pkg.length + 1) });
    }
  }
  return uses;
}

describe("the admin's tokens on the brand", () => {
  it("styles.css defines no pre-brand alias: its one colour token is the admin fill", () => {
    expect([...aliasColors.keys()]).toEqual(["hover"]);
    expect(themeDecls(styles, "shadow").size).toBe(0);
    expect(themeDecls(styles, "font-weight").size).toBe(0);
  });

  it("every admin token points at a custom property that exists", () => {
    const defined = new Set(
      [...`${brandTokens}\n${styles}`.matchAll(/(--pk-[a-z0-9-]+)\s*:/g)].map(
        (m) => m[1]!,
      ),
    );
    for (const [name, value] of aliasColors) {
      const refs = [...value.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(
        (m) => m[1]!,
      );
      expect(refs.length, `--color-${name}: ${value}`).toBeGreaterThan(0);
      for (const ref of refs)
        expect(defined.has(ref), `--color-${name} → ${ref}`).toBe(true);
    }
  });

  it("no admin token shadows a brand token with a different meaning", () => {
    for (const name of aliasColors.keys())
      expect(brandColors.has(name), `--color-${name}`).toBe(false);
  });

  it("every type size is a named step, never an arbitrary text-[…] size (EXPERIENCE.md §3)", () => {
    const sizes = new Set(themeDecls(styles, "text").keys());
    for (const step of ["3xs", "2xs", "code", "md", "headline", "headline-lg"])
      expect(sizes.has(step), `--text-${step}`).toBe(true);
    const arbitrary: string[] = [];
    for (const file of sourceFiles(join(pkg, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(
        /\btext-\[(?:length:)?[\d.]+(?:rem|px|em)\]/g,
      ))
        arbitrary.push(`${m[0]} (${file.slice(pkg.length + 1)})`);
    }
    expect(arbitrary).toEqual([]);
  });

  it("cn() merges every admin type step as a font size, as it did the arbitrary sizes", () => {
    const steps = [...themeDecls(styles, "text").keys()].filter(
      (k) => !k.includes("--"),
    );
    expect(steps.length).toBeGreaterThan(5);
    for (const step of steps) {
      // Not a colour: a text colour beside it survives…
      expect(cn(`text-${step}`, "text-fg").split(" "), step).toEqual([
        `text-${step}`,
        "text-fg",
      ]);
      // …and it replaces another size, like any font size.
      expect(cn("text-sm", `text-${step}`), step).toBe(`text-${step}`);
    }
  });

  it("every colour utility used in src resolves to a defined token", () => {
    const uses = colorUtilityUses();
    expect(uses.length).toBeGreaterThan(500);
    const unresolved = uses
      .filter(({ prefix, value }) =>
        prefix === "shadow"
          ? !shadows.has(value)
          : !colors.has(value) &&
            !KEYWORD_COLORS.has(value) &&
            !PALETTE_COLORS.has(value),
      )
      .map(({ prefix, value, file }) => `${prefix}-${value} (${file})`);
    expect([...new Set(unresolved)]).toEqual([]);
  });
});
