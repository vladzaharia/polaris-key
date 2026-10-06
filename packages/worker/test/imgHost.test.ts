/**
 * HA-02 — the image host (`core/imgHost.ts`, `core/imgHostname.ts`; notes/S-20 §6.5, owner
 * decision 2). Modelled on `bytesHost.test.ts`: configuration, isolation in both directions, the
 * pinned headers, cookies, per-product tenancy, the never-gated rule, variants and aliases.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { dispatch } from "../src/dispatch.js";
import {
  IMG_ALIAS_CACHE,
  IMG_CSP,
  IMG_HOST_TYPES,
  IMG_IMMUTABLE,
  dispatchImgHost,
  imgHostname,
  imgOrigin,
  imgUrl,
  isImgHost,
  matchImgPath,
} from "../src/core/imgHost.js";
import { HOSTED_ASSET_REF, ingest } from "../src/core/hostedAssets.js";
import {
  blobKey,
  putVerified,
  recordObject,
  stmtRecordRef,
} from "../src/core/blobs.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";

beforeAll(() => installDigestStream());

const HERE = dirname(fileURLToPath(import.meta.url));

const IMG = "https://img.example.test";
const BYTES = "https://dl.example.test";
const PKG = "https://pkg.example.test";
const CONSOLE = "https://key.example.test";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function filled(sig: number[], n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  out.set(sig, 0);
  return out;
}
const enc = (s: string) => new TextEncoder().encode(s);
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_SIG = [...enc("RIFF"), 1, 2, 3, 4, ...enc("WEBPVP8 ")];
const PNG = filled(PNG_SIG, 4000);
const PNG2 = filled(PNG_SIG, 5000, 9);
const PNG3 = filled(PNG_SIG, 6000, 11);
const WEBP64 = filled(WEBP_SIG, 900, 13);

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes.slice()).body as ReadableStream<Uint8Array>;
}

let db: SqliteDb;
let r2: R2Mock;

function env(over: Partial<Env> = {}): Env {
  const e = makeEnv(new KvMock(), []);
  e.BLOBS = asR2(r2);
  e.IMG_ORIGIN = IMG;
  e.BLOB_ORIGIN = BYTES;
  e.PKG_ORIGIN = PKG;
  return Object.assign(e, over);
}

/** Host `bytes` in `slot` of `product` through the real ingest (HA-01). */
async function host(
  product: string,
  slot: string,
  bytes: Uint8Array,
  locale = "",
): Promise<string> {
  const big = slot.startsWith("release-file");
  const res = await ingest(
    { env: { BLOBS: asR2(r2) }, db, now: NOW },
    product,
    slot,
    {
      kind: "stream",
      body: stream(bytes),
      size: bytes.length,
      sourceKind: "upload",
      origin: "console",
      locale,
      ...(big ? { expectedSha256: sha(bytes) } : {}),
    },
  );
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return sha(bytes);
}

/** Store a WebP variant of `slot`'s copy and list it in the row (HA-03's shape). */
async function addVariant(
  product: string,
  slot: string,
  w: number,
  bytes: Uint8Array,
  opts: { ref?: boolean; format?: string } = {},
): Promise<string> {
  const h = sha(bytes);
  const key = blobKey(h);
  const put = await putVerified(
    asR2(r2),
    key,
    bytes,
    { sha256: h, size: bytes.length },
    { contentType: "image/webp" },
  );
  expect(put.ok || put.reason === "exists").toBe(true);
  await recordObject(
    db,
    {
      storageKey: key,
      sha256: h,
      size: bytes.length,
      kind: "blob",
      gated: false,
    },
    NOW,
  );
  if (opts.ref !== false)
    await db.batch([
      stmtRecordRef(
        {
          product,
          storageKey: key,
          refKind: HOSTED_ASSET_REF,
          refId: `${slot}@`,
        },
        NOW,
      ),
    ]);
  const row = await db.first<{ variants_json: string }>(
    "SELECT variants_json FROM hosted_assets WHERE product = ? AND slot = ? AND locale = ''",
    product,
    slot,
  );
  const list = JSON.parse(row?.variants_json ?? "[]") as unknown[];
  list.push({
    w,
    format: opts.format ?? "webp",
    sha256: h,
    size: bytes.length,
  });
  await db.run(
    "UPDATE hosted_assets SET variants_json = ? WHERE product = ? AND slot = ? AND locale = ''",
    JSON.stringify(list),
    product,
    slot,
  );
  return h;
}

