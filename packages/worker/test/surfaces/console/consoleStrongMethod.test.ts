/**
 * ST-30 slice 2b: the strong-method rule (ST-28 SM-1 to SM-5), the computed root rule on
 * `asserted_at`, the audit actor as the member id with a sub mapping, and the account lifecycle
 * (merge, disable, delete) ending console eligibility on the link side.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { bindAdminFlow } from "../../flowBinderHelper.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../../seed.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  consoleRefusalCopy,
  handleAdminCallback,
  handleAdminLogin,
  type IdTokenVerifier,
} from "../../../src/console/auth.js";
import { resetConsoleSessionCache } from "../../../src/console/consoleSession.js";
import { handleActivity } from "../../../src/console/handlers/activity.js";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
} from "../../../src/core/console/session.js";
import { actorOf } from "../../../src/core/audit.js";
import { isMemberId, memberIdFor } from "../../../src/core/console/memberId.js";
import { rootRuleHolds } from "../../../src/core/rbac/principal.js";
import {
  consoleActorAliases,
  consoleSignIn,
  consoleSubject,
} from "../../../src/services/identity/public.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";
import {
  insertLink,
  markLinkStrong,
} from "../../../src/services/identity/accounts/repo.js";
import { mergeAccounts } from "../../../src/services/identity/accounts/merge.js";
import {
  deleteAccount,
  disableAccount,
} from "../../../src/services/identity/accounts/deletion.js";
import {
  getOrCreateAccountByIdentity,
  recordLinkAssertion,
  recordLinkGroups,
} from "../../../src/services/identity/portal/repo.js";
import { portalIdentityIssuerKey } from "../../../src/services/identity/portal/repo.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const ISSUER_KEY = portalIdentityIssuerKey(ISSUER);
const EIGHT_HOURS = ADMIN_SESSION_TTL_SECONDS;

function adminEnv(): Env {
  const env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  env.KEY_HASH_PEPPER = "test-pepper";
  return env;
}

type Db = ReturnType<typeof makeTestDb>;
type Claims = {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  groups?: string[];
};

async function signInThrough(
  env: Env,
  db: Db,
  claims: Claims = {},
  now = NOW,
): Promise<{ res: Response; token: string | null }> {
  const start = await handleAdminLogin(
    new Request("https://key.plrs.im/manage/login?go=1") as unknown as Request,
    env,
  );
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: claims.sub ?? "op-1",
      email: claims.email ?? "ada@example.com",
      emailVerified: claims.emailVerified ?? true,
      name: "Ada",
      groups: claims.groups ?? [GROUP],
    }),
  };
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: { cookie: await bindAdminFlow(env, state) },
    }) as unknown as Request,
    env,
    db,
    now,
    verifier,
  );
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  const token = cookie.startsWith(`${ADMIN_COOKIE}=`)
    ? cookie.slice(cookie.indexOf("=") + 1)
    : null;
  return { res, token };
}

async function me(env: Env, db: Db, token: string, now: number) {
  return handleAdmin(
    new Request("https://key.plrs.im/manage/api/me", {
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    }) as unknown as Request,
    env,
    db,
    "/api/me",
    { now },
  );
}

const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()) as {
    aid: string;
    sid: string;
  };

interface LinkRow {
  id: string;
  account_id: string;
  strong_at: number | null;
  asserted_at: number | null;
  groups_json: string | null;
  last_used_at: number;
}
const consoleLink = (db: Db, subject = "op-1") =>
  db.first<LinkRow>(
    "SELECT * FROM account_links WHERE issuer_key = ? AND subject = ?",
    ISSUER_KEY,
    subject,
  );

/** Everything a refused sign-in must leave untouched. */
async function snapshot(db: Db): Promise<string> {
  return JSON.stringify({
    accounts: await db.all("SELECT * FROM accounts ORDER BY id"),
    links: await db.all("SELECT * FROM account_links ORDER BY id"),
    sessions: await db.all("SELECT * FROM account_sessions ORDER BY id_hash"),
    audit: await db.all("SELECT * FROM portal_audit ORDER BY id"),
  });
}

