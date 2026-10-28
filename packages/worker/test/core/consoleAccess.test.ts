/**
 * `console.access` (ST-28 plan §2.4, §3; ST-32.2): the registry entry, the rule-1 exemption
 * (`PRIVILEGE_GRANT_KEYS`) and the one writer. Pinned here:
 *
 *   - the exemption list, and the fact that the key matches no deny-list category;
 *   - the exemption holds only for the entry's shape (a lookalike is still refused);
 *   - only a Superadmin writes it, with a step-up, an L2 confirm and a reason;
 *   - a rule must name an operator connection, and a `domain` rule a verified, enforced domain;
 *   - the server mints rule ids, and a client-chosen id is refused;
 *   - a refused write stores nothing.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { NOW } from "../seed.js";
import { insertConnection } from "../connectionFixtures.js";
import { ROOT_PRINCIPAL, PRINCIPALS } from "../rbacFixtures.js";
import { SETTINGS } from "../../src/mount.js";
import { setting } from "../../src/core/settings/define.js";
import { buildSettingsRegistry } from "../../src/core/settings/registry.js";
import {
  ACCESS_RULES_SCHEMA,
  checkRegistry,
  deniedCategories,
  PRIVILEGE_GRANT_KEYS,
} from "../../src/core/settings/rules.js";
import { PLATFORM_SLICE } from "../../src/core/settings/platform.js";
import { writeConsoleAccess } from "../../src/core/settings/consoleAccess.js";
import { writeSetting } from "../../src/core/settings/write.js";
import { resolvePlatformSetting } from "../../src/core/settings/resolve.js";
import type { AdminSession } from "../../src/core/console/session.js";
import type { Principal } from "../../src/core/rbac/can.js";
import type { Env } from "../../src/platform/env.js";
import type { Db } from "../../src/db/types.js";
import { SERVICES } from "../../src/mount.js";

const KEY = "console.access";
const ENV = { OIDC_ISSUER_ALLOWLIST: "ok.idp.example" } as unknown as Env;

function world() {
  const db = makeTestDb();
  return { db, ctx: { env: ENV, db, registry: SETTINGS } };
}

function session(
  principal: Principal | null,
  over: Partial<AdminSession> = {},
): AdminSession {
  return {
    sub: "mbr_1",
    name: "Una",
    email: "una@example.test",
    groups: [],
    csrf: "c",
    exp: NOW + 3600,
    stepUpAt: NOW,
    ...(principal ? { principal } : {}),
    ...over,
  };
}

const group = (connection = "console-idp", g = "tonebox-release") => ({
  when: { connection, group: g },
  grant: { role: "console_access", scope: "platform" },
});
const write = (
  w: ReturnType<typeof world>,
  s: AdminSession,
  rules: unknown[],
  over: Record<string, unknown> = {},
) =>
  writeConsoleAccess(
    w.ctx,
    s,
    {
      value: { rules },
      expectedVersion: 0,
      reason: "grant the release team access",
      confirm: KEY,
      ...over,
    },
    NOW,
  );
const stored = async (w: ReturnType<typeof world>) =>
  (await resolvePlatformSetting(w.ctx, KEY, { fresh: true })).value as {
    rules: Array<{ id: string }>;
  };

describe("the registry entry and its exemption", () => {
  it("pins PRIVILEGE_GRANT_KEYS, and the key matches no deny-list category", () => {
    expect(PRIVILEGE_GRANT_KEYS).toEqual(["console.access"]);
    expect(deniedCategories(KEY)).toEqual([]);
  });

  it("registers the platform entry the plan names", () => {
    const def = SETTINGS.get(KEY, "platform")!;
    expect(def).toMatchObject({
      scope: "platform",
      ownership: "operator",
      rbacArea: "members",
      securityWidening: true,
      critical: true,
      widensWhen: "any",
      confirm: { change: "L2" },
      value: { kind: "json", schema: ACCESS_RULES_SCHEMA },
      defaultValue: { rules: [] },
    });
    expect(checkRegistry(SETTINGS)).toEqual([]);
  });

  it("refuses a lookalike: another widening platform key, or this key in another shape", () => {
    const mk = (key: string, over = {}) =>
      setting({
        ...SETTINGS.get(KEY, "platform")!,
        key,
        ...over,
      });
    const issues = (extra: ReturnType<typeof mk>) =>
      checkRegistry(
        buildSettingsRegistry([...SERVICES.values()], {
          platform: [...PLATFORM_SLICE.filter((d) => d.key !== KEY), extra],
        }),
      );
    expect(issues(mk("console.grants"))).toEqual([
      expect.stringMatching(/cannot be a platform setting \(rule 1\)/),
      expect.stringMatching(/rbacArea is platform \(rule 7\)/),
    ]);
    expect(issues(mk(KEY, { rbacArea: "platform" }))).toEqual([
      expect.stringMatching(/rbacArea is members/),
      expect.stringMatching(/rbacArea is platform \(rule 7\)/),
    ]);
    expect(issues(mk(KEY, { critical: false }))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/critical, security-widening platform entry/),
      ]),
    );
  });
});

describe("who may write it", () => {
  it("lets a Superadmin with a step-up write, and mints the rule ids", async () => {
    const w = world();
    const r = await write(w, session(ROOT_PRINCIPAL), [group()]);
    expect(r.ok).toBe(true);
    const doc = await stored(w);
    expect(doc.rules).toHaveLength(1);
    expect(doc.rules[0]!.id).toMatch(/^r_[0-9a-f]{12}$/);
    const audit = await w.db.first<{ setting_key: string; origin: string }>(
      "SELECT setting_key, origin FROM platform_audit WHERE setting_key = ?",
      KEY,
    );
    expect(audit).toEqual({ setting_key: KEY, origin: "console" });
  });

  it("refuses everyone who is not a Superadmin, even with the Members area", async () => {
    for (const p of [
      PRINCIPALS.platformAdmin,
      PRINCIPALS.allProducts,
      PRINCIPALS.alphaAdmin,
      PRINCIPALS.consoleOnly,
      PRINCIPALS.stranger,
      null,
    ] as Array<Principal | null>) {
      const w = world();
      const r = await write(w, session(p), [group()]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(403);
      expect((await stored(w)).rules).toEqual([]);
    }
  });

  it("refuses a session with no step-up, or a stale one", async () => {
    for (const over of [
      { stepUpAt: undefined },
      { stepUpAt: NOW - 3600 },
    ] as Array<Partial<AdminSession>>) {
      const w = world();
      const r = await write(w, session(ROOT_PRINCIPAL, over), [group()]);
      expect(r).toMatchObject({
        ok: false,
        status: 403,
        reason: "step_up_required",
      });
      expect((await stored(w)).rules).toEqual([]);
    }
  });

  it("refuses a bypass of the writer: writeSetting needs the principal and step-up itself", async () => {
    const w = world();
    const base = {
      actor: { sub: "x", name: null, email: null },
      origin: "console" as const,
      principal: ROOT_PRINCIPAL,
      now: NOW,
      confirm: KEY,
    };
    const input = {
      key: KEY,
      value: { rules: [{ id: "r_aaaaaa", ...group() }] },
      expectedVersion: 0,
      reason: "x",
    };
    expect(await writeSetting(w.ctx, input, base)).toMatchObject({
      ok: false,
      reason: "step_up_required",
    });
    expect(
      await writeSetting(w.ctx, input, {
        ...base,
        principal: PRINCIPALS.platformAdmin,
        steppedUp: true,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect((await stored(w)).rules).toEqual([]);
  });

  it("needs the L2 confirm and a reason", async () => {
    const w = world();
    expect(
      await write(w, session(ROOT_PRINCIPAL), [group()], {
        confirm: undefined,
      }),
    ).toMatchObject({ ok: false, reason: "confirm_required" });
    expect(
      await write(w, session(ROOT_PRINCIPAL), [group()], { reason: undefined }),
    ).toMatchObject({ ok: false, reason: "reason_required" });
    expect((await stored(w)).rules).toEqual([]);
  });
});

describe("what a rule may name", () => {
  it("refuses a connection that is not an operator connection", async () => {
    const w = world();
    await insertConnection(w.db, {
      id: "cust",
      issuer: "https://ok.idp.example",
    });
    await insertConnection(w.db, {
      id: "ops-off-list",
      audience: "operators",
      issuer: "https://other.idp.example",
    });
    await insertConnection(w.db, {
      id: "ops-off",
      audience: "operators",
      issuer: "https://ok.idp.example",
      status: "disabled",
    });
    await insertConnection(w.db, {
      id: "ops-prod",
      scope: "product:alpha",
      audience: "customers",
      issuer: "https://ok.idp.example",
    });
    for (const id of [
      "cust",
      "ops-off-list",
      "ops-off",
      "ops-prod",
      "missing",
    ]) {
      const r = await write(w, session(ROOT_PRINCIPAL), [group(id)]);
      expect(r, id).toMatchObject({
        ok: false,
        reason: "not_operator_connection",
      });
    }
    expect((await stored(w)).rules).toEqual([]);
  });

  it("accepts console-idp and a qualifying connection, for a group or a claim", async () => {
    const w = world();
    await insertConnection(w.db, {
      id: "ops",
      audience: "both",
      issuer: "https://ok.idp.example",
    });
    const r = await write(w, session(ROOT_PRINCIPAL), [
      group("console-idp"),
      group("ops", "eng"),
      {
        when: {
          connection: "ops",
          claim: { name: "department", equals: "games" },
        },
        grant: {
          role: "product_admin",
          scope: "product:tonebox",
          areas: ["ship"],
        },
      },
    ]);
    expect(r.ok).toBe(true);
    expect((await stored(w)).rules).toHaveLength(3);
  });

  async function withDomain(
    db: Db,
    over: { verified?: boolean; enforce?: boolean },
  ) {
    await insertConnection(db, {
      id: "ops",
      audience: "operators",
      issuer: "https://ok.idp.example",
    });
    await db.run(
      `INSERT INTO identity_connection_domains (connection_id, scope, domain, token, verified_at, checked_at, enforce)
       VALUES ('ops', 'platform', 'example.com', 't', ?, ?, ?)`,
      over.verified === false ? null : NOW,
      NOW,
      over.enforce === false ? 0 : 1,
    );
  }
  const domainRule = (connection: string, domain = "example.com") => ({
    when: { connection, domain },
    grant: { role: "console_access", scope: "platform" },
  });

  it("accepts a domain rule only for a verified, enforced domain of that connection", async () => {
    const w = world();
    await withDomain(w.db, {});
    expect(
      (
        await write(w, session(ROOT_PRINCIPAL), [
          domainRule("ops", "Example.COM"),
        ])
      ).ok,
    ).toBe(true);
    expect(
      await write(
        w,
        session(ROOT_PRINCIPAL),
        [domainRule("ops", "other.com")],
        {
          expectedVersion: 1,
        },
      ),
    ).toMatchObject({ ok: false, reason: "domain_not_enforced" });
  });

  it("refuses a domain rule for an unverified or unenforced domain, or on console-idp", async () => {
    for (const over of [{ verified: false }, { enforce: false }]) {
      const w = world();
      await withDomain(w.db, over);
      expect(
        await write(w, session(ROOT_PRINCIPAL), [domainRule("ops")]),
      ).toMatchObject({
        ok: false,
        reason: "domain_not_enforced",
      });
    }
    const w = world();
    expect(
      await write(w, session(ROOT_PRINCIPAL), [domainRule("console-idp")]),
    ).toMatchObject({ ok: false, reason: "domain_not_enforced" });
  });

  it("refuses a rule that grants a platform role, and the system product's slug", async () => {
    const w = world();
    for (const grant of [
      { role: "platform_admin", scope: "platform" },
      { role: "superadmin", scope: "platform" },
      { role: "product_admin", scope: "product:polaris-key", areas: ["ship"] },
    ])
      expect(
        (await write(w, session(ROOT_PRINCIPAL), [{ ...group(), grant }])).ok,
      ).toBe(false);
    expect((await stored(w)).rules).toEqual([]);
  });
});

describe("rule ids are the server's", () => {
  it("refuses an id the client chose, and keeps a stored one stable", async () => {
    const w = world();
    expect(
      await write(w, session(ROOT_PRINCIPAL), [{ id: "r_abcdef", ...group() }]),
    ).toMatchObject({ ok: false, status: 422 });
    await write(w, session(ROOT_PRINCIPAL), [group()]);
    const [first] = (await stored(w)).rules;
    const again = await write(
      w,
      session(ROOT_PRINCIPAL),
      [
        { id: first!.id, ...group("console-idp", "other") },
        group("console-idp", "x"),
      ],
      { expectedVersion: 1 },
    );
    expect(again.ok).toBe(true);
    const doc = await stored(w);
    expect(doc.rules[0]!.id).toBe(first!.id);
    expect(doc.rules[1]!.id).not.toBe(first!.id);
    // A repeated id is refused.
    expect(
      await write(
        w,
        session(ROOT_PRINCIPAL),
        [
          { id: first!.id, ...group() },
          { id: first!.id, ...group() },
        ],
        { expectedVersion: 2 },
      ),
    ).toMatchObject({ ok: false });
  });

  it("empties the rules with a reset (Superadmin and step-up too)", async () => {
    const w = world();
    await write(w, session(ROOT_PRINCIPAL), [group()]);
    expect(
      await writeConsoleAccess(
        w.ctx,
        session(PRINCIPALS.platformAdmin),
        { op: "reset", expectedVersion: 1, reason: "r", confirm: KEY },
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    const r = await writeConsoleAccess(
      w.ctx,
      session(ROOT_PRINCIPAL),
      { op: "reset", expectedVersion: 1, reason: "r", confirm: KEY },
      NOW,
    );
    expect(r.ok).toBe(true);
    expect((await stored(w)).rules).toEqual([]);
  });
});
