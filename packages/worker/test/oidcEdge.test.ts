import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, importJWK, type KeyLike, SignJWT } from "jose";
import type { ManagedPayload } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { loadProduct, type Product } from "../src/product.js";
import {
  applyProvisioning,
  authorizeAndMint,
  enrollFromIdentity,
  handleAuthCallback,
  handleAuthPoll,
  handleAuthStart,
  type OidcIdentity,
} from "../src/oidc.js";
import { getLicense, getLicenseBySub } from "../src/repo.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

// Holder for the IdP public key the mocked `createRemoteJWKSet` should resolve to. jose's
// remote JWKS fetch bypasses globalThis.fetch (uses its own client), so we swap ONLY the
// JWKS getter while keeping the REAL `jwtVerify` (so iss/aud/sig/nonce checks are genuine).
const idpKey = vi.hoisted(() => ({ getKey: null as null | (() => Promise<unknown>) }));
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
    "INSERT INTO oidc_config (product, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?)",
    "djdl", "https://id.example", "client-djdl", null,
    JSON.stringify(["https://key.plrs.im/djdl/auth/callback"]),
    JSON.stringify({ family: { role: "user", tier: "pro" }, admin: { role: "admin" } }),
  );
  await db.run(
    "INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_machine_limit, modified_by, modified_at) VALUES (?,?,?,?,?,?,?,?)",
    "djdl", "pro", "Pro", null, 365, 5, null, NOW,
  );
  await db.run(
    "INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json) VALUES (?,?,?,?,?,?,?)",
    "djdl", "remnawaveSub", "polarisVpn", JSON.stringify(true), "proxy.subscriptionUrl",
    "https://vpn.polaris.rest/{claim}", JSON.stringify(["vpn.polaris.rest"]),
  );
}

const emptyPayload = (): ManagedPayload => ({ config: {}, secrets: {}, entitlements: {} });

