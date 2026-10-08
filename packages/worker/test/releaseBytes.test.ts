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
import {
  stmtSetArtifactModel,
  stmtUpsertBuild,
} from "../src/services/release/model.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { checkReleaseHealth } from "../src/services/release/health.js";
import {
  ASSET_BYTES,
  BYTES,
  bytesOf,
  call,
  CONSOLE,
  enableServices,
  envFor,
  github,
  release,
  RELEASES,
  seedReleaseProduct,
  sha256Hex,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { mkReq, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";

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
      "public, max-age=3600, no-transform",
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
      "public, max-age=3600, no-transform",
    );
  });

  it("an artifact whose only location is a gated/ key answers not-found to an anonymous request", async () => {
    // Gated content is authorised per request (THREAT-MODEL §3), and that check is P2b-04 /
    // P4-05's. Until it exists, a `public` product's access mode must not stand in for it.
    const s = await setup();
    const bytes = ASSET_BYTES[201]!;
    const hex = sha256Hex(bytes);
    const key = blobKey(hex, { gated: true });
    const put = await putVerified(asR2(s.r2), key, bytes, {
      sha256: hex,
      size: bytes.length,
    });
    expect(put.ok).toBe(true);
    await recordObject(
      s.db,
      {
        storageKey: key,
        sha256: hex,
        size: bytes.length,
        kind: "blob",
        gated: true,
      },
      NOW,
    );
    await recordRef(
      s.db,
      {
        product: SLUG,
        storageKey: key,
        refKind: "artifact",
        refId: `${SLUG}:g`,
      },
      NOW,
    );
    const set = stmtSetArtifactModel({
      product: SLUG,
      releaseId: "v1.1.0",
      artifactId: "201",
      buildId: "cli-arm64",
      role: "payload",
      sha256: hex,
      storageKey: key,
      locationsJson: JSON.stringify([{ provider: "r2", key }]),
    });
    await s.db.run(set.sql, ...set.params);
    s.gh.calls.api.length = 0;

    for (const origin of [BYTES, CONSOLE]) {
      for (const p of [
        "/release/builds/stable/cli-arm64",
        "/release/builds/1.1.0/cli-arm64",
        "/release/files/v1.1.0/djdl-arm64",
      ]) {
        const res = await get(s, `${origin}/${SLUG}${p}`);
        expect(res.status, `${origin}${p}`).toBe(404);
        expect(new Uint8Array(await res.arrayBuffer())).not.toEqual(bytes);
      }
    }
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
      "public, max-age=3600, no-transform",
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ASSET_BYTES[102]);
  });
});

