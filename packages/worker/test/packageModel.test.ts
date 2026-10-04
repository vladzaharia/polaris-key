/**
 * F-03 — the data model learns `package` (plans/F-01.md §6.3): `stmtUpsertDeliverable` (model.ts),
 * the resync's package rows (deliverables.ts), and the render queue's coalescing
 * (core/registryQueue.ts).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import {
  ReleaseModelError,
  stmtUpsertDeliverable,
} from "../src/services/release/model.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import {
  readRenderQueue,
  stmtConsumeRender,
  stmtEnqueuePackageRender,
} from "../src/core/registryQueue.js";
import type { ManifestPackageDeliverable } from "@polaris-key/manifest";

let db: Db;
beforeEach(async () => {
  db = makeTestDb();
  await seedProduct(db, "acme");
});

const NPM: ManifestPackageDeliverable = {
  kind: "package",
  id: "npm.sdk",
  ecosystem: "npm",
  name: "@acme/sdk",
  artifacts: { tarball: { match: "*.tgz" } },
};

const row = (id: string) =>
  db.first<Record<string, unknown>>(
    "SELECT kind, ecosystem, package_name, def_json FROM release_deliverables WHERE product = 'acme' AND deliverable_id = ?",
    id,
  );

describe("stmtUpsertDeliverable and package rows (F-03)", () => {
  it("a package needs its ecosystem and name, and nothing else may carry them", () => {
    expect(() =>
      stmtUpsertDeliverable(
        { product: "acme", deliverableId: "npm.sdk", kind: "package" },
        NOW,
      ),
    ).toThrow(ReleaseModelError);
    expect(() =>
      stmtUpsertDeliverable(
        {
          product: "acme",
          deliverableId: "app",
          kind: "app",
          ecosystem: "npm",
          packageName: "@acme/sdk",
        },
        NOW,
      ),
    ).toThrow(ReleaseModelError);
    expect(() =>
      stmtUpsertDeliverable(
        {
          product: "acme",
          deliverableId: "npm.sdk",
          kind: "package",
          packType: "files.tree",
          ecosystem: "npm",
          packageName: "@acme/sdk",
        },
        NOW,
      ),
    ).toThrow(ReleaseModelError);
  });

  it("resync writes each declared package, and drops an undeclared one only while it has no release", async () => {
    await db.batch(manifestDeliverableStatements("acme", null, NOW, [], [NPM]));
    expect(await row("npm.sdk")).toMatchObject({
      kind: "package",
      ecosystem: "npm",
      package_name: "@acme/sdk",
    });
    // Undeclared, never released: gone.
    await db.batch(manifestDeliverableStatements("acme", null, NOW, [], []));
    expect(await row("npm.sdk")).toBeNull();
    // Declared and released, then undeclared: kept (its versions are unique forever).
    await db.batch(manifestDeliverableStatements("acme", null, NOW, [], [NPM]));
    await db.run(
      `INSERT INTO release_metadata (product, release_id, version, metadata_access, artifacts_access,
         created_at, modified_at, deliverable_id, seq)
       VALUES ('acme', 'npm.sdk@1.0.0', '1.0.0', 'public', 'public', ?, ?, 'npm.sdk', 1)`,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_packages (product, ecosystem, name_norm, version, deliverable_id,
         release_id, name, files_json, metadata_json, source_json, published_at)
       VALUES ('acme', 'npm', '@acme/sdk', '1.0.0', 'npm.sdk', 'npm.sdk@1.0.0', '@acme/sdk', '[]',
               '{}', '{}', ?)`,
      NOW,
    );
    await db.batch(manifestDeliverableStatements("acme", null, NOW, [], []));
    expect(await row("npm.sdk")).not.toBeNull();
    // A released package's name never changes under its versions.
    await db.batch(
      manifestDeliverableStatements(
        "acme",
        null,
        NOW,
        [],
        [{ ...NPM, name: "@acme/renamed" }],
      ),
    );
    expect(await row("npm.sdk")).toMatchObject({ package_name: "@acme/sdk" });
  });

  it("the app row stays an app's, beside packages", async () => {
    await db.batch(manifestDeliverableStatements("acme", null, NOW, [], [NPM]));
    expect(await row("app")).toMatchObject({ kind: "app", ecosystem: null });
  });
});

describe("the render queue coalesces and never loses an enqueue (F-03)", () => {
  it("bumps the generation on a re-enqueue, and a drain consumes only the generation it read", async () => {
    const enq = async (reason: "publish" | "yank") => {
      const s = stmtEnqueuePackageRender("acme", "npm.sdk", reason, NOW);
      await db.run(s.sql, ...s.params);
    };
    await enq("publish");
    const [read] = await readRenderQueue(db, 10);
    expect(read).toMatchObject({ deliverableId: "npm.sdk", generation: 1 });
    // An enqueue lands while the render runs.
    await enq("yank");
    const c = stmtConsumeRender(read!);
    await db.run(c.sql, ...c.params);
    const left = await readRenderQueue(db, 10);
    expect(left).toEqual([
      expect.objectContaining({ reason: "yank", generation: 2 }),
    ]);
    const c2 = stmtConsumeRender(left[0]!);
    await db.run(c2.sql, ...c2.params);
    expect(await readRenderQueue(db, 10)).toEqual([]);
  });
});
