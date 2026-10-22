import { describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  DJDL_CATALOG,
  makeEnv,
  mkReq,
  NOW,
  seedProduct,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import {
  activateFromIdentity,
  authorizeAndMint,
  type OidcIdentity,
} from "../src/services/identity/oidc.js";
import { handleConfigDocument } from "../src/services/config/document.js";
import { handleLicenseDocument } from "../src/services/license/document.js";
import { subjectFor } from "../src/core/accounts/accountSubjects.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import {
  isSealedEnvelope,
  openManagedValue,
} from "../src/core/managedSecrets.js";
import { provisionedSecretTarget } from "../src/core/licensing/provisioning.js";
import { issueAccountLicense } from "../src/core/licensing/issueAccount.js";
import { applyProvisionedAccountSecrets } from "../src/core/accounts/accountOverrides.js";
import type { Env } from "../src/platform/env.js";

const SECRET = "proxy.subscriptionUrl";
const KEYS = { [TEST_KID]: TEST_PUB };

const identity = (claims: Record<string, unknown> = { vpnSub: "abc123" }) =>
  ({
    sub: "user-123",
    email: "ada@example.com",
    name: "Ada Lovelace",
    groups: ["members"],
    claims: { sub: "user-123", ...claims },
  }) satisfies OidcIdentity;

type Db = ReturnType<typeof makeTestDb>;

async function seedOidc(db: Db): Promise<void> {
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    "djdl",
    "custom",
    "https://id.example",
    "client-djdl",
    null,
    JSON.stringify(["https://key.plrs.im/djdl/identity/auth/callback"]),
    JSON.stringify({ members: { role: "user", tier: "pro" } }),
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
    SECRET,
    "https://vpn.example.com/{claim}",
    JSON.stringify(["vpn.example.com"]),
  );
}

async function linkOidc(db: Db, accountId: string, id = "lnk"): Promise<void> {
  await db.run(
    `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified, display_name, amr_json, created_at, last_used_at)
     VALUES (?, ?, 'iss', '', 'user-123', 'oidc', NULL, 0, NULL, '[]', ?, ?)`,
    id,
    accountId,
    NOW,
    NOW,
  );
}

async function accountOf(db: Db, email: string) {
  const r = await signIn(
    db,
    { issuerKey: "email", subject: email, kind: "email" },
    NOW,
    { unfenced: true },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  return r.account;
}

type Kind = "unowned" | "ownedLinked" | "ownedUnlinked";

async function scenario(kind: Kind) {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.EMAIL = { send: async () => {} } as unknown as Env["EMAIL"];
  await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
  await seedOidc(db);
  const product = (await loadProduct(env, db, "djdl"))!;
  // First sign-in: the licence has no owner yet, so the secret is in the column.
  const first = await activateFromIdentity(db, product, identity(), NOW, {
    env,
  });
  if (!("licenseId" in first)) throw new Error("expected license");
  const licenseId = first.licenseId;
  const ada = await accountOf(db, "ada@example.com");
  let subject: string | null = null;
  if (kind !== "unowned") {
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = 'djdl' AND id = ?",
      ada.id,
      licenseId,
    );
    subject = await subjectFor(db, ada.id, "djdl", NOW);
    if (kind === "ownedLinked") await linkOidc(db, ada.id);
  }
  // An operator's own secret key stays in the column either way.
  const col = await db.first<{ overrides_json: string }>(
    "SELECT overrides_json FROM licenses WHERE product = 'djdl' AND id = ?",
    licenseId,
  );
  const parsed = JSON.parse(col!.overrides_json);
  parsed.secrets["operator.key"] = {
    state: "hidden",
    value: "kept",
    updatedAt: NOW,
  };
  await db.run(
    "UPDATE licenses SET overrides_json = ? WHERE product = 'djdl' AND id = ?",
    JSON.stringify(parsed),
    licenseId,
  );
  const token = await authorizeAndMint(env, db, product, licenseId, "dev", NOW);
  if (subject)
    await db.run(
      "UPDATE devices SET subject = ? WHERE product = 'djdl' AND device_id = 'dev'",
      subject,
    );
  const sign = (claims?: Record<string, unknown>, now = NOW + 60) =>
    activateFromIdentity(db, product, identity(claims), now, { env });
  const docs = async (now: number) => {
    const headers = {
      authorization: `Bearer ${token}`,
      "x-pkey-version": "1.2.3",
    };
    const cfg = await verifyJws<ConfigDoc>(
      await (
        await handleConfigDocument(mkReq("GET", headers), env, db, product, now)
      ).text(),
      KEYS,
    );
    const lic = await verifyJws<LicenseDoc>(
      await (
        await handleLicenseDocument(
          mkReq("GET", headers),
          env,
          db,
          product,
          now,
        )
      ).text(),
      KEYS,
    );
    return { cfg: cfg!.payload, lic: lic!.payload };
  };
  const columnSecrets = async () =>
    (
      JSON.parse(
        (await db.first<{ overrides_json: string }>(
          "SELECT overrides_json FROM licenses WHERE product = 'djdl' AND id = ?",
          licenseId,
        ))!.overrides_json,
      ) as { secrets: Record<string, { value: unknown }> }
    ).secrets;
  const accountRow = async () =>
    subject
      ? await db.first<{ payload_json: string }>(
          "SELECT payload_json FROM account_overrides WHERE product = 'djdl' AND subject = ?",
          subject,
        )
      : null;
  return {
    db,
    env,
    product,
    licenseId,
    ada,
    docs,
    sign,
    columnSecrets,
    accountRow,
  };
}

