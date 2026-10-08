/**
 * HA-07 (notes/S-20 §6.8): the portal serves Polaris Key's hosted copies of a product's art.
 *
 *   - the library, the product page and Discover hand out image-host URLs, each at the ladder
 *     width its surface draws at, chosen exactly as the image host's `/icon` and `/header` aliases
 *     choose the slot; never a developer URL;
 *   - `/media/<p>/{icon,header}` fetches nothing for a slot with a copy: a 302 to the image host's
 *     stable alias;
 *   - PER SLOT, a slot with no copy (production at deploy: no product has resynced since HA-05)
 *     keeps exactly its pre-HA-07 art, the `/media` proxy URL, and `/media` proxies it;
 *   - the sign-in card's client record keeps §12.7.2's same-origin `/media/<p>/icon`;
 *   - the portal shell's CSP admits exactly the image host;
 *   - with the kill switch off (HA-10's platform setting `assets.hosting.enabled`, switched here
 *     as the console switches it) or no image host, every one of these is what it was before
 *     HA-07.
 */

import { describe, expect, it } from "vitest";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { seedHosted, setAssetHosting } from "./hostedFixture.js";
import { handlePortalApi, portalHooksFor } from "./portalHarness.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { loadProductPublic } from "../src/core/products.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import { handlePortal } from "../src/services/identity/portal/index.js";
import {
  PRESENTATION_WIDTHS,
  presentationFor,
} from "../src/services/identity/portal/library.js";
import {
  MEDIA_CSP,
  MEDIA_SHORT,
  handlePortalMedia,
  mediaVersion,
} from "../src/services/identity/portal/media.js";
import { clientRecordFor } from "../src/services/identity/passthrough/client.js";
import { pickVariantWidth } from "../src/core/hostedImages.js";

const PORTAL_SECRET = "test-portal-session-secret";
const IMG = "https://img.example.test";
const ICON =
  "https://raw.githubusercontent.com/fennick/tidewater/main/icon.png";
const HEADER = "https://raw.githubusercontent.com/fennick/tidewater/main/h.png";
const A = "a".repeat(64);
const B = "b".repeat(64);
const H = "c".repeat(64);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);

function portalEnv(img: string | null = IMG): Env {
  const env = makeEnv(new KvMock(), []);
  env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  if (img !== null) env.IMG_ORIGIN = img;
  return env;
}

async function tidewater(db: Db): Promise<void> {
  await seedProduct(db, "tidewater");
  await setServices(
    db,
    "tidewater",
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: true },
        update: { enabled: false },
        identity: { enabled: false },
        sync: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO dist_listing (product, listing_json, modified_at) VALUES (?, ?, ?)",
    "tidewater",
    JSON.stringify({
      name: "Tidewater",
      icon: { kind: "url", src: ICON },
      header: { kind: "url", src: HEADER },
    }),
    NOW,
  );
}

async function signedIn(
  env: Env,
  db: Db,
): Promise<{ cookie: string; csrf: string }> {
  const account = await getOrCreateAccountByEmail(
    db,
    "mara@fennick.studio",
    NOW,
  );
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  const { licenseId } = await seedLicenseWithKey(db, "tidewater", {
    id: "lic_tw",
  });
  await linkLicense(db, account.id, "tidewater", licenseId, "admin", NOW);
  return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf };
}