/** An account that signed in with an email code only (the weak method). */
async function emailPerson(db: Db, email: string) {
  const r = await signIn(
    db,
    {
      issuerKey: "email",
      subject: email,
      kind: "email",
      email,
      emailVerified: true,
    },
    NOW,
    { unfenced: true },
  );
  if (r.status !== "signed_in") throw new Error("fixture");
  return r;
}

const ident = (o: Partial<Parameters<typeof consoleSignIn>[2]> = {}) => ({
  sub: "op-1",
  email: "ada@example.com",
  emailVerified: true,
  displayName: "Ada",
  groups: [GROUP],
  ...o,
});

beforeEach(() => resetConsoleSessionCache());

describe("SM-1 and SM-3: the console needs a strong method", () => {
  it("SM-3(b)+(c): an operator's first sign-in creates a link marked strong, and the session opens", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { res, token } = await signInThrough(env, db);
    expect(res.status).toBe(302);
    const link = await consoleLink(db);
    expect(link!.strong_at).toBe(NOW);
    expect(link!.asserted_at).toBe(NOW);
    expect((await me(env, db, token!, NOW + 1)).status).toBe(200);
  });

  it("SM-3(b): a link CREATED by a console-IdP sign-in is strong even when the token asserts no group", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const r = await consoleSignIn(
      env,
      db,
      ident({ groups: [] }),
      { operator: false },
      NOW,
    );
    expect(r.status).toBe("ok");
    expect((await consoleLink(db))!.strong_at).toBe(NOW);
  });

  it("SM-3(c): today's operator, whose link predates strong_at, is marked at the sign-in that asserts the group", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const legacy = await getOrCreateAccountByIdentity(
      db,
      {
        provider: ISSUER_KEY,
        subject: "op-1",
        email: "ada@example.com",
        groups: [GROUP],
      },
      NOW - 100,
    );
    expect(legacy).toBeTruthy();
    expect((await consoleLink(db))!.strong_at).toBeNull();
    const { res, token } = await signInThrough(env, db, {}, NOW);
    expect(res.status).toBe(302);
    expect((await consoleLink(db))!.strong_at).toBe(NOW);
    expect((await me(env, db, token!, NOW + 1)).status).toBe(200);
  });

  it("SM-1 refused: a known link that is not strong, without the group asserted, is refused and writes nothing", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await getOrCreateAccountByIdentity(
      db,
      {
        provider: ISSUER_KEY,
        subject: "op-1",
        email: "ada@example.com",
        groups: [GROUP],
      },
      NOW - 100,
    );
    const before = await snapshot(db);
    const r = await consoleSignIn(
      env,
      db,
      ident({ groups: [] }),
      { operator: false },
      NOW,
    );
    expect(r).toEqual({ status: "refused", reason: "method" });
    expect(await snapshot(db)).toBe(before);
    expect((await consoleLink(db))!.strong_at).toBeNull();
  });

  it("SM-1 refused: an email-code-only account is refused, even with the IdP's verified address", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await emailPerson(db, "ada@example.com");
    // Not an operator (no group): it may not join the email-code account, and nothing is written.
    const before = await snapshot(db);
    const r = await consoleSignIn(
      env,
      db,
      ident({ groups: [] }),
      { operator: false },
      NOW,
    );
    expect(r).toEqual({ status: "refused", reason: "join" });
    expect(await snapshot(db)).toBe(before);
    // The email-code account itself has no console-IdP link, so it has no subject at all.
    const acct = await db.first<{ id: string }>("SELECT id FROM accounts");
    await db.run(
      "INSERT INTO account_sessions (id_hash, account_id, created_at, last_seen_at, expires_at, revoked_at, user_agent, amr_json) VALUES ('h', ?, ?, ?, ?, NULL, NULL, '[]')",
      acct!.id,
      NOW,
      NOW,
      NOW + 1000,
    );
    // consoleSubject hashes the sid; a row keyed by that hash is the live-session fixture.
    const { sessionIdHash } =
      await import("../../../src/services/identity/portal/accountSessions.js");
    await db.run(
      "UPDATE account_sessions SET id_hash = ?",
      await sessionIdHash(env, "sid-weak"),
    );
    expect(
      await consoleSubject(
        env,
        db,
        { aid: acct!.id, sid: "sid-weak" },
        NOW + 1,
      ),
    ).toBeNull();
  });

  it("an email-code-only operator who the IdP vouches for joins their account and is marked strong (SM-3(b))", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const weak = await emailPerson(db, "ada@example.com");
    const { res, token } = await signInThrough(env, db);
    expect(res.status).toBe(302);
    const link = await consoleLink(db);
    expect(link!.account_id).toBe(weak.account.id);
    expect(link!.strong_at).toBe(NOW);
    // The email link stays weak: SM-4.
    const email = await db.first<{ strong_at: number | null }>(
      "SELECT strong_at FROM account_links WHERE issuer_key = 'email'",
    );
    expect(email!.strong_at).toBeNull();
    expect((await me(env, db, token!, NOW + 1)).status).toBe(200);
  });

  it("an operator whose address the IdP did not verify never joins the email-code account: it gets its own, and the email link stays weak", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const weak = await emailPerson(db, "ada@example.com");
    const { res } = await signInThrough(env, db, { emailVerified: false });
    expect(res.status).toBe(302);
    const link = (await consoleLink(db))!;
    expect(link.account_id).not.toBe(weak.account.id);
    const email = await db.first<{ strong_at: number | null }>(
      "SELECT strong_at FROM account_links WHERE issuer_key = 'email'",
    );
    expect(email!.strong_at).toBeNull();
  });

  it("the card for a method refusal says what to use", () => {
    expect(consoleRefusalCopy("method")).toEqual({
      title: "That sign-in can’t open this console",
      lede: "Use your company account or a passkey. An email code can’t.",
    });
    expect(consoleRefusalCopy("join").title).toBe(
      "We couldn’t open your account",
    );
  });

  it("SM-1 per request: a session whose link lost strong_at is refused at the next check", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    expect((await me(env, db, token!, NOW + 1)).status).toBe(200);
    await db.run("UPDATE account_links SET strong_at = NULL");
    expect((await me(env, db, token!, NOW + 40)).status).toBe(401);
  });

  it("SM-2: a strong link through an issuer that is not the console IdP never opens the console, allowlisted or not", async () => {
    const env = adminEnv();
    env.OIDC_ISSUER_ALLOWLIST = "other.example";
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const claims = claimsOf(token!);
    // The same person's only link moves to another issuer: no console-IdP link, no subject.
    await db.run(
      "UPDATE account_links SET issuer_key = 'https://other.example'",
    );
    expect(await consoleSubject(env, db, claims, NOW + 1)).toBeNull();
    // And with the console IdP no longer configured, even the right link answers null.
    await db.run("UPDATE account_links SET issuer_key = ?", ISSUER_KEY);
    expect(await consoleSubject(env, db, claims, NOW + 1)).not.toBeNull();
    delete env.PLATFORM_OIDC_ISSUER;
    expect(await consoleSubject(env, db, claims, NOW + 1)).toBeNull();
  });

  it("SM-4: a console-IdP link made through the portal path is not strong, and asserting groups there does not make it so", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await getOrCreateAccountByIdentity(
      db,
      { provider: ISSUER_KEY, subject: "op-9", groups: [GROUP] },
      NOW,
    );
    const link = await consoleLink(db, "op-9");
    expect(link!.strong_at).toBeNull();
    expect(link!.asserted_at).toBe(NOW);
    const r = await consoleSignIn(
      env,
      db,
      ident({ sub: "op-9", groups: [] }),
      { operator: false },
      NOW + 5,
    );
    expect(r).toEqual({ status: "refused", reason: "method" });
  });

  it("markLinkStrong is account-scoped: another account's link changes nothing and is refused; the owner's marks once", async () => {
    const db = makeTestDb();
    await getOrCreateAccountByIdentity(
      db,
      { provider: ISSUER_KEY, subject: "op-a", groups: [] },
      NOW,
    );
    await getOrCreateAccountByIdentity(
      db,
      { provider: ISSUER_KEY, subject: "op-b", groups: [] },
      NOW,
    );
    const a = (await consoleLink(db, "op-a"))!;
    const b = (await consoleLink(db, "op-b"))!;
    expect(a.account_id).not.toBe(b.account_id);
    expect(await markLinkStrong(db, a.account_id, b.id, NOW + 1)).toBe(false);
    expect((await consoleLink(db, "op-b"))!.strong_at).toBeNull();
    expect(await markLinkStrong(db, a.account_id, "missing", NOW + 1)).toBe(
      false,
    );
    expect(await markLinkStrong(db, a.account_id, a.id, NOW + 2)).toBe(true);
    expect(await markLinkStrong(db, a.account_id, a.id, NOW + 9)).toBe(true);
    expect((await consoleLink(db, "op-a"))!.strong_at).toBe(NOW + 2);
  });

  it("SM-5: removing the strong method ends entry, not the account; a re-added method is not strong", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await emailPerson(db, "ada@example.com");
    const { token } = await signInThrough(env, db);
    const claims = claimsOf(token!);
    expect((await me(env, db, token!, NOW + 1)).status).toBe(200);
    await db.run("DELETE FROM account_links WHERE issuer_key = ?", ISSUER_KEY);
    expect((await me(env, db, token!, NOW + 40)).status).toBe(401);
    const acct = await db.first<{ status: string }>(
      "SELECT status FROM accounts WHERE id = ?",
      claims.aid,
    );
    expect(acct!.status).toBe("active");
    const rest = await db.all("SELECT * FROM account_links");
    expect(rest).toHaveLength(1);
    // Re-adding the same method from the portal (the account-linking path) leaves it weak (SM-4),
    // even with fresh groups on it.
    const readded = await insertLink(
      db,
      claims.aid,
      {
        issuerKey: ISSUER_KEY,
        tenantScope: "",
        subject: "op-1",
        kind: "oidc",
        email: "ada@example.com",
        emailVerified: true,
        displayName: "Ada",
        amr: null,
      },
      NOW + 50,
    );
    expect(readded).toBeTruthy();
    const back = (await consoleLink(db))!;
    await recordLinkGroups(db, back.id, [GROUP], NOW + 60);
    expect((await consoleLink(db))!.strong_at).toBeNull();
    expect(await consoleSubject(env, db, claims, NOW + 100)).toBeNull();
  });
});

