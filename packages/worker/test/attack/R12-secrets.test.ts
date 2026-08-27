/**
 * R12 — Secrets exposure / information leakage PoCs.
 *
 * Read-only attack tests: no source file is modified. Each `it()` states whether it
 * CONFIRMS a finding (the assertion encodes the vulnerable behaviour that exists today)
 * or REFUTES a hypothesis (the assertion encodes the safe behaviour that already holds).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock, asKv } from "../kvMock.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  TEST_PEM,
} from "../seed.js";
import type { Env } from "../../src/env.js";
import type { Db } from "../../src/db/types.js";
import { handleAdmin } from "../../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
  type SessionIdentity,
} from "../../src/admin/session.js";
import { redactPayload, parsePayload } from "../../src/admin/lib/redact.js";
import { loadCatalog } from "../../src/admin/lib/shape.js";
import {
  openManagedPayload,
  openManagedValue,
} from "../../src/admin/lib/managedSecrets.js";
import { hashKey, mintLicenseKey, randomId } from "../../src/crypto.js";
import {
  getInstallationToken,
  installationTokenSlot,
} from "../../src/services/release/githubApp.js";
import { open } from "../../src/keyvault.js";
import { handleMagicStart } from "../../src/services/identity/portal/auth.js";
import { upsertPortalProductSettings } from "../../src/services/identity/portal/repo.js";
import { insertSchema, upsertDevice } from "../../src/repo.js";
import { deactivateSchemas } from "../../src/admin/repo.js";
import { verifyJws, signJws } from "@plrs/jws";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const WORKER_SRC = join(HERE, "..", "..", "src");

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";

const PLATFORM_ADMIN: SessionIdentity = {
  sub: "admin-1",
  name: "Admin One",
  email: "admin@example.com",
  groups: [PLATFORM_GROUP],
};

function adminEnv(kv: KvMock, slugs: string[]): Env {
  const env = makeEnv(kv, slugs);
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

async function sessionCookie(
  env: Env,
  identity: SessionIdentity = PLATFORM_ADMIN,
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

/** Recursively collect every .ts file under a directory. */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** A catalog with one `secret: true` CONFIG-kind key and one `kind: "secret"` key. */
function catalogWithSecrets(secretFlag: boolean): unknown {
  return {
    schemaVersion: 1,
    entries: [
      {
        key: "api.token",
        kind: "config",
        category: "API",
        label: "API token",
        description: "Upstream API token.",
        accessor: "api.token",
        schema: { type: "string", maxLength: 2048 },
        ...(secretFlag ? { secret: true } : {}),
        managementDefault: "hidden",
      },
      {
        key: "proxy.subscriptionUrl",
        kind: "secret",
        secret: true,
        category: "VPN",
        label: "VPN subscription URL",
        description: "Subscription URL.",
        accessor: "proxy.subscriptionUrl",
        schema: { type: "string", maxLength: 2048 },
        managementDefault: "hidden",
      },
    ],
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// R12-01 — redactPayload() fails OPEN when the active catalog is unavailable.
// ───────────────────────────────────────────────────────────────────────────────
// FIXED (R12-01): redactPayload now FAILS CLOSED. The catalog is mutable external state —
// null during every schema replacement and manifest resync, null on a corrupt catalog_json,
// and a v2 catalog may drop a key or its `secret` flag — so an entry that cannot be positively
// classified as non-secret is blanked. The module's stated guarantee ("responses NEVER echo a
// stored secret value") now holds when the catalog is missing, not only when it agrees.
describe("R12-01 redactPayload now fails CLOSED without a catalog", () => {
  it("FIXED: a null catalog blanks the value instead of echoing it verbatim", () => {
    const payload = parsePayload(
      JSON.stringify({
        config: {
          "api.token": {
            state: "enforced",
            value: "SUPER-SECRET-TOKEN",
            updatedAt: NOW,
          },
        },
        secrets: {},
        entitlements: {},
      }),
    );
    // Catalog present => blanked.
    const withCatalog = redactPayload(payload, {
      entryByKey: () => ({ secret: true }),
    } as never);
    expect(withCatalog.config["api.token"]!.value).toBe("");

    // Catalog null (no active schema / unparseable catalog_json) => still blanked.
    const withoutCatalog = redactPayload(payload, null);
    expect(withoutCatalog.config["api.token"]!.value).toBe("");
    // …and the change metadata the admin UI needs survives.
    expect(withoutCatalog.config["api.token"]!.state).toBe("enforced");
    expect(withoutCatalog.config["api.token"]!.updatedAt).toBe(NOW);

    // A key the catalog positively declares NON-secret is still echoed in full.
    const nonSecret = redactPayload(payload, {
      entryByKey: () => ({ secret: false }),
    } as never);
    expect(nonSecret.config["api.token"]!.value).toBe("SUPER-SECRET-TOKEN");
  });

  it("FIXED (e2e): GET profile detail stays blanked after the active schema is deactivated", async () => {
    const kv = new KvMock();
    const db: Db = makeTestDb();
    const env = adminEnv(kv, ["acme"]);
    await seedProduct(db, "acme", { catalog: catalogWithSecrets(true) });
    const { cookie, csrf } = await sessionCookie(env);

    const created = await handleAdmin(
      mkReq("POST", "/api/products/acme/config/profiles", {
        cookie,
        csrf,
        body: { id: "prof-a", name: "A" },
      }),
      env,
      db,
      "/api/products/acme/config/profiles",
      { now: NOW },
    );
    expect(created.status).toBe(201);

    // Write a value into the secret-flagged CONFIG key.
    const put = await handleAdmin(
      mkReq("PUT", "/api/products/acme/config/profiles/prof-a", {
        cookie,
        csrf,
        body: {
          updates: [
            {
              key: "api.token",
              state: "enforced",
              value: "SUPER-SECRET-TOKEN",
            },
          ],
        },
      }),
      env,
      db,
      "/api/products/acme/config/profiles/prof-a",
      { now: NOW },
    );
    expect(put.status).toBe(200);

    // While the catalog is active the value is blanked (the documented behaviour).
    const okRes = await handleAdmin(
      mkReq("GET", "/api/products/acme/config/profiles/prof-a", { cookie }),
      env,
      db,
      "/api/products/acme/config/profiles/prof-a",
      { now: NOW },
    );
    const okBody = (await okRes.json()) as {
      payload: { config: Record<string, { value: unknown }> };
    };
    expect(okBody.payload.config["api.token"]!.value).toBe("");

    // ATTACK: deactivate the active schema. This is an ordinary admin action — schema
    // replacement, product re-link, or a corrupt catalog_json all land here, so loadCatalog()
    // returns null. The redaction no longer depends on it.
    await deactivateSchemas(db, "acme");

    const leakRes = await handleAdmin(
      mkReq("GET", "/api/products/acme/config/profiles/prof-a", { cookie }),
      env,
      db,
      "/api/products/acme/config/profiles/prof-a",
      { now: NOW },
    );
    const leakBody = (await leakRes.json()) as {
      payload: { config: Record<string, { value: unknown }> };
    };
    expect(leakBody.payload.config["api.token"]!.value).toBe("");
  });

  it("FIXED (e2e): dropping the `secret` flag in a NEW catalog version cannot un-redact a value written under the old one", async () => {
    const kv = new KvMock();
    const db: Db = makeTestDb();
    const env = adminEnv(kv, ["acme"]);
    await seedProduct(db, "acme", { catalog: catalogWithSecrets(true) });
    const { cookie, csrf } = await sessionCookie(env);

    await handleAdmin(
      mkReq("POST", "/api/products/acme/config/profiles", {
        cookie,
        csrf,
        body: { id: "prof-b", name: "B" },
      }),
      env,
      db,
      "/api/products/acme/config/profiles",
      { now: NOW },
    );
    await handleAdmin(
      mkReq("PUT", "/api/products/acme/config/profiles/prof-b", {
        cookie,
        csrf,
        body: {
          updates: [
            { key: "api.token", state: "enforced", value: "TOKEN-XYZ" },
          ],
        },
      }),
      env,
      db,
      "/api/products/acme/config/profiles/prof-b",
      { now: NOW },
    );

    // Publish catalog v2 that no longer marks api.token as secret.
    await deactivateSchemas(db, "acme");
    await insertSchema(db, {
      product: "acme",
      catalog_version: 2,
      catalog_json: JSON.stringify(catalogWithSecrets(false)),
      active: 1,
      created_at: NOW,
    });

    const res = await handleAdmin(
      mkReq("GET", "/api/products/acme/config/profiles/prof-b", { cookie }),
      env,
      db,
      "/api/products/acme/config/profiles/prof-b",
      { now: NOW },
    );
    const body = (await res.json()) as {
      payload: { config: Record<string, { value: unknown }> };
    };
    // R12-02 seals it at rest as well, so there is no plaintext left to leak either way.
    expect(body.payload.config["api.token"]!.value).toBe("");
  });

  it("CONFIRMED: a corrupt catalog_json silently degrades loadCatalog() to null", async () => {
    const db: Db = makeTestDb();
    await seedProduct(db, "acme", { catalog: catalogWithSecrets(true) });
    await db.run(
      "UPDATE product_schema SET catalog_json = ? WHERE product = ? AND active = 1",
      "{ not json",
      "acme",
    );
    expect(await loadCatalog(db, "acme")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R12-02 — managed "secrets" are stored in D1 as PLAINTEXT, unlike product_secrets.
// ───────────────────────────────────────────────────────────────────────────────
// FIXED (R12-02): catalog-declared secrets are now envelope-encrypted under PLATFORM_KEK by
// applyOverrides, exactly like product_keys.enc_private_json and product_secrets.enc_value_json.
// A read-only D1 dump no longer yields product-delivered secrets in cleartext.
describe("R12-02 managed secret values are SEALED at rest in D1", () => {
  it("FIXED: kind:'secret' and secret-flagged config are sealed in profiles.payload_json", async () => {
    const kv = new KvMock();
    const db: Db = makeTestDb();
    const env = adminEnv(kv, ["acme"]);
    await seedProduct(db, "acme", { catalog: catalogWithSecrets(true) });
    const { cookie, csrf } = await sessionCookie(env);

    await handleAdmin(
      mkReq("POST", "/api/products/acme/config/profiles", {
        cookie,
        csrf,
        body: { id: "prof-c", name: "C" },
      }),
      env,
      db,
      "/api/products/acme/config/profiles",
      { now: NOW },
    );
    await handleAdmin(
      mkReq("PUT", "/api/products/acme/config/profiles/prof-c", {
        cookie,
        csrf,
        body: {
          updates: [
            {
              key: "api.token",
              state: "enforced",
              value: "PLAINTEXT-CONFIG-SECRET",
            },
            {
              key: "proxy.subscriptionUrl",
              state: "enforced",
              value: "https://vpn.example.com/sub/PLAINTEXT-KIND-SECRET",
            },
          ],
        },
      }),
      env,
      db,
      "/api/products/acme/config/profiles/prof-c",
      { now: NOW },
    );

    const row = await db.first<{ payload_json: string }>(
      "SELECT payload_json FROM profiles WHERE product = ? AND id = ?",
      "acme",
      "prof-c",
    );
    // The at-rest assertion R12-02 said was missing — the mirror of admin.test.ts's
    // `enc_private_json` check, now applied to the managed payload columns.
    expect(row!.payload_json).not.toContain("PLAINTEXT-CONFIG-SECRET");
    expect(row!.payload_json).not.toContain("PLAINTEXT-KIND-SECRET");
    expect(row!.payload_json).toContain('\\"v\\":2'); // Sealed envelope, JSON-in-JSON

    // …and the ciphertext round-trips under the right AAD (product + catalog key), so the
    // delivery path can recover the plaintext.
    const payload = parsePayload(row!.payload_json);
    const opened = await openManagedPayload(env, "acme", payload);
    expect(opened.config["api.token"]!.value).toBe("PLAINTEXT-CONFIG-SECRET");
    expect(opened.secrets["proxy.subscriptionUrl"]!.value).toBe(
      "https://vpn.example.com/sub/PLAINTEXT-KIND-SECRET",
    );

    // A blob lifted from one product cannot be opened as another product's key (AAD binding).
    expect(
      await openManagedValue(
        env,
        "evilco",
        "api.token",
        payload.config["api.token"]!.value,
      ),
    ).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R12-03 — a live GitHub App installation token is cached in KV in PLAINTEXT.
// ───────────────────────────────────────────────────────────────────────────────

/** An env with a working GitHub App keypair, so `getInstallationToken` really signs a JWT. */
async function ghAppEnv(kv: KvMock): Promise<Env> {
  const env = adminEnv(kv, ["acme"]);
  env.GITHUB_APP_ID = "123456";
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey(
    "pkcs8",
    pair.privateKey,
  )) as ArrayBuffer;
  let bin = "";
  for (const b of new Uint8Array(pkcs8)) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  env.GITHUB_APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${(b64.match(/.{1,64}/g) ?? [b64]).join("\n")}\n-----END PRIVATE KEY-----`;
  return env;
}

const mintsToken = async (): Promise<Response> =>
  new Response(JSON.stringify({ token: "ghs_LIVE_INSTALLATION_TOKEN" }), {
    status: 201,
    headers: { "content-type": "application/json" },
  }) as unknown as Response;

// FIXED (R12-03). The cached record is sealed under the platform KEK before it is written,
// so the one directly-usable credential in KV is now ciphertext like everything else. The
// original assertion — `kv.get(…)` containing `ghs_LIVE_INSTALLATION_TOKEN` — is inverted
// below, and strengthened to sweep the WHOLE namespace rather than one key, so a future
// change that writes the token somewhere else in KV also trips it.
describe("R12-03 GitHub installation token is sealed in KV", () => {
  it("FIXED: a full KV dump contains no readable bearer token", async () => {
    const kv = new KvMock();
    const env = await ghAppEnv(kv);

    const token = await getInstallationToken(
      env,
      { owner: "acme", repo: "widget" },
      42,
      NOW,
      mintsToken,
    );
    expect(token).toBe("ghs_LIVE_INSTALLATION_TOKEN");

    // Dump KV, exactly as a leaked Cloudflare API token with KV:read would.
    const keys = kv.keys();
    expect(keys.length).toBe(1);
    for (const k of keys) {
      expect(await asKv(kv).get(k)).not.toContain(
        "ghs_LIVE_INSTALLATION_TOKEN",
      );
    }
  });

  it("FIXED: what IS stored is a v2 AES-GCM envelope that only the KEK opens", async () => {
    const kv = new KvMock();
    const env = await ghAppEnv(kv);
    const { key, ctx } = installationTokenSlot(42, {
      owner: "acme",
      repo: "widget",
    });

    await getInstallationToken(
      env,
      { owner: "acme", repo: "widget" },
      42,
      NOW,
      mintsToken,
    );

    const stored = (await asKv(kv).get(key)) as string;
    const envelope = JSON.parse(stored) as Record<string, unknown>;
    expect(envelope.v).toBe(2);
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.ct).toBe("string");
    expect(Object.keys(envelope)).not.toContain("token");

    // Round-trips only under the same AAD — i.e. the same installation AND the same scope.
    const opened = JSON.parse(await open(env, stored, ctx)) as {
      token: string;
      granted: string;
    };
    expect(opened.token).toBe("ghs_LIVE_INSTALLATION_TOKEN");
    expect(opened.granted).toBe("acme/widget");
    await expect(
      open(
        env,
        stored,
        installationTokenSlot(42, { owner: "acme", repo: "other" }).ctx,
      ),
    ).rejects.toThrow();
  });

  it("FIXED: with no usable KEK the token is served but NEVER persisted", async () => {
    const kv = new KvMock();
    const env = await ghAppEnv(kv);
    // A deployment mid-rotation / missing its KEK. Sealing is impossible; the old code would
    // have written plaintext anyway.
    delete (env as Record<string, unknown>).PLATFORM_KEK;
    delete (env as Record<string, unknown>).PLATFORM_KEK_KEYS;
    delete (env as Record<string, unknown>).PLATFORM_KEK_ACTIVE;

    const token = await getInstallationToken(
      env,
      { owner: "acme", repo: "widget" },
      42,
      NOW,
      mintsToken,
    );
    expect(token).toBe("ghs_LIVE_INSTALLATION_TOKEN");
    expect(kv.keys()).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R12-04 — credentials used verbatim as KV KEY NAMES (magic link, OIDC state, device code).
// ───────────────────────────────────────────────────────────────────────────────
describe("R12-04 credentials are KV key names, so a KV LIST is a credential dump", () => {
  it("CONFIRMED: the magic-link token IS the KV key and the victim email is the value", async () => {
    const kv = new KvMock();
    const db: Db = makeTestDb();
    const env = adminEnv(kv, ["acme"]);
    env.PORTAL_EMAIL_FROM = "Polaris Key <noreply@plrs.im>";
    env.EMAIL = { send: async (): Promise<void> => undefined } as never;
    await seedProduct(db, "acme");
    await upsertPortalProductSettings(
      db,
      "acme",
      { portalEnabled: true, magicEnabled: true },
      NOW,
    );

    const req = new Request("https://portal.plrs.im/api/magic/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "1.2.3.4",
      },
      body: JSON.stringify({ email: "victim@example.com" }),
    }) as unknown as Request;
    const res = await handleMagicStart(req, env, db);
    expect(res.status).toBe(200);

    const keys = kv.keys().filter((k) => k.startsWith("portal:magic:"));
    expect(keys).toHaveLength(1);

    // The key name IS the bearer credential — no hash, no pepper.
    const token = keys[0]!.slice("portal:magic:".length);
    expect(token).toMatch(/^magic_[A-Za-z0-9_-]+$/);

    // ...and the value names the victim.
    const value = await asKv(kv).get(keys[0]!);
    expect(value).toContain("victim@example.com");
  });

  it("CONFIRMED: the magic token carries only 72 bits of entropy (randomId = 9 bytes)", () => {
    const raw = randomId("magic").slice("magic_".length);
    // base64url of 9 bytes => 12 chars, i.e. 72 bits — vs 128 for a license key
    // and 256 for a device token (crypto.ts mintLicenseKey / mintToken).
    expect(raw).toHaveLength(12);
    const lic = mintLicenseKey("acme");
    expect(lic.slice("pkey_acme_".length)).toHaveLength(22); // 128 bits
  });

  it("REFUTED-BY-CONTRAST: device tokens and download tokens ARE hashed before storage", async () => {
    const hashed = await hashKey("plrst_abc", "pepper");
    expect(hashed).not.toContain("plrst_");
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R12-05 — KEY_HASH_PEPPER is optional and silently degrades to bare SHA-256.
// ───────────────────────────────────────────────────────────────────────────────
describe("R12-05 KEY_HASH_PEPPER silently optional", () => {
  it("CONFIRMED: with no pepper, hashKey() is a plain unsalted SHA-256 an attacker can recompute", async () => {
    const key = "pkey_acme_AAAAAAAAAAAAAAAAAAAAAA";
    const stored = await hashKey(key, undefined);

    // Offline recomputation with no server-side material at all.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(key),
    );
    const recomputed = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(stored).toBe(recomputed);

    // With a pepper the same guess cannot be confirmed offline.
    expect(await hashKey(key, "pepper")).not.toBe(recomputed);
  });

  it("CONFIRMED: nothing on the boot path requires KEY_HASH_PEPPER to be set", async () => {
    const kv = new KvMock();
    const env = makeEnv(kv, ["acme"]);
    expect(env.KEY_HASH_PEPPER).toBeUndefined();
    // The whole existing test corpus runs unpeppered — exactly the prod-misconfig shape.
    const db: Db = makeTestDb();
    await seedProduct(db, "acme");
    const { key } = await seedLicenseWithKey(db, "acme");
    const row = await db.first<{ key_hash: string }>(
      "SELECT key_hash FROM keys_index WHERE product = ?",
      "acme",
    );
    expect(row!.key_hash).toBe(await hashKey(key, undefined));
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R12-06 — the portal serves the full User-Agent back to end users; PRIVACY.md omits it.
// ───────────────────────────────────────────────────────────────────────────────
describe("R12-06 device User-Agent is collected, stored and re-served", () => {
  it("CONFIRMED: devices.ua persists the verbatim client User-Agent header", async () => {
    const db: Db = makeTestDb();
    await seedProduct(db, "acme");
    const { licenseId } = await seedLicenseWithKey(db, "acme");
    const UA =
      "DJDL/3.2.1 (Macintosh; Intel Mac OS X 15_3; corp-build-8891) AppleWebKit/605.1.15";
    await upsertDevice(db, {
      product: "acme",
      device_id: "dev-1",
      customer_id: null,
      license_id: licenseId,
      status: "authorized",
      first_seen: NOW,
      last_seen: NOW,
      ua: UA,
      label: null,
      overrides_json: null,
      reported_json: null,
      token_hash: null,
      platform: "darwin",
      arch: "arm64",
      app_version: "3.2.1",
      sdk_name: "node",
      sdk_version: "1.0.0",
    } as never);
    const row = await db.first<{ ua: string }>(
      "SELECT ua FROM devices WHERE product = ? AND device_id = ?",
      "acme",
      "dev-1",
    );
    expect(row!.ua).toBe(UA); // untruncated, unhashed

    // PRIVACY.md never mentions the User-Agent, in either the "collected" or
    // "not collected" list.
    const privacy = readFileSync(join(REPO, "docs", "PRIVACY.md"), "utf8");
    expect(privacy.toLowerCase()).not.toContain("user-agent");
    expect(privacy.toLowerCase()).not.toContain("user agent");
    // Nor the client IP that rateLimit.clientIp() reads and Workers Logs persists.
    expect(privacy).not.toContain("cf-connecting-ip");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R12-07 — the Python README pins a COMMITTED test keypair as a production trust anchor.
// ───────────────────────────────────────────────────────────────────────────────
describe("R12-07 committed corpus key published as a prod trust anchor", () => {
  // FIXED (R12-07) — the SDK READMEs now pin unmistakable placeholders and point readers at
  // the onboarding bundle / jwks.json for the real values. The forgery below still works
  // against the corpus key, of course — that is what a test key is for; what changed is that
  // no published example tells an adopter to trust it. This test is now the regression
  // guard: no README may contain a corpus PUBLIC key, under any kid.
  it("FIXED: no SDK README publishes a corpus public key as a trust anchor", async () => {
    const corpus = JSON.parse(
      readFileSync(
        join(REPO, "conformance", "corpus", "v1", "cases.json"),
        "utf8",
      ),
    ) as {
      keys: { kid: string; publicKeyRaw: string; privateKeyPkcs8Pem: string }[];
    };
    const readmes = [
      join(REPO, "sdks", "python", "README.md"),
      join(REPO, "sdks", "swift", "README.md"),
      join(REPO, "packages", "sdk-node", "README.md"),
      join(REPO, "packages", "sdk-react", "README.md"),
      join(REPO, "README.md"),
    ];
    for (const path of readmes) {
      const text = readFileSync(path, "utf8");
      for (const key of corpus.keys) {
        expect(
          text,
          `${path} must not pin ${key.kid}'s public key`,
        ).not.toContain(key.publicKeyRaw);
      }
    }

    // The Python quickstart — the one R12-07 was filed against — pins a placeholder that
    // cannot be mistaken for a key, right beside the production origin it used to endorse.
    const python = readFileSync(
      join(REPO, "sdks", "python", "README.md"),
      "utf8",
    );
    expect(python).toContain('base_url="https://key.plrs.im"');
    expect(python).toContain("<your-product-signing-key-b64url>");
    expect(python).not.toContain("pkey-prod-2026");

    // …and the attack it enabled is unchanged in nature: `verifyJws` selects by the
    // attacker-controlled `kid`, so ANY published keypair is a forgery oracle. That is
    // precisely why no real trust set may ever be sourced from this repo.
    const testKey = corpus.keys.find((k) => k.kid === "pkey-test-prod-2026")!;
    const forged = await signJws(
      { evil: true, entitlements: { premium: true } },
      testKey.privateKeyPkcs8Pem,
      "pkey-prod-2026",
    );
    const verified = await verifyJws(forged, {
      "pkey-prod-2026": testKey.publicKeyRaw,
    });
    expect(verified).not.toBeNull();
    expect(verified!.kid).toBe("pkey-prod-2026");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R12-08 — prod Cloudflare resource IDs committed, contradicting wrangler.toml's own comment.
// ───────────────────────────────────────────────────────────────────────────────
describe("R12-08 committed prod resource IDs", () => {
  it("CONFIRMED: prod KV + D1 ids are real while staging/dev keep placeholders", () => {
    const toml = readFileSync(join(HERE, "..", "..", "wrangler.toml"), "utf8");
    expect(toml).toContain("cannot be\n# committed here as real values");
    expect(toml).toContain('id = "51b31c97ac2140e5af2402bed1a31e71"');
    expect(toml).toContain(
      'database_id = "4bcb24b2-80af-4180-abcc-0e5e99564ed8"',
    );
    expect(toml).toContain("REPLACE_ME_STAGING_KV_ID");
    expect(toml).toContain("REPLACE_ME_DEV_D1_ID");
  });

  it("CONFIRMED: Workers Logs persist invocation metadata at 100% sampling", () => {
    const toml = readFileSync(join(HERE, "..", "..", "wrangler.toml"), "utf8");
    const logs = toml.slice(toml.indexOf("[observability.logs]"));
    expect(logs).toMatch(/enabled = true/);
    expect(logs).toMatch(/head_sampling_rate = 1/);
    expect(logs).toMatch(/persist = true/);
    expect(logs).toMatch(/invocation_logs = true/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// REFUTED — properties that DO hold.
// ───────────────────────────────────────────────────────────────────────────────
describe("R12 refuted hypotheses", () => {
  it("REFUTED: PUT /secrets/<name> never echoes the value", async () => {
    const kv = new KvMock();
    const db: Db = makeTestDb();
    const env = adminEnv(kv, ["acme"]);
    await seedProduct(db, "acme");
    const { cookie, csrf } = await sessionCookie(env);
    const res = await handleAdmin(
      mkReq("PUT", "/api/products/acme/secrets/UPSTREAM_TOKEN", {
        cookie,
        csrf,
        body: { value: "NEVER-ECHO-ME" },
      }),
      env,
      db,
      "/api/products/acme/secrets/UPSTREAM_TOKEN",
      { now: NOW },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("NEVER-ECHO-ME");
    const stored = await db.first<{ enc_value_json: string }>(
      "SELECT enc_value_json FROM product_secrets WHERE product = ? AND name = ?",
      "acme",
      "UPSTREAM_TOKEN",
    );
    expect(stored!.enc_value_json).not.toContain("NEVER-ECHO-ME");
  });

  it("REFUTED: key prepare/rotate returns only the PUBLIC key, never the PEM", async () => {
    const kv = new KvMock();
    const db: Db = makeTestDb();
    const env = adminEnv(kv, ["acme"]);
    await seedProduct(db, "acme");
    const { cookie, csrf } = await sessionCookie(env);
    const res = await handleAdmin(
      mkReq("POST", "/api/products/acme/keys/prepare", {
        cookie,
        csrf,
        body: {},
      }),
      env,
      db,
      "/api/products/acme/keys/prepare",
      { now: NOW },
    );
    const text = await res.text();
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(text).not.toContain(TEST_PEM);
  });

  it("REFUTED: the product registry view never carries sealed key material", async () => {
    const kv = new KvMock();
    const db: Db = makeTestDb();
    const env = adminEnv(kv, ["acme"]);
    await seedProduct(db, "acme");
    const { cookie } = await sessionCookie(env);
    const res = await handleAdmin(
      mkReq("GET", "/api/products/acme", { cookie }),
      env,
      db,
      "/api/products/acme",
      { now: NOW },
    );
    const text = await res.text();
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(text).not.toContain("enc_private_json");
    expect(text).not.toContain("enc_value_json");
    expect(text).not.toContain('"ct"');
  });

  it("REFUTED: GitHub error strings carry STATUS CODES only — never a body, URL or token", () => {
    const src = readFileSync(
      join(WORKER_SRC, "services", "release", "github.ts"),
      "utf8",
    );
    for (const m of src.matchAll(/NotFoundError\(`([^`]+)`\)/g)) {
      expect(m[1]).not.toContain("${jwt}");
      expect(m[1]).not.toContain("${token}");
      expect(m[1]).not.toContain("${url}");
    }
    const app = readFileSync(
      join(WORKER_SRC, "services", "release", "githubApp.ts"),
      "utf8",
    );
    for (const m of app.matchAll(/new Error\(`([^`]+)`\)/g)) {
      expect(m[1]).not.toContain("${jwt}");
      expect(m[1]).not.toContain("${pem}");
      expect(m[1]).not.toContain("${body.token}");
    }
  });

  it("REFUTED: there is no console.* logging anywhere in packages/worker/src", () => {
    const offenders = walkTs(WORKER_SRC).filter((f) =>
      /\bconsole\s*\./.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("REFUTED: the committed test kid/pubkey are referenced only from tests and the corpus", () => {
    const offenders = walkTs(WORKER_SRC).filter((f) => {
      const s = readFileSync(f, "utf8");
      return (
        s.includes("pkey-test-prod-2026") ||
        s.includes("kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI")
      );
    });
    expect(offenders).toEqual([]);
  });
});