const get = (url: string, init?: RequestInit, e: Env = env(), d: Db = db) =>
  dispatch(new Request(url, init), e, d);

/** The headers every image-host answer carries, whatever its status. */
function expectHardened(res: Response, what: string): void {
  expect(res.headers.get("x-content-type-options"), what).toBe("nosniff");
  expect(res.headers.get("content-security-policy"), what).toBe(
    "default-src 'none'; sandbox",
  );
  expect(res.headers.get("access-control-allow-origin"), what).toBe("*");
  expect(res.headers.get("cross-origin-resource-policy"), what).toBe(
    "cross-origin",
  );
  expect(res.headers.get("referrer-policy"), what).toBe("no-referrer");
  expect(res.headers.get("set-cookie"), what).toBeNull();
  expect(res.headers.get("access-control-allow-credentials"), what).toBeNull();
}

beforeEach(async () => {
  db = makeTestDb();
  r2 = new R2Mock();
  await seedProduct(db, "djdl");
  await seedProduct(db, "other");
});

// ── Configuration ────────────────────────────────────────────────────────────────────────────

describe("image host: configuration", () => {
  it("resolves IMG_ORIGIN to a lowercase hostname, and nothing for unset, junk or a sibling", () => {
    expect(imgHostname({ IMG_ORIGIN: "https://IMG.plrs.im/" })).toBe(
      "img.plrs.im",
    );
    expect(imgHostname({ IMG_ORIGIN: "https://img.plrs.im./" })).toBe(
      "img.plrs.im",
    );
    expect(
      isImgHost(new URL("https://IMG.plrs.im../manage"), {
        IMG_ORIGIN: "https://img.plrs.im",
      }),
    ).toBe(true);
    expect(
      isImgHost(new URL("https://key.plrs.im/x"), {
        IMG_ORIGIN: "https://img.plrs.im",
      }),
    ).toBe(false);
    expect(imgHostname({})).toBeNull();
    expect(imgHostname({ IMG_ORIGIN: "" })).toBeNull();
    expect(imgHostname({ IMG_ORIGIN: "not a url" })).toBeNull();
    expect(imgHostname({ IMG_ORIGIN: "ftp://img.plrs.im" })).toBeNull();
    // Equal to the bytes or the registry host: never the image host (they are checked first).
    expect(
      imgHostname({
        IMG_ORIGIN: "https://dl.plrs.im",
        BLOB_ORIGIN: "https://dl.plrs.im",
      }),
    ).toBeNull();
    expect(
      imgHostname({
        IMG_ORIGIN: "https://pkg.plrs.im",
        PKG_ORIGIN: "https://pkg.plrs.im",
      }),
    ).toBeNull();
    expect(isImgHost(new URL("https://img.plrs.im/x"), {})).toBe(false);
  });

  it("imgUrl builds the original and variant URLs, and nothing it could never serve", () => {
    const e = { IMG_ORIGIN: "https://img.plrs.im/" };
    const h = "a".repeat(64);
    expect(imgOrigin(e)).toBe("https://img.plrs.im");
    expect(imgUrl(e, "djdl", h)).toBe(`https://img.plrs.im/djdl/a/${h}`);
    expect(imgUrl(e, "djdl", h, 256)).toBe(
      `https://img.plrs.im/djdl/a/${h}/256.webp`,
    );
    expect(imgUrl({}, "djdl", h)).toBeNull();
    expect(imgUrl(e, "DJDL", h)).toBeNull();
    expect(imgUrl(e, "djdl", "A".repeat(64))).toBeNull();
    expect(imgUrl(e, "djdl", h, 0)).toBeNull();
    expect(imgUrl(e, "djdl", h, 1.5)).toBeNull();
    expect(imgUrl(e, "djdl", h, 5000)).toBeNull();
    // Every URL it builds is one the host's path parser accepts.
    expect(matchImgPath(new URL(imgUrl(e, "djdl", h, 4096)!).pathname)).toEqual(
      { kind: "asset", product: "djdl", sha256: h, w: 4096 },
    );
  });

  it("serves only raster image types, never SVG, HTML, XML or script", () => {
    expect([...IMG_HOST_TYPES].sort()).toEqual([
      "image/avif",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });

  it("the committed wrangler.toml gives each environment its own img host and IMG_ORIGIN", () => {
    const toml = readFileSync(join(HERE, "..", "wrangler.toml"), "utf8");
    for (const [envName, host] of [
      ["prod", "img.plrs.im"],
      ["staging", "img-staging.plrs.im"],
      ["dev", "img-dev.plrs.im"],
    ] as const) {
      const block = toml
        .split(`[env.${envName}]`)[1]!
        .split(/\n\[env\.(?!\w+\.)/)[0]!;
      expect(block, envName).toContain(`IMG_ORIGIN = "https://${host}"`);
      expect(block, envName).toMatch(
        new RegExp(
          `pattern = "${host.replace(/\./g, "\\.")}"\\s*\\ncustom_domain = true`,
        ),
      );
      // Distinct from its siblings, so the dispatcher can never drop it.
      expect(block, envName).not.toMatch(
        new RegExp(
          `(BLOB|PKG)_ORIGIN = "https://${host.replace(/\./g, "\\.")}"`,
        ),
      );
    }
  });
});

// ── Isolation ────────────────────────────────────────────────────────────────────────────────

/** Paths that reach the console, the portal, docs, discovery, a service, the byte routes and the
 *  registry routes elsewhere. None of them may answer on the image host. */
const OTHER_PATHS = [
  "/",
  "/index.html",
  "/favicon.ico",
  "/robots.txt",
  "/manage",
  "/manage/api/me",
  "/docs",
  "/login",
  "/api/me",
  "/media/djdl/icon",
  "/download/abc",
  "/djdl",
  "/djdl/.well-known/polaris.json",
  "/djdl/.well-known/jwks.json",
  "/djdl/distribution/download",
  "/djdl/distribution/blobs/sha256/" + "a".repeat(64),
  "/djdl/release/dl/x",
  "/djdl/appcast.xml",
  "/webhooks/github",
  "/v2/",
  "/npm/djdl/x",
  "/blobs/sha256/" + "a".repeat(64),
  // Near misses of the image routes.
  "/djdl/a/" + "A".repeat(64),
  "/djdl/a/" + "a".repeat(63),
  "/djdl/a/" + "a".repeat(64) + "/",
  "/djdl/a/" + "a".repeat(64) + "/0.webp",
  "/djdl/a/" + "a".repeat(64) + "/256.png",
  "/djdl/a/" + "a".repeat(64) + "/9999.webp",
  "/djdl/icon/",
  "/djdl/screenshots/0",
  "/djdl/screenshots/17",
  "/djdl/screenshots/01",
  "/DJDL/icon",
  "/djdl/%61/" + "a".repeat(64),
];

describe("image host: isolation", () => {
  it("every non-image path answers the plain not-found there, hardened", async () => {
    for (const path of OTHER_PATHS)
      for (const method of ["GET", "HEAD", "POST"]) {
        const res = await worker.fetch(
          new Request(IMG + path, { method }),
          env({ DB: undefined }),
        );
        expect(res.status, `${method} ${path}`).toBe(404);
        if (method !== "HEAD")
          expect(await res.json(), path).toEqual({ error: "not_found" });
        expectHardened(res, `${method} ${path}`);
        expect(res.headers.get("strict-transport-security"), path).toContain(
          "max-age=",
        );
      }
  });

  it("the fully-qualified, upper-case or ported host is the image host too", async () => {
    for (const base of [`${IMG}.`, "https://IMG.EXAMPLE.TEST:443"])
      for (const path of [
        "/manage",
        "/docs",
        "/djdl/.well-known/polaris.json",
      ]) {
        const res = await worker.fetch(new Request(base + path), env());
        expect(res.status, base + path).toBe(404);
        expect(res.headers.get("content-security-policy")).toBe(IMG_CSP);
      }
  });

  it("the image routes are 404 on the console, the bytes host and the registry host", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    await host("djdl", "listing.header", PNG2);
    for (const base of [CONSOLE, BYTES, PKG])
      for (const path of [
        `/djdl/a/${h}`,
        `/djdl/a/${h}/64.webp`,
        "/djdl/icon",
        "/djdl/header",
        "/djdl/screenshots/1",
      ]) {
        const res = await get(base + path);
        expect(res.status, base + path).toBe(404);
        expect(res.headers.get("content-type") ?? "", base + path).not.toMatch(
          /^image\//,
        );
        expect(res.headers.get("location"), base + path).toBeNull();
      }
    // …and the same request on the image host answers.
    expect((await get(`${IMG}/djdl/a/${h}`)).status).toBe(200);
  });

  it("with IMG_ORIGIN unset, its hostname is just another console request", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    const res = await get(
      `${IMG}/djdl/a/${h}`,
      undefined,
      env({ IMG_ORIGIN: undefined }),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).not.toBe(IMG_CSP);
  });

  it("other methods on an image path are 405, hardened, and never reach a route", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
      for (const path of [`/djdl/a/${h}`, "/djdl/icon"]) {
        const res = await get(IMG + path, { method });
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD");
        expectHardened(res, `${method} ${path}`);
      }
  });
});

