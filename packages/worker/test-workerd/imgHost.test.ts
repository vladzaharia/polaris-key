/// <reference types="@cloudflare/workers-types" />
// ── The image host on workerd (HA-02) ─────────────────────────────────────────────────────
//
// The Node lane (`test/imgHost.test.ts`) covers the rules against `test/r2Mock.ts` and no Cache
// API. This file runs the host through the real Worker entry (`SELF`) on miniflare's R2, D1 and
// Cache API: the isolation, a hosted PNG served byte for byte with the pinned headers, the
// cache fill through `waitUntil` (a teed body), and the tenancy check that still runs when the
// bytes are cached.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HOSTED_ASSET_REF, ingest } from "../src/core/assets/hostedAssets.js";
import { IMG_CSP, IMG_IMMUTABLE } from "../src/core/assets/imgHost.js";
import { D1Db } from "../src/db/d1.js";
import { NOW, seedProduct } from "./seed.js";

const LANE = { timeout: 60_000 };
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536)
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65_536, n)));
  out.set(PNG_SIG, 0);
  return out;
}

async function hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function expectHardened(res: Response, at: string): void {
  expect(res.headers.get("content-security-policy"), at).toBe(IMG_CSP);
  expect(res.headers.get("x-content-type-options"), at).toBe("nosniff");
  expect(res.headers.get("access-control-allow-origin"), at).toBe("*");
  expect(res.headers.get("cross-origin-resource-policy"), at).toBe(
    "cross-origin",
  );
  expect(res.headers.get("set-cookie"), at).toBeNull();
}

describe("image host isolation on workerd", () => {
  it("console, docs, product, byte and registry paths answer the hardened not-found", async () => {
    for (const host of ["img.workerd.test", "img.workerd.test."])
      for (const path of [
        "/",
        "/manage",
        "/docs",
        "/favicon.ico",
        "/djdl/.well-known/polaris.json",
        "/djdl/distribution/download",
        "/npm/djdl/x",
        "/v2/",
      ]) {
        const res = await SELF.fetch(`https://${host}${path}`, {
          headers: { cookie: "__Host-pkey_admin=x" },
        });
        const at = host + path;
        expect(res.status, at).toBe(404);
        expect(await res.json(), at).toEqual({ error: "not_found" });
        expectHardened(res, at);
      }
  });
});

describe("image host serving on workerd", LANE, () => {
  it("serves a hosted PNG with the pinned headers, from R2 and then from the cache", async () => {
    const db = new D1Db(env.DB);
    await seedProduct(env, db, "img-a", { schemaVersion: 1, entries: [] });
    await seedProduct(env, db, "img-b", { schemaVersion: 1, entries: [] });
    const bytes = png(200_000);
    const h = await hex(bytes);
    const res = await ingest(
      { env: { BLOBS: env.BLOBS }, db, now: NOW },
      "img-a",
      "presentation.icon",
      {
        kind: "stream",
        body: new Response(bytes).body!,
        size: bytes.length,
        sourceKind: "upload",
        origin: "console",
      },
    );
    expect(res).toMatchObject({ ok: true, sha256: h });

    for (const round of ["miss", "hit"]) {
      const got = await SELF.fetch(`https://img.workerd.test/img-a/a/${h}`);
      expect(got.status, round).toBe(200);
      expect(got.headers.get("content-type"), round).toBe("image/png");
      expect(got.headers.get("cache-control"), round).toBe(IMG_IMMUTABLE);
      expect(got.headers.get("etag"), round).toBe(`"${h}"`);
      expectHardened(got, round);
      expect(await hex(new Uint8Array(await got.arrayBuffer())), round).toBe(h);
    }

    const alias = await SELF.fetch("https://img.workerd.test/img-a/icon", {
      redirect: "manual",
    });
    expect(alias.status).toBe(302);
    expect(alias.headers.get("location")).toBe(
      `https://img.workerd.test/img-a/a/${h}`,
    );

    // Another product never gets the bytes, cached or not.
    const other = await SELF.fetch(`https://img.workerd.test/img-b/a/${h}`);
    expect(other.status).toBe(404);
    await other.body?.cancel();

    // The tenancy check is never cached: dropping the ref stops the answer at once.
    await db.run(
      "DELETE FROM blob_refs WHERE product = ? AND ref_kind = ?",
      "img-a",
      HOSTED_ASSET_REF,
    );
    const gone = await SELF.fetch(`https://img.workerd.test/img-a/a/${h}`);
    expect(gone.status).toBe(404);
    expectHardened(gone, "gone");
    await gone.body?.cancel();
  });
});
