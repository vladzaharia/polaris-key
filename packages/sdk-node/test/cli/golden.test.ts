// @pkey-feature ui.cli
// The Node terminal kit's baselines (docs/design/UI-KITS.md §7.1 "Terminal"): every component ×
// state it draws, in truecolor (dark and light), ANSI-16, NO_COLOR and ASCII, at 80 and 60
// columns, as golden ANSI text (golden/ansi/<state>.ansi), plus an SVG of the truecolor 80-column
// render in each theme (golden/svg/) and the PNG the docs show (golden/<state>-<theme>.png,
// rasterised from the SVG by scripts/render-goldens.mjs).
//
// A changed baseline fails until it is re-recorded in the same change, with the reason in the
// commit: PKEY_UPDATE_GOLDENS=1 pnpm --filter @polaris-key/node test test/cli/golden.test.ts
// (then `node packages/sdk-node/scripts/render-goldens.mjs` for the PNGs).
//
// The same renders carry the kit's checks: the 80/60-column layout lint, NO_COLOR and ASCII
// purity, no secret in any byte written, and the string lint (every visible word is catalog copy
// or the scenario's own data, proven by rendering under a pseudo-locale).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KIT_COPY } from "../../src/kitCopy.generated.js";
import { TERMINAL_SYMBOLS } from "../../src/cli/tokens.generated.js";
import { cellWidth, stripAnsi } from "../../src/cli/term/width.js";
import { KEY_SECRET, render, VARIANTS, type Variant } from "./harness.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { ansiToSvg } from "./svg.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "golden");
const UPDATE = process.env.PKEY_UPDATE_GOLDENS === "1";
const COMPONENTS = JSON.parse(
  readFileSync(join(HERE, "../../../brand/kit-copy/components.json"), "utf8"),
) as { components: Record<string, { states: Record<string, unknown> }> };

const kebab = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

async function renderAll(
  s: Scenario,
): Promise<Map<string, { text: string; raw: string; stderr: string }>> {
  const out = new Map<string, { text: string; raw: string; stderr: string }>();
  for (const v of VARIANTS)
    out.set(v.id, await render({ ...s.opts, variant: v }, s.run));
  return out;
}

function goldenText(renders: Map<string, { text: string }>): string {
  return [...renders].map(([id, r]) => `#### ${id}\n${r.text}\n`).join("\n");
}

function check(file: string, actual: string): void {
  if (UPDATE) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  expect(
    existsSync(file),
    `${file} is missing: re-record with PKEY_UPDATE_GOLDENS=1`,
  ).toBe(true);
  expect(
    actual,
    `${file} changed: re-record with PKEY_UPDATE_GOLDENS=1 and say why in the commit`,
  ).toBe(readFileSync(file, "utf8"));
}

const variant = (id: string): Variant => VARIANTS.find((v) => v.id === id)!;
const UNICODE_ONLY = new Set(
  Object.values(TERMINAL_SYMBOLS.unicode)
    .join("")
    .replace(/[\x20-\x7e]/g, ""),
);
UNICODE_ONLY.add("•");
UNICODE_ONLY.add("▌");
for (const f of "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏") UNICODE_ONLY.add(f);

