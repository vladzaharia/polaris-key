import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type KeyLike,
  SignJWT,
} from "jose";
import type { ManagedPayload } from "../src/core/payload.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedProductSecret } from "./seed.js";
import { loadProduct, type Product } from "../src/core/products.js";
import {
  applyProvisioning,
  authorizeAndMint,
  activateFromIdentity,
  deviceFlowKey,
  flowKey,
  handleAuthCallback,
  handleAuthDevicePoll,
  handleAuthDeviceStart,
  handleAuthDeviceVerify,
  handleAuthPoll,
  handleAuthStart,
  type OidcIdentity,
} from "../src/services/identity/oidc.js";
import { getLicense, getLicenseBySub } from "../src/repo.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

// Holder for the IdP public key the mocked `createRemoteJWKSet` should resolve to. jose's
// remote JWKS fetch bypasses globalThis.fetch (uses its own client), so we swap ONLY the
// JWKS getter while keeping the REAL `jwtVerify` (so iss/aud/sig/nonce checks are genuine).
const idpKey = vi.hoisted(() => ({
  getKey: null as null | (() => Promise<unknown>),
}));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () => {
      if (!idpKey.getKey) throw new Error("no test IdP key installed");
      return idpKey.getKey();
    },
  };
});

const identity = (over: Partial<OidcIdentity> = {}): OidcIdentity => ({
  sub: "user-123",
  email: "ada@example.com",
  name: "Ada Lovelace",
  groups: ["family"],
  claims: { sub: "user-123", remnawaveSub: "abc123" },
  ...over,
});

async function seedOidc(db: SqliteDb): Promise<void> {
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "custom",
    "https://id.example",
    "client-djdl",
    null,
    JSON.stringify(["https://key.plrs.im/djdl/identity/auth/callback"]),
    JSON.stringify({
      family: { role: "user", tier: "pro" },
      admin: { role: "admin" },
    }),
  );
  await db.run(
    "INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit, modified_by, modified_at) VALUES (?,?,?,?,?,?,?,?)",
    "djdl",
    "pro",
    "Pro",
    null,
    365,
    5,
    null,
    NOW,
  );
  await db.run(
    "INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "remnawaveSub",
    "polarisVpn",
    JSON.stringify(true),
    "proxy.subscriptionUrl",
    "https://vpn.polaris.rest/{claim}",
    JSON.stringify(["vpn.polaris.rest"]),
  );
}

const emptyPayload = (): ManagedPayload => ({
  config: {},
  secrets: {},
  entitlements: {},
});

describe("activateFromIdentity", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("is idempotent on the OIDC subject", async () => {
    const r1 = await activateFromIdentity(db, product, identity(), NOW);
    const r2 = await activateFromIdentity(
      db,
      product,
      identity({ name: "Changed Name" }),
      NOW + 100,
    );
    expect(r2).toEqual(r1);
    // Only one license row exists for the sub.
    expect(await getLicenseBySub(db, "djdl", "user-123")).not.toBeNull();
  });

  it("denies an identity whose groups grant nothing", async () => {
    const r = await activateFromIdentity(
      db,
      product,
      identity({ sub: "x", groups: ["randos"] }),
      NOW,
    );
    expect(r).toEqual({ error: "not-entitled" });
  });

  it("selects the tier from the first matching group + stamps expiry", async () => {
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const lic = await getLicense(db, "djdl", r.licenseId);
    expect(lic?.tier_id).toBe("pro");
    expect(lic?.expires_at).toBe(NOW + 365 * 86400);
  });

  it("leaves expiry null when the matched group has no tier", async () => {
    const r = await activateFromIdentity(
      db,
      product,
      identity({ sub: "adminuser", groups: ["admin"] }),
      NOW,
    );
    if (!("licenseId" in r)) throw new Error("expected license");
    const lic = await getLicense(db, "djdl", r.licenseId);
    expect(lic?.tier_id).toBeNull();
    expect(lic?.expires_at).toBeNull();
  });

  it("bakes provisioning overrides into the new license", async () => {
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const lic = await getLicense(db, "djdl", r.licenseId);
    const ov = JSON.parse(lic!.overrides_json!) as ManagedPayload;
    expect(ov.entitlements.polarisVpn?.value).toBe(true);
    expect(ov.secrets["proxy.subscriptionUrl"]?.value).toBe(
      "https://vpn.polaris.rest/abc123",
    );
  });
});

