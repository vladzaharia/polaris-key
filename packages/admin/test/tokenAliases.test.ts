import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The token alias smoke test (docs/design/ADMIN.md §7.2, chunk 1).
 *
 * Tailwind v4 emits nothing for a colour utility whose `--color-*` token does not exist, so a
 * renamed or forgotten alias is a silent unstyled element, not a build error. This sweeps every
 * class-shaped token in `src/` and requires each colour utility to resolve to a token that
 * `styles.css` (the pre-brand alias layer) or the brand's `theme.css` defines, and requires every
 * alias to point at a custom property that actually exists.
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
  text: /^(xs|sm|base|lg|[2-9]?xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|clip|ellipsis)$/,
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

describe("the token alias layer", () => {
  it("styles.css defines every pre-brand alias the views were written against", () => {
    for (const name of [
      "background",
      "foreground",
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
      "primary",
      "primary-foreground",
      "secondary",
      "secondary-foreground",
      "muted",
      "muted-foreground",
      "hover",
      "destructive",
      "destructive-foreground",
      "success-foreground",
      "warning-foreground",
      "input",
      "ring",
      "sidebar",
      "sidebar-foreground",
      "sidebar-border",
      "sidebar-accent",
    ])
      expect(aliasColors.has(name), `--color-${name}`).toBe(true);
  });

  it("every alias points at a custom property that exists", () => {
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

  it("no alias shadows a brand token with a different meaning", () => {
    for (const name of aliasColors.keys())
      expect(brandColors.has(name), `--color-${name}`).toBe(false);
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
