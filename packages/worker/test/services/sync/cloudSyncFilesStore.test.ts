// U-10.4: the file methods of `SyncStore` (plans/U-10-U-11a-slices.md §2.1), proved on both
// stores: the reference `MemoryStore` and the Durable Object's `SqlStore`. Plus the v3 to v4
// migration and the StoreUsage file members. No route and no behaviour change: nothing writes a
// file yet.
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../../src/services/sync/engine/memoryStore.js";
import type {
  StoredFile,
  SyncStore,
  UploadRow,
} from "../../../src/services/sync/engine/types.js";
import {
  compactUsage,
  fileUsage,
} from "../../../src/services/sync/engine/usage.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  SqlStore,
} from "../../../src/services/sync/do/sqlStore.js";
import { SqlTestStore } from "../../cloudSyncSqlTestStore.js";
import { DoStorageMock, rowCounts } from "../../cloudSyncDoMock.js";

const SHA = "ab".repeat(32);

const file = (
  recordId: string,
  version: number,
  status: StoredFile["status"] = "live",
  extra: Partial<StoredFile> = {},
): StoredFile => ({
  collection: "saves",
  recordId,
  version,
  objectKey: `u/p/s/o/up_${version}`,
  format: "whole",
  enc: "none",
  size: 100 + version,
  sha256: SHA,
  status,
  createdAt: 1_000 + version,
  clientId: "c_aaaaaaaaaaaaaaaaaaaaaa",
  ...extra,
});

const upload = (id: string, extra: Partial<UploadRow> = {}): UploadRow => ({
  uploadId: id,
  collection: "saves",
  recordId: "slot-1",
  baseVersion: null,
  mode: "single",
  format: "whole",
  enc: "none",
  size: 10,
  sha256: SHA,
  partBytes: null,
  multipartId: null,
  reservedBytes: 10,
  deviceId: "d_1",
  createdAt: 1_000,
  expiresAt: 5_000,
  state: "open",
  resultJson: null,
  ...extra,
});

const makers: Record<string, () => SyncStore> = {
  memory: () => new MemoryStore(),
  sql: () => new SqlTestStore(),
};

