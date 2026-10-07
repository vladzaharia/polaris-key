import { describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { ConfigDoc } from "@polaris-key/protocol/config";
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
  mergeProvisionedOverrides,
  type OidcIdentity,
} from "../src/services/identity/oidc.js";
import type { Db } from "../src/db/types.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { handleConfigDocument } from "../src/services/config/document.js";
import type { Env } from "../src/env.js";
import { subjectFor } from "../src/core/accountSubjects.js";
import {
  runOverrideMigration,
  setOverrideMigrationPrerequisite,
  startOverrideMigrationNotice,
} from "../src/core/overrideMigration.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";

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
      members: { role: "user", tier: "pro" },
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
    "vpnSub",
    "polarisVpn",
    JSON.stringify(true),
    "proxy.subscriptionUrl",
    "https://vpn.example.com/{claim}",
    JSON.stringify(["vpn.example.com"]),
  );
}

/** LX-08: the entries of a licence's `oidc` grant, as the licence document's layer reads them. */
async function oidcGrantEntries(
  db: Db,
  licenseId: string,
): Promise<
  Record<string, { state: string; value: unknown; updatedAt: number }>
> {
  const rows = await db.all<{
    key: string;
    value_json: string;
    state: string;
    updated_at: number;
  }>(
    `SELECT key, value_json, state, updated_at FROM grant_entitlements
      WHERE product = 'djdl' AND grant_id = ? ORDER BY key`,
    `grt_oidc_${licenseId}`,
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.key,
      {
        state: r.state,
        value: JSON.parse(r.value_json),
        updatedAt: r.updated_at,
      },
    ]),
  );
}

const identity = (over: Partial<OidcIdentity> = {}): OidcIdentity => ({
  sub: "user-123",
  email: "ada@example.com",
  name: "Ada Lovelace",
  groups: ["members"],
  claims: { sub: "user-123", vpnSub: "abc123" },
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

  it("records origin 'oidc' on a freshly inserted license (S-16 G14)", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;

    const r = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r)) throw new Error("expected license");
    const row = await db.first<{ origin: string; modified_by: string }>(
      "SELECT origin, modified_by FROM licenses WHERE product = ? AND id = ?",
      "djdl",
      r.licenseId,
    );
    expect(row?.origin).toBe("oidc");
    expect(row?.modified_by).toBe("oidc");
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
        claims: { sub: "user-123", vpnSub: "next-sub" },
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
    // LX-02: a sign-in on an existing licence does not renew its term.
    expect(row?.expires_at).toBe(NOW + 365 * 86400);
    const overrides = JSON.parse(row!.overrides_json) as {
      secrets: Record<string, { value: string }>;
    };
    expect(overrides.secrets["proxy.subscriptionUrl"]?.value).toBe(
      "https://vpn.example.com/next-sub",
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
      "x-pkey-version": "1.2.3",
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
      "https://vpn.example.com/abc123",
    );
    expect(cfg!.payload.secrets["proxy.subscriptionUrl"]?.state).toBe("hidden");
  });
});

void TEST_PUB;

