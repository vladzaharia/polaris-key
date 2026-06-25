import { describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedProduct, DJDL_CATALOG, TEST_KID, TEST_PUB } from "./seed.js";
import { loadProduct } from "../src/product.js";
import { enrollFromIdentity, authorizeAndMint, type OidcIdentity } from "../src/oidc.js";
import { handleConfig } from "../src/licensing.js";

async function seedOidc(db: ReturnType<typeof makeTestDb>): Promise<void> {
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

const identity = (over: Partial<OidcIdentity> = {}): OidcIdentity => ({
  sub: "user-123",
  email: "ada@example.com",
  name: "Ada Lovelace",
  groups: ["family"],
  claims: { sub: "user-123", remnawaveSub: "abc123" },
  ...over,
});

describe("OIDC enrollment", () => {
  it("mints a license for an entitled identity and is idempotent", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;

    const r1 = await enrollFromIdentity(db, product, identity(), NOW);
    expect("licenseId" in r1).toBe(true);
    const r2 = await enrollFromIdentity(db, product, identity(), NOW);
    expect(r2).toEqual(r1);
  });

  it("denies an identity whose groups grant nothing", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;
    const r = await enrollFromIdentity(db, product, identity({ sub: "other", groups: ["randos"] }), NOW);
    expect(r).toEqual({ error: "not-entitled" });
  });

  it("applies provisioning hooks (claim → entitlement + host-allowed secret) into the signed doc", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    // Seed the real catalog so handleConfig's defense-in-depth validation keeps the
    // provisioned secret (proxy.subscriptionUrl) instead of pruning it as unknown.
    await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;

    const r = await enrollFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const token = await authorizeAndMint(env, db, product, r.licenseId, "dev-oidc", NOW);

    const res = await handleConfig(
      mkReq("GET", { authorization: `Bearer ${token}`, "x-pkey-version": "1.2.3" }),
      env, db, product, NOW,
    );
    expect(res.status).toBe(200);
    const v = await verifyJws<ManagedConfigDoc>(await res.text(), { [TEST_KID]: TEST_PUB });
    expect(v!.payload.payload.entitlements.polarisVpn?.value).toBe(true);
    expect(v!.payload.payload.secrets["proxy.subscriptionUrl"]?.value).toBe("https://vpn.polaris.rest/abc123");
    expect(v!.payload.payload.secrets["proxy.subscriptionUrl"]?.state).toBe("hidden");
  });
});

void TEST_PUB;
