import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  makeEnv,
  mkReq as mkLicReq,
  NOW,
  seedLicenseWithKey,
  seedTier,
  seedProduct,
  approveEdgeMintRecipe,
  seedProductSecret,
} from "../seed.js";
import type { Env } from "../../src/platform/env.js";
import type { Db } from "../../src/db/types.js";
import { handleAdmin } from "../../src/console/index.js";
import { handleAdminLogin } from "../../src/console/auth.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  verifySession,
  type SessionIdentity,
} from "../../src/core/console/session.js";
import {
  getActiveProductKey,
  getProduct,
  getProductSecret,
  setServices,
} from "../../src/core/products/store.js";
import { listAudit } from "../../src/core/audit.js";
import { SETTINGS } from "../../src/mount.js";
import { loadProduct } from "../../src/core/products.js";
import type { ServiceHooks } from "../../src/core/hooks.js";
import type { ServiceDescriptor } from "../../src/core/registry.js";
import { releaseService } from "../../src/services/release/index.js";
import { updateService } from "../../src/services/update/index.js";
import { handleActivate } from "../../src/services/license/activation.js";
import { handleLicenseDocument } from "../../src/services/license/document.js";
import { handleMintToken } from "../../src/services/config/mint.js";
import { buildDoc } from "../../src/services/identity/doc.js";
import { signDoc } from "../../src/core/signing.js";
import { open } from "../../src/platform/keyvault.js";
import { verifyJws } from "@polaris-key/jws";
import type { DocProfile } from "@polaris-key/protocol";
import type { FusedSessionDoc } from "../../src/services/identity/doc.js";
import type { ManagedPayload } from "../../src/core/licensing/payload.js";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { MAX_DEVICE_LIMIT } from "@polaris-key/manifest";
import { getTokenRecord, putTokenRecord } from "../../src/platform/kv.js";
import { hashKey } from "../../src/platform/crypto.js";
import { consoleTestSession, consoleActor } from "../consoleSessionHelper.js";

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
  db: Db,
  identity: SessionIdentity,
): Promise<{ cookie: string; csrf: string }> {
  const { token, session } = await consoleTestSession(
    env,
    db,
    { authTime: NOW, stepUp: true, ...identity },
    NOW,
  );
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

/** The ids `GET /api/attention` answers for the signed-in operator. */
async function attentionIds(
  env: Env,
  db: ReturnType<typeof makeTestDb>,
  cookie: string,
): Promise<string[]> {
  const res = await dispatch(
    mkReq("GET", "/api/attention", { cookie }),
    env,
    db,
    "/api/attention",
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Array<{ id: string }> }).items.map(
    (i) => i.id,
  );
}

