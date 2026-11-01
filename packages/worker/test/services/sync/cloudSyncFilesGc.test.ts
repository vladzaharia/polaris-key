/**
 * U-10.10: the alarm's collection of files, the R2 sweep of an erasure, absorb and export of files,
 * and SSE-C (WIRE-CONTRACT-V5 §13.8.2, plans/U-10-U-11a-slices.md §2.6, D-8). Each rule has a test
 * that fails without it: GC never deletes a live file, an erasure leaves nothing in R2, a merge
 * keeps every file openable.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BeginFileResponse } from "@polaris-key/protocol/sync";
import { NOW } from "../../seed.js";
import { installDigestStream } from "../../r2Mock.js";
import {
  absorbCloudSync,
  deleteCloudSync,
  deleteCloudSyncIfUnchanged,
  exportCloudSync,
} from "../../../src/services/sync/do/client.js";
import { hlc, nextId } from "./cloudSyncAbuseWorld.js";
import {
  SLUG,
  becomeBob,
  begin,
  beginBody,
  bytesOf,
  call,
  filesPath,
  filesWorld,
  finalize,
  push,
  putBytes,
  rows,
  stored,
  uploadPath,
  usageOf,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";

beforeAll(() => installDigestStream());
afterEach(() => vi.useRealTimers());

const DAY = 86_400_000;
const name = (w: FilesWorld) => `${SLUG}:${w.subject}`;
const alarm = (w: FilesWorld) => w.ns.fireAlarm(name(w));
const pin = (w: FilesWorld) => ({ product: SLUG, subject: w.subject });
/** Sets the fake clock (installed once: the objects captured `Date.now` of the first install). */
const clock = (ms: number) => {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ms);
};
const del = (w: FilesWorld, collection: string, id: string) =>
  push(w, [
    {
      mutationId: nextId(),
      target: { record: [collection, id] },
      op: "delete",
      editedHlc: hlc,
    },
  ]);

describe("SSE-C (D-8)", () => {
  it("a server-mode file is stored under the person's key, shared by their files; the key is in ssec_keys", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "a", bytesOf(100));
    await stored(w, "saves", "b", bytesOf(200));
    const keys = rows(w, "SELECT kid FROM ssec_keys");
    expect(keys).toHaveLength(1);
    const kids = rows(w, "SELECT DISTINCT ssec_kid AS k FROM files");
    expect(kids).toEqual([{ k: keys[0]!.kid }]);
    for (const k of w.r2.keys()) expect(w.r2.ssecOf(k)).toBeDefined();
  });

  it("a download opens the object with its key, and an object read without it is refused by R2", async () => {
    const w = await filesWorld();
    const bytes = bytesOf(300);
    await stored(w, "saves", "a", bytes);
    const res = await call(w, "GET", `/${SLUG}/sync/files/saves/a`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    await expect(w.r2.get(w.r2.keys()[0]!)).rejects.toThrow();
  });

  it("a multipart upload is sealed too, part by part", async () => {
    const w = await filesWorld();
    const big = bytesOf(20 * 1024 * 1024);
    const up = (await (
      await begin(w, "big", "m", beginBody(big))
    ).json()) as BeginFileResponse;
    const part = 8 * 1024 * 1024;
    const { putBytes, finalize } = await import("./cloudSyncFilesWorld.js");
    for (let n = 1; n <= 3; n++)
      expect(
        (
          await putBytes(
            w,
            `${uploadPath("big", "m", up.uploadId)}/parts/${n}`,
            big.subarray((n - 1) * part, Math.min(n * part, big.length)),
          )
        ).status,
      ).toBe(204);
    expect((await finalize(w, "big", "m", up.uploadId)).status).toBe(200);
    expect(w.r2.ssecOf(w.r2.keys()[0]!)).toBeDefined();
    const res = await call(w, "GET", `/${SLUG}/sync/files/big/m`);
    expect((await res.arrayBuffer()).byteLength).toBe(big.length);
  });
});