async function api(
  env: Env,
  db: Db,
  path: string,
  s: { cookie: string; csrf: string },
): Promise<Record<string, any>> {
  const res = await handlePortalApi(
    new Request(`https://key.plrs.im${path}`, {
      headers: { cookie: s.cookie, [PORTAL_CSRF_HEADER]: s.csrf },
    }),
    env,
    db,
    path,
    NOW,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Record<string, any>;
}

/** A fetch that records every call and answers a PNG: proves whether the route fetched. */
function recorder() {
  const calls: string[] = [];
  const fetchImpl = async (input: Request | string) => {
    calls.push(typeof input === "string" ? input : input.url);
    return new Response(PNG, { headers: { "content-type": "image/png" } });
  };
  return { calls, fetchImpl };
}

async function media(
  env: Env,
  db: Db,
  path: string,
  fetchImpl: (input: Request | string) => Promise<Response>,
): Promise<Response> {
  const m = path.match(/^\/media\/([^/?]+)\/([^/?]+)/)!;
  return handlePortalMedia(
    new Request(`https://key.plrs.im${path}`),
    env,
    db,
    m[1]!,
    m[2]!,
    NOW,
    portalHooksFor(env, db),
    fetchImpl,
  );
}

describe("the variant choice (core/hostedImages.ts)", () => {
  it("is the narrowest rung at least as wide, else the original", () => {
    expect(pickVariantWidth([64, 128, 256, 512, 1024], 128)).toBe(128);
    expect(pickVariantWidth([64, 128, 256, 512, 1024], 200)).toBe(256);
    expect(pickVariantWidth([64, 128], 256)).toBeNull();
    expect(pickVariantWidth([], 64)).toBeNull();
  });
});

describe("the portal's presentation on hosted copies", () => {
  it("library and product page: image-host URLs at each surface's width, no developer URL", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    await seedHosted(db, "tidewater", "presentation.icon", {
      sha256: A,
      widths: [64, 128, 256, 512],
    });
    await seedHosted(db, "tidewater", "listing.header", {
      sha256: H,
      widths: [640, 1280],
    });
    const s = await signedIn(env, db);

    const library = await api(env, db, "/api/library", s);
    expect(library.products[0]).toMatchObject({
      iconUrl: `${IMG}/tidewater/a/${A}/${PRESENTATION_WIDTHS.library.icon}.webp`,
      headerUrl: `${IMG}/tidewater/a/${H}/${PRESENTATION_WIDTHS.library.header}.webp`,
    });
    // The product page draws a 112 px icon and a full-width banner: wider rungs. The header's
    // ladder stops at 1280 (a 1280 px original), so its 1920 ask gets the original.
    const product = await api(env, db, "/api/products/tidewater", s);
    expect(product).toMatchObject({
      iconUrl: `${IMG}/tidewater/a/${A}/256.webp`,
      headerUrl: `${IMG}/tidewater/a/${H}`,
    });
    for (const body of [library, product]) {
      expect(JSON.stringify(body)).not.toContain("githubusercontent");
      expect(JSON.stringify(body)).not.toContain("/media/");
    }
  });

  it("the key previews, signed in and signed out, carry the same hosted art (HA-07)", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    await seedHosted(db, "tidewater", "presentation.icon", {
      sha256: A,
      widths: [64, 128, 256, 512],
    });
    await seedHosted(db, "tidewater", "listing.header", {
      sha256: H,
      widths: [640, 1280],
    });
    // The product's own accent (`.pkey/product` presentation) is the tint, as the library's.
    await db.run(
      "UPDATE products SET presentation_json = ? WHERE slug = 'tidewater'",
      JSON.stringify({ accent: "#1F6FEB" }),
    );
    const s = await signedIn(env, db);
    const { key } = await seedLicenseWithKey(db, "tidewater", {
      id: "lic_new",
    });
    const preview = async (path: string, session: boolean) => {
      const res = await handlePortalApi(
        new Request(`https://key.plrs.im${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(session
              ? { cookie: s.cookie, [PORTAL_CSRF_HEADER]: s.csrf }
              : {}),
          },
          body: JSON.stringify({ key }),
        }),
        env,
        db,
        path,
        NOW,
      );
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { product: Record<string, unknown> })
        .product;
    };
    // The confirm step draws the art at a library tile's size, in the library's tint.
    const art = {
      slug: "tidewater",
      tintColor: "#1f6feb",
      iconUrl: `${IMG}/tidewater/a/${A}/${PRESENTATION_WIDTHS.library.icon}.webp`,
      headerUrl: `${IMG}/tidewater/a/${H}/${PRESENTATION_WIDTHS.library.header}.webp`,
    };
    const signedInPreview = await preview("/api/activate/preview", true);
    // Signed in, the name is the library's: the listing's display name, not the product row's.
    expect(signedInPreview).toMatchObject({ ...art, name: "Tidewater" });
    // Signed out there are no listing hooks, so the product row's name stands.
    expect(await preview("/api/key/preview", false)).toMatchObject({
      ...art,
      name: "tidewater",
    });
    expect(JSON.stringify(signedInPreview)).not.toContain("githubusercontent");
  });

  it("chooses the slot as the image host's /icon alias does, and only a copy the host serves", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    // presentation.icon has no ref to its copy (the host would not serve it): listing.icon wins.
    await seedHosted(db, "tidewater", "presentation.icon", {
      sha256: A,
      ref: false,
    });
    await seedHosted(db, "tidewater", "listing.icon", { sha256: B });
    // A first pull still in flight has no copy at all.
    await seedHosted(db, "tidewater", "listing.header", {
      sha256: null,
      status: "pending",
    });
    const product = (await loadProductPublic(db, "tidewater"))!;
    const p = await presentationFor(
      env,
      db,
      product,
      portalHooksFor(env, db),
      NOW,
      "discover",
    );
    // No ladder: the original.
    expect(p.iconUrl).toBe(`${IMG}/tidewater/a/${B}`);
    // No copy of the header: its pre-HA-07 proxy URL.
    expect(p.headerUrl).toBe(
      `/media/tidewater/header?v=${await mediaVersion(HEADER)}`,
    );
  });

  it("hosting on but no copies at all (no resync since HA-05): exactly the pre-HA-07 presentation", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await tidewater(db);
    const s = await signedIn(env, db);
    const library = await api(env, db, "/api/library", s);
    const product = await api(env, db, "/api/products/tidewater", s);
    for (const body of [library.products[0], product])
      expect(body).toMatchObject({
        iconUrl: `/media/tidewater/icon?v=${await mediaVersion(ICON)}`,
        headerUrl: `/media/tidewater/header?v=${await mediaVersion(HEADER)}`,
      });
    // Byte-identical to the rollback's answer.
    await setAssetHosting(env, db, "off");
    expect((await api(env, db, "/api/library", s)).products[0]).toEqual(
      library.products[0],
    );
  });

  it("an icon copy but no header copy: the hosted icon and the proxied header", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    await seedHosted(db, "tidewater", "presentation.icon", {
      sha256: A,
      widths: [64, 128, 256],
    });
    const s = await signedIn(env, db);
    const library = await api(env, db, "/api/library", s);
    expect(library.products[0]).toMatchObject({
      iconUrl: `${IMG}/tidewater/a/${A}/128.webp`,
      headerUrl: `/media/tidewater/header?v=${await mediaVersion(HEADER)}`,
    });
  });

  it("keeps serving a failed or stale re-pull's last good copy, as the image host does", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    await seedHosted(db, "tidewater", "presentation.icon", {
      sha256: A,
      status: "stale",
    });
    const product = (await loadProductPublic(db, "tidewater"))!;
    const p = await presentationFor(
      env,
      db,
      product,
      portalHooksFor(env, db),
      NOW,
      "library",
    );
    expect(p.iconUrl).toBe(`${IMG}/tidewater/a/${A}`);
  });

  it("the client record keeps §12.7.2's same-origin /media/<p>/icon, versioned by the copy", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    const product = (await loadProductPublic(db, "tidewater"))!;
    const none = await clientRecordFor(
      env,
      db,
      product,
      "web",
      NOW,
      portalHooksFor(env, db),
    );
    // No copy yet: the proxy URL it always was.
    expect(none.iconUrl).toBe(
      `/media/tidewater/icon?v=${await mediaVersion(ICON)}`,
    );
    await seedHosted(db, "tidewater", "listing.icon", { sha256: B });
    const rec = await clientRecordFor(
      env,
      db,
      product,
      "web",
      NOW,
      portalHooksFor(env, db),
    );
    expect(rec.iconUrl).toBe(`/media/tidewater/icon?v=${B.slice(0, 16)}`);
  });
});

describe("GET /media/<p>/<asset> redirects to the hosted copy, else proxies per slot", () => {
  it("302s to the image host's stable alias and fetches nothing", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    await seedHosted(db, "tidewater", "presentation.icon", { sha256: A });
    await seedHosted(db, "tidewater", "listing.header", { sha256: H });
    const up = recorder();
    for (const asset of ["icon", "header"]) {
      const res = await media(
        env,
        db,
        `/media/tidewater/${asset}?v=1`,
        up.fetchImpl,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${IMG}/tidewater/${asset}`);
      expect(res.headers.get("cache-control")).toBe(MEDIA_SHORT);
      expect(res.headers.get("content-security-policy")).toBe(MEDIA_CSP);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(up.calls).toEqual([]);
  });

  it("a slot with no copy is proxied exactly as before HA-07, so a deploy never blanks the art", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    const up = recorder();
    const res = await media(env, db, "/media/tidewater/icon", up.fetchImpl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toBe(MEDIA_CSP);
    expect(up.calls).toEqual([ICON]);
  });

  it("per slot: the icon with a copy redirects (no fetch), the header without one is proxied", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    await seedHosted(db, "tidewater", "presentation.icon", { sha256: A });
    const up = recorder();
    const icon = await media(env, db, "/media/tidewater/icon", up.fetchImpl);
    expect(icon.status).toBe(302);
    expect(icon.headers.get("location")).toBe(`${IMG}/tidewater/icon`);
    expect(up.calls).toEqual([]);
    const header = await media(
      env,
      db,
      "/media/tidewater/header",
      up.fetchImpl,
    );
    expect(header.status).toBe(200);
    expect(up.calls).toEqual([HEADER]);
  });

  it("the proxy fallback keeps its guards: a source off the GitHub allowlist is never fetched", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    await db.run(
      "UPDATE dist_listing SET listing_json = ? WHERE product = 'tidewater'",
      JSON.stringify({
        icon: { kind: "url", src: "https://cdn.example.test/i.png" },
      }),
    );
    const up = recorder();
    expect(
      (await media(env, db, "/media/tidewater/icon", up.fetchImpl)).status,
    ).toBe(404);
    expect(up.calls).toEqual([]);
  });

  it("still refuses a portal-disabled or unknown product", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    await seedHosted(db, "tidewater", "presentation.icon", { sha256: A });
    await db.run(
      `INSERT INTO portal_product_settings (product, portal_enabled, created_at, modified_at)
            VALUES ('tidewater', 0, ?, ?)
       ON CONFLICT (product) DO UPDATE SET portal_enabled = 0`,
      NOW,
      NOW,
    );
    const up = recorder();
    expect(
      (await media(env, db, "/media/tidewater/icon", up.fetchImpl)).status,
    ).toBe(404);
    expect(
      (await media(env, db, "/media/nobody/icon", up.fetchImpl)).status,
    ).toBe(404);
  });
});