// ── LX-02: sign-in on an existing licence (S-19 §4.3 G7, §7.5 Phase A, decision 12) ─────────
describe("OIDC sign-in on an existing licence (LX-02)", () => {
  type Row = {
    tier_id: string | null;
    expires_at: number | null;
    overrides_json: string;
    name: string | null;
    groups_json: string | null;
  };
  const readRow = (db: Db, id: string) =>
    db.first<Row>(
      "SELECT * FROM licenses WHERE product = ? AND id = ?",
      "djdl",
      id,
    );
  type Stored = {
    config: Record<string, { value: unknown }>;
    secrets: Record<string, { value: unknown }>;
    entitlements: Record<string, { value: unknown }>;
  } & Record<string, unknown>;

  async function setup() {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    await seedProduct(db, "djdl");
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;
    return { db, product };
  }

  async function writeOverrides(db: Db, id: string, overrides: unknown) {
    await db.run(
      "UPDATE licenses SET overrides_json = ? WHERE product = ? AND id = ?",
      JSON.stringify(overrides),
      "djdl",
      id,
    );
  }

  // LX-08 (S-19 §7.14 step 4): provisioned ENTITLEMENT keys are the licence's `oidc` grant, not
  // override keys; the column keeps the declared secrets (until U-03's run) and operator keys.
  const grantEntries = oidcGrantEntries;

  it("a trial licence's expires_at does not move on sign-in, so the trial ends", async () => {
    const { db, product } = await setup();
    await db.run(
      "UPDATE tiers SET policy_expiry_days = 14 WHERE product = 'djdl' AND id = 'pro'",
    );
    const r1 = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r1)) throw new Error("expected license");
    const trialEnd = NOW + 14 * 86400;
    expect((await readRow(db, r1.licenseId))?.expires_at).toBe(trialEnd);

    // Signing in again on day 10 used to push the end out to day 24 (endless trials).
    const r2 = await activateFromIdentity(
      db,
      product,
      identity(),
      NOW + 10 * 86400,
    );
    expect(r2).toEqual(r1);
    expect((await readRow(db, r1.licenseId))?.expires_at).toBe(trialEnd);

    // After the end the licence is unusable and sign-in does not revive it.
    const late = await activateFromIdentity(
      db,
      product,
      identity(),
      trialEnd + 1,
    );
    expect(late).toEqual({ error: "license-unusable" });
    expect((await readRow(db, r1.licenseId))?.expires_at).toBe(trialEnd);
  });

  it("does not change tier_id on an existing licence, even when the groups map elsewhere", async () => {
    const { db, product } = await setup();
    await db.run(
      "INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days, policy_device_limit, modified_by, modified_at) VALUES (?,?,?,?,?,?,?,?)",
      "djdl",
      "basic",
      "Basic",
      null,
      null,
      1,
      null,
      NOW,
    );
    const r1 = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r1)) throw new Error("expected license");
    // An operator moves the licence to `basic` with no expiry.
    await db.run(
      "UPDATE licenses SET tier_id = 'basic', expires_at = NULL WHERE product = 'djdl' AND id = ?",
      r1.licenseId,
    );
    await activateFromIdentity(
      db,
      product,
      identity({ name: "Ada Renamed", groups: ["members", "admin"] }),
      NOW + 60,
    );
    const row = await readRow(db, r1.licenseId);
    expect(row?.tier_id).toBe("basic");
    expect(row?.expires_at).toBeNull();
    // The identity-owned fields still follow the provider.
    expect(row?.name).toBe("Ada Renamed");
    expect(JSON.parse(row!.groups_json!)).toEqual(["members", "admin"]);
  });

  it("an operator override of an undeclared key survives sign-in; declared keys are rewritten", async () => {
    const { db, product } = await setup();
    const r1 = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r1)) throw new Error("expected license");
    const before = JSON.parse(
      (await readRow(db, r1.licenseId))!.overrides_json,
    ) as Stored;
    await writeOverrides(db, r1.licenseId, {
      config: {
        "ui.theme": { state: "enforced", value: "dark", updatedAt: 1 },
      },
      secrets: {
        ...before.secrets,
        "api.token": {
          state: "hidden",
          value: { sealed: "v1.opaque-envelope" },
          updatedAt: 1,
        },
      },
      entitlements: {
        ...before.entitlements,
        betaAccess: { state: "enforced", value: true, updatedAt: 1 },
        deviceLimit: { state: "enforced", value: 9, updatedAt: 1 },
      },
    });

    await activateFromIdentity(
      db,
      product,
      identity({ claims: { sub: "user-123", vpnSub: "rotated" } }),
      NOW + 60,
    );
    const after = JSON.parse(
      (await readRow(db, r1.licenseId))!.overrides_json,
    ) as Stored;
    // Undeclared keys of every kind survive as stored.
    expect(after.config["ui.theme"]?.value).toBe("dark");
    expect(after.secrets["api.token"]?.value).toEqual({
      sealed: "v1.opaque-envelope",
    });
    expect(after.entitlements.betaAccess?.value).toBe(true);
    expect(after.entitlements.deviceLimit?.value).toBe(9);
    // Declared keys follow the current claim: the entitlement on the licence's `oidc` grant
    // (LX-08), never in the column.
    expect(after.entitlements.polarisVpn).toBeUndefined();
    expect((await grantEntries(db, r1.licenseId)).polarisVpn).toEqual({
      state: "enforced",
      value: true,
      updatedAt: NOW + 60,
    });
    expect(after.secrets["proxy.subscriptionUrl"]?.value).toBe(
      "https://vpn.example.com/rotated",
    );
  });

  it("removes a declared key when its claim disappears, keeping undeclared keys", async () => {
    const { db, product } = await setup();
    const r1 = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r1)) throw new Error("expected license");
    const before = JSON.parse(
      (await readRow(db, r1.licenseId))!.overrides_json,
    ) as Stored;
    expect(before.entitlements.polarisVpn).toBeUndefined();
    expect((await grantEntries(db, r1.licenseId)).polarisVpn?.value).toBe(true);
    expect(before.secrets["proxy.subscriptionUrl"]).toBeDefined();
    await writeOverrides(db, r1.licenseId, {
      ...before,
      entitlements: {
        ...before.entitlements,
        betaAccess: { state: "enforced", value: true, updatedAt: 1 },
      },
    });

    // The provider no longer sends `vpnSub`: revocation on claim loss.
    await activateFromIdentity(
      db,
      product,
      identity({ claims: { sub: "user-123" } }),
      NOW + 60,
    );
    const after = JSON.parse(
      (await readRow(db, r1.licenseId))!.overrides_json,
    ) as Stored;
    expect(after.entitlements.polarisVpn).toBeUndefined();
    expect((await grantEntries(db, r1.licenseId)).polarisVpn).toBeUndefined();
    expect(after.secrets["proxy.subscriptionUrl"]).toBeUndefined();
    expect(after.entitlements.betaAccess?.value).toBe(true);
  });

  it("re-merges instead of overwriting an operator edit that lands between the read and the write", async () => {
    const { db, product } = await setup();
    const r1 = await activateFromIdentity(db, product, identity(), NOW);
    if (!("licenseId" in r1)) throw new Error("expected license");
    let injected = false;
    // The compare-and-set rides one batch with the `oidc` grant's guarded statements (LX-08).
    const racing: Db = {
      ...db,
      all: db.all.bind(db),
      first: db.first.bind(db),
      run: db.run.bind(db),
      runChanges: db.runChanges.bind(db),
      async batch(statements) {
        if (
          !injected &&
          statements.some((st) => st.sql.includes("overrides_json IS ?"))
        ) {
          injected = true;
          await writeOverrides(db, r1.licenseId, {
            config: {},
            secrets: {},
            entitlements: {
              operatorEdit: { state: "enforced", value: 1, updatedAt: 2 },
            },
          });
        }
        return db.batch(statements);
      },
    };
    await activateFromIdentity(racing, product, identity(), NOW + 60);
    expect(injected).toBe(true);
    const after = JSON.parse(
      (await readRow(db, r1.licenseId))!.overrides_json,
    ) as Stored;
    expect(after.entitlements.operatorEdit?.value).toBe(1);
    expect((await grantEntries(db, r1.licenseId)).polarisVpn?.value).toBe(true);
  });

  it("mergeProvisionedOverrides keeps unknown members and treats an unparseable column as empty", () => {
    const provisioned = {
      config: {},
      secrets: {},
      entitlements: {
        vpn: { state: "enforced" as const, value: true, updatedAt: 5 },
      },
    };
    const declared = {
      entitlements: new Set(["vpn", "gone"]),
      secrets: new Set(["s"]),
    };
    const merged = JSON.parse(
      mergeProvisionedOverrides(
        JSON.stringify({
          extra: { keep: 1 },
          config: { c: { state: "enforced", value: 1, updatedAt: 1 } },
          secrets: { s: { state: "hidden", value: "old", updatedAt: 1 } },
          entitlements: {
            gone: { state: "enforced", value: true, updatedAt: 1 },
          },
        }),
        provisioned,
        declared,
      ),
    ) as Stored;
    expect(merged.extra).toEqual({ keep: 1 });
    expect(merged.config.c?.value).toBe(1);
    expect(merged.secrets).toEqual({});
    expect(merged.entitlements).toEqual({
      vpn: { state: "enforced", value: true, updatedAt: 5 },
    });
    expect(
      JSON.parse(mergeProvisionedOverrides("{not json", provisioned, declared)),
    ).toEqual({
      config: {},
      secrets: {},
      entitlements: provisioned.entitlements,
    });
    expect(
      JSON.parse(mergeProvisionedOverrides(null, provisioned, declared)),
    ).toEqual({
      config: {},
      secrets: {},
      entitlements: provisioned.entitlements,
    });
  });
});