describe("applyProvisioning", () => {
  let db: SqliteDb;
  beforeEach(async () => {
    db = makeTestDb();
    await seedProduct(db, "djdl");
    await seedOidc(db);
  });

  it("fires only when the claim is present and truthy", async () => {
    const p = emptyPayload();
    await applyProvisioning(
      db,
      "djdl",
      identity({ claims: { sub: "x" } }),
      p,
      NOW,
    ); // no remnawaveSub
    expect(p.entitlements.polarisVpn).toBeUndefined();
    expect(p.secrets["proxy.subscriptionUrl"]).toBeUndefined();
  });

  it("skips a claim that is explicitly false", async () => {
    const p = emptyPayload();
    await applyProvisioning(
      db,
      "djdl",
      identity({ claims: { sub: "x", remnawaveSub: false } }),
      p,
      NOW,
    );
    expect(p.entitlements.polarisVpn).toBeUndefined();
  });

  it("drops a templated secret whose host is NOT in the allowlist", async () => {
    // Point the template host off the allowlist.
    await db.run(
      "UPDATE provisioning_config SET secret_url_template = ? WHERE product = 'djdl' AND claim = 'remnawaveSub'",
      "https://evil.example/{claim}",
    );
    const p = emptyPayload();
    await applyProvisioning(db, "djdl", identity(), p, NOW);
    // The entitlement still applies, but the disallowed secret is dropped.
    expect(p.entitlements.polarisVpn?.value).toBe(true);
    expect(p.secrets["proxy.subscriptionUrl"]).toBeUndefined();
  });

  it("URL-encodes the claim value into the secret URL", async () => {
    const p = emptyPayload();
    await applyProvisioning(
      db,
      "djdl",
      identity({ claims: { sub: "x", remnawaveSub: "a/b c" } }),
      p,
      NOW,
    );
    expect(p.secrets["proxy.subscriptionUrl"]?.value).toBe(
      "https://vpn.polaris.rest/a%2Fb%20c",
    );
    expect(p.secrets["proxy.subscriptionUrl"]?.state).toBe("hidden");
  });
});

