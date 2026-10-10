/// <reference types="@cloudflare/workers-types" />
// ── The blob store on miniflare's R2 (P2-01) ─────────────────────────────────────────────
//
// The Node lane runs `core/assets/blobs.ts` against `test/r2Mock.ts`. This file runs the same flows
// against the real binding, which is what proves the fake has not drifted: that R2 itself
// refuses a put whose bytes miss the `sha256` option, that `If-None-Match: *` makes a put
// create-only, that ranged gets return the right bytes, and that workerd's native
// `crypto.DigestStream` hashes a large object streamed rather than buffered.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BLOB_CSP,
  blobKey,
  blobResponse,
  hasRef,
  isStored,
  promote,
  putVerified,
  recordObject,
  recordRef,
  refHolders,
  stagingKey,
  streamSha256,
  verifyStaged,
} from "../src/core/assets/blobs.js";
import { D1Db } from "../src/db/d1.js";
import { inertDocumentPolicy } from "../src/core/assets/bytesHost.js";
import { landingCsp } from "../src/core/assets/bytesLanding.js";
import { NOW, seedProduct } from "./seed.js";

const MiB = 1024 * 1024;
/** Real R2 I/O through miniflare, including two 17 MiB objects generated, hashed, uploaded and
 *  streamed: ~2 s on an idle machine, so vitest's 5 s default is too tight for a loaded runner. */
const R2_LANE = { timeout: 60_000 };

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536)
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65_536, n)));
  return out;
}

async function hexSha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bucket(): R2Bucket {
  if (!env.BLOBS) throw new Error("BLOBS is not bound in the workerd lane");
  return env.BLOBS;
}

describe("putVerified on R2", R2_LANE, () => {
  it("R2 refuses bytes that do not hash to the sha256 option", async () => {
    const good = randomBytes(4096);
    const bad = randomBytes(4096);
    const h = await hexSha256(good);
    const res = await putVerified(bucket(), blobKey(h), bad, {
      sha256: h,
      size: bad.length,
    });
    expect(res).toMatchObject({ ok: false, reason: "rejected" });
    expect(await bucket().head(blobKey(h))).toBeNull();
  });

  it("is create-only: a second put to the same key is refused and the first survives", async () => {
    const bytes = randomBytes(8192);
    const h = await hexSha256(bytes);
    const first = await putVerified(bucket(), blobKey(h), bytes, {
      sha256: h,
      size: bytes.length,
    });
    expect(first.ok).toBe(true);
    const etag = (await bucket().head(blobKey(h)))!.etag;
    const second = await putVerified(bucket(), blobKey(h), bytes, {
      sha256: h,
      size: bytes.length,
    });
    expect(second).toEqual({ ok: false, reason: "exists" });
    expect((await bucket().head(blobKey(h)))!.etag).toBe(etag);
  });

  it("stores R2's SHA-256 checksum for a verified put", async () => {
    const bytes = randomBytes(1000);
    const h = await hexSha256(bytes);
    await putVerified(bucket(), blobKey(h), bytes, { sha256: h, size: 1000 });
    const head = await bucket().head(blobKey(h));
    const stored = new Uint8Array(head!.checksums.sha256!);
    expect(
      [...stored].map((b) => b.toString(16).padStart(2, "0")).join(""),
    ).toBe(h);
  });
});

