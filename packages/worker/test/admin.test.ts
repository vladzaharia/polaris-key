import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq as mkLicReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  approveEdgeMintRecipe,
  seedProductSecret,
} from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import { handleAdminLogin } from "../src/admin/auth.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
  verifySession,
  type SessionIdentity,
} from "../src/admin/session.js";
import {
  getActiveProductKey,
  getProductSecret,
  listAudit,
  setServices,
} from "../src/repo.js";
import { loadProduct } from "../src/core/products.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleMintToken } from "../src/services/config/mint.js";
import { buildDoc } from "../src/services/identity/doc.js";
import { signDoc } from "../src/core/signing.js";
import { open } from "../src/keyvault.js";
import { verifyJws } from "@polaris-key/jws";
import type { DocProfile } from "@polaris-key/protocol";
import type { FusedSessionDoc } from "../src/services/identity/doc.js";
import type { ManagedPayload } from "../src/core/payload.js";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { getTokenRecord } from "../src/kv.js";
import { hashKey } from "../src/crypto.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const DJDL_ADMIN_GROUP = "djdl-admins";

/** An Env with the admin session secret + platform admin group set. */
function adminEnv(kv: KvMock, slugs: string[]): Env {
  const env = makeEnv(kv, slugs);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

/** Forge a signed session cookie for the given identity (same scheme the worker verifies). */
async function sessionCookie(
  env: Env,
  identity: SessionIdentity,
): Promise<{ cookie: string; csrf: string }> {
  const { token, session } = await issueSession(env, identity, NOW);
  return { cookie: `${ADMIN_COOKIE}=${token}`, csrf: session.csrf };
}

function mkReq(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[CSRF_HEADER] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return new Request(
    `https://key.plrs.im/manage${path}`,
    init,
  ) as unknown as Request;
}

const dispatch = (req: Request, env: Env, db: Db, path: string) =>
  handleAdmin(req, env, db, path, { now: NOW });

describe("admin api", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    const res = await dispatch(mkReq("GET", "/api/me"), env, db, "/api/me");
    expect(res.status).toBe(401);
  });

  it("returns the signed-in identity at /api/me", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });
    const res = await dispatch(
      mkReq("GET", "/api/me", { cookie }),
      env,
      db,
      "/api/me",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sub: string;
      platformAdmin: boolean;
      csrf: string;
    };
    expect(body.sub).toBe("u1");
    expect(body.platformAdmin).toBe(true);
    expect(typeof body.csrf).toBe("string");
  });

  it("product create requires a platform admin", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    // A non-platform admin (no groups) cannot create a product.
    const weak = await sessionCookie(env, {
      sub: "u2",
      name: "Bob",
      email: "b@x.io",
      groups: [],
    });
    const denied = await dispatch(
      mkReq("POST", "/api/products", {
        cookie: weak.cookie,
        csrf: weak.csrf,
        body: { slug: "acme", name: "Acme" },
      }),
      env,
      db,
      "/api/products",
    );
    expect(denied.status).toBe(403);

    // A platform admin can.
    const strong = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });
    const created = await dispatch(
      mkReq("POST", "/api/products", {
        cookie: strong.cookie,
        csrf: strong.csrf,
        body: { slug: "acme", name: "Acme" },
      }),
      env,
      db,
      "/api/products",
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      ok: boolean;
      product: { slug: string };
    };
    expect(body.product.slug).toBe("acme");

    // It now shows up in the list.
    const list = await dispatch(
      mkReq("GET", "/api/products", { cookie: strong.cookie }),
      env,
      db,
      "/api/products",
    );
    const listed = (await list.json()) as { products: { slug: string }[] };
    expect(listed.products.map((p) => p.slug)).toContain("acme");
  });

  it("product projection includes release source and public signing key details", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run(
      "UPDATE products SET release_source = ? WHERE slug = ?",
      "github",
      "djdl",
    );
    await db.run(
      `INSERT INTO product_sync_state
         (product, source, status, last_checked_at, last_synced_at, commit_sha,
          changed_paths_json, updated_json, errors_json, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      "webhook",
      "error",
      NOW,
      null,
      "abc123",
      JSON.stringify([".pkey/product.yaml"]),
      JSON.stringify(["product"]),
      JSON.stringify(["bad manifest"]),
      "manifest validation failed",
    );
    const { cookie } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });

    const res = await dispatch(
      mkReq("GET", "/api/products/djdl", { cookie }),
      env,
      db,
      "/api/products/djdl",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      product: {
        releaseSource: string;
        signingKid: string;
        signing: { kid: string; alg: string; publicKey: string } | null;
        setup: {
          sync: {
            source: string;
            status: string;
            commitSha: string;
            changedPaths: string[];
            updated: string[];
            errors: string[];
            message: string;
          };
        };
      };
    };
    expect(body.product.releaseSource).toBe("github");
    expect(body.product.signingKid).toBe("pkey-test-prod-2026");
    expect(body.product.signing).toMatchObject({
      kid: "pkey-test-prod-2026",
      alg: "Ed25519",
      publicKey: expect.any(String),
    });
    expect(body.product.setup.sync).toMatchObject({
      source: "webhook",
      status: "error",
      commitSha: "abc123",
      changedPaths: [".pkey/product.yaml"],
      updated: ["product"],
      errors: ["bad manifest"],
      message: "manifest validation failed",
    });
  });

  it("product projection tolerates a missing public key row", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run("DELETE FROM product_keys WHERE product = ?", "djdl");
    await db.run(
      "UPDATE products SET signing_pub = NULL WHERE slug = ?",
      "djdl",
    );
    const { cookie } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });

    const res = await dispatch(
      mkReq("GET", "/api/products", { cookie }),
      env,
      db,
      "/api/products",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      products: Array<{
        slug: string;
        signing?: unknown | null;
      }>;
    };
    const djdl = body.products.find((p) => p.slug === "djdl");
    expect(djdl).toBeDefined();
    expect(djdl!.signing).toBeNull();
  });

  it("reads and updates per-product customer portal settings", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });

    const updated = await dispatch(
      mkReq("PATCH", "/api/products/djdl/identity/portal", {
        cookie,
        csrf,
        body: {
          portalEnabled: true,
          oidcEnabled: false,
          magicEnabled: true,
          licenseKeyClaimEnabled: false,
          releasesEnabled: false,
        },
      }),
      env,
      db,
      "/api/products/djdl/identity/portal",
    );
    expect(updated.status).toBe(200);
    const settingsBody = (await updated.json()) as {
      settings: {
        portalEnabled: boolean;
        oidcEnabled: boolean;
        magicEnabled: boolean;
        licenseKeyClaimEnabled: boolean;
        releasesEnabled: boolean;
      };
    };
    expect(settingsBody.settings).toMatchObject({
      portalEnabled: true,
      oidcEnabled: false,
      magicEnabled: true,
      licenseKeyClaimEnabled: false,
      releasesEnabled: false,
    });

    const detail = await dispatch(
      mkReq("GET", "/api/products/djdl", { cookie }),
      env,
      db,
      "/api/products/djdl",
    );
    const body = (await detail.json()) as {
      product: { portalSettings: typeof settingsBody.settings };
    };
    expect(body.product.portalSettings).toMatchObject(settingsBody.settings);
  });

  it("product deletion removes sealed keys, secrets, and sync state", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedProductSecret(db, "djdl", "OIDC_SECRET", "secret-value");
    await db.run(
      `INSERT INTO product_sync_state
         (product, source, status, last_checked_at, last_synced_at, commit_sha,
          changed_paths_json, updated_json, errors_json, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      "manual",
      "ok",
      NOW,
      NOW,
      "abc123",
      JSON.stringify([".pkey/product.yaml"]),
      JSON.stringify(["product"]),
      null,
      null,
    );
    expect(
      await db.first("SELECT * FROM product_keys WHERE product = ?", "djdl"),
    ).not.toBeNull();
    expect(
      await db.first("SELECT * FROM product_secrets WHERE product = ?", "djdl"),
    ).not.toBeNull();
    expect(
      await db.first(
        "SELECT * FROM product_sync_state WHERE product = ?",
        "djdl",
      ),
    ).not.toBeNull();

    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });
    const res = await dispatch(
      mkReq("DELETE", "/api/products/djdl", {
        cookie,
        csrf,
        body: { confirmSlug: "djdl" },
      }),
      env,
      db,
      "/api/products/djdl",
    );
    expect(res.status).toBe(200);

    const deleted = await db.first<{ status: string; deleted_at: number }>(
      "SELECT status, deleted_at FROM products WHERE slug = ?",
      "djdl",
    );
    expect(deleted).toMatchObject({ status: "deleted", deleted_at: NOW });
    expect(
      await db.first<{ status: string }>(
        "SELECT status FROM product_keys WHERE product = ?",
        "djdl",
      ),
    ).toMatchObject({ status: "revoked" });
    expect(
      await db.first("SELECT * FROM product_secrets WHERE product = ?", "djdl"),
    ).not.toBeNull();
    expect(
      await db.first(
        "SELECT * FROM product_sync_state WHERE product = ?",
        "djdl",
      ),
    ).not.toBeNull();
  });

  it("creates a license and mints a key returned exactly once", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });

    const created = await dispatch(
      mkReq("POST", "/api/products/djdl/license/licenses", {
        cookie,
        csrf,
        body: { name: "Grace", email: "g@x.io" },
      }),
      env,
      db,
      "/api/products/djdl/license/licenses",
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { licenseId: string; key: string };
    expect(body.key.startsWith("pkey_djdl_")).toBe(true);

    // GET the license detail — the raw key is NOT echoed back.
    const detailRes = await dispatch(
      mkReq("GET", `/api/products/djdl/license/licenses/${body.licenseId}`, {
        cookie,
      }),
      env,
      db,
      `/api/products/djdl/license/licenses/${body.licenseId}`,
    );
    const detail = (await detailRes.json()) as { keys: { hash: string }[] };
    expect(detail.keys.length).toBe(1);
    expect(JSON.stringify(detail)).not.toContain(body.key);
  });

  it("rejects a mutation with a missing/incorrect CSRF token", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });
    const res = await dispatch(
      mkReq("POST", "/api/products/djdl/license/licenses", {
        cookie,
        body: { name: "X" },
      }),
      env,
      db,
      "/api/products/djdl/license/licenses",
    );
    expect(res.status).toBe(403);
  });

  it("validates a published schema catalog", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });

    // A malformed catalog (bad schema fragment) is rejected.
    const bad = await dispatch(
      mkReq("PUT", "/api/products/djdl/config/catalog", {
        cookie,
        csrf,
        body: {
          catalog: {
            schemaVersion: 2,
            entries: [
              {
                key: "x",
                kind: "config",
                category: "c",
                label: "X",
                description: "",
                schema: { type: "not-a-type" },
              },
            ],
          },
        },
      }),
      env,
      db,
      "/api/products/djdl/config/catalog",
    );
    expect(bad.status).toBe(422);

    // A well-formed catalog publishes.
    const good = await dispatch(
      mkReq("PUT", "/api/products/djdl/config/catalog", {
        cookie,
        csrf,
        body: {
          catalog: {
            schemaVersion: 2,
            entries: [
              {
                key: "run.concurrency",
                kind: "config",
                category: "run",
                label: "Concurrency",
                description: "",
                schema: { type: "integer", minimum: 1 },
              },
            ],
          },
        },
      }),
      env,
      db,
      "/api/products/djdl/config/catalog",
    );
    expect(good.status).toBe(200);

    // And an override against it is catalog-validated (bad value ⇒ 422).
    const lic = await dispatch(
      mkReq("POST", "/api/products/djdl/license/licenses", {
        cookie,
        csrf,
        body: { name: "Z", email: "z@x.io" },
      }),
      env,
      db,
      "/api/products/djdl/license/licenses",
    );
    const { licenseId } = (await lic.json()) as { licenseId: string };
    const badOverride = await dispatch(
      mkReq(
        "PUT",
        `/api/products/djdl/license/licenses/${licenseId}/overrides`,
        {
          cookie,
          csrf,
          body: { updates: [{ key: "run.concurrency", value: 0 }] },
        },
      ),
      env,
      db,
      `/api/products/djdl/license/licenses/${licenseId}/overrides`,
    );
    expect(badOverride.status).toBe(422);
  });

  it("requires platform-admin access even when product admin metadata matches", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl", "acme"]);
    // acme is admin-gated to a group the session lacks.
    await seedProduct(db, "djdl");
    await seedProduct(db, "acme");
    await db.run(
      "UPDATE products SET admin_group = ? WHERE slug = ?",
      DJDL_ADMIN_GROUP,
      "djdl",
    );
    await db.run(
      "UPDATE products SET admin_group = ? WHERE slug = ?",
      "acme-admins",
      "acme",
    );

    // Product admin groups are reserved metadata in v1; only platform admins can read.
    const { cookie } = await sessionCookie(env, {
      sub: "u3",
      name: "Cy",
      email: "c@x.io",
      groups: [DJDL_ADMIN_GROUP],
    });
    const okHere = await dispatch(
      mkReq("GET", "/api/products/djdl/license/licenses", { cookie }),
      env,
      db,
      "/api/products/djdl/license/licenses",
    );
    expect(okHere.status).toBe(403);

    const deniedThere = await dispatch(
      mkReq("GET", "/api/products/acme/license/licenses", { cookie }),
      env,
      db,
      "/api/products/acme/license/licenses",
    );
    expect(deniedThere.status).toBe(403);
  });

  it("disabling a license purges its devices' hot-path bearer tokens immediately", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = adminEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { licenseId, key } = await seedLicenseWithKey(db, "djdl");

    // Activate a device so a token record lands in KV.
    const activateRes = await handleActivate(
      mkLicReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await activateRes.json()) as { token: string };
    const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
    expect(await getTokenRecord(env, "djdl", tokenHash)).not.toBeNull();

    // Disable the license via the admin API.
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });
    const disabled = await dispatch(
      mkReq(
        "POST",
        `/api/products/djdl/license/licenses/${licenseId}/disable`,
        {
          cookie,
          csrf,
        },
      ),
      env,
      db,
      `/api/products/djdl/license/licenses/${licenseId}/disable`,
    );
    expect(disabled.status).toBe(200);

    // The bearer token no longer authenticates — its KV record is gone.
    expect(await getTokenRecord(env, "djdl", tokenHash)).toBeNull();
  });

  it("audits an authenticated cross-product access denial (403 + access.denied row)", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl", "acme"]);
    await seedProduct(db, "djdl");
    await seedProduct(db, "acme");
    await db.run(
      "UPDATE products SET admin_group = ? WHERE slug = ?",
      DJDL_ADMIN_GROUP,
      "djdl",
    );
    await db.run(
      "UPDATE products SET admin_group = ? WHERE slug = ?",
      "acme-admins",
      "acme",
    );

    // A djdl-only admin (NOT platform) reaches for product acme.
    const { cookie } = await sessionCookie(env, {
      sub: "u3",
      name: "Cy",
      email: "c@x.io",
      groups: [DJDL_ADMIN_GROUP],
    });
    const denied = await dispatch(
      mkReq("GET", "/api/products/acme/license/licenses", { cookie }),
      env,
      db,
      "/api/products/acme/license/licenses",
    );
    expect(denied.status).toBe(403);

    // An access.denied audit row, attributed to the verified actor, lands on the target product.
    const rows = await listAudit(db, "acme", {});
    const row = rows.find((r) => r.action === "access.denied");
    expect(row).toBeDefined();
    expect(row?.actor_sub).toBe("u3");
    expect(row?.target_id).toBe("acme");
  });

  it("writes an audit row on every mutation", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });
    await dispatch(
      mkReq("POST", "/api/products/djdl/license/licenses", {
        cookie,
        csrf,
        body: { name: "Grace", email: "g@x.io" },
      }),
      env,
      db,
      "/api/products/djdl/license/licenses",
    );
    const rows = await listAudit(db, "djdl", {});
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.action).toBe("license.create");
    // Actor is the verified session subject, never a request field.
    expect(rows[0]?.actor_sub).toBe("u1");
  });

  it("fails closed: with NO ADMIN_SESSION_SECRET, issuing/verifying a session throws (D1)", async () => {
    const env = adminEnv(new KvMock(), []);
    // Remove the secret — the worker must NOT fall back to a guessable signing key.
    delete (env as { ADMIN_SESSION_SECRET?: string }).ADMIN_SESSION_SECRET;
    await expect(
      issueSession(
        env,
        { sub: "u1", name: "Ada", email: "a@x.io", groups: [] },
        NOW,
      ),
    ).rejects.toThrow("ADMIN_SESSION_SECRET is required");
    // Verification of any token must also throw (so no request can authenticate).
    await expect(verifySession(env, "forged.token", NOW)).rejects.toThrow(
      "ADMIN_SESSION_SECRET is required",
    );
  });

  it("manual create with an uploaded schema yields a usable product (loadProduct + /config sign)", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });

    const schema = {
      schemaVersion: 1,
      entries: [
        {
          key: "run.concurrency",
          kind: "config",
          category: "run",
          label: "Concurrency",
          description: "",
          schema: { type: "integer", minimum: 1 },
        },
      ],
    };
    const created = await dispatch(
      mkReq("POST", "/api/products", {
        cookie,
        csrf,
        body: { slug: "manualco", name: "Manual Co", schema },
      }),
      env,
      db,
      "/api/products",
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      ok: boolean;
      slug: string;
      kid: string;
    };
    expect(body.slug).toBe("manualco");
    expect(typeof body.kid).toBe("string");

    // The product loads with a real, KEK-sealed signing key.
    const product = await loadProduct(env, db, "manualco");
    expect(product).not.toBeNull();
    expect(product!.signingKeyPem).toContain("BEGIN PRIVATE KEY");

    // The schema it uploaded is the active catalog.
    const schemaRes = await dispatch(
      mkReq("GET", "/api/products/manualco/config/catalog", { cookie }),
      env,
      db,
      "/api/products/manualco/config/catalog",
    );
    expect(await schemaRes.text()).toContain("run.concurrency");

    // /config signs: a doc signed under the product key verifies against its published pub.
    const profile: DocProfile = {
      name: "Ada",
      firstName: "Ada",
      email: "a@x.io",
      activatedAt: NOW,
    };
    const payload: ManagedPayload = {
      config: {},
      secrets: {},
      entitlements: {},
    };
    const doc = buildDoc({
      schemaVersion: product!.schemaVersion,
      aud: "manualco",
      licenseId: "lic_1",
      deviceId: "dev-1",
      now: NOW,
      maxOfflineDays: 30,
      profile,
      payload,
    });
    const jws = await signDoc(doc, product!.signingKeyPem, product!.signingKid);
    const verified = await verifyJws<FusedSessionDoc>(jws, {
      [product!.signingKid]: product!.signingPub!,
    });
    expect(verified).not.toBeNull();
    expect(verified!.payload.aud).toBe("manualco");
  });

  // ── P4 regression: manual-create atomicity ────────────────────────────────────
  // A manual product is minted in ONE batch: the `products` row AND an active `product_keys`
  // row must BOTH exist, so a product can never be half-created (a row with no usable signing
  // key). We assert both rows directly, then prove the pair is usable end-to-end (loadProduct
  // opens the sealed key + /config signs a verifiable doc).
  it("manual create atomically yields BOTH a products row AND an active product_keys row", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });

    const created = await dispatch(
      mkReq("POST", "/api/products", {
        cookie,
        csrf,
        body: { slug: "atomicco", name: "Atomic Co" },
      }),
      env,
      db,
      "/api/products",
    );
    expect(created.status).toBe(201);
    const { kid } = (await created.json()) as { kid: string };

    // 1) The products row exists.
    const productRow = await db.first<{ slug: string; signing_pub: string }>(
      "SELECT * FROM products WHERE slug = ?",
      "atomicco",
    );
    expect(productRow).not.toBeNull();

    // 2) An ACTIVE product_keys row exists for the SAME kid, with sealed private material.
    const keyRow = await getActiveProductKey(db, "atomicco");
    expect(keyRow).not.toBeNull();
    expect(keyRow!.kid).toBe(kid);
    expect(keyRow!.status).toBe("active");
    expect(keyRow!.public_b64url).toBe(productRow!.signing_pub);
    // Sealed at rest — the private key is never stored in plaintext.
    expect(keyRow!.enc_private_json).not.toContain("BEGIN PRIVATE KEY");

    // 3) The pair is usable: loadProduct opens the sealed key + /config signs a verifiable doc.
    const product = (await loadProduct(env, db, "atomicco"))!;
    expect(product.signingKeyPem).toContain("BEGIN PRIVATE KEY");
    const { key } = await seedLicenseWithKey(db, "atomicco");
    const activateRes = await handleActivate(
      mkLicReq("POST", {
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
    const cfgRes = await handleLicenseDocument(
      mkLicReq("GET", {
        authorization: `Bearer ${token}`,
        "x-pkey-version": "1.0.0",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(cfgRes.status).toBe(200);
    const verified = await verifyJws<LicenseDoc>(await cfgRes.text(), {
      [product.signingKid]: product.signingPub!,
    });
    expect(verified).not.toBeNull();
    expect(verified!.payload.aud).toBe("atomicco");
  });

  it("PUT secrets stores write-only (sealed, name echoed but never the value)", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });

    const res = await dispatch(
      mkReq("PUT", "/api/products/djdl/secrets/OIDC_SECRET", {
        cookie,
        csrf,
        body: { value: "super-secret-value" },
      }),
      env,
      db,
      "/api/products/djdl/secrets/OIDC_SECRET",
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("OIDC_SECRET");
    expect(body).not.toContain("super-secret-value");

    // Stored sealed; opening under the KEK recovers it (write-only from the API's POV).
    const row = await getProductSecret(db, "djdl", "OIDC_SECRET");
    expect(row).not.toBeNull();
    expect(row!.enc_value_json).not.toContain("super-secret-value");
    expect(
      await open(env, row!.enc_value_json, {
        product: "djdl",
        kind: "product-secret",
        id: "OIDC_SECRET",
      }),
    ).toBe("super-secret-value");
  });

  it("product detail reports persistent required-secret setup status", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run(
      `INSERT INTO oidc_config
         (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
       VALUES (?,?,?,?,?,?,?)`,
      "djdl",
      "custom",
      "https://id.example",
      "client-djdl",
      "OIDC_SECRET",
      "[]",
      "{}",
    );
    await db.run(
      `INSERT INTO edge_mint_config
         (product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience, auth_page_template)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      "djdl",
      "music",
      "ES256",
      "MUSIC_KEY",
      null,
      "{}",
      3600,
      "music.apple.com",
      null,
    );
    await seedProductSecret(db, "djdl", "OIDC_SECRET", "oidc-value");
    const { cookie } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });

    const res = await dispatch(
      mkReq("GET", "/api/products/djdl", { cookie }),
      env,
      db,
      "/api/products/djdl",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      product: {
        setup: {
          healthy: boolean;
          requiredSecrets: string[];
          missingSecrets: string[];
          secrets: Array<{ name: string; configured: boolean }>;
        };
      };
    };
    expect(body.product.setup.healthy).toBe(false);
    expect(body.product.setup.requiredSecrets).toEqual([
      "MUSIC_KEY",
      "OIDC_SECRET",
    ]);
    expect(body.product.setup.missingSecrets).toEqual(["MUSIC_KEY"]);
    expect(body.product.setup.secrets).toEqual([
      { name: "MUSIC_KEY", configured: false, sources: ["Edge mint music"] },
      {
        name: "OIDC_SECRET",
        configured: true,
        sources: ["OIDC client secret"],
      },
    ]);
  });

  it("the setup checklist flags an edge-mint recipe awaiting approval and a secret not marked edge-mint (P0-12)", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run(
      `INSERT INTO edge_mint_config
         (product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience, auth_page_template)
       VALUES ('djdl','music','ES256','MUSIC_KEY',NULL,'{}',3600,NULL,NULL)`,
    );
    // Configured, but as a GENERAL secret: the recipe could not sign with it.
    await seedProductSecret(db, "djdl", "MUSIC_KEY", "pem");
    const { cookie } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });
    type Setup = {
      healthy: boolean;
      missing: string[];
      modules: Array<{
        id: string;
        status: string;
        pendingApproval?: string[];
      }>;
      nextActions: Array<{ id: string }>;
    };
    const setup = async (): Promise<Setup> => {
      const res = await dispatch(
        mkReq("GET", "/api/products/djdl", { cookie }),
        env,
        db,
        "/api/products/djdl",
      );
      return ((await res.json()) as { product: { setup: Setup } }).product
        .setup;
    };

    let s = await setup();
    expect(s.healthy).toBe(false);
    expect(s.missing).toContain("edge mint: MUSIC_KEY is not marked edge-mint");
    expect(s.missing).toContain("edge mint: recipe music awaits approval");
    expect(s.modules.find((m) => m.id === "edgeMint")).toMatchObject({
      status: "needs-secret",
      pendingApproval: ["music"],
    });
    expect(s.nextActions.map((a) => a.id)).toEqual(
      expect.arrayContaining(["secret-usage:MUSIC_KEY", "edge-mint:music"]),
    );

    // Marked edge-mint: only the approval is left.
    await seedProductSecret(db, "djdl", "MUSIC_KEY", "pem", "edge-mint");
    s = await setup();
    expect(s.modules.find((m) => m.id === "edgeMint")?.status).toBe(
      "needs-approval",
    );
    expect(s.missing).not.toContain(
      "edge mint: MUSIC_KEY is not marked edge-mint",
    );

    // Approved: the module is configured and the checklist item is gone.
    await approveEdgeMintRecipe(db, "djdl", "music");
    s = await setup();
    expect(s.modules.find((m) => m.id === "edgeMint")).toMatchObject({
      status: "configured",
      pendingApproval: [],
    });
    expect(s.nextActions.map((a) => a.id)).not.toContain("edge-mint:music");
  });

  it("keys/rotate stages a new key, then break-glass activation retires the old key", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const before = await getActiveProductKey(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });

    const res = await dispatch(
      mkReq("POST", "/api/products/djdl/keys/rotate", { cookie, csrf }),
      env,
      db,
      "/api/products/djdl/keys/rotate",
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      ok: boolean;
      kid: string;
      publicKey: string;
      status: string;
    };
    expect(body.kid).not.toBe(before!.kid);
    expect(body.status).toBe("staged");
    // The response never leaks private key material.
    expect(text).not.toContain("BEGIN PRIVATE KEY");

    // Rotation only stages the key. The old active key continues signing until activation.
    let after = await getActiveProductKey(db, "djdl");
    expect(after!.kid).toBe(before!.kid);
    let staged = await db.first<{ status: string }>(
      "SELECT status FROM product_keys WHERE product = ? AND kid = ?",
      "djdl",
      body.kid,
    );
    expect(staged?.status).toBe("staged");

    const activate = await dispatch(
      mkReq("POST", "/api/products/djdl/keys/activate", {
        cookie,
        csrf,
        body: { kid: body.kid, breakGlass: true },
      }),
      env,
      db,
      "/api/products/djdl/keys/activate",
    );
    expect(activate.status).toBe(200);

    // The active key is now the staged key; the old one is retired.
    after = await getActiveProductKey(db, "djdl");
    expect(after!.kid).toBe(body.kid);
    const old = await db.first<{ status: string }>(
      "SELECT * FROM product_keys WHERE product = ? AND kid = ?",
      "djdl",
      before!.kid,
    );
    expect(old?.status).toBe("retired");
    staged = await db.first<{ status: string }>(
      "SELECT status FROM product_keys WHERE product = ? AND kid = ?",
      "djdl",
      body.kid,
    );
    expect(staged?.status).toBe("active");
    // loadProduct now signs under the rotated key.
    const product = await loadProduct(env, db, "djdl");
    expect(product!.signingKid).toBe(body.kid);
  });

  it("a manual product has NO release/mint capability (mint route 404s)", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });
    await dispatch(
      mkReq("POST", "/api/products", {
        cookie,
        csrf,
        body: { slug: "manualco", name: "Manual Co" },
      }),
      env,
      db,
      "/api/products",
    );
    const product = (await loadProduct(env, db, "manualco"))!;
    expect(product).not.toBeNull();

    // Activate a device so we hold a valid bearer (passes the confused-deputy guard) and then
    // attempt to mint — there is no edge_mint_config recipe, so the route 404s.
    const { key } = await seedLicenseWithKey(db, "manualco");
    const activateRes = await handleActivate(
      mkLicReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await activateRes.json()) as { token: string };

    const mintRes = await handleMintToken(
      mkLicReq("POST", { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "applemusic",
      NOW,
    );
    expect(mintRes.status).toBe(404);

    // And it has no release_config row either.
    const rel = await db.first(
      "SELECT * FROM release_config WHERE product = ?",
      "manualco",
    );
    expect(rel).toBeNull();
  });

  it("rate-limits repeated admin logins → eventually 429 (D5)", async () => {
    const env = adminEnv(new KvMock(), []);
    // Configure the IdP so login would otherwise 302; the limiter must bite first.
    env.ADMIN_OIDC_ISSUER = "https://id.example";
    env.ADMIN_OIDC_CLIENT_ID = "admin-client";
    const ip = "203.0.113.7";
    const req = () =>
      new Request("https://key.plrs.im/manage/login", {
        headers: { "cf-connecting-ip": ip },
      }) as unknown as Request;

    // Limit is 20/60s → the first 20 succeed (302), the 21st is throttled (429).
    let throttled = false;
    for (let i = 0; i < 25; i++) {
      const res = await handleAdminLogin(req(), env);
      if (res.status === 429) {
        throttled = true;
        break;
      }
      expect(res.status).toBe(302);
    }
    expect(throttled).toBe(true);
  });
});

// ── Service enablement (plan §R4, spec §2.2) ────────────────────────────────────────────────
//
// The admin half of the single authority. Three properties, and they fail differently:
//
//   1. COHERENCE. A PATCH that would produce an unreachable product (Update with no Release, a
//      registration policy nothing can satisfy) is refused BEFORE it is written — the column
//      decides which routes exist, so an incoherent value is an outage, not a typo.
//   2. OWNERSHIP. A PATCH claims the row; a resync then cannot re-open what an operator closed.
//      `revert` hands it back without changing the live values.
//   3. AUDIT. Every write names the verified actor.
describe("admin services enablement", () => {
  const ALL_OFF = {
    license: { enabled: false },
    config: { enabled: false },
    release: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
  };

  async function world(): Promise<{
    db: Db;
    env: Env;
    cookie: string;
    csrf: string;
  }> {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });
    return { db, env, cookie, csrf };
  }

  const path = (suffix = "") => `/api/products/djdl/services${suffix}`;

  async function call(
    w: Awaited<ReturnType<typeof world>>,
    method: string,
    suffix = "",
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const p = path(suffix);
    const res = await dispatch(
      mkReq(method, p, { cookie: w.cookie, csrf: w.csrf, body }),
      w.env,
      w.db,
      p,
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    };
  }

  it("GET returns the set, the declared policy, the effective one, and the owner", async () => {
    const w = await world();
    const { status, body } = await call(w, "GET");
    expect(status).toBe(200);
    expect(body.services).toEqual({
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    });
    // Nothing declared, so the policy is null and the wire enforces the derivation.
    expect(body.registration).toBeNull();
    expect(body.effectiveRegistration).toBe("requires-license");
    expect(body.source).toBe("manifest");
  });

  it("PATCH merges, claims the row, and is visible to loadProduct", async () => {
    const w = await world();
    const { status, body } = await call(w, "PATCH", "", {
      services: { release: { enabled: true }, update: { enabled: true } },
    });
    expect(status).toBe(200);
    expect(body.source).toBe("admin");
    // Omitted slugs keep their current values rather than reverting to a default.
    expect(body.services).toEqual({
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      update: { enabled: true },
      identity: { enabled: false },
    });
    const product = await loadProduct(w.env, w.db, "djdl");
    expect(product?.services.update.enabled).toBe(true);
  });

  it("PATCH refuses an incoherent set without writing it", async () => {
    const w = await world();
    const bad = await call(w, "PATCH", "", {
      services: { update: { enabled: true } },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual(["update_requires_release"]);
    // Nothing was written: the row is still manifest-owned with the defaults.
    const after = await call(w, "GET");
    expect(after.body.source).toBe("manifest");
    expect(after.body.services).toMatchObject({ update: { enabled: false } });
  });

  it("PATCH refuses a registration policy nothing could satisfy", async () => {
    const w = await world();
    const noIdentity = await call(w, "PATCH", "", {
      registration: "requires-identity",
    });
    expect(noIdentity.status).toBe(422);
    expect(noIdentity.body.errors).toEqual(["registration_requires_identity"]);

    const stranded = await call(w, "PATCH", "", {
      services: { license: { enabled: false } },
      registration: "requires-license",
    });
    expect(stranded.status).toBe(422);
    expect(stranded.body.errors).toEqual(["config_without_activation"]);
  });

  it("PATCH sets and clears the declared policy independently of the set", async () => {
    const w = await world();
    const declared = await call(w, "PATCH", "", { registration: "open" });
    expect(declared.status).toBe(200);
    expect(declared.body.registration).toBe("open");
    expect(declared.body.effectiveRegistration).toBe("open");
    expect((await loadProduct(w.env, w.db, "djdl"))?.registration).toBe("open");

    // `null` CLEARS it — the product goes back to following its services. Omitting the key
    // would have left `open` in place, which is why the two have to be expressible separately.
    const cleared = await call(w, "PATCH", "", { registration: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.registration).toBeNull();
    expect(cleared.body.effectiveRegistration).toBe("requires-license");
  });

  it("PATCH rejects malformed input by field", async () => {
    const w = await world();
    for (const [body, field] of [
      [{ services: [] }, "services"],
      [{ services: { telemetry: { enabled: true } } }, "services.telemetry"],
      [{ services: { license: true } }, "services.license.enabled"],
      [
        { services: { license: { enabled: "yes" } } },
        "services.license.enabled",
      ],
      [{ registration: "OPEN" }, "registration"],
      [{ registration: 1 }, "registration"],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await call(w, "PATCH", "", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.fields).toContain(field);
    }
  });

  it("an admin claim survives a manifest resync; revert hands the row back", async () => {
    const w = await world();
    // Operator turns Config off live.
    expect(
      (await call(w, "PATCH", "", { services: { config: { enabled: false } } }))
        .status,
    ).toBe(200);

    // A push re-applies a manifest that wants everything on. It must not land.
    await setServices(
      w.db,
      "djdl",
      JSON.stringify({
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        update: { enabled: true },
        identity: { enabled: true },
      }),
      "manifest",
      NOW + 1,
    );
    const claimed = await call(w, "GET");
    expect(claimed.body.source).toBe("admin");
    expect(claimed.body.services).toMatchObject({ config: { enabled: false } });

    // Revert changes the OWNER and nothing else — the live set is untouched until the next
    // resync actually re-applies the manifest.
    const reverted = await call(w, "POST", "/revert");
    expect(reverted.status).toBe(200);
    expect(reverted.body.source).toBe("manifest");
    expect(reverted.body.services).toMatchObject({
      config: { enabled: false },
    });

    // …and now a resync is permitted to write again.
    await setServices(
      w.db,
      "djdl",
      JSON.stringify(ALL_OFF),
      "manifest",
      NOW + 2,
    );
    expect((await call(w, "GET")).body.services).toEqual(ALL_OFF);
  });

  it("audits both writes with the verified actor", async () => {
    const w = await world();
    await call(w, "PATCH", "", { services: { release: { enabled: true } } });
    await call(w, "POST", "/revert");
    const actions = (await listAudit(w.db, "djdl", { limit: 20 })).map(
      (r) => r.action,
    );
    expect(actions).toContain("product.services.update");
    expect(actions).toContain("product.services.revert");
    const row = (await listAudit(w.db, "djdl", { limit: 20 })).find(
      (r) => r.action === "product.services.update",
    );
    expect(row?.actor_sub).toBe("u1");
  });

  it("requires a session, a platform admin, and CSRF on the mutation", async () => {
    const w = await world();
    const p = path();
    // No session at all.
    expect((await dispatch(mkReq("GET", p), w.env, w.db, p)).status).toBe(401);
    // Signed in, but not a platform admin.
    const weak = await sessionCookie(w.env, {
      sub: "u9",
      name: "Bob",
      email: "b@x.io",
      groups: [],
    });
    expect(
      (await dispatch(mkReq("GET", p, { cookie: weak.cookie }), w.env, w.db, p))
        .status,
    ).toBe(403);
    // Platform admin, mutation, no CSRF token.
    expect(
      (
        await dispatch(
          mkReq("PATCH", p, { cookie: w.cookie, body: {} }),
          w.env,
          w.db,
          p,
        )
      ).status,
    ).toBe(403);
  });

  it("404s an unknown product and an unknown sub-action", async () => {
    const w = await world();
    const missing = "/api/products/nope/services";
    expect(
      (
        await dispatch(
          mkReq("GET", missing, { cookie: w.cookie }),
          w.env,
          w.db,
          missing,
        )
      ).status,
    ).toBe(404);
    expect((await call(w, "GET", "/whatever")).status).toBe(404);
    expect((await call(w, "DELETE", "")).status).toBe(405);
    expect((await call(w, "GET", "/revert")).status).toBe(405);
  });
});
