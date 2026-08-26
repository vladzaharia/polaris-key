import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq as mkLicReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import type { Env } from "../src/env.js";
import { handleActivate } from "../src/licensing.js";
import { loadProduct } from "../src/product.js";
import { hashKey } from "../src/crypto.js";
import { getTokenRecord } from "../src/kv.js";
import { getOrCreateAccountByEmail } from "../src/portal/repo.js";
import { handlePortalApi, handlePortalDownload } from "../src/portal/api.js";
import { handleMagicVerify } from "../src/portal/auth.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../src/portal/session.js";

const PORTAL_SECRET = "test-portal-session-secret";

function portalEnv(kv = new KvMock()): Env {
  const env = makeEnv(kv, ["djdl"]);
  env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  return env;
}

function req(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[PORTAL_CSRF_HEADER] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`https://key.plrs.im${path}`, init) as unknown as Request;
}

async function portalSession(
  env: Env,
  db: ReturnType<typeof makeTestDb>,
  email = "ada@example.com",
): Promise<{ cookie: string; csrf: string; accountId: string }> {
  const account = await getOrCreateAccountByEmail(db, email, NOW);
  const { token, session } = await issuePortalSession(
    env,
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

function cookieFromSetCookie(value: string | null): string {
  expect(value).toBeTruthy();
  return value!.split(";")[0]!;
}

describe("customer portal", () => {
  it("supports email magic-link login and auto-links licenses by verified email", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = portalEnv(kv);
    const sent: Array<{ to: string; text: string }> = [];
    env.EMAIL = {
      send: async (message: { to: string; text: string }) => {
        sent.push(message);
      },
    } as unknown as Env["EMAIL"];
    await seedProduct(db, "djdl");
    const { licenseId } = await seedLicenseWithKey(db, "djdl");

    const start = await handlePortalApi(
      req("POST", "/api/magic/start", {
        body: { email: "Ada@Example.com" },
      }),
      env,
      db,
      "/api/magic/start",
      NOW,
    );
    expect(start.status).toBe(200);
    expect(sent[0]?.to).toBe("ada@example.com");
    const token = kv
      .keys()
      .find((key) => key.startsWith("portal:magic:"))
      ?.replace("portal:magic:", "");
    expect(token).toBeTruthy();

    const verified = await handleMagicVerify(
      req("GET", `/magic/verify?token=${encodeURIComponent(token!)}`),
      env,
      db,
      NOW,
    );
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("/");

    const cookie = cookieFromSetCookie(verified.headers.get("set-cookie"));
    const list = await handlePortalApi(
      req("GET", "/api/licenses", { cookie }),
      env,
      db,
      "/api/licenses",
      NOW,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      licenses: Array<{ id: string; product: string; key?: string }>;
    };
    expect(body.licenses).toEqual([
      expect.objectContaining({ id: licenseId, product: "djdl" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("pkey_djdl_");
  });

  it("claims a license by key without revealing raw keys in later reads", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { licenseId, key } = await seedLicenseWithKey(db, "djdl");
    const session = await portalSession(env, db, "someone@example.com");

    const claimed = await handlePortalApi(
      req("POST", "/api/claim/license-key", {
        cookie: session.cookie,
        csrf: session.csrf,
        body: { key },
      }),
      env,
      db,
      "/api/claim/license-key",
      NOW,
    );
    expect(claimed.status).toBe(200);

    const detail = await handlePortalApi(
      req("GET", `/api/licenses/djdl/${licenseId}`, {
        cookie: session.cookie,
      }),
      env,
      db,
      `/api/licenses/djdl/${licenseId}`,
      NOW,
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      id: string;
      keys: Array<{ hash: string; status: string }>;
    };
    expect(body.id).toBe(licenseId);
    expect(body.keys).toEqual([
      expect.objectContaining({ hash: expect.any(String), status: "active" }),
    ]);
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it("hides and rejects license-key claim when the module is disabled", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { key } = await seedLicenseWithKey(db, "djdl");
    await db.run(
      `INSERT INTO portal_product_settings
         (product, portal_enabled, oidc_enabled, magic_enabled,
          license_key_claim_enabled, releases_enabled, branding_json, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      1,
      1,
      1,
      0,
      1,
      null,
      NOW,
      NOW,
    );
    const session = await portalSession(env, db, "someone@example.com");

    const caps = await handlePortalApi(
      req("GET", "/api/capabilities"),
      env,
      db,
      "/api/capabilities",
      NOW,
    );
    expect(caps.status).toBe(200);
    await expect(caps.json()).resolves.toMatchObject({
      modules: { claim: false },
    });

    const claimed = await handlePortalApi(
      req("POST", "/api/claim/license-key", {
        cookie: session.cookie,
        csrf: session.csrf,
        body: { key },
      }),
      env,
      db,
      "/api/claim/license-key",
      NOW,
    );
    expect(claimed.status).toBe(404);
  });

  it("disconnects a device and purges the hot bearer token", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = portalEnv(kv);
    await seedProduct(db, "djdl");
    const product = (await loadProduct(env, db, "djdl"))!;
    const { licenseId, key } = await seedLicenseWithKey(db, "djdl");
    const session = await portalSession(env, db);

    const activated = await handleActivate(
      mkLicReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      env,
      db,
      product,
      NOW,
    );
    const { token } = (await activated.json()) as { token: string };
    const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
    expect(await getTokenRecord(env, "djdl", tokenHash)).not.toBeNull();

    const disconnected = await handlePortalApi(
      req("DELETE", `/api/licenses/djdl/${licenseId}/devices/dev-1`, {
        cookie: session.cookie,
        csrf: session.csrf,
      }),
      env,
      db,
      `/api/licenses/djdl/${licenseId}/devices/dev-1`,
      NOW,
    );
    expect(disconnected.status).toBe(200);
    expect(await getTokenRecord(env, "djdl", tokenHash)).toBeNull();
    const device = await db.first<{ status: string }>(
      "SELECT status FROM devices WHERE product = ? AND device_id = ?",
      "djdl",
      "dev-1",
    );
    expect(device?.status).toBe("deauthorized");
  });

  it("issues short-lived portal download tokens for licensed release artifacts", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await seedLicenseWithKey(db, "djdl");
    const session = await portalSession(env, db);
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url,
          metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      "rel_1",
      "1.2.3",
      "DJDL 1.2.3",
      null,
      null,
      "https://example.com/releases/1.2.3",
      "authenticated",
      "licensed",
      NOW,
      null,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type,
          size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
          metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      "rel_1",
      "art_1",
      "djdl.dmg",
      "dmg",
      "macos",
      "arm64",
      "application/octet-stream",
      123,
      "sha",
      "https://downloads.example.com/djdl.dmg",
      null,
      null,
      "licensed",
      null,
      NOW,
    );

    const tokenRes = await handlePortalApi(
      req("POST", "/api/releases/djdl/rel_1/artifacts/art_1/token", {
        cookie: session.cookie,
        csrf: session.csrf,
      }),
      env,
      db,
      "/api/releases/djdl/rel_1/artifacts/art_1/token",
      NOW,
    );
    expect(tokenRes.status).toBe(201);
    const { url } = (await tokenRes.json()) as { url: string };
    expect(url).toMatch(/^\/download\/pkeyt_/);

    const redirect = await handlePortalDownload(
      req("GET", url),
      env,
      db,
      decodeURIComponent(url.replace("/download/", "")),
      NOW,
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(
      "https://downloads.example.com/djdl.dmg",
    );

    const reused = await handlePortalDownload(
      req("GET", url),
      env,
      db,
      decodeURIComponent(url.replace("/download/", "")),
      NOW,
    );
    expect(reused.status).toBe(404);
  });

  it("requires a linked product before minting release download tokens", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const session = await portalSession(env, db, "unlinked@example.com");
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url,
          metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      "rel_1",
      "1.2.3",
      "DJDL 1.2.3",
      null,
      null,
      "https://example.com/releases/1.2.3",
      "authenticated",
      "authenticated",
      NOW,
      null,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type,
          size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
          metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      "rel_1",
      "art_1",
      "djdl.dmg",
      "dmg",
      "macos",
      "arm64",
      "application/octet-stream",
      123,
      "sha",
      "https://downloads.example.com/djdl.dmg",
      null,
      null,
      "authenticated",
      null,
      NOW,
    );

    const tokenRes = await handlePortalApi(
      req("POST", "/api/releases/djdl/rel_1/artifacts/art_1/token", {
        cookie: session.cookie,
        csrf: session.csrf,
      }),
      env,
      db,
      "/api/releases/djdl/rel_1/artifacts/art_1/token",
      NOW,
    );
    expect(tokenRes.status).toBe(404);
  });

  it("re-checks license usability when redeeming portal download tokens", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { licenseId } = await seedLicenseWithKey(db, "djdl");
    const session = await portalSession(env, db);
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url,
          metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      "rel_1",
      "1.2.3",
      "DJDL 1.2.3",
      null,
      null,
      "https://example.com/releases/1.2.3",
      "authenticated",
      "licensed",
      NOW,
      null,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type,
          size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
          metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      "rel_1",
      "art_1",
      "djdl.dmg",
      "dmg",
      "macos",
      "arm64",
      "application/octet-stream",
      123,
      "sha",
      "https://downloads.example.com/djdl.dmg",
      null,
      null,
      "licensed",
      null,
      NOW,
    );

    const tokenRes = await handlePortalApi(
      req("POST", "/api/releases/djdl/rel_1/artifacts/art_1/token", {
        cookie: session.cookie,
        csrf: session.csrf,
      }),
      env,
      db,
      "/api/releases/djdl/rel_1/artifacts/art_1/token",
      NOW,
    );
    expect(tokenRes.status).toBe(201);
    const { url } = (await tokenRes.json()) as { url: string };
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      "djdl",
      licenseId,
    );

    const redirect = await handlePortalDownload(
      req("GET", url),
      env,
      db,
      decodeURIComponent(url.replace("/download/", "")),
      NOW,
    );
    expect(redirect.status).toBe(404);
  });
});

describe("portal account erasure (DELETE /api/me)", () => {
  // R11-09: there was no delete endpoint at all, so `portal_accounts.primary_email` and
  // `portal_account_emails.email` — the latter a PRIMARY KEY, with nowhere to record a
  // tombstone that does not re-store the address — were unerasable through the API.
  it("erases the account, its emails, its identities and its license links", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { licenseId } = await seedLicenseWithKey(db, "djdl");
    const session = await portalSession(env, db);
    await db.run(
      `INSERT INTO portal_account_identities (provider, subject, account_id, email, created_at, last_seen_at)
       VALUES ('oidc', 'sub-1', ?, 'ada@example.com', ?, ?)`,
      session.accountId,
      NOW,
      NOW,
    );
    // The license link is real: the seeded license carries ada@example.com.
    const before = await handlePortalApi(
      req("GET", "/api/licenses", { cookie: session.cookie }),
      env,
      db,
      "/api/licenses",
      NOW,
    );
    expect(
      ((await before.json()) as { licenses: unknown[] }).licenses,
    ).toHaveLength(1);
    expect(licenseId).toBeTruthy();

    const res = await handlePortalApi(
      req("DELETE", "/api/me", {
        cookie: session.cookie,
        csrf: session.csrf,
      }),
      env,
      db,
      "/api/me",
      NOW,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: session.accountId });
    // The session cookie is cleared on the way out.
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);

    for (const [table, column] of [
      ["portal_accounts", "id"],
      ["portal_account_emails", "account_id"],
      ["portal_account_identities", "account_id"],
      ["portal_license_links", "account_id"],
    ] as const) {
      const row = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`,
        session.accountId,
      );
      expect(`${table}=${row?.n}`).toBe(`${table}=0`);
    }
    // The address itself is gone from the database, not merely unlinked.
    const email = await db.first(
      "SELECT email FROM portal_account_emails WHERE email = 'ada@example.com'",
    );
    expect(email).toBeNull();
  });

  it("leaves the product's own license record alone — it is the tenant's data, not the account's", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const { licenseId } = await seedLicenseWithKey(db, "djdl");
    const session = await portalSession(env, db);

    await handlePortalApi(
      req("DELETE", "/api/me", { cookie: session.cookie, csrf: session.csrf }),
      env,
      db,
      "/api/me",
      NOW,
    );

    const license = await db.first<{ email: string | null }>(
      "SELECT email FROM licenses WHERE product = 'djdl' AND id = ?",
      licenseId,
    );
    expect(license?.email).toBe("ada@example.com");
  });

  it("keeps a non-identifying erasure receipt and drops the account's activity log", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const session = await portalSession(env, db);
    await db.run(
      `INSERT INTO portal_audit (id, account_id, at, action, product, target_kind, target_id, summary)
       VALUES ('paud_old', ?, ?, 'portal.license.claim', 'djdl', 'license', 'lic-1', 'Claimed license with a license key')`,
      session.accountId,
      NOW,
    );

    await handlePortalApi(
      req("DELETE", "/api/me", { cookie: session.cookie, csrf: session.csrf }),
      env,
      db,
      "/api/me",
      NOW,
    );

    const rows = await db.all<{
      action: string;
      account_id: string;
      summary: string;
      product: string | null;
    }>("SELECT action, account_id, summary, product FROM portal_audit");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("portal.account.delete");
    // The surrogate id survives; it no longer resolves to a person, and no email, name or
    // product travels with it.
    expect(rows[0]!.account_id).toBe(session.accountId);
    expect(rows[0]!.product).toBeNull();
    expect(rows[0]!.summary).not.toMatch(/@/);
  });

  it("notifies the account holder BEFORE the address is erased", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const sent: Array<{ to: string; subject: string }> = [];
    env.EMAIL = {
      send: async (message: { to: string; subject: string }) => {
        sent.push(message);
      },
    } as unknown as Env["EMAIL"];
    const session = await portalSession(env, db);

    await handlePortalApi(
      req("DELETE", "/api/me", { cookie: session.cookie, csrf: session.csrf }),
      env,
      db,
      "/api/me",
      NOW,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ada@example.com");
    expect(sent[0]!.subject).toMatch(/deleted/i);
  });

  it("requires a session", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const res = await handlePortalApi(
      req("DELETE", "/api/me"),
      env,
      db,
      "/api/me",
      NOW,
    );
    expect(res.status).toBe(401);
  });

  it("requires the CSRF header — a bare authenticated DELETE is refused", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const session = await portalSession(env, db);

    const res = await handlePortalApi(
      req("DELETE", "/api/me", { cookie: session.cookie }),
      env,
      db,
      "/api/me",
      NOW,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: "csrf" });
    const account = await db.first(
      "SELECT id FROM portal_accounts WHERE id = ?",
      session.accountId,
    );
    expect(account).toBeTruthy();
  });

  it("a wrong CSRF token is refused too, and the account survives", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const session = await portalSession(env, db);

    const res = await handlePortalApi(
      req("DELETE", "/api/me", {
        cookie: session.cookie,
        csrf: "not-the-token",
      }),
      env,
      db,
      "/api/me",
      NOW,
    );

    expect(res.status).toBe(403);
    expect(
      await db.first(
        "SELECT id FROM portal_accounts WHERE id = ?",
        session.accountId,
      ),
    ).toBeTruthy();
  });

  it("the session stops working the moment the account is gone", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const session = await portalSession(env, db);
    await handlePortalApi(
      req("DELETE", "/api/me", { cookie: session.cookie, csrf: session.csrf }),
      env,
      db,
      "/api/me",
      NOW,
    );

    // Same still-unexpired cookie, and a second delete: `requireSession` re-reads the account.
    const res = await handlePortalApi(
      req("GET", "/api/me", { cookie: session.cookie }),
      env,
      db,
      "/api/me",
      NOW,
    );
    expect(res.status).toBe(401);
    const again = await handlePortalApi(
      req("DELETE", "/api/me", { cookie: session.cookie, csrf: session.csrf }),
      env,
      db,
      "/api/me",
      NOW,
    );
    expect(again.status).toBe(401);
  });

  it("GET /api/me is unaffected", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    const session = await portalSession(env, db);
    const res = await handlePortalApi(
      req("GET", "/api/me", { cookie: session.cookie }),
      env,
      db,
      "/api/me",
      NOW,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      account: { email: "ada@example.com" },
    });
  });
});