describe("the alarm collects files", () => {
  it("an expired unfinished upload: object, multipart and reservation go; a finished one's object stays", async () => {
    clock(NOW * 1000);
    const w = await filesWorld();
    const done = await stored(w, "saves", "kept", bytesOf(50));
    const open = (await (
      await begin(w, "big", "m", beginBody(20 * 1024 * 1024))
    ).json()) as BeginFileResponse;
    expect(w.r2.openUploads()).toBe(1);
    clock(NOW * 1000 + DAY + 1000);
    await alarm(w);
    expect(w.r2.openUploads()).toBe(0);
    expect(usageOf(w).reserved_bytes ?? 0).toBe(0);
    expect(
      rows(
        w,
        "SELECT upload_id FROM uploads WHERE upload_id=?".replace(
          "?",
          `'${open.uploadId}'`,
        ),
      ),
    ).toEqual([]);
    // The finished file is intact, readable and still the live one.
    expect(w.r2.keys()).toHaveLength(1);
    expect(
      (await call(w, "GET", `/${SLUG}/sync/files/saves/kept`)).status,
    ).toBe(200);
    expect(rows(w, "SELECT version, status FROM files")).toEqual([
      { version: done.version, status: "live" },
    ]);
  });

  it("an alarm is set for the earliest upload expiry", async () => {
    clock(NOW * 1000);
    const w = await filesWorld();
    await begin(w, "saves", "a", beginBody(10));
    const inst = w.ns.instances.get(name(w))!;
    expect(inst.storage.alarm).not.toBeNull();
  });

  it("a deleted record's file and revisions: objects and rows go at the alarm, a live file of another record stays", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "gone", bytesOf(10, 1), { baseVersion: "*" });
    await stored(w, "saves", "gone", bytesOf(20, 2));
    await stored(w, "saves", "keep", bytesOf(30, 3), { baseVersion: "*" });
    expect(w.r2.keys()).toHaveLength(3);
    await del(w, "saves", "gone");
    expect(w.r2.keys()).toHaveLength(3); // waiting for the alarm
    await alarm(w);
    const left = rows(w, "SELECT record_id, status FROM files");
    expect(left).toEqual([{ record_id: "keep", status: "live" }]);
    expect(w.r2.keys()).toEqual([
      (rows(w, "SELECT object_key AS k FROM files")[0] as { k: string }).k,
    ]);
    expect(
      (await call(w, "GET", `/${SLUG}/sync/files/saves/keep`)).status,
    ).toBe(200);
  });

  it("keepRevisions: the revisions pruned at finalize leave R2 at the alarm; the kept ones and the live file stay", async () => {
    const w = await filesWorld();
    // "big" keeps 2 older versions.
    const v: number[] = [];
    for (let i = 1; i <= 5; i++)
      v.push(
        (
          await stored(
            w,
            "big",
            "r",
            bytesOf(10 + i, i),
            i === 1 ? { baseVersion: "*" } : {},
          )
        ).version,
      );
    await alarm(w);
    expect(
      rows(w, "SELECT version, status FROM files ORDER BY version"),
    ).toEqual([
      { version: v[2], status: "revision" },
      { version: v[3], status: "revision" },
      { version: v[4], status: "live" },
    ]);
    expect(w.r2.keys()).toHaveLength(3);
  });

  it("never deletes a live file or revision, however often it runs", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "a", bytesOf(10, 1), { baseVersion: "*" });
    await stored(w, "saves", "a", bytesOf(11, 2));
    for (let i = 0; i < 3; i++) await alarm(w);
    expect(w.r2.keys()).toHaveLength(2);
    expect(rows(w, "SELECT status FROM files ORDER BY version")).toEqual([
      { status: "revision" },
      { status: "live" },
    ]);
  });

  it("an object another non-dead row still names is not deleted", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "a", bytesOf(10), { baseVersion: "*" });
    const key = w.r2.keys()[0]!;
    // A dead row sharing a key with a live one (as an absorb could produce).
    const inst = w.ns.instances.get(name(w))!;
    inst.storage.sql.db
      .prepare(
        `INSERT INTO files SELECT collection, 'twin', version + 1000, object_key, format, enc, size, sha256, 'dead', ssec_kid, created_at, client_id FROM files`,
      )
      .run();
    await alarm(w);
    expect(w.r2.keys()).toEqual([key]);
    expect(rows(w, "SELECT status FROM files")).toEqual([{ status: "live" }]);
  });

  it("an R2 failure keeps the row and the object, and the alarm tries again", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "a", bytesOf(10), { baseVersion: "*" });
    await del(w, "saves", "a");
    const realDelete = w.r2.delete.bind(w.r2);
    w.r2.delete = () => Promise.reject(new Error("r2 down"));
    await alarm(w);
    expect(rows(w, "SELECT status FROM files")).toEqual([{ status: "dead" }]);
    expect(w.r2.keys()).toHaveLength(1);
    expect(w.ns.instances.get(name(w))!.storage.alarm).not.toBeNull();
    w.r2.delete = realDelete;
    await alarm(w);
    expect(rows(w, "SELECT 1 FROM files")).toEqual([]);
    expect(w.r2.keys()).toEqual([]);
  });
});

