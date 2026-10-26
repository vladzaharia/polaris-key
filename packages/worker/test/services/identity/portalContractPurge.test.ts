/**
 * I-28.1: `0141_a_portal_contract_purge.sql`, `scripts/portal-contract-check.sql` and the
 * successor `0141_b_index_assertion.sql`, rehearsed on a scratch SQLite holding every migration
 * before 0141_a. The purge deletes the four contract `portal_*` tables' rows only while the check's
 * four counts are all 0; each leftover kind alone must hold it back, and the check must name it.
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_INDEXES } from "../../../src/scheduled.js";
import { TEST_ROOT as HERE } from "../../paths.js";

const DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const PURGE = "0141_a_portal_contract_purge.sql";
const ASSERTION = "0141_b_index_assertion.sql";
const read = (...p: string[]) => readFileSync(join(HERE, "..", ...p), "utf8");
const CHECK = read("scripts", "portal-contract-check.sql");
const DOWN = read("scripts", "rollback", "0068_accounts.down.sql");
const T = 1_700_000_000;

const TABLES = [
  "portal_accounts",
  "portal_account_identities",
  "portal_account_emails",
  "portal_license_links",
] as const;

function scratch(): Database.Database {
  const raw = new Database(":memory:");
  for (const f of FILES) {
    if (f >= PURGE) break;
    raw.exec(read("migrations", f));
  }
  return raw;
}

/**
 * A clean fixture: the account model holds everything the portal tables hold, and the portal
 * tables are exactly what the 0068 down script would rebuild from it.
 */
function seedClean(raw: Database.Database): void {
  raw.exec(`
    INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
      default_max_offline_days, default_device_limit, created_at, modified_at)
      VALUES ('acme', 'acme', 'kid', 'pub', '0.0.0', '99.0.0', 30, 5, ${T}, ${T});
    INSERT INTO accounts (id, status, primary_email, display_name, created_at, modified_at)
      VALUES ('acct_a', 'active', 'a@x.test', 'Ada', ${T}, ${T}),
             ('acct_b', 'disabled', 'b@x.test', NULL, ${T}, ${T});
    INSERT INTO account_tombstones (id, deleted_at) VALUES ('acct_gone', ${T});
    INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email,
        email_verified, display_name, created_at, last_used_at)
      VALUES ('l1', 'acct_a', 'https://id.x.test', '', 'sub-a', 'oidc', 'a@x.test', 1, 'Ada', ${T}, ${T + 5}),
             ('l2', 'acct_a', 'email', '', 'a@x.test', 'email', 'a@x.test', 1, NULL, ${T}, ${T + 6}),
             ('l3', 'acct_b', 'email', '', 'b@x.test', 'email', 'b@x.test', 0, NULL, ${T}, ${T + 7});
    INSERT INTO licenses (product, id, status, activated_at, modified_at, account_id)
      VALUES ('acme', 'lic1', 'active', ${T}, ${T + 9}, 'acct_a'),
             ('acme', 'lic2', 'active', ${T}, ${T + 9}, NULL);
    -- The projection of the above, as the down script writes it.
    INSERT INTO portal_accounts (id, status, display_name, primary_email, created_at, modified_at)
      VALUES ('acct_a', 'active', 'Ada', 'a@x.test', ${T}, ${T}),
             ('acct_b', 'disabled', NULL, 'b@x.test', ${T}, ${T});
    INSERT INTO portal_account_identities (provider, subject, account_id, email, display_name,
        created_at, last_seen_at)
      VALUES ('https://id.x.test', 'sub-a', 'acct_a', 'a@x.test', 'Ada', ${T}, ${T + 5});
    INSERT INTO portal_account_emails (email, account_id, verified_at, created_at)
      VALUES ('a@x.test', 'acct_a', ${T + 6}, ${T}), ('b@x.test', 'acct_b', 0, ${T});
    INSERT INTO portal_license_links (account_id, product, license_id, source, created_at, last_seen_at)
      VALUES ('acct_a', 'acme', 'lic1', 'license-key', ${T + 9}, ${T + 9});
  `);
}

const counts = (raw: Database.Database) =>
  raw.prepare(CHECK.replace(/--[^\n]*/g, "")).get() as Record<string, number>;
const rows = (raw: Database.Database) =>
  Object.fromEntries(
    TABLES.map((t) => [
      t,
      raw.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all(),
    ]),
  );
const emptyAll = (raw: Database.Database) =>
  TABLES.every(
    (t) =>
      (raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number })
        .n === 0,
  );

const ZERO = {
  unmigrated_accounts: 0,
  identities_without_link: 0,
  emails_without_link: 0,
  unsettled_license_links: 0,
};

