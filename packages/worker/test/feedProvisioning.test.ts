/**
 * F-34.2: the manifest ingest provisions package feeds. A declared package makes an enabled
 * Customers (`licensed`) feed with the exact namespace derived from the declared names, and the
 * owner row when the product has none; insert only, so a resync never updates, re-enables or
 * widens anything an operator holds; the system product is skipped; an ecosystem with no one
 * namespace provisions nothing and says why.
 */
import { describe, expect, it } from "vitest";
import {
  packageNamespaceProblem,
  parseManifest,
  SYSTEM_PRODUCT_SLUG,
} from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { NOW } from "./seed.js";
import { ingestFor } from "../src/core/ingest/pipeline.js";
import { SERVICES } from "../src/mount.js";
import { packageFeedOf } from "../src/services/distribution/registryFeeds.js";
import { feedProvisionPlan } from "../src/services/distribution/ingest.js";
import { distributionManifest } from "../src/services/distribution/ingest.js";
import type { IngestContext } from "../src/core/ingest/types.js";
import type { Db } from "../src/db/types.js";
import { envFor, minimal, SLUG } from "./ingest/world.js";

const pkg = (ecosystem: string, name: string) => ({
  kind: "package",
  ecosystem,
  name,
  artifacts: { files: { match: "*" } },
});

function filesWith(deliverables: Record<string, unknown>) {
  return minimal({ release: { deliverables } });
}

