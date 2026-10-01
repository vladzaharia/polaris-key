/**
 * P2-05 — Release's three byte routes (`services/release/bytes.ts`) on the console host and on
 * the bytes host, the GitHub caches that make a download cheap (`ghCache.ts`), and the opt-in
 * redirect.
 *
 *   - the blob route refuses a hash no artifact of THIS product references, and serves 206, 304
 *     and 416 correctly from the R2 fake;
 *   - with caching, a download miss makes at most one GitHub API call and a following Range
 *     request makes none (fetch-counting);
 *   - with Release off, the three routes answer the bytes host's flat not-found.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import {
  BLOB_CSP,
  blobKey,
  putVerified,
  recordObject,
  recordRef,
} from "../src/core/blobs.js";
import { stmtSetArtifactModel } from "../src/services/release/model.js";
import {
  ASSET_BYTES,
  BYTES,
  bytesOf,
  call,
  CONSOLE,
  enableServices,
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  sha256Hex,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { NOW, seedProduct } from "./seed.js";

const BLOB = bytesOf(4096, 9);
const BLOB_HEX = sha256Hex(BLOB);
const BLOB_KEY = blobKey(BLOB_HEX);

async function setup(
  opts: { access?: string; repoPrivate?: boolean } = {},
): Promise<{ env: Env; db: Db; r2: R2Mock; gh: ReturnType<typeof github> }> {
  const db = makeTestDb();
  await seedReleaseProduct(db, {
    artifacts_access: opts.access ?? "public",
  });
  const r2 = new R2Mock();
  const env = envFor({ blobOrigin: BYTES });
  env.BLOBS = asR2(r2);
  const gh = github({
    releases: RELEASES,
    ...(opts.repoPrivate !== undefined
      ? { repoPrivate: opts.repoPrivate }
      : {}),
  });
  await syncAndDescribe(env, db, gh.fetchImpl);
  return { env, db, r2, gh };
}

/** Store `bytes` in R2 and give `product` a ref to it, as a promote + descriptor ingest would. */
async function storeBlob(
  db: Db,
  r2: R2Mock,
  product: string,
  bytes: Uint8Array,
): Promise<string> {
  const hex = sha256Hex(bytes);
  const key = blobKey(hex);
  const put = await putVerified(asR2(r2), key, bytes, {
    sha256: hex,
    size: bytes.length,
  });
  if (!put.ok && put.reason !== "exists") throw new Error(put.reason);
  await recordObject(
    db,
    {
      storageKey: key,
      sha256: hex,
      size: bytes.length,
      kind: "blob",
      gated: false,
    },
    NOW,
  );
  await recordRef(
    db,
    { product, storageKey: key, refKind: "artifact", refId: `${product}:x` },
    NOW,
  );
  return key;
}

const get = (
  s: { env: Env; db: Db; gh: ReturnType<typeof github> },
  url: string,
  init: RequestInit = {},
) => call(s.env, s.db, s.gh.fetchImpl, url, init);