describe("the computed root rule", () => {
  const cfg = { PLATFORM_ADMIN_GROUP: GROUP };
  const link = (o: Partial<Parameters<typeof rootRuleHolds>[1]> = {}) => ({
    strongAt: NOW,
    assertedAt: NOW,
    groups: [GROUP],
    ...o,
  });

  it("holds for a strong link, the group, an assertion under 8 h old", () => {
    expect(rootRuleHolds(cfg, link(), NOW, EIGHT_HOURS)).toBe(true);
    expect(rootRuleHolds(cfg, link(), NOW + EIGHT_HOURS, EIGHT_HOURS)).toBe(
      true,
    );
  });

  it("fails on each missing condition", () => {
    expect(rootRuleHolds(cfg, link(), NOW + EIGHT_HOURS + 1, EIGHT_HOURS)).toBe(
      false,
    );
    expect(
      rootRuleHolds(cfg, link({ assertedAt: null }), NOW, EIGHT_HOURS),
    ).toBe(false);
    expect(rootRuleHolds(cfg, link({ strongAt: null }), NOW, EIGHT_HOURS)).toBe(
      false,
    );
    expect(rootRuleHolds(cfg, link({ groups: ["x"] }), NOW, EIGHT_HOURS)).toBe(
      false,
    );
    expect(rootRuleHolds({}, link(), NOW, EIGHT_HOURS)).toBe(false);
    // The skew edge: 60 s ahead is allowed, 61 s ahead is not.
    expect(
      rootRuleHolds(cfg, link({ assertedAt: NOW + 60 }), NOW, EIGHT_HOURS),
    ).toBe(true);
    expect(
      rootRuleHolds(cfg, link({ assertedAt: NOW + 61 }), NOW, EIGHT_HOURS),
    ).toBe(false);
    // An assertion from the future (beyond skew) is not fresh.
    expect(
      rootRuleHolds(cfg, link({ assertedAt: NOW + 3600 }), NOW, EIGHT_HOURS),
    ).toBe(false);
  });

  it("consoleSubject: root true at 8 h, false after it with no groups offered", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const claims = claimsOf(token!);
    // Keep the session row alive past 8 h so the age alone decides.
    await db.run("UPDATE account_sessions SET expires_at = ?", NOW + 99999);
    const fresh = await consoleSubject(env, db, claims, NOW + EIGHT_HOURS);
    expect(fresh!.root).toBe(true);
    expect(fresh!.groups).toEqual([GROUP]);
    const stale = await consoleSubject(env, db, claims, NOW + EIGHT_HOURS + 1);
    expect(stale).not.toBeNull();
    expect(stale!.root).toBe(false);
    expect(stale!.groups).toEqual([]);
  });

  it("over HTTP: a stale assertion leaves a valid session with no console grant", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    expect((await me(env, db, token!, NOW + 1)).status).toBe(200);
    await db.run(
      "UPDATE account_links SET asserted_at = ?",
      NOW - EIGHT_HOURS - 1,
    );
    const r = await me(env, db, token!, NOW + 40);
    // The session is live, the person is not a member any more: no area, no console.
    expect(r.status).toBe(200);
    const body = (await r.json()) as { platformAdmin: boolean };
    expect(body.platformAdmin).toBe(false);
    const api = await handleAdmin(
      new Request("https://key.plrs.im/manage/api/platform/activity", {
        headers: { cookie: `${ADMIN_COOKIE}=${token}` },
      }) as unknown as Request,
      env,
      db,
      "/api/platform/activity",
      { now: NOW + 41 },
    );
    expect([401, 403]).toContain(api.status);
  });

  it("asserted_at moves only with the groups: sign-ins that rewrite none leave it alone", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await signInThrough(env, db);
    const link0 = (await consoleLink(db))!;
    expect(link0.asserted_at).toBe(NOW);
    // A bare signIn through the same identity (touchLink moves last_used_at) does not move it.
    const bare = await signIn(
      db,
      { issuerKey: ISSUER_KEY, subject: "op-1", kind: "oidc" },
      NOW + 500,
      { unfenced: true },
    );
    expect(bare.status).toBe("signed_in");
    const link1 = (await consoleLink(db))!;
    expect(link1.last_used_at).toBe(NOW + 500);
    expect(link1.asserted_at).toBe(NOW);
    // The groups writer moves both; an absent assertion clears both.
    await recordLinkGroups(db, link0.id, [GROUP], NOW + 600);
    expect((await consoleLink(db))!.asserted_at).toBe(NOW + 600);
    await recordLinkGroups(db, link0.id, undefined, NOW + 700);
    const cleared = (await consoleLink(db))!;
    expect(cleared.groups_json).toBeNull();
    expect(cleared.asserted_at).toBeNull();
    // A connection sign-in on the console IdP's issuer never writes the groups or `asserted_at`.
    await recordLinkGroups(db, link0.id, [GROUP], NOW + 800);
    await recordLinkAssertion(
      env,
      db,
      link0.id,
      { groups: null, claims: { team: "x" }, connectionId: "ops" },
      NOW + 900,
    );
    const kept = (await consoleLink(db))!;
    expect(kept.asserted_at).toBe(NOW + 800);
    expect(kept.groups_json).toBe(JSON.stringify([GROUP]));
  });

  it("a v1 cookie keeps its groups-only behaviour until it expires", async () => {
    // A v1 session has no `root`: the principal falls back to its groups (the cookie's own 8 h).
    const { resolvePrincipal } =
      await import("../../../src/core/rbac/principal.js");
    const p = await resolvePrincipal(
      cfg,
      null,
      { sub: "op-1", groups: [GROUP] },
      NOW,
    );
    expect(p.grants).toHaveLength(1);
    const q = await resolvePrincipal(
      cfg,
      null,
      { sub: "mbr_x", groups: [GROUP], root: false },
      NOW,
    );
    expect(q.grants).toHaveLength(0);
  });
});

