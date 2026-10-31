/**
 * U-10.8: download and revisions (WIRE-CONTRACT-V5 §13.2, §13.8): `GET …/files/{collection}/{id}`
 * with `?version=`, `Range`/`206` and `If-Range`, and `GET …/{id}/revisions`. Each rule here has a
 * test that fails without it: range bounds, version addressing, isolation, the two limiters.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  BeginFileResponse,
  FileRevisionsResponse,
} from "@polaris-key/protocol/sync";
import { NOW } from "../../seed.js";
import { installDigestStream } from "../../r2Mock.js";
import {
  SLUG,
  becomeBob,
  begin,
  beginBody,
  breakLimiter,
  bytesOf,
  call,
  errorCode,
  filesPath,
  filesWorld,
  finalize,
  meta,
  push,
  putBytes,
  rows,
  setGate,
  sha256Hex,
  spendLimit,
  stored,
  uploadPath,
  type FilesWorld,
} from "./cloudSyncFilesWorld.js";
import { hlc, nextId } from "./cloudSyncAbuseWorld.js";

beforeAll(() => installDigestStream());
afterEach(() => vi.useRealTimers());

const MIB = 1024 * 1024;
const PART = 8 * MIB;

const get = (
  w: FilesWorld,
  collection: string,
  id: string,
  opts: { query?: string; headers?: Record<string, string> } = {},
) =>
  call(
    w,
    "GET",
    `/${SLUG}/sync/files/${collection}/${id}${opts.query ?? ""}`,
    opts.headers ? { headers: opts.headers } : {},
  );

const bodyOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

const rangeOf = (
  w: FilesWorld,
  header: string,
  collection = "saves",
  id = "s1",
) => get(w, collection, id, { headers: { range: header } });

describe("GET …/files/{collection}/{id}", () => {
  it("serves the live file as it was stored, with the download headers", async () => {
    const w = await filesWorld();
    const bytes = bytesOf(50_000);
    const out = await stored(w, "saves", "s1", bytes);
    const res = await get(w, "saves", "s1");
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual(bytes);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": "attachment",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      etag: `"${out.sha256}"`,
      "accept-ranges": "bytes",
      "content-length": "50000",
      "repr-digest": `sha-256=:${Buffer.from(out.sha256, "hex").toString("base64")}:`,
    });
  });

  it("serves an empty file and a multipart file whole", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "empty", new Uint8Array(0));
    const none = await get(w, "saves", "empty");
    expect([none.status, (await bodyOf(none)).length]).toEqual([200, 0]);
    expect(none.headers.get("content-length")).toBe("0");

    // 20 MiB: three parts.
    const big = bytesOf(20 * MIB);
    const res = await begin(w, "big", "m", beginBody(big));
    const up = (await res.json()) as BeginFileResponse;
    for (let n = 1; n <= 3; n++)
      expect(
        (
          await putBytes(
            w,
            `${uploadPath("big", "m", up.uploadId)}/parts/${n}`,
            big.subarray((n - 1) * PART, Math.min(n * PART, big.length)),
          )
        ).status,
      ).toBe(204);
    expect((await finalize(w, "big", "m", up.uploadId)).status).toBe(200);
    const whole = await get(w, "big", "m");
    expect(whole.status).toBe(200);
    expect(await sha256Hex(await bodyOf(whole))).toBe(await sha256Hex(big));
    // A range across a part boundary reads the completed object, not one part.
    const across = await rangeOf(
      w,
      `bytes=${PART - 4}-${PART + 3}`,
      "big",
      "m",
    );
    expect(across.status).toBe(206);
    expect(await bodyOf(across)).toEqual(big.subarray(PART - 4, PART + 4));
  });

  it("404 for a record with no file, a record with only a value, and a missing record", async () => {
    const w = await filesWorld();
    await push(w, [
      {
        mutationId: nextId(),
        target: { record: ["big", "plain"] },
        op: "set",
        value: { n: 1 },
        editedHlc: hlc,
      },
    ]);
    for (const id of ["plain", "ghost"]) {
      const res = await get(w, "big", id);
      expect(res.status).toBe(404);
    }
  });

  it("answers nothing without a device token, and 404 while the launch gate is off", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(100));
    const anon = await call(
      w,
      "GET",
      filesPath("saves", "s1", "").slice(0, -1),
      {
        anonymous: true,
      },
    );
    expect(anon.status).toBe(401);
    setGate(w, "off");
    expect((await get(w, "saves", "s1")).status).toBe(404);
    expect(
      (await call(w, "GET", filesPath("saves", "s1", "revisions"))).status,
    ).toBe(404);
  });

  it("only GET: another method on the route is 405", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(100));
    for (const method of ["POST", "DELETE"] as const)
      expect(
        (await call(w, method, filesPath("saves", "s1", "").slice(0, -1)))
          .status,
      ).toBe(405);
  });
});

describe("Range", () => {
  const FILE = bytesOf(1000);
  const setup = async () => {
    const w = await filesWorld();
    const out = await stored(w, "saves", "s1", FILE);
    return { w, out };
  };

  it("bytes=a-b is 206 with Content-Range, a length, and the whole file's ETag and Repr-Digest", async () => {
    const { w, out } = await setup();
    const res = await rangeOf(w, "bytes=10-19");
    expect(res.status).toBe(206);
    expect(await bodyOf(res)).toEqual(FILE.subarray(10, 20));
    expect(res.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("etag")).toBe(`"${out.sha256}"`);
    expect(res.headers.get("repr-digest")).toContain("sha-256=:");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("an open-ended range and a suffix range read the tail", async () => {
    const { w } = await setup();
    const open = await rangeOf(w, "bytes=990-");
    expect(await bodyOf(open)).toEqual(FILE.subarray(990));
    expect(open.headers.get("content-range")).toBe("bytes 990-999/1000");
    const suffix = await rangeOf(w, "bytes=-5");
    expect(await bodyOf(suffix)).toEqual(FILE.subarray(995));
    expect(suffix.headers.get("content-range")).toBe("bytes 995-999/1000");
  });

  it("an end past the file and a suffix longer than it are clamped to the file", async () => {
    const { w } = await setup();
    const past = await rangeOf(w, "bytes=900-99999999999");
    expect(past.status).toBe(206);
    expect(await bodyOf(past)).toEqual(FILE.subarray(900));
    expect(past.headers.get("content-range")).toBe("bytes 900-999/1000");
    const long = await rangeOf(w, "bytes=-5000");
    expect(long.status).toBe(206);
    expect(await bodyOf(long)).toEqual(FILE);
    expect(long.headers.get("content-range")).toBe("bytes 0-999/1000");
  });

  it("a start at or past the end is 416 with Content-Range */size and no body", async () => {
    const { w } = await setup();
    for (const header of [
      "bytes=1000-",
      "bytes=1000-1005",
      "bytes=5000-",
      "bytes=-0",
    ]) {
      const res = await rangeOf(w, header);
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */1000");
      expect((await bodyOf(res)).length).toBe(0);
      expect(res.headers.get("content-disposition")).toBeNull();
    }
  });

  it("any range of an empty file is 416", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", new Uint8Array(0));
    for (const header of ["bytes=0-", "bytes=-1", "bytes=0-0"])
      expect((await rangeOf(w, header)).status).toBe(416);
  });

  it("a malformed, inverted, multiple or non-bytes range is ignored: the whole file", async () => {
    const { w } = await setup();
    for (const header of [
      "bytes=5-2",
      "bytes=0-1,5-6",
      "bytes=-",
      "bytes=abc",
      "items=0-1",
      "bytes=0-1-2",
    ]) {
      const res = await rangeOf(w, header);
      expect([header, res.status]).toEqual([header, 200]);
      expect(await bodyOf(res)).toEqual(FILE);
      expect(res.headers.get("content-range")).toBeNull();
    }
  });

  it("If-Range: the file's strong ETag keeps the range; any other validator serves the whole file", async () => {
    const { w, out } = await setup();
    const etag = `"${out.sha256}"`;
    const kept = await get(w, "saves", "s1", {
      headers: { range: "bytes=0-9", "if-range": etag },
    });
    expect(kept.status).toBe(206);
    for (const validator of [
      `"${"0".repeat(64)}"`,
      `W/${etag}`,
      "Wed, 21 Oct 2015 07:28:00 GMT",
    ]) {
      const res = await get(w, "saves", "s1", {
        headers: { range: "bytes=0-9", "if-range": validator },
      });
      expect([validator, res.status]).toEqual([validator, 200]);
      expect((await bodyOf(res)).length).toBe(1000);
    }
  });
});