describe("an erasure leaves nothing in R2", () => {
  it("deleteAll removes the files, the revisions, open uploads and strays under the prefix, and the SSE-C keys", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "a", bytesOf(10, 1), { baseVersion: "*" });
    await stored(w, "saves", "a", bytesOf(11, 2));
    await begin(w, "big", "m", beginBody(20 * 1024 * 1024));
    await w.r2.put(`u/${SLUG}/${w.subject}/o/stray`, new Uint8Array(3));
    // Another person's object is not this person's to delete.
    await w.r2.put(`u/${SLUG}/ps_someoneelse/o/theirs`, new Uint8Array(3));
    expect(w.r2.keys().length).toBeGreaterThanOrEqual(4);
    await deleteCloudSync(w.env, pin(w));
    expect(w.r2.keys()).toEqual([`u/${SLUG}/ps_someoneelse/o/theirs`]);
    expect(w.r2.openUploads()).toBe(0);
  });

  it("a single PUT that lands after the person's erasure leaves no object", async () => {
    const w = await filesWorld();
    const bytes = bytesOf(300, 5);
    const res = await begin(w, "saves", "a", beginBody(bytes));
    const up = (await res.json()) as BeginFileResponse;
    const real = w.r2.put.bind(w.r2);
    w.r2.put = async (...args: Parameters<typeof real>) => {
      w.r2.put = real;
      await deleteCloudSync(w.env, pin(w));
      return real(...args);
    };
    const late = await putBytes(
      w,
      uploadPath("saves", "a", up.uploadId),
      bytes,
    );
    expect(late.status).toBe(404);
    expect(w.r2.keys()).toEqual([]);
  });

  it("if R2 fails the erasure is refused and the rows (and keys) are kept for a retry", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "a", bytesOf(10), { baseVersion: "*" });
    const realList = w.r2.list.bind(w.r2);
    w.r2.list = () => Promise.reject(new Error("r2 down"));
    await expect(deleteCloudSync(w.env, pin(w))).rejects.toThrow();
    expect(rows(w, "SELECT 1 FROM files")).toHaveLength(1);
    w.r2.list = realList;
    await deleteCloudSync(w.env, pin(w));
    expect(w.r2.keys()).toEqual([]);
  });

  it("a person who never used files costs R2 nothing", async () => {
    const w = await filesWorld();
    await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["big", "x"] },
        op: "set",
        value: 1,
        editedHlc: hlc,
      },
    ]);
    const spy = vi.spyOn(w.r2, "list");
    await deleteCloudSync(w.env, pin(w));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("export and absorb carry files", () => {
  /** Alice has files; Bob (the same device, re-pointed) is the survivor. */
  async function pair() {
    const w = await filesWorld();
    await stored(w, "saves", "a", bytesOf(40, 1), { baseVersion: "*" });
    await stored(w, "saves", "a", bytesOf(41, 2));
    const alice = pin(w);
    await becomeBob(w);
    // Bob's object exists once he writes.
    await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["big", "bobs"] },
        op: "set",
        value: 1,
        editedHlc: hlc,
      },
    ]);
    const bobSubject = [...w.ns.instances.keys()]
      .map((k) => k.split(":")[1]!)
      .find((s) => s !== alice.subject) as string;
    return { w, alice, bob: { product: SLUG, subject: bobSubject } };
  }

  it("a person's own export lists pointers only; a merge export adds keys, SSE-C keys and nothing dead", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "a", bytesOf(40), { baseVersion: "*" });
    const own = await exportCloudSync(w.env, pin(w));
    expect(own?.files).toEqual([
      expect.objectContaining({ recordId: "a", status: "live", size: 40 }),
    ]);
    expect(JSON.stringify(own?.files)).not.toMatch(
      /u\/djdl|objectKey|ssec|clientId/,
    );
    const merge = await exportCloudSync(w.env, pin(w), { forMerge: true });
    expect(merge?.files?.[0]).toHaveProperty("objectKey");
    expect(merge?.ssecKeys).toHaveLength(1);
    await del(w, "saves", "a");
    expect(
      (await exportCloudSync(w.env, pin(w), { forMerge: true }))?.files,
    ).toBeUndefined();
  });

  it("the survivor takes the files with their keys, serves them, and absorbing again changes nothing", async () => {
    const { w, alice, bob } = await pair();
    const doc = (await exportCloudSync(w.env, alice, { forMerge: true }))!;
    expect((await absorbCloudSync(w.env, bob, doc)).changed).toBeGreaterThan(0);
    const files = w.ns.instances
      .get(`${SLUG}:${bob.subject}`)!
      .storage.sql.db.prepare(
        "SELECT status, object_key FROM files ORDER BY version",
      )
      .all() as { status: string; object_key: string }[];
    expect(files.map((f) => f.status)).toEqual(["revision", "live"]);
    for (const f of files) expect(f.object_key).toContain(alice.subject);
    // Bob opens Alice's merged file (the SSE-C key came with it).
    const res = await call(w, "GET", `/${SLUG}/sync/files/saves/a`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytesOf(41, 2));
    expect((await absorbCloudSync(w.env, bob, doc)).changed).toBe(0);
    expect(
      w.ns.instances
        .get(`${SLUG}:${bob.subject}`)!
        .storage.sql.db.prepare("SELECT COUNT(*) AS n FROM files")
        .get(),
    ).toEqual({ n: 2 });
  });

  it("a single PUT that lands after an account merge keeps the file the survivor holds", async () => {
    const w = await filesWorld();
    const bytes = bytesOf(300, 3);
    const res = await begin(w, "saves", "a", beginBody(bytes));
    const up = (await res.json()) as BeginFileResponse;
    const path = uploadPath("saves", "a", up.uploadId);
    expect((await putBytes(w, path, bytes)).status).toBe(204);
    const alice = pin(w);
    const aliceKey = `u/${SLUG}/${alice.subject}/o/${up.uploadId}`;
    // The second PUT is on its way when the file is finalized and the person's account is merged.
    const real = w.r2.put.bind(w.r2);
    w.r2.put = async (...args: Parameters<typeof real>) => {
      w.r2.put = real;
      expect((await finalize(w, "saves", "a", up.uploadId)).status).toBe(200);
      await becomeBob(w);
      await push(w, [
        {
          mutationId: nextId(),
          target: { record: ["big", "bobs"] },
          op: "set",
          value: 1,
          editedHlc: hlc,
        },
      ]);
      const bobSubject = [...w.ns.instances.keys()]
        .map((k) => k.split(":")[1]!)
        .find((x) => x !== alice.subject) as string;
      const bob = { product: SLUG, subject: bobSubject };
      const doc = (await exportCloudSync(w.env, alice, { forMerge: true }))!;
      await absorbCloudSync(w.env, bob, doc);
      await deleteCloudSyncIfUnchanged(
        w.env,
        alice,
        { seq: doc.seq, writes: doc.writes },
        bob.subject,
      );
      await w.db.run(
        "DELETE FROM account_product_subjects WHERE product = ? AND subject = ?",
        SLUG,
        alice.subject,
      );
      await w.db.run(
        "INSERT INTO account_product_subject_aliases (product, alias, subject, merged_at) VALUES (?, ?, ?, ?)",
        SLUG,
        alice.subject,
        bobSubject,
        NOW,
      );
      return real(...args);
    };
    const late = await putBytes(w, path, bytes);
    expect(late.status).toBe(404);
    expect(w.r2.keys()).toContain(aliceKey);
    const got = await call(w, "GET", `/${SLUG}/sync/files/saves/a`);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it("deleting the merged-away object keeps the files in R2; erasing the survivor then sweeps the absorbed prefix", async () => {
    const { w, alice, bob } = await pair();
    const doc = (await exportCloudSync(w.env, alice, { forMerge: true }))!;
    await absorbCloudSync(w.env, bob, doc);
    expect(
      await deleteCloudSyncIfUnchanged(
        w.env,
        alice,
        { seq: doc.seq, writes: doc.writes },
        bob.subject,
      ),
    ).toBe(true);
    expect(w.r2.keys()).toHaveLength(2);
    // A stray under the absorbed subject's prefix goes with the survivor's erasure.
    await w.r2.put(`u/${SLUG}/${alice.subject}/o/stray`, new Uint8Array(1));
    await deleteCloudSync(w.env, bob);
    expect(w.r2.keys()).toEqual([]);
  });

  it("the merged-away object's open uploads and dead files are cleared from R2 at its delete", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "a", bytesOf(40), { baseVersion: "*" });
    await stored(w, "saves", "dead", bytesOf(9), { baseVersion: "*" });
    await del(w, "saves", "dead");
    await begin(w, "big", "m", beginBody(20 * 1024 * 1024));
    const alice = pin(w);
    await becomeBob(w);
    await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["big", "b"] },
        op: "set",
        value: 1,
        editedHlc: hlc,
      },
    ]);
    const bob = {
      product: SLUG,
      subject: [...w.ns.instances.keys()]
        .map((k) => k.split(":")[1]!)
        .find((s) => s !== alice.subject)!,
    };
    const doc = (await exportCloudSync(w.env, alice, { forMerge: true }))!;
    await absorbCloudSync(w.env, bob, doc);
    await deleteCloudSyncIfUnchanged(
      w.env,
      alice,
      { seq: doc.seq, writes: doc.writes },
      bob.subject,
    );
    expect(w.r2.openUploads()).toBe(0);
    expect(w.r2.keys()).toHaveLength(1); // only the live file moved to Bob
  });

  it("a malformed file in an export is refused whole, before any write", async () => {
    const { w, alice, bob } = await pair();
    const doc = (await exportCloudSync(w.env, alice, { forMerge: true }))!;
    const bad = [
      {
        ...doc,
        files: [
          {
            ...doc.files![0]!,
            objectKey: "u/other/ps_x/o/up_AAAAAAAAAAAAAAAAAAAAAA",
          },
        ],
      },
      { ...doc, files: [{ ...doc.files![0]!, objectKey: "../../etc" }] },
      { ...doc, files: [{ ...doc.files![0]!, status: "dead" }] },
      { ...doc, ssecKeys: [] },
      { ...doc, files: [{ ...doc.files![0]!, sha256: "zz" }] },
    ];
    for (const d of bad)
      await expect(absorbCloudSync(w.env, bob, d as never)).rejects.toThrow();
    expect(
      w.ns.instances
        .get(`${SLUG}:${bob.subject}`)!
        .storage.sql.db.prepare("SELECT COUNT(*) AS n FROM files")
        .get(),
    ).toEqual({ n: 0 });
  });
});

