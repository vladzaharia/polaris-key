import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BLOB_CSP,
  BYTES_HOST_TYPES,
  BlobKeyError,
  blobKey,
  blobResponse,
  bundleKey,
  deltaKey,
  hasRef,
  isStored,
  parseKey,
  parseRange,
  promote,
  putVerified,
  recordObject,
  recordRef,
  referencedKeys,
  reprDigest,
  stagingKey,
  storedKeys,
  streamSha256,
  verifyStaged,
} from "../src/core/blobs.js";
import type { Db } from "../src/db/types.js";
import { makeTestDb } from "./helpers.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import { NOW, seedProduct } from "./seed.js";

beforeAll(() => installDigestStream());

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesOf(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

const BODY = bytesOf(100_000);
const HEX = sha(BODY);
const OTHER = bytesOf(100_000, 2);

// ── Key builders ────────────────────────────────────────────────────────────────────────────

describe("key layout", () => {
  const h2 = "b".repeat(64);
  it("builds the README §3.5 layout verbatim, with gated/ as a prefix", () => {
    expect(blobKey(HEX)).toBe(`blobs/sha256/${HEX}`);
    expect(bundleKey(HEX)).toBe(`bundles/sha256/${HEX}`);
    expect(deltaKey(HEX, h2, "bsdiff")).toBe(`deltas/${HEX}/${h2}.bsdiff`);
    expect(blobKey(HEX, { gated: true })).toBe(`gated/blobs/sha256/${HEX}`);
    expect(bundleKey(HEX, { gated: true })).toBe(`gated/bundles/sha256/${HEX}`);
    expect(deltaKey(HEX, h2, "hdiffpatch", { gated: true })).toBe(
      `gated/deltas/${HEX}/${h2}.hdiffpatch`,
    );
    expect(stagingKey("djdl", "tkt_01", HEX)).toBe(
      `staging/djdl/tkt_01/${HEX}`,
    );
  });

  it("refuses uppercase, short, or non-hex hashes and path-shaped parts", () => {
    expect(() => blobKey(HEX.toUpperCase())).toThrow(BlobKeyError);
    expect(() => blobKey("abc")).toThrow(BlobKeyError);
    expect(() => blobKey("g".repeat(64))).toThrow(BlobKeyError);
    expect(() => deltaKey(HEX, h2, "../x")).toThrow(BlobKeyError);
    expect(() => stagingKey("../djdl", "t", HEX)).toThrow(BlobKeyError);
    expect(() => stagingKey("djdl", "a/b", HEX)).toThrow(BlobKeyError);
  });

  it("parses every builder's output back, and nothing outside the layout", () => {
    expect(parseKey(blobKey(HEX, { gated: true }))).toEqual({
      area: "locked",
      kind: "blob",
      gated: true,
      sha256: HEX,
    });
    expect(parseKey(deltaKey(HEX, h2, "bsdiff"))).toMatchObject({
      kind: "delta",
      fromSha256: HEX,
      toSha256: h2,
      method: "bsdiff",
      gated: false,
    });
    expect(parseKey(stagingKey("djdl", "t1", HEX))).toEqual({
      area: "staging",
      product: "djdl",
      ticketId: "t1",
      sha256: HEX,
    });
    for (const bad of [
      `blobs/sha256/${HEX}/x`,
      `blobs/sha1/${HEX}`,
      `gated/staging/djdl/t/${HEX}`,
      `other/${HEX}`,
      "",
    ])
      expect(parseKey(bad)).toBeNull();
  });

  it("encodes Repr-Digest as an RFC 9530 byte sequence of the raw digest", () => {
    const b64 = createHash("sha256").update(BODY).digest("base64");
    expect(reprDigest(HEX)).toBe(`sha-256=:${b64}:`);
  });
});

// ── putVerified ─────────────────────────────────────────────────────────────────────────────

describe("putVerified", () => {
  let r2: R2Mock;
  beforeEach(() => {
    r2 = new R2Mock();
  });

  it("stores bytes that hash to the key's name, with R2's checksum recorded", async () => {
    const res = await putVerified(asR2(r2), blobKey(HEX), BODY, {
      sha256: HEX,
      size: BODY.length,
    });
    expect(res.ok).toBe(true);
    const head = await r2.head(blobKey(HEX));
    expect(Buffer.from(head!.checksums.sha256!).toString("hex")).toBe(HEX);
  });

  it("refuses a put whose bytes do not match the key's hash — nothing is stored", async () => {
    const res = await putVerified(asR2(r2), blobKey(HEX), OTHER, {
      sha256: HEX,
      size: OTHER.length,
    });
    expect(res).toMatchObject({ ok: false, reason: "rejected" });
    expect(r2.has(blobKey(HEX))).toBe(false);
  });

  it("refuses a claimed hash that is not the one the key is named by", async () => {
    const res = await putVerified(asR2(r2), blobKey(HEX), OTHER, {
      sha256: sha(OTHER),
      size: OTHER.length,
    });
    expect(res).toMatchObject({ ok: false, reason: "key_mismatch" });
    expect(r2.putAttempts).toEqual([]);
  });

  it("refuses keys outside the layout and buffers of the wrong size", async () => {
    expect(
      await putVerified(asR2(r2), "elsewhere/x", BODY, {
        sha256: HEX,
        size: BODY.length,
      }),
    ).toMatchObject({ ok: false, reason: "key_mismatch" });
    expect(
      await putVerified(asR2(r2), blobKey(HEX), BODY, {
        sha256: HEX,
        size: BODY.length + 1,
      }),
    ).toMatchObject({ ok: false, reason: "size_mismatch" });
    expect(r2.putAttempts).toEqual([]);
  });

  it("refuses a second put to an existing key and keeps the first object", async () => {
    const first = await putVerified(asR2(r2), blobKey(HEX), BODY, {
      sha256: HEX,
      size: BODY.length,
    });
    const etag = first.ok ? first.object.etag : "";
    const second = await putVerified(asR2(r2), blobKey(HEX), BODY, {
      sha256: HEX,
      size: BODY.length,
    });
    expect(second).toEqual({ ok: false, reason: "exists" });
    expect((await r2.head(blobKey(HEX)))!.etag).toBe(etag);
  });

  it("accepts a stream body", async () => {
    const res = await putVerified(
      asR2(r2),
      blobKey(HEX),
      new Blob([BODY]).stream(),
      { sha256: HEX, size: BODY.length },
    );
    expect(res.ok).toBe(true);
  });
});

// ── verifyStaged ────────────────────────────────────────────────────────────────────────────

describe("verifyStaged", () => {
  const key = stagingKey("djdl", "t1", HEX);
  let r2: R2Mock;
  beforeEach(() => {
    r2 = new R2Mock();
  });

  it("accepts R2's stored checksum without reading the body", async () => {
    r2.seed(key, BODY, { withSha256: true });
    const res = await verifyStaged(asR2(r2), key, {
      sha256: HEX,
      size: BODY.length,
    });
    expect(res).toMatchObject({ ok: true, method: "stored-checksum" });
  });

  it("refuses when the stored checksum is a different hash", async () => {
    r2.seed(key, OTHER, { withSha256: true });
    expect(
      await verifyStaged(asR2(r2), key, { sha256: HEX, size: OTHER.length }),
    ).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  it("falls back to a streamed hash when R2 holds no SHA-256", async () => {
    r2.seed(key, BODY);
    expect((await r2.head(key))!.checksums.sha256).toBeUndefined();
    const res = await verifyStaged(asR2(r2), key, {
      sha256: HEX,
      size: BODY.length,
    });
    expect(res).toMatchObject({ ok: true, method: "streamed" });
  });

  it("the streamed fallback refuses bytes that do not match", async () => {
    r2.seed(key, OTHER);
    expect(
      await verifyStaged(asR2(r2), key, { sha256: HEX, size: OTHER.length }),
    ).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  it("refuses a missing object and a size mismatch", async () => {
    expect(
      await verifyStaged(asR2(r2), key, { sha256: HEX, size: BODY.length }),
    ).toEqual({ ok: false, reason: "missing" });
    r2.seed(key, BODY);
    expect(
      await verifyStaged(asR2(r2), key, { sha256: HEX, size: BODY.length - 1 }),
    ).toEqual({ ok: false, reason: "size_mismatch" });
  });

  it("streamSha256 hashes a multi-chunk stream correctly", async () => {
    const big = bytesOf(3 * 1024 * 1024 + 17, 9);
    const got = await streamSha256(new Blob([big]).stream());
    expect(got).toEqual({ sha256: sha(big), bytes: big.length });
  });
});

// ── promote + D1 ────────────────────────────────────────────────────────────────────────────

describe("promote and the blob tables", () => {
  const from = stagingKey("djdl", "t1", HEX);
  const to = blobKey(HEX);
  const expected = { sha256: HEX, size: BODY.length };
  let r2: R2Mock;
  let db: Db;
  beforeEach(async () => {
    r2 = new R2Mock();
    db = makeTestDb();
    await seedProduct(db, "djdl");
    await seedProduct(db, "other");
  });

  it("verifies, copies, then records a blob_objects row", async () => {
    r2.seed(from, BODY);
    const res = await promote(asR2(r2), from, to, expected, { db, now: NOW });
    expect(res).toMatchObject({ ok: true, key: to, alreadyStored: false });
    expect(r2.has(to)).toBe(true);
    const row = await db.first<Record<string, unknown>>(
      "SELECT * FROM blob_objects WHERE storage_key = ?",
      to,
    );
    expect(row).toMatchObject({
      sha256: HEX,
      size: BODY.length,
      kind: "blob",
      gated: 0,
      verified_at: NOW,
    });
    expect(await isStored(db, to)).toBe(true);
  });

  it("never writes the target, nor a row, when verification fails", async () => {
    r2.seed(from, OTHER);
    const res = await promote(
      asR2(r2),
      from,
      to,
      { sha256: HEX, size: OTHER.length },
      { db, now: NOW },
    );
    expect(res).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(r2.putAttempts).not.toContain(to);
    expect(r2.has(to)).toBe(false);
    expect(await isStored(db, to)).toBe(false);
  });

  it("never writes the target when the staged object is missing or mis-sized", async () => {
    expect(
      await promote(asR2(r2), from, to, expected, { db, now: NOW }),
    ).toEqual({
      ok: false,
      reason: "missing",
    });
    r2.seed(from, BODY);
    expect(
      await promote(
        asR2(r2),
        from,
        to,
        { sha256: HEX, size: 1 },
        { db, now: NOW },
      ),
    ).toEqual({ ok: false, reason: "size_mismatch" });
    expect(r2.putAttempts).toEqual([]);
  });

  it("refuses keys that disagree with the expected hash, before touching R2", async () => {
    r2.seed(from, BODY);
    const wrongTarget = blobKey("c".repeat(64));
    expect(
      await promote(asR2(r2), from, wrongTarget, expected, { db, now: NOW }),
    ).toEqual({ ok: false, reason: "bad_key" });
    expect(await promote(asR2(r2), to, to, expected, { db, now: NOW })).toEqual(
      { ok: false, reason: "bad_key" },
    );
    expect(
      await promote(asR2(r2), from, stagingKey("djdl", "t2", HEX), expected, {
        db,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "bad_key" });
    expect(r2.putAttempts).toEqual([]);
  });

  it("is idempotent: a second promote of the same bytes is alreadyStored", async () => {
    r2.seed(from, BODY);
    await promote(asR2(r2), from, to, expected, { db, now: NOW });
    const again = await promote(asR2(r2), from, to, expected, {
      db,
      now: NOW + 5,
    });
    expect(again).toMatchObject({ ok: true, alreadyStored: true });
    const rows = await db.all("SELECT * FROM blob_objects");
    expect(rows).toHaveLength(1);
  });

  it("records gated deltas with their kind and gate", async () => {
    const dkey = deltaKey("a".repeat(64), "b".repeat(64), "bsdiff", {
      gated: true,
    });
    r2.seed(from, BODY);
    await promote(asR2(r2), from, dkey, expected, { db, now: NOW });
    expect(
      await db.first(
        "SELECT kind, gated FROM blob_objects WHERE storage_key = ?",
        dkey,
      ),
    ).toEqual({ kind: "delta", gated: 1 });
  });

  it("storedKeys answers for many keys in chunked queries", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 250; i++) {
      const h = sha(new Uint8Array([i, i >> 8]));
      keys.push(blobKey(h));
      if (i % 2 === 0)
        await recordObject(
          db,
          {
            storageKey: blobKey(h),
            sha256: h,
            size: 2,
            kind: "blob",
            gated: false,
          },
          NOW,
        );
    }
    const got = await storedKeys(db, [...keys, keys[0]!]);
    expect(got.size).toBe(125);
    expect(got.has(keys[0]!)).toBe(true);
    expect(got.has(keys[1]!)).toBe(false);
  });

  it("referencedKeys answers per product: another product's stored copy is not 'present'", async () => {
    // The tenant-safe deduplication answer (P2-02's `present`): storedKeys says "someone has
    // these bytes"; referencedKeys says "THIS product already references them".
    const keys: string[] = [];
    for (let i = 0; i < 250; i++) {
      const h = sha(new Uint8Array([i, i >> 8, 7]));
      const key = blobKey(h, { gated: true });
      keys.push(key);
      await recordObject(
        db,
        { storageKey: key, sha256: h, size: 3, kind: "blob", gated: true },
        NOW,
      );
      await recordRef(
        db,
        { product: "other", storageKey: key, refKind: "artifact", refId: "o" },
        NOW,
      );
      if (i % 5 === 0)
        for (const refId of ["a", "b"])
          await recordRef(
            db,
            { product: "djdl", storageKey: key, refKind: "artifact", refId },
            NOW,
          );
    }
    expect((await storedKeys(db, keys)).size).toBe(250);
    const mine = await referencedKeys(db, "djdl", [...keys, keys[0]!]);
    expect(mine.size).toBe(50);
    expect(mine.has(keys[0]!)).toBe(true);
    expect(mine.has(keys[1]!)).toBe(false);
    expect((await referencedKeys(db, "other", keys)).size).toBe(250);
    expect((await referencedKeys(db, "nobody", keys)).size).toBe(0);
  });

  it("hasRef is per product: another product's ref does not count", async () => {
    r2.seed(from, BODY);
    await promote(asR2(r2), from, to, expected, { db, now: NOW });
    await recordRef(
      db,
      { product: "other", storageKey: to, refKind: "artifact", refId: "a1" },
      NOW,
    );
    expect(await hasRef(db, "other", to)).toBe(true);
    expect(await hasRef(db, "djdl", to)).toBe(false);
    await recordRef(
      db,
      { product: "djdl", storageKey: to, refKind: "artifact", refId: "a2" },
      NOW,
    );
    // idempotent
    await recordRef(
      db,
      { product: "djdl", storageKey: to, refKind: "artifact", refId: "a2" },
      NOW,
    );
    expect(await hasRef(db, "djdl", to)).toBe(true);
  });

  it("a ref can only name a recorded object (foreign key)", async () => {
    await expect(
      recordRef(
        db,
        {
          product: "djdl",
          storageKey: blobKey(HEX),
          refKind: "artifact",
          refId: "x",
        },
        NOW,
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("an object with a ref cannot be deleted from blob_objects (the GC invariant)", async () => {
    r2.seed(from, BODY);
    await promote(asR2(r2), from, to, expected, { db, now: NOW });
    await recordRef(
      db,
      { product: "djdl", storageKey: to, refKind: "artifact", refId: "a" },
      NOW,
    );
    await expect(
      db.run("DELETE FROM blob_objects WHERE storage_key = ?", to),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

// ── blobResponse ────────────────────────────────────────────────────────────────────────────

describe("blobResponse", () => {
  const key = blobKey(HEX);
  const size = BODY.length;
  const b64 = createHash("sha256").update(BODY).digest("base64");
  let r2: R2Mock;
  beforeEach(async () => {
    r2 = new R2Mock();
    await putVerified(asR2(r2), key, BODY, { sha256: HEX, size });
  });

  function req(headers: Record<string, string> = {}, method = "GET"): Request {
    return new Request("https://dl.example/x", { method, headers });
  }
  // The bytes host is DERIVED from the request URL against BLOB_ORIGIN (P2-05).
  const bytesEnv = { BLOB_ORIGIN: "https://dl.example" };
  const ungated = { sha256: HEX, gated: false, env: bytesEnv };

  it("200 carries ETag, Repr-Digest, Accept-Ranges, nosniff, sandbox and immutable caching", async () => {
    const res = await blobResponse(req(), asR2(r2), key, ungated);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${HEX}"`);
    expect(res.headers.get("repr-digest")).toBe(`sha-256=:${b64}:`);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);
    expect(res.headers.get("content-security-policy")).toMatch(/\bsandbox\b/);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    expect(res.headers.get("content-length")).toBe(String(size));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BODY);
  });

  it("206 with Content-Range for a satisfiable range; Repr-Digest still covers the whole", async () => {
    const res = await blobResponse(
      req({ range: "bytes=10-19" }),
      asR2(r2),
      key,
      ungated,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 10-19/${size}`);
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("repr-digest")).toBe(`sha-256=:${b64}:`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BODY.slice(10, 20));
  });

  it("serves open-ended and suffix ranges", async () => {
    const open = await blobResponse(
      req({ range: `bytes=${size - 5}-` }),
      asR2(r2),
      key,
      ungated,
    );
    expect(open.headers.get("content-range")).toBe(
      `bytes ${size - 5}-${size - 1}/${size}`,
    );
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(
      BODY.slice(size - 5),
    );
    const suffix = await blobResponse(
      req({ range: "bytes=-3" }),
      asR2(r2),
      key,
      ungated,
    );
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(
      BODY.slice(size - 3),
    );
  });

  it("416 for an unsatisfiable range, with Content-Range: bytes */size", async () => {
    const res = await blobResponse(
      req({ range: `bytes=${size}-` }),
      asR2(r2),
      key,
      ungated,
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${size}`);
    expect(await res.text()).toBe("");
  });

  it("If-Range not matching the ETag returns the full 200", async () => {
    const res = await blobResponse(
      req({ range: "bytes=0-9", "if-range": `"${"0".repeat(64)}"` }),
      asR2(r2),
      key,
      ungated,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(size);
  });

  it("If-Range matching the ETag honours the range", async () => {
    const res = await blobResponse(
      req({ range: "bytes=0-9", "if-range": `"${HEX}"` }),
      asR2(r2),
      key,
      ungated,
    );
    expect(res.status).toBe(206);
  });

  it("If-None-Match matching the ETag returns 304 with no body", async () => {
    for (const inm of [`"${HEX}"`, `W/"${HEX}"`, `"x", "${HEX}"`, "*"]) {
      const res = await blobResponse(
        req({ "if-none-match": inm }),
        asR2(r2),
        key,
        ungated,
      );
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(`"${HEX}"`);
      expect(await res.text()).toBe("");
    }
    const miss = await blobResponse(
      req({ "if-none-match": `"${"0".repeat(64)}"` }),
      asR2(r2),
      key,
      ungated,
    );
    expect(miss.status).toBe(200);
  });

  it("multi-range and malformed ranges are ignored (full 200)", async () => {
    for (const range of [
      "bytes=0-1,5-6",
      "items=0-1",
      "bytes=9-3",
      "bytes=x-",
    ]) {
      const res = await blobResponse(req({ range }), asR2(r2), key, ungated);
      expect(res.status, range).toBe(200);
    }
  });

  it("HEAD returns the same headers and no body", async () => {
    const get = await blobResponse(
      req({ range: "bytes=0-9" }),
      asR2(r2),
      key,
      ungated,
    );
    const head = await blobResponse(
      req({ range: "bytes=0-9" }, "HEAD"),
      asR2(r2),
      key,
      ungated,
    );
    expect(head.status).toBe(206);
    expect([...head.headers]).toEqual([...get.headers]);
    expect(await head.text()).toBe("");
  });

  it("gated responses are private, no-store, no-transform", async () => {
    const gkey = blobKey(HEX, { gated: true });
    await putVerified(asR2(r2), gkey, BODY, { sha256: HEX, size });
    const res = await blobResponse(req(), asR2(r2), gkey, {
      ...ungated,
      gated: true,
    });
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );
    const nm = await blobResponse(
      req({ "if-none-match": `"${HEX}"` }),
      asR2(r2),
      gkey,
      { ...ungated, gated: true },
    );
    expect(nm.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );
  });

  it("a gated/ key is private, no-store even if the caller forgot to say gated", async () => {
    const gkey = blobKey(HEX, { gated: true });
    await putVerified(asR2(r2), gkey, BODY, { sha256: HEX, size });
    const res = await blobResponse(req(), asR2(r2), gkey, ungated);
    expect(res.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );
  });

  it("never serves a staging/ object (unverified CI upload)", async () => {
    const skey = stagingKey("djdl", "t1", HEX);
    r2.seed(skey, BODY);
    await expect(blobResponse(req(), asR2(r2), skey, ungated)).rejects.toThrow(
      BlobKeyError,
    );
  });

  it("console-host responses are always octet-stream attachments, whatever is asked", async () => {
    const res = await blobResponse(req(), asR2(r2), key, {
      sha256: HEX,
      gated: false,
      env: bytesEnv,
      host: "console",
      contentType: "application/vnd.android.package-archive",
      disposition: "inline",
      filename: "My Game.apk",
    });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="My_Game.apk"',
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("ignores a caller-supplied host: bytes on a console-host request (P2-05)", async () => {
    const consoleReq = new Request("https://key.example/djdl/release/blobs/x");
    for (const env of [bytesEnv, {}]) {
      const res = await blobResponse(consoleReq, asR2(r2), key, {
        sha256: HEX,
        gated: false,
        env,
        host: "bytes",
        contentType: "application/wasm",
        disposition: "inline",
        filename: "game.wasm",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toBe(
        'attachment; filename="game.wasm"',
      );
    }
  });

  it("a locked key whose object has no stored checksum answers not-found (P2-05)", async () => {
    // Seeded directly, bypassing putVerified: no `checksums.sha256` on the object.
    for (const k of [
      blobKey(sha(OTHER)),
      blobKey(sha(OTHER), { gated: true }),
      bundleKey(sha(OTHER)),
    ]) {
      r2.seed(k, OTHER);
      const res = await blobResponse(req(), asR2(r2), k, {
        ...ungated,
        sha256: sha(OTHER),
      });
      expect(res.status, k).toBe(404);
      expect(res.headers.get("etag"), k).toBeNull();
      expect(res.headers.get("repr-digest"), k).toBeNull();
    }
    const dkey = deltaKey("a".repeat(64), "b".repeat(64), "bsdiff");
    r2.seed(dkey, OTHER);
    expect(
      (
        await blobResponse(req(), asR2(r2), dkey, {
          ...ungated,
          sha256: sha(OTHER),
        })
      ).status,
    ).toBe(404);
  });

  it("the bytes host may pass an allowlisted type and inline disposition", async () => {
    const res = await blobResponse(req(), asR2(r2), key, {
      ...ungated,
      contentType: "application/wasm",
      disposition: "inline",
      filename: "game.wasm",
    });
    expect(res.headers.get("content-type")).toBe("application/wasm");
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="game.wasm"',
    );
    const apk = await blobResponse(req(), asR2(r2), key, {
      ...ungated,
      contentType: "application/vnd.android.package-archive",
    });
    expect(apk.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("the bytes host never serves an executable or renderable type — it downgrades to an octet-stream attachment", async () => {
    for (const t of [
      "text/html",
      "text/html; charset=utf-8",
      "application/xhtml+xml",
      "image/svg+xml",
      "text/xml",
      "application/xml",
      "text/javascript",
      "application/javascript",
      "application/json",
      "text/plain",
      "image/png",
    ]) {
      const res = await blobResponse(req(), asR2(r2), key, {
        ...ungated,
        contentType: t,
        disposition: "inline",
      });
      expect(res.headers.get("content-type"), t).toBe(
        "application/octet-stream",
      );
      expect(res.headers.get("content-disposition"), t).toMatch(/^attachment;/);
    }
  });

  it("the allowlist itself holds no executable or renderable type", () => {
    for (const t of BYTES_HOST_TYPES)
      expect(t).not.toMatch(/html|xml|svg|script|ecmascript|json|^text\//i);
  });

  it("answers not-found for a missing object or a checksum that disagrees", async () => {
    const other = blobKey(sha(OTHER));
    expect(
      (
        await blobResponse(req(), asR2(r2), other, {
          ...ungated,
          sha256: sha(OTHER),
        })
      ).status,
    ).toBe(404);
    // A delta is not named by its own hash, so a wrong opts.sha256 reaches the checksum check.
    const dkey = deltaKey("a".repeat(64), "b".repeat(64), "bsdiff");
    await putVerified(asR2(r2), dkey, BODY, { sha256: HEX, size });
    expect(
      (
        await blobResponse(req(), asR2(r2), dkey, {
          ...ungated,
          sha256: sha(OTHER),
        })
      ).status,
    ).toBe(404);
  });

  it("refuses a key not named by opts.sha256 and non-GET methods", async () => {
    await expect(
      blobResponse(req(), asR2(r2), key, { ...ungated, sha256: sha(OTHER) }),
    ).rejects.toThrow(BlobKeyError);
    const post = await blobResponse(req({}, "POST"), asR2(r2), key, ungated);
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("parseRange", () => {
  it("follows RFC 9110 single-range semantics", () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange("bytes=0-0", 10)).toEqual({ offset: 0, length: 1 });
    expect(parseRange("bytes=5-100", 10)).toEqual({ offset: 5, length: 5 });
    expect(parseRange("bytes=-100", 10)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=-", 10)).toBeNull();
  });
});
