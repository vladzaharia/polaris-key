/**
 * U-37.4: `finalize` for a `chunks` upload (WIRE-CONTRACT-V5 §13.8.1, §13.8.2): every planned chunk
 * stored (or `409 upload_incomplete` with the ids), the manifest received, `file_chunks` rows and a
 * reference on each chunk, and the reservation turned into the charge: the manifest plus the chunk
 * bytes, each chunk charged once while it is referenced.
 */
import { describe, expect, it } from "vitest";
import type { FinalizeResponse } from "@polaris-key/protocol/sync";
import {
  call,
  errorCode,
  filesPath,
  filesWorld,
  finalize,
  rows,
  setQuota,
  sha256Hex,
  stored,
  uploadRow,
  usageOf,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";
import {
  beginChunks,
  chunkOf,
  deleteRecord,
  fireAlarm,
  keyOfChunk,
  manifestOf,
  planned,
  putChunk,
  putManifest,
  writeChunked,
  type TestChunk,
} from "./cloudSyncChunksWorld.js";

const usage = (
  w: FilesWorld,
): Record<
  "bytes" | "file_bytes" | "revision_bytes" | "files" | "reserved_bytes",
  number
> => ({
  bytes: 0,
  file_bytes: 0,
  revision_bytes: 0,
  files: 0,
  reserved_bytes: 0,
  ...usageOf(w),
});

const refsOf = (w: FilesWorld, c: TestChunk): number | undefined =>
  rows(
    w,
    `SELECT refs FROM chunks WHERE collection = 'delta' AND chunk_id = '${c.id}'`,
  )[0]?.refs as number | undefined;

const fileChunks = (w: FilesWorld, record: string, version: number) =>
  rows(
    w,
    `SELECT chunk_id FROM file_chunks WHERE record_id = '${record}' AND version = ${version} ORDER BY chunk_id`,
  ).map((r) => r.chunk_id);

describe("finalize in chunks mode", () => {
  it("makes the manifest the record's file, references each chunk once and charges manifest plus chunks", async () => {
    const w = await filesWorld();
    const manifest = manifestOf(1, 200);
    const a = chunkOf(1, 1000);
    const b = chunkOf(2, 3000);
    const { uploadId, done } = await writeChunked(
      w,
      "delta",
      "slot",
      manifest,
      [a, b],
    );
    expect(done).toEqual({
      version: expect.any(Number),
      size: manifest.length,
      sha256: sha256Hex(manifest),
      format: "chunks",
    });
    expect(refsOf(w, a)).toBe(1);
    expect(refsOf(w, b)).toBe(1);
    expect(fileChunks(w, "slot", done.version)).toEqual([a.id, b.id].sort());
    // The pins are gone and the reservation became the charge.
    expect(rows(w, "SELECT * FROM upload_chunks")).toEqual([]);
    const u = usage(w);
    expect(u.reserved_bytes ?? 0).toBe(0);
    expect(u.file_bytes).toBe(
      manifest.length + a.object.length + b.object.length,
    );
    expect(u.files).toBe(1);
    expect(Number(uploadRow(w, uploadId)!.reserved_bytes)).toBe(0);
    expect(uploadRow(w, uploadId)!.state).toBe("done");
  });

  it("serves the manifest as the record's file", async () => {
    const w = await filesWorld();
    const manifest = manifestOf(3, 300);
    await writeChunked(w, "delta", "slot", manifest, [chunkOf(1)]);
    const res = await call(
      w,
      "GET",
      filesPath("delta", "slot", "").replace(/\/$/, ""),
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(manifest);
  });

  it("is 409 upload_incomplete with the chunk ids still missing, then the manifest as part 1, and completes once they are sent", async () => {
    const w = await filesWorld();
    const manifest = manifestOf();
    const a = chunkOf(1);
    const b = chunkOf(2);
    const up = await beginChunks(w, "delta", "slot", manifest);
    await planned(w, "delta", "slot", up.uploadId, [a, b]);
    expect((await putChunk(w, "delta", "slot", up.uploadId, a)).status).toBe(
      204,
    );
    const first = await finalize(w, "delta", "slot", up.uploadId);
    expect(first.status).toBe(409);
    expect(await errorCode(first.clone())).toBe("upload_incomplete");
    expect(((await first.json()) as { missing: unknown }).missing).toEqual([
      b.id,
    ]);
    expect((await putChunk(w, "delta", "slot", up.uploadId, b)).status).toBe(
      204,
    );
    const second = await finalize(w, "delta", "slot", up.uploadId);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { missing: unknown }).missing).toEqual([
      1,
    ]);
    expect(
      (await putManifest(w, "delta", "slot", up.uploadId, manifest)).status,
    ).toBe(204);
    expect((await finalize(w, "delta", "slot", up.uploadId)).status).toBe(200);
    expect(refsOf(w, a)).toBe(1);
  });

  it("charges only what changed when a new version shares chunks, and the old version keeps its references", async () => {
    const w = await filesWorld();
    const a = chunkOf(1, 1000);
    const b = chunkOf(2, 2000);
    const c = chunkOf(3, 4000);
    const m1 = manifestOf(1, 200);
    const m2 = manifestOf(2, 210);
    const v1 = (await writeChunked(w, "delta", "slot", m1, [a, b])).done;
    const before = usage(w);
    // Version 2 keeps A and B and adds C: the plan says A and B are present and only C is sent.
    const up = await beginChunks(w, "delta", "slot", m2, {
      baseVersion: v1.version,
    });
    const lists = await planned(w, "delta", "slot", up.uploadId, [a, b, c]);
    expect(lists.present.map((p) => p[0]).sort()).toEqual([a.id, b.id].sort());
    expect(lists.missing).toEqual([c.id]);
    const putsBefore = w.r2.putAttempts.length;
    expect((await putChunk(w, "delta", "slot", up.uploadId, c)).status).toBe(
      204,
    );
    expect(w.r2.putAttempts.length).toBe(putsBefore + 1);
    expect(
      (await putManifest(w, "delta", "slot", up.uploadId, m2)).status,
    ).toBe(204);
    const done = (await (
      await finalize(w, "delta", "slot", up.uploadId)
    ).json()) as FinalizeResponse;
    const after = usage(w);
    // A and B are shared (2 references each), C is new. The new manifest is charged to the live
    // file; the old one stays as a revision (keepRevisions 1).
    expect(refsOf(w, a)).toBe(2);
    expect(refsOf(w, b)).toBe(2);
    expect(refsOf(w, c)).toBe(1);
    expect(after.bytes - before.bytes).toBe(m2.length + c.object.length);
    expect(after.file_bytes - before.file_bytes).toBe(
      m2.length - m1.length + c.object.length,
    );
    expect(after.revision_bytes).toBe(m1.length);
    expect(fileChunks(w, "slot", v1.version)).toEqual([a.id, b.id].sort());
    expect(fileChunks(w, "slot", done.version)).toEqual(
      [a.id, b.id, c.id].sort(),
    );
  });

  it("charges a chunk once however many records name it", async () => {
    const w = await filesWorld();
    const a = chunkOf(1, 1000);
    await writeChunked(w, "delta", "one", manifestOf(1, 150), [a]);
    const mid = usage(w).bytes;
    await writeChunked(w, "delta", "two", manifestOf(2, 151), [a]);
    expect(refsOf(w, a)).toBe(2);
    // Only the second manifest (and its record) is new.
    const second = usage(w).bytes - mid;
    expect(second).toBeLessThan(a.object.length);
    expect(second).toBeGreaterThanOrEqual(151);
  });

  it("two uploads that plan the same missing chunk both finish, and the chunk is charged once", async () => {
    const w = await filesWorld();
    const a = chunkOf(1, 1000);
    const m1 = manifestOf(1, 150);
    const m2 = manifestOf(2, 151);
    const up1 = await beginChunks(w, "delta", "one", m1);
    const up2 = await beginChunks(w, "delta", "two", m2);
    await planned(w, "delta", "one", up1.uploadId, [a]);
    const lists2 = await planned(w, "delta", "two", up2.uploadId, [a]);
    expect(lists2.missing).toEqual([a.id]);
    expect((await putChunk(w, "delta", "one", up1.uploadId, a)).status).toBe(
      204,
    );
    expect((await putChunk(w, "delta", "two", up2.uploadId, a)).status).toBe(
      204,
    );
    expect(
      (await putManifest(w, "delta", "one", up1.uploadId, m1)).status,
    ).toBe(204);
    expect(
      (await putManifest(w, "delta", "two", up2.uploadId, m2)).status,
    ).toBe(204);
    const before = usage(w).bytes;
    expect((await finalize(w, "delta", "one", up1.uploadId)).status).toBe(200);
    const mid = usage(w).bytes;
    expect((await finalize(w, "delta", "two", up2.uploadId)).status).toBe(200);
    expect(refsOf(w, a)).toBe(2);
    // Chunk A is charged by the first finalize and not again by the second.
    expect(mid - before).toBeGreaterThanOrEqual(m1.length + a.object.length);
    expect(usage(w).bytes - mid).toBeLessThan(a.object.length);
    expect(usage(w).reserved_bytes ?? 0).toBe(0);
  });

  it("a repeated finalize replays the answer and charges nothing", async () => {
    const w = await filesWorld();
    const manifest = manifestOf();
    const a = chunkOf(1);
    const { uploadId, done } = await writeChunked(
      w,
      "delta",
      "slot",
      manifest,
      [a],
    );
    const before = usage(w);
    const again = await finalize(w, "delta", "slot", uploadId);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(done);
    expect(usage(w)).toEqual(before);
    expect(refsOf(w, a)).toBe(1);
  });

  it("a record written since begin ends the upload with 409 revision_conflict: no reference is taken, the pins and the reservation go, the chunk waits for the collector", async () => {
    const w = await filesWorld();
    const a = chunkOf(1);
    const manifest = manifestOf();
    // `begin` create-only on a record nobody has yet; then another upload creates it first.
    const up = await beginChunks(w, "delta", "slot", manifest, {
      baseVersion: "*",
    });
    await planned(w, "delta", "slot", up.uploadId, [a]);
    expect((await putChunk(w, "delta", "slot", up.uploadId, a)).status).toBe(
      204,
    );
    expect(
      (await putManifest(w, "delta", "slot", up.uploadId, manifest)).status,
    ).toBe(204);
    await writeChunked(w, "delta", "slot", manifestOf(9, 170), [chunkOf(7)]);
    const res = await finalize(w, "delta", "slot", up.uploadId);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("revision_conflict");
    expect(refsOf(w, a)).toBe(0);
    expect(
      rows(w, `SELECT * FROM upload_chunks WHERE upload_id = '${up.uploadId}'`),
    ).toEqual([]);
    expect(uploadRow(w, up.uploadId)).toMatchObject({
      state: "aborted",
      reserved_bytes: 0,
    });
    expect(usage(w).reserved_bytes ?? 0).toBe(0);
    // The chunk is stored and unreferenced: not charged.
    expect(usage(w).file_bytes).toBe(170 + chunkOf(7).object.length);
  });

  it("keeps the quota honest: a plan that fits the quota finalizes within it, and the reservation is released", async () => {
    const w = await filesWorld();
    const a = chunkOf(1, 3000);
    const manifest = manifestOf(1, 200);
    await setQuota(w, manifest.length + a.object.length + 400);
    const { done } = await writeChunked(w, "delta", "slot", manifest, [a]);
    expect(done.format).toBe("chunks");
    const u = usage(w);
    expect(u.reserved_bytes ?? 0).toBe(0);
    expect(u.bytes).toBeLessThanOrEqual(
      manifest.length + a.object.length + 400,
    );
  });

  it("the manifest is checked like a single file: a wrong digest is refused and finalize does not run", async () => {
    const w = await filesWorld();
    const manifest = manifestOf();
    const up = await beginChunks(w, "delta", "slot", manifest);
    const bad = new Uint8Array(manifest);
    bad[0] = bad[0]! ^ 1;
    const res = await putManifest(w, "delta", "slot", up.uploadId, bad);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("upload_mismatch");
    const fin = await finalize(w, "delta", "slot", up.uploadId);
    expect(fin.status).toBe(409);
  });
});