void filesPath;

describe("an object whose product is gone", () => {
  it("an object that finds its product deleted removes its stored files before its rows, and keeps the rows while R2 fails", async () => {
    clock(NOW * 1000);
    const w = await filesWorld();
    // The directory flush finds the product gone (its last statement changes no row).
    (w.ns as unknown as { opts: { db?: unknown } }).opts.db = () => ({
      batch: async () => undefined,
      batchChanges: async (s: unknown[]) =>
        s.map((_, i) => (i === s.length - 1 ? 0 : 1)),
    });
    await stored(w, "saves", "a", bytesOf(10));
    expect(w.r2.keys()).toHaveLength(1);
    clock(NOW * 1000 + 16 * 60_000);
    const realDelete = w.r2.delete.bind(w.r2);
    w.r2.delete = () => Promise.reject(new Error("r2 down"));
    await alarm(w);
    // R2 failed: the rows (and the retry alarm) stay, and the bytes are still there.
    const inst = w.ns.instances.get(name(w))!;
    expect(rows(w, "SELECT 1 FROM files")).toHaveLength(1);
    expect(w.r2.keys()).toHaveLength(1);
    expect(inst.storage.alarm).not.toBeNull();
    // R2 recovers: the files go first, then the object's own storage.
    w.r2.delete = realDelete;
    clock(NOW * 1000 + 18 * 60_000);
    await alarm(w);
    expect(w.r2.keys()).toEqual([]);
    expect(inst.storage.alarm).toBeNull();
    expect(
      inst.storage.sql.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all(),
    ).toEqual([]);
  });
});
