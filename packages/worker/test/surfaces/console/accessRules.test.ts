/**
 * ST-32.5: the SSO rules' preview and the `admin_group` conversion offers. People sign in through
 * the real callback (as in consoleBindingWrites); rule facts are links written straight to
 * `account_links`. Pinned here:
 *   - the preview answers exactly what sign-in grants for the same facts (one `evaluate`);
 *   - it needs the Members area, names only members, and counts other people for a Superadmin alone;
 *   - offers exist only where `admin_group` is set and is not the default `admin`;
 *   - Accept is the `console.access` write (Superadmin, step-up, L2 confirmation, reason), appends a
 *     rule built from the stored group, mails every Superadmin and writes `rbac.admin_group_offer`;
 *   - Dismiss and bulk dismiss write that row per product, once.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../../seed.js";
import { insertConnection } from "../../connectionFixtures.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import { resetConsoleSessionCache } from "../../../src/console/consoleSession.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import type { GrantScope, Role } from "../../../src/core/rbac/can.js";
import { memberIdFor } from "../../../src/core/console/memberId.js";
import { resolvePrincipal } from "../../../src/core/rbac/principal.js";
import { resolvePlatformSetting } from "../../../src/core/settings/resolve.js";
import { SETTINGS } from "../../../src/mount.js";
import { ROOT_PRINCIPAL } from "../../rbacFixtures.js";
import { writeConsoleAccess } from "../../../src/core/settings/consoleAccess.js";

const GROUP = "platform-admins";
const CORP_ISSUER = "https://corp.idp.example";

type Db = ReturnType<typeof makeTestDb>;

interface Mail {
  to: string;
  subject: string;
  text: string;
}

let mail: Mail[];
/** Everyone who signed in, so every response body can be checked for an account id. */
let people: { accountId: string }[];

function adminEnv(): Env {
  const e = makeEnv(new KvMock(), ["alpha", "beta"]);
  e.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  e.PLATFORM_ADMIN_GROUP = GROUP;
  e.EMAIL = {
    send: async (m: Mail) => {
      mail.push(m);
    },
  } as unknown as Env["EMAIL"];
  e.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  return e;
}

interface Person {
  token: string;
  accountId: string;
  csrf: string;
  memberId: string;
}

/** Sign in; `root` holds the root group, anyone else gets only what is bound or ruled for them. */
async function person(
  who: string,
  opts: { root?: boolean; stepUp?: boolean } = {},
): Promise<Person> {
  const t = await consoleTestSession(
    env,
    db,
    {
      sub: `idp-${who}`,
      email: `${who}@example.com`,
      name: who,
      groups: opts.root ? [GROUP] : [],
      ...(opts.stepUp ? { authTime: NOW, stepUp: true } : {}),
    },
    NOW,
  );
  const claims = JSON.parse(
    Buffer.from(t.token.split(".")[0]!, "base64url").toString("utf8"),
  ) as { aid: string };
  people.push({ accountId: claims.aid });
  return {
    token: t.token,
    accountId: claims.aid,
    csrf: t.csrf,
    memberId: await memberIdFor(env, claims.aid),
  };
}

const bind = (accountId: string, role: Role, scope: GrantScope) =>
  db.run(
    `INSERT INTO console_role_bindings (id, account_id, role, scope, source, granted_at)
     VALUES (?, ?, ?, ?, 'grant', ?)`,
    `crb_${accountId}`,
    accountId,
    role,
    scope,
    NOW - 10,
  );

/** Every response body, to assert no account id ever appears in one. */
let seen: string[];

/** One admin API call as `p`; the CSRF header goes on every write unless `csrf: false`. */
async function send(
  p: Person,
  method: string,
  path: string,
  body?: unknown,
  opts: { csrf?: boolean } = {},
): Promise<{ status: number; b: any }> {
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${p.token}`,
  };
  if (method !== "GET" && opts.csrf !== false) headers[CSRF_HEADER] = p.csrf;
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`https://key.plrs.im/manage${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await handleAdmin(req as never, env, db, path, { now: NOW + 1 });
  const text = await res.text();
  seen.push(text);
  return { status: res.status, b: text ? JSON.parse(text) : {} };
}

const rows = (sql: string, ...params: string[]) =>
  db.all<Record<string, string | number | null>>(sql, ...params);