describe("handleAuthPoll states", () => {
  let db: SqliteDb;
  let env: Env;
  let kv: KvMock;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    kv = new KvMock();
    env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    product = (await loadProduct(env, db, "djdl"))!;
  });

  const poll = (state: string, device = "dev-1") =>
    handleAuthPoll(
      new Request(
        `https://key.plrs.im/djdl/identity/auth/poll?state=${state}&device=${device}`,
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );

  /** A flow record shaped the way beginAuthFlow + device confirmation write it: bound to the
   *  device that started it and stamped confirmed. Both are authorization inputs on the poll
   *  surfaces (R8-01), so a fixture without them is not a pollable flow. */
  async function putFlow(
    state: string,
    flow: Record<string, unknown>,
  ): Promise<void> {
    await env.HOT.put(
      await flowKey(env, "djdl", state),
      JSON.stringify({
        verifier: "v",
        nonce: "n",
        redirectUri: "r",
        deviceId: "dev-1",
        confirmedAt: NOW,
        ...flow,
      }),
    );
  }

  it("returns timeout when the flow record is gone", async () => {
    const res = await poll("missing");
    expect(((await res.json()) as { status: string }).status).toBe("timeout");
  });

  it("requires state + device query params", async () => {
    const res = await handleAuthPoll(
      new Request(
        "https://key.plrs.im/djdl/identity/auth/poll?state=x",
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(400);
  });

  it("returns pending while the flow has neither error nor licenseId", async () => {
    await putFlow("s1", {});
    expect(
      ((await (await poll("s1")).json()) as { status: string }).status,
    ).toBe("pending");
  });

  it("returns a generic error with NO IdP reason (no failure enumeration)", async () => {
    // Even if a flow somehow carries an error reason, the poll surface must not echo it.
    await putFlow("s2", { error: "id-token-invalid" });
    const res = await poll("s2");
    const body = (await res.clone().json()) as {
      status: string;
      reason?: string;
    };
    expect(body.status).toBe("error");
    expect(body.reason).toBeUndefined();
    // The raw response body must not leak any IdP failure string either.
    expect(await res.text()).not.toContain("id-token-invalid");
  });

  it("returns ready with a token once the license is set, then consumes the flow", async () => {
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    await putFlow("s3", { licenseId: r.licenseId });
    const body = (await (await poll("s3")).json()) as {
      status: string;
      token: string;
    };
    expect(body.status).toBe("ready");
    expect(body.token.startsWith("pkeyt_")).toBe(true);
    // The flow record is deleted after a ready poll → a second poll times out.
    expect(
      ((await (await poll("s3")).json()) as { status: string }).status,
    ).toBe("timeout");
  });

  it("starts a JSON device flow with a poll handle", async () => {
    const res = await handleAuthDeviceStart(
      new Request("https://key.plrs.im/djdl/identity/auth/device/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "dev-json" }),
      }) as unknown as Request,
      env,
      db,
      product,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      pollUrl: string;
      expiresIn: number;
      interval: number;
    };
    expect(body.deviceCode).toBeTruthy();
    expect(body.userCode).toMatch(/^[A-Z0-9_-]{4}-[A-Z0-9_-]{4}$/);
    expect(body.verificationUri).toContain(
      "https://key.plrs.im/djdl/identity/auth/device/verify?device_code=",
    );
    expect(body.pollUrl).toBe(
      "https://key.plrs.im/djdl/identity/auth/device/poll",
    );
    expect(body.expiresIn).toBe(600);
    expect(body.interval).toBeGreaterThan(0);
    expect(
      await env.HOT.get(await deviceFlowKey(env, "djdl", body.deviceCode)),
    ).toBeTruthy();
  });

  it("polls a JSON device flow and mints through the shared authorizer", async () => {
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    await putFlow("oauth-state", {
      licenseId: r.licenseId,
      deviceId: "dev-json",
    });
    await env.HOT.put(
      await deviceFlowKey(env, "djdl", "device-code"),
      JSON.stringify({
        state: "oauth-state",
        deviceId: "dev-json",
        userCode: "ABCD-EFGH",
        authorizeUrl: "https://id.example/authorize",
        confirmedAt: NOW,
      }),
    );
    const res = await handleAuthDevicePoll(
      new Request("https://key.plrs.im/djdl/identity/auth/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceCode: "device-code",
          deviceId: "dev-json",
        }),
      }) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    const body = (await res.json()) as { status: string; token: string };
    expect(body.status).toBe("ready");
    expect(body.token.startsWith("pkeyt_")).toBe(true);
  });

  it("renders and confirms the JSON device verification page", async () => {
    await putFlow("oauth-state", { deviceId: "dev-json" });
    await env.HOT.put(
      await deviceFlowKey(env, "djdl", "device-code"),
      JSON.stringify({
        state: "oauth-state",
        deviceId: "dev-json",
        userCode: "ABCD-EFGH",
        authorizeUrl: "https://id.example/authorize",
        deviceName: "Studio Mac",
      }),
    );
    const page = await handleAuthDeviceVerify(
      new Request(
        "https://key.plrs.im/djdl/identity/auth/device/verify?device_code=device-code",
      ) as unknown as Request,
      env,
      product,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Studio Mac");
    // The GET renders only; confirmation is a POST carrying the token minted here (R8-02).
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;

    const confirm = await handleAuthDeviceVerify(
      new Request(
        "https://key.plrs.im/djdl/identity/auth/device/verify?device_code=device-code",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "https://key.plrs.im",
          },
          body: new URLSearchParams({ csrf }).toString(),
        },
      ) as unknown as Request,
      env,
      product,
    );
    expect(confirm.status).toBe(303);
    expect(confirm.headers.get("location")).toBe(
      "https://id.example/authorize",
    );
    const stored = JSON.parse(
      (await env.HOT.get(await deviceFlowKey(env, "djdl", "device-code")))!,
    ) as { confirmedAt?: number };
    expect(stored.confirmedAt).toBeTruthy();
    // …and the confirmation is recorded on the flow the poll surfaces actually read.
    const flow = JSON.parse(
      (await env.HOT.get(await flowKey(env, "djdl", "oauth-state")))!,
    ) as {
      confirmedAt?: number;
    };
    expect(flow.confirmedAt).toBeTruthy();
  });

  it("rejects JSON device polls from a different device id", async () => {
    await putFlow("oauth-state", {});
    await env.HOT.put(
      await deviceFlowKey(env, "djdl", "device-code"),
      JSON.stringify({ state: "oauth-state", deviceId: "dev-json" }),
    );
    const res = await handleAuthDevicePoll(
      new Request("https://key.plrs.im/djdl/identity/auth/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceCode: "device-code",
          deviceId: "other-device",
        }),
      }) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );
    expect(res.status).toBe(401);
  });
});

