import { beforeEach, describe, expect, it } from "vitest";
import type { ManagedPayload } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { loadProduct, type Product } from "../src/product.js";
import {
  applyProvisioning,
  authorizeAndMint,
  enrollFromIdentity,
  handleAuthPoll,
  type OidcIdentity,
} from "../src/oidc.js";
import { getLicense, getLicenseBySub } from "../src/repo.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

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
    "djdl", "https://id.example", "client-djdl", null, null,
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
    await applyProvisioning(db, "djdl", identity({ claims: { sub: "x" } }), p); // no remnawaveSub
    expect(p.entitlements.polarisVpn).toBeUndefined();
    expect(p.secrets["proxy.subscriptionUrl"]).toBeUndefined();
  });

  it("skips a claim that is explicitly false", async () => {
    const p = emptyPayload();
    await applyProvisioning(db, "djdl", identity({ claims: { sub: "x", remnawaveSub: false } }), p);
    expect(p.entitlements.polarisVpn).toBeUndefined();
  });

  it("drops a templated secret whose host is NOT in the allowlist", async () => {
    // Point the template host off the allowlist.
    await db.run(
      "UPDATE provisioning_config SET secret_url_template = ? WHERE product = 'djdl' AND claim = 'remnawaveSub'",
      "https://evil.example/{claim}",
    );
    const p = emptyPayload();
    await applyProvisioning(db, "djdl", identity(), p);
    // The entitlement still applies, but the disallowed secret is dropped.
    expect(p.entitlements.polarisVpn?.value).toBe(true);
    expect(p.secrets["proxy.subscriptionUrl"]).toBeUndefined();
  });

  it("URL-encodes the claim value into the secret URL", async () => {
    const p = emptyPayload();
    await applyProvisioning(db, "djdl", identity({ claims: { sub: "x", remnawaveSub: "a/b c" } }), p);
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

  it("returns error with the recorded reason", async () => {
    await putFlow("s2", { error: "id-token-invalid" });
    const body = (await (await poll("s2")).json()) as { status: string; reason: string };
    expect(body.status).toBe("error");
    expect(body.reason).toBe("id-token-invalid");
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
