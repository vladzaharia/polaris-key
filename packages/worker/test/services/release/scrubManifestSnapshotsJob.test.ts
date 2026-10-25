// The one-shot job that scrubs snapshots written before the scrub existed.
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { NOW, seedProduct } from "../../seed.js";
import { makeEnv } from "../../seed.js";
import { KvMock } from "../../kvMock.js";
import { stmtUpsertManifestSnapshot } from "../../../src/core/manifestSnapshot.js";
import { scrubManifestSnapshotsJob } from "../../../src/services/release/snapshotScrub.js";
import { migrationJobs } from "../../../src/core/contributions.js";
import "../../../src/mount.js";

const SECRET = "s3cret-value";
const manifest = {
  catalog: {
    schemaVersion: 1,
    entries: [
      {
        key: "api.key",
        kind: "secret",
        category: "a",
        label: "k",
        description: "",
        schema: { type: "string" },
      },
    ],
  },
  profiles: [
    {
      id: "p",
      payload: {
        config: {
          "api.key": { state: "enforced", value: SECRET, updatedAt: 0 },
          "api.url": { state: "enforced", value: "https://ok", updatedAt: 0 },
        },
        secrets: { t: { state: "enforced", value: SECRET, updatedAt: 0 } },
      },
    },
  ],
};

describe("release.scrub-manifest-snapshots", () => {
  it("is contributed, plans, applies once, and down restores nothing", async () => {
    expect(migrationJobs().map((j) => j.id)).toContain(
      scrubManifestSnapshotsJob.id,
    );
    const db = makeTestDb();
    await seedProduct(db, "snap");
    // A row written as the old code did: the manifest, unscrubbed.
    await db.batch([
      stmtUpsertManifestSnapshot({
        product: "snap",
        appliedSha: null,
        appliedAt: NOW,
        origin: "link",
        filesSha256: "f".repeat(64),
        manifest,
      }),
    ]);
    const ctx = { env: makeEnv(new KvMock(), []), db, now: NOW };
    expect(await scrubManifestSnapshotsJob.units(ctx)).toEqual(["snap"]);
    expect(await scrubManifestSnapshotsJob.plan(ctx, "snap")).toEqual({
      changes: 1,
    });
    expect(
      JSON.stringify(await scrubManifestSnapshotsJob.plan(ctx, "snap")),
    ).not.toContain(SECRET);

    expect(await scrubManifestSnapshotsJob.apply(ctx, "snap")).toBe(1);
    const row = await db.first<{ manifest_json: string; files_sha256: string }>(
      "SELECT manifest_json, files_sha256 FROM product_manifest_snapshot WHERE product = ?",
      "snap",
    );
    expect(row!.manifest_json).not.toContain(SECRET);
    expect(row!.manifest_json).toContain("https://ok");
    expect(row!.files_sha256).toBe("f".repeat(64));

    // Idempotent: nothing left to plan or change.
    expect(await scrubManifestSnapshotsJob.plan(ctx, "snap")).toEqual({
      changes: 0,
    });
    expect(await scrubManifestSnapshotsJob.apply(ctx, "snap")).toBe(0);

    // Down has nothing to restore.
    expect(await scrubManifestSnapshotsJob.down(ctx, "snap")).toBe(0);
    const after = await db.first<{ manifest_json: string }>(
      "SELECT manifest_json FROM product_manifest_snapshot WHERE product = ?",
      "snap",
    );
    expect(after!.manifest_json).toBe(row!.manifest_json);
  });
});
