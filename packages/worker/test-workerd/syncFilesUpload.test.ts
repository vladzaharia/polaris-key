/// <reference types="@cloudflare/workers-types" />
// ── Cloud Sync's upload path on the real runtime (U-10.6) ────────────────────────────────
//
// The Node lane proves the file routes over `R2Mock` and a SQLite mock. This lane proves what
// those fakes cannot: the real `CloudSyncDO` making R2's control calls (`createMultipartUpload`,
// `abort`, `delete`) under `blockConcurrencyWhile`, and the Worker's streaming helpers against the
// real binding: `hashBody` (a `DigestStream` tap) in front of `fixedLength` (a `FixedLengthStream`)
// into `put` and `uploadPart`. R2 needs the length up front, so the order of the two matters, and
// only workerd shows whether it is right.

import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  callCloudSync,
  cloudSyncObjectName,
} from "../src/services/sync/do/client.js";
import { streamSha256 } from "../src/core/assets/blobs.js";
import { fileObjectKey } from "../src/services/sync/engine/files.js";
import {
  fixedLength,
  hashBody,
} from "../src/services/sync/handlers/fileStream.js";
import { hexEncode } from "../src/platform/bytes.js";
import { D1Db } from "../src/db/d1.js";
import { seedProduct } from "./seed.js";

const R2_LANE = { timeout: 60_000 };
const PRODUCT = "wdf";
const NOW = Date.now();

beforeAll(async () => {
  await seedProduct(env, new D1Db(env.DB), PRODUCT, {
    schemaVersion: 1,
    entries: [],
  });
});

function bucket(): R2Bucket {
  if (!env.SYNC_FILES) throw new Error("SYNC_FILES is not bound");
  return env.SYNC_FILES;
}

function bytesOf(n: number, seed = 7): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 255;
  return out;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hexEncode(await crypto.subtle.digest("SHA-256", bytes));
}

/** A body that arrives in small chunks, as a request body does. */
function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(pos, pos + 8191));
      pos += 8191;
    },
  });
}

const fileBegin = (
  pin: { product: string; subject: string },
  over: { uploadId: string; size: number; mode: "single" | "multipart" },
) =>
  callCloudSync<"fileBegin">(env, pin, {
    op: "fileBegin",
    uploadId: over.uploadId,
    deviceId: "d1",
    collection: "saves",
    recordId: "slot-1",
    request: {
      size: over.size,
      sha256: "ab".repeat(32),
      format: "whole",
      enc: "none",
    },
    mode: over.mode,
    ...(over.mode === "multipart" ? { partBytes: 8 * 1024 * 1024 } : {}),
    maxRecords: 16,
    limits: { quotaBytes: 1_000_000_000 },
    serverNow: NOW,
  });