describe("verifyStaged + promote on R2", R2_LANE, () => {
  it("streams a >16 MiB object through the native DigestStream", async () => {
    const big = randomBytes(17 * MiB + 3);
    const h = await hexSha256(big);
    const key = stagingKey("djdl", "big", h);
    // Uploaded WITHOUT a checksum, as a CI S3 client that omits x-amz-checksum-sha256 would.
    await bucket().put(key, big);
    expect((await bucket().head(key))!.checksums.sha256).toBeUndefined();

    const res = await verifyStaged(bucket(), key, {
      sha256: h,
      size: big.length,
    });
    expect(res).toMatchObject({ ok: true, method: "streamed" });

    const obj = await bucket().get(key);
    expect(await streamSha256(obj!.body)).toEqual({
      sha256: h,
      bytes: big.length,
    });

    const wrong = await verifyStaged(bucket(), key, {
      sha256: "0".repeat(64),
      size: big.length,
    });
    expect(wrong).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  it("uses the stored checksum when the uploader sent one", async () => {
    const bytes = randomBytes(2048);
    const h = await hexSha256(bytes);
    const key = stagingKey("djdl", "sum", h);
    await bucket().put(key, bytes, { sha256: h });
    expect(
      await verifyStaged(bucket(), key, { sha256: h, size: 2048 }),
    ).toMatchObject({
      ok: true,
      method: "stored-checksum",
    });
  });

  it("promotes a large object by streaming, records it, and refs are per product", async () => {
    const db = new D1Db(env.DB);
    await seedProduct(env, db, "blobs-a", { schemaVersion: 1, entries: [] });
    await seedProduct(env, db, "blobs-b", { schemaVersion: 1, entries: [] });
    const big = randomBytes(17 * MiB);
    const h = await hexSha256(big);
    const from = stagingKey("blobs-a", "t1", h);
    await bucket().put(from, big);

    const res = await promote(
      bucket(),
      from,
      blobKey(h),
      { sha256: h, size: big.length },
      {
        db,
        now: NOW,
        product: "blobs-a",
      },
    );
    expect(res).toMatchObject({ ok: true, alreadyStored: false });
    expect(await isStored(db, blobKey(h))).toBe(true);
    const head = await bucket().head(blobKey(h));
    expect(head!.size).toBe(big.length);

    await recordRef(
      db,
      {
        product: "blobs-a",
        storageKey: blobKey(h),
        refKind: "artifact",
        refId: "x",
      },
      NOW,
    );
    expect(await hasRef(db, "blobs-a", blobKey(h))).toBe(true);
    expect(await hasRef(db, "blobs-b", blobKey(h))).toBe(false);
  });

  // P2-02 wave-1 sync: the `alreadyStored` path on the real binding. In workerd the staged
  // body is locked by `putVerified`'s `pipeThrough(FixedLengthStream)` when R2 refuses the
  // create-only put, so the cancel that follows must not throw or leave the promote hanging.
  it("a second product's promote of bytes already stored succeeds as alreadyStored", async () => {
    const db = new D1Db(env.DB);
    await seedProduct(env, db, "stored-a", { schemaVersion: 1, entries: [] });
    await seedProduct(env, db, "stored-b", { schemaVersion: 1, entries: [] });
    const bytes = randomBytes(2 * MiB + 17);
    const h = await hexSha256(bytes);
    const fromA = stagingKey("stored-a", "ta", h);
    const fromB = stagingKey("stored-b", "tb", h);
    await bucket().put(fromA, bytes, { sha256: h });
    await bucket().put(fromB, bytes);
    const expected = { sha256: h, size: bytes.length };

    const first = await promote(bucket(), fromA, blobKey(h), expected, {
      db,
      now: NOW,
      product: "stored-a",
    });
    expect(first).toMatchObject({ ok: true, alreadyStored: false });
    const second = await promote(bucket(), fromB, blobKey(h), expected, {
      db,
      now: NOW + 1,
      product: "stored-b",
    });
    expect(second).toMatchObject({ ok: true, alreadyStored: true });
    // And a promote FOR the other product from this one's prefix is refused before any I/O.
    expect(
      await promote(bucket(), fromA, blobKey(h), expected, {
        db,
        now: NOW + 2,
        product: "stored-b",
      }),
    ).toEqual({ ok: false, reason: "bad_key" });
  });

  it("never writes the target when the staged bytes are wrong", async () => {
    const db = new D1Db(env.DB);
    const bytes = randomBytes(4096);
    const claimed = "1".repeat(64);
    const from = stagingKey("djdl", "bad", claimed);
    await bucket().put(from, bytes);
    const res = await promote(
      bucket(),
      from,
      blobKey(claimed),
      { sha256: claimed, size: bytes.length },
      { db, now: NOW, product: "djdl" },
    );
    expect(res).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(await bucket().head(blobKey(claimed))).toBeNull();
    expect(await isStored(db, blobKey(claimed))).toBe(false);
  });
});

describe("blobResponse on R2", R2_LANE, () => {
  it("serves 200, 206, 416, 304 and HEAD with the SHA-256 validators", async () => {
    const bytes = randomBytes(100_000);
    const h = await hexSha256(bytes);
    const key = blobKey(h);
    await putVerified(bucket(), key, bytes, { sha256: h, size: bytes.length });
    const opts = {
      sha256: h,
      gated: false,
      env: { BLOB_ORIGIN: "https://dl.workerd.test" },
    };
    const url = "https://dl.workerd.test/x";

    const full = await blobResponse(new Request(url), bucket(), key, opts);
    expect(full.status).toBe(200);
    expect(full.headers.get("etag")).toBe(`"${h}"`);
    expect(full.headers.get("content-security-policy")).toBe(BLOB_CSP);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

    const part = await blobResponse(
      new Request(url, { headers: { range: "bytes=1000-1999" } }),
      bucket(),
      key,
      opts,
    );
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(
      `bytes 1000-1999/${bytes.length}`,
    );
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(
      bytes.slice(1000, 2000),
    );

    const suffix = await blobResponse(
      new Request(url, { headers: { range: "bytes=-10" } }),
      bucket(),
      key,
      opts,
    );
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(
      bytes.slice(-10),
    );

    const none = await blobResponse(
      new Request(url, { headers: { range: `bytes=${bytes.length}-` } }),
      bucket(),
      key,
      opts,
    );
    expect(none.status).toBe(416);

    const notModified = await blobResponse(
      new Request(url, { headers: { "if-none-match": `"${h}"` } }),
      bucket(),
      key,
      opts,
    );
    expect(notModified.status).toBe(304);

    const head = await blobResponse(
      new Request(url, { method: "HEAD" }),
      bucket(),
      key,
      opts,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect(head.body).toBeNull();
  });
});

describe("bytes host isolation on workerd", R2_LANE, () => {
  it("the console, portal and docs answer not-found, sandboxed, on the bytes host", async () => {
    for (const path of [
      "/index.html",
      "/favicon.ico",
      "/manage",
      "/docs",
      "/djdl/.well-known/polaris.json",
    ]) {
      // The fully-qualified form (trailing dot) is the same host, not a way around it.
      for (const host of ["dl.workerd.test", "dl.workerd.test."]) {
        const res = await SELF.fetch(`https://${host}${path}`, {
          headers: { cookie: "__Host-pkey_admin=x" },
        });
        const at = host + path;
        expect(res.status, at).toBe(404);
        expect(await res.json(), at).toEqual({ error: "not_found" });
        expect(res.headers.get("content-security-policy"), at).toBe(BLOB_CSP);
        expect(res.headers.get("x-content-type-options"), at).toBe("nosniff");
        expect(res.headers.get("set-cookie"), at).toBeNull();
      }
    }
  });
});

describe("the bytes host's landing page on workerd", () => {
  it("GET / is the static page under its inert policy; the brand module loads in workerd", async () => {
    for (const host of ["dl.workerd.test", "dl.workerd.test."]) {
      const res = await SELF.fetch(`https://${host}/`, {
        headers: { cookie: "__Host-pkey_admin=x" },
      });
      expect(res.status, host).toBe(200);
      expect(res.headers.get("content-type"), host).toBe(
        "text/html; charset=utf-8",
      );
      const csp = res.headers.get("content-security-policy")!;
      expect(csp, host).toBe(await landingCsp());
      expect(inertDocumentPolicy(csp), host).toBe(true);
      expect(csp, host).not.toMatch(/script/);
      expect(res.headers.get("x-content-type-options"), host).toBe("nosniff");
      expect(res.headers.get("set-cookie"), host).toBeNull();
      const html = await res.text();
      expect(html, host).toContain('aria-label="Polaris Key Delivery"');
      expect(html, host).not.toMatch(/<script/i);
    }
    const post = await SELF.fetch("https://dl.workerd.test/", {
      method: "POST",
    });
    expect(post.status).toBe(404);
    expect(post.headers.get("content-security-policy")).toBe(BLOB_CSP);
    // The console host's `/` is not the landing page.
    const consoleRoot = await SELF.fetch("https://key.plrs.im/");
    expect(await consoleRoot.text()).not.toContain(
      "The download host for games and apps",
    );
  });
});

// P4-05: the blob route authorises a pack object by its holders. The grouping query (`substr` /
// `instr` over a pack release id, GROUP BY, the overflow LIMIT) runs on D1 here.
describe("refHolders on D1 (P4-05)", () => {
  it("collapses refs to one row per (key, kind, holder) and never reads another product's", async () => {
    const db = new D1Db(env.DB);
    await seedProduct(env, db, "holders-a", { schemaVersion: 1, entries: [] });
    await seedProduct(env, db, "holders-b", { schemaVersion: 1, entries: [] });
    const h = "ab".repeat(32);
    const pub = blobKey(h);
    const gated = blobKey(h, { gated: true });
    for (const [key, isGated] of [
      [pub, false],
      [gated, true],
    ] as const)
      await recordObject(
        db,
        { storageKey: key, sha256: h, size: 1, kind: "blob", gated: isGated },
        NOW,
      );
    const refs: Array<[string, string, string, string]> = [
      ["holders-a", pub, "artifact", "app@1.0.0/a"],
      ["holders-a", pub, "artifact", "app@1.1.0/a"],
      ["holders-a", gated, "pack-object", "djdl.skins@1.0.0"],
      ["holders-a", gated, "pack-object", "djdl.skins@1.1.0"],
      ["holders-a", gated, "pack-upload", "djdl.skins"],
      ["holders-b", gated, "pack-upload", "other.pack"],
    ];
    for (const [product, storageKey, refKind, refId] of refs)
      await recordRef(db, { product, storageKey, refKind, refId }, NOW);
    expect(await refHolders(db, "holders-a", [pub, gated])).toEqual([
      { storageKey: pub, refKind: "artifact", holder: "" },
      { storageKey: gated, refKind: "pack-object", holder: "djdl.skins" },
      { storageKey: gated, refKind: "pack-upload", holder: "djdl.skins" },
    ]);
  });
});