describe.each(Object.entries(makers))(
  "file methods: %s store",
  (_name, make) => {
    it("round-trips a file row, its status and its SSE-C key id", () => {
      const s = make();
      expect(s.getFile("saves", "slot-1", 7)).toBeUndefined();
      expect(s.liveFile("saves", "slot-1")).toBeUndefined();
      s.putFile(file("slot-1", 7, "live", { ssecKid: "cd".repeat(16) }));
      s.putFile(file("slot-1", 5, "revision"));
      s.putFile(file("slot-2", 9));
      expect(s.getFile("saves", "slot-1", 7)).toEqual(
        file("slot-1", 7, "live", { ssecKid: "cd".repeat(16) }),
      );
      expect(s.liveFile("saves", "slot-1")?.version).toBe(7);
      expect(s.filesOf("saves", "slot-1").map((f) => f.version)).toEqual([
        5, 7,
      ]);
      expect(s.allFiles().map((f) => [f.recordId, f.version])).toEqual([
        ["slot-1", 5],
        ["slot-1", 7],
        ["slot-2", 9],
      ]);
      // A put on the same version replaces the row: the live file becomes a revision.
      s.putFile(file("slot-1", 7, "revision"));
      expect(s.liveFile("saves", "slot-1")).toBeUndefined();
      s.deleteFile("saves", "slot-1", 5);
      expect(s.filesOf("saves", "slot-1").map((f) => f.version)).toEqual([7]);
    });

    it("orders versions numerically, not as text", () => {
      const s = make();
      for (const v of [10, 9, 100, 2]) s.putFile(file("r", v, "revision"));
      expect(s.filesOf("saves", "r").map((f) => f.version)).toEqual([
        2, 9, 10, 100,
      ]);
    });

    it("keeps upload sessions: base version forms, open count, expiry and parts", () => {
      const s = make();
      s.putUpload(upload("up_a", { baseVersion: 4 }));
      s.putUpload(upload("up_b", { baseVersion: "*", expiresAt: 3_000 }));
      s.putUpload(
        upload("up_c", {
          mode: "multipart",
          partBytes: 8_388_608,
          multipartId: "mp",
        }),
      );
      s.putUpload(upload("up_d", { state: "done", resultJson: "{}" }));
      expect(s.getUpload("up_a")?.baseVersion).toBe(4);
      expect(s.getUpload("up_b")?.baseVersion).toBe("*");
      expect(s.getUpload("up_c")?.baseVersion).toBeNull();
      expect(s.getUpload("up_c")).toMatchObject({
        mode: "multipart",
        partBytes: 8_388_608,
        multipartId: "mp",
      });
      expect(s.getUpload("nope")).toBeUndefined();
      // Open: not done, not expired.
      expect(s.openUploads(2_000).map((u) => u.uploadId)).toEqual([
        "up_a",
        "up_b",
        "up_c",
      ]);
      expect(s.openUploads(3_000).map((u) => u.uploadId)).toEqual([
        "up_a",
        "up_c",
      ]);
      // Expired: any state, oldest expiry first, bounded.
      expect(s.expiredUploads(5_000, 10).map((u) => u.uploadId)).toEqual([
        "up_b",
        "up_a",
        "up_c",
        "up_d",
      ]);
      expect(s.expiredUploads(5_000, 2)).toHaveLength(2);
      expect(s.expiredUploads(2_999, 10)).toEqual([]);

      s.putPart({ uploadId: "up_c", n: 2, etag: "e2", bytes: 20 });
      s.putPart({ uploadId: "up_c", n: 1, etag: "e1", bytes: 10 });
      s.putPart({ uploadId: "up_c", n: 2, etag: "e2b", bytes: 21 });
      s.putPart({ uploadId: "up_a", n: 1, etag: "x", bytes: 1 });
      expect(s.getParts("up_c")).toEqual([
        { uploadId: "up_c", n: 1, etag: "e1", bytes: 10 },
        { uploadId: "up_c", n: 2, etag: "e2b", bytes: 21 },
      ]);
      // Deleting a session takes its parts and no one else's.
      s.deleteUpload("up_c");
      expect(s.getUpload("up_c")).toBeUndefined();
      expect(s.getParts("up_c")).toEqual([]);
      expect(s.getParts("up_a")).toHaveLength(1);
    });

    it("keeps SSE-C keys as bytes", () => {
      const s = make();
      const key = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
      expect(s.getSsecKey("k1")).toBeUndefined();
      s.putSsecKey("k1", key);
      s.putSsecKey("k0", key.slice().reverse());
      expect([...(s.getSsecKey("k1") as Uint8Array)]).toEqual([...key]);
      expect(s.allSsecKeys().map(([kid]) => kid)).toEqual(["k0", "k1"]);
      s.deleteSsecKey("k1");
      expect(s.getSsecKey("k1")).toBeUndefined();
    });

    it("reads the file members of the usage as absent while zero", () => {
      const s = make();
      const base = {
        settings: 1,
        settingsBytes: 2,
        records: 3,
        recordBytes: 4,
        bytes: 6,
      };
      s.setUsage({ ...base, files: 0, fileBytes: 0 });
      expect(s.getUsage()).toEqual(base);
      expect(fileUsage(s.getUsage())).toEqual({
        files: 0,
        fileBytes: 0,
        revisionBytes: 0,
        reservedBytes: 0,
      });
      s.setUsage({
        ...base,
        files: 2,
        fileBytes: 300,
        revisionBytes: 50,
        reservedBytes: 70,
      });
      expect(s.getUsage()).toEqual({
        ...base,
        files: 2,
        fileBytes: 300,
        revisionBytes: 50,
        reservedBytes: 70,
      });
      // Back to zero: the members go again.
      s.setUsage(base);
      expect(s.getUsage()).toEqual(base);
      expect(compactUsage({ ...base, reservedBytes: 0 })).toEqual(base);
    });

    it("rolls a failed transaction's file writes back", () => {
      const s = make();
      s.putFile(file("a", 1));
      s.putUpload(upload("up_a"));
      s.putSsecKey("k", new Uint8Array([1, 2, 3]));
      expect(() =>
        s.transaction(() => {
          s.putFile(file("a", 2));
          s.deleteFile("saves", "a", 1);
          s.putUpload(upload("up_b"));
          s.putPart({ uploadId: "up_a", n: 1, etag: "e", bytes: 1 });
          s.deleteSsecKey("k");
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(s.filesOf("saves", "a").map((f) => f.version)).toEqual([1]);
      expect(s.getUpload("up_b")).toBeUndefined();
      expect(s.getParts("up_a")).toEqual([]);
      expect(s.getSsecKey("k")).toEqual(new Uint8Array([1, 2, 3]));
    });
  },
);

describe("SqlStore: schema v4", () => {
  it("migrates a v3 object: rows kept, file tables made, no data written", () => {
    const storage = new DoStorageMock();
    for (const step of MIGRATIONS.slice(0, 3))
      for (const stmt of step) storage.sql.exec(stmt);
    storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('schema_version', '3')`,
    );
    storage.sql.exec(
      `INSERT INTO records (collection, id, version, hlc, client_id, value_json, kind, deleted)
       VALUES ('saves', 's', 1, '0190f3a2c1b4:0001', 'c_aaaaaaaaaaaaaaaaaaaaaa', '5', 'value', 0)`,
    );
    const store = new SqlStore(
      storage as unknown as ConstructorParameters<typeof SqlStore>[0],
    );
    expect(store.schemaVersion()).toBe(3);
    store.prepare(false);
    expect(store.schemaVersion()).toBe(4);
    expect(SCHEMA_VERSION).toBe(4);
    expect(store.getRecord("saves", "s")?.value).toBe(5);
    expect(
      rowCounts(storage, ["files", "uploads", "upload_parts", "ssec_keys"]),
    ).toEqual([0, 0, 0, 0]);
    expect(store.allFiles()).toEqual([]);
    expect(store.getUsage()).toEqual({
      settings: 0,
      settingsBytes: 0,
      records: 0,
      recordBytes: 0,
      bytes: 0,
    });
  });

  it("answers an object that was never written as holding no file, and creates nothing", () => {
    const storage = new DoStorageMock();
    const store = new SqlStore(
      storage as unknown as ConstructorParameters<typeof SqlStore>[0],
    );
    expect(store.allFiles()).toEqual([]);
    expect(store.getFile("c", "r", 1)).toBeUndefined();
    expect(store.liveFile("c", "r")).toBeUndefined();
    expect(store.getUpload("up")).toBeUndefined();
    expect(store.openUploads(0)).toEqual([]);
    expect(store.getParts("up")).toEqual([]);
    expect(store.getSsecKey("k")).toBeUndefined();
    expect(store.schemaVersion()).toBe(0);
  });

  it("refuses a write before the schema is made", () => {
    const storage = new DoStorageMock();
    const store = new SqlStore(
      storage as unknown as ConstructorParameters<typeof SqlStore>[0],
    );
    expect(() => store.putFile(file("a", 1))).toThrow(/prepare/);
    expect(() => store.putUpload(upload("up"))).toThrow(/prepare/);
  });
});
