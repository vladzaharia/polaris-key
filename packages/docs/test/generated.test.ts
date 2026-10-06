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
import { createTableColumns, EMITTERS } from "../scripts/gen-reference.mjs";

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

describe("the data model's column parser", () => {
  it("skips table constraints but keeps columns that only start with a keyword", () => {
    const body = `
  product     TEXT NOT NULL,
  checked_at  INTEGER,
  unique_hash TEXT,
  primary_owner TEXT,
  constraint_note TEXT,
  -- a comment
  PRIMARY KEY (product, checked_at),
  UNIQUE (unique_hash),
  FOREIGN KEY (product) REFERENCES products(slug),
  CHECK (checked_at IS NULL OR checked_at > 0),
  check(product <> ''),
  CONSTRAINT one_owner UNIQUE (primary_owner)`;
    expect((createTableColumns as (body: string) => string[])(body)).toEqual([
      "product",
      "checked_at",
      "unique_hash",
      "primary_owner",
      "constraint_note",
    ]);
  });

  it("lists hosted_assets.checked_at on the data-model page", () => {
    const page = (EMITTERS as Record<string, () => string>)[
      "data-model.mdx"
    ]!();
    const row = page.split("\n").find((l) => l.startsWith("| `hosted_assets`"));
    expect(row).toContain("`checked_at`");
  });
});