let env: Env;
let db: Db;
let n = 0;

async function link(
  accountId: string,
  over: { groups?: string[]; email?: string; verified?: number } = {},
) {
  n += 1;
  await db.run(
    `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email,
       email_verified, groups_json, claims_json, strong_at, asserted_at, asserted_connection_id, created_at, last_used_at)
     VALUES (?, ?, ?, '', ?, 'oidc', ?, ?, ?, NULL, ?, ?, 'ops', ?, ?)`,
    `lnk_t${n}`,
    accountId,
    CORP_ISSUER,
    `sub-t${n}`,
    over.email ?? null,
    over.verified ?? 0,
    JSON.stringify(over.groups ?? ["release"]),
    NOW,
    NOW,
    NOW,
    NOW,
  );
}

async function plainAccount(id: string) {
  await db.run(
    "INSERT INTO accounts (id, created_at, modified_at) VALUES (?, ?, ?)",
    id,
    NOW,
    NOW,
  );
  return id;
}

beforeEach(async () => {
  resetConsoleSessionCache();
  mail = [];
  seen = [];
  people = [];
  env = adminEnv();
  env.OIDC_ISSUER_ALLOWLIST = "corp.idp.example";
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, "beta");
  await seedProduct(db, "gamma");
  await insertConnection(db, {
    id: "ops",
    audience: "operators",
    issuer: CORP_ISSUER,
  });
});

afterEach(() => {
  for (const t of seen)
    for (const p of people) expect(t).not.toContain(p.accountId);
});

const draft = (group = "release") => ({
  rule: {
    label: "Releases",
    when: { connection: "ops", group },
    grant: { role: "console_access", scope: "platform" },
  },
});

const setGroup = (slug: string, group: string | null) =>
  db.run("UPDATE products SET admin_group = ? WHERE slug = ?", group, slug);

describe("POST /access/rules/preview", () => {
  it("names only members, answers what sign-in grants, and counts the rest for a Superadmin", async () => {
    const root = await person("root", { root: true });
    const bob = await person("bob");
    await bind(bob.accountId, "console_access", "platform");
    await link(bob.accountId);
    const carol = await plainAccount("acc_carol");
    await link(carol);
    const dave = await plainAccount("acc_dave");
    await link(dave, { groups: ["other"] });

    const r = await send(root, "POST", "/api/access/rules/preview", draft());
    expect(r.status).toBe(200);
    expect(r.b.members).toEqual([
      {
        memberId: bob.memberId,
        name: "bob",
        email: "bob@example.com",
        grant: { role: "console_access", scope: "platform", areas: null },
      },
    ]);
    expect(r.b.otherLinks).toBe(1);
    expect(JSON.stringify(r.b)).not.toContain("carol");

    // The same draft, stored, grants the same thing at sign-in.
    const w = await writeConsoleAccess(
      { env, db, registry: SETTINGS },
      {
        sub: root.memberId,
        name: "root",
        email: "root@example.com",
        groups: [],
        csrf: "c",
        exp: NOW + 3600,
        stepUpAt: NOW,
        principal: ROOT_PRINCIPAL,
      },
      {
        value: { rules: [draft().rule] },
        expectedVersion: 0,
        reason: "same rule",
        confirm: "console.access",
      },
      NOW,
    );
    expect(w.ok).toBe(true);
    const granted = (
      await resolvePrincipal(
        env,
        db,
        { sub: bob.memberId, groups: [], accountId: bob.accountId },
        NOW + 1,
      )
    ).grants.filter((g) => g.source === "rule");
    expect(granted).toHaveLength(1);
    expect({
      role: granted[0]!.role,
      scope: granted[0]!.scope,
      areas: granted[0]!.areas,
    }).toEqual(r.b.members[0].grant);
  });

  it("hides the count of non-members from a Platform admin, and refuses a member without Members", async () => {
    await person("root", { root: true });
    const pa = await person("pa");
    await bind(pa.accountId, "platform_admin", "platform");
    const plain = await person("plain");
    await bind(plain.accountId, "console_access", "platform");
    const carol = await plainAccount("acc_carol");
    await link(carol);

    const ok = await send(pa, "POST", "/api/access/rules/preview", draft());
    expect(ok.status).toBe(200);
    expect(ok.b.otherLinks).toBeNull();
    expect(ok.b.members).toEqual([]);

    const no = await send(plain, "POST", "/api/access/rules/preview", draft());
    expect(no.status).toBe(403);
    const noCsrf = await send(
      pa,
      "POST",
      "/api/access/rules/preview",
      draft(),
      {
        csrf: false,
      },
    );
    expect(noCsrf.status).toBe(403);
  });

  it("refuses a draft the write would refuse", async () => {
    const root = await person("root", { root: true });
    const bad = await send(root, "POST", "/api/access/rules/preview", {
      rule: {
        when: { connection: "nope", group: "x" },
        grant: { role: "console_access", scope: "platform" },
      },
    });
    expect(bad.status).toBe(422);
    expect(bad.b.reason).toBe("not_operator_connection");
    const worse = await send(root, "POST", "/api/access/rules/preview", {
      rule: {
        when: { connection: "ops", group: "x" },
        grant: { role: "superadmin", scope: "platform" },
      },
    });
    expect(worse.status).toBe(422);
    const extra = await send(root, "POST", "/api/access/rules/preview", {
      ...draft(),
      accountId: "acc_x",
    });
    expect(extra.status).toBe(422);
  });
});

