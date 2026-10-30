/**
 * U-10.7: `POST …/finalize` (WIRE-CONTRACT-V5 §13.8.1, GF2 and GF3): the streamed SHA-256, the
 * compare-and-swap re-check, charge then release, the revision, and idempotence. Each rule here has
 * a test that fails without it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  BeginFileResponse,
  FinalizeResponse,
  PushResponse,
  SyncJson,
} from "@polaris-key/protocol/sync";
import { NOW } from "../../seed.js";
import { installDigestStream } from "../../r2Mock.js";
import { callCloudSync } from "../../../src/services/sync/do/client.js";
import { fileObjectKey } from "../../../src/services/sync/engine/files.js";
import { hlc, nextId } from "./cloudSyncAbuseWorld.js";
import {
  SLUG,
  begin,
  beginBody,
  bytesOf,
  call,
  errorCode,
  filesWorld,
  finalize,
  push,
  putBytes,
  rows,
  setQuota,
  sha256Hex,
  uploadPath,
  usageOf,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";

beforeAll(() => installDigestStream());
afterEach(() => vi.useRealTimers());

const MIB = 1024 * 1024;
const PART = 8 * MIB;

/** A world on a pinned clock with one open single upload of `n` bytes for saves/s1. */
async function pinnedSingle(n: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  const w = await filesWorld();
  return { w, up: await uploaded(w, "saves", "s1", bytesOf(n)) };
}

/** Nothing was committed, charged, reserved or left in R2 for an upload that ended. */
function expectNothingKept(w: FilesWorld) {
  expect(rows(w, "SELECT 1 FROM files")).toEqual([]);
  expect(w.r2.keys()).toEqual([]);
  expect(usageOf(w).reserved_bytes ?? 0).toBe(0);
  expect(usageOf(w).files ?? 0).toBe(0);
}

const keyOf = (w: FilesWorld, uploadId: string) =>
  fileObjectKey({ product: SLUG, subject: w.subject }, uploadId);

/** A begun upload with its bytes sent, ready to finalize (single mode). */
async function uploaded(
  w: FilesWorld,
  collection: string,
  id: string,
  bytes: Uint8Array,
  over: object = {},
): Promise<BeginFileResponse> {
  const res = await begin(w, collection, id, beginBody(bytes, over));
  expect(res.status).toBe(200);
  const up = (await res.json()) as BeginFileResponse;
  expect(
    (await putBytes(w, uploadPath(collection, id, up.uploadId), bytes)).status,
  ).toBe(204);
  return up;
}

/** A begun multipart upload, `parts` of it sent (1-based numbers). */
async function uploadedParts(
  w: FilesWorld,
  collection: string,
  id: string,
  file: Uint8Array,
  parts: number[],
  declared: Uint8Array | number = file,
): Promise<BeginFileResponse> {
  const res = await begin(w, collection, id, beginBody(declared));
  expect(res.status).toBe(200);
  const up = (await res.json()) as BeginFileResponse;
  for (const n of parts)
    expect(
      (
        await putBytes(
          w,
          `${uploadPath(collection, id, up.uploadId)}/parts/${n}`,
          file.subarray((n - 1) * PART, Math.min(n * PART, file.length)),
        )
      ).status,
    ).toBe(204);
  return up;
}

const finalized = async (res: Response): Promise<FinalizeResponse> => {
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as FinalizeResponse;
};

/** A record written through the push (a value in `big`, which has no schema). */
async function putRecord(
  w: FilesWorld,
  collection: string,
  id: string,
  value: SyncJson,
  baseVersion?: number | "*",
): Promise<{ status: string; version?: number }> {
  const res = await push(w, [
    {
      mutationId: nextId(),
      target: { record: [collection, id] },
      op: "set",
      value,
      editedHlc: hlc,
      ...(baseVersion !== undefined ? { baseVersion } : {}),
    },
  ]);
  return ((await res.json()) as PushResponse).results[0] as {
    status: string;
    version?: number;
  };
}

