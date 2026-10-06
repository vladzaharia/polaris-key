import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { compareDirs } from "../src/pixeldiff.ts";

function png(
  file: string,
  w: number,
  h: number,
  paint: (x: number, y: number) => number,
) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      p.data[i] = p.data[i + 1] = p.data[i + 2] = paint(x, y);
      p.data[i + 3] = 255;
    }
  writeFileSync(file, PNG.sync.write(p));
}

describe("the React/elements cross-renderer diff", () => {
  it("is inactive until both baseline sets exist", () => {
    expect(compareDirs("/nonexistent/a", "/nonexistent/b")).toBeNull();
  });

  it("matches identical renders, fails a drift, a size change and a state only one side renders", () => {
    const root = mkdtempSync(join(tmpdir(), "xdiff-"));
    const a = join(root, "react");
    const b = join(root, "elements");
    mkdirSync(a);
    mkdirSync(b);
    png(join(a, "gate-dark.png"), 20, 20, () => 40);
    png(join(b, "gate-dark.png"), 20, 20, () => 42);
    png(join(a, "activate-dark.png"), 20, 20, () => 40);
    png(join(b, "activate-dark.png"), 20, 20, (x) => (x < 4 ? 200 : 40));
    png(join(a, "settings-dark.png"), 20, 20, () => 40);
    png(join(b, "settings-dark.png"), 20, 21, () => 40);
    png(join(a, "update-dark.png"), 20, 20, () => 40);
    const r = compareDirs(a, b, { outDir: join(root, "out") })!;
    expect(Object.fromEntries(r.map((p) => [p.name, p.status]))).toEqual({
      "activate-dark.png": "mismatch",
      "gate-dark.png": "match",
      "settings-dark.png": "size",
      "update-dark.png": "only-a",
    });
  });
});
