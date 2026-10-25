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
    ).toBe(2); // the manifest's tier and the Default tier (LX-33.7)
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

describe("the create dry run asks what the create refuses (P0-26b)", () => {
  const profileWithSecret = () =>
    minimal({
      product: {
        profiles: [
          {
            id: "standard",
            name: "Standard",
            payload: {
              config: {},
              secrets: {
                "api.key": {
                  state: "default",
                  value: "a-secret-value",
                  updatedAt: 0,
                },
              },
            },
          },
        ],
      },
    });

  it("plan reports the seal refusal the create makes, with no KEK", async () => {
    const files = profileWithSecret();
    const parsed = parseManifest(
      Object.fromEntries(
        Object.entries(files).map(([path, text]) => [
          path.replace(/^\.pkey\//, "").replace(/\.(json|yaml)$/, ""),
          text,
        ]),
      ),
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const env = envFor();
    delete (env as { PLATFORM_KEK?: string }).PLATFORM_KEK;
    const db = makeTestDb();
    const input = {
      mode: "create" as const,
      product: SLUG,
      manifest: parsed.manifest,
      now: NOW,
      source: {
        origin: "link" as const,
        sha: null,
        files,
        fetchImpl: async () => new Response("no", { status: 404 }),
      },
    };
    const ingest = ingestFor(SERVICES);
    const run = await ingest.run(env, db, input);
    expect(run.ok).toBe(false);
    const plan = await ingest.plan(env, db, input);
    expect(plan.problems.map((p) => p.check)).toContain("seal");
  });
});

describe("service coherence on a create with no repository (ST-43)", () => {
  const run = async (services: string[], starterTier?: "free" | "none") => {
    const { createFromDocuments } =
      await import("../../src/core/ingest/fromDocuments.js");
    const db = makeTestDb();
    const res = await createFromDocuments(envFor(), db, ingestFor(SERVICES), {
      slug: SLUG,
      name: "Acme",
      choices: {
        services: services as never,
        intendedPlatforms: [],
        starterTier: starterTier ?? null,
        trustReleaseWorkflow: false,
      },
      author: "ada",
      now: NOW,
    });
    return { db, res };
  };

  it.each([
    [["distribution"], "distribution_requires_release"],
    [["release", "update"], "update_requires_distribution"],
    [["sync"], "sync_requires_config"],
    [["config", "sync"], "sync_requires_identity"],
  ])("refuses %j with %s and writes nothing", async (services, code) => {
    const { db, res } = await run(services);
    expect(res.ok).toBe(false);
    if (!res.ok && "reason" in res) {
      expect(res.reason).toBe(code);
      expect(res.codes).toContain(code);
    }
    expect(
      await db.first("SELECT slug FROM products WHERE slug = ?", SLUG),
    ).toBeNull();
  });

  it("takes the list as it is: an empty list turns nothing on", async () => {
    const { db, res } = await run([], "none");
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const row = await db.first<{
      services_json: string;
      services_source: string;
    }>(
      "SELECT services_json, services_source FROM products WHERE slug = ?",
      SLUG,
    );
    expect(row?.services_source).toBe("admin");
    const on = Object.entries(JSON.parse(row!.services_json)).filter(
      ([, v]) => (v as { enabled: boolean }).enabled,
    );
    expect(on).toEqual([]);
  });

  it("refuses the Free tier without License", async () => {
    const { res } = await run(["config"], "free");
    expect(res.ok).toBe(false);
    if (!res.ok && "reason" in res)
      expect(res.reason).toBe("starter_tier_requires_license");
  });
});