describe("enrollFromIdentity", () => {
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
    const r1 = await enrollFromIdentity(db, product, identity(), NOW);
    const r2 = await enrollFromIdentity(db, product, identity({ name: "Changed Name" }), NOW + 100);
    expect(r2).toEqual(r1);
    // Only one license row exists for the sub.
    expect((await getLicenseBySub(db, "djdl", "user-123"))).not.toBeNull();
  });

  it("denies an identity whose groups grant nothing", async () => {
    const r = await enrollFromIdentity(db, product, identity({ sub: "x", groups: ["randos"] }), NOW);
    expect(r).toEqual({ error: "not-entitled" });
  });

  it("selects the tier from the first matching group + stamps expiry", async () => {
    const r = await enrollFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const lic = await getLicense(db, "djdl", r.licenseId);
    expect(lic?.tier_id).toBe("pro");
    expect(lic?.expires_at).toBe(NOW + 365 * 86400);
  });

  it("leaves expiry null when the matched group has no tier", async () => {
    const r = await enrollFromIdentity(db, product, identity({ sub: "adminuser", groups: ["admin"] }), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const lic = await getLicense(db, "djdl", r.licenseId);
    expect(lic?.tier_id).toBeNull();
    expect(lic?.expires_at).toBeNull();
  });

  it("bakes provisioning overrides into the new license", async () => {
    const r = await enrollFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const lic = await getLicense(db, "djdl", r.licenseId);
    const ov = JSON.parse(lic!.overrides_json!) as ManagedPayload;
    expect(ov.entitlements.polarisVpn?.value).toBe(true);
    expect(ov.secrets["proxy.subscriptionUrl"]?.value).toBe("https://vpn.polaris.rest/abc123");
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
    await applyProvisioning(db, "djdl", identity({ claims: { sub: "x" } }), p, NOW); // no remnawaveSub
    expect(p.entitlements.polarisVpn).toBeUndefined();
    expect(p.secrets["proxy.subscriptionUrl"]).toBeUndefined();
  });

  it("skips a claim that is explicitly false", async () => {
    const p = emptyPayload();
    await applyProvisioning(db, "djdl", identity({ claims: { sub: "x", remnawaveSub: false } }), p, NOW);
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
    await applyProvisioning(db, "djdl", identity({ claims: { sub: "x", remnawaveSub: "a/b c" } }), p, NOW);
    expect(p.secrets["proxy.subscriptionUrl"]?.value).toBe("https://vpn.polaris.rest/a%2Fb%20c");
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

  const poll = (state: string, machine = "dev-1") =>
    handleAuthPoll(
      new Request(`https://key.plrs.im/djdl/auth/poll?state=${state}&machine=${machine}`) as unknown as Request,
      env, db, product, NOW,
    );

  async function putFlow(state: string, flow: Record<string, unknown>): Promise<void> {
    await env.HOT.put(`p:djdl:flow:${state}`, JSON.stringify({ verifier: "v", nonce: "n", redirectUri: "r", ...flow }));
  }

  it("returns timeout when the flow record is gone", async () => {
    const res = await poll("missing");
    expect(((await res.json()) as { status: string }).status).toBe("timeout");
  });

  it("requires state + machine query params", async () => {
    const res = await handleAuthPoll(
      new Request("https://key.plrs.im/djdl/auth/poll?state=x") as unknown as Request, env, db, product, NOW,
    );
    expect(res.status).toBe(400);
  });

  it("returns pending while the flow has neither error nor licenseId", async () => {
    await putFlow("s1", {});
    expect(((await (await poll("s1")).json()) as { status: string }).status).toBe("pending");
  });

  it("returns a generic error with NO IdP reason (no failure enumeration)", async () => {
    // Even if a flow somehow carries an error reason, the poll surface must not echo it.
    await putFlow("s2", { error: "id-token-invalid" });
    const res = await poll("s2");
    const body = (await res.clone().json()) as { status: string; reason?: string };
    expect(body.status).toBe("error");
    expect(body.reason).toBeUndefined();
    // The raw response body must not leak any IdP failure string either.
    expect(await res.text()).not.toContain("id-token-invalid");
  });

  it("returns ready with a token once the license is set, then consumes the flow", async () => {
    const r = await enrollFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    await putFlow("s3", { licenseId: r.licenseId });
    const body = (await (await poll("s3")).json()) as { status: string; token: string };
    expect(body.status).toBe("ready");
    expect(body.token.startsWith("pkeyt_")).toBe(true);
    // The flow record is deleted after a ready poll → a second poll times out.
    expect(((await (await poll("s3")).json()) as { status: string }).status).toBe("timeout");
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
    const r = await enrollFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const token = await authorizeAndMint(env, db, product, r.licenseId, "dev-oidc", NOW);
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
    await seedOidc(db); // allowlists https://key.plrs.im/djdl/auth/callback
    product = (await loadProduct(env, db, "djdl"))!;
  });

  it("starts the flow when the computed redirect URI is allow-listed", async () => {
    const req = new Request("https://key.plrs.im/djdl/auth/start") as unknown as Request;
    const res = await handleAuthStart(req, env, db, product);
    expect(res.status).toBe(302);
  });

  it("returns 400 when the computed redirect URI is NOT allow-listed", async () => {
    // A request arriving at a different origin computes an off-allowlist redirect URI.
    const req = new Request("https://evil.example/djdl/auth/start") as unknown as Request;
    const res = await handleAuthStart(req, env, db, product);
    expect(res.status).toBe(400);
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
  const REDIRECT = "https://key.plrs.im/djdl/auth/callback";

  /** Route globalThis.fetch: the token endpoint returns our signed id_token. (JWKS is
   *  resolved by the mocked `createRemoteJWKSet`, not via fetch.) */
  function installFetchMock(idToken: string): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (u.includes("/api/oidc/token")) {
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
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

  /** Seed a flow record the way handleAuthStart would, with a known nonce + redirect URI. */
  async function seedFlow(state: string, nonce: string): Promise<void> {
    await env.HOT.put(
      `p:djdl:flow:${state}`,
      JSON.stringify({ verifier: "v", nonce, redirectUri: REDIRECT }),
    );
  }

  const callback = (state: string, code = "auth-code") =>
    handleAuthCallback(
      new Request(`https://key.plrs.im/djdl/auth/callback?code=${code}&state=${state}`) as unknown as Request,
      env,
      db,
      product,
      NOW,
    );

  const poll = (state: string) =>
    handleAuthPoll(
      new Request(`https://key.plrs.im/djdl/auth/poll?state=${state}&machine=dev-1`) as unknown as Request,
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
    const jwk = { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "test-idp", use: "sig" };
    const pub = await importJWK(jwk, "ES256");
    idpKey.getKey = async () => pub;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    idpKey.getKey = null;
  });

  it("rejects an ID token with NO nonce claim (D9)", async () => {
    await seedFlow("n1", "the-nonce");
    installFetchMock(await signIdToken({ sub: "user-123", groups: ["family"] })); // no nonce
    const res = await callback("n1");
    expect(res.status).toBe(401);
    // Failure deletes the flow → poll cannot enumerate a reason (D8).
    const body = (await poll("n1").then((r) => r.json())) as { status: string; reason?: string };
    expect(body.status).toBe("timeout");
    expect(body.reason).toBeUndefined();
  });

  it("rejects an ID token whose nonce does NOT match the flow (D9)", async () => {
    await seedFlow("n2", "the-nonce");
    installFetchMock(await signIdToken({ sub: "user-123", groups: ["family"], nonce: "WRONG" }));
    const res = await callback("n2");
    expect(res.status).toBe(401);
  });

  it("accepts a matching nonce and mints a license (control)", async () => {
    await seedFlow("n3", "the-nonce");
    installFetchMock(await signIdToken({ sub: "user-123", groups: ["family"], nonce: "the-nonce" }));
    const res = await callback("n3");
    expect(res.status).toBe(200);
    const body = (await poll("n3").then((r) => r.json())) as { status: string };
    expect(body.status).toBe("ready");
  });

  it("does NOT leak a failure reason via poll after a failed callback (D8)", async () => {
    // An entitled-nothing identity: enrollment fails, the flow must be deleted (no reason).
    await seedFlow("n4", "the-nonce");
    installFetchMock(await signIdToken({ sub: "nobody", groups: ["randos"], nonce: "the-nonce" }));
    const cb = await callback("n4");
    expect(cb.status).toBe(403);
    const res = await poll("n4");
    const body = (await res.clone().json()) as { status: string; reason?: string };
    // Flow gone ⇒ generic timeout; crucially, no "not-entitled"/IdP reason is exposed.
    expect(body.reason).toBeUndefined();
    expect(await res.text()).not.toContain("not-entitled");
  });
});
