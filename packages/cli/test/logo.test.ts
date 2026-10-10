/**
 * The `pkey` logo: drawn only on a Unicode terminal with room, in the overview header; the
 * collapsed star on a Unicode terminal without; the previous header everywhere else; and baked art
 * that fails here when the brand key mark changes.
 */

import { cellWidth, stripAnsi } from "@polaris-key/node/terminal";
import { describe, expect, it } from "vitest";
import { renderHelp, renderCommandHelp, findCommand } from "../src/help.js";
import {
  LOGO_ART,
  LOGO_COLS,
  LOGO_STAR,
  LOGO_STAR_GLYPH,
  logoLines,
} from "../src/logo.js";
import { termFor, type TermEnv, type TermFlags } from "../src/terminal.js";
import { readGeometry, renderLogo } from "../scripts/gen-logo.mjs";

const ESC = "\x1b";
const TEXT_ROWS = [
  "pkey",
  "Polaris Key platform CLI",
  "",
  "Usage  pkey <command> [options]",
];

function term(
  opts: {
    tty?: boolean;
    columns?: number;
    rows?: number;
    env?: TermEnv;
    flags?: TermFlags;
  } = {},
) {
  const out = {
    isTTY: opts.tty ?? true,
    columns: opts.columns ?? 80,
    rows: opts.rows ?? 24,
    write: () => true,
  };
  return termFor(out, opts.env ?? {}, opts.flags);
}

/** The overview as lines, the way a pipe prints it: the header before it had a logo. */
const piped = (columns = 80) =>
  stripAnsi(
    renderHelp(
      columns === 80
        ? term({ tty: false })
        : term({ columns, env: { CI: "true" } }),
    ),
  ).split("\n");
const sansHeader = (lines: string[]) => lines.slice(lines.indexOf("Manifest"));

describe("the logo header on a Unicode terminal with room", () => {
  const lines = renderHelp(term()).split("\n");
  const plain = lines.map(stripAnsi);

  it("starts with the art, then the text block centred beside it, then the body unchanged", () => {
    plain.slice(0, LOGO_ART.length).forEach((row, r) => {
      expect(row.startsWith(LOGO_ART[r]!)).toBe(true);
    });
    const top = 3;
    TEXT_ROWS.forEach((text, i) => {
      const row = plain[top + i]!;
      if (!text) expect(row.trim()).toBe(LOGO_ART[top + i]!.trim());
      else {
        expect(row.slice(LOGO_ART[top + i]!.length).trim()).toBe(text);
        expect(row.indexOf(text)).toBe(LOGO_COLS + 2);
      }
    });
    expect(plain[LOGO_ART.length]).toBe("");
    expect(sansHeader(plain)).toEqual(sansHeader(piped()));
  });

  it("paints star cells strong and every other cell muted", () => {
    const art = logoLines(term())!;
    expect(art).toHaveLength(LOGO_ART.length);
    let stars = 0;
    art.forEach((line, r) => {
      let col = 0;
      for (const span of line) {
        for (const ch of span.text) {
          const star = LOGO_STAR[r]![col++] === "1";
          stars += star ? 1 : 0;
          if (ch === " ") expect(span.style).toBeUndefined();
          else expect(span.style).toEqual([star ? "strong" : "muted"]);
        }
      }
    });
    expect(stars).toBeGreaterThan(0);
    expect(lines[0]).toContain(ESC);
  });

  it("has no trailing spaces and draws no colour when colour is off", () => {
    for (const l of plain) expect(l).toBe(l.trimEnd());
    // As everywhere in pkey, NO_COLOR drops colour and keeps weight (bold, dim).
    for (const opts of [
      { env: { NO_COLOR: "1" } },
      { flags: { color: false } },
    ])
      expect(renderHelp(term(opts))).not.toMatch(
        /\x1b\[(?:3[0-79]|9[0-7]|4[0-79]|10[0-7]|[34]8)/,
      );
    expect(renderHelp(term({ tty: false }))).not.toContain(ESC);
  });

  it("fits the columns at 50, 80 and 120", () => {
    for (const columns of [50, 80, 120]) {
      const out = renderHelp(term({ columns })).split("\n");
      expect(stripAnsi(out[0]!).startsWith(LOGO_ART[0]!)).toBe(true);
      for (const l of out)
        expect(cellWidth(l)).toBeLessThanOrEqual(Math.min(columns, 80));
    }
  });
});

describe("the previous header", () => {
  const before = piped();
  const cases: Array<[string, Parameters<typeof term>[0]]> = [
    ["a pipe", { tty: false }],
    ["CI", { env: { CI: "true" } }],
    ["--ascii", { flags: { ascii: true } }],
    ["TERM=dumb", { env: { TERM: "dumb" } }],
  ];
  for (const [name, opts] of cases)
    it(`stays for ${name}`, () => {
      const out = renderHelp(term(opts));
      expect(
        stripAnsi(out)
          .split("\n")
          .map((l) => l.replace(/ - /, " · ")),
      ).toEqual(before.map((l) => l.replace(/ - /, " · ")));
      expect(out).not.toContain(LOGO_STAR_GLYPH);
      for (const row of LOGO_ART) expect(out).not.toContain(row.trim());
    });

  it("stays under --json", () => {
    const t = term();
    t.caps.json = true;
    expect(logoLines(t)).toBeNull();
    expect(stripAnsi(renderHelp(t)).split("\n")).toEqual(before);
  });

  it("stays in a command's own help", () => {
    const t = term();
    const out = renderCommandHelp(t, findCommand("validate")!);
    for (const row of LOGO_ART) expect(out).not.toContain(row.trim());
    expect(out).not.toContain(LOGO_STAR_GLYPH);
  });
});

describe("the collapsed star", () => {
  for (const [columns, rows] of [
    [49, 24],
    [60, 10],
    [80, 23],
  ] as const)
    it(`replaces the art at ${columns}x${rows}`, () => {
      const t = term({ columns, rows });
      expect(logoLines(t)).toBeNull();
      const lines = renderHelp(t).split("\n");
      expect(stripAnsi(lines[0]!)).toBe(
        `${LOGO_STAR_GLYPH} pkey · Polaris Key platform CLI`.slice(0, 80),
      );
      expect(lines[0]).toContain(`${ESC}[1m${LOGO_STAR_GLYPH} `);
      expect(sansHeader(lines.map(stripAnsi))).toEqual(
        sansHeader(piped(columns)),
      );
    });

  it("measures one cell", () => {
    expect(cellWidth(LOGO_STAR_GLYPH)).toBe(1);
  });
});

describe("the baked art", () => {
  it("is what the brand key mark renders to", () => {
    const { art, star } = renderLogo(readGeometry());
    expect(LOGO_ART).toEqual(art);
    expect(LOGO_STAR).toEqual(star);
    expect(art.every((r: string) => cellWidth(r) <= LOGO_COLS)).toBe(true);
  });
});