function parse(files: Record<string, string>) {
  const parsed = parseManifest(
    Object.fromEntries(
      Object.entries(files).map(([path, text]) => [
        path.replace(/^\.pkey\//, "").replace(/\.(json|yaml)$/, ""),
        text,
      ]),
    ),
  );
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.manifest;
}

async function run(
  db: Db,
  files: Record<string, string>,
  mode: "create" | "apply",
  now = NOW,
  product = SLUG,
) {
  return ingestFor(SERVICES).run(envFor(), db, {
    mode,
    product,
    manifest: parse(files),
    now,
    source: {
      origin: mode === "create" ? "link" : "resync",
      sha: null,
      files,
      fetchImpl: async () => new Response("no network", { status: 404 }),
    },
  });
}

/** A resync's Distribution contribution, run against `db` (the pipeline needs repo coordinates). */
async function resync(
  db: Db,
  files: Record<string, string>,
  now: number,
  enabled = true,
) {
  const c = await distributionManifest.prepare({
    manifest: parse(files),
    slug: SLUG,
    now,
    enabled,
    mode: "apply",
    scope: "full",
  } as unknown as IngestContext);
  await db.batch([...c.statements, ...c.audits]);
  return c;
}

const feeds = (db: Db, product = SLUG) =>
  db.all<Record<string, unknown>>(
    `SELECT ecosystem, enabled, access_mode, namespace_json, updated_by, version
       FROM dist_registry_feeds WHERE product = ? ORDER BY ecosystem`,
    product,
  );
const owner = (db: Db, product = SLUG) =>
  db.first<Record<string, unknown>>(
    "SELECT enabled, version, updated_by FROM dist_registry_owners WHERE product = ?",
    product,
  );
const audits = (db: Db, product = SLUG) =>
  db.all<Record<string, unknown>>(
    "SELECT target_id, actor_sub, after_json FROM audit WHERE product = ? AND action = 'distribution.feed.provision' ORDER BY target_id",
    product,
  );

const NPM = { "npm.sdk": pkg("npm", "@acme/sdk") };

describe("manifest-provisioned feeds (F-34.2)", () => {
  it("a declared npm package makes a Customers feed on its scope, with the owner on", async () => {
    const db = makeTestDb();
    const res = await run(db, filesWith(NPM), "create");
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(await feeds(db)).toEqual([
      {
        ecosystem: "npm",
        enabled: 1,
        access_mode: "licensed",
        namespace_json: JSON.stringify({ scope: "@acme" }),
        updated_by: "manifest",
        version: 1,
      },
    ]);
    expect(await owner(db)).toEqual({
      enabled: 1,
      version: 1,
      updated_by: "manifest",
    });
    // No console step: the feed settings the Release ingest reads are in place, and the
    // declared name passes the namespace check while another scope does not.
    const f = await packageFeedOf(db, SLUG, "npm");
    expect(f?.accessMode).toBe("licensed");
    expect(
      packageNamespaceProblem("npm", "@acme/sdk", f?.namespace),
    ).toBeNull();
    expect(
      packageNamespaceProblem("npm", "@other/sdk", f?.namespace),
    ).not.toBeNull();
  });

  it("confines Maven and Go to exact names, not wide prefixes", async () => {
    const plan = feedProvisionPlan(
      parse(
        filesWith({
          "maven.core": pkg("maven", "im.acme:core"),
          "go.mod": pkg("go", "example.com/acme/sdk"),
        }),
      ),
      SLUG,
    );
    const by = Object.fromEntries(plan.feeds.map((f) => [f.ecosystem, f]));
    expect(
      packageNamespaceProblem("maven", "im.acme:core", by.maven?.namespace),
    ).toBeNull();
    expect(
      packageNamespaceProblem("maven", "im.other:core", by.maven?.namespace),
    ).not.toBeNull();
    // The field is a prefix list: the exact groupId also admits its subgroups (the narrowest it
    // expresses, F-34.1).
    expect(
      packageNamespaceProblem("maven", "im.acme.sub:x", by.maven?.namespace),
    ).toBeNull();
    expect(
      packageNamespaceProblem("go", "example.com/acme/sdk", by.go?.namespace),
    ).toBeNull();
    expect(
      packageNamespaceProblem("go", "example.com/acme/other", by.go?.namespace),
    ).not.toBeNull();
  });

  it("is idempotent on resync and writes one audit row per created feed", async () => {
    const db = makeTestDb();
    const files = filesWith({
      ...NPM,
      "pypi.tools": pkg("pypi", "acme-tools"),
    });
    await run(db, files, "create");
    const a = await audits(db);
    expect(a.map((r) => r.target_id)).toEqual(["npm", "pypi"]);
    expect(a[0]?.actor_sub).toBe("resync");
    const before = [await feeds(db), await owner(db)];
    await resync(db, files, NOW + 60);
    expect([await feeds(db), await owner(db)]).toEqual(before);
    expect(await audits(db)).toEqual(a);
  });

  it("a later-declared ecosystem is added, the owner row untouched", async () => {
    const db = makeTestDb();
    await run(db, filesWith(NPM), "create");
    await resync(
      db,
      filesWith({ ...NPM, "pypi.tools": pkg("pypi", "acme-tools") }),
      NOW + 60,
    );
    expect((await feeds(db)).map((f) => f.ecosystem)).toEqual(["npm", "pypi"]);
    expect(await owner(db)).toMatchObject({ version: 1 });
    expect((await audits(db)).map((r) => r.target_id)).toEqual(["npm", "pypi"]);
  });

  it("keeps what an operator set: off owner, off feed, public feed, widened namespace", async () => {
    const db = makeTestDb();
    await run(db, filesWith(NPM), "create");
    await db.run(
      "UPDATE dist_registry_owners SET enabled = 0, updated_by = 'op' WHERE product = ?",
      SLUG,
    );
    await db.run(
      `UPDATE dist_registry_feeds SET enabled = 0, access_mode = 'public',
         namespace_json = '{"scope":"@wider"}', updated_by = 'op' WHERE product = ?`,
      SLUG,
    );
    await resync(
      db,
      filesWith({ ...NPM, "pypi.tools": pkg("pypi", "acme-tools") }),
      NOW + 60,
    );
    expect(await owner(db)).toEqual({
      enabled: 0,
      version: 1,
      updated_by: "op",
    });
    const [npm, pypi] = await feeds(db);
    expect(npm).toMatchObject({
      enabled: 0,
      access_mode: "public",
      namespace_json: '{"scope":"@wider"}',
      updated_by: "op",
    });
    // The new ecosystem is provisioned at Customers; the operator's off owner stays off.
    expect(pypi).toMatchObject({ access_mode: "licensed", enabled: 1 });
    expect((await audits(db)).map((r) => r.target_id)).toEqual(["npm", "pypi"]);
  });

  it("does not turn an owner on when the product already has a feed row", async () => {
    const db = makeTestDb();
    await run(db, minimal(), "create");
    await db.run(
      `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json,
         max_package_bytes, updated_at) VALUES (?, 'oci', 0, '{}', 1, ?)`,
      SLUG,
      NOW,
    );
    await resync(db, filesWith(NPM), NOW + 60);
    expect(await owner(db)).toBeNull();
    expect((await feeds(db)).map((f) => f.ecosystem)).toEqual(["npm", "oci"]);
  });

  it("several npm scopes provision nothing and the answer says why", async () => {
    const db = makeTestDb();
    const res = await run(
      db,
      filesWith({
        ...NPM,
        "npm.other": pkg("npm", "@other/sdk"),
        "pypi.tools": pkg("pypi", "acme-tools"),
      }),
      "create",
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect((await feeds(db)).map((f) => f.ecosystem)).toEqual(["pypi"]);
    expect((await audits(db)).map((r) => r.target_id)).toEqual(["pypi"]);
    if (res.ok)
      expect(res.facts.feedProvision).toEqual({
        skipped: [{ ecosystem: "npm", reason: expect.any(String) }],
      });
    // The publish side: no feed row, so the ingest finds no feed to publish into.
    expect(await packageFeedOf(db, SLUG, "npm")).toBeNull();
  });

  it("writes the rows while Distribution is off (the contribution is told so)", async () => {
    const db = makeTestDb();
    await run(db, minimal(), "create");
    const c = await resync(db, filesWith(NPM), NOW + 60, false);
    expect(c.updated).toEqual(["distribution"]);
    expect(await feeds(db)).toHaveLength(1);
    expect(await owner(db)).toMatchObject({ enabled: 1 });
    expect(await audits(db)).toHaveLength(1);
  });

  it("skips the system product", () => {
    const plan = feedProvisionPlan(parse(filesWith(NPM)), SYSTEM_PRODUCT_SLUG);
    expect(plan).toEqual({ feeds: [], skipped: [] });
  });

  it("provisions nothing for a manifest that declares no package", async () => {
    const db = makeTestDb();
    await run(db, minimal(), "create");
    expect(await feeds(db)).toEqual([]);
    expect(await owner(db)).toBeNull();
    expect(await audits(db)).toEqual([]);
  });
});
