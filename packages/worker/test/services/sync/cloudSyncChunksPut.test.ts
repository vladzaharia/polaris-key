/**
 * U-37.3: `PUT …/upload/{uploadId}/chunks/{chunkId}` and `GET …/files/{collection}/chunks/{chunkId}`
 * (WIRE-CONTRACT-V5 §13.8.2, §13.8.3): create-only, only ids the plan answered `missing`, the exact
 * declared size and the digest, under the person's own prefix and key; and the read of a chunk only
 * when a file of that collection references it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "../../seed.js";
import { SYNC_CHUNK_MAX_STORED_BYTES } from "@polaris-key/protocol/sync";
import { createHash } from "node:crypto";
import {
  SLUG,
  begin,
  beginBody,
  bytesOf,
  call,
  errorCode,
  filesWorld,
  meta,
  rows,
  spendLimit,
  uploadPath,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";
import {
  beginChunks,
  chunkOf,
  chunkPath,
  digestHeader,
  exec,
  manifestOf,
  plan,
  planned,
  putChunk,
  type TestChunk,
} from "./cloudSyncChunksWorld.js";

afterEach(() => vi.useRealTimers());

const keyOf = (w: FilesWorld, collection: string, chunkId: string) =>
  `u/${SLUG}/${w.subject}/c/${collection}/${chunkId}`;

const chunkRow = (w: FilesWorld, collection: string, id: string) =>
  rows(
    w,
    `SELECT * FROM chunks WHERE collection = '${collection}' AND chunk_id = '${id}'`,
  )[0];

/** An upload in `delta` with `chunks` planned, ready for PUTs. */
async function ready(w: FilesWorld, chunks: TestChunk[], record = "slot") {
  const up = await beginChunks(w, "delta", record, manifestOf());
  await planned(w, "delta", record, up.uploadId, chunks);
  return up;
}

