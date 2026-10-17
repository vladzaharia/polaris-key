/**
 * P0-26 D8: the pipeline creates a product from documents with no repository (ST-43 adds the
 * route). The snapshot origin stays `link` with `applied_sha` NULL, no release coordinates are
 * written, and a declared `trustedPublisher` is refused (nothing to pin its repository ids to).
 */
import { describe, expect, it } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "../helpers.js";
import { NOW } from "../seed.js";
import { ingestFor } from "../../src/core/ingest/pipeline.js";
import { SERVICES } from "../../src/mount.js";
import { envFor, full, minimal, SLUG } from "./world.js";

const create = async (files: Record<string, string>) => {
  // `parseManifest` keys the documents by name; the snapshot keeps them by path.
  const parsed = parseManifest(
    Object.fromEntries(
      Object.entries(files).map(([path, text]) => [
        path.replace(/^\.pkey\//, "").replace(/\.(json|yaml)$/, ""),
        text,
      ]),
    ),
  );
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const db = makeTestDb();
  const res = await ingestFor(SERVICES).run(envFor(), db, {
    mode: "create",
    product: SLUG,
    manifest: parsed.manifest,
    now: NOW,
    source: {
      origin: "link",
      sha: null,
      files,
      fetchImpl: async () => new Response("no network", { status: 404 }),
    },
  });
  return { db, res };
};

describe("create from documents (D8)", () => {
  it("registers the product and its rows with no repository", async () => {
    const { db, res } = await create(minimal());
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(
      await db.first(
        "SELECT release_source FROM products WHERE slug = ?",
        SLUG,
      ),
    ).toEqual({ release_source: null });
    expect(
      await db.first(
        "SELECT origin, applied_sha FROM product_manifest_snapshot WHERE product = ?",
        SLUG,
      ),
    ).toEqual({ origin: "link", applied_sha: null });
    expect(
      await db.first(
        "SELECT COUNT(*) AS n FROM release_config WHERE product = ?",
        SLUG,
      ),
    ).toEqual({ n: 0 });
    expect(
      (await db.all("SELECT id FROM tiers WHERE product = ?", SLUG)).length,
    ).toBe(1);
  });

  it("accepts documents with no release block", async () => {
    const files = minimal();
    delete files[".pkey/release.json"];
    const { res } = await create(files);
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });

  it("refuses a declared trustedPublisher, failing closed", async () => {
    const { db, res } = await create(full());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("publishing.trustedPublisher");
    expect(
      await db.first("SELECT slug FROM products WHERE slug = ?", SLUG),
    ).toBeNull();
  });
});
