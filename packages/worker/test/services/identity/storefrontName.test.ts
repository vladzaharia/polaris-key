/**
 * LK-12d: `GET /api/storefront/<product>` answers a product's name and icon to a signed-out
 * visitor only when Discover would offer a new account an Add action; everything else is one
 * uniform 404.
 */
import { describe, expect, it } from "vitest";
import { writeListing } from "../../listingWrites.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW, setPortalToggles } from "../../seed.js";
import { setup } from "../../discoverFixture.js";
import { seedHosted } from "../../hostedFixture.js";
import { handlePortalApi } from "../../portalHarness.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";

const IMG = "https://img.example.test";
const A = "a".repeat(64);

function env(img = true): Env {
  const e = makeEnv(new KvMock(), []);
  if (img) e.IMG_ORIGIN = IMG;
  return e;
}

function get(
  e: Env,
  db: Db,
  slug: string,
  init: RequestInit = {},
  ip = "203.0.113.7",
) {
  return handlePortalApi(
    new Request(`https://key.plrs.im/api/storefront/${slug}`, {
      headers: { "cf-connecting-ip": ip },
      ...init,
    }),
    e,
    db,
    `/api/storefront/${slug}`,
    NOW,
  );
}

const headersOf = (r: Response) => [...r.headers].sort();

describe("GET /api/storefront/<product> (LK-12d)", () => {
  it("a Discover-visible product: name and icon, public cache, no cookie", async () => {
    const db = makeTestDb();
    await setup(db, "free");
    await seedHosted(db, "free", "presentation.icon", {
      sha256: A,
      widths: [64, 128, 256],
    });
    const res = await get(env(), db, "free", {
      headers: { cookie: "__Host-pkey_portal=whatever" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({
      name: expect.any(String),
      iconUrl: `${IMG}/free/a/${A}/128.webp`,
    });
  });

  it("iconUrl is null without a hosted copy or an image host", async () => {
    const db = makeTestDb();
    await setup(db, "free");
    expect(await (await get(env(), db, "free")).json()).toMatchObject({
      iconUrl: null,
    });
    await seedHosted(db, "free", "presentation.icon", {
      sha256: A,
      widths: [128],
    });
    expect(await (await get(env(false), db, "free")).json()).toMatchObject({
      iconUrl: null,
    });
  });

  it("answers one uniform 404 for unknown, unlisted, purchase-only, portal off, storefront off, Identity off and a bad slug", async () => {
    const db = makeTestDb();
    await setup(db, "unlisted");
    await writeListing(db, "unlisted", { storeListed: "unlisted" });
    await setup(db, "paid", { free: false });
    await setup(db, "portaloff");
    await setPortalToggles(db, "portaloff", { portalEnabled: false }, NOW);
    await setup(db, "noid", { identity: false });
    const slugs = [
      "nobody",
      "unlisted",
      "paid",
      "portaloff",
      "noid",
      "Bad_Slug",
      "x".repeat(80),
    ];
    const seen: { status: number; body: string; headers: unknown }[] = [];
    for (const s of slugs) {
      const r = await get(env(), db, s);
      seen.push({
        status: r.status,
        body: await r.text(),
        headers: headersOf(r),
      });
    }
    for (const r of seen) expect(r).toEqual(seen[0]);
    expect(seen[0]!.status).toBe(404);
    expect(seen[0]!.headers).toContainEqual(["cache-control", "no-store"]);

    // The deployment's storefront off: a visible product turns into the same 404.
    await setup(db, "free");
    await db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('storefront.polarisKey.enabled', '"off"', 2, ?, 'u1')`,
      NOW,
    );
    const off = await get(env(), db, "free");
    expect({
      status: off.status,
      body: await off.text(),
      headers: headersOf(off),
    }).toEqual(seen[0]);
  });

  it("is per-network rate limited, and refuses other methods", async () => {
    const db = makeTestDb();
    await setup(db, "free");
    const e = env();
    const post = await get(e, db, "free", { method: "POST" });
    expect(post.status).toBe(405);
    let last = 200;
    for (let i = 0; i < 61; i++)
      last = (await get(e, db, "free", {}, "198.51.100.9")).status;
    expect(last).toBe(429);
    expect((await get(e, db, "free", {}, "198.51.100.200")).status).toBe(200);
  });
});

describe("GET /api/capabilities?product= (LK-FU-2, PX-33)", () => {
  const caps = (e: Env, db: Db, slug: string) =>
    handlePortalApi(
      new Request(`https://key.plrs.im/api/capabilities?product=${slug}`),
      e,
      db,
      "/api/capabilities",
      NOW,
    );

  it("names a Discover-visible product with its header art", async () => {
    const db = makeTestDb();
    await setup(db, "free");
    await seedHosted(db, "free", "listing.header", {
      sha256: A,
      widths: [640],
    });
    const body = (await (await caps(env(), db, "free")).json()) as {
      product?: { slug: string; name: string; artUrl?: string };
    };
    expect(body.product).toEqual({
      slug: "free",
      name: expect.any(String),
      artUrl: `${IMG}/free/a/${A}/640.webp`,
    });
  });

  it("omits the product wherever the storefront route would 404, and with no ?product", async () => {
    const db = makeTestDb();
    await setup(db, "unlisted");
    await writeListing(db, "unlisted", { storeListed: "unlisted" });
    for (const s of ["unlisted", "nobody"])
      expect(await (await caps(env(), db, s)).json()).not.toHaveProperty(
        "product",
      );
  });
});
