/**
 * U-37.2: `begin` in `chunks` mode and the plan call (WIRE-CONTRACT-V5 §13.8.1, §13.8.2), driven
 * through the real dispatch pipeline and the real `CloudSyncDO` over the SQLite mock.
 */
import { describe, expect, it } from "vitest";
import type { UploadStatus } from "@polaris-key/protocol/sync";
import {
  SYNC_CHUNK_MAX_STORED_BYTES,
  SYNC_MANIFEST_MAX_STORED_BYTES,
} from "@polaris-key/protocol/sync";
import {
  begin,
  beginBody,
  call,
  errorCode,
  filesWorld,
  meta,
  rows,
  setQuota,
  uploadPath,
  uploadRow,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";
import {
  MIB,
  beginChunks,
  chunkOf,
  exec,
  manifestOf,
  plan,
  planPath,
  planUpload,
  planned,
} from "./cloudSyncChunksWorld.js";

const reserved = (w: FilesWorld): number =>
  Number(meta(w, "usage_reserved_bytes") ?? 0);

const pins = (w: FilesWorld, uploadId: string) =>
  rows(
    w,
    `SELECT chunk_id, stored_bytes, have, reserved FROM upload_chunks WHERE upload_id = '${uploadId}' ORDER BY chunk_id`,
  );

describe("begin in chunks mode", () => {
  it("answers mode chunks for a manifest and reserves the manifest's bytes", async () => {
    const w = await filesWorld();
    const manifest = manifestOf();
    const up = await beginChunks(w, "delta", "slot", manifest);
    expect(up.mode).toBe("chunks");
    expect(up.partBytes).toBeUndefined();
    expect(reserved(w)).toBe(manifest.length);
    const row = uploadRow(w, up.uploadId)!;
    expect(row).toMatchObject({
      mode: "chunks",
      format: "chunks",
      size: manifest.length,
    });
  });

  it("refuses chunks on a collection without files.delta with 400 bad_request", async () => {
    const w = await filesWorld();
    const res = await begin(
      w,
      "big",
      "slot",
      beginBody(manifestOf(), { format: "chunks" }),
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("bad_request");
  });

  it("refuses a manifest over SYNC_MANIFEST_MAX_STORED_BYTES with 413 and one under the smallest with 400", async () => {
    const w = await filesWorld();
    const over = await begin(
      w,
      "delta",
      "slot",
      beginBody(SYNC_MANIFEST_MAX_STORED_BYTES + 1, { format: "chunks" }),
    );
    expect(over.status).toBe(413);
    expect(await errorCode(over)).toBe("file_too_large");
    const atMax = await begin(
      w,
      "delta",
      "slot",
      beginBody(SYNC_MANIFEST_MAX_STORED_BYTES, { format: "chunks" }),
    );
    expect(atMax.status).toBe(200);
    const tiny = await begin(
      w,
      "delta",
      "slot2",
      beginBody(111, { format: "chunks" }),
    );
    expect(tiny.status).toBe(400);
  });

  it("keeps a whole file on a delta collection in single mode, whatever its size", async () => {
    const w = await filesWorld();
    const res = await begin(w, "delta", "slot", beginBody(2 * MIB));
    expect(((await res.json()) as { mode: string }).mode).toBe("single");
  });
});

describe("the plan call", () => {
  it("answers every named id once; an unknown chunk is missing and reserves its declared bytes", async () => {
    const w = await filesWorld();
    const a = chunkOf(1, 1000);
    const b = chunkOf(2, 3000);
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    const before = reserved(w);
    const lists = await planned(w, "delta", "slot", up.uploadId, [a, b]);
    expect(lists.missing.sort()).toEqual([a.id, b.id].sort());
    expect(lists.present).toEqual([]);
    expect(reserved(w)).toBe(before + a.object.length + b.object.length);
    expect(pins(w, up.uploadId)).toHaveLength(2);
    expect(Number(uploadRow(w, up.uploadId)!.reserved_bytes)).toBe(
      before + a.object.length + b.object.length,
    );
  });

  it("naming an id again changes nothing", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await planUpload(w, "slot", [a]);
    const once = reserved(w);
    await planned(w, "delta", "slot", up.uploadId, [a]);
    expect(reserved(w)).toBe(once);
    expect(pins(w, up.uploadId)).toHaveLength(1);
  });

  it("answers present, with the stored size, for a chunk the collection stores, and reserves only an unreferenced one", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const b = chunkOf(2);
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    // Two chunks as the object would hold them after earlier writes: A referenced, B not.
    exec(
      w,
      `INSERT INTO chunks VALUES ('delta', '${a.id}', 'u/p/s/c/delta/${a.id}', ${a.object.length}, 1, 0, NULL),
                                 ('delta', '${b.id}', 'u/p/s/c/delta/${b.id}', ${b.object.length}, 0, 0, NULL)`,
    );
    const base = reserved(w);
    const lists = await planned(w, "delta", "slot", up.uploadId, [a, b]);
    expect(lists.missing).toEqual([]);
    expect(lists.present.sort()).toEqual(
      [
        [a.id, a.object.length],
        [b.id, b.object.length],
      ].sort(),
    );
    // A is charged already; B will be charged by this upload's finalize, so it is reserved.
    expect(reserved(w)).toBe(base + b.object.length);
    expect(pins(w, up.uploadId).map((r) => [r.have, r.reserved])).toEqual(
      expect.arrayContaining([
        [1, 0],
        [1, b.object.length],
      ]),
    );
  });

  it("is per collection: a chunk another collection stores is missing here", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    exec(
      w,
      `INSERT INTO chunks VALUES ('big', '${a.id}', 'u/p/s/c/big/${a.id}', ${a.object.length}, 1, 0, NULL)`,
    );
    const lists = await planned(w, "delta", "slot", up.uploadId, [a]);
    expect(lists.missing).toEqual([a.id]);
    expect(lists.present).toEqual([]);
  });

  it("refuses a bad body with 400 and writes nothing: duplicates, bad ids, sizes out of range, too many ids, extra members", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    const path = planPath("delta", "slot", up.uploadId);
    const bad: unknown[] = [
      {},
      { chunks: [] },
      { chunks: "x" },
      {
        chunks: [
          [a.id, 10],
          [a.id, 10],
        ],
      },
      { chunks: [["ABC".repeat(22).slice(0, 64), 10]] },
      { chunks: [[a.id.slice(1), 10]] },
      { chunks: [[a.id, 0]] },
      { chunks: [[a.id, 2]] },
      { chunks: [[a.id, SYNC_CHUNK_MAX_STORED_BYTES + 1]] },
      { chunks: [[a.id, 1.5]] },
      { chunks: [[a.id]] },
      { chunks: [[a.id, 10, 11]] },
      {
        chunks: Array.from({ length: 1025 }, (_, i) => [
          i.toString(16).padStart(64, "0"),
          100,
        ]),
      },
    ];
    for (const json of bad) {
      const res = await call(w, "POST", path, { json });
      expect(res.status, JSON.stringify(json).slice(0, 60)).toBe(400);
    }
    expect(pins(w, up.uploadId)).toEqual([]);
    expect(reserved(w)).toBe(Number(uploadRow(w, up.uploadId)!.reserved_bytes));
  });

  it("caps the chunk size at SYNC_CHUNK_MAX_STORED_BYTES and the smallest object by mode", async () => {
    const w = await filesWorld();
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    const id = (n: number) => n.toString(16).padStart(64, "0");
    expect(
      (await plan(w, "delta", "slot", up.uploadId, [[id(1), 2]])).status,
    ).toBe(400);
    expect(
      (await plan(w, "delta", "slot", up.uploadId, [[id(1), 3]])).status,
    ).toBe(200);
    expect(
      (
        await plan(w, "delta", "slot", up.uploadId, [
          [id(2), SYNC_CHUNK_MAX_STORED_BYTES],
        ])
      ).status,
    ).toBe(200);
  });

  it("allows at most 16,384 distinct ids over all the calls of one upload", async () => {
    const w = await filesWorld({
      catalog: {
        schemaVersion: 1,
        entries: [],
        cloudSync: {
          encryption: "server",
          collections: [
            {
              name: "delta",
              label: "Delta",
              files: { delta: true, maxBytes: 1_073_741_824, keepRevisions: 1 },
            },
          ],
        },
      },
    });
    await setQuota(w, 10 * 1024 ** 3);
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    const batch = (from: number) =>
      Array.from({ length: 1024 }, (_, i): [string, number] => [
        (from + i).toString(16).padStart(64, "0"),
        3,
      ]);
    for (let k = 0; k < 16; k++)
      expect(
        (await plan(w, "delta", "slot", up.uploadId, batch(k * 1024))).status,
      ).toBe(200);
    const res = await plan(w, "delta", "slot", up.uploadId, batch(16 * 1024));
    expect(res.status).toBe(400);
    // Re-naming ids it already holds is not "more".
    expect((await plan(w, "delta", "slot", up.uploadId, batch(0))).status).toBe(
      200,
    );
    expect(pins(w, up.uploadId)).toHaveLength(16 * 1024);
  }, 120_000);

  it("refuses over the quota with 403 quota_exceeded scope user, naming nothing", async () => {
    const w = await filesWorld();
    await setQuota(w, 5000);
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    const a = chunkOf(1, 3000);
    const b = chunkOf(2, 3000);
    const res = await plan(w, "delta", "slot", up.uploadId, [
      [a.id, a.object.length],
      [b.id, b.object.length],
    ]);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("quota_exceeded");
    expect(pins(w, up.uploadId)).toEqual([]);
    // One that fits is taken.
    expect(
      (await plan(w, "delta", "slot", up.uploadId, [[a.id, a.object.length]]))
        .status,
    ).toBe(200);
  });

  it("refuses a file over files.maxBytes with 413 file_too_large", async () => {
    const w = await filesWorld();
    await setQuota(w, 100 * MIB);
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    const ids = Array.from({ length: 11 }, (_, i): [string, number] => [
      (i + 1).toString(16).padStart(64, "0"),
      SYNC_CHUNK_MAX_STORED_BYTES,
    ]);
    const res = await plan(w, "delta", "slot", up.uploadId, ids);
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("file_too_large");
    expect(pins(w, up.uploadId)).toEqual([]);
  });

  it("is 404 for an unknown upload and another record's, 400 upload_mismatch for a single upload", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    const ghost = "up_AAAAAAAAAAAAAAAAAAAAAA";
    expect((await plan(w, "delta", "slot", ghost, [[a.id, 100]])).status).toBe(
      404,
    );
    expect(
      (await plan(w, "delta", "other", up.uploadId, [[a.id, 100]])).status,
    ).toBe(404);
    const single = await begin(w, "delta", "s2", beginBody(100));
    const sid = ((await single.json()) as { uploadId: string }).uploadId;
    const res = await plan(w, "delta", "s2", sid, [[a.id, 100]]);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("upload_mismatch");
  });

  it("is 405 for any other method and needs the device bearer", async () => {
    const w = await filesWorld();
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    const path = planPath("delta", "slot", up.uploadId);
    expect((await call(w, "GET", path)).status).toBe(405);
    expect(
      (await call(w, "POST", path, { json: { chunks: [] }, anonymous: true }))
        .status,
    ).toBe(401);
  });

  it("is 410 once the upload is past its 24 hours", async () => {
    const w = await filesWorld();
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    const a = chunkOf(1);
    exec(
      w,
      `UPDATE uploads SET expires_at = 1 WHERE upload_id = '${up.uploadId}'`,
    );
    const res = await plan(w, "delta", "slot", up.uploadId, [[a.id, 100]]);
    expect(res.status).toBe(410);
  });

  it("the resume answer of a chunks upload lists the chunk ids it lacks and the manifest part", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const b = chunkOf(2);
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    await planned(w, "delta", "slot", up.uploadId, [a, b]);
    const res = await call(w, "GET", uploadPath("delta", "slot", up.uploadId));
    const status = (await res.json()) as UploadStatus;
    expect(status.mode).toBe("chunks");
    expect(status.missing?.sort()).toEqual([a.id, b.id].sort());
    expect(status.received).toEqual([]);
  });

  it("DELETE releases the reservation and the pins", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await beginChunks(w, "delta", "slot", manifestOf());
    await planned(w, "delta", "slot", up.uploadId, [a]);
    expect(reserved(w)).toBeGreaterThan(0);
    const del = await call(
      w,
      "DELETE",
      uploadPath("delta", "slot", up.uploadId),
    );
    expect(del.status).toBe(204);
    expect(reserved(w)).toBe(0);
    expect(pins(w, up.uploadId)).toEqual([]);
  });
});
