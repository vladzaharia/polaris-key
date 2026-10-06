/**
 * PX-W1 — the portal's library and product views (`GET /api/library`, `GET /api/products/<p>`;
 * docs/design/PORTAL.md G1, G5, G16) and the same-origin media proxy (`GET /media/<p>/<asset>`).
 *
 * The presentation comes from Distribution's stored root listing (`dist_listing`, written by
 * manifest ingest: `distributionOutlets.test.ts` pins that half) through the `delivery` hook, so
 * the fixtures here write the row directly and drive the portal the way `dispatch.ts` wires it.
 *
 * The media cases pin the SSRF rules in `portal/media.ts` (THREAT-MODEL "Portal media proxy"):
 * no URL in the request, GitHub-hosted https sources only, every redirect hop re-checked, size
 * caps on the header AND the stream, and a magic-number type check that ignores the upstream
 * `Content-Type`.
 */

import { issuePortalSessionRow } from "./portalSessionRow.js";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { SEAT_DORMANCY_SECONDS } from "../src/repo.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../src/services/identity/portal/session.js";
import { handlePortal } from "../src/services/identity/portal/index.js";
import {
  EXPIRES_SOON_SECONDS,
  licenseStatus,
} from "../src/services/identity/portal/library.js";
import {
  MEDIA_CSP,
  MEDIA_IMMUTABLE,
  MEDIA_SHORT,
  handlePortalMedia,
  mediaSourceUrl,
  mediaVersion,
  sniffImageType,
} from "../src/services/identity/portal/media.js";
import { handlePortalApi, portalHooksFor } from "./portalHarness.js";

const PORTAL_SECRET = "test-portal-session-secret";
const ICON =
  "https://raw.githubusercontent.com/fennick/tidewater/main/icon.png";
const HEADER = "https://tidewater.example/header.png";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
  0x52,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

function portalEnv(): Env {
  const env = makeEnv(new KvMock(), []);
  env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  return env;
}

function req(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[PORTAL_CSRF_HEADER] = opts.csrf;
  return new Request(`https://key.plrs.im${path}`, { method, headers });
}

async function session(
  env: Env,
  db: Db,
  email = "mara@fennick.studio",
): Promise<{ cookie: string; csrf: string; accountId: string }> {
  const account = await getOrCreateAccountByEmail(db, email, NOW);
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
  return {
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
    accountId: account.id,
  };
}

async function setProductServices(
  db: Db,
  slug: string,
  services: Partial<ServicesMap>,
): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: false },
        ...services,
      },
    }),
    "manifest",
    NOW,
  );
}

/** A product with Distribution on and the given root listing, as manifest ingest stores it. */
async function productWithListing(
  db: Db,
  slug: string,
  listing: Record<string, unknown> | null,
): Promise<void> {
  await seedProduct(db, slug);
  await setProductServices(db, slug, { distribution: { enabled: true } });
  if (listing)
    await db.run(
      "INSERT INTO dist_listing (product, listing_json, modified_at) VALUES (?, ?, ?)",
      slug,
      JSON.stringify(listing),
      NOW,
    );
}

