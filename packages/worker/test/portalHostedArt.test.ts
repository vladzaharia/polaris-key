/**
 * HA-07 (notes/S-20 §6.8): the portal serves Polaris Key's hosted copies of a product's art.
 *
 *   - the library, the product page and Discover hand out image-host URLs, each at the ladder
 *     width its surface draws at, chosen exactly as the image host's `/icon` and `/header` aliases
 *     choose the slot; never a developer URL;
 *   - `/media/<p>/{icon,header}` fetches nothing: a 302 to the image host's stable alias, or 404;
 *   - the sign-in card's client record keeps §12.7.2's same-origin `/media/<p>/icon`;
 *   - the portal shell's CSP admits exactly the image host;
 *   - with the kill switch off (HA-10's `assets.hosting.enabled`, a code constant until then) or no
 *     image host, every one of these is what it was before HA-07.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { seedHosted } from "./hostedFixture.js";
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

// The kill switch, controllable per test (HA-10 replaces the constant with a settings read).
const hosting = vi.hoisted(() => ({ on: true }));
vi.mock("../src/core/assetHosting.js", () => ({
  ASSET_HOSTING_ENABLED: true,
  assetHostingEnabled: () => hosting.on,
}));

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

beforeEach(() => {
  hosting.on = true;
});

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
    expect(p.headerUrl).toBeNull();
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
    expect(none.iconUrl).toBeNull();
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

describe("GET /media/<p>/<asset> redirects to the hosted copy", () => {
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

  it("is the plain 404, never a fetch, when there is no copy (the GitHub fetch is gone)", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await tidewater(db);
    const up = recorder();
    const res = await media(env, db, "/media/tidewater/icon", up.fetchImpl);
    expect(res.status).toBe(404);
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
  const imgSrc = async (env: Env) => {
    const res = await handlePortal(
      new Request("https://key.plrs.im/library"),
      env,
      makeTestDb(),
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
    hosting.on = false;
    expect(await imgSrc(portalEnv())).toBe("img-src 'self' data:");
  });

  it("writes only a bare origin into the policy", async () => {
    expect(await imgSrc(portalEnv("https://img.example.test/some/path"))).toBe(
      `img-src 'self' data: ${IMG}`,
    );
  });
});

describe("rollback: hosting off, or no image host, restores the pre-HA-07 portal", () => {
  for (const [label, setup] of [
    ["the kill switch off", () => ((hosting.on = false), portalEnv())],
    ["no image host", () => portalEnv(null)],
  ] as const)
    it(`${label}: proxy URLs in the library, and /media proxies again`, async () => {
      const env = setup();
      const db = makeTestDb();
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
