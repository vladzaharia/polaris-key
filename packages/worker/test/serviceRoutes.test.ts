/**
 * The service surface as a PRODUCT sees it: what the core router hands to which descriptor,
 * what a product that has turned a service off can still reach, and — the load-bearing one —
 * that a product running Config WITHOUT License gets a real signed config document.
 *
 * The suites next door test the documents' contents (`licensing.test.ts`) and the registry's
 * dispatch rules in isolation (`registry.test.ts`). This one wires the two together through
 * `matchRoute` + `dispatchService` + the real descriptors, because the interesting failures of
 * a modular monolith are at the joins.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { verifyConfigDoc, verifyLicenseDoc } from "@polaris-key/client-core";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { normalizeModules, servicesFromModules } from "@polaris-key/manifest";
import { matchRoute } from "../src/router.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleDiscovery } from "../src/core/discovery.js";
import { dispatchService, type ServiceRegistry } from "../src/core/registry.js";
import { licenseService } from "../src/services/license/index.js";
import { configService } from "../src/services/config/index.js";
import { identityService } from "../src/services/identity/index.js";
import { handleActivate } from "../src/services/license/activation.js";
import { hashKey, mintDeviceToken } from "../src/platform/crypto.js";
import { putTokenRecord } from "../src/platform/kv.js";
import { setServices, upsertDevice } from "../src/core/repo.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const TRUST = { [TEST_KID]: TEST_PUB };

const REGISTRY: ServiceRegistry = new Map([
  [licenseService.slug, licenseService],
  [configService.slug, configService],
  [identityService.slug, identityService],
]);

/** Drive a product-scoped path exactly as `index.ts` does: match, then dispatch. */
async function call(
  env: Env,
  db: SqliteDb,
  product: Product,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const route = matchRoute(path);
  if (route.kind !== "service") throw new Error(`not a service route: ${path}`);
  return dispatchService(REGISTRY, route.slug, product.services, {
    req: mkReq(init.method ?? "GET", init.headers ?? {}),
    env,
    db,
    product,
    rest: route.rest,
    now: NOW,
  });
}

async function setServicesJson(
  db: SqliteDb,
  slug: string,
  services: Record<string, { enabled: boolean }>,
): Promise<void> {
  await setServices(db, slug, JSON.stringify(services), "admin", NOW);
}

/** `/<p>/.well-known/polaris.json`, assembled from the same registry the routes dispatch to. */
async function discovery(
  env: Env,
  db: SqliteDb,
  product: Product,
): Promise<unknown> {
  const res = await handleDiscovery(
    new Request(
      `https://key.plrs.im/${product.slug}/.well-known/polaris.json`,
    ) as unknown as Request,
    env,
    db,
    product,
    REGISTRY,
  );
  return res.json();
}