describe("the terminal kit's baselines", () => {
  it("names every scenario after a components.json state (or help)", () => {
    for (const s of SCENARIOS) {
      if (s.name.startsWith("help")) continue;
      const comp = Object.keys(COMPONENTS.components)
        .filter((c) => s.name === kebab(c) || s.name.startsWith(`${kebab(c)}-`))
        .sort((a, b) => kebab(b).length - kebab(a).length)[0];
      expect(comp, s.name).toBeDefined();
      const rest = s.name.slice(kebab(comp!).length + 1);
      const states = Object.keys(COMPONENTS.components[comp!]!.states);
      expect(
        states.some((st) => rest === st || rest.startsWith(`${st}-`)),
        `${s.name}: "${rest}" starts with no state of ${comp}`,
      ).toBe(true);
    }
  });

  for (const s of SCENARIOS) {
    it(`${s.name}: golden text in every variant, an SVG per theme, and the layout checks`, async () => {
      const renders = await renderAll(s);
      check(join(GOLDEN, "ansi", `${s.name}.ansi`), goldenText(renders));
      for (const theme of ["dark", "light"] as const) {
        const r = renders.get(`truecolor-80-${theme}`)!;
        check(
          join(GOLDEN, "svg", `${s.name}-${theme}.svg`),
          ansiToSvg(r.text, {
            theme,
            columns: 80,
            title: "tidewater — 80 × 24",
          }),
        );
      }
      for (const [id, r] of renders) {
        const v = variant(id);
        // The 80/60-column lint (UI-KITS §1.5 rule 13, §7.3).
        for (const line of r.text.split("\n"))
          expect(
            cellWidth(line),
            `${s.name} ${id}: "${stripAnsi(line)}"`,
          ).toBeLessThanOrEqual(v.columns);
        // Never a key, a poll credential or a device token, in any byte written.
        for (const out of [r.raw, r.stderr]) {
          expect(out).not.toContain(KEY_SECRET);
          expect(out).not.toContain("dc_secret");
          expect(out).not.toContain("pkeyt_");
        }
        if (v.color === "none")
          expect(
            r.raw,
            `${s.name} ${id}: an SGR escape under NO_COLOR`,
          ).not.toMatch(/\x1b\[[0-9;]*m/);
        if (v.ascii)
          for (const ch of stripAnsi(r.text))
            expect(
              UNICODE_ONLY.has(ch),
              `${s.name} ${id}: "${ch}" in ASCII mode`,
            ).toBe(false);
      }
    });
  }

  it("shows only catalog copy and each scenario's data (the string lint, by pseudo-locale)", async () => {
    const pseudo = Object.fromEntries(
      Object.entries(KIT_COPY.en).map(([k, v]) => [k, `⟦${v}⟧`]),
    );
    for (const s of SCENARIOS) {
      const r = await render(
        {
          ...s.opts,
          variant: variant("no-color-80"),
          theme: { copy: { overrides: { en: pseudo } } },
        },
        s.run,
      );
      let text = stripAnsi(`${r.text}\n${r.stderr}`);
      // Catalog text, possibly wrapped across lines and rails.
      text = text.replace(/⟦[^⟧]*⟧/gs, " ");
      for (const d of [...s.data].sort((a, b) => b.length - a.length))
        text = text.split(d).join(" ");
      // Glyphs, rails, bullets, codes and the figures the platform formats (Intl).
      text = text
        .replace(/[\s│┌└◆◇✓✗▲●○━·…•▌⠋█▀▄|`*+!#()\-[\]⟦⟧:,./%<>]/g, " ")
        .replace(/\b\d+(\.\d+)?\b/g, " ")
        .replace(/\b(MB|kB|sec|min|hr|Oct|Sep)\b/g, " ")
        .trim();
      expect(
        text,
        `${s.name}: words outside the catalog and the scenario's data`,
      ).toBe("");
    }
  });

  it("has a PNG for every SVG, rendered from that SVG (scripts/render-goldens.mjs)", () => {
    const manifest = join(GOLDEN, "png-sources.json");
    if (UPDATE && !existsSync(manifest)) return;
    const recorded = JSON.parse(readFileSync(manifest, "utf8")) as Record<
      string,
      string
    >;
    const svgs = readdirSync(join(GOLDEN, "svg"))
      .filter((f) => f.endsWith(".svg"))
      .sort();
    const expected = Object.fromEntries(
      svgs.map((f) => [
        f.replace(/\.svg$/, ".png"),
        createHash("sha256")
          .update(readFileSync(join(GOLDEN, "svg", f)))
          .digest("hex"),
      ]),
    );
    expect(
      recorded,
      "a PNG is stale: run node packages/sdk-node/scripts/render-goldens.mjs",
    ).toEqual(expected);
    for (const png of Object.keys(expected))
      expect(existsSync(join(GOLDEN, png)), png).toBe(true);
  });
});
