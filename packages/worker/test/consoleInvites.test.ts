/**
 * ST-31.7: invitations through `POST /bindings` and `POST /products/:slug/members` with `emails`
 * (D-e, D-g, the 20-address cap, the per-recipient operator-notice budget, undo, the nightly sweep,
 * the erasure of an invitee). The harness is ST-31.6's: each person signs in through the
 * real callback (so the cookie, the session row and the strong console link are real); the IdP
 * groups are then stripped from the link unless the person is the root operator, which leaves a
 * signed-in non-root member whose authority is exactly the bindings written here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { bindAdminFlow } from "./flowBinderHelper.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  type IdTokenVerifier,
} from "../src/console/auth.js";
import { resetConsoleSessionCache } from "../src/console/consoleSession.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../src/core/console/session.js";
import {
  bindingUnchangedSql,
  newBindingId,
  stmtInsertBinding,
  stmtUpdateBindingAreas,
} from "../src/core/rbac/bindings.js";
import type { AreaId } from "../src/core/rbac/areas.js";
import type { GrantScope, Role } from "../src/core/rbac/can.js";
import { memberIdFor } from "../src/core/console/memberId.js";
import { erasureKey } from "../src/core/accounts/erasureFence.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import {
  INVITE_TTL_SECONDS,
  INVITE_PURGE_GRACE_SECONDS,
} from "../src/core/rbac/bindings.js";
import { runScheduledMaintenance } from "../src/scheduled.js";
import { deleteAccount } from "../src/services/identity/accounts/deletion.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { asR2, R2Mock } from "./r2Mock.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";

type Db = ReturnType<typeof makeTestDb>;

interface Mail {
  to: string;
  subject: string;
  text: string;
  from: unknown;
}

let mail: Mail[];
/** Everyone who signed in, so every response body can be checked for an account id. */
let people: { accountId: string }[];

function adminEnv(withEmail = true): Env {
  const env = makeEnv(new KvMock(), ["alpha", "beta"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  if (withEmail) {
    env.EMAIL = {
      send: async (m: Mail) => {
        mail.push(m);
      },
    } as unknown as Env["EMAIL"];
    env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  }
  return env;
}

interface Person {
  token: string;
  accountId: string;
  csrf: string;
  who: string;
  memberId: string;
}

/** Sign in through the real gate (as a root group member), then drop the stored groups. */
async function person(
  env: Env,
  db: Db,
  who: string,
  opts: { keepRoot?: boolean; stepUp?: boolean } = {},
): Promise<Person> {
  const start = await handleAdminLogin(
    new Request(
      "https://key.plrs.im/manage/login?go=1" +
        (opts.stepUp ? "&stepUp=1" : ""),
    ) as unknown as Request,
    env,
  );
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: `idp-${who}`,
      email: `${who}@example.com`,
      emailVerified: true,
      name: who,
      groups: [GROUP],
      ...(opts.stepUp ? { authTime: NOW } : {}),
    }),
  };
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: { cookie: await bindAdminFlow(env, state) },
    }) as unknown as Request,
    env,
    db,
    NOW,
    verifier,
  );
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const token = cookie.slice(cookie.indexOf("=") + 1);
  const claims = JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
  ) as { aid: string; csrf: string };
  if (!opts.keepRoot) {
    await db.run(
      "UPDATE account_links SET groups_json = '[]' WHERE account_id = ?",
      claims.aid,
    );
  }
  people.push({ accountId: claims.aid });
  return {
    token,
    accountId: claims.aid,
    csrf: claims.csrf,
    who,
    memberId: await memberIdFor(env, claims.aid),
  };
}

async function bind(
  db: Db,
  accountId: string,
  role: Role,
  scope: GrantScope,
  areas: AreaId[] | null,
): Promise<string> {
  const id = newBindingId();
  const s = stmtInsertBinding({
    id,
    accountId,
    emailNorm: null,
    role,
    scope,
    areas,
    source: "grant",
    grantedBy: null,
    grantedAt: NOW - 10,
  });
  await db.run(s.sql, ...s.params);
  return id;
}

