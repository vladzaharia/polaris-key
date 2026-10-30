/**
 * U-10.6: the byte routes (WIRE-CONTRACT-V5 §13.8.1, GF7): `PUT …/upload/{uploadId}` for a single
 * upload and `PUT …/upload/{uploadId}/parts/{n}` for a multipart one. The server streams the bytes
 * and checks only size and SHA-256; each rule here has a test that fails without it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  BeginFileResponse,
  UploadStatus,
} from "@polaris-key/protocol/sync";
import { NOW } from "../../seed.js";
import { installDigestStream } from "../../r2Mock.js";
import { rateLimitOk } from "../../../src/core/rateLimit.js";
import { syncLimiterShard } from "../../../src/services/sync/limits.js";
import { fileObjectKey } from "../../../src/services/sync/engine/files.js";
import {
  SLUG,
  begin,
  beginBody,
  breakLimiter,
  bytesOf,
  call,
  digestHeader,
  errorCode,
  filesWorld,
  meta,
  putBytes,
  setGate,
  uploadPath,
  uploadRow,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";
import { invalidatePlatformSettings } from "../../../src/core/platformSettings.js";

beforeAll(() => installDigestStream());
afterEach(() => vi.useRealTimers());

const MIB = 1024 * 1024;
const PART = 8 * MIB;

const opened = async (
  w: FilesWorld,
  collection: string,
  id: string,
  bytes: Uint8Array,
  over: object = {},
): Promise<BeginFileResponse> => {
  const res = await begin(w, collection, id, beginBody(bytes, over));
  expect(res.status).toBe(200);
  return (await res.json()) as BeginFileResponse;
};

/** The answer is `400 upload_mismatch`. */
const expectMismatch = async (res: Response, what?: string) =>
  expect([res.status, await errorCode(res)], what).toEqual([
    400,
    "upload_mismatch",
  ]);

/** A world with one open single upload of `n` bytes for saves/s1. */
async function single(n: number) {
  const w = await filesWorld();
  const bytes = bytesOf(n);
  const up = await opened(w, "saves", "s1", bytes);
  return { w, bytes, up, path: uploadPath("saves", "s1", up.uploadId) };
}

const keyOf = (w: FilesWorld, uploadId: string) =>
  fileObjectKey({ product: SLUG, subject: w.subject }, uploadId);

const statusOf = async (
  w: FilesWorld,
  collection: string,
  id: string,
  uploadId: string,
): Promise<UploadStatus> => {
  const res = await call(w, "GET", uploadPath(collection, id, uploadId));
  expect(res.status).toBe(200);
  return (await res.json()) as UploadStatus;
};

const partPath = (c: string, id: string, uploadId: string, n: number) =>
  `${uploadPath(c, id, uploadId)}/parts/${n}`;

const bodyOf = async (w: FilesWorld, key: string): Promise<Uint8Array> => {
  const obj = await w.r2.get(key);
  if (!obj || !("arrayBuffer" in obj)) throw new Error(`no object at ${key}`);
  return new Uint8Array(await obj.arrayBuffer());
};

