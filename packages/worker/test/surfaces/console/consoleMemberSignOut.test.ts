/**
 * ST-34.12: "Sign out everywhere" for a console member. People sign in through the real callback
 * (`consoleTestSession`, then the stored groups are dropped); the preview and the write are driven through `handleAdmin`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../../seed.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import { resetConsoleSessionCache } from "../../../src/console/consoleSession.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { isAdminSessionRevoked } from "../../../src/core/console/sessionRevocation.js";
import { ADMIN_SESSION_TTL_SECONDS } from "../../../src/core/console/session.js";
import {
  ADMIN_SCOPE,
  PACKAGES_READ_SCOPE,
  listAccountTokens,
  mintAccountToken,
  resolvePersonalToken,
} from "../../../src/core/accounts/personalTokens.js";

import { consoleTestSession } from "../../consoleSessionHelper.js";
import { memberIdFor } from "../../../src/core/console/memberId.js";
import {
  newBindingId,
  stmtInsertBinding,
} from "../../../src/core/rbac/bindings.js";
import type { GrantScope, Role } from "../../../src/core/rbac/can.js";

const GROUP = "platform-admins";
type Db = ReturnType<typeof makeTestDb>;
type Mail = { to: string };
type Person = {
  token: string;
  accountId: string;
  csrf: string;
  memberId: string;
};

let env: Env;
let db: Db;
let mail: Mail[];
/** Every response body, and every account id seen, to assert none names an account. */
let bodies: string[];
let accountIds: string[];

/** An operator who signed in through the console; `root` keeps the IdP group, else only bindings remain. */
async function member(who: string, root = false): Promise<Person> {
  const s = await consoleTestSession(
    env,
    db,
    {
      sub: `idp-${who}`,
      email: `${who}@example.com`,
      emailVerified: true,
      name: who,
      groups: [GROUP],
    },
    NOW,
  );
  const aid = JSON.parse(
    Buffer.from(s.token.split(".")[0]!, "base64url").toString("utf8"),
  ).aid as string;
  if (!root)
    await db.run(
      "UPDATE account_links SET groups_json = '[]' WHERE account_id = ?",
      aid,
    );
  accountIds.push(aid);
  return {
    token: s.token,
    accountId: aid,
    csrf: s.csrf,
    memberId: await memberIdFor(env, aid),
  };
}

/** Give the member a platform-scope role. */
async function grant(p: Person, role: Role, scope: GrantScope = "platform") {
  const row = stmtInsertBinding({
    id: newBindingId(),
    accountId: p.accountId,
    emailNorm: null,
    role,
    scope,
    areas: null,
    source: "grant",
    grantedBy: null,
    grantedAt: NOW - 10,
  });
  await db.run(row.sql, ...row.params);
}