describe("portal contract purge", () => {
  it("purges a clean fixture and the check reads all zeros", () => {
    const raw = scratch();
    seedClean(raw);
    expect(counts(raw)).toEqual(ZERO);
    raw.exec(read("migrations", PURGE));
    expect(emptyAll(raw)).toBe(true);
    expect(counts(raw)).toEqual(ZERO);
    // The account model is untouched.
    expect(
      (raw.prepare("SELECT COUNT(*) AS n FROM account_links").get() as any).n,
    ).toBe(3);
  });

  it("a tombstoned account's rows and links to a missing licence do not hold it back", () => {
    const raw = scratch();
    seedClean(raw);
    raw.exec(`
      INSERT INTO portal_accounts (id, status, created_at, modified_at)
        VALUES ('acct_gone', 'active', ${T}, ${T});
      INSERT INTO portal_account_emails (email, account_id, verified_at, created_at)
        VALUES ('gone@x.test', 'acct_gone', ${T}, ${T});
      INSERT INTO portal_license_links (account_id, product, license_id, source, created_at, last_seen_at)
        VALUES ('acct_b', 'acme', 'deleted-licence', 'admin', ${T}, ${T});
    `);
    expect(counts(raw)).toEqual(ZERO);
    raw.exec(read("migrations", PURGE));
    expect(emptyAll(raw)).toBe(true);
  });

  const leftovers: Array<[keyof typeof ZERO, string]> = [
    [
      "unmigrated_accounts",
      `INSERT INTO portal_accounts (id, status, created_at, modified_at)
         VALUES ('acct_legacy', 'active', ${T}, ${T})`,
    ],
    [
      "identities_without_link",
      `INSERT INTO portal_account_identities (provider, subject, account_id, created_at, last_seen_at)
         VALUES ('https://id.x.test', 'sub-orphan', 'acct_b', ${T}, ${T})`,
    ],
    [
      "emails_without_link",
      `INSERT INTO portal_account_emails (email, account_id, verified_at, created_at)
         VALUES ('orphan@x.test', 'acct_b', ${T}, ${T})`,
    ],
    [
      "unsettled_license_links",
      // lic2 is floating; lic1 is held by acct_a, so acct_b's link to it is unsettled too.
      `INSERT INTO portal_license_links (account_id, product, license_id, source, created_at, last_seen_at)
         VALUES ('acct_b', 'acme', 'lic2', 'email', ${T}, ${T})`,
    ],
  ];
  for (const [kind, insert] of leftovers) {
    it(`a ${kind} leftover alone deletes nothing, and the check names it`, () => {
      const raw = scratch();
      seedClean(raw);
      raw.exec(insert);
      const before = rows(raw);
      expect(counts(raw)).toEqual({ ...ZERO, [kind]: 1 });
      raw.exec(read("migrations", PURGE));
      expect(rows(raw)).toEqual(before);
    });
  }

  it("an email of account A linked only to account B blocks the purge", () => {
    const raw = scratch();
    seedClean(raw);
    raw.exec(
      `INSERT INTO portal_account_emails (email, account_id, verified_at, created_at)
         VALUES ('shared@x.test', 'acct_a', ${T}, ${T})`,
    );
    raw.exec(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
         email_verified, created_at, last_used_at)
       VALUES ('l9', 'acct_b', 'email', '', 'shared@x.test', 'email', 1, ${T}, ${T})`,
    );
    expect(counts(raw)).toEqual({ ...ZERO, emails_without_link: 1 });
    const before = rows(raw);
    raw.exec(read("migrations", PURGE));
    expect(rows(raw)).toEqual(before);
  });

  it("a link to a licence held by another account is an unsettled leftover", () => {
    const raw = scratch();
    seedClean(raw);
    raw.exec(
      `INSERT INTO portal_license_links (account_id, product, license_id, source, created_at, last_seen_at)
         VALUES ('acct_b', 'acme', 'lic1', 'email', ${T}, ${T})`,
    );
    expect(counts(raw)).toEqual({ ...ZERO, unsettled_license_links: 1 });
    const before = rows(raw);
    raw.exec(read("migrations", PURGE));
    expect(rows(raw)).toEqual(before);
  });

  it("a replay is a no-op, and finishes a half-applied run", () => {
    const raw = scratch();
    seedClean(raw);
    raw.exec(read("migrations", PURGE));
    raw.exec(read("migrations", PURGE));
    expect(emptyAll(raw)).toBe(true);

    // A run that died after the first statement: replay empties the rest.
    const half = scratch();
    seedClean(half);
    half.exec("DELETE FROM portal_license_links");
    half.exec(read("migrations", PURGE));
    expect(emptyAll(half)).toBe(true);
  });

  it("purge then the 0068 down script rebuilds the portal tables from the account model", () => {
    const raw = scratch();
    seedClean(raw);
    const before = rows(raw);
    raw.exec(read("migrations", PURGE));
    expect(emptyAll(raw)).toBe(true);
    raw.exec(DOWN);
    expect(rows(raw)).toEqual(before);
    // And running the down script again changes nothing.
    raw.exec(DOWN);
    expect(rows(raw)).toEqual(before);
  });
});

describe("0141_b index assertion", () => {
  it("records found = expected for REQUIRED_INDEXES, without the portal contract indexes", () => {
    const raw = scratch();
    seedClean(raw);
    raw.exec(read("migrations", PURGE));
    raw.exec(read("migrations", ASSERTION));
    // This file's own list: the names the 0141_b assertion declares.
    const names = [
      ...read("migrations", ASSERTION).matchAll(/\('(idx_[a-z0-9_]+)'\)/g),
    ].map((m) => m[1]!);
    expect(
      raw
        .prepare("SELECT expected, found, missing FROM schema_index_assertion")
        .get(),
    ).toEqual({
      expected: names.length,
      found: names.length,
      missing: "",
    });
    // The newest list (REQUIRED_INDEXES) has moved on since 0141_b: it only has to cover this one.
    expect(REQUIRED_INDEXES).toEqual(expect.arrayContaining(names));
    expect(names.filter((n) => /portal_(account|license)/.test(n))).toEqual([]);
  });
});