/** The part of a delivered document that does not name the licence or the device. */
const content = (d: { cfg: ConfigDoc; lic: LicenseDoc }) =>
  JSON.stringify({
    config: d.cfg.config,
    secrets: d.cfg.secrets,
    entitlements: d.lic.entitlements,
  });

describe("provisioned secret target per licence (U-27.2, L-U1)", () => {
  it("an owned licence whose owner is linked: the account row holds the secret sealed under the managed-secret AAD, the column drops the declared key and keeps the operator's", async () => {
    const s = await scenario("ownedLinked");
    expect(Object.keys(await s.columnSecrets()).sort()).toEqual([
      "operator.key",
      SECRET,
    ]);
    await s.sign();
    expect(Object.keys(await s.columnSecrets())).toEqual(["operator.key"]);
    const row = await s.accountRow();
    expect(row).not.toBeNull();
    // Nothing in the clear at rest.
    expect(row!.payload_json).not.toContain("vpn.example.com");
    const stored = (
      JSON.parse(row!.payload_json) as {
        secrets: Record<string, { value: string }>;
      }
    ).secrets[SECRET]!.value;
    expect(isSealedEnvelope(stored)).toBe(true);
    // Round trip: it opens under the same (product, key) AAD the column uses, to the
    // interpolated claim.
    expect(await openManagedValue(s.env, "djdl", SECRET, stored)).toBe(
      "https://vpn.example.com/abc123",
    );
    // And it does not open under another key's AAD.
    expect(
      await openManagedValue(s.env, "djdl", "other.key", stored),
    ).toBeNull();
    // Entitlements stay on the oidc grant.
    const grant = await s.db.all<{ key: string }>(
      "SELECT key FROM grant_entitlements WHERE product = 'djdl' AND grant_id = ?",
      `grt_oidc_${s.licenseId}`,
    );
    expect(grant.map((g) => g.key)).toEqual(["polarisVpn"]);
    // A claim that disappears revokes it from the account row, the operator key stays.
    await s.sign({});
    // (an empty row is deleted, so absent or without the key both mean revoked)
    const gone = await s.accountRow();
    if (gone) expect(gone.payload_json).not.toContain(SECRET);
    expect(Object.keys(await s.columnSecrets())).toEqual(["operator.key"]);
  });

  it("a floating licence keeps the secret in the column", async () => {
    const s = await scenario("unowned");
    await s.sign();
    const secrets = await s.columnSecrets();
    expect(Object.keys(secrets).sort()).toEqual(["operator.key", SECRET]);
    expect(isSealedEnvelope(secrets[SECRET]!.value)).toBe(true);
    expect(
      await openManagedValue(s.env, "djdl", SECRET, secrets[SECRET]!.value),
    ).toBe("https://vpn.example.com/abc123");
    const rows = await s.db.all(
      "SELECT 1 FROM account_overrides WHERE product = 'djdl'",
    );
    expect(rows).toHaveLength(0);
  });

  it("an owned licence whose signing identity is not linked to the owner writes nothing to the owner's row", async () => {
    const s = await scenario("ownedUnlinked");
    await s.sign();
    expect(Object.keys(await s.columnSecrets()).sort()).toEqual([
      "operator.key",
      SECRET,
    ]);
    expect(await s.accountRow()).toBeNull();
  });

  it("a handed-over licence takes nothing from the previous owner's sign-in", async () => {
    const s = await scenario("ownedLinked");
    const bob = await accountOf(s.db, "bob@example.com");
    await s.db.run(
      "UPDATE licenses SET account_id = ? WHERE product = 'djdl' AND id = ?",
      bob.id,
      s.licenseId,
    );
    await s.sign();
    const bobSubject = await subjectFor(s.db, bob.id, "djdl", NOW);
    const rows = await s.db.all(
      "SELECT 1 FROM account_overrides WHERE product = 'djdl' AND subject = ?",
      bobSubject,
    );
    expect(rows).toHaveLength(0);
    expect(Object.keys(await s.columnSecrets()).sort()).toEqual([
      "operator.key",
      SECRET,
    ]);
  });

  it("the target is the column without an owner or without a sub", async () => {
    const s = await scenario("ownedLinked");
    expect(await provisionedSecretTarget(s.db, null, "user-123")).toBe(
      "license",
    );
    expect(await provisionedSecretTarget(s.db, s.ada.id, "")).toBe("license");
    expect(await provisionedSecretTarget(s.db, s.ada.id, "someone")).toBe(
      "license",
    );
    expect(await provisionedSecretTarget(s.db, s.ada.id, "user-123")).toBe(
      "account",
    );
  });

  it("the delivered config and licence content is identical whichever layer holds the secret", async () => {
    const unowned = await scenario("unowned");
    const column = await scenario("ownedUnlinked");
    const account = await scenario("ownedLinked");
    for (const s of [unowned, column, account]) await s.sign();
    const at = NOW + 120;
    const [u, c, a] = [
      await unowned.docs(at),
      await column.docs(at),
      await account.docs(at),
    ];
    // The secret is delivered, opened, in all three.
    for (const d of [u, c, a])
      expect(d.cfg.secrets[SECRET]?.value).toBe(
        "https://vpn.example.com/abc123",
      );
    expect(content(c)).toBe(content(u));
    // The owner's device gets byte-for-byte the same content from the account row as from the
    // column (the operator key is pruned by the catalog either way).
    expect(content(a)).toBe(content(c));
  });

  it("an owned licence delivers the same signed content before and after its secret moves to the owner's row", async () => {
    // The first sign-in (in `scenario`) left the secret in the column; the second, at the same
    // `now`, moves it. The owner's device sees the same config and licence content.
    const s = await scenario("ownedLinked");
    expect(Object.keys(await s.columnSecrets())).toContain(SECRET);
    const before = await s.docs(NOW);
    await s.sign(undefined, NOW);
    expect(Object.keys(await s.columnSecrets())).not.toContain(SECRET);
    expect(await s.accountRow()).not.toBeNull();
    const after = await s.docs(NOW);
    expect(JSON.stringify(after.cfg)).toBe(JSON.stringify(before.cfg));
    expect(JSON.stringify(after.lic)).toBe(JSON.stringify(before.lic));
  });

  it("an unowned licence delivers the same signed content before and after a re-sign-in", async () => {
    const s = await scenario("unowned");
    const before = await s.docs(NOW);
    await s.sign(undefined, NOW);
    const after = await s.docs(NOW);
    expect(JSON.stringify(after.cfg)).toBe(JSON.stringify(before.cfg));
    expect(JSON.stringify(after.lic)).toBe(JSON.stringify(before.lic));
  });

  it("a licence minted for an account (issueAccountLicense) writes the linked owner's row, never the column", async () => {
    const s = await scenario("ownedLinked");
    const ada = s.ada;
    const res = await issueAccountLicense(
      s.db,
      s.product,
      ada.id,
      identity(),
      { kind: "oidc", env: s.env },
      NOW + 5,
    );
    if (!("licenseId" in res)) throw new Error("expected license");
    const col = await s.db.first<{ overrides_json: string }>(
      "SELECT overrides_json FROM licenses WHERE product = 'djdl' AND id = ?",
      res.licenseId,
    );
    expect(JSON.parse(col!.overrides_json).secrets).toEqual({});
    const row = await s.accountRow();
    expect(row!.payload_json).toContain(SECRET);
    expect(row!.payload_json).not.toContain("vpn.example.com");
  });

  it("a link from another scope with the same sub writes nothing (platform links only)", async () => {
    const s = await scenario("ownedUnlinked");
    // Same sub, but a tenant-scoped link: not the platform sign-in the owner holds.
    await s.db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified, display_name, amr_json, created_at, last_used_at)
       VALUES ('lnk-t', ?, 'iss', 'tenant-x', 'user-123', 'oidc', NULL, 0, NULL, '[]', ?, ?)`,
      s.ada.id,
      NOW,
      NOW,
    );
    expect(await provisionedSecretTarget(s.db, s.ada.id, "user-123")).toBe(
      "license",
    );
    await applyProvisionedAccountSecrets(
      s.env,
      s.db,
      "djdl",
      s.ada.id,
      { [SECRET]: { state: "default", value: "https://x", updatedAt: NOW } },
      new Set([SECRET]),
      NOW,
      "user-123",
    );
    expect(await s.accountRow()).toBeNull();
    await s.sign();
    expect(await s.accountRow()).toBeNull();
  });

  it("the claim arm on an enrolled licence owned by an account the claimer is not linked to writes nothing to the owner's row", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["djdl"]);
    env.EMAIL = { send: async () => {} } as unknown as Env["EMAIL"];
    await seedProduct(db, "djdl", { catalog: DJDL_CATALOG });
    await seedOidc(db);
    const product = (await loadProduct(env, db, "djdl"))!;
    const bob = await accountOf(db, "bob@example.com");
    await db.run(
      `INSERT INTO licenses (product, id, status, sub, name, email, groups_json, tier_id, activated_at, expires_at, max_offline_days, overrides_json, channels_json, min_version, max_version, origin, account_id, modified_by, modified_at)
       VALUES ('djdl', 'lic-enrolled', 'active', NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, '{"config":{},"secrets":{},"entitlements":{}}', NULL, NULL, NULL, 'enroll', ?, NULL, ?)`,
      NOW,
      bob.id,
      NOW,
    );
    await activateFromIdentity(
      db,
      product,
      {
        sub: "mallory-sub",
        email: "mallory@example.com",
        name: "M",
        groups: ["members"],
        claims: { sub: "mallory-sub", vpnSub: "mallory" },
      },
      NOW + 10,
      { enrolledLicenseId: "lic-enrolled", env },
    );
    expect(
      await db.all(
        "SELECT subject FROM account_overrides WHERE product = 'djdl'",
      ),
    ).toEqual([]);
  });
});