describe("service routing through the core router", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("404s the fused /<p>/config route that wire v3 removed", async () => {
    const res = await call(env, db, product, "/djdl/config");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found" } });
  });

  it("404s an unknown path inside a service with the registry's single shape", async () => {
    const shapes = await Promise.all(
      ["/djdl/config/report", "/djdl/license/account", "/djdl/config/mint"].map(
        async (path) => {
          const res = await call(env, db, product, path);
          return { status: res.status, body: await res.text() };
        },
      ),
    );
    for (const shape of shapes) {
      expect(shape.status).toBe(404);
      expect(shape.body).toBe(JSON.stringify({ error: { code: "not_found" } }));
    }
  });

  it("hides a disabled service entirely, including routes that exist", async () => {
    await setServicesJson(db, "djdl", {
      license: { enabled: true },
      config: { enabled: false },
    });
    const disabled = (await loadProduct(env, db, "djdl"))!;
    const { key } = await seedLicenseWithKey(db, "djdl");
    const activateRes = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      disabled,
      NOW,
    );
    const { token } = (await activateRes.json()) as { token: string };
    const headers = { authorization: `Bearer ${token}` };

    // A perfectly good credential against a real route — the service is simply not there.
    const off = await call(env, db, disabled, "/djdl/config/document", {
      headers,
    });
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: { code: "not_found" } });

    // …while the service the product DOES run answers the same credential.
    const on = await call(env, db, disabled, "/djdl/license/document", {
      headers,
    });
    expect(on.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// D-08 — service independence, proved on the wire
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("a config-only product (D-08)", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  let token: string;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["cfgonly"]);
    await seedProduct(db, "cfgonly", {
      catalog: {
        schemaVersion: 3,
        entries: [
          {
            key: "app.theme",
            kind: "config",
            category: "app",
            label: "Theme",
            description: "",
            schema: { type: "string" },
            default: "system",
            managementDefault: "default",
          },
        ],
      },
    });
    await setServicesJson(db, "cfgonly", {
      license: { enabled: false },
      config: { enabled: true },
    });
    product = (await loadProduct(env, db, "cfgonly"))!;

    // A REGISTERED device, minted by hand.
    //
    // `POST /<p>/devices/register` is T1.5 and does not exist yet, so the row and its hot
    // token record are written here directly. Everything else in the flow is the real thing:
    // the same `devices` row shape registration will write, the same KV record
    // `core/validateDeviceToken` reads, and the real config descriptor answering the request.
    // When registration lands, this fixture collapses into a call to it.
    token = mintDeviceToken();
    const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
    await upsertDevice(db, {
      product: "cfgonly",
      device_id: "dev-registered",
      customer_id: null,
      // `devices.license_id` is NOT NULL today, so a licence-less device still carries a
      // placeholder that names no `licenses` row. That is the honest current shape of a
      // registered-without-licence device, and it is exactly the case the config document has
      // to survive: `getLicense` returns null for it.
      license_id: "",
      status: "authorized",
      first_seen: NOW,
      last_seen: NOW,
      ua: null,
      label: null,
      overrides_json: null,
      reported_json: null,
      token_hash: tokenHash,
      platform: null,
      arch: null,
      app_version: null,
      sdk_name: null,
      sdk_version: null,
    });
    await putTokenRecord(env, "cfgonly", tokenHash, {
      product: "cfgonly",
      deviceId: "dev-registered",
      licenseId: "",
    });
  });

  it("issues a config document to a registered device with no licence at all", async () => {
    const res = await call(env, db, product, "/cfgonly/config/document", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jwt");
    const jws = await res.text();

    const doc = await verifyConfigDoc(jws, {
      lastAcceptedIssuedAt: null,
      trust: TRUST,
      expectedAud: "cfgonly",
      deviceId: "dev-registered",
      now: NOW,
    });
    expect(doc).not.toBeNull();
    expect(doc!.iss).toBe("key.plrs.im");
    expect(doc!.schemaVersion).toBe(1);
    // The catalog default still arrives — the merge tolerates the missing licence layers
    // rather than bailing out of the whole document.
    expect(doc!.config["app.theme"]?.value).toBe("system");
    // The grace window comes from the PRODUCT default when there is no licence to override it.
    expect(doc!.graceUntil).toBe(NOW + 30 * 86_400);

    // §2.2, the whole point: not one licence field, and none smuggled in under another name.
    const payload = JSON.parse(
      Buffer.from(jws.split(".")[1] as string, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "aud",
      "config",
      "deviceId",
      "expiresAt",
      "graceUntil",
      "iss",
      "issuedAt",
      "schemaVersion",
      "secrets",
    ]);
    expect(payload).not.toHaveProperty("licenseId");
    expect(payload).not.toHaveProperty("entitlements");
    expect(payload).not.toHaveProperty("profile");
  });

  it("does not gate the config document on the client's version or channel", async () => {
    // The build gate is a LICENCE grant (D-20). A product with no licence service has no
    // window to be outside of, so a build that `/license/document` would refuse still gets
    // its settings.
    const res = await call(env, db, product, "/cfgonly/config/document", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "0.0.1",
        "x-pkey-channel": "staging",
      },
    });
    expect(res.status).toBe(200);
  });

  it("has no license surface to reach at all", async () => {
    for (const path of [
      "/cfgonly/license/document",
      "/cfgonly/license/activate",
      "/cfgonly/license/token",
    ]) {
      const res = await call(env, db, product, path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found" } });
    }
  });

  it("refuses an unknown token exactly as a licensed product does", async () => {
    const res = await call(env, db, product, "/cfgonly/config/document", {
      headers: { authorization: "Bearer pkeyt_nope" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized" } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// R1 — a LICENSED product's config document needs the device's licence to still be usable
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// The config document carries the product's secrets. D-08 lets a product with License OFF serve
// it on a device token alone, but the same rule used to apply to a licensed product too, so a
// device whose licence an operator had disabled, or that had expired, kept receiving every secret
// — a rotated one included — for as long as its token lived. The check applies to a device BOUND
// to a licence; a keyless device of a licensed product is still served (`register.test.ts`).
// The refusal is a 401 (with its own code), never a 403: SDKs read a 403 on a document as a build
// block. The client side of it is the `sync-config-license-unusable` transcript.

describe("a licensed product's config document (R1)", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;
  let licenseId: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    product = (await loadProduct(env, db, "djdl"))!;
    expect(product.services.license.enabled).toBe(true);
    const seeded = await seedLicenseWithKey(db, "djdl");
    licenseId = seeded.licenseId;
    const activateRes = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${seeded.key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(activateRes.status).toBe(200);
    const { token } = (await activateRes.json()) as { token: string };
    headers = { authorization: `Bearer ${token}` };
  });

  const configDocument = (extra: Record<string, string> = {}) =>
    call(env, db, product, "/djdl/config/document", {
      headers: { ...headers, ...extra },
    });

  async function expectRefused(res: Response): Promise<void> {
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "license_unusable" } });
  }

  it("serves the document while the licence is usable", async () => {
    const res = await configDocument();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jwt");
    const doc = await verifyConfigDoc(await res.text(), {
      lastAcceptedIssuedAt: null,
      trust: TRUST,
      expectedAud: "djdl",
      deviceId: "dev-1",
      now: NOW,
    });
    expect(doc).not.toBeNull();
  });

  it("refuses a disabled licence with 401 license_unusable, and never answers it a 304", async () => {
    const ok = await configDocument();
    expect(ok.status).toBe(200);
    const etag = ok.headers.get("etag")!;

    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = 'djdl' AND id = ?",
      licenseId,
    );
    await expectRefused(await configDocument());
    // A conditional request is refused too: "unchanged" would tell the device its copy is
    // still current.
    await expectRefused(await configDocument({ "if-none-match": etag }));

    // Re-enabling the licence restores the document.
    await db.run(
      "UPDATE licenses SET status = 'active' WHERE product = 'djdl' AND id = ?",
      licenseId,
    );
    expect((await configDocument()).status).toBe(200);
  });

  it("refuses a licence past its expiry", async () => {
    await db.run(
      "UPDATE licenses SET expires_at = ? WHERE product = 'djdl' AND id = ?",
      NOW - 1,
      licenseId,
    );
    await expectRefused(await configDocument());
  });

  it("refuses a device whose licence no longer exists", async () => {
    await db.run(
      "DELETE FROM licenses WHERE product = 'djdl' AND id = ?",
      licenseId,
    );
    await expectRefused(await configDocument());
  });

  it("still answers a bad token 401 before it asks about the licence", async () => {
    const res = await call(env, db, product, "/djdl/config/document", {
      headers: { authorization: "Bearer pkeyt_nope" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized" } });
  });

  it("does not apply once the product turns License off (D-08)", async () => {
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = 'djdl' AND id = ?",
      licenseId,
    );
    await setServicesJson(db, "djdl", {
      license: { enabled: false },
      config: { enabled: true },
    });
    product = (await loadProduct(env, db, "djdl"))!;
    expect((await configDocument()).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The other direction: a license-only product still answers for grants.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("a license-only product", () => {
  it("serves the license document while the config surface is absent", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["liconly"]);
    await seedProduct(db, "liconly");
    await setServicesJson(db, "liconly", {
      license: { enabled: true },
      config: { enabled: false },
    });
    const product = (await loadProduct(env, db, "liconly"))!;
    const { key, licenseId } = await seedLicenseWithKey(db, "liconly");
    const activateRes = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(activateRes.status).toBe(200);
    const { token } = (await activateRes.json()) as { token: string };
    const headers = { authorization: `Bearer ${token}` };

    const res = await call(env, db, product, "/liconly/license/document", {
      headers,
    });
    expect(res.status).toBe(200);
    const doc = await verifyLicenseDoc(await res.text(), {
      lastAcceptedIssuedAt: null,
      trust: TRUST,
      expectedAud: "liconly",
      deviceId: "dev-1",
      now: NOW,
    });
    expect(doc!.licenseId).toBe(licenseId);

    for (const path of ["/liconly/config/document", "/liconly/config/schema"]) {
      expect((await call(env, db, product, path, { headers })).status).toBe(
        404,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// P3 — identity stops inferring enablement from an `oidc_config` row
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// This is the regression that would be silent and expensive. Before the carve, identity's routes
// answered for any product with an `oidc_config` row and discovery reported that row; after it,
// both read `services_json`. A product whose manifest declared OIDC but whose enablement set was
// written without `identity` would therefore keep its `oidc_config` row and LOSE its login, with
// nothing in the response to say why.
//
// The manifest mapping is what makes that impossible, so it is exercised here rather than
// asserted about: the enablement set is derived by the same `normalizeModules` →
// `servicesFromModules` pair that `linkRepo`/`resync` and the seed generator use, from the same
// `modules:` block a `.pkey/product` file carries.

/** Seed a product OIDC config, as a repo link would write it. */
async function seedOidcConfig(db: SqliteDb, slug: string): Promise<void> {
  await db.run(
    `INSERT INTO oidc_config
       (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json,
        group_role_map_json)
     VALUES (?,?,?,?,?,?,?)`,
    slug,
    "custom",
    "https://id.example",
    "client-oidcprod",
    null,
    JSON.stringify([`https://key.plrs.im/${slug}/identity/auth/callback`]),
    JSON.stringify({ members: { role: "user" } }),
  );
}

const IDENTITY_PATHS = [
  "/oidcprod/identity/session",
  "/oidcprod/identity/session/license",
  "/oidcprod/identity/auth/start",
  "/oidcprod/identity/auth/callback",
  "/oidcprod/identity/auth/logout",
  "/oidcprod/identity/auth/device/start",
  "/oidcprod/identity/auth/device/verify",
  "/oidcprod/identity/auth/device/poll",
];

describe("an OIDC product whose manifest declared it", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["oidcprod"]);
    await seedProduct(db, "oidcprod");
    await seedOidcConfig(db, "oidcprod");
    // The manifest's own words, through the manifest's own translation. `modules.oidc` is the
    // pre-suite spelling every existing product uses, and it maps to the `identity` slug.
    const services = servicesFromModules(
      normalizeModules({
        licensing: { enabled: true },
        oidc: { enabled: true },
      }),
    );
    expect(services.identity.enabled).toBe(true);
    await setServicesJson(db, "oidcprod", services);
    product = (await loadProduct(env, db, "oidcprod"))!;
  });

  it("keeps its sign-in working end to end, at the namespaced path", async () => {
    const res = await call(env, db, product, "/oidcprod/identity/auth/start");
    expect(res.status).toBe(302);
    const authorize = new URL(res.headers.get("location")!);
    expect(authorize.origin).toBe("https://id.example");
    // The redirect URI the IdP is handed — and the one it must have registered — is the
    // namespaced callback. This is the operator-visible half of the route move.
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://key.plrs.im/oidcprod/identity/auth/callback",
    );
    expect(authorize.searchParams.get("client_id")).toBe("client-oidcprod");
  });

  // `/auth/poll` put both halves of a `state` + device-id poll in a query string and had no flow
  // left to complete: it is retired, and answers exactly what a path that never existed does.
  it("answers the retired /identity/auth/poll with the registry's generic 404", async () => {
    for (const method of ["GET", "POST"]) {
      const res = await call(env, db, product, "/oidcprod/identity/auth/poll", {
        method,
      });
      expect(res.status, method).toBe(404);
      expect(await res.text(), method).toBe(
        JSON.stringify({ error: { code: "not_found" } }),
      );
    }
  });

  it("serves the browser-session document at its new URL", async () => {
    const res = await call(env, db, product, "/oidcprod/identity/session");
    expect(res.status).toBe(200);
    // Unauthenticated shape, unchanged by the move: the response BODY is not part of this task
    // (the React SDK migrates against it in a sibling wave), only the URL is.
    expect(await res.json()).toEqual({ authenticated: false, doc: null });
  });

  it("advertises the service in discovery from the flag, not from the row", async () => {
    const body = (await discovery(env, db, product)) as {
      services: Record<string, Record<string, unknown>>;
    };
    expect(body.services.identity).toMatchObject({
      enabled: true,
      configured: true,
    });
  });
});

describe("a product with identity disabled", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["oidcprod"]);
    await seedProduct(db, "oidcprod");
    // The row is PRESENT and the service is OFF. That combination is the whole point: row
    // presence used to be the enablement signal, and it must now decide nothing.
    await seedOidcConfig(db, "oidcprod");
    await setServicesJson(db, "oidcprod", {
      license: { enabled: true },
      config: { enabled: true },
      identity: { enabled: false },
    });
    product = (await loadProduct(env, db, "oidcprod"))!;
  });

  it("404s the whole /identity/* surface with the registry's single shape", async () => {
    for (const path of IDENTITY_PATHS) {
      const res = await call(env, db, product, path, { method: "POST" });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe(
        JSON.stringify({ error: { code: "not_found" } }),
      );
    }
  });

  it("reports `{enabled:false}` and NOTHING else in discovery", async () => {
    const body = (await discovery(env, db, product)) as {
      services: Record<string, Record<string, unknown>>;
    };
    expect(body.services.identity).toEqual({ enabled: false });
  });
});