describe("POST …/finalize: a single upload", () => {
  it("makes the file the record's: a new version, the bytes charged, the reservation released", async () => {
    const w = await filesWorld();
    const bytes = bytesOf(100_000);
    const up = await uploaded(w, "saves", "s1", bytes, { baseVersion: "*" });
    expect(usageOf(w)).toMatchObject({ reserved_bytes: 100_000 });
    const out = await finalized(await finalize(w, "saves", "s1", up.uploadId));
    expect(out).toEqual({
      version: expect.any(Number),
      size: 100_000,
      sha256: await sha256Hex(bytes),
      format: "whole",
    });
    // GF2: the record is a write: its version is the file's and the answer's.
    expect(
      rows(
        w,
        "SELECT collection, id, version, value_json, deleted FROM records",
      ),
    ).toEqual([
      {
        collection: "saves",
        id: "s1",
        version: out.version,
        value_json: "null",
        deleted: 0,
      },
    ]);
    expect(rows(w, "SELECT * FROM files")).toEqual([
      expect.objectContaining({
        collection: "saves",
        record_id: "s1",
        version: out.version,
        object_key: keyOf(w, up.uploadId),
        status: "live",
        size: 100_000,
        sha256: out.sha256,
      }),
    ]);
    // Charge, then release: the bytes are in `bytes`, and nothing is still reserved.
    const usage = usageOf(w);
    expect(usage.files).toBe(1);
    expect(usage.file_bytes).toBe(100_000);
    expect(usage.bytes).toBeGreaterThanOrEqual(100_000);
    expect(usage.reserved_bytes ?? 0).toBe(0);
    expect(rows(w, "SELECT state, reserved_bytes FROM uploads")).toEqual([
      { state: "done", reserved_bytes: 0 },
    ]);
    // The object stays where the session put it.
    expect(w.r2.keys()).toEqual([keyOf(w, up.uploadId)]);
  });

  it("is idempotent per uploadId: a repeat answers the same body and charges nothing", async () => {
    const w = await filesWorld();
    const up = await uploaded(w, "saves", "s1", bytesOf(5000));
    const first = await finalized(
      await finalize(w, "saves", "s1", up.uploadId),
    );
    const usage = usageOf(w);
    const seq = rows(w, "SELECT value FROM meta WHERE key = 'seq'");
    for (let i = 0; i < 3; i++)
      expect(
        await finalized(await finalize(w, "saves", "s1", up.uploadId)),
      ).toEqual(first);
    expect(usageOf(w)).toEqual(usage);
    expect(rows(w, "SELECT value FROM meta WHERE key = 'seq'")).toEqual(seq);
    expect(rows(w, "SELECT version FROM files")).toHaveLength(1);
  });

  it("two finalizes at once charge once: the second is answered, or told to retry and then replayed", async () => {
    const w = await filesWorld();
    const up = await uploaded(w, "saves", "s1", bytesOf(5000));
    const both = await Promise.all([
      finalize(w, "saves", "s1", up.uploadId),
      finalize(w, "saves", "s1", up.uploadId),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(
      expect.arrayContaining([200]),
    );
    for (const r of both) expect([200, 503]).toContain(r.status);
    const settled = await finalized(
      await finalize(w, "saves", "s1", up.uploadId),
    );
    for (const r of both)
      if (r.status === 200) expect(await r.json()).toEqual(settled);
    expect(usageOf(w).files).toBe(1);
    expect(usageOf(w).file_bytes).toBe(5000);
    expect(rows(w, "SELECT 1 FROM files")).toHaveLength(1);
  });

  it("a second file keeps the first as a revision: bytes counted once each, files still one", async () => {
    const w = await filesWorld();
    const a = await uploaded(w, "saves", "s1", bytesOf(1000), {
      baseVersion: "*",
    });
    const first = await finalized(await finalize(w, "saves", "s1", a.uploadId));
    const b = await uploaded(w, "saves", "s1", bytesOf(3000, 9), {
      baseVersion: first.version,
    });
    const second = await finalized(
      await finalize(w, "saves", "s1", b.uploadId),
    );
    expect(second.version).toBeGreaterThan(first.version);
    expect(
      rows(w, "SELECT version, status, size FROM files ORDER BY version"),
    ).toEqual([
      { version: first.version, status: "revision", size: 1000 },
      { version: second.version, status: "live", size: 3000 },
    ]);
    const u = usageOf(w);
    expect(u).toMatchObject({
      files: 1,
      file_bytes: 3000,
      revision_bytes: 1000,
    });
    // `bytes` holds both files and the record, once each.
    const record = rows(w, "SELECT 1 FROM records").length;
    expect(record).toBe(1);
    expect(u.bytes).toBeGreaterThanOrEqual(4000);
    expect(u.bytes).toBeLessThan(4000 + 100);
    // Both objects are still stored (the first is a revision now).
    expect(w.r2.keys()).toHaveLength(2);
  });

  it("a finalized file counts against the quota like any stored byte", async () => {
    const w = await filesWorld();
    await setQuota(w, 1_000_000);
    const up = await uploaded(w, "saves", "s1", bytesOf(600_000));
    await finalized(await finalize(w, "saves", "s1", up.uploadId));
    const over = await begin(w, "saves", "s2", beginBody(600_000));
    expect(over.status).toBe(403);
    expect(await over.json()).toEqual({
      error: { code: "quota_exceeded" },
      scope: "user",
    });
  });
});

describe("POST …/finalize: a multipart upload", () => {
  // 20 MiB: parts of 8, 8 and 4 MiB.
  const FILE = bytesOf(20 * MIB);

  it("completes the parts in R2, verifies the whole stream and commits", async () => {
    const w = await filesWorld();
    const up = await uploadedParts(w, "big", "m", FILE, [3, 1, 2]);
    expect(w.r2.openUploads()).toBe(1);
    const out = await finalized(await finalize(w, "big", "m", up.uploadId));
    expect(out).toMatchObject({ size: 20 * MIB, format: "whole" });
    expect(out.sha256).toBe(await sha256Hex(FILE));
    expect(w.r2.openUploads()).toBe(0);
    const stored = (await w.r2.get(keyOf(w, up.uploadId))) as R2ObjectBody;
    expect(await sha256Hex(new Uint8Array(await stored.arrayBuffer()))).toBe(
      out.sha256,
    );
    expect(usageOf(w)).toMatchObject({ files: 1, file_bytes: 20 * MIB });
    expect(usageOf(w).reserved_bytes ?? 0).toBe(0);
  });

  it("refuses with upload_incomplete and the missing parts, and finishes once they are sent", async () => {
    const w = await filesWorld();
    const up = await uploadedParts(w, "big", "m", FILE, [1, 3]);
    const res = await finalize(w, "big", "m", up.uploadId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "upload_incomplete" },
      missing: [2],
    });
    // Nothing was claimed, charged or completed.
    expect(w.r2.openUploads()).toBe(1);
    expect(rows(w, "SELECT state FROM uploads")).toEqual([{ state: "open" }]);
    expect(usageOf(w).files ?? 0).toBe(0);
    await putBytes(
      w,
      `${uploadPath("big", "m", up.uploadId)}/parts/2`,
      FILE.subarray(PART, 2 * PART),
    );
    await finalized(await finalize(w, "big", "m", up.uploadId));
  });

  it("a single upload with no PUT lists part 1 as missing", async () => {
    const w = await filesWorld();
    const res = await begin(w, "saves", "s1", beginBody(bytesOf(100)));
    const up = (await res.json()) as BeginFileResponse;
    const out = await finalize(w, "saves", "s1", up.uploadId);
    expect(out.status).toBe(409);
    expect(await out.json()).toEqual({
      error: { code: "upload_incomplete" },
      missing: [1],
    });
  });

  it("verifies the whole object against the declared hash: a lie is 400, the upload ends, nothing is charged", async () => {
    const w = await filesWorld();
    // Every part is honest, but `begin` declared another file's hash.
    const up = await uploadedParts(w, "big", "m", FILE, [1, 2, 3], 20 * MIB);
    const res = await finalize(w, "big", "m", up.uploadId);
    expect([res.status, await errorCode(res)]).toEqual([
      400,
      "upload_mismatch",
    ]);
    // The pointer did not move: no record, no file, nothing charged or reserved, no object.
    expect(rows(w, "SELECT 1 FROM records")).toEqual([]);
    expect(rows(w, "SELECT 1 FROM files")).toEqual([]);
    expect(usageOf(w).files ?? 0).toBe(0);
    expect(usageOf(w).reserved_bytes ?? 0).toBe(0);
    expect(w.r2.keys()).toEqual([]);
    expect(w.r2.openUploads()).toBe(0);
    // The upload is over.
    const again = await finalize(w, "big", "m", up.uploadId);
    expect(again.status).toBe(404);
  });

  it("completes over an R2 upload that was completed already (a retry after a crash)", async () => {
    const w = await filesWorld();
    const up = await uploadedParts(w, "big", "m", FILE, [1, 2, 3]);
    // The first call got as far as R2's complete and died.
    const parts = rows(w, "SELECT n, etag FROM upload_parts ORDER BY n").map(
      (r) => ({ partNumber: r.n as number, etag: r.etag as string }),
    );
    const mp = rows(w, "SELECT multipart_id FROM uploads")[0]
      ?.multipart_id as string;
    await w.r2.resumeMultipartUpload(keyOf(w, up.uploadId), mp).complete(parts);
    await finalized(await finalize(w, "big", "m", up.uploadId));
    expect(usageOf(w).files).toBe(1);
  });
});