// ── U-03: provisioned secrets follow the account override layer from the migration's run on ──
describe("OIDC provisioning after the licence-override migration (U-03; S-19 §8 U-03 row)", () => {
  it("the run moves the provisioned secret to the owner's row, and later sign-ins write it there, sealed", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.EMAIL = { send: async () => {} } as unknown as Env["EMAIL"];
    await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;
    const r = await activateFromIdentity(db, product, identity(), NOW, { env });
    if (!("licenseId" in r)) throw new Error("expected license");
    const ada = await signIn(
      db,
      { issuerKey: "email", subject: "ada@example.com", kind: "email" },
      NOW,
    );
    if (ada.status !== "signed_in") throw new Error(ada.status);
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = 'djdl' AND id = ?",
      ada.account.id,
      r.licenseId,
    );
    const token = await authorizeAndMint(
      env,
      db,
      product,
      r.licenseId,
      "dev-oidc",
      NOW,
    );
    const secretOf = async (now: number) => {
      const res = await handleConfigDocument(
        mkReq("GET", {
          authorization: `Bearer ${token}`,
          "x-pkey-version": "1.2.3",
        }),
        env,
        db,
        product,
        now,
      );
      const cfg = await verifyJws<ConfigDoc>(await res.text(), {
        [TEST_KID]: TEST_PUB,
      });
      return cfg!.payload.secrets["proxy.subscriptionUrl"]?.value;
    };
    expect(await secretOf(NOW)).toBe("https://vpn.example.com/abc123");

    const actor = { sub: "op", name: null, email: null };
    const runAt = NOW + 31 * 86_400;
    await setOverrideMigrationPrerequisite(db, "loginCard", true, actor, NOW);
    await setOverrideMigrationPrerequisite(db, "library", true, actor, NOW);
    await startOverrideMigrationNotice(db, actor, NOW);
    const run = await runOverrideMigration(env, db, actor, runAt);
    expect(run.ok && run.progress.done).toBe(true);
    // Moved, and sealed on the way (the licence column held it in plaintext).
    expect(await secretOf(runAt)).toBe("https://vpn.example.com/abc123");
    const subject = await subjectFor(db, ada.account.id, "djdl", NOW);
    const accountRow = () =>
      db.first<{ payload_json: string }>(
        "SELECT payload_json FROM account_overrides WHERE product = 'djdl' AND subject = ?",
        subject,
      );
    expect((await accountRow())!.payload_json).not.toContain("vpn.example.com");

    // A later sign-in with a new claim writes the owner's row, not the licence.
    const again = await activateFromIdentity(
      db,
      product,
      identity({ claims: { sub: "user-123", vpnSub: "next" } }),
      runAt,
      { env },
    );
    expect("licenseId" in again).toBe(true);
    expect(await secretOf(runAt)).toBe("https://vpn.example.com/next");
    const lic = await db.first<{ overrides_json: string }>(
      "SELECT overrides_json FROM licenses WHERE product = 'djdl' AND id = ?",
      r.licenseId,
    );
    const stored = JSON.parse(lic!.overrides_json) as {
      secrets: Record<string, unknown>;
      entitlements: Record<string, unknown>;
    };
    expect(stored.secrets).toEqual({});
    // LX-08: the provisioned entitlement is the licence's `oidc` grant.
    expect(stored.entitlements.polarisVpn).toBeUndefined();
    expect((await oidcGrantEntries(db, r.licenseId)).polarisVpn).toBeDefined();
    expect((await accountRow())!.payload_json).not.toContain("vpn.example.com");

    // The claim disappears: the declared secret leaves the owner's row too.
    await activateFromIdentity(
      db,
      product,
      identity({ claims: { sub: "user-123" } }),
      runAt,
      { env },
    );
    expect(await secretOf(runAt)).toBeUndefined();
  });
});

