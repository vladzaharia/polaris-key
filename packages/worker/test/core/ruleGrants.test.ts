/**
 * Per-request evaluation of the `console.access` rules (ST-28 plan §2.4, §10; ST-32.3).
 *
 * `resolvePrincipal` appends `source: "rule"` grants from the account's strong OIDC links through
 * operator connections. Pinned here:
 *   - the preview and sign-in answer from the one `evaluate` call;
 *   - an address confirmed only by an email code never matches a domain rule;
 *   - a stale or future `asserted_at`, a weak link and a non-operator connection grant nothing;
 *   - a deleted rule stops granting once the 30-second settings cache turns over;
 *   - no document yields Superadmin or Platform admin;
 *   - a rule grant and the root rule are summed and neither removes the other.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../helpers.js";
import { NOW } from "../seed.js";
import { insertConnection } from "../connectionFixtures.js";
import { ROOT_PRINCIPAL } from "../rbacFixtures.js";
import { writeConsoleAccess } from "../../src/core/settings/consoleAccess.js";
import { SETTINGS } from "../../src/mount.js";
import { resolvePrincipal } from "../../src/core/rbac/principal.js";
import {
  ruleGrantsFor,
  ruleMatchesFor,
} from "../../src/core/rbac/ruleGrants.js";
import {
  recordLinkAssertion,
  recordLinkGroups,
} from "../../src/services/identity/portal/repo.js";
import { can, PLATFORM } from "../../src/core/rbac/can.js";
import {
  parseAccessRules,
  type AccessRule,
} from "../../src/core/rbac/claimMatcher.js";
import type { AdminSession } from "../../src/core/console/session.js";
import type { Env } from "../../src/platform/env.js";
import type { Db } from "../../src/db/types.js";

const ISSUER = "https://ok.idp.example";
const CONSOLE_ISSUER = "https://console.idp.example";
const HOUR = 3600;

let db: Db;
let env: Env;
const ctx = () => ({ env, db, registry: SETTINGS });

beforeEach(() => {
  db = makeTestDb();
  env = {
    OIDC_ISSUER_ALLOWLIST: "ok.idp.example",
    ADMIN_OIDC_ISSUER: CONSOLE_ISSUER,
    ADMIN_OIDC_CLIENT_ID: "console",
    PLATFORM_ADMIN_GROUP: "admins",
  } as unknown as Env;
});
afterEach(() => vi.useRealTimers());

const session: AdminSession = {
  sub: "mbr_1",
  name: "Una",
  email: "una@example.test",
  groups: [],
  csrf: "c",
  exp: NOW + 3600,
  stepUpAt: NOW,
  principal: ROOT_PRINCIPAL,
};

const groupRule = (connection = "ops", group = "release") => ({
  when: { connection, group },
  grant: { role: "console_access", scope: "platform" },
});

async function writeRules(rules: unknown[], expectedVersion = 0) {
  const r = await writeConsoleAccess(
    ctx(),
    session,
    {
      value: { rules },
      expectedVersion,
      reason: "grant the release team access",
      confirm: "console.access",
    },
    NOW,
  );
  expect(r.ok).toBe(true);
}

async function operatorConnection(id = "ops", issuer = ISSUER) {
  await insertConnection(db, { id, audience: "operators", issuer });
}

async function enforceDomain() {
  await db.run(
    `INSERT INTO identity_connection_domains (connection_id, scope, domain, token, verified_at, checked_at, enforce)
     VALUES ('ops', 'platform', 'example.com', 't', ?, ?, 1)`,
    NOW,
    NOW,
  );
}

async function writeDomainRule() {
  await writeRules([
    {
      when: { connection: "ops", domain: "example.com" },
      grant: { role: "console_access", scope: "platform" },
    },
  ]);
}

async function account(id = "acc_1") {
  await db.run(
    "INSERT INTO accounts (id, created_at, modified_at) VALUES (?, ?, ?)",
    id,
    NOW,
    NOW,
  );
  return id;
}

interface LinkOver {
  issuer?: string;
  kind?: string;
  groups?: string[] | null;
  claims?: Record<string, unknown> | null;
  email?: string | null;
  emailVerified?: number;
  strongAt?: number | null;
  assertedAt?: number | null;
  subject?: string;
  /** Default: the connection of the issuer (`ops`, or `console-idp`). */
  assertedBy?: string | null;
}