async function device(
  db: Db,
  slug: string,
  licenseId: string,
  id: string,
  lastSeen: number,
  status = "authorized",
): Promise<void> {
  await db.run(
    `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, label, platform)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    slug,
    id,
    licenseId,
    status,
    NOW - 1000,
    lastSeen,
    `${id} label`,
    "macos",
  );
}

async function api(
  env: Env,
  db: Db,
  path: string,
  s: { cookie: string; csrf: string } | null,
  method = "GET",
): Promise<Response> {
  return handlePortalApi(
    req(method, path, s ? { cookie: s.cookie, csrf: s.csrf } : {}),
    env,
    db,
    path,
    NOW,
  );
}

const DORMANT_AT = NOW - SEAT_DORMANCY_SECONDS - 1;

// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("GET /api/library", () => {
  it("needs a portal session", async () => {
    const db = makeTestDb();
    const res = await api(portalEnv(), db, "/api/library", null);
    expect(res.status).toBe(401);
  });

  it("one entry per product: presentation from the listing, proxied art, support, seats", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const s = await session(env, db);
    await productWithListing(db, "tidewater", {
      name: "Tidewater Studio",
      developerName: "Fennick Studio",
      tintColor: "#1f3b5c",
      website: "https://tidewater.example",
      iconUrl: ICON,
      headerUrl: HEADER,
      supportUrl: "https://tidewater.example/help",
      supportEmail: "help@tidewater.example",
    });
    const { licenseId } = await seedLicenseWithKey(db, "tidewater", {
      id: "lic_tw",
    });
    await linkLicense(db, s.accountId, "tidewater", licenseId, "admin", NOW);
    await device(db, "tidewater", licenseId, "dev-a", NOW - 10);
    await device(db, "tidewater", licenseId, "dev-b", NOW - 20);
    await device(db, "tidewater", licenseId, "dev-old", DORMANT_AT);
    await device(db, "tidewater", licenseId, "dev-gone", NOW, "deauthorized");

    // A licence-only product: no Distribution, so no listing — the name fallback.
    await seedProduct(db, "quill");
    await setProductServices(db, "quill", {});
    const quill = await seedLicenseWithKey(db, "quill", { id: "lic_q" });
    await linkLicense(db, s.accountId, "quill", quill.licenseId, "admin", NOW);

    const res = await api(env, db, "/api/library", s);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      products: Array<Record<string, unknown>>;
    };
    expect(body.products.map((p) => p.product)).toEqual(["quill", "tidewater"]);
    const tw = body.products[1]!;
    expect(tw).toMatchObject({
      product: "tidewater",
      name: "Tidewater Studio",
      developerName: "Fennick Studio",
      tintColor: "#1f3b5c",
      website: "https://tidewater.example",
      iconUrl: `/media/tidewater/icon?v=${await mediaVersion(ICON)}`,
      // Hosted off the allowlist: the proxy would refuse it, so the library hands out nothing.
      headerUrl: null,
      support: {
        url: "https://tidewater.example/help",
        email: "help@tidewater.example",
      },
      status: "active",
      licenseCount: 1,
      addedAt: NOW,
      license: {
        id: "lic_tw",
        status: "active",
        licenseStatus: "active",
        deviceLimit: 5,
        activeSeatCount: 2,
        deviceCount: 3,
        dormantCount: 1,
      },
    });
    expect(body.products[0]).toMatchObject({
      product: "quill",
      name: "quill",
      developerName: null,
      tintColor: null,
      website: null,
      iconUrl: null,
      headerUrl: null,
      support: null,
    });
    // The page never receives a developer URL for art.
    expect(JSON.stringify(body)).not.toContain("raw.githubusercontent.com");
    expect(JSON.stringify(body)).not.toContain(HEADER);
  });

  it("shows the BEST licence and its status; a portal-disabled product is absent", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const s = await session(env, db);
    await productWithListing(db, "orbit", null);
    const expired = await seedLicenseWithKey(db, "orbit", {
      id: "lic_old",
      expiresAt: NOW - 86400,
    });
    const soon = await seedLicenseWithKey(db, "orbit", {
      id: "lic_soon",
      expiresAt: NOW + 3 * 86400,
    });
    for (const l of [expired, soon])
      await linkLicense(db, s.accountId, "orbit", l.licenseId, "admin", NOW);

    await seedProduct(db, "hidden");
    await setProductServices(db, "hidden", {});
    const hidden = await seedLicenseWithKey(db, "hidden", { id: "lic_h" });
    await linkLicense(
      db,
      s.accountId,
      "hidden",
      hidden.licenseId,
      "admin",
      NOW,
    );
    await db.run(
      `INSERT INTO portal_product_settings
         (product, portal_enabled, oidc_enabled, magic_enabled, license_key_claim_enabled,
          releases_enabled, branding_json, created_at, modified_at)
       VALUES ('hidden', 0, 1, 1, 1, 1, NULL, ?, ?)`,
      NOW,
      NOW,
    );

    const body = (await (await api(env, db, "/api/library", s)).json()) as {
      products: Array<Record<string, unknown>>;
    };
    expect(body.products).toHaveLength(1);
    expect(body.products[0]).toMatchObject({
      product: "orbit",
      status: "expires_soon",
      licenseCount: 2,
      license: { id: "lic_soon", expiresAt: NOW + 3 * 86400 },
    });
  });

  it("a device-limit licence reads device_limit with the enforced limit", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const s = await session(env, db);
    await productWithListing(db, "orbit", null);
    await db.run(
      "UPDATE products SET default_device_limit = 2 WHERE slug = 'orbit'",
    );
    const l = await seedLicenseWithKey(db, "orbit", { id: "lic_full" });
    await linkLicense(db, s.accountId, "orbit", l.licenseId, "admin", NOW);
    await device(db, "orbit", l.licenseId, "d1", NOW);
    await device(db, "orbit", l.licenseId, "d2", NOW);
    // A dormant device holds no seat, so it does not count toward the limit.
    await device(db, "orbit", l.licenseId, "d3", DORMANT_AT);
    const body = (await (await api(env, db, "/api/library", s)).json()) as {
      products: Array<Record<string, unknown>>;
    };
    expect(body.products[0]).toMatchObject({
      status: "device_limit",
      license: { deviceLimit: 2, activeSeatCount: 2, dormantCount: 1 },
    });
  });

  it("is read-only: a POST is refused", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const s = await session(env, db);
    const res = await api(env, db, "/api/library", s, "POST");
    expect(res.status).toBe(405);
  });
});

describe("licenseStatus (§5.3 precedence)", () => {
  const seats = { deviceLimit: 3, activeSeatCount: 1 };
  it("first match wins", () => {
    expect(
      licenseStatus({ status: "disabled", expires_at: NOW - 1 }, seats, NOW),
    ).toBe("suspended");
    expect(
      licenseStatus(
        { status: "active", expires_at: NOW - 1 },
        { deviceLimit: 1, activeSeatCount: 1 },
        NOW,
      ),
    ).toBe("expired");
    expect(
      licenseStatus(
        { status: "active", expires_at: NOW + 60 },
        { deviceLimit: 1, activeSeatCount: 1 },
        NOW,
      ),
    ).toBe("device_limit");
    expect(
      licenseStatus(
        { status: "active", expires_at: NOW + EXPIRES_SOON_SECONDS },
        seats,
        NOW,
      ),
    ).toBe("expires_soon");
    expect(
      licenseStatus(
        { status: "active", expires_at: NOW + EXPIRES_SOON_SECONDS + 1 },
        seats,
        NOW,
      ),
    ).toBe("active");
    expect(
      licenseStatus({ status: "active", expires_at: null }, seats, NOW),
    ).toBe("active");
  });
});

describe("GET /api/products/<p>", () => {
  it("presentation, services, every licence best first, devices with dormancy", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const s = await session(env, db);
    await productWithListing(db, "tidewater", {
      name: "Tidewater Studio",
      iconUrl: ICON,
    });
    const a = await seedLicenseWithKey(db, "tidewater", {
      id: "lic_a",
      expiresAt: NOW - 10,
    });
    const b = await seedLicenseWithKey(db, "tidewater", { id: "lic_b" });
    for (const l of [a, b])
      await linkLicense(
        db,
        s.accountId,
        "tidewater",
        l.licenseId,
        "admin",
        NOW,
      );
    await device(db, "tidewater", "lic_b", "dev-now", NOW - 5);
    await device(db, "tidewater", "lic_b", "dev-old", DORMANT_AT);
    await device(db, "tidewater", "lic_b", "dev-gone", NOW, "deauthorized");

    const res = await api(env, db, "/api/products/tidewater", s);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & {
      licenses: Array<Record<string, unknown> & { devices: unknown[] }>;
    };
    expect(body).toMatchObject({
      product: "tidewater",
      name: "Tidewater Studio",
      iconUrl: `/media/tidewater/icon?v=${await mediaVersion(ICON)}`,
      status: "active",
      services: {
        license: true,
        config: true,
        release: false,
        distribution: true,
        update: false,
        identity: false,
      },
      returnTo: { origins: [], schemes: [] },
    });
    expect(body.licenses.map((l) => [l.id, l.status])).toEqual([
      ["lic_b", "active"],
      ["lic_a", "expired"],
    ]);
    expect(body.licenses[0]).toMatchObject({
      deviceLimit: 5,
      activeSeatCount: 1,
      deviceCount: 2,
      dormantCount: 1,
      entitlements: [],
    });
    expect(body.licenses[0]!.devices).toEqual([
      {
        deviceId: "dev-now",
        label: "dev-now label",
        platform: "macos",
        arch: null,
        appVersion: null,
        firstSeen: NOW - 1000,
        lastSeen: NOW - 5,
        dormant: false,
      },
      {
        deviceId: "dev-old",
        label: "dev-old label",
        platform: "macos",
        arch: null,
        appVersion: null,
        firstSeen: NOW - 1000,
        lastSeen: DORMANT_AT,
        dormant: true,
      },
    ]);
  });

  it("returnTo lists the product's declared web origins, for the focused flows (PX-10)", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const s = await session(env, db);
    await productWithListing(db, "tidewater", null);
    await db.run(
      `UPDATE products SET web_origins_json = ? WHERE slug = ?`,
      JSON.stringify(["https://app.tidewater.example"]),
      "tidewater",
    );
    const l = await seedLicenseWithKey(db, "tidewater", { id: "lic_r" });
    await linkLicense(db, s.accountId, "tidewater", l.licenseId, "admin", NOW);
    const res = await api(env, db, "/api/products/tidewater", s);
    expect(((await res.json()) as { returnTo: unknown }).returnTo).toEqual({
      origins: ["https://app.tidewater.example"],
      schemes: [],
    });
  });

  it("404s a product the account holds nothing for, and an unknown product", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const s = await session(env, db);
    await productWithListing(db, "tidewater", null);
    // Someone else's licence on a real product.
    const other = await session(env, db, "someone@else.example");
    const l = await seedLicenseWithKey(db, "tidewater", { id: "lic_x" });
    await linkLicense(
      db,
      other.accountId,
      "tidewater",
      l.licenseId,
      "admin",
      NOW,
    );
    expect((await api(env, db, "/api/products/tidewater", s)).status).toBe(404);
    expect((await api(env, db, "/api/products/nope", s)).status).toBe(404);
    expect((await api(env, db, "/api/products/tidewater", other)).status).toBe(
      200,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════

type Call = { url: string; init?: RequestInit };

/** A scripted upstream: `routes[url]` answers that URL; anything else is a test failure. */
function upstream(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: Request | string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected upstream fetch: ${url}`);
    return route();
  };
  return { calls, fetchImpl };
}