describe("PUT …/chunks/{chunkId}", () => {
  it("stores the object create-only under the person's prefix, with the person's key, and records the chunk unreferenced", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await ready(w, [a]);
    const res = await putChunk(w, "delta", "slot", up.uploadId, a);
    expect(res.status).toBe(204);
    const key = keyOf(w, "delta", a.id);
    expect(w.r2.keys()).toEqual([key]);
    expect(w.r2.raw(key)).toEqual(a.object);
    // Server-mode objects take the person's SSE-C key (D-8), like a server-mode file.
    expect(w.r2.ssecOf(key)).toBeDefined();
    expect(chunkRow(w, "delta", a.id)).toMatchObject({
      object_key: key,
      stored_bytes: a.object.length,
      refs: 0,
    });
    expect(
      rows(w, `SELECT have FROM upload_chunks WHERE chunk_id = '${a.id}'`),
    ).toEqual([{ have: 1 }]);
    // The next plan call says present.
    const lists = await planned(w, "delta", "slot", up.uploadId, [a]);
    expect(lists.present).toEqual([[a.id, a.object.length]]);
  });

  it("refuses an id the plan did not name, and a session that is not a chunks session, as upload_mismatch", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const b = chunkOf(2);
    const up = await ready(w, [a]);
    const stray = await putChunk(w, "delta", "slot", up.uploadId, b);
    expect(stray.status).toBe(400);
    expect(await errorCode(stray)).toBe("upload_mismatch");
    const single = await begin(w, "delta", "s2", beginBody(100));
    const sid = ((await single.json()) as { uploadId: string }).uploadId;
    const wrong = await putChunk(w, "delta", "s2", sid, a);
    expect(wrong.status).toBe(400);
    expect(w.r2.putAttempts).toEqual([]);
    expect(chunkRow(w, "delta", b.id)).toBeUndefined();
  });

  it("refuses a wrong length, a missing digest, a wrong digest and an over-cap body before storing anything", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await ready(w, [a]);
    const longer = new Uint8Array(a.object.length + 1);
    const refused = async (
      over: Record<string, string | undefined>,
      bytes = a.object,
    ) => {
      const res = await putChunk(
        w,
        "delta",
        "slot",
        up.uploadId,
        { ...a, object: bytes },
        over,
      );
      return [res.status, res.status === 400 ? await errorCode(res) : ""];
    };
    expect(await refused({}, longer)).toEqual([400, "upload_mismatch"]);
    expect(await refused({ "content-digest": undefined })).toEqual([
      400,
      "upload_mismatch",
    ]);
    expect(
      await refused({ "content-digest": digestHeader(bytesOf(9, 3)) }),
    ).toEqual([400, "upload_mismatch"]);
    expect(await refused({ "content-length": undefined })).toEqual([
      400,
      "upload_mismatch",
    ]);
    const huge = await putChunk(w, "delta", "slot", up.uploadId, a, {
      "content-length": String(SYNC_CHUNK_MAX_STORED_BYTES + 1),
    });
    expect(huge.status).toBe(413);
    expect(w.r2.keys()).toEqual([]);
    expect(chunkRow(w, "delta", a.id)).toBeUndefined();
  });

  it("is create-only: a resend of a landed chunk is 204 and a second upload's identical PUT stands, a different object does not replace it", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up1 = await ready(w, [a], "one");
    expect((await putChunk(w, "delta", "one", up1.uploadId, a)).status).toBe(
      204,
    );
    // A resend: the plan has it as held, nothing is written again.
    const attempts = w.r2.putAttempts.length;
    expect((await putChunk(w, "delta", "one", up1.uploadId, a)).status).toBe(
      204,
    );
    expect(w.r2.putAttempts.length).toBe(attempts);
    // A second upload planned before the first landed (missing for it too) finds the object there.
    const up2 = await beginChunks(w, "delta", "two", manifestOf(2));
    exec(w, `DELETE FROM chunks WHERE chunk_id = '${a.id}'`);
    await planned(w, "delta", "two", up2.uploadId, [a]);
    expect((await putChunk(w, "delta", "two", up2.uploadId, a)).status).toBe(
      204,
    );
    expect(w.r2.raw(keyOf(w, "delta", a.id))).toEqual(a.object);
    // An object that differs under the same key never replaces it.
    exec(w, `DELETE FROM chunks WHERE chunk_id = '${a.id}'`);
    const other = { ...a, object: bytesOf(a.object.length, 99) };
    const up3 = await beginChunks(w, "delta", "three", manifestOf(3));
    await planned(w, "delta", "three", up3.uploadId, [a]);
    const clash = await putChunk(w, "delta", "three", up3.uploadId, other);
    expect(clash.status).toBe(400);
    expect(w.r2.raw(keyOf(w, "delta", a.id))).toEqual(a.object);
  });

  it("keeps two collections' chunks apart: the same id is two objects", async () => {
    const w = await filesWorld({
      catalog: {
        schemaVersion: 1,
        entries: [],
        cloudSync: {
          encryption: "server",
          collections: [
            { name: "delta", label: "A", files: { delta: true } },
            { name: "delta2", label: "B", files: { delta: true } },
          ],
        },
      },
    });
    const a = chunkOf(1);
    const up1 = await beginChunks(w, "delta", "slot", manifestOf());
    await planned(w, "delta", "slot", up1.uploadId, [a]);
    expect((await putChunk(w, "delta", "slot", up1.uploadId, a)).status).toBe(
      204,
    );
    // Another collection does not see it.
    const up2 = await beginChunks(w, "delta2", "slot", manifestOf());
    const lists = await planned(w, "delta2", "slot", up2.uploadId, [a]);
    expect(lists.missing).toEqual([a.id]);
    expect((await putChunk(w, "delta2", "slot", up2.uploadId, a)).status).toBe(
      204,
    );
    expect(w.r2.keys()).toEqual(
      [keyOf(w, "delta", a.id), keyOf(w, "delta2", a.id)].sort(),
    );
  });

  it("is 404 on a closed session and 410 past its 24 hours; DELETE then PUT stores nothing", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await ready(w, [a]);
    const del = await call(
      w,
      "DELETE",
      uploadPath("delta", "slot", up.uploadId),
    );
    expect(del.status).toBe(204);
    expect((await putChunk(w, "delta", "slot", up.uploadId, a)).status).toBe(
      404,
    );
    expect(w.r2.keys()).toEqual([]);
    const b = chunkOf(2);
    const up2 = await ready(w, [b], "slot2");
    exec(
      w,
      `UPDATE uploads SET expires_at = 1 WHERE upload_id = '${up2.uploadId}'`,
    );
    expect((await putChunk(w, "delta", "slot2", up2.uploadId, b)).status).toBe(
      410,
    );
  });

  it("gives the object a row even when the session closed while the bytes were on their way", async () => {
    // The Worker streams to R2, then tells the object; a DELETE in between must not orphan the object.
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await ready(w, [a]);
    const realPut = w.r2.put.bind(w.r2);
    w.r2.put = (async (...args: Parameters<typeof realPut>) => {
      const out = await realPut(...args);
      await call(w, "DELETE", uploadPath("delta", "slot", up.uploadId));
      return out;
    }) as typeof w.r2.put;
    const res = await putChunk(w, "delta", "slot", up.uploadId, a);
    expect(res.status).toBe(404);
    expect(chunkRow(w, "delta", a.id)).toMatchObject({ refs: 0 });
    expect(meta(w, "usage_reserved_bytes") ?? "0").toBe("0");
  });

  it("is 405 for other methods and needs the device bearer", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await ready(w, [a]);
    const path = chunkPath("delta", "slot", up.uploadId, a.id);
    expect((await call(w, "GET", path)).status).toBe(405);
    expect(
      (await call(w, "PUT", path, { bytes: a.object, anonymous: true })).status,
    ).toBe(401);
  });

  it("shares the 600-a-minute allowance with the parts and the plan call: the 601st request is 429 and stores nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const w = await filesWorld();
    const a = chunkOf(1);
    const up = await ready(w, [a]);
    // `ready` spent one request on the plan call.
    await spendLimit(w, "syncParts", 598, 600, 60);
    // One left: the plan call takes it, the next request is refused, whichever route it is.
    expect(
      (await plan(w, "delta", "slot", up.uploadId, [[a.id, a.object.length]]))
        .status,
    ).toBe(200);
    const res = await putChunk(w, "delta", "slot", up.uploadId, a);
    expect([res.status, await errorCode(res)]).toEqual([429, "rate_limited"]);
    expect(res.headers.get("retry-after")).not.toBeNull();
    expect(w.r2.putAttempts).toEqual([]);
    expect(
      (await call(w, "GET", `/${SLUG}/sync/files/delta/chunks/${a.id}`)).status,
    ).toBe(429);
    // The next minute it goes through.
    vi.setSystemTime((NOW + 60) * 1000);
    expect((await putChunk(w, "delta", "slot", up.uploadId, a)).status).toBe(
      204,
    );
  });
});

