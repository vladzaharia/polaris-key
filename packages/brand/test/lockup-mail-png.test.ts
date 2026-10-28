import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCKER_TRIM } from "../src/tokens/primitives.js";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lockups",
  "mail",
);
const size = (f: string) => {
  const b = readFileSync(join(dir, f));
  return {
    w: b.readUInt32BE(16),
    h: b.readUInt32BE(20),
    sig: b.subarray(1, 4).toString(),
  };
};

describe("the Locker lockup PNGs for mail (pnpm lockup-mail-png)", () => {
  for (const theme of ["light", "dark"]) {
    it(`${theme}: a 2x raster of the re-laid trimmed lockup, 52 px tall`, () => {
      const { w, h, sig } = size(`locker-lockup-${theme}-2x.png`);
      expect(sig).toBe("PNG");
      expect(h).toBe(52);
      expect(
        Math.abs(w - (52 * LOCKER_TRIM.width) / LOCKER_TRIM.height),
      ).toBeLessThan(1);
    });
  }
});