function image(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return () =>
    new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png", ...headers },
    });
}

async function media(
  db: Db,
  path: string,
  fetchImpl: (input: Request | string, init?: RequestInit) => Promise<Response>,
  method = "GET",
): Promise<Response> {
  const env = portalEnv();
  const m = path.match(/^\/media\/([^/?]+)\/([^/?]+)/)!;
  return handlePortalMedia(
    req(method, path),
    env,
    db,
    m[1]!,
    m[2]!,
    NOW,
    portalHooksFor(env, db),
    fetchImpl,
  );
}

describe("GET /media/<product>/<asset> (the SSRF-safe proxy)", () => {
  it("serves an allowlisted PNG with the sniffed type, its own sandbox CSP and immutable caching", async () => {
    const db = makeTestDb();
    await productWithListing(db, "tidewater", { iconUrl: ICON });
    const up = upstream({
      [ICON]: image(PNG, { "content-type": "text/html" }),
    });
    const v = await mediaVersion(ICON);
    const res = await media(db, `/media/tidewater/icon?v=${v}`, up.fetchImpl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(MEDIA_CSP);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe(MEDIA_IMMUTABLE);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // Manual redirects, never followed by the runtime.
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.init?.redirect).toBe("manual");

    // Without the current `v` (a stale or absent one) the answer is cached only briefly.
    const stale = await media(
      db,
      "/media/tidewater/icon?v=0000000000000000",
      upstream({ [ICON]: image(PNG) }).fetchImpl,
    );
    expect(stale.headers.get("cache-control")).toBe(MEDIA_SHORT);
  });

  it("serves JPEG, WebP and GIF by magic number; HEAD has no body", async () => {
    for (const [bytes, type] of [
      [JPEG, "image/jpeg"],
      [WEBP, "image/webp"],
      [GIF, "image/gif"],
    ] as const) {
      const db = makeTestDb();
      await productWithListing(db, "tidewater", { headerUrl: ICON });
      const res = await media(
        db,
        "/media/tidewater/header",
        upstream({ [ICON]: image(bytes) }).fetchImpl,
      );
      expect(res.headers.get("content-type")).toBe(type);
    }
    const db = makeTestDb();
    await productWithListing(db, "tidewater", { iconUrl: ICON });
    const head = await media(
      db,
      "/media/tidewater/icon",
      upstream({ [ICON]: image(PNG) }).fetchImpl,
      "HEAD",
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect(await head.text()).toBe("");
  });

  it("never fetches a source off the allowlist (no request is even made)", async () => {
    for (const src of [
      "https://tidewater.example/icon.png",
      "http://raw.githubusercontent.com/a/b/main/icon.png",
      "https://127.0.0.1/icon.png",
      "https://[::1]/icon.png",
      "https://localhost/icon.png",
      "https://raw.githubusercontent.com:8443/a/b/main/icon.png",
      "https://user:pw@raw.githubusercontent.com/a/b/main/icon.png",
      "https://raw.githubusercontent.com.evil.example/icon.png",
      "https://key.plrs.im/manage/api/me",
    ]) {
      const db = makeTestDb();
      await productWithListing(db, "tidewater", { iconUrl: src });
      const up = upstream({});
      const res = await media(db, "/media/tidewater/icon", up.fetchImpl);
      expect(res.status, src).toBe(404);
      expect(up.calls, src).toEqual([]);
      expect(mediaSourceUrl(src), src).toBeNull();
    }
  });

  it("refuses an unknown asset, a product without a listing, an unknown or portal-disabled product", async () => {
    const db = makeTestDb();
    await productWithListing(db, "tidewater", { iconUrl: ICON });
    await productWithListing(db, "bare", null);
    await productWithListing(db, "off", { iconUrl: ICON });
    await db.run(
      `INSERT INTO portal_product_settings
         (product, portal_enabled, oidc_enabled, magic_enabled, license_key_claim_enabled,
          releases_enabled, branding_json, created_at, modified_at)
       VALUES ('off', 0, 1, 1, 1, 1, NULL, ?, ?)`,
      NOW,
      NOW,
    );
    const up = upstream({});
    for (const path of [
      "/media/tidewater/screenshot",
      "/media/tidewater/iconUrl",
      "/media/tidewater/header",
      "/media/bare/icon",
      "/media/nope/icon",
      "/media/off/icon",
      "/media/Bad_Slug/icon",
    ]) {
      const res = await media(db, path, up.fetchImpl);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
    expect(up.calls).toEqual([]);
  });

  it("re-checks every redirect hop, and stops after three", async () => {
    const hop = (to: string) => () =>
      new Response(null, { status: 302, headers: { location: to } });
    const OBJ =
      "https://objects.githubusercontent.com/github-production-release-asset/1/icon.png";
    const GH =
      "https://github.com/fennick/tidewater/releases/download/v1/icon.png";

    // Allowlisted → allowlisted: followed.
    let db = makeTestDb();
    await productWithListing(db, "tidewater", { iconUrl: GH });
    let up = upstream({ [GH]: hop(OBJ), [OBJ]: image(PNG) });
    expect(
      (await media(db, "/media/tidewater/icon", up.fetchImpl)).status,
    ).toBe(200);
    expect(up.calls.map((c) => c.url)).toEqual([GH, OBJ]);

    // Allowlisted → anywhere else: refused without fetching the target.
    for (const target of [
      "https://evil.example/x.png",
      "http://objects.githubusercontent.com/x.png",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      db = makeTestDb();
      await productWithListing(db, "tidewater", { iconUrl: GH });
      up = upstream({ [GH]: hop(target) });
      expect(
        (await media(db, "/media/tidewater/icon", up.fetchImpl)).status,
        target,
      ).toBe(404);
      expect(up.calls.map((c) => c.url)).toEqual([GH]);
    }

    // Four hops is one too many.
    const u = (n: number) =>
      `https://raw.githubusercontent.com/a/b/main/${n}.png`;
    db = makeTestDb();
    await productWithListing(db, "tidewater", { iconUrl: u(0) });
    up = upstream({
      [u(0)]: hop(u(1)),
      [u(1)]: hop(u(2)),
      [u(2)]: hop(u(3)),
      [u(3)]: hop(u(4)),
      [u(4)]: image(PNG),
    });
    expect(
      (await media(db, "/media/tidewater/icon", up.fetchImpl)).status,
    ).toBe(404);
    expect(up.calls).toHaveLength(4);
  });

  it("caps the size by the header and by the stream", async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(PNG);
    // Declared too large: refused before the body is read.
    let db = makeTestDb();
    await productWithListing(db, "tidewater", { iconUrl: ICON });
    let res = await media(
      db,
      "/media/tidewater/icon",
      upstream({
        [ICON]: () =>
          new Response(PNG, {
            status: 200,
            headers: { "content-length": String(big.byteLength) },
          }),
      }).fetchImpl,
    );
    expect(res.status).toBe(404);
    // Streamed without a length: cut off at the cap.
    db = makeTestDb();
    await productWithListing(db, "tidewater", { iconUrl: ICON });
    res = await media(
      db,
      "/media/tidewater/icon",
      upstream({
        [ICON]: () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(big);
                c.close();
              },
            }),
            { status: 200 },
          ),
      }).fetchImpl,
    );
    expect(res.status).toBe(404);
    // The header's cap is larger: the same bytes are a valid header.
    db = makeTestDb();
    await productWithListing(db, "tidewater", { headerUrl: ICON });
    res = await media(
      db,
      "/media/tidewater/header",
      upstream({ [ICON]: image(big) }).fetchImpl,
    );
    expect(res.status).toBe(200);
  });

  it("refuses anything that is not an image by its bytes, whatever the upstream type says", async () => {
    for (const bytes of [
      SVG,
      new TextEncoder().encode("<!doctype html><script>x</script>"),
      new Uint8Array(0),
    ]) {
      const db = makeTestDb();
      await productWithListing(db, "tidewater", { iconUrl: ICON });
      const res = await media(
        db,
        "/media/tidewater/icon",
        upstream({ [ICON]: image(bytes, { "content-type": "image/png" }) })
          .fetchImpl,
      );
      expect(res.status).toBe(404);
    }
    expect(sniffImageType(SVG)).toBeNull();
  });

  it("an upstream error or a thrown fetch is a 404, never a 5xx", async () => {
    let db = makeTestDb();
    await productWithListing(db, "tidewater", { iconUrl: ICON });
    expect(
      (
        await media(
          db,
          "/media/tidewater/icon",
          upstream({ [ICON]: () => new Response("no", { status: 500 }) })
            .fetchImpl,
        )
      ).status,
    ).toBe(404);
    db = makeTestDb();
    await productWithListing(db, "tidewater", { iconUrl: ICON });
    expect(
      (
        await media(db, "/media/tidewater/icon", async () => {
          throw new Error("network down");
        })
      ).status,
    ).toBe(404);
  });

  it("only GET and HEAD", async () => {
    const db = makeTestDb();
    await productWithListing(db, "tidewater", { iconUrl: ICON });
    const res = await media(
      db,
      "/media/tidewater/icon",
      upstream({}).fetchImpl,
      "POST",
    );
    expect(res.status).toBe(405);
  });

  it("every other path under /media is the proxy's 404, never the SPA shell", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    for (const path of ["/media", "/media/tidewater", "/media/a/b/c"]) {
      const res = await handlePortal(req("GET", path), env, db, path, {
        now: NOW,
        hooksFor: portalHooksFor(env, db),
      });
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toContain(
        "application/json",
      );
    }
  });
});
