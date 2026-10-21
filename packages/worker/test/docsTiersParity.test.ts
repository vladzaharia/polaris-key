/**
 * `docsTiers.generated.ts` is the docs build's per-file tier table (DOC-03b): the files only gated
 * pages load, and each moved-page redirect page at its target's tier. It must equal a fresh sweep
 * of the built site (skipped when there is no `packages/docs/dist`), so a page that starts or
 * stops loading a file cannot leave the Worker serving it at the wrong tier.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOCS_ASSET_TIERS,
  DOCS_REDIRECT_TIERS,
} from "../src/docsTiers.generated.js";
import { collectDocsTiers } from "../../docs/scripts/collect-docs-tiers.js";

const dist = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "dist",
);

describe.skipIf(!existsSync(dist))("docsTiers.generated.ts", () => {
  it("matches the built site", () => {
    const fresh = collectDocsTiers(dist);
    expect(DOCS_ASSET_TIERS).toEqual(fresh.assets);
    expect(DOCS_REDIRECT_TIERS).toEqual(fresh.redirects);
  });

  it("puts the old Help pages in the public tier", () => {
    expect(DOCS_REDIRECT_TIERS["/docs/users/activation/index.html"]).toBe(
      "public",
    );
  });
});