describe("POST …/finalize: the stored object is hashed, not trusted", () => {
  it("an object that is not the declared size or bytes is refused and removed", async () => {
    for (const tampered of [bytesOf(5000, 9), bytesOf(4000)]) {
      const w = await filesWorld();
      const up = await uploaded(w, "saves", "s1", bytesOf(5000));
      // The bytes at rest change after the PUT (R2 holds no stored hash for a replaced object).
      w.r2.tamper(keyOf(w, up.uploadId), tampered);
      const res = await finalize(w, "saves", "s1", up.uploadId);
      expect([res.status, await errorCode(res)]).toEqual([
        400,
        "upload_mismatch",
      ]);
      expectNothingKept(w);
    }
  });
});

describe("POST …/finalize: an object that went missing", () => {
  it("a single upload whose object is gone lists part 1 as missing, and takes the bytes again", async () => {
    const w = await filesWorld();
    const bytes = bytesOf(2000);
    const up = await uploaded(w, "saves", "s1", bytes);
    await w.r2.delete(keyOf(w, up.uploadId));
    const res = await finalize(w, "saves", "s1", up.uploadId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "upload_incomplete" },
      missing: [1],
    });
    expect(
      (await putBytes(w, uploadPath("saves", "s1", up.uploadId), bytes)).status,
    ).toBe(204);
    await finalized(await finalize(w, "saves", "s1", up.uploadId));
  });
});