describe("authorizeAndMint", () => {
  it("authorizes the device and writes a usable token record", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const token = await authorizeAndMint(
      env,
      db,
      product,
      r.licenseId,
      "dev-oidc",
      NOW,
    );
    expect(token.startsWith("pkeyt_")).toBe(true);
    // The KV token record is product-scoped.
    expect(kv.keys().some((k) => k.startsWith("p:djdl:token:"))).toBe(true);
  });
});

// ── D7: redirect-URI allowlist ────────────────────────────────────────────────
describe("handleAuthStart redirect-URI allowlist (D7)", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db); // allowlists https://key.plrs.im/djdl/identity/auth/callback
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("starts the flow when the computed redirect URI is allow-listed", async () => {
    const req = new Request(
      "https://key.plrs.im/djdl/identity/auth/start",
    ) as unknown as Request;
    const res = await handleAuthStart(req, env, db, product);
    expect(res.status).toBe(302);
  });

  it("returns 400 when the computed redirect URI is NOT allow-listed", async () => {
    // A request arriving at a different origin computes an off-allowlist redirect URI.
    const req = new Request(
      "https://evil.example/djdl/identity/auth/start",
    ) as unknown as Request;
    const res = await handleAuthStart(req, env, db, product);
    expect(res.status).toBe(400);
  });

  it("rejects cross-origin browser return_to redirects", async () => {
    const req = new Request(
      "https://key.plrs.im/djdl/auth/login?return_to=https%3A%2F%2Fapp.example%2Fdone",
    ) as unknown as Request;
    const res = await handleAuthStart(req, env, db, product);
    expect(res.status).toBe(400);
  });
});

