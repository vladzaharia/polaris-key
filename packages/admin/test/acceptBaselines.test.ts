// @ts-expect-error plain .mjs script, no declarations
import * as ab from "../scripts/accept-baselines.mjs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

const BASE = "/b/linux";
const known = new Set([`${BASE}/home-desktop-dark.png`]);
const opts = { baselineDir: BASE, exists: (p: string) => known.has(p) };

function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = rgb[0];
    p.data[i + 1] = rgb[1];
    p.data[i + 2] = rgb[2];
    p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
}

describe("accept-baselines mapping", () => {
  it("maps an artifact path, nested or not, to its linux baseline", () => {
    for (const rel of [
      "home-desktop-dark.actual.png",
      "portal-visual-diff-3/home-desktop-dark.actual.png",
    ])
      expect(ab.mapToBaseline(rel, opts)).toEqual({
        name: "home-desktop-dark",
        dest: `${BASE}/home-desktop-dark.png`,
        isNew: false,
      });
  });

  it("refuses an unknown baseline unless new ones are allowed", () => {
    expect(() => ab.mapToBaseline("nope.actual.png", opts)).toThrow(
      /no known baseline/,
    );
    expect(
      ab.mapToBaseline("nope.actual.png", { ...opts, allowNew: true }).isNew,
    ).toBe(true);
  });

  it("refuses a path that escapes the baseline directory or is no actual image", () => {
    expect(() => ab.mapToBaseline("../x.actual.png", opts)).toThrow(
      /not a baseline name/,
    );
    expect(() => ab.mapToBaseline("a/../../x.actual.png", opts)).toThrow(
      /not a baseline name/,
    );
    expect(() => ab.mapToBaseline("home.diff.png", opts)).toThrow(/not a/);
  });

  it("refuses a run whose head is not an ancestor, and a malformed head", () => {
    const sha = "a".repeat(40);
    expect(() => ab.checkAncestry(sha, () => false)).toThrow(/not an ancestor/);
    expect(() => ab.checkAncestry("", () => true)).toThrow(/head SHA/);
    expect(() => ab.checkAncestry(sha, () => true)).not.toThrow();
  });

  it("parses the options and refuses bad combinations", () => {
    expect(ab.parseArgs(["123", "--job", "2", "--allow-new"])).toEqual({
      runId: "123",
      job: "2",
      fromDir: null,
      allowNew: true,
    });
    expect(ab.artifactName("2")).toBe("portal-visual-diff-2");
    expect(ab.artifactName("portal-visual-diff-2")).toBe(
      "portal-visual-diff-2",
    );
    expect(() => ab.parseArgs([])).toThrow(/run id/);
    expect(() => ab.parseArgs(["abc"])).toThrow(/numeric/);
    expect(() => ab.parseArgs(["1", "--from-dir", "x"])).toThrow(
      /alternatives/,
    );
    expect(() => ab.parseArgs(["--bogus"])).toThrow(/unknown option/);
  });

  it("summarises old to new, and a size change", () => {
    const a = png(4, 4, [0, 0, 0]);
    expect(ab.summarize("x", a, png(4, 4, [255, 255, 255]))).toMatch(
      /4x4 \d+ B -> 4x4 \d+ B, 100.00% changed/,
    );
    expect(ab.summarize("x", a, a)).toMatch(/0.00% changed/);
    expect(ab.summarize("x", a, png(4, 6, [0, 0, 0]))).toMatch(/size changed/);
    expect(ab.summarize("x", null, a)).toMatch(/^x: new 4x4/);
  });

  it("plans from a directory, refusing before any write", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-test-"));
    mkdirSync(join(dir, "portal-visual-diff-1"));
    writeFileSync(
      join(dir, "portal-visual-diff-1/home-desktop-dark.actual.png"),
      png(2, 2, [1, 2, 3]),
    );
    writeFileSync(
      join(dir, "portal-visual-diff-1/home-desktop-dark.diff.png"),
      png(2, 2, [9, 9, 9]),
    );
    const items = ab.plan(dir, opts);
    expect(items.map((i: { name: string }) => i.name)).toEqual([
      "home-desktop-dark",
    ]);
    expect(
      readFileSync(
        join(dir, "portal-visual-diff-1/home-desktop-dark.actual.png"),
      ),
    ).toEqual(items[0].bytes);
    writeFileSync(join(dir, "stray.actual.png"), png(2, 2, [1, 2, 3]));
    expect(() => ab.plan(dir, opts)).toThrow(/no known baseline/);
    expect(() => ab.plan(join(dir, "portal-visual-diff-1/x"), opts)).toThrow();
  });

  it("refuses the same name carried twice with different images", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-test-"));
    for (const [shard, c] of [
      ["1", 1],
      ["2", 2],
    ] as const) {
      mkdirSync(join(dir, `portal-visual-diff-${shard}`));
      writeFileSync(
        join(dir, `portal-visual-diff-${shard}/home-desktop-dark.actual.png`),
        png(2, 2, [c, c, c]),
      );
    }
    expect(() => ab.plan(dir, opts)).toThrow(/twice/);
  });
});