describe("the entitled access mode on the build, file and blob routes", () => {
  /** v1.0.0, v1.1.0 and a four-part `v1.2.3.4`, each with the `cli-arm64` build. */
  async function entitledSetup(window: { maxVersion: string }) {
    const db = makeTestDb();
    await seedReleaseProduct(db, { artifacts_access: "entitled" });
    const env = envFor({ blobOrigin: BYTES });
    const r2 = new R2Mock();
    env.BLOBS = asR2(r2);
    const fourPart = release("v1.2.3.4", [
      {
        id: 301,
        name: "djdl-arm64",
        size: ASSET_BYTES[301]!.length,
        content_type: "application/octet-stream",
        browser_download_url:
          "https://github.com/acme/djdl/releases/download/v1.2.3.4/djdl-arm64",
      },
    ]);
    const gh = github({ releases: [fourPart, ...RELEASES] });
    await syncAndDescribe(env, db, gh.fetchImpl);
    const b = stmtUpsertBuild(
      {
        product: SLUG,
        releaseId: "v1.2.3.4",
        buildId: "cli-arm64",
        platform: "macos",
        arch: "arm64",
        format: "binary",
      },
      NOW,
    );
    await db.run(b.sql, ...b.params);
    const a = stmtSetArtifactModel({
      product: SLUG,
      releaseId: "v1.2.3.4",
      artifactId: "301",
      buildId: "cli-arm64",
      role: "payload",
      sha256: sha256Hex(ASSET_BYTES[301]!),
    });
    await db.run(a.sql, ...a.params);

    const { key } = await seedLicenseWithKey(db, SLUG, window);
    const product = (await loadProduct(env, db, SLUG))!;
    const act = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(act.status).toBe(200);
    const token = ((await act.json()) as { token: string }).token;
    return { env, db, gh, r2, token };
  }

  it("a version the window cannot order (four-part, non-semver) is refused, never waved through", async () => {
    // `compareSemver` calls an unparseable version equal to both bounds, so without the
    // fail-closed rule `1.2.3.4` passes a licence capped at 1.0.0.
    const s = await entitledSetup({ maxVersion: "1.0.0" });
    const auth = { headers: { authorization: `Bearer ${s.token}` } };
    for (const origin of [BYTES, CONSOLE]) {
      for (const [p, code] of [
        ["/release/builds/1.2.3.4/cli-arm64", "version_blocked"],
        ["/release/files/v1.2.3.4/djdl-arm64", "version_blocked"],
        // A `v`-prefixed selector is not a version selector: an unknown channel, refused.
        ["/release/builds/v1.2.3.4/cli-arm64", "channel_not_allowed"],
        // …and the semver control: outside the window, refused as before.
        ["/release/builds/1.1.0/cli-arm64", "version_blocked"],
        ["/release/files/v1.1.0/djdl-arm64", "version_blocked"],
      ] as const) {
        const res = await get(s, `${origin}/${SLUG}${p}`, auth);
        expect(res.status, `${origin}${p}`).toBe(403);
        expect(await res.json(), `${origin}${p}`).toMatchObject({
          error: { code },
        });
      }
      // Inside the window, served.
      const ok = await get(
        s,
        `${origin}/${SLUG}/release/builds/1.0.0/cli-arm64`,
        auth,
      );
      expect(ok.status, origin).toBe(200);
      expect(new Uint8Array(await ok.arrayBuffer())).toEqual(ASSET_BYTES[101]);
    }
  });

  it("a blob is served only if a release carrying its digest passes the licence's window", async () => {
    // The gateway's decision for a blob names no version, so it proves only a usable licence;
    // without the per-release check, a licence capped at 1.0.0 could fetch v1.1.0 by hash.
    const s = await entitledSetup({ maxVersion: "1.0.0" });
    const auth = { headers: { authorization: `Bearer ${s.token}` } };
    const digest = async (
      releaseId: string,
      artifactId: string,
      bytes: Uint8Array,
      buildId: string | null,
    ) => {
      await storeBlob(s.db, s.r2, SLUG, bytes);
      const set = stmtSetArtifactModel({
        product: SLUG,
        releaseId,
        artifactId,
        buildId,
        role: "payload",
        sha256: sha256Hex(bytes),
      });
      await s.db.run(set.sql, ...set.params);
      return sha256Hex(bytes);
    };
    const v100 = await digest("v1.0.0", "101", ASSET_BYTES[101]!, "cli-arm64");
    const v110 = await digest("v1.1.0", "201", ASSET_BYTES[201]!, "cli-arm64");
    // The four-part release's payload already carries its digest (entitledSetup).
    await storeBlob(s.db, s.r2, SLUG, ASSET_BYTES[301]!);
    const v1234 = sha256Hex(ASSET_BYTES[301]!);
    // Identical bytes in a release inside the window and one outside it: served.
    const SHARED = bytesOf(2048, 5);
    await digest("v1.0.0", "102", SHARED, null);
    const shared = await digest("v1.1.0", "202", SHARED, null);
    // Referenced by this product, but by no release artifact (a pack object, say).
    await storeBlob(s.db, s.r2, SLUG, BLOB);

    for (const origin of [BYTES, CONSOLE]) {
      const at = (hex: string) =>
        `${origin}/${SLUG}/release/blobs/sha256/${hex}`;
      for (const [hex, code] of [
        [v110, "version_blocked"],
        [v1234, "version_blocked"],
      ] as const) {
        // SEC-DST-12: out of the window is the plain not-found on the blob route, the same
        // answer as a digest this product never held (no hash-existence oracle for a licensee).
        const res = await get(s, at(hex), auth);
        expect(res.status, `${origin} ${hex} ${code}`).toBe(404);
        expect(await res.json(), `${origin} ${hex}`).toEqual(
          await (await get(s, at("e".repeat(64)), auth)).json(),
        );
      }
      const orphan = await get(s, at(BLOB_HEX), auth);
      expect(orphan.status, origin).toBe(404);

      const ok = await get(s, at(v100), auth);
      expect(ok.status, origin).toBe(200);
      expect(new Uint8Array(await ok.arrayBuffer())).toEqual(ASSET_BYTES[101]);
      const both = await get(s, at(shared), auth);
      expect(both.status, origin).toBe(200);
      expect(new Uint8Array(await both.arrayBuffer())).toEqual(SHARED);

      // No device token: refused before any release is looked at.
      const anon = await get(s, at(v100));
      expect(anon.status, origin).toBe(401);
    }
  });

  it("a release's stored version is never re-read as a moving selector (tags latest, stable, pr-N, a manual channel)", async () => {
    // The sync stores `versionFromTag(tag)`, so a rolling prerelease tagged `latest` has the
    // version `latest`. Read as a route selector that is the moving stable channel — no window,
    // and every grant holds stable — so a licence capped at 1.0.0 with no beta grant fetched
    // the prerelease's bytes by file and by hash. `pr-5` and a manual `nightly` were checked as
    // moving channels the licence holds, again with no window. A stored version is the version
    // of one fixed release: window-checked, and refused when the window cannot order it.
    const db = makeTestDb();
    await seedReleaseProduct(db, {
      artifacts_access: "entitled",
      manual_channels_json: JSON.stringify([
        { name: "nightly", regex: "nightly" },
      ]),
    });
    const env = envFor({ blobOrigin: BYTES });
    const r2 = new R2Mock();
    env.BLOBS = asR2(r2);
    const rolling = [
      ["latest", 401],
      ["stable", 402],
      ["pr-5", 403],
      ["nightly", 404],
    ] as const;
    for (const [i, [, id]] of rolling.entries())
      ASSET_BYTES[id] = bytesOf(4000 + i, 40 + i);
    const gh = github({
      releases: [
        ...rolling.map(([tag, id]) =>
          release(
            tag,
            [
              {
                id,
                name: "djdl-arm64",
                size: ASSET_BYTES[id]!.length,
                content_type: "application/octet-stream",
                browser_download_url: `https://github.com/acme/djdl/releases/download/${tag}/djdl-arm64`,
              },
            ],
            { prerelease: true },
          ),
        ),
        ...RELEASES,
      ],
    });
    await syncAndDescribe(env, db, gh.fetchImpl);
    const digests: [string, string][] = [];
    for (const [tag, id] of rolling) {
      const bytes = ASSET_BYTES[id]!;
      await storeBlob(db, r2, SLUG, bytes);
      const set = stmtSetArtifactModel({
        product: SLUG,
        releaseId: tag,
        artifactId: String(id),
        buildId: null,
        role: "payload",
        sha256: sha256Hex(bytes),
      });
      await db.run(set.sql, ...set.params);
      digests.push([tag, sha256Hex(bytes)]);
    }
    // Stable plus the two moving channels, capped at 1.0.0: no beta grant.
    const { key } = await seedLicenseWithKey(db, SLUG, {
      maxVersion: "1.0.0",
      channels: ["stable", "pr", "nightly"],
    });
    const product = (await loadProduct(env, db, SLUG))!;
    const act = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(act.status).toBe(200);
    const token = ((await act.json()) as { token: string }).token;
    const s = { env, db, gh };
    const auth = { headers: { authorization: `Bearer ${token}` } };

    for (const origin of [BYTES, CONSOLE]) {
      for (const [tag, hex] of digests) {
        for (const p of [
          `/release/files/${tag}/djdl-arm64`,
          `/release/blobs/sha256/${hex}`,
        ]) {
          const res = await get(s, `${origin}/${SLUG}${p}`, auth);
          if (p.includes("/blobs/")) {
            // SEC-DST-12: the blob route answers the plain not-found (no hash oracle).
            expect(res.status, `${origin}${p}`).toBe(404);
            continue;
          }
          expect(res.status, `${origin}${p}`).toBe(403);
          expect(await res.json(), `${origin}${p}`).toMatchObject({
            error: { code: "version_blocked" },
            allowedRange: { max: "1.0.0" },
          });
        }
      }
      // Controls: a file inside the window is served; one outside it, and the beta channel the
      // licence does not hold, are refused as before.
      const ok = await get(
        s,
        `${origin}/${SLUG}/release/files/v1.0.0/djdl-arm64`,
        auth,
      );
      expect(ok.status, origin).toBe(200);
      expect(new Uint8Array(await ok.arrayBuffer())).toEqual(ASSET_BYTES[101]);
      const outside = await get(
        s,
        `${origin}/${SLUG}/release/files/v1.1.0/djdl-arm64`,
        auth,
      );
      expect(outside.status, origin).toBe(403);
      expect(await outside.json()).toMatchObject({
        error: { code: "version_blocked" },
      });
      const beta = await get(
        s,
        `${origin}/${SLUG}/release/builds/beta/cli-arm64`,
        auth,
      );
      expect(beta.status, origin).toBe(403);
      expect(await beta.json()).toMatchObject({
        error: { code: "channel_not_allowed" },
      });
    }
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

  it("the health check and the download paths share one cached resolution", async () => {
    const s = await setup();
    s.gh.calls.api.length = 0;
    const health = await checkReleaseHealth(
      s.env,
      s.db,
      SLUG,
      NOW,
      s.gh.fetchImpl,
    );
    expect(health.release?.tag).toBe("v1.1.0");
    const lists = () =>
      s.gh.calls.api.filter((u) => /\/releases\?per_page=/.test(u)).length;
    expect(lists()).toBe(1);
    for (const path of [
      "/update/version",
      "/update/appcast.xml?arch=arm64",
      "/release/dl/latest/djdl-arm64?checksum=sha256",
    ])
      await get(s, `${CONSOLE}/${SLUG}${path}`);
    await checkReleaseHealth(s.env, s.db, SLUG, NOW, s.gh.fetchImpl);
    expect(lists()).toBe(1);
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
    // P2b-04: byte delivery is Distribution's, and its fragment advertises the CANONICAL URLs.
    const body = (await res.json()) as {
      services: {
        release: { endpoints: Record<string, string> };
        distribution: { endpoints: Record<string, string> };
      };
    };
    expect(body.services.distribution.endpoints).toMatchObject({
      download: `${CONSOLE}/${SLUG}/distribution/dl`,
      install: `${CONSOLE}/${SLUG}/distribution/install.sh`,
      builds: `${BYTES}/${SLUG}/distribution/builds/{selector}/{buildId}`,
      blobs: `${BYTES}/${SLUG}/distribution/blobs/sha256/{sha256}`,
    });
    // Release's own keys stay (the document is wire); they name the permanent aliases.
    expect(body.services.release.endpoints).toMatchObject({
      download: `${CONSOLE}/${SLUG}/release/dl`,
      builds: `${BYTES}/${SLUG}/release/builds/{selector}/{buildId}`,
      blobs: `${BYTES}/${SLUG}/release/blobs/sha256/{sha256}`,
    });
  });
});
