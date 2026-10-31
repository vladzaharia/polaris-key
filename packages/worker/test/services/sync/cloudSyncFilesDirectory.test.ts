/**
 * U-10.11: the directory keeps a person's file bytes (`files`, `file_bytes`, `revision_bytes`),
 * the aggregate splits them from settings and records, and a merge adds them (D-10).
 */
import { beforeAll, describe, expect, it } from "vitest";
import "../../../src/index.js";
import type { ScheduledServiceContext } from "../../../src/core/registry.js";
import { syncScheduled } from "../../../src/services/sync/scheduled.js";
import { cloudSyncStore } from "../../../src/services/sync/subjectStore.js";
import { installDigestStream } from "../../r2Mock.js";
import { NOW } from "../../seed.js";
import {
  SLUG,
  bytesOf,
  filesWorld,
  push,
  stored,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";
import { hlc, nextId } from "./cloudSyncAbuseWorld.js";

beforeAll(() => installDigestStream());

/** A world whose objects flush their directory to the world's real D1. */
async function flushing(): Promise<FilesWorld> {
  const w = await filesWorld();
  (w.ns as unknown as { opts: { db?: unknown } }).opts.db = () => w.db;
  return w;
}

const flush = (w: FilesWorld) => w.ns.fireAlarm(`${SLUG}:${w.subject}`);
const row = (w: FilesWorld, subject = w.subject) =>
  w.db.first<Record<string, number>>(
    "SELECT * FROM sync_directory WHERE product = ? AND subject = ?",
    SLUG,
    subject,
  );

describe("the directory row", () => {
  it("carries files, file_bytes and revision_bytes beside the total that holds them", async () => {
    const w = await flushing();
    await stored(w, "saves", "a", bytesOf(1000, 1), { baseVersion: "*" });
    await stored(w, "saves", "a", bytesOf(3000, 2));
    await stored(w, "saves", "b", bytesOf(500, 3), { baseVersion: "*" });
    await flush(w);
    expect(await row(w)).toMatchObject({
      files: 2,
      file_bytes: 3500,
      revision_bytes: 1000,
    });
    const r = (await row(w))!;
    expect(r.bytes).toBeGreaterThanOrEqual(4500);
    expect(r.bytes).toBeLessThan(4500 + 200);
  });

  it("a record delete gives the bytes back in the next flush", async () => {
    const w = await flushing();
    await stored(w, "saves", "a", bytesOf(1000), { baseVersion: "*" });
    await flush(w);
    await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["saves", "a"] },
        op: "delete",
        editedHlc: hlc,
      },
    ]);
    await flush(w);
    expect(await row(w)).toMatchObject({
      files: 0,
      file_bytes: 0,
      revision_bytes: 0,
      bytes: 0,
    });
  });

  it("a person with no files writes zeros", async () => {
    const w = await flushing();
    await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["big", "x"] },
        op: "set",
        value: 1,
        editedHlc: hlc,
      },
    ]);
    await flush(w);
    expect(await row(w)).toMatchObject({
      files: 0,
      file_bytes: 0,
      revision_bytes: 0,
    });
  });

  it("size is the total, with revisions counted once", async () => {
    const w = await flushing();
    await stored(w, "saves", "a", bytesOf(1000, 1), { baseVersion: "*" });
    await stored(w, "saves", "a", bytesOf(2000, 2));
    await flush(w);
    const r = (await row(w))!;
    const size = await cloudSyncStore.size!(
      { db: w.db, env: w.env, now: NOW } as never,
      { product: SLUG, subject: w.subject },
    );
    expect(size).toBe(r.bytes);
  });
});

describe("the product aggregate", () => {
  const dirRow = (
    subject: string,
    fileBytes: number,
    revisionBytes: number,
    recordBytes: number,
    bytes: number,
  ) => [SLUG, subject, bytes, fileBytes, revisionBytes, recordBytes] as const;

  it("splits settings, records, files and revisions; settings are the remainder", async () => {
    const w = await filesWorld();
    for (const r of [
      dirRow("s1", 300, 100, 50, 600),
      dirRow("s2", 20, 0, 0, 40),
    ])
      await w.db.run(
        `INSERT INTO sync_directory (product, subject, bytes, file_bytes, revision_bytes, record_bytes,
           quota_bytes, last_active_at) VALUES (?, ?, ?, ?, ?, ?, 1000, ?)`,
        ...r,
        NOW,
      );
    await syncScheduled({
      db: w.db,
      now: NOW,
      product: { slug: SLUG },
    } as unknown as ScheduledServiceContext);
    const u = (await w.db.first<Record<string, unknown>>(
      "SELECT * FROM sync_product_usage WHERE product = ?",
      SLUG,
    ))!;
    expect(u).toMatchObject({
      bytes: 640,
      file_bytes: 320,
      revision_bytes: 100,
      record_bytes: 50,
    });
    expect(JSON.parse(u.breakdown_json as string).byKind).toEqual({
      settings: 170,
      records: 50,
      files: 320,
      revisions: 100,
    });
  });
});

describe("a merge adds the file bytes", () => {
  it("the survivor's row is the sum", async () => {
    const w = await filesWorld();
    for (const [subject, files, fileBytes] of [
      ["from", 1, 100],
      ["to", 2, 250],
    ] as const)
      await w.db.run(
        `INSERT INTO sync_directory (product, subject, bytes, files, file_bytes, quota_bytes, last_active_at)
         VALUES (?, ?, ?, ?, ?, 1000, ?)`,
        SLUG,
        subject,
        fileBytes,
        files,
        fileBytes,
        NOW,
      );
    // The objects are empty here; the directory rows are what this checks.
    await cloudSyncStore.merge!({ db: w.db, env: w.env, now: NOW } as never, {
      product: SLUG,
      from: "from",
      to: "to",
    });
    expect(await row(w, "to")).toMatchObject({ files: 3, file_bytes: 350 });
    expect(await row(w, "from")).toBeNull();
  });
});