describe("the upload path under workerd (U-10.6)", () => {
  it(
    "hashes a body on its way into a fixed-length put, and the digest is the bytes'",
    R2_LANE,
    async () => {
      const body = bytesOf(300_000);
      const hashed = hashBody(chunked(body));
      const sha = await sha256Hex(body);
      const obj = await bucket().put(
        "u/t/s/o/stream",
        fixedLength(hashed.stream, body.length),
        { sha256: sha, onlyIf: new Headers({ "If-None-Match": "*" }) },
      );
      expect(obj?.size).toBe(body.length);
      expect(await hashed.digest).toBe(sha);
      await bucket().delete("u/t/s/o/stream");
    },
  );

  it(
    "a body shorter than the length it was declared with is refused by R2, nothing stored",
    R2_LANE,
    async () => {
      const body = bytesOf(1000);
      await expect(
        bucket().put("u/t/s/o/short", fixedLength(chunked(body), 2000), {
          sha256: await sha256Hex(body),
        }),
      ).rejects.toThrow();
      expect(await bucket().head("u/t/s/o/short")).toBeNull();
    },
  );

  it(
    "makes a multipart upload for begin, takes a hashed part, and aborts it",
    R2_LANE,
    async () => {
      const pin = { product: PRODUCT, subject: "sub_multipart" };
      const uploadId = "up_AAAAAAAAAAAAAAAAAAAAAA";
      const begun = await fileBegin(pin, {
        uploadId,
        size: 20 * 1024 * 1024,
        mode: "multipart",
      });
      expect(begun.outcome).toMatchObject({ ok: true, mode: "multipart" });

      const prepared = await callCloudSync<"filePrepare">(env, pin, {
        op: "filePrepare",
        collection: "saves",
        recordId: "slot-1",
        uploadId,
        serverNow: NOW,
      });
      if (!prepared.outcome.ok) throw new Error("not prepared");
      const { key, multipartId } = prepared.outcome;
      expect(key).toBe(fileObjectKey(pin, uploadId));
      expect(multipartId).toEqual(expect.any(String));

      const part = bytesOf(100_000, 3);
      const hashed = hashBody(chunked(part));
      const uploaded = await bucket()
        .resumeMultipartUpload(key, multipartId as string)
        .uploadPart(1, fixedLength(hashed.stream, part.length));
      expect(await hashed.digest).toBe(await sha256Hex(part));
      const recorded = await callCloudSync<"filePart">(env, pin, {
        op: "filePart",
        collection: "saves",
        recordId: "slot-1",
        uploadId,
        n: 1,
        etag: uploaded.etag,
        bytes: part.length,
        serverNow: NOW,
      });
      expect(recorded.outcome).toEqual({ ok: true });
      const status = await callCloudSync<"fileStatus">(env, pin, {
        op: "fileStatus",
        collection: "saves",
        recordId: "slot-1",
        uploadId,
        serverNow: NOW,
      });
      expect(status.outcome).toMatchObject({
        ok: true,
        status: { mode: "multipart", received: [1] },
      });

      // Abort: the multipart upload is aborted in R2 and the reservation released.
      const aborted = await callCloudSync<"fileAbort">(env, pin, {
        op: "fileAbort",
        collection: "saves",
        recordId: "slot-1",
        uploadId,
        serverNow: NOW,
      });
      expect(aborted.outcome).toEqual({ ok: true });
      await expect(
        bucket()
          .resumeMultipartUpload(key, multipartId as string)
          .uploadPart(2, bytesOf(10)),
      ).rejects.toThrow();
      const usage = await callCloudSync<"usage">(env, pin, { op: "usage" });
      expect(usage.usage.reservedBytes ?? 0).toBe(0);
    },
  );

  it("deletes a single upload's object on abort", R2_LANE, async () => {
    const pin = { product: PRODUCT, subject: "sub_single" };
    const uploadId = "up_BBBBBBBBBBBBBBBBBBBBBB";
    await fileBegin(pin, { uploadId, size: 1000, mode: "single" });
    const key = fileObjectKey(pin, uploadId);
    await bucket().put(key, bytesOf(1000));
    expect(await bucket().head(key)).not.toBeNull();
    await callCloudSync<"fileAbort">(env, pin, {
      op: "fileAbort",
      collection: "saves",
      recordId: "slot-1",
      uploadId,
      serverNow: NOW,
    });
    expect(await bucket().head(key)).toBeNull();
  });

  it(
    "finalizes a multipart upload: R2 completes the parts, the object hashes to the declared value, the record moves",
    R2_LANE,
    async () => {
      const pin = { product: PRODUCT, subject: "sub_finalize" };
      const uploadId = "up_CCCCCCCCCCCCCCCCCCCCCC";
      const partBytes = 5 * 1024 * 1024;
      const file = bytesOf(partBytes + 1000, 11);
      const sha = await sha256Hex(file);
      await callCloudSync<"fileBegin">(env, pin, {
        op: "fileBegin",
        uploadId,
        deviceId: "d1",
        collection: "saves",
        recordId: "slot-1",
        request: {
          size: file.length,
          sha256: sha,
          format: "whole",
          enc: "none",
          baseVersion: "*",
        },
        mode: "multipart",
        partBytes,
        maxRecords: 16,
        limits: { quotaBytes: 1_000_000_000 },
        serverNow: NOW,
      });
      const address = {
        collection: "saves",
        recordId: "slot-1",
        uploadId,
        serverNow: NOW,
      };
      const prepared = await callCloudSync<"filePrepare">(env, pin, {
        op: "filePrepare",
        ...address,
      });
      if (!prepared.outcome.ok) throw new Error("not prepared");
      const { key, multipartId } = prepared.outcome;
      const mp = bucket().resumeMultipartUpload(key, multipartId as string);
      for (const [n, body] of [
        [2, file.subarray(partBytes)],
        [1, file.subarray(0, partBytes)],
      ] as const) {
        const hashed = hashBody(chunked(body));
        const part = await mp.uploadPart(
          n,
          fixedLength(hashed.stream, body.length),
        );
        expect(await hashed.digest).toBe(await sha256Hex(body.slice()));
        await callCloudSync<"filePart">(env, pin, {
          op: "filePart",
          ...address,
          n,
          etag: part.etag,
          bytes: body.length,
        });
      }

      // Finalize: complete in R2, hash the stored object, commit.
      const claimed = await callCloudSync<"fileFinalizePrepare">(env, pin, {
        op: "fileFinalizePrepare",
        ...address,
      });
      expect(claimed.outcome).toMatchObject({
        ok: true,
        verify: { key, size: file.length },
      });
      const stored = await bucket().get(key);
      if (!stored) throw new Error("no completed object");
      expect((await streamSha256(stored.body)).sha256).toBe(sha);
      const committed = await callCloudSync<"fileFinalizeCommit">(env, pin, {
        op: "fileFinalizeCommit",
        ...address,
        deviceId: "d1",
        clientId: "c_AAAAAAAAAAAAAAAAAAAAAA",
        maxRecords: 16,
      });
      if (!committed.outcome.ok) throw new Error("not committed");
      expect(committed.outcome.result).toMatchObject({
        size: file.length,
        sha256: sha,
        format: "whole",
      });
      // A repeat is the stored answer, charged once.
      const again = await callCloudSync<"fileFinalizePrepare">(env, pin, {
        op: "fileFinalizePrepare",
        ...address,
      });
      expect(again.outcome).toEqual({
        ok: true,
        replay: committed.outcome.result,
      });

      const stub = env.CLOUD_SYNC.get(
        env.CLOUD_SYNC.idFromName(cloudSyncObjectName(pin)),
      );
      const usage = await runInDurableObject(stub, async (_o, state) => ({
        files: state.storage.sql
          .exec("SELECT status, size FROM files")
          .toArray(),
        records: state.storage.sql
          .exec("SELECT version, value_json FROM records")
          .toArray(),
      }));
      expect(usage.files).toEqual([{ status: "live", size: file.length }]);
      expect(usage.records).toEqual([
        { version: committed.outcome.result.version, value_json: "null" },
      ]);
      const u = await callCloudSync<"usage">(env, pin, { op: "usage" });
      expect(u.usage).toMatchObject({ files: 1, fileBytes: file.length });
      expect(u.usage.reservedBytes ?? 0).toBe(0);
    },
  );
});