describe("blob route", () => {
  it("refuses a hash no artifact of this product references — even when another product holds it", async () => {
    const s = await setup();
    await seedProduct(s.db, "other");
    await storeBlob(s.db, s.r2, "other", BLOB);
    for (const host of [CONSOLE, BYTES]) {
      const res = await get(
        s,
        `${host}/${SLUG}/release/blobs/sha256/${BLOB_HEX}`,
      );
      expect(res.status, host).toBe(404);
      expect(await res.json(), host).toEqual({ error: "not_found" });
    }
    // An unknown hash answers exactly the same.
    const unknown = await get(
      s,
      `${BYTES}/${SLUG}/release/blobs/sha256/${"0".repeat(64)}`,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
  });

  it("serves 200, 206, 304, 416 and HEAD from R2 once this product references it", async () => {
    const s = await setup();
    await storeBlob(s.db, s.r2, SLUG, BLOB);
    const url = `${BYTES}/${SLUG}/release/blobs/sha256/${BLOB_HEX}`;

    const full = await get(s, url);
    expect(full.status).toBe(200);
    expect(full.headers.get("etag")).toBe(`"${BLOB_HEX}"`);
    expect(full.headers.get("repr-digest")).toMatch(/^sha-256=:/);
    expect(full.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    expect(full.headers.get("content-security-policy")).toBe(BLOB_CSP);
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(BLOB);

    const part = await get(s, url, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(
      `bytes 100-199/${BLOB.length}`,
    );
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(
      BLOB.slice(100, 200),
    );

    const notModified = await get(s, url, {
      headers: { "if-none-match": `"${BLOB_HEX}"` },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");

    const unsatisfiable = await get(s, url, {
      headers: { range: `bytes=${BLOB.length}-` },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe(
      `bytes */${BLOB.length}`,
    );

    const head = await get(s, url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(BLOB.length));
    expect(await head.text()).toBe("");
  });

  it("on the console host the same blob is an octet-stream attachment", async () => {
    const s = await setup();
    await storeBlob(s.db, s.r2, SLUG, BLOB);
    const res = await get(
      s,
      `${CONSOLE}/${SLUG}/release/blobs/sha256/${BLOB_HEX}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    // The sandbox CSP survives the gateway's hardening (it is tighter than the app CSP).
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);
  });

  it("follows the artifacts access mode: a non-public product needs a licensed device", async () => {
    const s = await setup({ access: "authenticated" });
    await storeBlob(s.db, s.r2, SLUG, BLOB);
    const res = await get(
      s,
      `${BYTES}/${SLUG}/release/blobs/sha256/${BLOB_HEX}`,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "download_auth_required",
    );
  });

  it("refuses methods other than GET and HEAD", async () => {
    const s = await setup();
    await storeBlob(s.db, s.r2, SLUG, BLOB);
    const res = await get(
      s,
      `${BYTES}/${SLUG}/release/blobs/sha256/${BLOB_HEX}`,
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(405);
  });
});

describe("Release off", () => {
  it("the three release byte routes answer the bytes host's flat not-found", async () => {
    const s = await setup();
    await storeBlob(s.db, s.r2, SLUG, BLOB);
    const paths = [
      `/${SLUG}/release/blobs/sha256/${BLOB_HEX}`,
      `/${SLUG}/release/builds/stable/cli-arm64`,
      `/${SLUG}/release/files/v1.1.0/djdl-arm64`,
    ];
    for (const p of paths)
      expect((await get(s, BYTES + p)).status, p).toBe(200);

    await enableServices(s.db, false);
    s.gh.calls.api.length = 0;
    for (const p of paths) {
      const res = await get(s, BYTES + p);
      expect(res.status, p).toBe(404);
      expect(await res.json(), p).toEqual({ error: "not_found" });
      expect(res.headers.get("content-security-policy"), p).toBe(BLOB_CSP);
      expect(res.headers.get("x-content-type-options"), p).toBe("nosniff");
    }
    // Nothing reached GitHub: the routes never ran.
    expect(s.gh.calls.api).toEqual([]);
  });
});

describe("build and file routes", () => {
  it("a build served from R2 needs no GitHub call, and a moving selector is not immutable", async () => {
    const s = await setup();
    const key = await storeBlob(s.db, s.r2, SLUG, ASSET_BYTES[201]!);
    const set = stmtSetArtifactModel({
      product: SLUG,
      releaseId: "v1.1.0",
      artifactId: "201",
      buildId: "cli-arm64",
      role: "payload",
      sha256: sha256Hex(ASSET_BYTES[201]!),
      storageKey: key,
      locationsJson: JSON.stringify([
        { provider: "github", asset: 201 },
        { provider: "r2", key },
      ]),
    });
    await s.db.run(set.sql, ...set.params);
    s.gh.calls.api.length = 0;

    const res = await get(
      s,
      `${BYTES}/${SLUG}/release/builds/stable/cli-arm64`,
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ASSET_BYTES[201]);
    expect(res.headers.get("etag")).toBe(`"${sha256Hex(ASSET_BYTES[201]!)}"`);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=120, no-transform",
    );
    expect(s.gh.calls.api).toEqual([]);
    expect(s.gh.calls.storage).toEqual([]);

    // A pinned version is immutable.
    const pinned = await get(
      s,
      `${BYTES}/${SLUG}/release/builds/1.1.0/cli-arm64`,
    );
    expect(pinned.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
  });

  it("?deliverable= and an unknown build or selector answer not-found", async () => {
    const s = await setup();
    for (const p of [
      "/release/builds/stable/nope",
      "/release/builds/nightly/cli-arm64",
      "/release/builds/stable/cli-arm64?deliverable=packs.core",
      "/release/files/v1.1.0/missing.zip",
      "/release/files/v9.9.9/djdl-arm64",
    ]) {
      const res = await get(s, `${BYTES}/${SLUG}${p}`);
      expect(res.status, p).toBe(404);
    }
  });

  it("?checksum=sha256 answers the payload digest (octet-stream on the bytes host, text on the console)", async () => {
    const s = await setup();
    const want = `${sha256Hex(ASSET_BYTES[201]!)}\n`;
    const bytes = await get(
      s,
      `${BYTES}/${SLUG}/release/builds/stable/cli-arm64?checksum=sha256`,
    );
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("application/octet-stream");
    expect(await bytes.text()).toBe(want);
    const console_ = await get(
      s,
      `${CONSOLE}/${SLUG}/release/builds/stable/cli-arm64?checksum=sha256`,
    );
    expect(console_.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await console_.text()).toBe(want);
  });

  it("a file route serves one exact file of one release, never the repo's content type", async () => {
    const s = await setup();
    const res = await get(
      s,
      `${BYTES}/${SLUG}/release/files/v1.0.0/djdl-1.0.0-arm64.dmg`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/x-apple-diskimage",
    );
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ASSET_BYTES[102]);
  });
});

describe("GitHub caching (fetch-counting)", () => {
  it("a build download miss makes one API call, and a following Range request makes none", async () => {
    const s = await setup();
    s.gh.calls.api.length = 0;
    s.gh.calls.storage.length = 0;
    const url = `${BYTES}/${SLUG}/release/builds/stable/cli-arm64`;

    const first = await get(s, url, { headers: { range: "bytes=0-999" } });
    expect(first.status).toBe(206);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(
      ASSET_BYTES[201]!.slice(0, 1000),
    );
    expect(s.gh.calls.api).toHaveLength(1);
    expect(s.gh.calls.api[0]).toMatch(/\/releases\/assets\/201$/);
    expect(s.gh.calls.storage).toHaveLength(1);

    const next = await get(s, url, { headers: { range: "bytes=1000-1999" } });
    expect(next.status).toBe(206);
    expect(next.headers.get("content-range")).toBe(
      `bytes 1000-1999/${ASSET_BYTES[201]!.length}`,
    );
    expect(new Uint8Array(await next.arrayBuffer())).toEqual(
      ASSET_BYTES[201]!.slice(1000, 2000),
    );
    expect(s.gh.calls.api).toHaveLength(1); // no API call for the second chunk
    expect(s.gh.calls.storage).toHaveLength(2);
  });

  it("the legacy download: with resolution cached, a miss costs one API call and a Range chunk none", async () => {
    const s = await setup();
    s.gh.calls.api.length = 0;
    // A version check resolves `latest` (one list call) and caches the resolution…
    const v = await get(s, `${CONSOLE}/${SLUG}/update/version`);
    expect(v.status).toBe(200);
    expect(s.gh.calls.api).toHaveLength(1);
    s.gh.calls.api.length = 0;

    // …so the download miss is one API call (the asset), and the next chunk is none.
    const url = `${CONSOLE}/${SLUG}/release/dl/latest/djdl-arm64`;
    const first = await get(s, url, { headers: { range: "bytes=0-9" } });
    expect(first.status).toBe(206);
    expect(s.gh.calls.api, s.gh.calls.api.join("\n")).toHaveLength(1);
    const next = await get(s, url, { headers: { range: "bytes=10-19" } });
    expect(next.status).toBe(206);
    expect(new Uint8Array(await next.arrayBuffer())).toEqual(
      ASSET_BYTES[201]!.slice(10, 20),
    );
    expect(s.gh.calls.api).toHaveLength(1);
  });

  it("the cached signed URL is sealed in KV, never plaintext", async () => {
    const s = await setup();
    await get(s, `${BYTES}/${SLUG}/release/builds/stable/cli-arm64`);
    const kv = s.env.HOT as unknown as {
      keys(): string[];
      get(k: string): Promise<string | null>;
    };
    const slot = kv.keys().find((k) => k.includes("gh-asset-url"));
    expect(slot).toBeDefined();
    const raw = (await kv.get(slot!)) ?? "";
    expect(raw).not.toContain("objects.githubusercontent.com");
    expect(raw).not.toContain("X-Amz-Signature");
  });
});

describe("redirect mode", () => {
  it("?redirect=1 on a public artifact of a public repository is a 302 to GitHub's download URL", async () => {
    const s = await setup({ repoPrivate: false });
    const res = await get(
      s,
      `${BYTES}/${SLUG}/release/files/v1.1.0/djdl-arm64?redirect=1`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/acme/djdl/releases/download/x/djdl-arm64",
    );
    expect(s.gh.calls.storage).toEqual([]);
  });

  it("a private repository, or a non-public product, streams instead", async () => {
    const priv = await setup({ repoPrivate: true });
    const a = await get(
      priv,
      `${BYTES}/${SLUG}/release/files/v1.1.0/djdl-arm64?redirect=1`,
    );
    expect(a.status).toBe(200);
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(ASSET_BYTES[201]);
  });

  it("streaming stays the default", async () => {
    const s = await setup({ repoPrivate: false });
    const res = await get(
      s,
      `${BYTES}/${SLUG}/release/files/v1.1.0/djdl-arm64`,
    );
    expect(res.status).toBe(200);
  });
});

describe("discovery", () => {
  it("advertises the templated builds and blobs endpoints on the bytes host when BLOB_ORIGIN is set", async () => {
    const s = await setup();
    const res = await get(s, `${CONSOLE}/${SLUG}/.well-known/polaris.json`);
    const body = (await res.json()) as {
      services: { release: { endpoints: Record<string, string> } };
    };
    expect(body.services.release.endpoints).toMatchObject({
      download: `${CONSOLE}/${SLUG}/release/dl`,
      builds: `${BYTES}/${SLUG}/release/builds/{selector}/{buildId}`,
      blobs: `${BYTES}/${SLUG}/release/blobs/sha256/{sha256}`,
    });
  });
});