describe("PUT …/upload/{uploadId}: a single upload", () => {
  it("stores the bytes at the session's key, verified, and records part 1", async () => {
    const w = await filesWorld();
    const bytes = bytesOf(100_000);
    const up = await opened(w, "saves", "s1", bytes);
    const res = await putBytes(
      w,
      uploadPath("saves", "s1", up.uploadId),
      bytes,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
    expect(w.r2.keys()).toEqual([keyOf(w, up.uploadId)]);
    expect(await bodyOf(w, keyOf(w, up.uploadId))).toEqual(bytes);
    // The resume answer now shows part 1; nothing else about the session changed.
    expect((await statusOf(w, "saves", "s1", up.uploadId)).received).toEqual([
      1,
    ]);
    expect(uploadRow(w, up.uploadId)?.state).toBe("open");
    // The object holds the hash R2 verified.
    const head = await w.r2.head(keyOf(w, up.uploadId));
    expect(head?.checksums.toJSON().sha256).toBe(
      Buffer.from(
        await crypto.subtle.digest("SHA-256", bytes as BufferSource),
      ).toString("hex"),
    );
  });

  it("an empty file is a single PUT of no bytes", async () => {
    const w = await filesWorld();
    const empty = new Uint8Array(0);
    const up = await opened(w, "saves", "e", empty);
    expect(
      (await putBytes(w, uploadPath("saves", "e", up.uploadId), empty)).status,
    ).toBe(204);
    expect((await w.r2.head(keyOf(w, up.uploadId)))?.size).toBe(0);
  });

  it("refuses a Content-Digest other than the one begin declared, and stores nothing", async () => {
    const { w, bytes, up } = await single(5000);
    const other = bytesOf(5000, 99);
    const res = await putBytes(
      w,
      uploadPath("saves", "s1", up.uploadId),
      bytes,
      { "content-digest": digestHeader(other) },
    );
    await expectMismatch(res);
    expect(w.r2.keys()).toEqual([]);
    expect(w.r2.putAttempts).toEqual([]);
  });

  it("refuses bytes that do not hash to the declared value: R2 rejects them, nothing is stored or recorded", async () => {
    const { w, bytes, up } = await single(5000);
    // The digest header is the declared one, the body is not.
    const res = await putBytes(
      w,
      uploadPath("saves", "s1", up.uploadId),
      bytesOf(5000, 3),
      { "content-digest": digestHeader(bytes) },
    );
    await expectMismatch(res);
    expect(w.r2.keys()).toEqual([]);
    expect((await statusOf(w, "saves", "s1", up.uploadId)).received).toEqual(
      [],
    );
    // The session is still open: the right bytes go through.
    expect(
      (await putBytes(w, uploadPath("saves", "s1", up.uploadId), bytes)).status,
    ).toBe(204);
  });

  it("refuses a length other than the declared size, and a missing length or digest", async () => {
    const { w, bytes, path } = await single(5000);
    for (const over of [
      { "content-length": "4999" },
      { "content-length": "5001" },
      { "content-length": undefined },
      { "content-length": "abc" },
      { "content-digest": undefined },
      { "content-digest": "sha-256=:AAAA:" },
      { "content-digest": "md5=:AAAA:" },
    ])
      expect(
        (await putBytes(w, path, bytes, over)).status,
        JSON.stringify(over),
      ).toBe(400);
    expect(w.r2.putAttempts).toEqual([]);
    // Other members of the header do not matter; the sha-256 one is read.
    expect(
      (
        await putBytes(w, path, bytes, {
          "content-digest": `sha-512=:AAAA:, ${digestHeader(bytes)}`,
        })
      ).status,
    ).toBe(204);
  });

  it("a Content-Length over 16 MiB is 413 body_too_large, before a byte is read", async () => {
    const w = await filesWorld();
    const up = await opened(w, "saves", "s1", bytesOf(100));
    const res = await putBytes(
      w,
      uploadPath("saves", "s1", up.uploadId),
      bytesOf(100),
      { "content-length": String(16 * MIB + 1) },
    );
    expect([res.status, await errorCode(res)]).toEqual([413, "body_too_large"]);
    expect(w.r2.putAttempts).toEqual([]);
  });

  it("a resend is 204 and the stored object is the first one, never replaced", async () => {
    const { w, bytes, up, path } = await single(5000);
    expect((await putBytes(w, path, bytes)).status).toBe(204);
    const etag = (await w.r2.head(keyOf(w, up.uploadId)))?.etag;
    expect((await putBytes(w, path, bytes)).status).toBe(204);
    expect((await w.r2.head(keyOf(w, up.uploadId)))?.etag).toBe(etag);
    // Other bytes under the declared digest meet the object that is already there: the write is
    // create-only, so the verified object stands and is what the 204 speaks of.
    expect(
      (
        await putBytes(w, path, bytesOf(5000, 3), {
          "content-digest": digestHeader(bytes),
        })
      ).status,
    ).toBe(204);
    expect(await bodyOf(w, keyOf(w, up.uploadId))).toEqual(bytes);
    expect((await w.r2.head(keyOf(w, up.uploadId)))?.etag).toBe(etag);
  });

  it("an object that is there but is not the declared one is never accepted", async () => {
    const { w, bytes, up } = await single(5000);
    // Something else sits at the key (it cannot, but the check does not rely on that).
    w.r2.seed(keyOf(w, up.uploadId), bytesOf(5000, 3), { withSha256: true });
    const res = await putBytes(
      w,
      uploadPath("saves", "s1", up.uploadId),
      bytes,
    );
    await expectMismatch(res);
    expect((await statusOf(w, "saves", "s1", up.uploadId)).received).toEqual(
      [],
    );
  });

  it("is 404 for a session that is unknown, another record's or ended, and 410 once expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const { w, bytes, up } = await single(100);
    const ghost = "up_AAAAAAAAAAAAAAAAAAAAAA";
    for (const path of [
      uploadPath("saves", "s1", ghost),
      uploadPath("saves", "other", up.uploadId),
      uploadPath("big", "s1", up.uploadId),
    ])
      expect((await putBytes(w, path, bytes)).status, path).toBe(404);
    expect(w.r2.putAttempts).toEqual([]);
    // Expired: 410, the session is collected and the reservation freed.
    vi.setSystemTime((NOW + 86_400) * 1000);
    const late = await putBytes(
      w,
      uploadPath("saves", "s1", up.uploadId),
      bytes,
    );
    expect([late.status, await errorCode(late)]).toEqual([
      410,
      "upload_expired",
    ]);
    expect(w.r2.keys()).toEqual([]);
    expect(Number(meta(w, "usage_reserved_bytes") ?? 0)).toBe(0);
    expect(
      (await putBytes(w, uploadPath("saves", "s1", up.uploadId), bytes)).status,
    ).toBe(404);
  });

  it("an upload that ended takes no bytes", async () => {
    const { w, bytes, path } = await single(100);
    await call(w, "DELETE", path);
    expect((await putBytes(w, path, bytes)).status).toBe(404);
    expect(w.r2.keys()).toEqual([]);
  });

  it("the session closing while the bytes are on their way leaves no object behind", async () => {
    const { w, bytes, path } = await single(1000);
    const real = w.r2.put.bind(w.r2);
    w.r2.put = async (...args: Parameters<typeof real>) => {
      await call(w, "DELETE", path);
      return real(...args);
    };
    const res = await putBytes(w, path, bytes);
    expect(res.status).toBe(404);
    expect(w.r2.keys()).toEqual([]);
  });

  it("a part route on a single session is a mismatch", async () => {
    const { w, bytes, up } = await single(100);
    const res = await putBytes(
      w,
      partPath("saves", "s1", up.uploadId, 1),
      bytes,
    );
    await expectMismatch(res);
  });

  it("R2 failing for another reason than the bytes is retryable, not a mismatch", async () => {
    const { w, bytes, up } = await single(100);
    w.r2.put = () => Promise.reject(new Error("R2 is down"));
    w.r2.head = () => Promise.reject(new Error("R2 is down"));
    const res = await putBytes(
      w,
      uploadPath("saves", "s1", up.uploadId),
      bytes,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

describe("PUT …/upload/{uploadId}/parts/{n}: a multipart upload", () => {
  // 20 MiB: parts of 8, 8 and 4 MiB.
  const FILE = bytesOf(20 * MIB);
  const part = (n: number) =>
    FILE.subarray((n - 1) * PART, Math.min(n * PART, FILE.length));

  it("takes parts in any order, and a resent part replaces its earlier copy", async () => {
    const w = await filesWorld();
    const up = await opened(w, "big", "m", FILE);
    expect(up).toMatchObject({ mode: "multipart", partBytes: PART });
    const path = (n: number) => partPath("big", "m", up.uploadId, n);
    for (const n of [3, 1, 2])
      expect((await putBytes(w, path(n), part(n))).status, `part ${n}`).toBe(
        204,
      );
    expect((await statusOf(w, "big", "m", up.uploadId)).received).toEqual([
      1, 2, 3,
    ]);
    const before = uploadRow(w, up.uploadId);
    // Resent: still three parts, the newest etag is the one kept.
    const etags = () =>
      (
        w.ns.instances
          .get(`${SLUG}:${w.subject}`)!
          .storage.sql.db.prepare("SELECT n, etag FROM upload_parts ORDER BY n")
          .all() as { n: number; etag: string }[]
      ).map((r) => r.etag);
    const first = etags();
    expect((await putBytes(w, path(2), part(2))).status).toBe(204);
    const second = etags();
    expect(second).toHaveLength(3);
    expect(second[1]).not.toBe(first[1]);
    expect(second[0]).toBe(first[0]);
    // The session is still open, with its multipart upload unfinished in R2.
    expect(uploadRow(w, up.uploadId)).toEqual(before);
    expect(w.r2.openUploads()).toBe(1);
  });

  it("a part whose bytes do not match its Content-Digest is refused and forgotten, even a good one it replaced", async () => {
    const w = await filesWorld();
    const up = await opened(w, "big", "m", FILE);
    const path = partPath("big", "m", up.uploadId, 1);
    expect((await putBytes(w, path, part(1))).status).toBe(204);
    expect((await statusOf(w, "big", "m", up.uploadId)).received).toEqual([1]);
    // A resend whose digest header is not its bytes' (R2 may now hold these bytes as part 1).
    const bad = await putBytes(w, path, bytesOf(PART, 5), {
      "content-digest": digestHeader(part(1)),
    });
    await expectMismatch(bad);
    // Part 1 counts as missing again, so finalize can never complete over a replaced part.
    expect((await statusOf(w, "big", "m", up.uploadId)).received).toEqual([]);
    expect((await putBytes(w, path, part(1))).status).toBe(204);
    expect((await statusOf(w, "big", "m", up.uploadId)).received).toEqual([1]);
  });

  it("refuses a part number outside 1…⌈size / partBytes⌉", async () => {
    const w = await filesWorld();
    const up = await opened(w, "big", "m", FILE);
    for (const n of [0, 4, 99, 123456789]) {
      const res = await putBytes(
        w,
        partPath("big", "m", up.uploadId, n),
        part(1),
      );
      await expectMismatch(res, `part ${n}`);
    }
    expect(w.r2.putAttempts).toEqual([]);
    // Not a number at all is no route.
    expect(
      (
        await putBytes(
          w,
          `${uploadPath("big", "m", up.uploadId)}/parts/x`,
          part(1),
        )
      ).status,
    ).toBe(404);
  });

  it("refuses a part of the wrong length: every part but the last is partBytes, the last is the rest", async () => {
    const w = await filesWorld();
    const up = await opened(w, "big", "m", FILE);
    const send = (n: number, bytes: Uint8Array) =>
      putBytes(w, partPath("big", "m", up.uploadId, n), bytes);
    for (const [n, bytes] of [
      [1, part(1).subarray(0, PART - 1)],
      [1, FILE.subarray(0, PART + 1)],
      [3, part(3).subarray(0, 4 * MIB - 1)],
      [3, FILE.subarray(0, PART)],
    ] as const) {
      const res = await send(n, bytes);
      await expectMismatch(res, `part ${n}`);
    }
    expect(w.r2.putAttempts).toEqual([]);
    expect((await send(3, part(3))).status).toBe(204);
  });

  it("refuses a part with no Content-Digest or no Content-Length", async () => {
    const w = await filesWorld();
    const up = await opened(w, "big", "m", FILE);
    const path = partPath("big", "m", up.uploadId, 1);
    for (const over of [
      { "content-digest": undefined },
      { "content-length": undefined },
      { "content-digest": "sha-256=:short:" },
    ]) {
      const res = await putBytes(w, path, part(1), over);
      await expectMismatch(res);
    }
    expect((await statusOf(w, "big", "m", up.uploadId)).received).toEqual([]);
  });

  it("a single-PUT route on a multipart session is a mismatch", async () => {
    const w = await filesWorld();
    const up = await opened(w, "big", "m", FILE);
    const res = await putBytes(w, uploadPath("big", "m", up.uploadId), part(1));
    await expectMismatch(res);
  });

  it("is 404 for a part of an ended session, and R2's multipart is gone with it", async () => {
    const w = await filesWorld();
    const up = await opened(w, "big", "m", FILE);
    await call(w, "DELETE", uploadPath("big", "m", up.uploadId));
    expect(
      (await putBytes(w, partPath("big", "m", up.uploadId, 1), part(1))).status,
    ).toBe(404);
    expect(w.r2.openUploads()).toBe(0);
  });
});

describe("the byte routes' front door", () => {
  it("answers 404 with the gate off, 401 with no bearer, and 503 with writes paused", async () => {
    const { w, bytes, path } = await single(100);
    const anon = await call(w, "PUT", path, {
      bytes,
      anonymous: true,
      headers: {
        "content-length": "100",
        "content-digest": digestHeader(bytes),
      },
    });
    expect(anon.status).toBe(401);
    await w.db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('cloudSync.writesPaused', '"on"', 1, ?, 'test')`,
      NOW,
    );
    invalidatePlatformSettings(w.env, w.db);
    const paused = await putBytes(w, path, bytes);
    expect([paused.status, await errorCode(paused)]).toEqual([
      503,
      "writes_paused",
    ]);
    expect(paused.headers.get("retry-after")).toBe("300");
    await w.db.run("DELETE FROM platform_settings");
    invalidatePlatformSettings(w.env, w.db);
    setGate(w, "off");
    expect((await putBytes(w, path, bytes)).status).toBe(404);
    expect(w.r2.putAttempts).toEqual([]);
  });

  it("600 byte requests a minute per device; the 601st is 429 and costs the object nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const { w, bytes, up } = await single(100);
    const shard = syncLimiterShard(SLUG, w.subject);
    for (let i = 0; i < 600; i++)
      expect(
        await rateLimitOk(
          w.env,
          shard,
          {
            bucket: "syncParts",
            id: "dev-attack-1",
            limit: 600,
            windowSec: 60,
          },
          NOW,
        ),
      ).toBe(true);
    const calls = w.ns.calls.length;
    const res = await putBytes(
      w,
      uploadPath("saves", "s1", up.uploadId),
      bytes,
    );
    expect([res.status, await errorCode(res)]).toEqual([429, "rate_limited"]);
    expect(res.headers.get("retry-after")).toBe(String(60 - (NOW % 60)));
    expect(w.ns.calls.length).toBe(calls);
    vi.setSystemTime((NOW + 60) * 1000);
    expect(
      (await putBytes(w, uploadPath("saves", "s1", up.uploadId), bytes)).status,
    ).toBe(204);
  });

  it("limiter down: it fails open", async () => {
    const { w, bytes, up } = await single(100);
    breakLimiter(w);
    expect(
      (await putBytes(w, uploadPath("saves", "s1", up.uploadId), bytes)).status,
    ).toBe(204);
  });
});
