import { describe, expect, it } from "vitest";
import { issuePortalSessionRow } from "./portalSessionRow.js";
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
import type { Db } from "../src/db/types.js";
import { insertLicense, setServices } from "../src/repo.js";
import { authorizeAndMint } from "../src/services/identity/oidc.js";
import { serializeServices } from "../src/core/services.js";
import { handleActivate } from "../src/services/license/activation.js";
import { loadProduct } from "../src/core/products.js";
import { subjectFor } from "../src/core/accountSubjects.js";
import {
  registerSubjectStore,
  unregisterSubjectStore,
} from "../src/core/subjectHooks.js";
import { sweepErasures } from "../src/services/identity/accounts/deletion.js";
import { hashKey } from "../src/crypto.js";
import { getTokenRecord } from "../src/kv.js";
import {
  getOrCreateAccountByEmail,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import {
  handlePortalApi,
  handlePortalDownload,
  seedRepositoryVisibility,
} from "./portalHarness.js";
import { seedDeliveryAccess } from "./releaseSurface.js";
import { handleMagicVerify } from "../src/services/identity/portal/auth.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../src/services/identity/portal/session.js";

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

function cookieFromSetCookie(value: string | null): string {
  expect(value).toBeTruthy();
  return value!.split(";")[0]!;
}

/** Turn the Release service on for a product, the way the manifest writer does. */
async function enableReleaseService(db: Db, slug: string): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: false },
        identity: { enabled: false },
        sync: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
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
    // The token reaches the user only through the emailed link. R12-04: the KV key is a
    // peppered hash of it, so it cannot be read back out of a key listing.
    const link = /https:\/\/\S+/.exec(sent[0]!.text)?.[0];
    const token = link ? new URL(link).searchParams.get("token") : null;
    expect(token).toBeTruthy();
    expect(kv.keys().some((key) => key.includes(token!))).toBe(false);

    // I-07: the landing page (GET) consumes nothing; its button POSTs the token back, from the
    // browser that asked (its flow cookie), which signs that browser in.
    const flowCookie = cookieFromSetCookie(start.headers.get("set-cookie"));
    const landing = await handleMagicVerify(
      req("GET", `/magic/verify?token=${encodeURIComponent(token!)}`, {
        cookie: flowCookie,
      }),
      env,
      db,
      NOW,
    );
    expect(landing.status).toBe(200);
    expect(landing.headers.get("set-cookie")).toBeNull();
    const verified = await handleMagicVerify(
      new Request("https://key.plrs.im/magic/verify", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: flowCookie,
        },
        body: new URLSearchParams({ token: token! }).toString(),
      }) as unknown as Request,
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
    // The seeded licence carries ada@example.com and this account signed in as someone else, so
    // the S-16 email rule (PX-W5) would refuse it; this product opts into claim by key.
    await upsertPortalProductSettings(db, "djdl", { claimByKey: true }, NOW);
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

  it("lists and removes a device of a sign-in (keyless) licence the account owns", async () => {
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
    const product = (await loadProduct(env, db, "djdl"))!;
    const session = await portalSession(env, db);
    // The product-OIDC licence: `sub`-keyed, no key, linked to the portal account.
    await insertLicense(db, {
      product: "djdl",
      id: "lic_oidc",
      status: "active",
      sub: "sub-ada",
      name: "Ada Lovelace",
      email: "ada@example.com",
      groups_json: null,
      tier_id: null,
      activated_at: NOW,
      expires_at: null,
      max_offline_days: null,
      overrides_json: null,
      channels_json: null,
      min_version: null,
      max_version: null,
      origin: "oidc",
      modified_by: "oidc",
      modified_at: NOW,
    });
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      session.accountId,
      "djdl",
      "lic_oidc",
    );
    const token = await authorizeAndMint(
      env,
      db,
      product,
      "lic_oidc",
      "dev-oidc",
      NOW,
    );
    const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
    expect(await getTokenRecord(env, "djdl", tokenHash)).not.toBeNull();

    const path = "/api/licenses/djdl/lic_oidc";
    const listed = await handlePortalApi(
      req("GET", path, { cookie: session.cookie }),
      env,
      db,
      path,
      NOW,
    );
    expect(listed.status).toBe(200);
    const detail = (await listed.json()) as {
      identityProvider: string;
      keyCount: number;
      devices: Array<{ deviceId: string; status: string }>;
    };
    expect(detail.identityProvider).toBe("oidc");
    expect(detail.keyCount).toBe(0);
    expect(detail.devices).toEqual([
      expect.objectContaining({ deviceId: "dev-oidc", status: "authorized" }),
    ]);

    const removed = await handlePortalApi(
      req("DELETE", `${path}/devices/dev-oidc`, {
        cookie: session.cookie,
        csrf: session.csrf,
      }),
      env,
      db,
      `${path}/devices/dev-oidc`,
      NOW,
    );
    expect(removed.status).toBe(200);
    expect(await getTokenRecord(env, "djdl", tokenHash)).toBeNull();
    const device = await db.first<{ status: string }>(
      "SELECT status FROM devices WHERE product = ? AND device_id = ?",
      "djdl",
      "dev-oidc",
    );
    expect(device?.status).toBe("deauthorized");
    const audit = await db.first<{ target_id: string }>(
      "SELECT target_id FROM portal_audit WHERE account_id = ? AND action = ?",
      session.accountId,
      "portal.device.disconnect",
    );
    expect(audit?.target_id).toBe("dev-oidc");
    expect(sent.length).toBeGreaterThan(0);

    // Another account cannot touch it: the licence is not theirs.
    const other = await portalSession(env, db, "eve@example.com");
    const refused = await handlePortalApi(
      req("DELETE", `${path}/devices/dev-oidc`, {
        cookie: other.cookie,
        csrf: other.csrf,
      }),
      env,
      db,
      `${path}/devices/dev-oidc`,
      NOW,
    );
    expect(refused.status).toBe(404);
  });

  it("issues short-lived portal download tokens for licensed release artifacts", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await seedLicenseWithKey(db, "djdl");
    const session = await portalSession(env, db);
    // Task 7.2 made the portal's download flow a projection of `services_json`, and
    // `DEFAULT_SERVICES` has Release OFF — so a fixture that only seeds release ROWS now
    // describes a product that does not serve them. Declaring the service is what this fixture
    // always meant; it just used to be able to leave it unsaid.
    await enableReleaseService(db, "djdl");
    // The delivery access is Distribution's per-deliverable answer since P2b-04 (it was the
    // per-artifact snapshot below): `licensed`, as the artifact row says.
    await seedDeliveryAccess(db, "djdl", "licensed");
    // A licensed file reaches a browser through its GitHub URL only from a public repository.
    await seedRepositoryVisibility(env, db, "djdl", "public");

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
      "https://github.com/acme/djdl/releases/download/v1.2.3/djdl.dmg",
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
    expect(url).toMatch(/^\/download\/[A-Za-z0-9_-]{43}$/);

    const redirect = await handlePortalDownload(
      req("GET", url),
      env,
      db,
      decodeURIComponent(url.replace("/download/", "")),
      NOW,
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(
      "https://github.com/acme/djdl/releases/download/v1.2.3/djdl.dmg",
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

  it("lists each file with its build's platform, or its name's, when it has none", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    await seedLicenseWithKey(db, "djdl");
    const session = await portalSession(env, db);
    await enableReleaseService(db, "djdl");
    await seedDeliveryAccess(db, "djdl", "licensed");
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, metadata_access, artifacts_access, published_at,
          created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      "rel_1",
      "1.2.3",
      "authenticated",
      "licensed",
      NOW,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_builds
         (product, release_id, build_id, platform, arch, format, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "djdl",
      "rel_1",
      "mac",
      "macos",
      "arm64",
      "zip",
      NOW,
      NOW,
    );
    const files: [string, string, string | null, string | null][] = [
      // [artifact id, name, platform, build id]
      ["a1", "djdl-mac.zip", null, "mac"],
      ["a2", "djdl-arm64.app.zip", null, null],
      ["a3", "djdl-arm64", null, null],
    ];
    for (const [id, name, platform, buildId] of files) {
      await db.run(
        `INSERT INTO release_artifacts
           (product, release_id, artifact_id, name, kind, platform, arch, access,
            created_at, build_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "djdl",
        "rel_1",
        id,
        name,
        "archive",
        platform,
        "arm64",
        "licensed",
        NOW,
        buildId,
      );
    }
    const res = await handlePortalApi(
      req("GET", "/api/releases", { cookie: session.cookie }),
      env,
      db,
      "/api/releases",
      NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: {
        artifacts: { name: string; platform: string | null; arch: string }[];
      }[];
    };
    expect(
      body.releases[0]!.artifacts.map((a) => [a.name, a.platform, a.arch]),
    ).toEqual(
      expect.arrayContaining([
        ["djdl-mac.zip", "macos", "arm64"],
        ["djdl-arm64.app.zip", "macos", "arm64"],
        // Nothing determines a platform: the console labels it "Unknown platform · ARM64".
        ["djdl-arm64", null, "arm64"],
      ]),
    );
  });

  it("requires a linked product before minting release download tokens", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const session = await portalSession(env, db, "unlinked@example.com");
    // Task 7.2 made the portal's download flow a projection of `services_json`, and
    // `DEFAULT_SERVICES` has Release OFF — so a fixture that only seeds release ROWS now
    // describes a product that does not serve them. Declaring the service is what this fixture
    // always meant; it just used to be able to leave it unsaid.
    await enableReleaseService(db, "djdl");
    // The delivery access is Distribution's per-deliverable answer since P2b-04 (it was the
    // per-artifact snapshot below): `authenticated`, as the artifact row says.
    await seedDeliveryAccess(db, "djdl", "authenticated");

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
      "https://github.com/acme/djdl/releases/download/v1.2.3/djdl.dmg",
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
    // Task 7.2 made the portal's download flow a projection of `services_json`, and
    // `DEFAULT_SERVICES` has Release OFF — so a fixture that only seeds release ROWS now
    // describes a product that does not serve them. Declaring the service is what this fixture
    // always meant; it just used to be able to leave it unsaid.
    await enableReleaseService(db, "djdl");
    // The delivery access is Distribution's per-deliverable answer since P2b-04 (it was the
    // per-artifact snapshot below): `licensed`, as the artifact row says.
    await seedDeliveryAccess(db, "djdl", "licensed");
    // A licensed file reaches a browser through its GitHub URL only from a public repository.
    await seedRepositoryVisibility(env, db, "djdl", "public");

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
      "https://github.com/acme/djdl/releases/download/v1.2.3/djdl.dmg",
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
    // I-05: sign-in methods are `account_links` rows (the portal tables are the pre-I-05 copy).
    await db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email,
         email_verified, created_at, last_used_at)
       VALUES ('lnk_oidc', ?, 'https://id.example', '', 'sub-1', 'oidc', 'ada@example.com', 1, ?, ?)`,
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
      ["accounts", "id"],
      ["account_links", "account_id"],
      ["account_product_subjects", "account_id"],
      ["licenses", "account_id"],
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
    for (const sql of [
      "SELECT email FROM portal_account_emails WHERE email = 'ada@example.com'",
      "SELECT email FROM account_links WHERE email = 'ada@example.com'",
      "SELECT primary_email FROM accounts WHERE primary_email = 'ada@example.com'",
    ]) {
      expect(await db.first(sql)).toBeNull();
    }
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

  it("SEC-PRV-1: a failing store hook answers erasing:true, closes the session and the sweeper finishes", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const session = await portalSession(env, db);
    await subjectFor(db, session.accountId, "djdl", NOW);
    let failing = true;
    registerSubjectStore("flaky-erasure", {
      merge: async () => {},
      delete: async () => {
        if (failing) throw new Error("DO unavailable");
      },
    });
    try {
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
      expect(await res.json()).toMatchObject({
        ok: true,
        deleted: session.accountId,
        erasing: true,
      });
      // The cookie no longer opens anything.
      const me = await handlePortalApi(
        req("GET", "/api/me", { cookie: session.cookie }),
        env,
        db,
        "/api/me",
        NOW + 1,
      );
      expect(me.status).toBe(401);
      failing = false;
      expect(
        await sweepErasures({ db, env, now: NOW + 7200, origin: "" }),
      ).toEqual({ completed: 1, attempted: 1 });
      expect(
        await db.first(
          "SELECT id FROM accounts WHERE id = ?",
          session.accountId,
        ),
      ).toBeNull();
    } finally {
      unregisterSubjectStore("flaky-erasure");
    }
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
      "SELECT id FROM accounts WHERE id = ?",
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
      await db.first("SELECT id FROM accounts WHERE id = ?", session.accountId),
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