// ── Serving ──────────────────────────────────────────────────────────────────────────────────

describe("image host: serving", () => {
  it("serves a hosted original with exactly the pinned headers", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    const res = await get(`${IMG}/djdl/a/${h}`);
    expect(res.status).toBe(200);
    const headers = Object.fromEntries(
      [...res.headers].filter(([k]) => k !== "date"),
    );
    expect(headers).toEqual({
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=31536000, immutable, no-transform",
      "content-disposition": "inline",
      "content-length": String(PNG.length),
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "image/png",
      "cross-origin-resource-policy": "cross-origin",
      etag: `"${h}"`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    expect(IMG_IMMUTABLE).toBe(headers["cache-control"]);
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(h);
  });

  it("HEAD answers the same headers with no body; If-None-Match is a 304", async () => {
    const h = await host("djdl", "listing.screenshot:2", PNG);
    const head = await get(`${IMG}/djdl/a/${h}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(PNG.length));
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(await head.text()).toBe("");
    for (const inm of [`"${h}"`, `W/"${h}"`, `"x", "${h}"`, "*"]) {
      const res = await get(`${IMG}/djdl/a/${h}`, {
        headers: { "if-none-match": inm },
      });
      expect(res.status, inm).toBe(304);
      expect(res.headers.get("etag")).toBe(`"${h}"`);
      expectHardened(res, inm);
    }
    const miss = await get(`${IMG}/djdl/a/${h}`, {
      headers: { "if-none-match": '"other"' },
    });
    expect(miss.status).toBe(200);
  });

  it("no response reads or sets a cookie", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    for (const path of [
      `/djdl/a/${h}`,
      "/djdl/icon",
      "/manage",
      `/other/a/${h}`,
    ]) {
      const res = await get(IMG + path, {
        headers: { cookie: "__Host-pkey_admin=SENTINEL; pkey_portal=SENTINEL" },
      });
      expect(res.headers.get("set-cookie"), path).toBeNull();
      expect(JSON.stringify([...res.headers]), path).not.toContain("SENTINEL");
    }
  });

  it("a route's own Set-Cookie and Access-Control headers never survive the hardening", async () => {
    const { hardenImgHostResponse } = await import("../src/core/imgHost.js");
    const res = hardenImgHostResponse(
      new Response("x", {
        headers: {
          "set-cookie": "a=b",
          "access-control-allow-origin": "https://evil.example",
          "access-control-allow-credentials": "true",
          "content-security-policy": "script-src *",
        },
      }),
    );
    expectHardened(res, "policed");
  });

  it("a hash held only by another product is a 404 there", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    const res = await get(`${IMG}/other/a/${h}`);
    expect(res.status).toBe(404);
    expectHardened(res, "other");
    // …and an unknown product, the same.
    expect((await get(`${IMG}/nobody/a/${h}`)).status).toBe(404);
    // Once the other product hosts the same bytes itself, each serves them.
    await host("other", "listing.header", PNG);
    expect((await get(`${IMG}/other/a/${h}`)).status).toBe(200);
    expect((await get(`${IMG}/djdl/a/${h}`)).status).toBe(200);
  });

  it("a ref of another kind is not enough: only a hosted-asset ref serves", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    // `other` holds the same object as a release file ref, never as a hosted asset.
    await db.batch([
      stmtRecordRef(
        {
          product: "other",
          storageKey: blobKey(h),
          refKind: "release-file",
          refId: "r1",
        },
        NOW,
      ),
    ]);
    expect((await get(`${IMG}/other/a/${h}`)).status).toBe(404);
  });

  it("a hosted copy in a non-image slot (a release file) is never served, even if it is a PNG", async () => {
    const h = await host("djdl", "release-file:r1", PNG3);
    const row = await db.first<{ content_type: string }>(
      "SELECT content_type FROM hosted_assets WHERE product = 'djdl' AND slot = 'release-file:r1'",
    );
    expect(row?.content_type).toBe("image/png");
    expect((await get(`${IMG}/djdl/a/${h}`)).status).toBe(404);
  });

  it("a non-image type is never served, whatever the row says", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    for (const t of [
      "image/svg+xml",
      "text/html",
      "application/octet-stream",
      null,
    ]) {
      await db.run(
        "UPDATE hosted_assets SET content_type = ? WHERE product = 'djdl' AND slot = 'presentation.icon'",
        t,
      );
      expect((await get(`${IMG}/djdl/a/${h}`)).status, String(t)).toBe(404);
      expect((await get(`${IMG}/djdl/icon`)).status, String(t)).toBe(404);
    }
  });

  it("refuses anything gated: a gated/ object is a 404, never a 401", async () => {
    const h = sha(PNG2);
    const gatedKey = blobKey(h, { gated: true });
    await putVerified(asR2(r2), gatedKey, PNG2, {
      sha256: h,
      size: PNG2.length,
    });
    await recordObject(
      db,
      {
        storageKey: gatedKey,
        sha256: h,
        size: PNG2.length,
        kind: "blob",
        gated: true,
      },
      NOW,
    );
    await db.batch([
      {
        sql: `INSERT INTO hosted_assets (product, slot, locale, origin, source_kind, sha256, size,
                content_type, variants_json, status, modified_at)
              VALUES ('djdl', 'listing.header', '', 'console', 'upload', ?, ?, 'image/png', '[]',
                'ready', ?)`,
        params: [h, PNG2.length, NOW],
      },
      stmtRecordRef(
        {
          product: "djdl",
          storageKey: gatedKey,
          refKind: HOSTED_ASSET_REF,
          refId: "listing.header@",
        },
        NOW,
      ),
    ]);
    for (const path of [`/djdl/a/${h}`, "/djdl/header"]) {
      const res = await get(IMG + path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("www-authenticate"), path).toBeNull();
    }
  });

  it("an object missing from R2, or whose checksum disagrees with its name, is a 404", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    r2.tamper(blobKey(h), PNG2);
    expect((await get(`${IMG}/djdl/a/${h}`)).status).toBe(404);
    await r2.delete(blobKey(h));
    expect((await get(`${IMG}/djdl/a/${h}`)).status).toBe(404);
    expect(
      (await get(`${IMG}/djdl/a/${h}`, undefined, env({ BLOBS: undefined })))
        .status,
    ).toBe(404);
  });

  it("a replaced copy stops answering; a failed refresh keeps the last good copy serving", async () => {
    const old = await host("djdl", "presentation.icon", PNG);
    const fresh = await host("djdl", "presentation.icon", PNG2);
    expect((await get(`${IMG}/djdl/a/${old}`)).status).toBe(404);
    expect((await get(`${IMG}/djdl/a/${fresh}`)).status).toBe(200);
    // A refused re-ingest (not an image) leaves the row `failed` with its last good copy.
    const refused = await ingest(
      { env: { BLOBS: asR2(r2) }, db, now: NOW },
      "djdl",
      "presentation.icon",
      {
        kind: "stream",
        body: stream(enc("<svg/>")),
        size: 6,
        sourceKind: "upload",
        origin: "console",
      },
    );
    expect(refused.ok).toBe(false);
    expect((await get(`${IMG}/djdl/a/${fresh}`)).status).toBe(200);
    const alias = await get(`${IMG}/djdl/icon`);
    expect(alias.headers.get("location")).toBe(`${IMG}/djdl/a/${fresh}`);
  });

  it("a throw becomes the hardened JSON 500, never the runtime's HTML page", async () => {
    const broken = {
      all: () => Promise.reject(new Error("d1 down")),
      first: () => Promise.reject(new Error("d1 down")),
    } as unknown as Db;
    const res = await dispatchImgHost(
      new Request(`${IMG}/djdl/a/${"a".repeat(64)}`),
      env(),
      broken,
      NOW,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expectHardened(res, "500");
  });

  it("a rate-limited cache miss is a hardened 429", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    const limited = env({
      RL: {
        idFromName: (n: string) => n,
        get: () => ({
          fetch: async () => Response.json({ ok: false }),
        }),
      } as unknown as Env["RL"],
    });
    const res = await get(`${IMG}/djdl/a/${h}`, undefined, limited);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expectHardened(res, "429");
    // An unavailable limiter fails open: the images are public.
    const down = env({
      RL: {
        idFromName: (n: string) => n,
        get: () => ({
          fetch: async () => new Response("boom", { status: 500 }),
        }),
      } as unknown as Env["RL"],
    });
    expect((await get(`${IMG}/djdl/a/${h}`, undefined, down)).status).toBe(200);
  });
});

// ── Variants ─────────────────────────────────────────────────────────────────────────────────

describe("image host: variants", () => {
  it("serves a listed, held WebP variant as image/webp with the immutable headers", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    const v = await addVariant("djdl", "presentation.icon", 64, WEBP64);
    const res = await get(`${IMG}/djdl/a/${h}/64.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("etag")).toBe(`"${v}"`);
    expect(res.headers.get("cache-control")).toBe(IMG_IMMUTABLE);
    expectHardened(res, "variant");
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(v);
  });

  it("an unlisted width, an unheld variant or another product's original is a 404", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    await addVariant("djdl", "presentation.icon", 64, WEBP64);
    expect((await get(`${IMG}/djdl/a/${h}/128.webp`)).status).toBe(404);
    expect((await get(`${IMG}/other/a/${h}/64.webp`)).status).toBe(404);
    // Listed in variants_json but with no ref behind it: not served.
    const h2 = await host("djdl", "listing.header", PNG2);
    await addVariant("djdl", "listing.header", 640, filled(WEBP_SIG, 700, 17), {
      ref: false,
    });
    expect((await get(`${IMG}/djdl/a/${h2}/640.webp`)).status).toBe(404);
    // A format other than WebP is not a .webp variant.
    await addVariant(
      "djdl",
      "listing.header",
      1280,
      filled(WEBP_SIG, 800, 19),
      {
        format: "avif",
      },
    );
    expect((await get(`${IMG}/djdl/a/${h2}/1280.webp`)).status).toBe(404);
  });

  it("a variant's hash is not itself a servable original", async () => {
    await host("djdl", "presentation.icon", PNG);
    const v = await addVariant("djdl", "presentation.icon", 64, WEBP64);
    expect((await get(`${IMG}/djdl/a/${v}`)).status).toBe(404);
  });
});