describe("finalize of a chunks upload whose present chunks lost their last reference after the plan", () => {
  const SIZE = 160;
  /** An open upload for `record` that the plan answered `present` for `chunk` (a file holds it). */
  async function planPresent(w: FilesWorld, record: string, chunk: TestChunk) {
    const manifest = manifestOf(9, SIZE);
    const up = await beginChunks(w, "delta", record, manifest);
    const plan = await planned(w, "delta", record, up.uploadId, [chunk]);
    expect(plan.present).toHaveLength(1);
    expect(
      (await putManifest(w, "delta", record, up.uploadId, manifest)).status,
    ).toBe(204);
    return up;
  }

  it("finalize charges a chunk whose last reference went after the plan only when it fits the quota", async () => {
    const w = await filesWorld();
    const chunks = [1, 2, 3].map((n) => chunkOf(n, 1000));
    const bytes = chunks[0]!.object.length;
    await setQuota(w, 1_000_000);
    const uploads = [];
    for (const [i, c] of chunks.entries()) {
      await writeChunked(w, "delta", `old${i}`, manifestOf(i, SIZE), [c]);
      uploads.push(await planPresent(w, `new${i}`, c));
    }
    // Every file that held a chunk is deleted: the bytes are given back, the open uploads pin them.
    for (const i of chunks.keys()) await deleteRecord(w, "delta", `old${i}`);
    const filler = 2 * bytes + 3 * SIZE;
    await stored(w, "saves", "filler", new Uint8Array(filler).fill(3));
    const quota = filler + 3 * SIZE + bytes + 200;
    await setQuota(w, quota);
    const answers: number[] = [];
    for (const [i, up] of uploads.entries()) {
      const res = await finalize(w, "delta", `new${i}`, up.uploadId);
      answers.push(res.status);
      if (res.status === 403) {
        expect(await errorCode(res)).toBe("quota_exceeded");
        expect(uploadRow(w, up.uploadId)?.state).not.toBe("finalizing");
      }
    }
    expect(answers).toEqual([200, 403, 403]);
    expect(usage(w).bytes).toBeLessThanOrEqual(quota);
    expect(usage(w).reserved_bytes ?? 0).toBe(0);
    await fireAlarm(w);
    const held = w.r2
      .keys()
      .filter((k) => k.includes("/c/"))
      .sort();
    expect(held).toEqual([keyOfChunk(w, "delta", chunks[0]!)]);
  });

  it("finalize of an upload whose present chunks kept their references is not refused near the quota", async () => {
    const w = await filesWorld();
    const c = chunkOf(1, 1000);
    await writeChunked(w, "delta", "old", manifestOf(1, SIZE), [c]);
    const up = await planPresent(w, "new", c);
    // Exactly what is charged now plus the new manifest, and nothing more.
    await setQuota(w, usage(w).bytes + usage(w).reserved_bytes);
    expect((await finalize(w, "delta", "new", up.uploadId)).status).toBe(200);
  });
});