/** One console request as `p`; the CSRF header goes on a write unless `csrf: false`. */
async function send(
  p: Person,
  method: "GET" | "POST",
  path: string,
  o: { csrf?: boolean; now?: number } = {},
) {
  const write = method !== "GET";
  const res = await handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${p.token}`,
        ...(write && o.csrf !== false ? { [CSRF_HEADER]: p.csrf } : {}),
        ...(write ? { "content-type": "application/json" } : {}),
      },
      ...(write ? { body: "{}" } : {}),
    }) as unknown as Request,
    env,
    db,
    path,
    { now: o.now ?? NOW + 1 },
  );
  const text = await res.text();
  bodies.push(text);
  const b = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  return {
    status: res.status,
    b,
    reason: (b.error as { reason?: string } | undefined)?.reason ?? b.reason,
  };
}

const auditCount = async () =>
  (await db.all("SELECT 1 FROM platform_audit WHERE action = 'rbac.signout'"))
    .length;

beforeEach(async () => {
  resetConsoleSessionCache();
  mail = [];
  bodies = [];
  accountIds = [];
  env = makeEnv(new KvMock(), ["alpha", "beta"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  env.EMAIL = {
    send: async (m: Mail) => void mail.push(m),
  } as unknown as Env["EMAIL"];
  db = makeTestDb();
  await seedProduct(db, "alpha");
});

afterEach(() => {
  for (const t of bodies)
    for (const id of accountIds) expect(t).not.toContain(id);
});

async function mint(accountId: string, scope: string, label: string) {
  const r = await mintAccountToken(
    env,
    db,
    { accountId, label, scope, createdBy: `portal:${accountId}` },
    NOW,
  );
  if (!r.ok) throw new Error("mint failed");
  return r.token;
}

const route = (id: string) => `/api/members/${id}/sign-out`;

describe("members/<id>/sign-out", () => {
  it("a Platform admin signs a member out: the session ends, admin tokens at once, packages tokens survive", async () => {
    const pam = await member("pam");
    await grant(pam, "platform_admin");
    const bob = await member("bob");
    await grant(bob, "console_access");
    const admin = await mint(bob.accountId, ADMIN_SCOPE, "ci box");
    const pkgs = await mint(bob.accountId, PACKAGES_READ_SCOPE, "laptop");
    expect((await send(bob, "GET", "/api/me")).status).toBe(200);

    const preview = await send(pam, "GET", route(bob.memberId));
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.b)).toContain("ci box");
    expect(JSON.stringify(preview.b)).not.toContain("laptop");
    // The preview writes nothing.
    expect(
      await resolvePersonalToken(env, db, admin, ADMIN_SCOPE, NOW + 1),
    ).not.toBeNull();
    expect(await auditCount()).toBe(0);

    const done = await send(pam, "POST", route(bob.memberId));
    expect(done.status).toBe(200);
    expect(done.b).toMatchObject({ ok: true, memberId: bob.memberId });
    expect(
      await resolvePersonalToken(env, db, admin, ADMIN_SCOPE, NOW + 2),
    ).toBeNull();
    expect(
      await resolvePersonalToken(env, db, pkgs, PACKAGES_READ_SCOPE, NOW + 2),
    ).not.toBeNull();
    const live = await listAccountTokens(db, bob.accountId, NOW + 2);
    expect(
      live.filter((t) => t.status === "active").map((t) => t.scope),
    ).toEqual([PACKAGES_READ_SCOPE]);
    // The session ends within the console's 30 s live-check window.
    expect((await send(bob, "GET", "/api/me", { now: NOW + 40 })).status).toBe(
      401,
    );
    // The mark is the one a sign-out writes, under the member id.
    expect(
      await isAdminSessionRevoked(env, {
        sub: bob.memberId,
        exp: NOW + ADMIN_SESSION_TTL_SECONDS,
      }),
    ).toBe(true);
    const audit = await db.all(
      "SELECT * FROM platform_audit WHERE action = 'rbac.signout'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_sub: pam.memberId,
      target_kind: "console_member",
      target_id: bob.memberId,
    });
    expect(mail.map((m) => m.to)).toEqual(["bob@example.com"]);
    expect(JSON.stringify(mail)).not.toContain(admin);
  });

  it("a Platform admin cannot sign out a Superadmin, a root holder or a peer", async () => {
    const pam = await member("pam");
    await grant(pam, "platform_admin");
    const root = await member("root", true);
    const sue = await member("sue");
    await grant(sue, "superadmin");
    const pete = await member("pete");
    await grant(pete, "platform_admin");
    for (const target of [root, sue, pete])
      for (const method of ["GET", "POST"] as const)
        expect((await send(pam, method, route(target.memberId))).status).toBe(
          403,
        );
    expect(await auditCount()).toBe(0);
    // A Superadmin may sign out another root holder.
    const root2 = await member("root2", true);
    expect((await send(root, "POST", route(root2.memberId))).status).toBe(200);
  });

  it("refuses a self sign-out, a missing CSRF token, and a member without edit on members", async () => {
    const root = await member("root", true);
    const bob = await member("bob");
    await grant(bob, "console_access");
    const vic = await member("vic");
    await grant(vic, "console_access");
    expect((await send(root, "POST", route(root.memberId))).reason).toBe(
      "self_sign_out",
    );
    expect(
      (await send(root, "POST", route(bob.memberId), { csrf: false })).status,
    ).toBe(403);
    for (const method of ["GET", "POST"] as const)
      expect((await send(vic, method, route(bob.memberId))).status).toBe(403);
    expect(await auditCount()).toBe(0);
    expect((await send(bob, "GET", "/api/me")).status).toBe(200);
  });

  it("an unknown, forged or malformed member is one 404 that says nothing", async () => {
    const root = await member("root", true);
    const stan = await member("stan"); // signed in, holds no binding
    const answers = new Set<string>();
    for (const id of [`mbr_${"A".repeat(22)}`, "not-an-id", stan.memberId])
      for (const method of ["GET", "POST"] as const) {
        const r = await send(root, method, route(id));
        expect(r.status).toBe(404);
        answers.add(JSON.stringify(r.b));
      }
    expect(answers.size).toBe(1);
    expect(await auditCount()).toBe(0);
  });
});