// ── Aliases ──────────────────────────────────────────────────────────────────────────────────

describe("image host: stable aliases", () => {
  it("302 to the slot's current content-addressed URL, cached for five minutes", async () => {
    const icon = await host("djdl", "presentation.icon", PNG);
    const header = await host("djdl", "listing.header", PNG2);
    const shot = await host("djdl", "listing.screenshot:3", PNG3);
    for (const [path, h] of [
      ["/djdl/icon", icon],
      ["/djdl/header", header],
      ["/djdl/screenshots/3", shot],
    ] as const) {
      for (const method of ["GET", "HEAD"]) {
        const res = await get(IMG + path, { method });
        expect(res.status, path).toBe(302);
        expect(res.headers.get("location"), path).toBe(`${IMG}/djdl/a/${h}`);
        expect(res.headers.get("cache-control"), path).toBe(IMG_ALIAS_CACHE);
        expect(IMG_ALIAS_CACHE).toBe("public, max-age=300");
        expectHardened(res, path);
      }
    }
    expect((await get(`${IMG}/djdl/screenshots/4`)).status).toBe(404);
  });

  it("the icon alias falls back to the listing icon; a localised copy is not the default", async () => {
    expect((await get(`${IMG}/djdl/icon`)).status).toBe(404);
    await host("djdl", "presentation.icon", PNG2, "de");
    expect((await get(`${IMG}/djdl/icon`)).status).toBe(404);
    const listing = await host("djdl", "listing.icon", PNG);
    expect((await get(`${IMG}/djdl/icon`)).headers.get("location")).toBe(
      `${IMG}/djdl/a/${listing}`,
    );
    const own = await host("djdl", "presentation.icon", PNG3);
    expect((await get(`${IMG}/djdl/icon`)).headers.get("location")).toBe(
      `${IMG}/djdl/a/${own}`,
    );
  });

  it("an alias names the canonical origin, and another product's slot never answers", async () => {
    const h = await host("djdl", "presentation.icon", PNG);
    const res = await get(`${IMG}./djdl/icon`);
    expect(res.headers.get("location")).toBe(`${IMG}/djdl/a/${h}`);
    expect((await get(`${IMG}/other/icon`)).status).toBe(404);
  });
});