describe("the audit actor is the member id", () => {
  it("is mbr_ + 22 characters, stable per account, keyed by the pepper, and never the account id", async () => {
    const env = adminEnv();
    const a = await memberIdFor(env, "acct_1");
    expect(isMemberId(a)).toBe(true);
    expect(a).toBe(await memberIdFor(env, "acct_1"));
    expect(a).not.toBe(await memberIdFor(env, "acct_2"));
    expect(a).not.toContain("acct_1");
    const other = { ...env, KEY_HASH_PEPPER: "another" } as Env;
    expect(await memberIdFor(other, "acct_1")).not.toBe(a);
    const unkeyed = { ...env, KEY_HASH_PEPPER: undefined } as Env;
    expect(isMemberId(await memberIdFor(unkeyed, "acct_1"))).toBe(true);
  });

  it("a console write records the member id, and the activity filter finds old and new rows under either id", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    await seedProduct(db, "alpha");
    const { token } = await signInThrough(env, db);
    const claims = claimsOf(token!);
    const { resolveConsoleCaller } =
      await import("../../../src/console/api.js");
    const caller = await resolveConsoleCaller(
      env,
      db,
      new Request("https://key.plrs.im/manage/api/me", {
        headers: { cookie: `${ADMIN_COOKIE}=${token}` },
      }),
      NOW + 1,
    );
    const session = caller!.session;
    const mbr = await memberIdFor(env, claims.aid);
    expect(actorOf(session).sub).toBe(mbr);
    expect(session.idpSub).toBe("op-1");

    const row = (id: string, sub: string, at: number) =>
      db.run(
        `INSERT INTO audit (product, id, at, actor_sub, actor_name, actor_email, action,
           target_kind, target_id, parent_id, summary)
         VALUES ('alpha', ?, ?, ?, NULL, NULL, 'a', 'product', 'alpha', NULL, 's')`,
        id,
        at,
        sub,
      );
    await row("aud_old", "op-1", NOW); // written before the console named actors by member id
    await row("aud_new", mbr, NOW + 1);
    await row("aud_other", "someone-else", NOW + 2);

    const ids = async (actor: string) => {
      const res = await handleActivity(
        new Request(`https://key.plrs.im/x?actor=${encodeURIComponent(actor)}`),
        env,
        db,
        "alpha",
      );
      const body = (await res.json()) as { items: { id: string }[] };
      return body.items.map((i) => i.id).sort();
    };
    expect(await ids(mbr)).toEqual(["aud_new", "aud_old"]);
    expect(await ids("op-1")).toEqual(["aud_new", "aud_old"]);
    expect(await ids("someone-else")).toEqual(["aud_other"]);
    // A member id nobody holds matches only itself.
    expect(await ids("mbr_AAAAAAAAAAAAAAAAAAAAAA")).toEqual([]);
  });

  it("consoleActorAliases maps both ways and gives an unknown actor back alone", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const mbr = await memberIdFor(env, claimsOf(token!).aid);
    expect((await consoleActorAliases(env, db, mbr)).sort()).toEqual(
      [mbr, "op-1"].sort(),
    );
    expect((await consoleActorAliases(env, db, "op-1")).sort()).toEqual(
      [mbr, "op-1"].sort(),
    );
    expect(await consoleActorAliases(env, db, "nobody")).toEqual(["nobody"]);
  });

  it("/me answers the member id and the prior subject, and old records still read as 'you'", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const body = (await (await me(env, db, token!, NOW + 1)).json()) as {
      sub: string;
      priorSubs: string[];
    };
    expect(isMemberId(body.sub)).toBe(true);
    expect(body.priorSubs).toEqual(["op-1"]);
  });
});