async function call(
  p: Person,
  method: string,
  path: string,
  body?: unknown,
  opts: { csrf?: boolean; now?: number } = {},
): Promise<Response> {
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${p.token}`,
        ...(method !== "GET" && opts.csrf !== false
          ? { [CSRF_HEADER]: p.csrf }
          : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Request,
    env,
    db,
    path,
    { now: opts.now ?? NOW + 1 },
  );
}

interface Body {
  ok?: boolean;
  code?: string;
  reason?: string;
  fields?: string[];
  bindingId?: string;
  unchanged?: boolean;
  widened?: boolean;
  confirm?: string;
  binding?: {
    bindingId: string;
    memberId: string;
    role: string;
    scope: string;
    areas: string[] | null;
  };
  notified?: { sent: number; of: number; nobodyNotified: boolean };
  results?: {
    email: string;
    status: string;
    bindingId?: string;
    expiresAt?: number;
    needsOperatorSignIn?: boolean;
    emailed?: boolean;
    link?: string;
  }[];
  counts?: Record<string, number>;
  emailOff?: boolean;
  invite?: boolean;
  error?: { reason?: string };
}

/** Every response body in a test, to assert the account id never appears in one. */
let seen: string[];

async function send(
  p: Person,
  method: string,
  path: string,
  body?: unknown,
  opts?: { csrf?: boolean; now?: number },
): Promise<{ status: number; b: Body }> {
  const res = await call(p, method, path, body, opts);
  const text = await res.text();
  seen.push(text);
  return { status: res.status, b: (text ? JSON.parse(text) : {}) as Body };
}

async function rows(sql: string, ...params: string[]) {
  return db.all<Record<string, string | number | null>>(sql, ...params);
}

async function storedAreas(id: string) {
  const r = await db.first<{ areas_json: string | null }>(
    "SELECT areas_json FROM console_role_bindings WHERE id = ?",
    id,
  );
  return r === null ? "gone" : r.areas_json;
}

let env: Env;
let db: Db;

beforeEach(async () => {
  resetConsoleSessionCache();
  mail = [];
  seen = [];
  people = [];
  env = adminEnv();
  db = makeTestDb();
  await seedProduct(db, "alpha");
  await seedProduct(db, "beta");
});

afterEach(() => {
  // The account id never reaches a response body, whatever the route answered.
  for (const t of seen)
    for (const p of people) expect(t).not.toContain(p.accountId);
});

const alphaShip = {
  role: "product_admin",
  scope: "product:alpha",
  areas: ["ship"],
};

/** A signed-in root operator who has just stepped up: the usual writer. */
const rootWriter = () =>
  person(env, db, "root", { keepRoot: true, stepUp: true });

const invites = () =>
  rows("SELECT * FROM console_role_bindings WHERE email_norm IS NOT NULL");

describe("POST /bindings with emails", () => {
  it("answers per address: invited, updated (D-e), merged, invalid, exists", async () => {
    const root = await rootWriter();
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const carol = await person(env, db, "carol");
    await bind(db, carol.accountId, "console_access", "platform", null);
    await bind(db, carol.accountId, "product_admin", "product:alpha", ["ship"]);
    const r = await send(root, "POST", "/api/bindings", {
      emails: [
        "New.Person@Example.com",
        "  new.person@example.com ",
        "not an address",
        "bob@example.com",
        "carol@example.com",
        "other@example.com",
      ],
      ...alphaShip,
    });
    expect(r.status).toBe(201);
    expect(r.b.results!.map((x) => [x.email, x.status])).toEqual([
      ["new.person@example.com", "invited"],
      ["new.person@example.com", "merged"],
      ["not an address", "invalid"],
      ["bob@example.com", "updated"],
      ["carol@example.com", "exists"],
      ["other@example.com", "invited"],
    ]);
    expect(r.b.counts).toEqual({
      invited: 2,
      updated: 1,
      exists: 1,
      merged: 1,
      invalid: 1,
    });
    // The invite row: normalised address, no account, seven days, the inviter's member id.
    const inv = (await invites()).find(
      (x) => x.email_norm === "new.person@example.com",
    )!;
    expect(inv).toMatchObject({
      account_id: null,
      role: "product_admin",
      scope: "product:alpha",
      areas_json: '["ship"]',
      source: "invite",
      granted_by: root.memberId,
      granted_at: NOW + 1,
      expires_at: NOW + 1 + INVITE_TTL_SECONDS,
    });
    expect(INVITE_TTL_SECONDS).toBe(7 * 86_400);
    // The existing member got an account binding, not an invite.
    expect(
      await rows(
        "SELECT * FROM console_role_bindings WHERE account_id = ? AND scope = 'product:alpha'",
        bob.accountId,
      ),
    ).toHaveLength(1);
    expect(await invites()).toHaveLength(2);
    // Nothing written for the invalid, merged or existing rows.
    expect(await rows("SELECT * FROM console_role_bindings")).toHaveLength(
      2 /* bob, carol console_access */ +
        1 /* carol ship */ +
        1 /* bob ship */ +
        2,
    );
  });

  it("takes at most 20 addresses and exactly one of member or emails", async () => {
    const root = await rootWriter();
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@example.com`);
    const over = await send(root, "POST", "/api/bindings", {
      emails: many,
      ...alphaShip,
    });
    expect(over.status).toBe(422);
    expect(over.b.error?.reason ?? over.b.reason).toBe("too_many_emails");
    const twenty = await send(root, "POST", "/api/bindings", {
      emails: many.slice(0, 20),
      ...alphaShip,
    });
    expect(twenty.status).toBe(201);
    expect(twenty.b.counts!.invited).toBe(20);

    const both = await send(root, "POST", "/api/bindings", {
      member: root.memberId,
      emails: ["a@example.com"],
      ...alphaShip,
    });
    expect(both.status).toBe(422);
    const neither = await send(root, "POST", "/api/bindings", alphaShip);
    expect(neither.status).toBe(422);
    for (const bad of [[], "a@example.com", [1], [null], {}])
      expect(
        (
          await send(root, "POST", "/api/bindings", {
            emails: bad,
            ...alphaShip,
          })
        ).status,
      ).toBe(422);
    expect(await invites()).toHaveLength(20);
  });

  it("only invalid addresses: 200 and nothing written", async () => {
    const root = await rootWriter();
    const r = await send(root, "POST", "/api/bindings", {
      emails: ["nope", "also nope", "a@b"],
      ...alphaShip,
    });
    expect(r.status).toBe(200);
    expect(r.b.counts).toMatchObject({ invalid: 3, invited: 0 });
    expect(await invites()).toHaveLength(0);
    expect(mail).toHaveLength(0);
  });

  it("re-inviting refreshes the expiry and keeps the row", async () => {
    const root = await rootWriter();
    const first = await send(root, "POST", "/api/bindings", {
      emails: ["x@example.com"],
      ...alphaShip,
    });
    const id = first.b.results![0]!.bindingId!;
    const later = NOW + 200;
    const again = await send(
      root,
      "POST",
      "/api/bindings",
      { emails: ["X@example.com"], ...alphaShip },
      { now: later },
    );
    expect(again.status).toBe(201);
    expect(again.b.results![0]).toMatchObject({
      status: "invited",
      bindingId: id,
      expiresAt: later + INVITE_TTL_SECONDS,
    });
    const all = await invites();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id,
      granted_at: later,
      expires_at: later + INVITE_TTL_SECONDS,
    });
  });

  it("refuses your own address (D-g), the session's or any verified one, writing nothing", async () => {
    const root = await rootWriter();
    for (const mine of ["root@example.com", " ROOT@example.com"]) {
      const r = await send(root, "POST", "/api/bindings", {
        emails: ["fine@example.com", mine],
        ...alphaShip,
      });
      expect(r.status).toBe(403);
      expect(r.b.error?.reason ?? r.b.reason).toBe("self_grant");
    }
    // A second verified address of the writer counts too.
    await db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified, created_at, last_used_at)
       VALUES ('l-extra', ?, 'email', '', 'second@example.com', 'email', 'second@example.com', 1, ?, ?)`,
      root.accountId,
      NOW,
      NOW,
    );
    const second = await send(root, "POST", "/api/bindings", {
      emails: ["second@example.com"],
      ...alphaShip,
    });
    expect(second.status).toBe(403);
    expect(await invites()).toHaveLength(0);
    expect(mail).toHaveLength(0);
  });

  it("holds an invite to the same rules as a grant (G1, G2, G3, L2)", async () => {
    const root = await rootWriter();
    const pa = await person(env, db, "pa", { stepUp: true });
    await bind(db, pa.accountId, "console_access", "platform", null);
    await bind(db, pa.accountId, "platform_admin", "platform", null);
    // A Platform admin may not invite a Superadmin or a Platform admin (G2) nor `products:*`.
    for (const body of [
      { role: "superadmin", scope: "platform", confirm: "L2" },
      { role: "platform_admin", scope: "platform", confirm: "L2" },
      {
        role: "product_admin",
        scope: "products:*",
        areas: null,
        confirm: "L2",
      },
    ]) {
      const r = await send(pa, "POST", "/api/bindings", {
        emails: ["z@example.com"],
        ...body,
      });
      expect(r.status).toBe(403);
      expect(r.b.error?.reason ?? r.b.reason).toBe("grant_refused");
    }
    // A Superadmin's L2 target needs the confirm, then the invite is flagged (SM-7).
    const need = await send(root, "POST", "/api/bindings", {
      emails: ["z@example.com"],
      role: "platform_admin",
      scope: "platform",
    });
    expect(need.status).toBe(422);
    expect(need.b.error?.reason ?? need.b.reason).toBe("confirm_required");
    const ok = await send(root, "POST", "/api/bindings", {
      emails: ["z@example.com"],
      role: "platform_admin",
      scope: "platform",
      confirm: "L2",
    });
    expect(ok.status).toBe(201);
    expect(ok.b.confirm).toBe("L2");
    expect(ok.b.results![0]).toMatchObject({
      status: "invited",
      needsOperatorSignIn: true,
    });
    // SM-6 roles carry no flag.
    const plain = await send(root, "POST", "/api/bindings", {
      emails: ["y@example.com"],
      role: "console_access",
      scope: "platform",
    });
    expect(plain.b.results![0]!.needsOperatorSignIn).toBeUndefined();
    // Unknown product, system product and unknown fields are refused before any address is read.
    expect(
      (
        await send(root, "POST", "/api/bindings", {
          emails: ["q@example.com"],
          role: "product_admin",
          scope: "product:nope",
          areas: null,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(root, "POST", "/api/bindings", {
          emails: ["q@example.com"],
          ...alphaShip,
          token: "x",
        })
      ).status,
    ).toBe(422);
    // Without a step-up the POST row refuses before the handler.
    const plainRoot = await person(env, db, "root", { keepRoot: true });
    const noStep = await send(plainRoot, "POST", "/api/bindings", {
      emails: ["q@example.com"],
      ...alphaShip,
    });
    expect([401, 403]).toContain(noStep.status);
    expect(noStep.b.code).toBe("step_up_required");
  });

  it("sends the invitation as Polaris Key with a hint-only link, and tells the Superadmins once", async () => {
    const root = await rootWriter();
    const r = await send(root, "POST", "/api/bindings", {
      emails: ["a@example.com", "b@example.com"],
      ...alphaShip,
    });
    expect(r.b.emailOff).toBe(false);
    expect(r.b.results!.every((x) => x.emailed === true && !x.link)).toBe(true);
    const toA = mail.filter((m) => m.to === "a@example.com");
    expect(toA).toHaveLength(1);
    expect(JSON.stringify(toA[0]!.from)).toContain("key.plrs.im");
    expect(toA[0]!.subject).toBe("You are invited to the Polaris Key console");
    expect(toA[0]!.text).toContain("/manage/login?login_hint=a%40example.com");
    // The link carries the address and nothing else: no token, code or id.
    const link = /https?:\/\/\S+login_hint=\S+/.exec(toA[0]!.text)![0];
    expect([...new URL(link).searchParams.keys()]).toEqual(["login_hint"]);
    // The invitee's mail does not name any other invitee.
    expect(toA[0]!.text).not.toContain("b@example.com");
    // One digest to the Superadmin (root), no invited address in it.
    const digest = mail.filter((m) => m.to === "root@example.com");
    expect(digest).toHaveLength(1);
    expect(digest[0]!.subject).toContain("2");
    expect(digest[0]!.text).not.toContain("a@example.com");
    expect(r.b.notified).toEqual({ sent: 3, of: 3, nobodyNotified: false });
  });

  it("with email off the response carries the links, and the rows are still written", async () => {
    env = adminEnv(false);
    const root = await rootWriter();
    const r = await send(root, "POST", "/api/bindings", {
      emails: ["a@example.com", "b+tag@example.com"],
      ...alphaShip,
    });
    expect(r.status).toBe(201);
    expect(r.b.emailOff).toBe(true);
    expect(r.b.notified).toMatchObject({ sent: 0, nobodyNotified: true });
    const links = r.b.results!.map((x) => x.link!);
    expect(links[1]).toBe(
      "https://key.plrs.im/manage/login?login_hint=b%2Btag%40example.com",
    );
    for (const l of links)
      expect([...new URL(l).searchParams.keys()]).toEqual(["login_hint"]);
    expect(await invites()).toHaveLength(2);
  });

  it("budgets operator notices per recipient: the eleventh in an hour is not sent", async () => {
    const root = await rootWriter();
    let last: Body | undefined;
    for (let i = 0; i < 11; i++)
      last = (
        await send(root, "POST", "/api/bindings", {
          emails: ["same@example.com"],
          ...alphaShip,
        })
      ).b;
    expect(mail.filter((m) => m.to === "same@example.com")).toHaveLength(10);
    expect(last!.results![0]).toMatchObject({ emailed: false });
    expect(last!.results![0]!.link).toContain("login_hint=same%40example.com");
    // The Superadmin's digests share the same ten-an-hour budget.
    expect(mail.filter((m) => m.to === "root@example.com")).toHaveLength(10);
    expect(last!.notified).toMatchObject({ sent: 0, nobodyNotified: true });
  });

  it("budgets invitations per member: the request that would pass the limit is refused whole", async () => {
    const root = await rootWriter();
    // 5 requests of 20 = 100 addresses are within the hourly limit.
    for (let r = 0; r < 5; r++) {
      const res = await send(root, "POST", "/api/bindings", {
        emails: Array.from({ length: 20 }, (_, i) => `u${r}-${i}@example.com`),
        ...alphaShip,
      });
      expect(res.status).toBe(201);
    }
    const over = await send(root, "POST", "/api/bindings", {
      emails: ["one-more@example.com"],
      ...alphaShip,
    });
    expect(over.status).toBe(429);
    expect(await invites()).toHaveLength(100);
  });

  it("audits one rbac.invite per invite without the address, and rbac.grant per update", async () => {
    const root = await rootWriter();
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const r = await send(root, "POST", "/api/bindings", {
      emails: ["audited@example.com", "bob@example.com"],
      ...alphaShip,
    });
    const inviteId = r.b.results![0]!.bindingId!;
    const platform = await rows(
      "SELECT * FROM platform_audit WHERE action = 'rbac.invite'",
    );
    expect(platform).toHaveLength(1);
    expect(platform[0]).toMatchObject({
      actor_sub: root.memberId,
      target_kind: "console_role_binding",
      target_id: inviteId,
    });
    expect(JSON.stringify(platform[0])).not.toContain("audited@example.com");
    expect(String(platform[0]!.summary)).toMatch(/invitee:[0-9a-f]{12}/);
    expect(
      await rows(
        "SELECT * FROM audit WHERE action = 'rbac.invite' AND product = 'alpha'",
      ),
    ).toHaveLength(1);
    expect(
      await rows("SELECT * FROM platform_audit WHERE action = 'rbac.grant'"),
    ).toHaveLength(1);
    // The same opaque reference every time, so repeated invites correlate without naming anyone.
    await send(root, "POST", "/api/bindings", {
      emails: ["audited@example.com"],
      ...alphaShip,
    });
    const again = await rows(
      "SELECT summary FROM platform_audit WHERE action = 'rbac.invite' ORDER BY at, id",
    );
    expect(again).toHaveLength(2);
    expect(String(again[0]!.summary).match(/invitee:[0-9a-f]{12}/)![0]).toBe(
      String(again[1]!.summary).match(/invitee:[0-9a-f]{12}/)![0],
    );
  });

  it("D-e only for a verified address on an active member, otherwise an invite", async () => {
    const root = await rootWriter();
    // Holds a portal account but no binding: invited.
    const dave = await getOrCreateAccountByEmail(db, "dave@example.com", NOW);
    expect(dave).toBeTruthy();
    // A member whose account is disabled, and one on the erasure ledger.
    const eve = await person(env, db, "eve");
    await bind(db, eve.accountId, "console_access", "platform", null);
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      eve.accountId,
    );
    const fay = await person(env, db, "fay");
    await bind(db, fay.accountId, "console_access", "platform", null);
    await env.BLOBS!.put(erasureKey(fay.accountId), "1");
    // A member whose address is not verified.
    const gus = await person(env, db, "gus");
    await bind(db, gus.accountId, "console_access", "platform", null);
    await db.run(
      "UPDATE account_links SET email_verified = 0 WHERE account_id = ?",
      gus.accountId,
    );
    await db.run(
      "UPDATE accounts SET primary_email_verified_at = NULL WHERE id = ?",
      gus.accountId,
    );
    const r = await send(root, "POST", "/api/bindings", {
      emails: [
        "dave@example.com",
        "eve@example.com",
        "fay@example.com",
        "gus@example.com",
      ],
      ...alphaShip,
    });
    expect(r.status).toBe(201);
    expect(r.b.results!.map((x) => x.status)).toEqual([
      "invited",
      "invited",
      "invited",
      "invited",
    ]);
    for (const p of [eve, fay, gus])
      expect(
        await rows(
          "SELECT * FROM console_role_bindings WHERE account_id = ? AND scope = 'product:alpha'",
          p.accountId,
        ),
      ).toHaveLength(0);
  });

  it("a root-only member (no binding) is an existing member too", async () => {
    const root = await rootWriter();
    const boss = await person(env, db, "boss", { keepRoot: true });
    expect(boss.accountId).not.toBe(root.accountId);
    const r = await send(root, "POST", "/api/bindings", {
      emails: ["boss@example.com"],
      ...alphaShip,
    });
    expect(r.b.results![0]!.status).toBe("updated");
  });

  it("an erasure ledger outage refuses the request and writes nothing", async () => {
    const root = await rootWriter();
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const blobs = env.BLOBS!;
    // The ledger answers for everyone except the invited member: the writer's session still holds.
    env.BLOBS = {
      head: async (key: string) => {
        if (key === erasureKey(bob.accountId)) throw new Error("r2 down");
        return null;
      },
    } as unknown as Env["BLOBS"];
    const r = await send(root, "POST", "/api/bindings", {
      emails: ["bob@example.com"],
      ...alphaShip,
    });
    env.BLOBS = blobs;
    expect(r.status).toBe(503);
    expect(await invites()).toHaveLength(0);
  });

  it("no response body carries an account id, for invited and updated alike", async () => {
    const root = await rootWriter();
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    await send(root, "POST", "/api/bindings", {
      emails: ["bob@example.com", "new@example.com"],
      ...alphaShip,
    });
    await send(root, "GET", "/api/products/alpha/members");
    await send(root, "GET", "/api/members");
    // The afterEach hook asserts it over every body seen; make sure bodies were seen.
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.join("")).not.toMatch(/"accountId"|"account_id"/);
  });
});

describe("POST /products/:slug/members with emails", () => {
  async function productAdmin(name = "pa") {
    const pa = await person(env, db, name, { stepUp: true });
    await bind(db, pa.accountId, "console_access", "platform", null);
    await bind(db, pa.accountId, "product_admin", "product:alpha", null);
    return pa;
  }

  it("a Product admin invites to its own product; both trails; the roster lists it", async () => {
    const pa = await productAdmin();
    const r = await send(pa, "POST", "/api/products/alpha/members", {
      emails: ["new@example.com"],
      areas: ["ship"],
    });
    expect(r.status).toBe(201);
    expect(r.b.results![0]).toMatchObject({ status: "invited" });
    expect(
      await rows(
        "SELECT * FROM audit WHERE action = 'rbac.invite' AND product = 'alpha'",
      ),
    ).toHaveLength(1);
    expect(
      await rows("SELECT * FROM platform_audit WHERE action = 'rbac.invite'"),
    ).toHaveLength(1);
    const roster = await send(pa, "GET", "/api/products/alpha/members");
    const listed = (
      roster.b as unknown as { invites: { email: string; bindingId: string }[] }
    ).invites;
    expect(listed.map((i) => i.email)).toEqual(["new@example.com"]);
    // Console access through the twin is platform scope (G3).
    const ca = await send(pa, "POST", "/api/products/alpha/members", {
      emails: ["desk@example.com"],
      role: "console_access",
    });
    expect(ca.status).toBe(201);
    expect(
      (await invites()).find((x) => x.email_norm === "desk@example.com"),
    ).toMatchObject({ role: "console_access", scope: "platform" });
  });

  it("cannot invite to another product, as a platform role, or to itself", async () => {
    const pa = await productAdmin();
    const other = await send(pa, "POST", "/api/products/beta/members", {
      emails: ["x@example.com"],
    });
    expect(other.status).toBe(403);
    const role = await send(pa, "POST", "/api/products/alpha/members", {
      emails: ["x@example.com"],
      role: "superadmin",
    });
    expect(role.status).toBe(422);
    const scope = await send(pa, "POST", "/api/products/alpha/members", {
      emails: ["x@example.com"],
      scope: "platform",
    });
    expect(scope.status).toBe(422);
    const self = await send(pa, "POST", "/api/products/alpha/members", {
      emails: ["pa@example.com"],
      areas: null,
    });
    expect(self.status).toBe(403);
    expect(await invites()).toHaveLength(0);
  });

  it("a Product admin without the members area cannot invite", async () => {
    const lim = await person(env, db, "lim", { stepUp: true });
    await bind(db, lim.accountId, "console_access", "platform", null);
    await bind(db, lim.accountId, "product_admin", "product:alpha", ["ship"]);
    const r = await send(lim, "POST", "/api/products/alpha/members", {
      emails: ["x@example.com"],
    });
    expect(r.status).toBe(403);
    expect(await invites()).toHaveLength(0);
  });
});

describe("undoing an invitation", () => {
  it("DELETE removes the invite and audits it; PATCH is a 404", async () => {
    const root = await rootWriter();
    const made = await send(root, "POST", "/api/bindings", {
      emails: ["undo@example.com"],
      ...alphaShip,
    });
    const id = made.b.results![0]!.bindingId!;
    const patch = await send(root, "PATCH", `/api/bindings/${id}`, {
      areas: ["ship", "commerce"],
    });
    expect(patch.status).toBe(404);
    const del = await send(root, "DELETE", `/api/bindings/${id}`);
    expect(del.status).toBe(200);
    expect(del.b).toMatchObject({ ok: true, bindingId: id, invite: true });
    expect(await invites()).toHaveLength(0);
    const audit = await rows(
      "SELECT * FROM platform_audit WHERE action = 'rbac.revoke'",
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain("undo@example.com");
    expect(
      await rows(
        "SELECT * FROM audit WHERE action = 'rbac.revoke' AND product = 'alpha'",
      ),
    ).toHaveLength(1);
    expect((await send(root, "DELETE", `/api/bindings/${id}`)).status).toBe(
      404,
    );
  });

  it("applies the revoke rules to an invite (D-c, B1) and the twin's scope fence", async () => {
    const root = await rootWriter();
    const pa = await person(env, db, "pa", { stepUp: true });
    await bind(db, pa.accountId, "console_access", "platform", null);
    await bind(db, pa.accountId, "product_admin", "product:alpha", null);
    const mine = await send(pa, "POST", "/api/products/alpha/members", {
      emails: ["mine@example.com"],
      areas: ["ship"],
    });
    const theirs = await send(root, "POST", "/api/bindings", {
      emails: ["beta@example.com"],
      role: "product_admin",
      scope: "product:beta",
      areas: ["ship"],
    });
    const wide = await send(root, "POST", "/api/bindings", {
      emails: ["wide@example.com"],
      role: "product_admin",
      scope: "products:*",
      areas: null,
      confirm: "L2",
    });
    const desk = await send(root, "POST", "/api/bindings", {
      emails: ["desk@example.com"],
      role: "console_access",
      scope: "platform",
    });
    // The twin reaches only its own product's invites.
    for (const other of [theirs, wide, desk])
      expect(
        (
          await send(
            pa,
            "DELETE",
            `/api/products/alpha/members/${other.b.results![0]!.bindingId}`,
          )
        ).status,
      ).toBe(404);
    // A Product admin cannot take back a platform-scope or wide invite through /bindings either.
    for (const other of [theirs, wide, desk])
      expect(
        (
          await send(
            pa,
            "DELETE",
            `/api/bindings/${other.b.results![0]!.bindingId}`,
          )
        ).status,
      ).toBe(403);
    // It can cancel its own product's.
    expect(
      (
        await send(
          pa,
          "DELETE",
          `/api/products/alpha/members/${mine.b.results![0]!.bindingId}`,
        )
      ).status,
    ).toBe(200);
    expect((await invites()).map((i) => i.email_norm).sort()).toEqual([
      "beta@example.com",
      "desk@example.com",
      "wide@example.com",
    ]);
  });
});

describe("the nightly sweep", () => {
  it("deletes invites that expired more than 7 days ago, and only those", async () => {
    const root = await rootWriter();
    const mk = async (email: string, expiresAt: number) => {
      const id = newBindingId();
      const s = stmtInsertBinding({
        id,
        accountId: null,
        emailNorm: email,
        role: "console_access",
        scope: "platform",
        areas: null,
        source: "invite",
        grantedBy: root.memberId,
        grantedAt: NOW - 20 * 86_400,
        expiresAt,
      });
      await db.run(s.sql, ...s.params);
    };
    const now = NOW + 100 * 86_400;
    await mk("old@example.com", now - INVITE_PURGE_GRACE_SECONDS - 1);
    await mk("edge@example.com", now - INVITE_PURGE_GRACE_SECONDS);
    await mk("recent@example.com", now - 86_400);
    await mk("live@example.com", now + 86_400);
    // A member's binding is never touched.
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    const report = await runScheduledMaintenance(db, now, env);
    expect(report.failures).toEqual({});
    expect(report.counts.consoleInvites).toBe(1);
    expect((await invites()).map((i) => i.email_norm).sort()).toEqual([
      "edge@example.com",
      "live@example.com",
      "recent@example.com",
    ]);
    expect(
      await rows(
        "SELECT * FROM console_role_bindings WHERE account_id = ?",
        bob.accountId,
      ),
    ).toHaveLength(1);
    // A second run on the same clock changes nothing.
    const again = await runScheduledMaintenance(db, now, env);
    expect(again.counts.consoleInvites).toBe(0);
  });
});

describe("erasure of an invitee", () => {
  it("deleting the account removes the invites for its addresses, and no others", async () => {
    const r2 = new R2Mock();
    env.BLOBS = asR2(r2);
    const root = await rootWriter();
    const signed = await signIn(
      db,
      { issuerKey: "email", subject: "gone@example.com", kind: "email" },
      NOW,
      { env },
    );
    if (signed.status !== "signed_in") throw new Error("sign-in failed");
    const mk = async (email: string) => {
      const s = stmtInsertBinding({
        id: newBindingId(),
        accountId: null,
        emailNorm: email,
        role: "console_access",
        scope: "platform",
        areas: null,
        source: "invite",
        grantedBy: root.memberId,
        grantedAt: NOW,
        expiresAt: NOW + 86_400,
      });
      await db.run(s.sql, ...s.params);
    };
    await mk("gone@example.com");
    await mk("keep@example.com");
    const res = await deleteAccount(
      { db, env, now: NOW + 5, origin: "https://key.plrs.im" },
      signed.account.id,
    );
    expect(res.ok).toBe(true);
    expect((await invites()).map((i) => i.email_norm)).toEqual([
      "keep@example.com",
    ]);
  });
});

describe("REV-ST31-7 fix round", () => {
  async function addLink(
    accountId: string,
    id: string,
    email: string,
    verified: number,
  ) {
    await db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified, created_at, last_used_at)
       VALUES (?, ?, 'https://other', '', ?, 'oidc', ?, ?, ?, ?)`,
      id,
      accountId,
      `s-${id}`,
      email,
      verified,
      NOW,
      NOW,
    );
  }

  it("B1: an L2 grant still mails every Superadmin after the budget is spent; L1 stays budgeted", async () => {
    const root = await rootWriter();
    await person(env, db, "sa2", { keepRoot: true });
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    for (let i = 0; i < 10; i++)
      await send(root, "POST", "/api/bindings", {
        emails: [`burn${i}@example.com`],
        role: "console_access",
        scope: "platform",
      });
    const before = mail.filter((m) => m.to === "sa2@example.com").length;
    expect(before).toBe(10);
    // L1 member grant: the Superadmin's budget is spent, so it is not told.
    const carol = await person(env, db, "carol");
    await bind(db, carol.accountId, "console_access", "platform", null);
    await send(root, "POST", "/api/bindings", {
      member: carol.memberId,
      ...alphaShip,
    });
    expect(mail.filter((m) => m.to === "sa2@example.com")).toHaveLength(10);
    // L2: still told, grantee included.
    const g = await send(root, "POST", "/api/bindings", {
      member: bob.memberId,
      role: "superadmin",
      scope: "platform",
      confirm: "L2",
    });
    expect(g.status).toBe(201);
    expect(mail.filter((m) => m.to === "sa2@example.com")).toHaveLength(11);
    expect(mail.filter((m) => m.to === "bob@example.com").length).toBe(1);
    // The per-request digest of L2 invitations is priority too.
    const inv = await send(root, "POST", "/api/bindings", {
      emails: ["new-sa@example.com"],
      role: "superadmin",
      scope: "platform",
      confirm: "L2",
    });
    expect(inv.status).toBe(201);
    expect(mail.filter((m) => m.to === "sa2@example.com")).toHaveLength(12);
  });

  it("B2: with the invite budget spent a member and a stranger both answer 429", async () => {
    const root = await rootWriter();
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    for (let r = 0; r < 5; r++)
      expect(
        (
          await send(root, "POST", "/api/bindings", {
            emails: Array.from(
              { length: 20 },
              (_, i) => `u${r}-${i}@example.com`,
            ),
            role: "console_access",
            scope: "platform",
          })
        ).status,
      ).toBe(201);
    const member = await send(root, "POST", "/api/bindings", {
      emails: ["bob@example.com"],
      role: "console_access",
      scope: "platform",
    });
    const stranger = await send(root, "POST", "/api/bindings", {
      emails: ["stranger@example.com"],
      role: "console_access",
      scope: "platform",
    });
    expect([member.status, stranger.status]).toEqual([429, 429]);
    expect(member.b.error?.reason ?? member.b.reason).toBe("invite_budget");
  });

  it("B3: a narrowed Product admin cannot re-scope or re-own an invite it cannot cancel", async () => {
    const root = await rootWriter();
    const pa = await person(env, db, "pa", { stepUp: true });
    await bind(db, pa.accountId, "console_access", "platform", null);
    await bind(db, pa.accountId, "product_admin", "product:alpha", [
      "ship",
      "members",
    ]);
    const made = await send(root, "POST", "/api/bindings", {
      emails: ["x@example.com"],
      role: "product_admin",
      scope: "product:alpha",
      areas: null,
    });
    const id = made.b.results![0]!.bindingId!;
    const mailsBefore = mail.length;
    const auditBefore = (await rows("SELECT id FROM platform_audit")).length;
    const re = await send(pa, "POST", "/api/products/alpha/members", {
      emails: ["x@example.com"],
      areas: ["ship"],
    });
    expect(re.status).toBe(200);
    expect(re.b.results![0]).toMatchObject({ status: "exists", bindingId: id });
    const row = (await invites())[0]!;
    expect(row.areas_json).toBeNull();
    expect(row.granted_by).toBe(root.memberId);
    expect(mail.length).toBe(mailsBefore);
    expect((await rows("SELECT id FROM platform_audit")).length).toBe(
      auditBefore,
    );
  });

  it("N8: a refresh by a writer who may cancel it audits the before", async () => {
    const root = await rootWriter();
    await send(root, "POST", "/api/bindings", {
      emails: ["r@example.com"],
      ...alphaShip,
    });
    await send(root, "POST", "/api/bindings", {
      emails: ["r@example.com"],
      role: "product_admin",
      scope: "product:alpha",
      areas: ["ship", "members"],
    });
    const a = await rows(
      "SELECT before_json FROM platform_audit WHERE action = 'rbac.invite'",
    );
    expect(a).toHaveLength(2);
    expect(a.filter((x) => x.before_json !== null)).toHaveLength(1);
  });

  it("D-g at creation: the writer's own unverified link address is refused", async () => {
    const root = await rootWriter();
    await addLink(root.accountId, "l-unv", "mine-later@example.com", 0);
    const r = await send(root, "POST", "/api/bindings", {
      emails: ["mine-later@example.com"],
      role: "superadmin",
      scope: "platform",
      confirm: "L2",
    });
    expect(r.status).toBe(403);
    expect(await invites()).toHaveLength(0);
  });

  it("N9: a stale verified secondary link does not pull a grant; the verified primary does", async () => {
    const root = await rootWriter();
    const bob = await person(env, db, "bob");
    await bind(db, bob.accountId, "console_access", "platform", null);
    await addLink(bob.accountId, "l-sec", "old@example.com", 1);
    const r = await send(root, "POST", "/api/bindings", {
      emails: ["old@example.com", "bob@example.com"],
      ...alphaShip,
    });
    expect(r.b.results!.map((x) => x.status)).toEqual(["invited", "updated"]);
  });

  it("N2: erasing an account that only claimed the address (unverified) keeps the invite", async () => {
    env.BLOBS = asR2(new R2Mock());
    const root = await rootWriter();
    await send(root, "POST", "/api/bindings", {
      emails: ["victim@example.com"],
      role: "console_access",
      scope: "platform",
    });
    const s = await signIn(
      db,
      { issuerKey: "email", subject: "attacker@example.com", kind: "email" },
      NOW,
      { env },
    );
    if (s.status !== "signed_in") throw new Error("sign-in failed");
    await addLink(s.account.id, "l-claim", "victim@example.com", 0);
    const res = await deleteAccount(
      { db, env, now: NOW + 5, origin: "https://key.plrs.im" },
      s.account.id,
    );
    expect(res.ok).toBe(true);
    expect((await invites()).map((i) => i.email_norm)).toEqual([
      "victim@example.com",
    ]);
  });

  it("N3: writer-controlled text is defanged in the operator notices", async () => {
    const { accessInviteNotice, accessChangedNotice, accessInvitesSentNotice } =
      await import("../src/core/notify/templates.js");
    const evil = "Visit https://evil.example.com/login or www.evil.io now";
    const inv = accessInviteNotice({
      inviter: evil,
      roleLabel: "Console access",
      scopeLabel: evil,
      areas: null,
      link: "https://key.plrs.im/manage/login?login_hint=a%40b.co",
      origin: "https://key.plrs.im",
    });
    const changed = accessChangedNotice({
      change: "granted",
      member: evil,
      actor: evil,
      roleLabel: "Console access",
      scopeLabel: evil,
      areas: null,
      origin: null,
    });
    const sent = accessInvitesSentNotice({
      actor: evil,
      count: 1,
      roleLabel: "Console access",
      scopeLabel: evil,
      areas: null,
      origin: null,
    });
    for (const m of [inv, changed, sent]) {
      const body = m.text.replace(/Sign in: \S+/, "");
      expect(body).not.toContain("https://evil");
      expect(body).not.toMatch(/evil\.example|evil\.io/);
      expect(body).toContain("evil[.]example[.]com");
      expect(body).toContain("www[.]evil[.]io");
      expect(m.html).not.toMatch(/evil\.example|evil\.io/);
    }
  });
});
