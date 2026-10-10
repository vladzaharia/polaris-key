/**
 * I-05's migrations (0068_a..e), rehearsed on a PRODUCTION-SHAPED copy (plans/I-04.md §6.1): the
 * database as it stands before 0068, holding portal accounts with verified and unverified emails,
 * an issuer-keyed and a pre-I-01 (`oidc`) identity, a disabled account, licences linked to several
 * accounts from different sources (the many-to-one `portal_license_links`), a platform-issuer
 * OIDC licence keyed by `sub`, a custom-issuer `sub`-only licence and authorized devices. Then:
 *
 *   - the backfill keeps every account id, copies every sign-in method, and picks ONE owner per
 *     licence by link strength (oidc > email > admin > license-key, then earliest; §8 Q1);
 *   - it is expand-only (no `portal_*` row and no licence column changes) and a replay converges;
 *   - every existing portal account and every existing OIDC licence still signs in;
 *   - the Worker's catch-up copies rows a pre-I-05 Worker wrote during the deploy window, and the
 *     Q1 settlement removes the losing links, revokes their registry tokens and reports them;
 *   - the `down` script copies back what the I-05 Worker created, so a rolled-back Worker sees it.
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db/sqlite.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { insertLicense } from "../src/core/repo.js";
import { loadProduct } from "../src/core/products.js";
import { activateFromIdentity } from "../src/services/identity/oidc.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { rekeyLegacyAccountLinks } from "../src/services/identity/accounts/repo.js";
import {
  catchUpLegacyAccounts,
  moveLicenseOwnerEndingLinks,
  settleOwnershipConflicts,
} from "../src/services/identity/accounts/legacy.js";
import {
  attachLicense,
  detachLicense,
  reassignLicense,
} from "../src/services/identity/accounts/claim.js";
import {
  deleteAccount,
  disableAccount,
  removeProductData,
} from "../src/services/identity/accounts/deletion.js";
import type { Env } from "../src/platform/env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const BEFORE = FILES.filter((f) => f < "0068");
const I05 = FILES.filter((f) => f.startsWith("0068_"));
const AFTER = FILES.filter((f) => f > "0068_z");
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");
const DOWN = readFileSync(
  join(HERE, "..", "scripts", "rollback", "0068_accounts.down.sql"),
  "utf8",
);
const ISSUER = "https://id.plrs.example";
type Ctx = { db: SqliteDb; env: Env; now: number; origin: string };

function license(
  product: string,
  id: string,
  over: { sub?: string | null; email?: string | null },
) {
  return {
    product,
    id,
    status: "active",
    sub: over.sub ?? null,
    name: null,
    email: over.email ?? null,
    groups_json: null,
    tier_id: null,
    activated_at: NOW,
    expires_at: null,
    max_offline_days: null,
    overrides_json: null,
    channels_json: null,
    min_version: null,
    max_version: null,
    modified_by: null,
    modified_at: NOW,
  };
}

/** The database at 0067, populated the way production is. */
async function productionShaped(): Promise<{
  raw: Database.Database;
  db: SqliteDb;
}> {
  const raw = new Database(":memory:");
  expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
  for (const f of BEFORE) raw.exec(sql(f));
  const db = new SqliteDb(raw);
  const run = (q: string, ...p: unknown[]) => raw.prepare(q).run(...p);

  await seedProduct(db, "acme");
  await seedProduct(db, "custom");
  run(
    `INSERT INTO oidc_config (product, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
     VALUES ('acme', ?, 'cid', NULL, NULL, ?)`,
    ISSUER,
    JSON.stringify({ staff: { role: "user" } }),
  );
  run(
    `INSERT INTO oidc_config (product, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json, provider)
     VALUES ('custom', 'https://idp.custom.example', 'cid', NULL, NULL, '{}', 'custom')`,
  );

  // acct_1: a platform-IdP user with a verified email. acct_2: a pre-I-01 identity row (the
  // literal 'oidc', which 0059's trigger now refuses on insert, so it is rewritten after).
  // acct_3: a disabled email-only account with an UNVERIFIED address.
  for (const [id, status, email] of [
    ["acct_1", "active", "ada@example.com"],
    ["acct_2", "active", "bob@example.com"],
    ["acct_3", "disabled", "cy@example.com"],
  ] as const) {
    run(
      `INSERT INTO portal_accounts (id, status, display_name, primary_email, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      status,
      id,
      email,
      NOW - 1000,
      NOW - 1000,
    );
  }
  run(
    `INSERT INTO portal_account_emails (email, account_id, verified_at, created_at) VALUES
       ('ada@example.com', 'acct_1', ?, ?), ('bob@example.com', 'acct_2', ?, ?),
       ('cy@example.com', 'acct_3', 0, ?)`,
    NOW - 900,
    NOW - 900,
    NOW - 900,
    NOW - 900,
    NOW - 900,
  );
  run(
    `INSERT INTO portal_account_identities (provider, subject, account_id, email, display_name, created_at, last_seen_at)
     VALUES (?, 'user-1', 'acct_1', 'ada@example.com', 'Ada', ?, ?),
            (?, 'user-2', 'acct_2', NULL, 'Bob', ?, ?)`,
    ISSUER,
    NOW - 900,
    NOW - 800,
    ISSUER,
    NOW - 900,
    NOW - 800,
  );
  run(
    "UPDATE portal_account_identities SET provider = 'oidc' WHERE subject = 'user-2'",
  );

  // lic-1: the OIDC licence of user-1, linked by oidc to acct_1 and EARLIER by key to acct_3.
  // lic-2: linked by email to acct_2 and by admin to acct_3 (email outranks admin).
  // lic-3: linked by key to acct_1 (t=5) and acct_2 (t=3): a tie on source, the earliest wins.
  // lic-custom: a custom-issuer `sub`-only licence with no link (stays floating, §8 Q6).
  await insertLicense(
    db,
    license("acme", "lic-1", { sub: "user-1", email: "ada@example.com" }),
  );
  await insertLicense(
    db,
    license("acme", "lic-2", { email: "bob@example.com" }),
  );
  await insertLicense(db, license("acme", "lic-3", {}));
  await insertLicense(db, license("custom", "lic-custom", { sub: "user-1" }));
  for (const [acct, lic, source, at] of [
    ["acct_1", "lic-1", "oidc", NOW - 100],
    ["acct_3", "lic-1", "license-key", NOW - 500],
    ["acct_2", "lic-2", "email", NOW - 100],
    ["acct_3", "lic-2", "admin", NOW - 500],
    ["acct_1", "lic-3", "license-key", NOW - 5],
    ["acct_2", "lic-3", "license-key", NOW - 3 - 100],
  ] as const) {
    run(
      `INSERT INTO portal_license_links (account_id, product, license_id, source, created_at, last_seen_at)
       VALUES (?, 'acme', ?, ?, ?, ?)`,
      acct,
      lic,
      source,
      at,
      at,
    );
  }
  run(
    `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, token_hash)
     VALUES ('acme', 'dev-1', 'lic-1', 'authorized', ?, ?, 'th-1')`,
    NOW - 100,
    NOW - 100,
  );
  run(
    `INSERT INTO registry_tokens (product, token_id, token_hash, hint, label, scopes_json, binding,
       license_id, created_by, portal_account_id, created_at, expires_at)
     VALUES ('acme', 'rtok_loser', 'hl', 'abcd', 'cy', '["read"]', 'license', 'lic-1',
       'portal:acct_3', 'acct_3', ?, ?)`,
    NOW - 50,
    NOW + 86400,
  );
  return { raw, db };
}

function applyI05(raw: Database.Database): void {
  for (const f of [...I05, ...AFTER]) raw.exec(sql(f));
}

const portalSnapshot = (raw: Database.Database) =>
  [
    "portal_accounts",
    "portal_account_emails",
    "portal_account_identities",
    "portal_license_links",
  ].map((t) => raw.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all());

describe("migrations 0068 on a production-shaped copy", () => {
  it("keeps every account id, copies every sign-in method, and picks one owner per licence by link strength", async () => {
    const { raw } = await productionShaped();
    const portalBefore = portalSnapshot(raw);
    applyI05(raw);

    expect(
      raw
        .prepare(
          "SELECT id, status, primary_email, primary_email_verified_at FROM accounts ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "acct_1",
        status: "active",
        primary_email: "ada@example.com",
        primary_email_verified_at: NOW - 900,
      },
      {
        id: "acct_2",
        status: "active",
        primary_email: "bob@example.com",
        primary_email_verified_at: NOW - 900,
      },
      // An unverified address stays unverified.
      {
        id: "acct_3",
        status: "disabled",
        primary_email: "cy@example.com",
        primary_email_verified_at: null,
      },
    ]);
    expect(
      raw
        .prepare(
          "SELECT account_id, issuer_key, tenant_scope, subject, kind, email_verified FROM account_links ORDER BY account_id, kind, subject",
        )
        .all(),
    ).toEqual([
      {
        account_id: "acct_1",
        issuer_key: "email",
        tenant_scope: "",
        subject: "ada@example.com",
        kind: "email",
        email_verified: 1,
      },
      {
        account_id: "acct_1",
        issuer_key: ISSUER,
        tenant_scope: "",
        subject: "user-1",
        kind: "oidc",
        email_verified: 1,
      },
      {
        account_id: "acct_2",
        issuer_key: "email",
        tenant_scope: "",
        subject: "bob@example.com",
        kind: "email",
        email_verified: 1,
      },
      {
        account_id: "acct_2",
        issuer_key: "oidc",
        tenant_scope: "",
        subject: "user-2",
        kind: "oidc",
        email_verified: 0,
      },
      {
        account_id: "acct_3",
        issuer_key: "email",
        tenant_scope: "",
        subject: "cy@example.com",
        kind: "email",
        email_verified: 0,
      },
    ]);
    expect(
      raw
        .prepare(
          "SELECT product, id, account_id FROM licenses ORDER BY product, id",
        )
        .all(),
    ).toEqual([
      { product: "acme", id: "lic-1", account_id: "acct_1" }, // oidc beats an earlier key link
      { product: "acme", id: "lic-2", account_id: "acct_2" }, // email beats admin
      { product: "acme", id: "lic-3", account_id: "acct_2" }, // a tie on source: the earliest
      { product: "custom", id: "lic-custom", account_id: null }, // `sub` alone never attaches
    ]);
    const subjects = raw
      .prepare(
        "SELECT account_id, product, subject FROM account_product_subjects ORDER BY account_id",
      )
      .all() as Array<{ account_id: string; product: string; subject: string }>;
    expect(subjects.map((s) => [s.account_id, s.product])).toEqual([
      ["acct_1", "acme"],
      ["acct_2", "acme"],
    ]);
    for (const s of subjects)
      expect(s.subject).toMatch(/^ps_[A-Za-z0-9_-]{22}$/);
    // Expand-only: the portal tables a rolled-back Worker reads are untouched.
    expect(portalSnapshot(raw)).toEqual(portalBefore);
    // The new device columns exist and are empty: nothing was signed in before I-05.
    expect(raw.prepare("SELECT subject, bound_by FROM devices").all()).toEqual([
      { subject: null, bound_by: null },
    ]);

    // A replay of the backfill converges: same owners, same subjects, no duplicate links.
    raw.exec(sql("0068_e_accounts_backfill.sql"));
    raw.exec(sql("0068_a_accounts.sql"));
    expect(
      raw
        .prepare(
          "SELECT account_id, product, subject FROM account_product_subjects ORDER BY account_id",
        )
        .all(),
    ).toEqual(subjects);
    expect(
      (
        raw.prepare("SELECT COUNT(*) AS n FROM account_links").get() as {
          n: number;
        }
      ).n,
    ).toBe(5);
  });

  it("every existing portal account and every existing OIDC licence still signs in", async () => {
    const { raw, db } = await productionShaped();
    applyI05(raw);
    const env = makeEnv(new KvMock(), ["acme"]);

    // The platform-IdP user, by its issuer-keyed identity.
    const ada = await signIn(
      db,
      {
        issuerKey: ISSUER,
        subject: "user-1",
        kind: "oidc",
        email: "ada@example.com",
        emailVerified: true,
      },
      NOW,
    );
    expect(ada).toMatchObject({
      status: "signed_in",
      created: false,
      account: { id: "acct_1" },
    });
    // The pre-I-01 identity, after the Worker's re-key (the portal callback runs it first).
    await rekeyLegacyAccountLinks(db, ISSUER);
    const bob = await signIn(
      db,
      { issuerKey: ISSUER, subject: "user-2", kind: "oidc" },
      NOW,
    );
    expect(bob).toMatchObject({
      status: "signed_in",
      created: false,
      account: { id: "acct_2" },
    });
    // A magic-link sign-in by a verified address.
    expect(
      await signIn(
        db,
        { issuerKey: "email", subject: "bob@example.com", kind: "email" },
        NOW,
      ),
    ).toMatchObject({ status: "signed_in", account: { id: "acct_2" } });
    // The disabled account stays refused.
    expect(
      await signIn(
        db,
        { issuerKey: "email", subject: "cy@example.com", kind: "email" },
        NOW,
      ),
    ).toEqual({ status: "refused", reason: "account_disabled" });
    expect(
      (raw.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number })
        .n,
    ).toBe(3);

    // The product-OIDC licence of user-1 is found by its subject exactly as before.
    const product = (await loadProduct(env, db, "acme"))!;
    const activated = await activateFromIdentity(
      db,
      product,
      {
        sub: "user-1",
        email: "ada@example.com",
        groups: ["staff"],
        claims: {},
      },
      NOW,
    );
    expect(activated).toEqual({ licenseId: "lic-1" });
  });

  it("the catch-up copies what a pre-I-05 Worker wrote; the Q1 settlement drops the losing links, revokes their tokens and reports them", async () => {
    const { raw, db } = await productionShaped();
    applyI05(raw);
    const env = makeEnv(new KvMock(), ["acme"]) as Env;

    // A pre-I-05 Worker, still serving, signs up a new portal user and links a licence.
    raw
      .prepare(
        `INSERT INTO portal_accounts (id, status, display_name, primary_email, created_at, modified_at)
       VALUES ('acct_late', 'active', 'Late', 'late@example.com', ?, ?)`,
      )
      .run(NOW, NOW);
    raw
      .prepare(
        `INSERT INTO portal_account_emails (email, account_id, verified_at, created_at)
       VALUES ('late@example.com', 'acct_late', ?, ?)`,
      )
      .run(NOW, NOW);
    await insertLicense(
      db,
      license("acme", "lic-late", { email: "late@example.com" }),
    );
    raw
      .prepare(
        `INSERT INTO portal_license_links (account_id, product, license_id, source, created_at, last_seen_at)
       VALUES ('acct_late', 'acme', 'lic-late', 'email', ?, ?)`,
      )
      .run(NOW, NOW);

    await catchUpLegacyAccounts(db);
    await catchUpLegacyAccounts(db); // idempotent
    expect(
      raw.prepare("SELECT id FROM accounts WHERE id = 'acct_late'").get(),
    ).toEqual({ id: "acct_late" });
    expect(
      raw
        .prepare("SELECT account_id FROM licenses WHERE id = 'lic-late'")
        .get(),
    ).toEqual({
      account_id: "acct_late",
    });
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM account_links WHERE account_id = 'acct_late'",
        )
        .get(),
    ).toEqual({ n: 1 });

    const settled = await settleOwnershipConflicts({
      db,
      env,
      now: NOW,
      origin: "",
    });
    // acct_3 lost lic-1 and lic-2; acct_1 lost lic-3.
    expect(settled).toBe(3);
    expect(
      raw
        .prepare(
          "SELECT account_id, license_id FROM portal_license_links ORDER BY license_id",
        )
        .all(),
    ).toEqual([
      { account_id: "acct_1", license_id: "lic-1" },
      { account_id: "acct_2", license_id: "lic-2" },
      { account_id: "acct_2", license_id: "lic-3" },
      { account_id: "acct_late", license_id: "lic-late" },
    ]);
    expect(
      raw
        .prepare(
          "SELECT revoked_at, revoke_reason FROM registry_tokens WHERE token_id = 'rtok_loser'",
        )
        .get(),
    ).toEqual({ revoked_at: NOW, revoke_reason: "link_removed" });
    const report = raw
      .prepare(
        "SELECT action, target_id FROM platform_audit WHERE action = 'account.license.superseded' ORDER BY target_id",
      )
      .all();
    expect(report).toEqual([
      { action: "account.license.superseded", target_id: "acme/lic-1" },
      { action: "account.license.superseded", target_id: "acme/lic-2" },
      { action: "account.license.superseded", target_id: "acme/lic-3" },
    ]);
    // Nothing is left to settle.
    expect(
      await settleOwnershipConflicts({ db, env, now: NOW, origin: "" }),
    ).toBe(0);

    // Idempotent settlement: a run that died after announcing a loser but before dropping its
    // link finishes on the next run without a second email or audit row.
    raw
      .prepare(
        `INSERT INTO portal_license_links (account_id, product, license_id, source, created_at, last_seen_at)
         VALUES ('acct_3', 'acme', 'lic-1', 'email', ?, ?)`,
      )
      .run(NOW - 10, NOW - 10);
    expect(
      await settleOwnershipConflicts({ db, env, now: NOW, origin: "" }),
    ).toBe(1);
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'account.license.superseded'",
        )
        .get(),
    ).toEqual({ n: 3 });
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM portal_license_links WHERE account_id = 'acct_3' AND license_id = 'lic-1'",
        )
        .get(),
    ).toEqual({ n: 0 });

    // The owner move ends every portal link in the same batch, and only when the move applies.
    const ctx = { db, env, now: NOW, origin: "" };
    expect(
      await moveLicenseOwnerEndingLinks(ctx, "acme", "lic-1", "acct_2", null),
    ).toBe(false);
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM portal_license_links WHERE license_id = 'lic-1'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(
      await moveLicenseOwnerEndingLinks(ctx, "acme", "lic-1", "acct_1", null),
    ).toBe(true);
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM portal_license_links WHERE license_id = 'lic-1'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      raw
        .prepare(
          "SELECT account_id FROM licenses WHERE product = 'acme' AND id = 'lic-1'",
        )
        .get(),
    ).toEqual({ account_id: null });
  });

  // Review fix: a removal path that clears the owner pointer must not leave another account's
  // unsettled portal link behind, or the scheduled catch-up hands the floating licence to it.
  for (const [name, clear] of [
    [
      "detach",
      (ctx: Ctx) =>
        detachLicense(ctx, {
          accountId: "acct_1",
          product: "acme",
          licenseId: "lic-1",
        }),
    ],
    [
      "relink to nobody",
      (ctx: Ctx) =>
        reassignLicense(ctx, {
          product: "acme",
          licenseId: "lic-1",
          toAccountId: null,
          actor: "admin:test",
        }),
    ],
    [
      "per-product removal with detach",
      (ctx: Ctx) =>
        removeProductData(ctx, {
          accountId: "acct_1",
          product: "acme",
          alsoDetachLicenses: true,
        }),
    ],
    ["account deletion", (ctx: Ctx) => deleteAccount(ctx, "acct_1")],
  ] as const) {
    it(`after ${name}, the catch-up never re-points the floating licence at an unsettled Q1 loser`, async () => {
      const { raw, db } = await productionShaped();
      applyI05(raw);
      const env = makeEnv(new KvMock(), ["acme"]) as Env;
      const ctx: Ctx = { db, env, now: NOW, origin: "" };
      const owner = () =>
        raw
          .prepare(
            "SELECT account_id FROM licenses WHERE product = 'acme' AND id = 'lic-1'",
          )
          .get();
      // The migration picked acct_1; acct_3's key link is not settled yet (no nightly run).
      expect(owner()).toEqual({ account_id: "acct_1" });

      await clear(ctx);
      expect(owner()).toEqual({ account_id: null });
      await catchUpLegacyAccounts(db);
      expect(owner()).toEqual({ account_id: null });

      // acct_3 got the loser handling inline: its link went, its token stopped, it was reported.
      expect(
        raw
          .prepare(
            "SELECT account_id FROM portal_license_links WHERE product = 'acme' AND license_id = 'lic-1'",
          )
          .all(),
      ).toEqual([]);
      expect(
        raw
          .prepare(
            "SELECT revoked_at FROM registry_tokens WHERE token_id = 'rtok_loser'",
          )
          .get(),
      ).toEqual({ revoked_at: NOW });
      expect(
        raw
          .prepare(
            "SELECT target_id FROM platform_audit WHERE action = 'account.license.superseded'",
          )
          .all(),
      ).toEqual([{ target_id: "acme/lic-1" }]);
    });
  }

  it("a disable reaches the portal tables, and the down script re-applies one", async () => {
    const { raw, db } = await productionShaped();
    applyI05(raw);
    const env = makeEnv(new KvMock(), ["acme"]) as Env;
    const status = (id: string) =>
      raw.prepare("SELECT status FROM portal_accounts WHERE id = ?").get(id);
    await disableAccount({ db, env, now: NOW, origin: "" }, "acct_1");
    expect(status("acct_1")).toEqual({ status: "disabled" });
    // A disable whose mirror is missing (written before the fix) is re-applied by the down script.
    raw.exec("UPDATE accounts SET status = 'disabled' WHERE id = 'acct_2'");
    raw.exec(DOWN);
    expect(status("acct_2")).toEqual({ status: "disabled" });
  });

  it("the down script copies back what the I-05 Worker created, so a rolled-back Worker sees it", async () => {
    const { raw, db } = await productionShaped();
    applyI05(raw);
    const env = makeEnv(new KvMock(), ["acme"]);
    await seedProduct(db, "fresh");
    await insertLicense(db, license("fresh", "lic-new", {}));

    // Under I-05: a new account signs up, and attaches a licence.
    const created = await signIn(
      db,
      {
        issuerKey: ISSUER,
        subject: "user-9",
        kind: "oidc",
        email: "new@example.com",
        emailVerified: true,
      },
      NOW,
    );
    if (created.status !== "signed_in") throw new Error("sign-in failed");
    await attachLicense(
      { db, env, now: NOW, origin: "" },
      {
        accountId: created.account.id,
        product: "fresh",
        licenseId: "lic-new",
        via: "key",
      },
    );

    raw.exec(DOWN);
    raw.exec(DOWN); // idempotent

    // What the pre-I-05 Worker reads to sign this person in and list their licences.
    expect(
      raw
        .prepare(
          `SELECT a.id FROM portal_account_identities i JOIN portal_accounts a ON a.id = i.account_id
            WHERE i.provider = ? AND i.subject = 'user-9'`,
        )
        .get(ISSUER),
    ).toEqual({ id: created.account.id });
    expect(
      raw
        .prepare(
          "SELECT account_id FROM portal_account_emails WHERE email = 'new@example.com'",
        )
        .get(),
    ).toEqual({ account_id: created.account.id });
    expect(
      raw
        .prepare(
          "SELECT product, license_id FROM portal_license_links WHERE account_id = ?",
        )
        .all(created.account.id),
    ).toEqual([{ product: "fresh", license_id: "lic-new" }]);
    // Existing portal rows are unchanged by the down script (it adds, and re-applies a disable).
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM portal_accounts").get(),
    ).toEqual({ n: 4 });
  });
});