describe("GET …/files/{collection}/chunks/{chunkId}", () => {
  /** A chunk a file references: the object in R2 and its row, as a `finalize` leaves them. */
  async function referenced(w: FilesWorld, c: TestChunk, collection = "delta") {
    const up = await beginChunks(w, "delta", "seed", manifestOf(5));
    await planned(w, "delta", "seed", up.uploadId, [c]);
    expect((await putChunk(w, "delta", "seed", up.uploadId, c)).status).toBe(
      204,
    );
    if (collection === "delta")
      exec(w, `UPDATE chunks SET refs = 1 WHERE chunk_id = '${c.id}'`);
  }

  const get = (w: FilesWorld, collection: string, id: string) =>
    call(w, "GET", `/${SLUG}/sync/files/${collection}/chunks/${id}`);

  it("answers the stored object with attachment, nosniff, no-store and the object's SHA-256 as ETag", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    await referenced(w, a);
    const res = await get(w, "delta", a.id);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(a.object);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBe(
      `"${createHash("sha256").update(a.object).digest("hex")}"`,
    );
    expect(res.headers.get("content-length")).toBe(String(a.object.length));
  });

  it("is the same 404 for an unknown id, an unreferenced chunk and another collection's chunk", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const b = chunkOf(2);
    await referenced(w, a);
    // B is stored but nothing references it.
    const up = await beginChunks(w, "delta", "slotb", manifestOf(6));
    await planned(w, "delta", "slotb", up.uploadId, [b]);
    await putChunk(w, "delta", "slotb", up.uploadId, b);
    for (const [coll, id] of [
      ["delta", chunkOf(3).id],
      ["delta", b.id],
      ["big", a.id],
      ["nope", a.id],
    ] as const) {
      const res = await get(w, coll, id);
      expect(res.status, `${coll} ${id.slice(0, 6)}`).toBe(404);
    }
  });

  it("refuses a malformed id, other methods and no bearer; it is not a path to another person's chunk", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    await referenced(w, a);
    expect((await get(w, "delta", "XYZ")).status).toBe(404);
    expect(
      (await call(w, "POST", `/${SLUG}/sync/files/delta/chunks/${a.id}`))
        .status,
    ).toBe(405);
    expect(
      (
        await call(w, "GET", `/${SLUG}/sync/files/delta/chunks/${a.id}`, {
          anonymous: true,
        })
      ).status,
    ).toBe(401);
  });
});