describe("?version= and revisions", () => {
  /** Three versions of one record: the first two are kept, the third is live. */
  async function threeVersions() {
    const w = await filesWorld();
    const a = bytesOf(100, 1);
    const b = bytesOf(200, 2);
    const c = bytesOf(300, 3);
    const v1 = await stored(w, "saves", "s1", a);
    const v2 = await stored(w, "saves", "s1", b);
    const v3 = await stored(w, "saves", "s1", c);
    return { w, files: [a, b, c], v: [v1, v2, v3] };
  }

  it("?version= reads a kept version, or the live one by its number", async () => {
    const { w, files, v } = await threeVersions();
    for (const i of [0, 1, 2]) {
      const res = await get(w, "saves", "s1", {
        query: `?version=${v[i]!.version}`,
      });
      expect(res.status).toBe(200);
      expect(await bodyOf(res)).toEqual(files[i]);
      expect(res.headers.get("etag")).toBe(`"${v[i]!.sha256}"`);
    }
    // No version: the live one.
    expect(await bodyOf(await get(w, "saves", "s1"))).toEqual(files[2]);
  });

  it("a version the record does not keep, or another record's, is 404", async () => {
    const { w, v } = await threeVersions();
    await stored(w, "saves", "other", bytesOf(10, 9));
    for (const version of [v[2]!.version + 1, v[2]!.version + 1000]) {
      const res = await get(w, "saves", "s1", { query: `?version=${version}` });
      expect([version, res.status]).toEqual([version, 404]);
    }
    // A version number that is real, but belongs to a file of another record.
    const otherVersion = (
      rows(w, "SELECT version FROM files WHERE record_id = 'other'")[0] as {
        version: number;
      }
    ).version;
    expect(
      (await get(w, "saves", "s1", { query: `?version=${otherVersion}` }))
        .status,
    ).toBe(404);
    expect(
      (await get(w, "saves", "other", { query: `?version=${v[0]!.version}` }))
        .status,
    ).toBe(404);
    // The same number in another collection is another record.
    expect(
      (await get(w, "big", "s1", { query: `?version=${v[0]!.version}` }))
        .status,
    ).toBe(404);
  });

  it("a malformed ?version= is 400 bad_request", async () => {
    const { w } = await threeVersions();
    for (const query of [
      "?version=abc",
      "?version=0",
      "?version=-1",
      "?version=1.5",
      "?version=",
      "?version=1e3",
      "?version=99999999999999999999",
    ]) {
      const res = await get(w, "saves", "s1", { query });
      expect([query, res.status, await errorCode(res)]).toEqual([
        query,
        400,
        "bad_request",
      ]);
    }
  });

  it("revisions lists the kept older versions, newest first, and not the live file", async () => {
    const { w, files, v } = await threeVersions();
    const res = await call(w, "GET", filesPath("saves", "s1", "revisions"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as FileRevisionsResponse;
    expect(body.revisions).toEqual([
      {
        version: v[1]!.version,
        size: files[1]!.length,
        sha256: v[1]!.sha256,
        format: "whole",
        createdAt: expect.any(Number),
      },
      {
        version: v[0]!.version,
        size: files[0]!.length,
        sha256: v[0]!.sha256,
        format: "whole",
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("revisions is an empty list for a record with a single file or none", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(10));
    for (const id of ["s1", "ghost"])
      expect(
        await (
          await call(w, "GET", filesPath("saves", id, "revisions"))
        ).json(),
      ).toEqual({ revisions: [] });
  });

  it("revisions: another method is 405", async () => {
    const w = await filesWorld();
    expect(
      (await call(w, "POST", filesPath("saves", "s1", "revisions"))).status,
    ).toBe(405);
  });
});

describe("isolation", () => {
  it("another person's device reads nothing of the first person's files or revisions", async () => {
    const w = await filesWorld();
    const out = await stored(w, "saves", "s1", bytesOf(100));
    await stored(w, "saves", "s1", bytesOf(100, 5));
    await becomeBob(w);
    expect((await get(w, "saves", "s1")).status).toBe(404);
    expect(
      (await get(w, "saves", "s1", { query: `?version=${out.version}` }))
        .status,
    ).toBe(404);
    expect(
      await (
        await call(w, "GET", filesPath("saves", "s1", "revisions"))
      ).json(),
    ).toEqual({ revisions: [] });
  });

  it("a record id or collection that is not in the key charset is no route", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(10));
    for (const path of [
      `/${SLUG}/sync/files/saves/..%2Fs1`,
      `/${SLUG}/sync/files/saves/s1%2Frevisions`,
      `/${SLUG}/sync/files/u%2Fdjdl/s1`,
    ])
      expect((await call(w, "GET", path)).status).toBe(404);
  });

  it("the R2 key is never read from the request: the stored object of another upload is not reachable by a path", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(10, 1));
    const key = w.r2.keys()[0] as string;
    for (const id of [key, encodeURIComponent(key)])
      expect((await get(w, "saves", id)).status).toBe(404);
  });
});

describe("the limits", () => {
  it("a whole-file GET is one of 30 transfers an hour: the 31st is 429, and costs the object nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(100));
    // The `begin` of `stored` took one of the 30; 28 more leave exactly one transfer.
    await spendLimit(w, "syncFilesDevice", 28, 30, 3600);
    expect((await get(w, "saves", "s1")).status).toBe(200);
    const calls = w.ns.calls.length;
    const res = await get(w, "saves", "s1");
    expect([res.status, await errorCode(res)]).toEqual([429, "rate_limited"]);
    expect(res.headers.get("retry-after")).toBe(String(3600 - (NOW % 3600)));
    expect(w.ns.calls.length).toBe(calls);
    // A range that is the whole file is the same transfer, however it is asked for.
    expect((await rangeOf(w, "bytes=0-")).status).toBe(429);
    expect((await rangeOf(w, "bytes=0-99999")).status).toBe(429);
    // A part of the file is a ranged request, charged to the minute's bucket.
    expect((await rangeOf(w, "bytes=0-9")).status).toBe(206);
    // A range that the server ignores is a whole-file transfer too.
    expect((await rangeOf(w, "bytes=0-1,5-6")).status).toBe(429);
  });

  it("a ranged GET is one of 600 requests a minute; the 601st is 429", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(100));
    // The PUT and the finalize of `stored` took two of the 600.
    await spendLimit(w, "syncParts", 598, 600, 60);
    const res = await rangeOf(w, "bytes=0-9");
    expect([res.status, await errorCode(res)]).toEqual([429, "rate_limited"]);
    expect(res.headers.get("retry-after")).toBe(String(60 - (NOW % 60)));
    // The revisions listing is a 600-a-minute request too.
    expect(
      (await call(w, "GET", filesPath("saves", "s1", "revisions"))).status,
    ).toBe(429);
    // The whole-file allowance is a different bucket.
    expect((await get(w, "saves", "s1")).status).toBe(200);
  });

  it("downloads, status and abort proceed when the limiter cannot be read", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(100));
    const open = await begin(w, "saves", "s2", beginBody(10));
    const up = (await open.json()) as { uploadId: string };
    const held = Number(meta(w, "usage_reserved_bytes") ?? 0);
    expect(held).toBeGreaterThan(0);
    breakLimiter(w);
    expect((await get(w, "saves", "s1")).status).toBe(200);
    expect((await rangeOf(w, "bytes=0-9")).status).toBe(206);
    const path = uploadPath("saves", "s2", up.uploadId);
    expect((await call(w, "GET", path)).status).toBe(200);
    expect((await call(w, "DELETE", path)).status).toBe(204);
    expect(Number(meta(w, "usage_reserved_bytes") ?? 0)).toBe(0);
  });

  it("a Range request answered whole because If-Range does not match is one of the 30 transfers an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(100));
    await spendLimit(w, "syncFilesDevice", 28, 30, 3600);
    const stale = (): Promise<Response> =>
      get(w, "saves", "s1", {
        headers: { range: "bytes=0-9", "if-range": '"stale"' },
      });
    const first = await stale();
    expect(first.status).toBe(200);
    expect((await first.arrayBuffer()).byteLength).toBe(100);
    const res = await stale();
    expect([res.status, await errorCode(res)]).toEqual([429, "rate_limited"]);
    // A matching validator is an ordinary range on the minute bucket.
    expect((await rangeOf(w, "bytes=0-9")).status).toBe(206);
  });
});

describe("when the object is wrong", () => {
  it("an object that vanished from R2 is a 500, with no ETag or digest sent for bytes nobody checked", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(100));
    await w.r2.delete(w.r2.keys());
    const res = await get(w, "saves", "s1");
    expect(res.status).toBe(500);
    expect(res.headers.get("etag")).toBeNull();
  });

  it("an object of another length than the row says is a 500", async () => {
    const w = await filesWorld();
    await stored(w, "saves", "s1", bytesOf(100));
    w.r2.tamper(w.r2.keys()[0] as string, bytesOf(60));
    expect((await get(w, "saves", "s1")).status).toBe(500);
  });
});
