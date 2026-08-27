import { describe, expect, it } from "vitest";
import { verifyJws } from "@plrs/jws";
import type { LicenseDoc } from "@plrs/protocol/license";
import type { ConfigDoc } from "@plrs/protocol/config";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedProduct,
  DJDL_CATALOG,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import {
  activateFromIdentity,
  authorizeAndMint,
  type OidcIdentity,
} from "../src/services/identity/oidc.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleConfigDocument } from "../src/services/config/document.js";

async function seedOidc(db: ReturnType<typeof makeTestDb>): Promise<void> {
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

const identity = (over: Partial<OidcIdentity> = {}): OidcIdentity => ({
  sub: "user-123",
  email: "ada@example.com",
  name: "Ada Lovelace",
  groups: ["family"],
  claims: { sub: "user-123", remnawaveSub: "abc123" },
  ...over,
});

describe("OIDC activation", () => {
  it("mints a license for an entitled identity and is idempotent", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;

    const r1 = await activateFromIdentity(db, product, identity(), NOW);
    expect("licenseId" in r1).toBe(true);
    const r2 = await activateFromIdentity(db, product, identity(), NOW);
    expect(r2).toEqual(r1);
  });

  it("refreshes OIDC-owned license metadata and provisioning on reuse", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;

    const r1 = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r1)) throw new Error("expected license");
    const r2 = await activateFromIdentity(
      db,
      product,
      identity({
        name: "Ada Changed",
        email: "ada.changed@example.com",
        claims: { sub: "user-123", remnawaveSub: "next-sub" },
      }),
      NOW + 60,
    );
    expect(r2).toEqual(r1);

    const row = await db.first<{
      name: string;
      email: string;
      overrides_json: string;
      expires_at: number;
    }>(
      "SELECT * FROM licenses WHERE product = ? AND id = ?",
      "djdl",
      r1.licenseId,
    );
    expect(row?.name).toBe("Ada Changed");
    expect(row?.email).toBe("ada.changed@example.com");
    expect(row?.expires_at).toBe(NOW + 60 + 365 * 86400);
    const overrides = JSON.parse(row!.overrides_json) as {
      secrets: Record<string, { value: string }>;
    };
    expect(overrides.secrets["proxy.subscriptionUrl"]?.value).toBe(
      "https://vpn.polaris.rest/next-sub",
    );
  });

  it("refuses to reuse disabled or expired OIDC licenses", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;
    const r1 = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r1)) throw new Error("expected license");
    await db.run(
      "UPDATE licenses SET status = ? WHERE product = ? AND id = ?",
      "disabled",
      "djdl",
      r1.licenseId,
    );
    const disabled = await activateFromIdentity(db, product, identity(), NOW);
    expect(disabled).toEqual({ error: "license-unusable" });

    await db.run(
      "UPDATE licenses SET status = ?, expires_at = ? WHERE product = ? AND id = ?",
      "active",
      NOW - 1,
      "djdl",
      r1.licenseId,
    );
    const expired = await activateFromIdentity(db, product, identity(), NOW);
    expect(expired).toEqual({ error: "license-unusable" });
  });

  it("enforces OIDC device limits through the shared authorizer", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    await db.run(
      "UPDATE tiers SET policy_device_limit = ? WHERE product = ? AND id = ?",
      1,
      "djdl",
      "pro",
    );
    const product = (await loadProduct(env, db, "djdl"))!;
    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    await authorizeAndMint(env, db, product, r.licenseId, "dev-1", NOW);
    await expect(
      authorizeAndMint(env, db, product, r.licenseId, "dev-2", NOW),
    ).rejects.toThrow("device_limit");
  });

  it("denies an identity whose groups grant nothing", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;
    const r = await activateFromIdentity(
      db,
      product,
      identity({ sub: "other", groups: ["randos"] }),
      NOW,
    );
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

    const req = mkReq("GET", {
      authorization: `Bearer ${token}`,
      "x-polaris-version": "1.2.3",
    });
    const trust = { [TEST_KID]: TEST_PUB };

    // The provisioning hook writes an entitlement AND a secret. Wire v3 delivers them on
    // DIFFERENT documents (§2.1/§2.2), so this pins both halves — which is also the check that
    // the split did not drop one of the two provisioned buckets on the floor.
    const licRes = await handleLicenseDocument(req, env, db, product, NOW);
    expect(licRes.status).toBe(200);
    const lic = await verifyJws<LicenseDoc>(await licRes.text(), trust);
    expect(lic!.payload.entitlements.polarisVpn?.value).toBe(true);

    const cfgRes = await handleConfigDocument(req, env, db, product, NOW);
    expect(cfgRes.status).toBe(200);
    const cfg = await verifyJws<ConfigDoc>(await cfgRes.text(), trust);
    expect(cfg!.payload.secrets["proxy.subscriptionUrl"]?.value).toBe(
      "https://vpn.polaris.rest/abc123",
    );
    expect(cfg!.payload.secrets["proxy.subscriptionUrl"]?.state).toBe("hidden");
  });
});

void TEST_PUB;