describe("offers", () => {
  it("lists only products whose admin_group is set and is not the default", async () => {
    const root = await person("root", { root: true });
    await setGroup("alpha", "alpha-admins");
    await setGroup("beta", "admin");
    await setGroup("gamma", null);
    const r = await send(root, "GET", "/api/access/offers");
    expect(r.status).toBe(200);
    expect(r.b.offers).toEqual([
      { product: "alpha", name: expect.any(String), group: "alpha-admins" },
    ]);
  });

  it("dismisses one offer once and audits it on both trails", async () => {
    const root = await person("root", { root: true });
    await setGroup("alpha", "alpha-admins");
    const r = await send(root, "POST", "/api/access/offers/alpha", {
      action: "dismiss",
    });
    expect(r.status).toBe(200);
    expect(r.b.outcome).toBe("dismissed");
    const platform = await rows(
      "SELECT * FROM platform_audit WHERE action = 'rbac.admin_group_offer'",
    );
    expect(platform).toHaveLength(1);
    expect(platform[0]).toMatchObject({
      target_id: "alpha",
      actor_sub: root.memberId,
      setting_key: "admin_group_offer:alpha",
    });
    expect(JSON.parse(platform[0]!.after_json as string)).toEqual({
      outcome: "dismissed",
    });
    expect(
      await rows(
        "SELECT * FROM audit WHERE action = 'rbac.admin_group_offer' AND product = 'alpha'",
      ),
    ).toHaveLength(1);
    expect((await send(root, "GET", "/api/access/offers")).b.offers).toEqual(
      [],
    );
    const again = await send(root, "POST", "/api/access/offers/alpha", {
      action: "dismiss",
    });
    expect(again.status).toBe(404);
  });

  it("dismisses every open offer in one call, one row per product", async () => {
    const root = await person("root", { root: true });
    await setGroup("alpha", "a");
    await setGroup("beta", "b");
    await setGroup("gamma", "admin");
    const r = await send(root, "POST", "/api/access/offers", {
      action: "dismiss_all",
    });
    expect(r.status).toBe(200);
    expect(r.b.dismissed.sort()).toEqual(["alpha", "beta"]);
    const platform = await rows(
      "SELECT target_id FROM platform_audit WHERE action = 'rbac.admin_group_offer' ORDER BY target_id",
    );
    expect(platform.map((p) => p.target_id)).toEqual(["alpha", "beta"]);
    const product = await rows(
      "SELECT product FROM audit WHERE action = 'rbac.admin_group_offer' ORDER BY product",
    );
    expect(product.map((p) => p.product)).toEqual(["alpha", "beta"]);
    const none = await send(root, "POST", "/api/access/offers", {
      action: "dismiss_all",
    });
    expect(none.b.dismissed).toEqual([]);
  });

  it("lets only a Superadmin decide", async () => {
    await person("root", { root: true });
    const pa = await person("pa");
    await bind(pa.accountId, "platform_admin", "platform");
    await setGroup("alpha", "alpha-admins");
    expect((await send(pa, "GET", "/api/access/offers")).status).toBe(200);
    for (const body of [{ action: "dismiss" }, { action: "accept" }]) {
      const r = await send(pa, "POST", "/api/access/offers/alpha", body);
      expect(r.status).toBe(403);
      expect(r.b.reason).toBe("superadmin_only");
    }
    const bulk = await send(pa, "POST", "/api/access/offers", {
      action: "dismiss_all",
    });
    expect(bulk.status).toBe(403);
    expect(
      await rows(
        "SELECT 1 FROM platform_audit WHERE action = 'rbac.admin_group_offer'",
      ),
    ).toEqual([]);
  });

  const accept = {
    action: "accept",
    connection: "ops",
    areas: ["ship"],
    reason: "map the group",
    confirm: "console.access",
  };

  it("accept needs a step-up, the typed confirmation and a reason", async () => {
    const root = await person("root", { root: true });
    await setGroup("alpha", "alpha-admins");
    const noStep = await send(root, "POST", "/api/access/offers/alpha", accept);
    expect(noStep.status).toBe(403);
    expect(noStep.b.code).toBe("step_up_required");
    const stepped = await person("root", { root: true, stepUp: true });
    const noConfirm = await send(stepped, "POST", "/api/access/offers/alpha", {
      ...accept,
      confirm: undefined,
    });
    expect(noConfirm.status).toBeGreaterThanOrEqual(400);
    const noReason = await send(stepped, "POST", "/api/access/offers/alpha", {
      ...accept,
      reason: undefined,
    });
    expect(noReason.status).toBeGreaterThanOrEqual(400);
    const wrongConn = await send(stepped, "POST", "/api/access/offers/alpha", {
      ...accept,
      connection: "nope",
    });
    expect(wrongConn.status).toBe(422);
    expect(
      await rows(
        "SELECT 1 FROM platform_audit WHERE action = 'rbac.admin_group_offer'",
      ),
    ).toEqual([]);
    expect(
      (await send(stepped, "GET", "/api/access/offers")).b.offers,
    ).toHaveLength(1);
  });

  it("accept appends a rule built from the stored group, audits it and mails the Superadmins", async () => {
    await person("root", { root: true });
    const stepped = await person("boss", { root: true, stepUp: true });
    await setGroup("alpha", "alpha-admins");
    // The caller cannot choose the group or the id.
    const forged = await send(stepped, "POST", "/api/access/offers/alpha", {
      ...accept,
      group: "everyone",
    });
    expect(forged.status).toBe(422);
    const r = await send(stepped, "POST", "/api/access/offers/alpha", accept);
    expect(r.status).toBe(200);
    expect(r.b.outcome).toBe("accepted");
    const doc = (
      await resolvePlatformSetting(
        { env, db, registry: SETTINGS },
        "console.access",
        { fresh: true },
      )
    ).value as { rules: Array<Record<string, unknown>> };
    expect(doc.rules).toHaveLength(1);
    expect(doc.rules[0]).toMatchObject({
      id: r.b.ruleId,
      when: { connection: "ops", group: "alpha-admins" },
      grant: { role: "product_admin", scope: "product:alpha", areas: ["ship"] },
    });
    const outcome = await rows(
      "SELECT * FROM platform_audit WHERE action = 'rbac.admin_group_offer'",
    );
    expect(outcome).toHaveLength(1);
    expect(JSON.parse(outcome[0]!.after_json as string)).toEqual({
      outcome: "accepted",
      ruleId: r.b.ruleId,
    });
    expect(
      await rows(
        "SELECT 1 FROM platform_audit WHERE action = 'rbac.access_rules'",
      ),
    ).toHaveLength(1);
    // Both Superadmins are told, and the mail names no group.
    expect(mail.map((m) => m.to).sort()).toEqual([
      "boss@example.com",
      "root@example.com",
    ]);
    expect(mail[0]!.subject).toBe("Sign-in rules changed");
    for (const m of mail) expect(m.text).not.toContain("alpha-admins");
    // The offer is closed; a second accept finds none.
    const again = await send(
      stepped,
      "POST",
      "/api/access/offers/alpha",
      accept,
    );
    expect(again.status).toBe(404);
  });
});