let n = 0;
async function link(accountId: string, over: LinkOver = {}) {
  n += 1;
  await db.run(
    `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email,
       email_verified, groups_json, claims_json, strong_at, asserted_at, asserted_connection_id, created_at, last_used_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `lnk_${n}`,
    accountId,
    over.issuer ?? ISSUER,
    over.subject ?? `sub-${n}`,
    over.kind ?? "oidc",
    over.email ?? null,
    over.emailVerified ?? 0,
    over.groups === null ? null : JSON.stringify(over.groups ?? ["release"]),
    over.claims ? JSON.stringify(over.claims) : null,
    over.strongAt === undefined ? NOW : over.strongAt,
    over.assertedAt === undefined ? NOW : over.assertedAt,
    over.assertedBy === undefined
      ? over.issuer === CONSOLE_ISSUER
        ? "console-idp"
        : "ops"
      : over.assertedBy,
    NOW,
    NOW,
  );
}

const grantsOf = async (accountId: string, now = NOW) =>
  (
    await resolvePrincipal(
      env,
      db,
      { sub: "mbr_1", groups: [], accountId },
      now,
    )
  ).grants;

describe("sign-in and preview give the same grants", () => {
  it("resolvePrincipal's rule grants are exactly what ruleMatchesFor answers for the stored rules", async () => {
    await operatorConnection();
    await writeRules([
      groupRule(),
      {
        when: { connection: "ops", claim: { name: "dept", equals: "games" } },
        grant: {
          role: "product_admin",
          scope: "product:tonebox",
          areas: ["ship"],
        },
      },
      groupRule("ops", "nobody"),
    ]);
    const a = await account();
    await link(a, { claims: { dept: "games" } });
    const rules = (
      await import("../../src/core/settings/resolve.js").then((m) =>
        m.resolvePlatformSetting(ctx(), "console.access", { fresh: true }),
      )
    ).value as { rules: AccessRule[] };
    const preview = (await ruleMatchesFor(env, db, a, rules.rules, NOW)).map(
      (m) => m.grant,
    );
    const signIn = (await grantsOf(a)).filter((g) => g.source === "rule");
    expect(preview).toHaveLength(2);
    expect(signIn).toEqual(preview);
  });
});

describe("what a link must be", () => {
  it("matches a domain rule only on an address the IdP verified, never an email-code address", async () => {
    await operatorConnection();
    await enforceDomain();
    await writeDomainRule();
    // Confirmed only by an email code: a different link, kind "email", never read.
    const viaCode = await account("acc_code");
    await link(viaCode, {
      issuer: "email",
      kind: "email",
      email: "ada@example.com",
      emailVerified: 1,
      groups: null,
    });
    expect(await ruleGrantsFor(env, db, viaCode, NOW)).toEqual([]);
    // An IdP link whose address the IdP did not verify.
    const unverified = await account("acc_unv");
    await link(unverified, {
      email: "ada@example.com",
      emailVerified: 0,
      groups: null,
    });
    expect(await ruleGrantsFor(env, db, unverified, NOW)).toEqual([]);
    // The IdP asserted and verified it.
    const asserted = await account("acc_idp");
    await link(asserted, {
      email: "ada@example.com",
      emailVerified: 1,
      groups: null,
    });
    expect(await ruleGrantsFor(env, db, asserted, NOW)).toHaveLength(1);
  });

  it("ignores a stale or future asserted_at, and one that is missing", async () => {
    await operatorConnection();
    await writeRules([groupRule()]);
    const fresh = await account("acc_fresh");
    await link(fresh, { assertedAt: NOW - 8 * HOUR });
    expect(await ruleGrantsFor(env, db, fresh, NOW)).toHaveLength(1);
    for (const [i, assertedAt] of [
      NOW - 8 * HOUR - 1,
      NOW + 600,
      null,
    ].entries()) {
      const a = await account(`acc_bad${i}`);
      await link(a, { assertedAt });
      expect(await ruleGrantsFor(env, db, a, NOW)).toEqual([]);
    }
  });

  it("ignores a link that is not strong", async () => {
    await operatorConnection();
    await writeRules([groupRule()]);
    const a = await account();
    await link(a, { strongAt: null });
    expect(await ruleGrantsFor(env, db, a, NOW)).toEqual([]);
  });

  it("ignores a connection that is not (or no longer) an operator connection", async () => {
    await operatorConnection();
    await writeRules([groupRule()]);
    const a = await account();
    await link(a);
    expect(await ruleGrantsFor(env, db, a, NOW)).toHaveLength(1);
    for (const sql of [
      "UPDATE identity_connections SET audience = 'customers' WHERE id = 'ops'",
      "UPDATE identity_connections SET status = 'disabled' WHERE id = 'ops'",
      "UPDATE identity_connections SET scope = 'product:alpha', audience = 'customers' WHERE id = 'ops'",
      "UPDATE identity_connections SET issuer = 'https://other.example' WHERE id = 'ops'",
    ]) {
      await db.run(sql);
      expect(await ruleGrantsFor(env, db, a, NOW)).toEqual([]);
      await db.run(
        "UPDATE identity_connections SET audience = 'operators', status = 'active', scope = 'platform', issuer = ? WHERE id = 'ops'",
        ISSUER,
      );
    }
  });

  it("ignores a link through another issuer than the rule's connection", async () => {
    await operatorConnection();
    await writeRules([groupRule()]);
    const a = await account();
    await link(a, { issuer: "https://elsewhere.idp.example" });
    expect(await ruleGrantsFor(env, db, a, NOW)).toEqual([]);
  });

  it("serves console-idp rules from the console IdP's link, and only while its issuer is allowed", async () => {
    await writeRules([groupRule("console-idp", "release")]);
    const a = await account();
    await link(a, { issuer: CONSOLE_ISSUER });
    expect(await ruleGrantsFor(env, db, a, NOW)).toHaveLength(1);
    const noIdp = { ...env, ADMIN_OIDC_ISSUER: undefined } as unknown as Env;
    expect(await ruleGrantsFor(noIdp, db, a, NOW)).toEqual([]);
  });

  it("reads nothing without an account id", async () => {
    await operatorConnection();
    await writeRules([groupRule()]);
    const p = await resolvePrincipal(
      env,
      db,
      { sub: "x", groups: ["release"] },
      NOW,
    );
    expect(p.grants).toEqual([]);
  });
});

describe("which connection asserted the facts", () => {
  it("a product-scope connection on the same issuer cannot satisfy an operator rule", async () => {
    await operatorConnection();
    await insertConnection(db, {
      id: "shop",
      scope: "product:alpha",
      audience: "customers",
      issuer: ISSUER,
    });
    await writeRules([groupRule()]);
    const a = await account();
    await link(a, { groups: [], assertedBy: "ops" });
    expect(await ruleGrantsFor(env, db, a, NOW)).toEqual([]);
    // The user signs in through the product connection, whose map names an attribute they edit.
    await recordLinkAssertion(
      env,
      db,
      "lnk_" + n,
      { groups: ["release"], claims: null, connectionId: "shop" },
      NOW,
    );
    expect(await ruleGrantsFor(env, db, a, NOW)).toEqual([]);
    // The operator connection's own assertion still grants.
    await recordLinkAssertion(
      env,
      db,
      "lnk_" + n,
      { groups: ["release"], claims: null, connectionId: "ops" },
      NOW,
    );
    expect(await ruleGrantsFor(env, db, a, NOW)).toHaveLength(1);
    // A link that no connection claimed (NULL) is not read either.
    await db.run("UPDATE account_links SET asserted_connection_id = NULL");
    expect(await ruleGrantsFor(env, db, a, NOW)).toEqual([]);
  });

  it("a claim removed at the next console sign-in stops matching", async () => {
    await writeRules([
      {
        when: {
          connection: "console-idp",
          claim: { name: "dept", equals: "games" },
        },
        grant: { role: "console_access", scope: "platform" },
      },
    ]);
    const a = await account();
    await link(a, { issuer: CONSOLE_ISSUER, claims: { dept: "games" } });
    expect(await ruleGrantsFor(env, db, a, NOW)).toHaveLength(1);
    await recordLinkGroups(db, "lnk_" + n, ["x"], NOW + 5, "console-idp");
    expect(await ruleGrantsFor(env, db, a, NOW + 5)).toEqual([]);
  });

  it("a sign-in that maps no groups or claims still lets a domain rule work", async () => {
    await operatorConnection();
    await enforceDomain();
    await writeDomainRule();
    const a = await account();
    await link(a, {
      email: "ada@example.com",
      emailVerified: 1,
      groups: null,
      assertedAt: null,
      assertedBy: null,
    });
    expect(await ruleGrantsFor(env, db, a, NOW)).toEqual([]);
    await recordLinkAssertion(
      env,
      db,
      "lnk_" + n,
      { groups: null, claims: null, connectionId: "ops" },
      NOW,
    );
    expect(await ruleGrantsFor(env, db, a, NOW)).toHaveLength(1);
  });
});

describe("a deleted rule", () => {
  it("stops granting once the 30-second settings cache turns over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW * 1000));
    await operatorConnection();
    await writeRules([groupRule()]);
    const a = await account();
    await link(a);
    expect(await ruleGrantsFor(env, db, a, NOW)).toHaveLength(1);
    // Deleted behind this isolate's back (another isolate wrote it).
    await db.run("DELETE FROM platform_settings WHERE key = 'console.access'");
    vi.setSystemTime(new Date((NOW + 10) * 1000));
    expect(await ruleGrantsFor(env, db, a, NOW + 10)).toHaveLength(1);
    vi.setSystemTime(new Date((NOW + 31) * 1000));
    expect(await ruleGrantsFor(env, db, a, NOW + 31)).toEqual([]);
  });
});

describe("a rule never reaches the root", () => {
  it("never yields superadmin or platform_admin, whatever is stored", async () => {
    await operatorConnection();
    const a = await account();
    await link(a);
    // The parser refuses a document that names either; evaluate also skips them if one slipped in.
    for (const role of ["superadmin", "platform_admin"]) {
      expect(
        parseAccessRules({
          rules: [
            {
              id: "r_aaaaaa",
              when: { connection: "ops", group: "release" },
              grant: { role, scope: "platform" },
            },
          ],
        }).ok,
      ).toBe(false);
      // A raw row written past the writer is read through the same parser, so it grants nothing.
      await db.run(
        `INSERT OR REPLACE INTO platform_settings (key, value_json, version, updated_at, updated_by)
         VALUES ('console.access', ?, 1, ?, 'raw')`,
        JSON.stringify({
          rules: [
            {
              id: "r_aaaaaa",
              when: { connection: "ops", group: "release" },
              grant: { role, scope: "platform" },
            },
          ],
        }),
        NOW,
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date((NOW + 1000) * 1000));
      expect(await ruleGrantsFor(env, db, a, NOW)).toEqual([]);
      vi.useRealTimers();
    }
  });

  it("sums with the root rule: the rule grant is added, never replaces it", async () => {
    await operatorConnection();
    await writeRules([groupRule()]);
    const a = await account();
    await link(a);
    const p = await resolvePrincipal(
      env,
      db,
      { sub: "mbr_1", groups: [], root: true, accountId: a },
      NOW,
    );
    expect(p.grants.map((g) => `${g.role}:${g.source}`)).toEqual([
      "superadmin:root",
      "console_access:rule",
    ]);
    const only = { memberId: "m", grants: await grantsOf(a) };
    expect(can(only, PLATFORM, "console", "view")).toBe(true);
    expect(can(only, PLATFORM, "members", "edit")).toBe(false);
  });
});