describe("OIDC claim of an enrolled licence after the migration's run (U-03, N8)", () => {
  it("clears a declared secret whose claim is absent from the owner's row, keeping an operator's keys", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.EMAIL = { send: async () => {} } as unknown as Env["EMAIL"];
    await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;
    const ada = await signIn(
      db,
      { issuerKey: "email", subject: "ada@example.com", kind: "email" },
      NOW,
    );
    if (ada.status !== "signed_in") throw new Error(ada.status);
    // An anonymous enrolled licence that Ada's account already owns.
    await db.run(
      `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id, activated_at,
         expires_at, max_offline_days, overrides_json, channels_json, min_version, max_version,
         origin, account_id, modified_by, modified_at)
       VALUES ('djdl', 'lic-enrolled', 'active', NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL,
         '{"config":{},"secrets":{},"entitlements":{}}', NULL, NULL, NULL, 'enroll', ?, NULL, ?)`,
      NOW,
      ada.account.id,
      NOW,
    );
    const subject = await subjectFor(db, ada.account.id, "djdl", NOW);
    await db.run(
      `INSERT INTO account_overrides (product, subject, payload_json, updated_at, updated_by)
       VALUES ('djdl', ?, ?, ?, 'signin')`,
      subject,
      JSON.stringify({
        config: {},
        secrets: {
          "proxy.subscriptionUrl": {
            state: "hidden",
            value: "https://vpn.example.com/stale",
            updatedAt: NOW,
          },
          "operator.key": { state: "hidden", value: "kept", updatedAt: NOW },
        },
      }),
      NOW,
    );
    const actor = { sub: "op", name: null, email: null };
    const runAt = NOW + 31 * 86_400;
    await setOverrideMigrationPrerequisite(db, "loginCard", true, actor, NOW);
    await setOverrideMigrationPrerequisite(db, "library", true, actor, NOW);
    await startOverrideMigrationNotice(db, actor, NOW);
    expect((await runOverrideMigration(env, db, actor, runAt)).ok).toBe(true);

    // The identity signs in WITHOUT the claim the secret's hook reads, claiming the enrolled row.
    const r = await activateFromIdentity(
      db,
      product,
      identity({ claims: { sub: "user-123" } }),
      runAt,
      { enrolledLicenseId: "lic-enrolled", env },
    );
    expect(r).toMatchObject({ licenseId: "lic-enrolled", merged: "claimed" });
    const row = await db.first<{ payload_json: string }>(
      "SELECT payload_json FROM account_overrides WHERE product = 'djdl' AND subject = ?",
      subject,
    );
    const secrets = (
      JSON.parse(row!.payload_json) as { secrets: Record<string, unknown> }
    ).secrets;
    expect(Object.keys(secrets)).toEqual(["operator.key"]);
  });
});