describe("hardening round", () => {
  it("c: the member id resolves with indexed reads regardless of how many links exist", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const mbr = await memberIdFor(env, claimsOf(token!).aid);
    const link = (await consoleLink(db))!;
    expect(
      (await db.first<{ member_id: string }>(
        "SELECT member_id FROM account_links WHERE id = ?",
        link.id,
      ))!.member_id,
    ).toBe(mbr);
    // 3000 other console-IdP links: the old scan capped at 2000 and missed this one.
    await db.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
       INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
                                  email_verified, created_at, last_used_at)
       SELECT 'lnk_bulk' || i, ?, ?, '', 'bulk' || i, 'oidc', 0, 1, 1 FROM n`,
      link.account_id,
      ISSUER_KEY,
    );
    const reads: string[] = [];
    const real = db.all.bind(db);
    const realFirst = db.first.bind(db);
    db.all = (async (...a: Parameters<typeof real>) => {
      reads.push(String(a[0]));
      return real(...a);
    }) as typeof db.all;
    db.first = (async (...a: Parameters<typeof realFirst>) => {
      reads.push(String(a[0]));
      return realFirst(...a);
    }) as typeof db.first;
    const aliases = await consoleActorAliases(env, db, mbr);
    expect(aliases).toContain("op-1");
    expect(aliases).toContain(mbr);
    expect(reads.length).toBeLessThanOrEqual(3);
    expect(reads.join("\n")).not.toMatch(/LIMIT 2000/);
    // A planted member_id on another account's link never maps: the id is recomputed.
    await emailPerson(db, "eve@example.com");
    const eve = await db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE issuer_key = 'email'",
    );
    await db.run(
      "UPDATE account_links SET member_id = ? WHERE id = ?",
      "mbr_AAAAAAAAAAAAAAAAAAAAAA",
      eve!.id,
    );
    expect(
      await consoleActorAliases(env, db, "mbr_AAAAAAAAAAAAAAAAAAAAAA"),
    ).toEqual(["mbr_AAAAAAAAAAAAAAAAAAAAAA"]);
  });

  it("f: the member id is keyed by a derived member key, not the pepper over a text prefix", async () => {
    const env = adminEnv();
    const id = await memberIdFor(env, "acct_1");
    const { hmacSha256, importHmacKey } =
      await import("../../../src/platform/hash.js");
    const { b64urlEncode } = await import("../../../src/platform/bytes.js");
    const old = await hmacSha256(
      await importHmacKey(env.KEY_HASH_PEPPER!),
      "console-member|acct_1",
    );
    expect(id).not.toBe("mbr_" + b64urlEncode(old).slice(0, 22));
    const key = await crypto.subtle.importKey(
      "raw",
      (await hmacSha256(
        await importHmacKey(env.KEY_HASH_PEPPER!),
        "pkey/console-member-key/v1",
      )) as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("acct_1")),
    );
    expect(id).toBe("mbr_" + b64urlEncode(mac).slice(0, 22));
  });
});

describe("merge, disable and delete end console eligibility", () => {
  const ctx = (env: Env, db: Db, now: number) => ({
    db,
    env,
    now,
    origin: "https://key.plrs.im",
  });

  it("merge: the absorbed operator account's links lose strength, and its console session ends", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const op = claimsOf(token!).aid;
    const survivor = await emailPerson(db, "keep@example.com");
    expect((await me(env, db, token!, NOW + 1)).status).toBe(200);
    const merged = await mergeAccounts(ctx(env, db, NOW + 2), {
      survivor: { accountId: survivor.account.id, authenticatedAt: NOW + 2 },
      absorbed: { accountId: op, authenticatedAt: NOW + 2 },
    });
    expect(merged.ok).toBe(true);
    const moved = (await consoleLink(db))!;
    expect(moved.account_id).toBe(survivor.account.id);
    expect(moved.strong_at).toBeNull();
    expect(moved.asserted_at).toBeNull();
    expect((await me(env, db, token!, NOW + 40)).status).toBe(401);
    // The survivor does not inherit console entry: it has a link but none is strong.
    expect(
      await consoleSubject(
        env,
        db,
        { aid: survivor.account.id, sid: claimsOf(token!).sid },
        NOW + 41,
      ),
    ).toBeNull();
  });

  it("merge: the survivor keeps its own strong link", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const op = claimsOf(token!).aid;
    const absorbed = await emailPerson(db, "gone@example.com");
    const merged = await mergeAccounts(ctx(env, db, NOW + 2), {
      survivor: { accountId: op, authenticatedAt: NOW + 2 },
      absorbed: { accountId: absorbed.account.id, authenticatedAt: NOW + 2 },
    });
    expect(merged.ok).toBe(true);
    expect((await consoleLink(db))!.strong_at).toBe(NOW);
    expect((await me(env, db, token!, NOW + 40)).status).toBe(200);
  });

  it("disable: sessions end, strength clears, and re-enabling does not bring console access back", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const op = claimsOf(token!).aid;
    expect((await me(env, db, token!, NOW + 1)).status).toBe(200);
    const r = await disableAccount(ctx(env, db, NOW + 2), op);
    expect(r.ok).toBe(true);
    const link = (await consoleLink(db))!;
    expect(link.strong_at).toBeNull();
    expect(link.asserted_at).toBeNull();
    const rows = await db.all<{ revoked_at: number | null }>(
      "SELECT revoked_at FROM account_sessions",
    );
    expect(rows.every((s) => s.revoked_at !== null)).toBe(true);
    expect((await me(env, db, token!, NOW + 40)).status).toBe(401);
    await db.run("UPDATE accounts SET status = 'active'");
    resetConsoleSessionCache();
    expect((await me(env, db, token!, NOW + 80)).status).toBe(401);
    // The person can sign in through the IdP again, which marks the link anew.
    const again = await signInThrough(env, db, {}, NOW + 100);
    expect(again.res.status).toBe(302);
    expect((await me(env, db, again.token!, NOW + 101)).status).toBe(200);
  });

  it("a: disable changes status, sessions and strength in one batch (and a failure leaves none)", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const op = claimsOf(token!).aid;
    const batches: number[] = [];
    const real = db.batch.bind(db);
    db.batch = (async (stmts: Parameters<typeof real>[0]) => {
      batches.push(stmts.length);
      return real(stmts);
    }) as typeof db.batch;
    expect((await disableAccount(ctx(env, db, NOW + 2), op)).ok).toBe(true);
    // One batch holds the status flip, the sessions and the strength clear.
    expect(batches.some((n) => n >= 3)).toBe(true);
    // A failing batch applies nothing: strength stays with the (still active) account.
    const db2 = makeTestDb();
    const t2 = await signInThrough(env, db2);
    const op2 = claimsOf(t2.token!).aid;
    db2.batch = (async () => {
      throw new Error("d1 down");
    }) as typeof db2.batch;
    await expect(disableAccount(ctx(env, db2, NOW + 2), op2)).rejects.toThrow();
    const st = await db2.first<{ status: string }>(
      "SELECT status FROM accounts WHERE id = ?",
      op2,
    );
    expect(st!.status).toBe("active");
    expect((await consoleLink(db2))!.strong_at).toBe(NOW);
    // Already disabled: not ok, nothing to do.
    expect((await disableAccount(ctx(env, db, NOW + 3), op)).ok).toBe(false);
  });

  it("delete: the console session ends and no link stays eligible", async () => {
    const env = adminEnv();
    const db = makeTestDb();
    const { token } = await signInThrough(env, db);
    const op = claimsOf(token!).aid;
    expect((await me(env, db, token!, NOW + 1)).status).toBe(200);
    await deleteAccount(ctx(env, db, NOW + 2), op);
    const link = await consoleLink(db);
    if (link) {
      expect(link.strong_at).toBeNull();
      expect(link.asserted_at).toBeNull();
    }
    expect((await me(env, db, token!, NOW + 40)).status).toBe(401);
  });
});