describe("handleAuthStart platform OIDC provider", () => {
  let db: SqliteDb;
  let env: Env;
  let product: Product;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await db.run(
      `INSERT INTO oidc_config
         (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
       VALUES (?,?,?,?,?,?,?)`,
      "djdl",
      "platform",
      null,
      null,
      null,
      JSON.stringify(["https://key.plrs.im/djdl/identity/auth/callback"]),
      JSON.stringify({ family: { role: "user", tier: "pro" } }),
    );
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("uses PLATFORM_OIDC issuer/client for product auth start", async () => {
    env.PLATFORM_OIDC_ISSUER = "https://platform-id.example";
    env.PLATFORM_OIDC_CLIENT_ID = "platform-client";
    const res = await handleAuthStart(
      new Request(
        "https://key.plrs.im/djdl/identity/auth/start",
      ) as unknown as Request,
      env,
      db,
      product,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://platform-id.example");
    expect(location.searchParams.get("client_id")).toBe("platform-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://key.plrs.im/djdl/identity/auth/callback",
    );
  });

  it("fails clearly when platform OIDC env is missing", async () => {
    const res = await handleAuthStart(
      new Request(
        "https://key.plrs.im/djdl/identity/auth/start",
      ) as unknown as Request,
      env,
      db,
      product,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("platform oidc is not configured");
  });
});

// ── D9 + D8: full callback with a signed ID token (nonce + failure enumeration) ──
describe("handleAuthCallback ID-token verification (D9/D8)", () => {
  let db: SqliteDb;
  let env: Env;
  let kv: KvMock;
  let product: Product;
  let priv: KeyLike;

  const ISSUER = "https://id.example";
  const AUD = "client-djdl";
  const REDIRECT = "https://key.plrs.im/djdl/identity/auth/callback";

  /** Route globalThis.fetch: the token endpoint returns our signed id_token. (JWKS is
   *  resolved by the mocked `createRemoteJWKSet`, not via fetch.) */
  function installFetchMock(idToken: string): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const u =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (u.includes("/api/oidc/token")) {
          return new Response(JSON.stringify({ id_token: idToken }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      },
    );
  }

  async function signIdToken(claims: Record<string, unknown>): Promise<string> {
    // jose validates exp/iat against the REAL wall clock; use it so only nonce/iss/aud
    // (the properties under test) decide acceptance.
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "test-idp" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(priv);
  }

  /** Seed a flow record the way handleAuthDeviceStart + confirmation would: known nonce and
   *  redirect URI, bound to `dev-1` and confirmed, so `poll()` below can complete it. */
  async function seedFlow(state: string, nonce: string): Promise<void> {
    await env.HOT.put(
      await flowKey(env, "djdl", state),
      JSON.stringify({
        verifier: "v",
        nonce,
        redirectUri: REDIRECT,
        deviceId: "dev-1",
        confirmedAt: NOW,
      }),
    );
  }

  const callback = (state: string, code = "auth-code") =>
    handleAuthCallback(
      new Request(
        `https://key.plrs.im/djdl/identity/auth/callback?code=${code}&state=${state}`,
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );

  const poll = (state: string) =>
    handleAuthPoll(
      new Request(
        `https://key.plrs.im/djdl/identity/auth/poll?state=${state}&device=dev-1`,
      ) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );

  beforeEach(async () => {
    db = makeTestDb();
    kv = new KvMock();
    env = makeEnv(kv, ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    product = (await loadProduct(env, db, "djdl"))!;
    const pair = await generateKeyPair("ES256", { extractable: true });
    priv = pair.privateKey;
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      alg: "ES256",
      kid: "test-idp",
      use: "sig",
    };
    const pub = await importJWK(jwk, "ES256");
    idpKey.getKey = async () => pub;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    idpKey.getKey = null;
  });

  it("rejects an ID token with NO nonce claim (D9)", async () => {
    await seedFlow("n1", "the-nonce");
    installFetchMock(
      await signIdToken({ sub: "user-123", groups: ["family"] }),
    ); // no nonce
    const res = await callback("n1");
    expect(res.status).toBe(401);
    // Failure deletes the flow → poll cannot enumerate a reason (D8).
    const body = (await poll("n1").then((r) => r.json())) as {
      status: string;
      reason?: string;
    };
    expect(body.status).toBe("timeout");
    expect(body.reason).toBeUndefined();
  });

  it("rejects an ID token whose nonce does NOT match the flow (D9)", async () => {
    await seedFlow("n2", "the-nonce");
    installFetchMock(
      await signIdToken({
        sub: "user-123",
        groups: ["family"],
        nonce: "WRONG",
      }),
    );
    const res = await callback("n2");
    expect(res.status).toBe(401);
  });

  it("accepts a matching nonce and mints a license (control)", async () => {
    await seedFlow("n3", "the-nonce");
    installFetchMock(
      await signIdToken({
        sub: "user-123",
        groups: ["family"],
        nonce: "the-nonce",
      }),
    );
    const res = await callback("n3");
    expect(res.status).toBe(200);
    const body = (await poll("n3").then((r) => r.json())) as { status: string };
    expect(body.status).toBe("ready");
  });

  it("uses platform OIDC env during callback and still mints a product license", async () => {
    await db.run(
      `UPDATE oidc_config
          SET provider = ?, issuer = NULL, client_id = NULL, client_secret_secret = NULL
        WHERE product = ?`,
      "platform",
      "djdl",
    );
    env.PLATFORM_OIDC_ISSUER = ISSUER;
    env.PLATFORM_OIDC_CLIENT_ID = AUD;
    await seedFlow("n-platform", "the-nonce");
    installFetchMock(
      await signIdToken({
        sub: "platform-user",
        groups: ["family"],
        nonce: "the-nonce",
      }),
    );
    const res = await callback("n-platform");
    expect(res.status).toBe(200);
    const lic = await getLicenseBySub(db, "djdl", "platform-user");
    expect(lic?.product).toBe("djdl");
  });

  it("does NOT leak a failure reason via poll after a failed callback (D8)", async () => {
    // An entitled-nothing identity: activation fails, the flow must be deleted (no reason).
    await seedFlow("n4", "the-nonce");
    installFetchMock(
      await signIdToken({
        sub: "nobody",
        groups: ["randos"],
        nonce: "the-nonce",
      }),
    );
    const cb = await callback("n4");
    expect(cb.status).toBe(403);
    const res = await poll("n4");
    const body = (await res.clone().json()) as {
      status: string;
      reason?: string;
    };
    // Flow gone ⇒ generic timeout; crucially, no "not-entitled"/IdP reason is exposed.
    expect(body.reason).toBeUndefined();
    expect(await res.text()).not.toContain("not-entitled");
  });

  // ── P4 regression: confidential-client fail-closed ──────────────────────────
  // When oidc_config DECLARES a `client_secret_secret` name but no matching product_secrets
  // row exists (or it can't be unsealed), the callback MUST fail closed with 500
  // "misconfigured" — it must NEVER silently fall through and exchange the code as a PUBLIC
  // client (which would let a mis-provisioned confidential client be downgraded).
  it("fails closed (500 misconfigured) when a declared client secret is missing — no public exchange", async () => {
    // Declare a secret name, but seed NO product_secrets row for it.
    await db.run(
      "UPDATE oidc_config SET client_secret_secret = ? WHERE product = 'djdl'",
      "OIDC_CLIENT_SECRET",
    );
    await seedFlow("c1", "the-nonce");

    // Track whether the token endpoint is ever called — it must NOT be, since we bail before
    // the exchange. A valid id_token is staged so a (wrongly) public exchange would 200.
    let tokenExchangeCalled = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const u =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (u.includes("/api/oidc/token")) {
          tokenExchangeCalled = true;
          const idToken = await signIdToken({
            sub: "user-123",
            groups: ["family"],
            nonce: "the-nonce",
          });
          return new Response(JSON.stringify({ id_token: idToken }), {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      },
    );

    const res = await callback("c1");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("misconfigured");
    // Proof it did NOT silently downgrade to a public client: the code was never exchanged.
    expect(tokenExchangeCalled).toBe(false);

    // The flow is consumed on the fail-closed path ⇒ a subsequent poll just times out.
    const body = (await poll("c1").then((r) => r.json())) as { status: string };
    expect(body.status).toBe("timeout");
  });

  it("succeeds for the SAME config once the declared secret is sealed in product_secrets (control)", async () => {
    // The confidential client is correctly provisioned: declare the name AND seal a value.
    await db.run(
      "UPDATE oidc_config SET client_secret_secret = ? WHERE product = 'djdl'",
      "OIDC_CLIENT_SECRET",
    );
    await seedProductSecret(
      db,
      "djdl",
      "OIDC_CLIENT_SECRET",
      "shhh-confidential",
    );
    await seedFlow("c2", "the-nonce");

    let sentClientSecret: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const u =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (u.includes("/api/oidc/token")) {
          const params = new URLSearchParams(String(init?.body ?? ""));
          sentClientSecret = params.get("client_secret");
          const idToken = await signIdToken({
            sub: "user-123",
            groups: ["family"],
            nonce: "the-nonce",
          });
          return new Response(JSON.stringify({ id_token: idToken }), {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      },
    );

    const res = await callback("c2");
    expect(res.status).toBe(200);
    // The unsealed secret was forwarded to the IdP as a confidential-client credential.
    expect(sentClientSecret).toBe("shhh-confidential");
  });

  // P0-12 — usage scoping runs both ways. The OIDC path asks for a GENERAL secret, so a secret an
  // operator marked as edge-mint key material reads as missing here: it fails closed exactly
  // like the missing-secret case above, and is never unsealed or sent to the IdP.
  it("fails closed when the declared client secret is marked edge-mint (P0-12)", async () => {
    await db.run(
      "UPDATE oidc_config SET client_secret_secret = ? WHERE product = 'djdl'",
      "OIDC_CLIENT_SECRET",
    );
    await seedProductSecret(
      db,
      "djdl",
      "OIDC_CLIENT_SECRET",
      "shhh-confidential",
      "edge-mint",
    );
    await seedFlow("c3", "the-nonce");
    let tokenExchangeCalled = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const u =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (u.includes("/api/oidc/token")) tokenExchangeCalled = true;
        throw new Error(`unexpected fetch: ${u}`);
      },
    );
    const res = await callback("c3");
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("misconfigured");
    expect(tokenExchangeCalled).toBe(false);
  });
});