describe("admin api", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    const res = await dispatch(mkReq("GET", "/api/me"), env, db, "/api/me");
    expect(res.status).toBe(401);
    // A first visit: no session was presented, so nothing says one ended.
    expect(res.headers.get("x-pkey-session")).toBeNull();
  });

  it("marks a 401 for a session cookie that no longer verifies as expired", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    const req = new Request("https://key.plrs.im/manage/api/me", {
      headers: { cookie: "__Host-pkey_admin=not-a-session" },
    }) as unknown as Request;
    const res = await dispatch(req, env, db, "/api/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("x-pkey-session")).toBe("expired");
  });

  it("returns the signed-in identity at /api/me", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie } = await sessionCookie(env, db, {
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
    expect(body.sub).toBe(await consoleActor(env, db, "u1"));
    expect(body.platformAdmin).toBe(true);
    expect(typeof body.csrf).toBe("string");
  });

  it("/api/me names the deployment and when the session ends (ADMIN.md A-1)", async () => {
    const me = async (
      environment: string | undefined,
    ): Promise<{ environment: unknown; sessionExpiresAt: unknown }> => {
      const db = makeTestDb();
      const env = adminEnv(new KvMock(), []);
      if (environment !== undefined) env.PKEY_ENVIRONMENT = environment;
      const { cookie } = await sessionCookie(env, db, {
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
      return (await res.json()) as {
        environment: unknown;
        sessionExpiresAt: unknown;
      };
    };

    for (const value of ["prod", "staging", "dev"]) {
      expect((await me(value)).environment).toBe(value);
    }
    expect((await me(" Staging ")).environment).toBe("staging");
    // Unset or unrecognised: `null`, and the raw value is never echoed.
    expect((await me(undefined)).environment).toBeNull();
    expect((await me("<script>")).environment).toBeNull();

    // The session's own signed expiry, in epoch seconds: a hard 8 h after it was issued.
    const { sessionExpiresAt } = await me("prod");
    expect(typeof sessionExpiresAt).toBe("number");
    expect(sessionExpiresAt).toBe(NOW + 8 * 60 * 60);
  });

  it("/api/me names the customer origin only while the customer host is usable (LK-17), and says whether email can be sent", async () => {
    const read = async (
      set: boolean,
    ): Promise<{ customerOrigin?: string | null; emailOn?: boolean }> => {
      const env = adminEnv(new KvMock(), []);
      env.CONSOLE_ORIGIN = "https://key.plrs.im";
      if (set) {
        env.CUSTOMER_ORIGIN = "https://polaris.locker";
        env.EMAIL = { send: async () => ({}) } as never;
      }
      const db = makeTestDb();
      const { cookie } = await sessionCookie(env, db, {
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
      return (await res.json()) as {
        customerOrigin?: string | null;
        emailOn?: boolean;
      };
    };
    expect(await read(true)).toMatchObject({
      customerOrigin: "https://polaris.locker",
      emailOn: true,
    });
    expect(await read(false)).toMatchObject({
      customerOrigin: null,
      emailOn: false,
    });
  });

  it("every deployment in wrangler.toml names itself to the console", async () => {
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync(
      new URL("../../wrangler.toml", import.meta.url),
      "utf8",
    );
    for (const env of ["prod", "staging", "dev"]) {
      const block = toml.split(`[env.${env}.vars]`)[1]!.split("\n[")[0]!;
      expect(block, env).toContain(`PKEY_ENVIRONMENT = "${env}"`);
    }
  });

  it("product create requires a platform admin", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    // A non-platform admin (no groups) cannot create a product.
    const weak = await sessionCookie(env, db, {
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
    const strong = await sessionCookie(env, db, {
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
    const { cookie } = await sessionCookie(env, db, {
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
    expect(body.product.releaseSource).toBe("github");
    expect(body.product.signingKid).toBe("pkey-test-prod-2026");
    expect(body.product.signing).toMatchObject({
      kid: "pkey-test-prod-2026",
      alg: "Ed25519",
      publicKey: expect.any(String),
    });
    expect(body.product.sync).toMatchObject({
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
    const { cookie } = await sessionCookie(env, db, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });

    // The list is the slim projection (ST-44); the signing block rides the one-product read.
    const res = await dispatch(
      mkReq("GET", "/api/products/djdl", { cookie }),
      env,
      db,
      "/api/products/djdl",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      product: { slug: string; signing?: unknown | null };
    };
    expect(body.product.slug).toBe("djdl");
    expect(body.product.signing).toBeNull();
  });

  it("refuses the retired per-product toggles with 422, naming each (I-29)", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, db, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });
    const retired = [
      "oidcEnabled",
      "magicEnabled",
      "licenseKeyClaimEnabled",
      "releasesEnabled",
      "autoLinkEnabled",
    ];
    for (const key of retired) {
      const res = await dispatch(
        mkReq("PATCH", "/api/products/djdl/identity/portal", {
          cookie,
          csrf,
          body: { [key]: false },
        }),
        env,
        db,
        "/api/products/djdl/identity/portal",
      );
      expect(res.status, key).toBe(422);
      expect(JSON.stringify(await res.json())).toContain(key);
    }
  });

  it("reads and updates per-product customer portal settings", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, db, {
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
          keyReissueEnabled: true,
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
        keyReissueEnabled: boolean;
      };
    };
    expect(settingsBody.settings).toMatchObject({
      portalEnabled: true,
      keyReissueEnabled: true,
    });
    // I-29: the retired toggles are not part of the settings at all.
    expect(settingsBody.settings).not.toHaveProperty("oidcEnabled");
    expect(settingsBody.settings).not.toHaveProperty("magicEnabled");

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

    const { cookie, csrf } = await sessionCookie(env, db, {
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

  it("product deletion runs the Cloud Sync purge before the per-device token deletes (SR-1 N6)", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = adminEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, token_hash)
       VALUES ('djdl', 'dev-1', 'lic-1', 'authorized', ?, ?, 'th-dev-1')`,
      NOW,
      NOW,
    );
    await putTokenRecord(env, "djdl", "th-dev-1", {
      product: "djdl",
      deviceId: "dev-1",
      licenseId: "lic-1",
    });
    // More objects than one run erases, so the first attempt answers purge_incomplete.
    await db.batch(
      Array.from({ length: 405 }, (_, i) => ({
        sql: `INSERT INTO sync_directory (product, subject, bytes, settings, records, files, revision_bytes,
                quota_bytes, tier_id, platform, last_active_at, updated_at)
              VALUES (?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, 1, 1)`,
        params: ["djdl", `ps_${String(i).padStart(4, "0")}`],
      })),
    );
    const { cookie, csrf } = await sessionCookie(env, db, {
      sub: "u1",
      name: "Ada",
      email: "ada@x.io",
      groups: [PLATFORM_GROUP],
    });
    const del = () =>
      dispatch(
        mkReq("DELETE", "/api/products/djdl", {
          cookie,
          csrf,
          body: { confirmSlug: "djdl" },
        }),
        env,
        db,
        "/api/products/djdl",
      );
    expect((await del()).status).toBe(409);
    // The bounded purge ran first and was not finished: no token was spent on yet.
    expect(await getTokenRecord(env, "djdl", "th-dev-1")).not.toBeNull();
    expect((await del()).status).toBe(200);
    expect(await getTokenRecord(env, "djdl", "th-dev-1")).toBeNull();
  });

  it("creates a license and mints a key returned exactly once", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, db, {
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
    const { cookie } = await sessionCookie(env, db, {
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
    const { cookie, csrf } = await sessionCookie(env, db, {
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
    const { cookie } = await sessionCookie(env, db, {
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
    const { cookie, csrf } = await sessionCookie(env, db, {
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
    const { cookie } = await sessionCookie(env, db, {
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
    expect(row?.actor_sub).toBe(await consoleActor(env, db, "u3"));
    expect(row?.target_id).toBe("acme");
  });

  it("writes an audit row on every mutation", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, db, {
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
    expect(rows[0]?.actor_sub).toBe(await consoleActor(env, db, "u1"));
  });

  it("fails closed: with NO ADMIN_SESSION_SECRET, issuing a session throws and verifying returns null (D1)", async () => {
    const env = adminEnv(new KvMock(), []);
    // Remove the secret — the worker must NOT fall back to a guessable signing key.
    delete (env as { ADMIN_SESSION_SECRET?: string }).ADMIN_SESSION_SECRET;
    await expect(
      consoleTestSession(
        env,
        makeTestDb(),
        { sub: "u1", name: "Ada", email: "a@x.io", groups: [] },
        NOW,
      ),
    ).rejects.toThrow("ADMIN_SESSION_SECRET is required");
    // Verification of any token is null (no request can authenticate), not a thrown error.
    expect(await verifySession(env, "forged.token", NOW)).toBeNull();
  });

  it("manual create with an uploaded schema yields a usable product (loadProduct + /config sign)", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    const { cookie, csrf } = await sessionCookie(env, db, {
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

    // The product's accessor opens a real, KEK-sealed signing key.
    const product = await loadProduct(env, db, "manualco");
    expect(product).not.toBeNull();
    expect(await product!.signingKey()).toContain("BEGIN PRIVATE KEY");

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
    const jws = await signDoc(
      doc,
      (await product!.signingKey())!,
      product!.signingKid,
    );
    const verified = await verifyJws<FusedSessionDoc>(jws, {
      [product!.signingKid]: product!.signingPub!,
    });
    expect(verified).not.toBeNull();
    expect(verified!.payload.aud).toBe("manualco");
  });

  // ── Manual-create atomicity ───────────────────────────────────────────────────
  // A manual product is minted in ONE batch: the `products` row AND an active `product_keys`
  // row must BOTH exist, so a product can never be half-created (a row with no usable signing
  // key). We assert both rows directly, then prove the pair is usable end-to-end (the accessor
  // opens the sealed key + /config signs a verifiable doc).
  it("manual create atomically yields BOTH a products row AND an active product_keys row", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    const { cookie, csrf } = await sessionCookie(env, db, {
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

    // 3) The pair is usable: the signing-key accessor opens the sealed key + /config signs.
    const product = (await loadProduct(env, db, "atomicco"))!;
    expect(await product.signingKey()).toContain("BEGIN PRIVATE KEY");
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
    const { cookie, csrf } = await sessionCookie(env, db, {
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
    const { cookie } = await sessionCookie(env, db, {
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
    const body = (await res.json()) as { product: Record<string, unknown> };
    expect(body.product).not.toHaveProperty("setup");
    expect(body.product).not.toHaveProperty("onboarding");
    expect(body.product).not.toHaveProperty("modules");
    // The secrets inventory names the required secrets and says which have a value.
    const inv = await dispatch(
      mkReq("GET", "/api/products/djdl/secrets", { cookie }),
      env,
      db,
      "/api/products/djdl/secrets",
    );
    const listing = (await inv.json()) as {
      secrets: Array<{ name: string; configured: boolean }>;
    };
    expect(listing.secrets.map((s) => [s.name, s.configured])).toEqual([
      ["MUSIC_KEY", false],
      ["OIDC_SECRET", true],
    ]);
    // Attention names the one that is missing.
    expect(await attentionIds(env, db, cookie)).toContain(
      "djdl:secret.missing:MUSIC_KEY",
    );
  });

  it("attention flags an edge-mint recipe awaiting approval and a secret not marked edge-mint (P0-12)", async () => {
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
    const { cookie } = await sessionCookie(env, db, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });
    const ids = () => attentionIds(env, db, cookie);

    expect(await ids()).toEqual(
      expect.arrayContaining([
        "djdl:secret.usage:MUSIC_KEY",
        "djdl:mint.pending:music",
      ]),
    );

    // Marked edge-mint: only the approval is left.
    await seedProductSecret(db, "djdl", "MUSIC_KEY", "pem", "edge-mint");
    expect(await ids()).toEqual(["djdl:mint.pending:music"]);

    // Approved: the item is gone.
    await approveEdgeMintRecipe(db, "djdl", "music");
    expect(await ids()).toEqual([]);

    // Anonymous enrolment makes the mint public: an approval without the acknowledgement no
    // longer counts, and the recipe is back.
    await db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = 'djdl'",
      JSON.stringify({ enabled: true, tierId: "free", mode: "anonymous" }),
    );
    expect(await ids()).toEqual(["djdl:mint.pending:music"]);
    await approveEdgeMintRecipe(db, "djdl", "music", {
      acknowledgeOpenRegistration: true,
    });
    expect(await ids()).toEqual([]);
  });

  it("keys/rotate stages a new key, then break-glass activation retires the old key", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    const before = await getActiveProductKey(db, "djdl");
    const { cookie, csrf } = await sessionCookie(env, db, {
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
    const { cookie, csrf } = await sessionCookie(env, db, {
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
      new Request("https://key.plrs.im/manage/login?go=1", {
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
    distribution: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
    sync: { enabled: false },
    commerce: { enabled: false },
    connect: { enabled: false },
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
    const { cookie, csrf } = await sessionCookie(env, db, {
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

  it("GET returns the set, effective policy, and owner", async () => {
    const w = await world();
    const { status, body } = await call(w, "GET");
    expect(status).toBe(200);
    expect(body.services).toEqual({
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
      sync: { enabled: false },
      commerce: { enabled: false },
      connect: { enabled: false },
    });
    expect(body.effectiveRegistration).toBe("requires-license");
    expect(body.source).toBe("manifest");
  });

  it("GET, PATCH and revert all report facts counted from the rows, and a dry run reports none", async () => {
    const w = await world();
    await seedTier(w.db, "djdl", "free");
    await seedTier(w.db, "djdl", "pro");
    await seedLicenseWithKey(w.db, "djdl", { id: "lic_a" });
    await seedLicenseWithKey(w.db, "djdl", { id: "lic_b" });
    await seedLicenseWithKey(w.db, "djdl", { id: "lic_c" });
    await w.db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, channel, metadata_access, artifacts_access,
          published_at, created_at, modified_at)
       VALUES ('djdl', 'rel_1', '2.4.0', 'beta', 'public', 'public', ?, ?, ?)`,
      NOW,
      NOW,
      NOW,
    );
    const expected = {
      licensing: { tiers: 2, licenses: 3 },
      managedConfig: { catalogVersion: 1 },
      shipBuilds: { latest: { version: "2.4.0", channel: "beta" } },
      commerce: { storefronts: 0, storeGrants: 0 },
    };

    expect((await call(w, "GET")).body.facts).toEqual(expected);

    // A write that adds a licence in between would show here if facts were read before it.
    const patched = await call(w, "PATCH", "", {
      services: { identity: { enabled: true } },
    });
    expect(patched.status).toBe(200);
    // LX-33.7: a services write seeds the Default tier of a License product that has none.
    expect(patched.body.facts).toEqual({
      ...expected,
      licensing: { tiers: 3, licenses: 3 },
    });

    const dry = await call(w, "PATCH", "?dryRun=1", {
      services: { identity: { enabled: false } },
    });
    expect(dry.status).toBe(200);
    expect(dry.body).not.toHaveProperty("facts");
    expect(
      (await loadProduct(w.env, w.db, "djdl"))?.services.identity.enabled,
    ).toBe(true);

    expect((await call(w, "POST", "/revert")).body.facts).toEqual({
      ...expected,
      licensing: { tiers: 3, licenses: 3 },
    });
  });

  it("PATCH merges, claims the row, and is visible to loadProduct", async () => {
    const w = await world();
    const { status, body } = await call(w, "PATCH", "", {
      services: {
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
      },
    });
    expect(status).toBe(200);
    expect(body.source).toBe("admin");
    expect(body.facts).toMatchObject({
      licensing: { tiers: 1, licenses: 0 },
      managedConfig: { catalogVersion: 1 },
      shipBuilds: { latest: null },
      commerce: { storefronts: 0, storeGrants: 0 },
    });
    expect(body.services).toEqual({
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: true },
      identity: { enabled: false },
      sync: { enabled: false },
      commerce: { enabled: false },
      connect: { enabled: false },
    });
    const product = await loadProduct(w.env, w.db, "djdl");
    expect(product?.services.update.enabled).toBe(true);
  });

  it("PATCH applies submitted changes and cascades dependents under the requirement rule", async () => {
    const w = await world();
    const enabled = await call(w, "PATCH", "", {
      services: {
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
      },
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.services).toMatchObject({
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: true },
    });

    const disabled = await call(w, "PATCH", "", {
      services: { release: { enabled: false } },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.services).toMatchObject({
      release: { enabled: false },
      distribution: { enabled: false },
      update: { enabled: false },
    });
  });

  it("records Ship builds turned on, and the cascade of turning Release off, as one audit row each (ST-38)", async () => {
    const w = await world();
    await call(w, "PATCH", "", {
      services: {
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
      },
    });
    await call(w, "PATCH", "", { services: { release: { enabled: false } } });
    const rows = (await listAudit(w.db, "djdl", { limit: 20 })).filter(
      (r) => r.action === "product.services.update",
    );
    // Three slugs written by one PATCH are one audited batch, not one row per slug, and the two
    // dependents the second PATCH takes with Release share its row.
    expect(rows).toHaveLength(2);
    const summaries = rows.map((r) => r.summary ?? "");
    expect(summaries).toContainEqual(
      expect.stringContaining("license, config, release, distribution, update"),
    );
    expect(summaries).toContainEqual(
      expect.stringContaining(
        "distribution, update turned off with what they require",
      ),
    );
  });

  it("PATCH preserves a slug from a newer build it does not know (P0-08)", async () => {
    const w = await world();
    await setServices(
      w.db,
      "djdl",
      '{"license":{"enabled":true},"config":{"enabled":true},"release":{"enabled":false},"update":{"enabled":false},"identity":{"enabled":false},"zeta":{"enabled":true}}',
      "manifest",
      NOW,
    );
    const { status } = await call(w, "PATCH", "", {
      services: { release: { enabled: true } },
    });
    expect(status).toBe(200);
    const row = await getProduct(w.db, "djdl");
    expect(row?.services_json).toBe(
      '{"license":{"enabled":true},"config":{"enabled":true},"release":{"enabled":true},"distribution":{"enabled":false},"update":{"enabled":false},"identity":{"enabled":false},"sync":{"enabled":false},"commerce":{"enabled":false},"connect":{"enabled":false},"zeta":{"enabled":true}}',
    );
    // The console still cannot patch a slug it does not know.
    const bad = await call(w, "PATCH", "", {
      services: { zeta: { enabled: false } },
    });
    expect(bad.status).toBe(422);
  });

  it("PATCH refuses an incoherent set without writing it", async () => {
    const w = await world();
    const bad = await call(w, "PATCH", "", {
      services: { update: { enabled: true } },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual(["update_requires_distribution"]);
    // Nothing was written: the row is still manifest-owned with the defaults.
    const after = await call(w, "GET");
    expect(after.body.source).toBe("manifest");
    expect(after.body.services).toMatchObject({ update: { enabled: false } });
  });

  it("PATCH refuses Cloud Sync without Config and Identity, then cascades it off with a requirement (U-04)", async () => {
    const w = await world();
    // Defaults: License + Config on, Identity off. Cloud Sync needs Identity.
    const noIdentity = await call(w, "PATCH", "", {
      services: { sync: { enabled: true } },
    });
    expect(noIdentity.status).toBe(422);
    expect(noIdentity.body.errors).toEqual(["sync_requires_identity"]);
    const noConfig = await call(w, "PATCH", "", {
      services: {
        config: { enabled: false },
        identity: { enabled: true },
        sync: { enabled: true },
      },
    });
    expect(noConfig.status).toBe(422);
    expect(noConfig.body.errors).toContain("sync_requires_config");
    // With both, it turns on; turning off a requirement cascades it off in the same write.
    const on = await call(w, "PATCH", "", {
      services: {
        identity: { enabled: true },
        sync: { enabled: true },
      },
    });
    expect(on.status).toBe(200);
    const identityOff = await call(w, "PATCH", "", {
      services: { identity: { enabled: false } },
    });
    expect(identityOff.status).toBe(200);
    expect(identityOff.body.services).toMatchObject({
      identity: { enabled: false },
      sync: { enabled: false },
      commerce: { enabled: false },
      connect: { enabled: false },
    });
  });

  it("PATCH refuses Commerce without License; turning License off turns Commerce off in one audit row (CM-29)", async () => {
    const w = await world();
    const withoutLicense = await call(w, "PATCH", "", {
      services: { license: { enabled: false }, commerce: { enabled: true } },
    });
    expect(withoutLicense.status).toBe(422);
    expect(withoutLicense.body.errors).toEqual(["commerce_requires_license"]);
    const on = await call(w, "PATCH", "", {
      services: { commerce: { enabled: true } },
    });
    expect(on.status).toBe(200);
    // The confirmation names the dependent before anything is written.
    const dry = await call(w, "PATCH", "?dryRun=1", {
      services: { license: { enabled: false } },
    });
    expect(JSON.stringify(dry.body)).toContain("commerce");
    const off = await call(w, "PATCH", "", {
      services: { license: { enabled: false } },
    });
    expect(off.status).toBe(200);
    expect(off.body.services).toMatchObject({
      license: { enabled: false },
      commerce: { enabled: false },
      connect: { enabled: false },
    });
    // Turning License back on does not turn Commerce back on.
    const back = await call(w, "PATCH", "", {
      services: { license: { enabled: true } },
    });
    expect(back.body.services).toMatchObject({ commerce: { enabled: false } });
    const rows = (await listAudit(w.db, "djdl", { limit: 20 })).filter(
      (r) =>
        r.action === "product.services.update" &&
        (r.summary ?? "").includes("commerce") &&
        (r.summary ?? "").includes("license"),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("a service's admin context carries Core's hooks, gated on the product's enablement (P2b-01)", async () => {
    // The admin route itself is reachable while its own service is off (configure before
    // enabling), but a HOOK still answers only while its providing service is on.
    const w = await world();
    const seen: ServiceHooks[] = [];
    const admin = vi
      .spyOn(updateService as Required<ServiceDescriptor>, "adminHandle")
      .mockImplementation(async (ctx) => {
        seen.push(ctx.hooks);
        return new Response("{}", { status: 200 });
      });
    const catalog = vi.spyOn(
      releaseService as Required<ServiceDescriptor>,
      "releaseCatalog",
    );
    try {
      const at = "/api/products/djdl/update/simulate";
      const hit = () =>
        dispatch(
          mkReq("GET", at, { cookie: w.cookie, csrf: w.csrf }),
          w.env,
          w.db,
          at,
        );
      // Defaults: Release and Distribution off.
      expect((await hit()).status).toBe(200);
      expect(seen[0]!.releaseCatalog()).toBeNull();
      expect(seen[0]!.delivery()).toBeNull();
      expect(catalog).not.toHaveBeenCalled();
      // The whole chain on.
      await setServices(
        w.db,
        "djdl",
        JSON.stringify({
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: true },
          identity: { enabled: false },
          sync: { enabled: false },
          commerce: { enabled: false },
          connect: { enabled: false },
        }),
        "manifest",
        NOW,
      );
      expect((await hit()).status).toBe(200);
      expect(seen[1]!.releaseCatalog()).not.toBeNull();
      expect(seen[1]!.delivery()?.defaultTransport).toBe("pkey-cdn");
      expect(catalog).toHaveBeenCalledTimes(1);
    } finally {
      admin.mockRestore();
      catalog.mockRestore();
    }
  });

  it("PATCH rejects a removed registration policy by field", async () => {
    const w = await world();
    for (const registration of ["requires-identity", null]) {
      const res = await call(w, "PATCH", "", { registration });
      expect(res.status).toBe(422);
      expect(res.body.fields).toEqual(["registration"]);
    }
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
        distribution: { enabled: true },
        update: { enabled: true },
        identity: { enabled: true },
        sync: { enabled: false },
        commerce: { enabled: false },
        connect: { enabled: false },
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
    expect(reverted.body.facts).toMatchObject({
      licensing: { tiers: 1, licenses: 0 },
      managedConfig: { catalogVersion: 1 },
      shipBuilds: { latest: null },
      commerce: { storefronts: 0, storeGrants: 0 },
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
    expect(row?.actor_sub).toBe(await consoleActor(w.env, w.db, "u1"));
  });

  it("requires a session, a platform admin, and CSRF on the mutation", async () => {
    const w = await world();
    const p = path();
    // No session at all.
    expect((await dispatch(mkReq("GET", p), w.env, w.db, p)).status).toBe(401);
    // Signed in, but not a platform admin.
    const weak = await sessionCookie(w.env, w.db, {
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

// ───────────────────────────────────────────────────────────────────────────────────────────
// The device-limit CEILING, on every admin path that can set a product's default.
//
// `claimDeviceSeat` finds the lowest free seat with a recursive CTE that enumerates 1..limit
// inside ONE statement, so the cost of an activation is O(deviceLimit). Every write path checked
// the lower bound (`limit > 0` reads as UNLIMITED) and none checked the upper one, which made
// `deviceLimit: 100000000` a legal admin write and a permanently wedged activation route for
// that product.
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("device-limit ceiling on the product registry", () => {
  async function platform(): Promise<{
    db: Db;
    env: Env;
    cookie: string;
    csrf: string;
  }> {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), []);
    const { cookie, csrf } = await sessionCookie(env, db, {
      sub: "u1",
      name: "Ada",
      email: "a@x.io",
      groups: [PLATFORM_GROUP],
    });
    return { db, env, cookie, csrf };
  }

  it("POST /api/products refuses a device limit no activation could survive", async () => {
    // Create checked NOTHING (`Number(body.defaultDeviceLimit ?? 5)` was the whole of it), so a
    // ceiling on the PATCH alone would have been one POST away from irrelevant.
    const { db, env, cookie, csrf } = await platform();
    for (const bad of [MAX_DEVICE_LIMIT + 1, 100000000, 2.5, 0, -1]) {
      const res = await dispatch(
        mkReq("POST", "/api/products", {
          cookie,
          csrf,
          body: { slug: "acme", name: "Acme", defaultDeviceLimit: bad },
        }),
        env,
        db,
        "/api/products",
      );
      expect(`${bad}=${res.status}`).toBe(`${bad}=422`);
      const body = (await res.json()) as { message: string; fields: string[] };
      expect(body.fields).toEqual(["defaultDeviceLimit"]);
      expect(body.message).toContain(String(MAX_DEVICE_LIMIT));
    }
    // Nothing was written on the way to any of those refusals.
    expect(await getProduct(db, "acme")).toBeNull();

    // …and the ceiling itself is a legal value, not an off-by-one.
    const ok = await dispatch(
      mkReq("POST", "/api/products", {
        cookie,
        csrf,
        body: {
          slug: "acme",
          name: "Acme",
          defaultDeviceLimit: MAX_DEVICE_LIMIT,
        },
      }),
      env,
      db,
      "/api/products",
    );
    expect(ok.status).toBe(201);
    expect((await getProduct(db, "acme"))?.default_device_limit).toBe(
      MAX_DEVICE_LIMIT,
    );
  });

  it("create without a device limit keeps the default of 5", async () => {
    const { db, env, cookie, csrf } = await platform();
    const res = await dispatch(
      mkReq("POST", "/api/products", {
        cookie,
        csrf,
        body: { slug: "acme", name: "Acme" },
      }),
      env,
      db,
      "/api/products",
    );
    expect(res.status).toBe(201);
    expect((await getProduct(db, "acme"))?.default_device_limit).toBe(5);
  });

  it("the numeric coercion on create cannot smuggle a string past the ceiling", async () => {
    // `Number(body.defaultDeviceLimit ?? 5)` accepts `"1e9"` and `"100000000"` as readily as the
    // numbers, so the check has to run on the COERCED value, not on the raw field.
    const { db, env, cookie, csrf } = await platform();
    for (const bad of ["1e9", "100000000", "abc", "", "1001"]) {
      const res = await dispatch(
        mkReq("POST", "/api/products", {
          cookie,
          csrf,
          body: { slug: "acme", name: "Acme", defaultDeviceLimit: bad },
        }),
        env,
        db,
        "/api/products",
      );
      const body = (await res.json()) as { fields: string[] };
      expect(`${JSON.stringify(bad)}=${res.status}`).toBe(
        `${JSON.stringify(bad)}=422`,
      );
      expect(body.fields).toEqual(["defaultDeviceLimit"]);
    }
    expect(await getProduct(db, "acme")).toBeNull();
  });

  it("PATCH /api/products/<slug> refuses an unbounded device limit", async () => {
    const { db, env, cookie, csrf } = await platform();
    await seedProduct(db, "acme");
    const path = "/api/products/acme";

    for (const bad of [MAX_DEVICE_LIMIT + 1, 100000000, 2.5, 0, -1]) {
      const rejected = await dispatch(
        mkReq("PATCH", path, {
          cookie,
          csrf,
          body: { defaultDeviceLimit: bad },
        }),
        env,
        db,
        path,
      );
      expect(`${bad}=${rejected.status}`).toBe(`${bad}=422`);
      const body = (await rejected.json()) as {
        message: string;
        fields: string[];
      };
      expect(body.fields).toEqual(["defaultDeviceLimit"]);
      expect(body.message).toContain(String(MAX_DEVICE_LIMIT));
    }
    // Refused, not clamped: the stored value is still the one nobody touched.
    expect((await getProduct(db, "acme"))?.default_device_limit).toBe(5);

    // A legal write still lands: the ceiling refuses, it does not get in the way of a real
    // seat count.
    const accepted = await dispatch(
      mkReq("PATCH", path, {
        cookie,
        csrf,
        body: { defaultDeviceLimit: MAX_DEVICE_LIMIT },
      }),
      env,
      db,
      path,
    );
    expect(accepted.status).toBe(200);
    expect((await getProduct(db, "acme"))?.default_device_limit).toBe(
      MAX_DEVICE_LIMIT,
    );
  });

  it("the settings registry holds the same ceiling, at platform and product scope", () => {
    // The generic settings writers validate against the registry's value spec, so a bound that
    // differs from the ceiling here is a second way in.
    for (const scope of ["platform", "product"] as const)
      expect(
        SETTINGS.get("license.defaults.deviceLimit", scope)?.value,
      ).toEqual({
        kind: "integer",
        unit: "count",
        min: 1,
        max: MAX_DEVICE_LIMIT,
      });
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// Rotation kids: a fresh kid per rotation, and a collision is a 409 rather than an opaque 500.
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("signing-key rotation mints distinct kids", () => {
  const ROTATE = "/api/products/djdl/keys/rotate";

  /** POST keys/rotate as a platform admin whose session was issued at `at`. */
  async function rotateAt(
    env: Env,
    db: Db,
    at: number,
  ): Promise<{ status: number; body: { kid?: string; message?: string } }> {
    const { token, session } = await consoleTestSession(
      env,
      db,
      {
        sub: "u1",
        name: "Ada",
        email: "a@x.io",
        groups: [PLATFORM_GROUP],
        authTime: at,
        stepUp: true,
      },
      at,
    );
    const res = await handleAdmin(
      mkReq("POST", ROTATE, {
        cookie: `${ADMIN_COOKIE}=${token}`,
        csrf: session.csrf,
      }),
      env,
      db,
      ROTATE,
      { now: at },
    );
    const body = (await res.json()) as { kid?: string; message?: string };
    return { status: res.status, body };
  }

  it("two rotations in the same second, and two a day apart, never collide", async () => {
    // The kid used to end in `(now % 100000).toString(36)`: constant within a second and
    // repeating every 100000 s (~28 h), so a second rotation at either moment collided on
    // `PRIMARY KEY (product, kid)` and surfaced as an opaque 500 naming neither kid nor cause.
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");

    const first = await rotateAt(env, db, NOW);
    const sameSecond = await rotateAt(env, db, NOW);
    const dayLater = await rotateAt(env, db, NOW + 100_000);
    for (const r of [first, sameSecond, dayLater])
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    const kids = [first, sameSecond, dayLater].map((r) => r.body.kid!);
    expect(new Set(kids).size).toBe(3);
    for (const kid of kids)
      expect(kid).toMatch(/^djdl-20\d\d-[0-9a-hjkmnp-tv-z]{8}$/);

    const staged = await db.all<{ kid: string }>(
      "SELECT kid FROM product_keys WHERE product = 'djdl' AND status = 'staged'",
    );
    expect(staged.map((r) => r.kid).sort()).toEqual([...kids].sort());
  });

  it("a collision on the primary key is a 409 naming the kid, not a 500", async () => {
    const db = makeTestDb();
    const env = adminEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    // Another writer takes whatever kid the handler minted in the instant between the mint and
    // the insert, the only way a 40-bit random suffix can collide.
    const colliding: Db = {
      all: (sql, ...params) => db.all(sql, ...params),
      first: (sql, ...params) => db.first(sql, ...params),
      run: (sql, ...params) => db.run(sql, ...params),
      batch: (statements) => db.batch(statements),
      async runChanges(sql, ...params) {
        if (sql.includes("INSERT INTO product_keys"))
          await db.run(
            `INSERT INTO product_keys (product, kid, alg, public_b64url, enc_private_json, status, created_at)
             VALUES (?, ?, 'Ed25519', 'taken-pub', '{}', 'staged', ?)`,
            params[0],
            params[1],
            NOW,
          );
        return db.runChanges(sql, ...params);
      },
    };

    const res = await rotateAt(env, colliding, NOW);
    expect(res.status).toBe(409);
    const taken = await db.first<{ kid: string; public_b64url: string }>(
      "SELECT kid, public_b64url FROM product_keys WHERE public_b64url = 'taken-pub'",
    );
    expect(taken).not.toBeNull();
    expect(res.body.message).toContain(taken!.kid);
    expect(res.body.message).toContain("already exists");
    // The existing row is untouched: a reported collision is not a silent overwrite, and the
    // refused rotation left no second staged key behind.
    expect(taken!.public_b64url).toBe("taken-pub");
    const staged = await db.all<{ kid: string }>(
      "SELECT kid FROM product_keys WHERE product = 'djdl' AND status = 'staged'",
    );
    expect(staged.map((r) => r.kid)).toEqual([taken!.kid]);
  });
});