describe("POST …/finalize: the record is re-checked (GF3)", () => {
  it("any write to the record since begin is 409 revision_conflict, and the upload ends", async () => {
    const w = await filesWorld();
    const v = (await putRecord(w, "big", "r", { a: 1 })).version as number;
    const up = await uploaded(w, "big", "r", bytesOf(1000), {
      baseVersion: v,
    });
    // A metadata write lands between begin and finalize.
    const next = (await putRecord(w, "big", "r", { a: 2 }, v))
      .version as number;
    expect(next).toBeGreaterThan(v);
    const res = await finalize(w, "big", "r", up.uploadId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "revision_conflict" },
      server: { version: next },
    });
    // Nothing moved: the record is the pusher's, no file, no charge, no object, no reservation.
    expect(rows(w, "SELECT version, value_json FROM records")).toEqual([
      { version: next, value_json: '{"a":2}' },
    ]);
    expectNothingKept(w);
  });

  it("a create-only upload loses to a record created meanwhile", async () => {
    const w = await filesWorld();
    const up = await uploaded(w, "big", "r", bytesOf(1000), {
      baseVersion: "*",
    });
    await putRecord(w, "big", "r", { a: 1 }, "*");
    const res = await finalize(w, "big", "r", up.uploadId);
    expect([res.status, await errorCode(res)]).toEqual([
      409,
      "revision_conflict",
    ]);
    expect(rows(w, "SELECT 1 FROM files")).toEqual([]);
  });

  it("the file keeps the record's value, and a metadata write on the returned version goes through", async () => {
    const w = await filesWorld();
    const v = (await putRecord(w, "big", "r", { a: 1 })).version as number;
    const up = await uploaded(w, "big", "r", bytesOf(1000), { baseVersion: v });
    const out = await finalized(await finalize(w, "big", "r", up.uploadId));
    expect(out.version).toBeGreaterThan(v);
    expect(rows(w, "SELECT version, value_json FROM records")).toEqual([
      { version: out.version, value_json: '{"a":1}' },
    ]);
    // File first, metadata second, on the version finalize returned.
    expect((await putRecord(w, "big", "r", { a: 2 }, out.version)).status).toBe(
      "ok",
    );
    // The old version is stale now.
    expect((await putRecord(w, "big", "r", { a: 3 }, v)).status).toBe(
      "conflict",
    );
  });

  it("a record deleted since begin is a conflict for a number baseVersion", async () => {
    const w = await filesWorld();
    const v = (await putRecord(w, "big", "r", { a: 1 })).version as number;
    const up = await uploaded(w, "big", "r", bytesOf(1000), { baseVersion: v });
    const del = await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["big", "r"] },
        op: "delete",
        editedHlc: hlc,
      },
    ]);
    expect(del.status).toBe(200);
    const res = await finalize(w, "big", "r", up.uploadId);
    expect(res.status).toBe(409);
  });

  it("a create is checked against maxRecords at commit: 403 scope collection, and the upload ends", async () => {
    const w = await filesWorld();
    const a = await uploaded(w, "one", "a", bytesOf(100));
    const b = await uploaded(w, "one", "b", bytesOf(100, 9));
    await finalized(await finalize(w, "one", "a", a.uploadId));
    const res = await finalize(w, "one", "b", b.uploadId);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "quota_exceeded" },
      scope: "collection",
    });
    expect(rows(w, "SELECT record_id FROM files")).toEqual([
      { record_id: "a" },
    ]);
    expect(w.r2.keys()).toEqual([keyOf(w, a.uploadId)]);
  });
});