describe("the portal shell's CSP admits exactly the image host", () => {
  const imgSrc = async (env: Env, db: Db = makeTestDb()) => {
    const res = await handlePortal(
      new Request("https://key.plrs.im/library"),
      env,
      db,
      "/library",
      { now: NOW },
    );
    return (res.headers.get("content-security-policy") ?? "")
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("img-src"));
  };

  it("adds IMG_ORIGIN, and only while hosted copies are served", async () => {
    expect(await imgSrc(portalEnv())).toBe(`img-src 'self' data: ${IMG}`);
    expect(await imgSrc(portalEnv(null))).toBe("img-src 'self' data:");
    const env = portalEnv();
    const db = makeTestDb();
    await setAssetHosting(env, db, "off");
    expect(await imgSrc(env, db)).toBe("img-src 'self' data:");
    // Switched back on, the image host is admitted again.
    await setAssetHosting(env, db, "on");
    expect(await imgSrc(env, db)).toBe(`img-src 'self' data: ${IMG}`);
  });

  it("writes only a bare origin into the policy", async () => {
    expect(await imgSrc(portalEnv("https://img.example.test/some/path"))).toBe(
      `img-src 'self' data: ${IMG}`,
    );
  });
});

describe("rollback: hosting off, or no image host, restores the pre-HA-07 portal", () => {
  for (const [label, setup] of [
    [
      "the kill switch off",
      async (db: Db) => {
        const env = portalEnv();
        await setAssetHosting(env, db, "off");
        return env;
      },
    ],
    ["no image host", async () => portalEnv(null)],
  ] as const)
    it(`${label}: proxy URLs in the library, and /media proxies again`, async () => {
      const db = makeTestDb();
      const env = await setup(db);
      await tidewater(db);
      await seedHosted(db, "tidewater", "presentation.icon", { sha256: A });
      const s = await signedIn(env, db);
      const library = await api(env, db, "/api/library", s);
      expect(library.products[0]).toMatchObject({
        iconUrl: `/media/tidewater/icon?v=${await mediaVersion(ICON)}`,
        headerUrl: `/media/tidewater/header?v=${await mediaVersion(HEADER)}`,
      });
      const up = recorder();
      const res = await media(env, db, "/media/tidewater/icon", up.fetchImpl);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(up.calls).toEqual([ICON]);
    });
});
