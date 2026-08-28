/**
 * Freshness gate for the generated reference pages: every emitter's output must byte-equal
 * the committed page. A hand edit to a generated page, or a source change (new validation
 * code, new migration, new route) without regeneration, fails here — run
 * `pnpm --filter @polaris-key/docs gen` to update.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMITTERS } from "../scripts/gen-reference.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const referenceDir = join(here, "..", "src", "content", "docs", "reference");

describe("generated reference pages are current", () => {
  for (const [file, emit] of Object.entries(
    EMITTERS as Record<string, () => string>,
  )) {
    it(file, () => {
      const committed = readFileSync(join(referenceDir, file), "utf8");
      expect(committed).toBe(emit());
    });
  }
});