describe("reservations protect the room a file was promised", () => {
  it("a push cannot take the bytes an open upload has reserved", async () => {
    const w = await filesWorld();
    await setQuota(w, 700_000);
    expect((await begin(w, "saves", "s1", beginBody(600_000))).status).toBe(
      200,
    );
    const chunk = "x".repeat(60_000);
    // 600,000 reserved + about 60,000: room. The next 60,000 would pass 700,000.
    expect((await putRecord(w, "big", "r1", chunk)).status).toBe("ok");
    const refused = (await putRecord(w, "big", "r2", chunk)) as {
      status: string;
      code?: string;
      scope?: string;
    };
    expect(refused).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "user",
    });
  });
});

describe("reservations protect the room, for settings too", () => {
  it("a setting write cannot take the bytes an open upload has reserved", async () => {
    const w = await filesWorld();
    await setQuota(w, 600_300);
    expect((await begin(w, "saves", "s1", beginBody(600_000))).status).toBe(
      200,
    );
    const setting = (key: string, size: number) =>
      push(w, [
        {
          mutationId: nextId(),
          target: { setting: key, scope: "user" },
          op: "set",
          value: "y".repeat(size),
          editedHlc: hlc,
        },
      ]).then(
        async (r) => ((await r.json()) as PushResponse).results[0] as object,
      );
    expect(await setting("a", 100)).toMatchObject({ status: "ok" });
    expect(await setting("b", 500)).toMatchObject({
      status: "rejected",
      code: "quota_exceeded",
      scope: "user",
    });
  });
});

