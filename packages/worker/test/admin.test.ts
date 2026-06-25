import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq as mkLicReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
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
} from "../src/repo.js";
import { loadProduct } from "../src/product.js";
import { handleConfig, handleEnroll } from "../src/licensing.js";
import { handleMintToken } from "../src/edgeMint.js";
import { buildDoc, signDoc } from "../src/configDoc.js";
import { open } from "../src/keyvault.js";
import { verifyJws } from "@polaris-key/jws";
import type {
  ManagedConfigDoc,
  ManagedPayload,
  DocProfile,
} from "@polaris-key/protocol";
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
    `https://key.plrs.im/admin${path}`,
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
        signingPublicKey: string | null;
        signingKey: { kid: string; alg: string; publicKey: string } | null;
      };
    };
    expect(body.product.releaseSource).toBe("github");
    expect(body.product.signingKid).toBe("pkey-test-prod-2026");
    expect(body.product.signingPublicKey).toBeTruthy();
    expect(body.product.signingKey).toMatchObject({
      kid: "pkey-test-prod-2026",
      alg: "Ed25519",
      publicKey: body.product.signingPublicKey,
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
        signingPublicKey: string | null;
        signingKey: unknown;
      }>;
    };
    const djdl = body.products.find((p) => p.slug === "djdl");
    expect(djdl).toBeDefined();
    expect(djdl!.signingPublicKey).toBeNull();
    expect(djdl!.signingKey).toBeNull();
  });

  it("product deletion removes sealed keys and secrets", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedProductSecret(db, "djdl", "OIDC_SECRET", "secret-value");
    expect(
      await db.first("SELECT * FROM product_keys WHERE product = ?", "djdl"),
    ).not.toBeNull();
    expect(
      await db.first("SELECT * FROM product_secrets WHERE product = ?", "djdl"),
    ).not.toBeNull();

    const { cookie, csrf } = await sessionCookie(env, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });
    const res = await dispatch(
      mkReq("DELETE", "/api/products/djdl", { cookie, csrf }),
      env,
      db,
      "/api/products/djdl",
    );
    expect(res.status).toBe(200);

    expect(
      await db.first("SELECT * FROM products WHERE slug = ?", "djdl"),
    ).toBeNull();
    expect(
      await db.first("SELECT * FROM product_keys WHERE product = ?", "djdl"),
    ).toBeNull();
    expect(
      await db.first("SELECT * FROM product_secrets WHERE product = ?", "djdl"),
    ).toBeNull();
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
      mkReq("POST", "/api/products/djdl/licenses", {
        cookie,
        csrf,
        body: { name: "Grace", email: "g@x.io" },
      }),
      env,
      db,
      "/api/products/djdl/licenses",
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { licenseId: string; key: string };
    expect(body.key.startsWith("pkey_djdl_")).toBe(true);

    // GET the license detail — the raw key is NOT echoed back.
    const detailRes = await dispatch(
      mkReq("GET", `/api/products/djdl/licenses/${body.licenseId}`, { cookie }),
      env,
      db,
      `/api/products/djdl/licenses/${body.licenseId}`,
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
      mkReq("POST", "/api/products/djdl/licenses", {
        cookie,
        body: { name: "X" },
      }),
      env,
      db,
      "/api/products/djdl/licenses",
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
      mkReq("PUT", "/api/products/djdl/schema", {
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
      "/api/products/djdl/schema",
    );
    expect(bad.status).toBe(422);

    // A well-formed catalog publishes.
    const good = await dispatch(
      mkReq("PUT", "/api/products/djdl/schema", {
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
      "/api/products/djdl/schema",
    );
    expect(good.status).toBe(200);

    // And an override against it is catalog-validated (bad value ⇒ 422).
    const lic = await dispatch(
      mkReq("POST", "/api/products/djdl/licenses", {
        cookie,
        csrf,
        body: { name: "Z", email: "z@x.io" },
      }),
      env,
      db,
      "/api/products/djdl/licenses",
    );
    const { licenseId } = (await lic.json()) as { licenseId: string };
    const badOverride = await dispatch(
      mkReq("PUT", `/api/products/djdl/licenses/${licenseId}/overrides`, {
        cookie,
        csrf,
        body: { updates: [{ key: "run.concurrency", value: 0 }] },
      }),
      env,
      db,
      `/api/products/djdl/licenses/${licenseId}/overrides`,
    );
    expect(badOverride.status).toBe(422);
  });

  it("cannot touch another product the session does not administer", async () => {
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

    // A djdl-only admin (NOT platform) can read djdl but not acme.
    const { cookie } = await sessionCookie(env, {
      sub: "u3",
      name: "Cy",
      email: "c@x.io",
      groups: [DJDL_ADMIN_GROUP],
    });
    const okHere = await dispatch(
      mkReq("GET", "/api/products/djdl/licenses", { cookie }),
      env,
      db,
      "/api/products/djdl/licenses",
    );
    expect(okHere.status).toBe(200);

    const deniedThere = await dispatch(
      mkReq("GET", "/api/products/acme/licenses", { cookie }),
      env,
      db,
      "/api/products/acme/licenses",
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

    // Enroll a device so a token record lands in KV.
    const enrollRes = await handleEnroll(
      mkLicReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await enrollRes.json()) as { token: string };
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
      mkReq("POST", `/api/products/djdl/licenses/${licenseId}/disable`, {
        cookie,
        csrf,
      }),
      env,
      db,
      `/api/products/djdl/licenses/${licenseId}/disable`,
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
      mkReq("GET", "/api/products/acme/licenses", { cookie }),
      env,
      db,
      "/api/products/acme/licenses",
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
      mkReq("POST", "/api/products/djdl/licenses", {
        cookie,
        csrf,
        body: { name: "Grace", email: "g@x.io" },
      }),
      env,
      db,
      "/api/products/djdl/licenses",
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
      mkReq("GET", "/api/products/manualco/schema", { cookie }),
      env,
      db,
      "/api/products/manualco/schema",
    );
    expect(await schemaRes.text()).toContain("run.concurrency");

    // /config signs: a doc signed under the product key verifies against its published pub.
    const profile: DocProfile = {
      name: "Ada",
      firstName: "Ada",
      email: "a@x.io",
      enrolledAt: NOW,
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
    const verified = await verifyJws<ManagedConfigDoc>(jws, {
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
    const enrollRes = await handleEnroll(
      mkLicReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(enrollRes.status).toBe(200);
    const { token } = (await enrollRes.json()) as { token: string };
    const cfgRes = await handleConfig(
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
    const verified = await verifyJws<ManagedConfigDoc>(await cfgRes.text(), {
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
    expect(await open(env, row!.enc_value_json)).toBe("super-secret-value");
  });

  it("keys/rotate retires the old key and activates a new kid (private never returned)", async () => {
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
    };
    expect(body.kid).not.toBe(before!.kid);
    // The response never leaks private key material.
    expect(text).not.toContain("BEGIN PRIVATE KEY");

    // The active key is the new one; the old one is retired.
    const after = await getActiveProductKey(db, "djdl");
    expect(after!.kid).toBe(body.kid);
    const old = await db.first<{ status: string }>(
      "SELECT * FROM product_keys WHERE product = ? AND kid = ?",
      "djdl",
      before!.kid,
    );
    expect(old?.status).toBe("retired");
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

    // Enroll a device so we hold a valid bearer (passes the confused-deputy guard) and then
    // attempt to mint — there is no edge_mint_config recipe, so the route 404s.
    const { key } = await seedLicenseWithKey(db, "manualco");
    const enrollRes = await handleEnroll(
      mkLicReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await enrollRes.json()) as { token: string };

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
      new Request("https://key.plrs.im/admin/login", {
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