describe("POST …/finalize: the session", () => {
  it("is 404 for a session that is unknown, another record's or ended, and 410 once expired", async () => {
    const { w, up } = await pinnedSingle(100);
    for (const [c, id, uploadId] of [
      ["saves", "s1", "up_AAAAAAAAAAAAAAAAAAAAAA"],
      ["saves", "other", up.uploadId],
      ["big", "s1", up.uploadId],
    ] as const)
      expect((await finalize(w, c, id, uploadId)).status).toBe(404);
    vi.setSystemTime((NOW + 86_400) * 1000);
    const late = await finalize(w, "saves", "s1", up.uploadId);
    expect([late.status, await errorCode(late)]).toEqual([
      410,
      "upload_expired",
    ]);
    expect(w.r2.keys()).toEqual([]);
    expect((await finalize(w, "saves", "s1", up.uploadId)).status).toBe(404);

    const gone = await uploaded(w, "saves", "s2", bytesOf(100));
    await call(w, "DELETE", uploadPath("saves", "s2", gone.uploadId));
    expect((await finalize(w, "saves", "s2", gone.uploadId)).status).toBe(404);
  });

  it("a body that is not {uploadId} is 400", async () => {
    const w = await filesWorld();
    for (const json of [{}, { uploadId: 5 }, { uploadId: "nope" }, [], "x"]) {
      const res = await call(w, "POST", "/djdl/sync/files/saves/s1/finalize", {
        json,
      });
      expect([res.status, await errorCode(res)], JSON.stringify(json)).toEqual([
        400,
        "bad_request",
      ]);
    }
  });

  it("a finalize in flight is 503 for the same upload, until its claim runs out", async () => {
    const { w, up } = await pinnedSingle(100);
    // Another call has claimed the session and is hashing.
    const prepared = await callCloudSync<"fileFinalizePrepare">(
      w.env,
      { product: SLUG, subject: w.subject },
      {
        op: "fileFinalizePrepare",
        collection: "saves",
        recordId: "s1",
        uploadId: up.uploadId,
        serverNow: NOW * 1000,
      },
    );
    expect(prepared.outcome.ok).toBe(true);
    const busy = await finalize(w, "saves", "s1", up.uploadId);
    expect([busy.status, await errorCode(busy)]).toEqual([503, "unavailable"]);
    expect(busy.headers.get("retry-after")).toBe("1");
    // The claim lapses (the other call died): this one takes over.
    vi.setSystemTime((NOW + 61) * 1000);
    await finalized(await finalize(w, "saves", "s1", up.uploadId));
  });

  it("R2 failing while the object is read gives the claim back: the next call finishes", async () => {
    const w = await filesWorld();
    const up = await uploaded(w, "saves", "s1", bytesOf(100));
    const head = w.r2.head.bind(w.r2);
    let calls = 0;
    w.r2.head = async (key: string) => {
      // The first head is the prepare's (it must work); the second is the Worker's read.
      if (++calls === 2) throw new Error("R2 is down");
      return head(key);
    };
    const down = await finalize(w, "saves", "s1", up.uploadId);
    expect(down.status).toBe(503);
    expect(rows(w, "SELECT state FROM uploads")).toEqual([{ state: "open" }]);
    w.r2.head = head;
    await finalized(await finalize(w, "saves", "s1", up.uploadId));
  });

  it("answers 404 with the gate off, 401 with no bearer, and 503 with writes paused", async () => {
    const w = await filesWorld();
    const up = await uploaded(w, "saves", "s1", bytesOf(100));
    const anon = await call(w, "POST", "/djdl/sync/files/saves/s1/finalize", {
      json: { uploadId: up.uploadId },
      anonymous: true,
    });
    expect(anon.status).toBe(401);
    await w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('cloudSync.writesPaused', '"on"', 1, ?, 'test')`,
      NOW,
    );
    const { invalidatePlatformSettings } =
      await import("../../../src/core/platformSettings.js");
    invalidatePlatformSettings(w.env, w.db);
    const paused = await finalize(w, "saves", "s1", up.uploadId);
    expect([paused.status, await errorCode(paused)]).toEqual([
      503,
      "writes_paused",
    ]);
    expect(rows(w, "SELECT 1 FROM files")).toEqual([]);
  });
});
