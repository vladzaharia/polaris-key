/**
 * ST-30c.3: the console's own sign-in methods (ST-28 SM-3(a) and (d), SM-4). Enrolment goes
 * through I-16 with the session's step-up as `authenticatedAt` (never `now`); "Use for the
 * console" marks one of the caller's console-eligible passkeys strong. Both audit as
 * `rbac.method_strong` and mail the account and every Superadmin.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW } from "../../seed.js";
import { SoftAuthenticator } from "../../softAuthenticator.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import { resetConsoleSessionCache } from "../../../src/console/consoleSession.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  STEP_UP_MAX_AGE_SECONDS,
  issueBreakGlassSession,
  issueSessionV2,
} from "../../../src/core/console/session.js";
import {
  consolePasskeyCeremony,
  consoleSignIn,
} from "../../../src/services/identity/public.js";
import { handleAccountPasskeys } from "../../../src/services/identity/passkeys/routes.js";
import {
  MAX_PASSKEYS_PER_ACCOUNT,
  insertPasskey,
} from "../../../src/services/identity/passkeys/repo.js";
import { insertLink } from "../../../src/services/identity/accounts/repo.js";
import { sessionIdHash } from "../../../src/services/identity/portal/accountSessions.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import { importHmacKey } from "../../../src/platform/hash.js";
import { signHmacToken } from "../../../src/platform/hmacToken.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const ORIGIN = "https://key.plrs.im";

type Db = ReturnType<typeof makeTestDb>;
interface Mail {
  to: string;
  subject: string;
  text: string;
}

let env: Env;
let db: Db;
let mail: Mail[];

beforeEach(() => {
  resetConsoleSessionCache();
  mail = [];
  env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  env.KEY_HASH_PEPPER = "test-pepper";
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  env.EMAIL = {
    send: async (m: Mail) => {
      mail.push(m);
    },
  } as unknown as Env["EMAIL"];
  db = makeTestDb();
});

interface Operator {
  accountId: string;
  sid: string;
  token: string;
  csrf: string;
}

/** An operator signed in through the console IdP, with a step-up at `stepUpAt` (or none). */
async function operator(
  n: number,
  stepUpAt: number | null = NOW,
): Promise<Operator> {
  const r = await consoleSignIn(
    env,
    db,
    {
      sub: `op-${n}`,
      email: `op${n}@example.com`,
      emailVerified: true,
      displayName: `Op ${n}`,
      groups: [GROUP],
    },
    { operator: true },
    NOW,
  );
  if (r.status !== "ok") throw new Error("fixture");
  const { token, claims } = await issueSessionV2(
    env,
    {
      aid: r.accountId,
      sid: r.sid,
      name: r.name,
      email: r.email,
      ...(stepUpAt === null ? {} : { authTime: stepUpAt, stepUp: true }),
    },
    NOW,
  );
  return { accountId: r.accountId, sid: r.sid, token, csrf: claims.csrf };
}

async function call(
  who: Pick<Operator, "token" | "csrf">,
  method: string,
  path: string,
  body?: unknown,
  now = NOW + 1,
  csrf: string | null = who.csrf,
) {
  return handleAdmin(
    new Request(`${ORIGIN}/manage${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${who.token}`,
        ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as unknown as Request,
    env,
    db,
    path,
    { now },
  );
}

/** The whole "Add a passkey" ceremony through the console routes. */
async function enrol(
  who: Operator,
  auth: SoftAuthenticator,
  now = NOW + 1,
): Promise<Response> {
  const start = await call(who, "POST", "/api/me/passkeys/options", {}, now);
  if (start.status !== 200) return start;
  const { options } = (await start.json()) as {
    options: Parameters<SoftAuthenticator["register"]>[0];
  };
  const response = await auth.register(options);
  return call(who, "POST", "/api/me/passkeys", { response }, now);
}

interface MethodView {
  id: string;
  kind: string;
  name: string | null;
  strong: boolean;
  consoleEligible: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}
async function methods(who: Operator): Promise<MethodView[]> {
  const res = await call(who, "GET", "/api/me/methods");
  expect(res.status).toBe(200);
  const text = await res.text();
  // PX-W17 (accountIdBoundary): a body names methods, never the account.
  expect(text).not.toContain(who.accountId);
  return (JSON.parse(text) as { methods: MethodView[] }).methods;
}

const audits = (action = "rbac.method_strong") =>
  db.all<{ actor_sub: string; summary: string; action: string }>(
    "SELECT * FROM platform_audit WHERE action = ?",
    action,
  );

const strongAt = (linkId: string) =>
  db.first<{ strong_at: number | null }>(
    "SELECT strong_at FROM account_links WHERE id = ?",
    linkId,
  );

/** A passkey stored the way the Locker account stores one (never strong), under `rpId`. */
async function portalPasskey(
  accountId: string,
  rpId = "key.plrs.im",
): Promise<string> {
  const auth = await SoftAuthenticator.create();
  const r = await insertPasskey(
    db,
    {
      accountId,
      credentialId: auth.id,
      publicKey: "AAAA",
      counter: 0,
      transports: [],
      rpId,
      userHandle: "h",
      details: {},
    },
    NOW,
  );
  if (r === "conflict") throw new Error("fixture");
  return r.linkId;
}

describe("SM-3(a): enrolment under a step-up", () => {
  it("adds a passkey that is strong at once, audits it as the member and mails the account and every Superadmin", async () => {
    const a = await operator(1);
    await operator(2);
    const auth = await SoftAuthenticator.create();
    const res = await enrol(a, auth);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      passkey: { methodId: string };
    };
    expect((await strongAt(body.passkey.methodId))!.strong_at).toBe(NOW + 1);
    const list = await methods(a);
    const pk = list.find((m) => m.id === body.passkey.methodId)!;
    expect(pk).toMatchObject({ kind: "passkey", strong: true });
    expect(pk.consoleEligible).toBe(false); // already strong
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_sub).toMatch(/^mbr_/);
    const to = mail
      .filter((m) => m.subject.startsWith("A passkey can now open"))
      .map((m) => m.to)
      .sort();
    expect(to).toContain("op1@example.com");
    expect(to).toContain("op2@example.com");
    expect(JSON.stringify(body)).not.toContain(a.accountId);
  });

  it("mails a Superadmin who adds one a single notice, the Superadmin copy, and every other Superadmin theirs", async () => {
    const a = await operator(1);
    await operator(2);
    const res = await enrol(a, await SoftAuthenticator.create());
    expect(res.status).toBe(201);
    const mine = mail.filter((m) => m.to === "op1@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain(
      "You get this because you are a Superadmin",
    );
    expect(mail.filter((m) => m.to === "op2@example.com")).toHaveLength(1);
    // I-16's own "sign-in method added" mail is not sent on the console path.
    expect(mail.some((m) => /method (was )?added/i.test(m.subject))).toBe(
      false,
    );
  });

  it("tells the owner of an add even when marking it strong fails: exactly one mail, nothing silent", async () => {
    const a = await operator(1);
    // Make the strong-marking a no-op, as a lost race or an unreadable link would.
    await db.run(
      "CREATE TRIGGER no_strong BEFORE UPDATE OF strong_at ON account_links BEGIN SELECT RAISE(IGNORE); END",
    );
    const res = await enrol(a, await SoftAuthenticator.create());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { passkey: { methodId: string } };
    expect((await strongAt(body.passkey.methodId))!.strong_at).toBeNull();
    expect(await audits()).toHaveLength(0);
    expect(mail.filter((m) => m.to === "op1@example.com")).toHaveLength(1);
    expect(mail).toHaveLength(1);
  });

  it("without a step-up, or after the window, the route table refuses before anything is written", async () => {
    const none = await operator(1, null);
    const r1 = await call(none, "POST", "/api/me/passkeys/options", {});
    expect(r1.status).toBe(403);
    expect(JSON.stringify(await r1.json())).toContain("step_up_required");
    const old = await operator(2, NOW);
    const later = NOW + STEP_UP_MAX_AGE_SECONDS + 5;
    const r2 = await call(old, "POST", "/api/me/passkeys/options", {}, later);
    expect(r2.status).toBe(403);
    const r3 = await call(old, "POST", "/api/me/passkeys", {}, later);
    expect(r3.status).toBe(403);
    expect(await audits()).toHaveLength(0);
    expect(
      await db.all(
        "SELECT 1 FROM account_passkeys WHERE account_id = ?",
        old.accountId,
      ),
    ).toHaveLength(0);
  });

  it("I-16 refuses a stale caller too, and a session with no step-up is passed the epoch, never now", async () => {
    const a = await operator(1, null);
    const req = new Request(`${ORIGIN}/manage/api/me/passkeys/options`, {
      method: "POST",
      body: "{}",
    });
    // Called past the route table, as a bug in it would: Identity still says no.
    const { response, strongLinkId } = await consolePasskeyCeremony(
      req,
      env,
      db,
      { accountId: a.accountId, sid: a.sid, stepUpAt: undefined },
      ["options"],
      NOW + 1,
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe(
      "step_up_required",
    );
    expect(strongLinkId).toBeNull();
    // Stale by one second past the window.
    const stale = await consolePasskeyCeremony(
      req,
      env,
      db,
      {
        accountId: a.accountId,
        sid: a.sid,
        stepUpAt: NOW - STEP_UP_MAX_AGE_SECONDS - 1,
      },
      ["options"],
      NOW,
    );
    expect(stale.response.status).toBe(401);
  });

  it("a passkey added in the Locker account is not strong (SM-4) until Use for the console", async () => {
    const a = await operator(1);
    const auth = await SoftAuthenticator.create();
    const caller = {
      accountId: a.accountId,
      authenticatedAt: NOW,
      sessionIdHash: await sessionIdHash(env, "portal-session"),
    };
    const portalReq = (path: string, body: unknown) =>
      new Request(`${ORIGIN}/api/me/passkeys${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const start = await handleAccountPasskeys(
      portalReq("/options", {}),
      env,
      db,
      caller,
      ["options"],
      NOW,
    );
    const { options } = (await start.json()) as {
      options: Parameters<SoftAuthenticator["register"]>[0];
    };
    const added = await handleAccountPasskeys(
      portalReq("", { response: await auth.register(options) }),
      env,
      db,
      caller,
      [],
      NOW,
    );
    expect(added.status).toBe(201);
    const { passkey } = (await added.json()) as {
      passkey: { methodId: string };
    };
    expect((await strongAt(passkey.methodId))!.strong_at).toBeNull();
    expect(await audits()).toHaveLength(0);
    const before = (await methods(a)).find((m) => m.id === passkey.methodId)!;
    expect(before).toMatchObject({ strong: false, consoleEligible: true });
    const res = await call(
      a,
      "POST",
      `/api/me/methods/${passkey.methodId}/strong`,
      {},
    );
    expect(res.status).toBe(200);
    expect((await strongAt(passkey.methodId))!.strong_at).toBe(NOW + 1);
    const after = (await methods(a)).find((m) => m.id === passkey.methodId)!;
    expect(after).toMatchObject({ strong: true, consoleEligible: false });
  });

  it("keeps I-16's verified-email and passkey-count rules", async () => {
    const a = await operator(1);
    await db.run(
      "UPDATE accounts SET primary_email_verified_at = NULL WHERE id = ?",
      a.accountId,
    );
    const r = await call(a, "POST", "/api/me/passkeys/options", {});
    expect(r.status).toBe(403);
    expect(((await r.json()) as { reason: string }).reason).toBe(
      "email_unverified",
    );
    await db.run(
      "UPDATE accounts SET primary_email_verified_at = ? WHERE id = ?",
      NOW,
      a.accountId,
    );
    for (let i = 0; i < MAX_PASSKEYS_PER_ACCOUNT; i++)
      await portalPasskey(a.accountId);
    const full = await call(a, "POST", "/api/me/passkeys/options", {});
    expect(full.status).toBe(403);
    expect(((await full.json()) as { reason: string }).reason).toBe("limit");
  });
});

describe("GET /me/methods: what the page needs to name a row and to disable Add", () => {
  it("returns I-16's aaguid and addedFrom for a passkey, null for other kinds, and never the account id", async () => {
    const a = await operator(1);
    const res = await enrol(a, await SoftAuthenticator.create());
    expect(res.status).toBe(201);
    const list = await methods(a);
    const pk = list.find((m) => m.kind === "passkey") as unknown as {
      aaguid: string | null;
      addedFrom: string | null;
    };
    expect(typeof pk.aaguid === "string" || pk.aaguid === null).toBe(true);
    expect("addedFrom" in pk).toBe(true);
    const other = list.find((m) => m.kind !== "passkey") as unknown as {
      aaguid: string | null;
      addedFrom: string | null;
    };
    expect(other).toMatchObject({ aaguid: null, addedFrom: null });
  });

  it("answers canAdd with I-16's reason: email_unverified, then limit, then ok", async () => {
    const a = await operator(1);
    const get = async () =>
      (await (await call(a, "GET", "/api/me/methods")).json()) as {
        canAdd: boolean;
        reason: string | null;
      };
    expect(await get()).toMatchObject({ canAdd: true, reason: null });
    await db.run(
      "UPDATE accounts SET primary_email_verified_at = NULL WHERE id = ?",
      a.accountId,
    );
    expect(await get()).toMatchObject({
      canAdd: false,
      reason: "email_unverified",
    });
    await db.run(
      "UPDATE accounts SET primary_email_verified_at = ? WHERE id = ?",
      NOW,
      a.accountId,
    );
    for (let i = 0; i < MAX_PASSKEYS_PER_ACCOUNT; i++)
      await portalPasskey(a.accountId);
    expect(await get()).toMatchObject({ canAdd: false, reason: "limit" });
  });
});

describe("SM-3(d): Use for the console", () => {
  it("needs a step-up", async () => {
    const a = await operator(1, null);
    const id = await portalPasskey(a.accountId);
    const res = await call(a, "POST", `/api/me/methods/${id}/strong`, {});
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("step_up_required");
    expect((await strongAt(id))!.strong_at).toBeNull();
    expect(await audits()).toHaveLength(0);
  });

  it("marks the caller's own passkey: audit row (actor mbr_) and mail to the account and every Superadmin", async () => {
    const a = await operator(1);
    await operator(2);
    const id = await portalPasskey(a.accountId);
    const res = await call(a, "POST", `/api/me/methods/${id}/strong`, {});
    expect(res.status).toBe(200);
    expect((await strongAt(id))!.strong_at).toBe(NOW + 1);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_sub).toMatch(/^mbr_/);
    const got = mail.filter((m) =>
      m.subject.startsWith("A passkey can now open"),
    );
    expect(got.map((m) => m.to)).toEqual(
      expect.arrayContaining(["op1@example.com", "op2@example.com"]),
    );
    // A second try is refused and writes nothing more.
    const again = await call(a, "POST", `/api/me/methods/${id}/strong`, {});
    expect(again.status).toBe(409);
    expect(await audits()).toHaveLength(1);
  });

  it("another account's link is a 404 and stays weak", async () => {
    const a = await operator(1);
    const b = await operator(2);
    const theirs = await portalPasskey(b.accountId);
    const res = await call(a, "POST", `/api/me/methods/${theirs}/strong`, {});
    expect(res.status).toBe(404);
    expect((await strongAt(theirs))!.strong_at).toBeNull();
    expect((await methods(a)).map((m) => m.id)).not.toContain(theirs);
  });

  it("refuses an email-code link and a passkey of another relying party (not_eligible)", async () => {
    const a = await operator(1);
    await insertLink(
      db,
      a.accountId,
      {
        issuerKey: "email",
        tenantScope: "",
        subject: "op1@example.com",
        kind: "email",
        email: "op1@example.com",
        emailVerified: true,
        displayName: null,
        amr: ["email"],
      },
      NOW,
    );
    const email = (await methods(a)).find((m) => m.kind === "email")!;
    expect(email.consoleEligible).toBe(false);
    const other = await portalPasskey(a.accountId, "polaris.locker");
    expect(
      (await methods(a)).find((m) => m.id === other)!.consoleEligible,
    ).toBe(false);
    for (const id of [email.id, other]) {
      const res = await call(a, "POST", `/api/me/methods/${id}/strong`, {});
      expect(res.status).toBe(403);
      expect(((await res.json()) as { reason: string }).reason).toBe(
        "not_eligible",
      );
      expect((await strongAt(id))!.strong_at).toBeNull();
    }
    expect(await audits()).toHaveLength(0);
  });
});

describe("who may call", () => {
  it("refuses a break-glass session (no account) on every route", async () => {
    const { token, session } = await issueBreakGlassSession(
      env,
      {
        sub: "idp-bg",
        email: "bg@example.com",
        groups: [GROUP],
        authTime: NOW,
        stepUp: true,
      },
      NOW,
    );
    const bg = { token, csrf: session.csrf };
    for (const [m, p, body] of [
      ["GET", "/api/me/methods", undefined],
      ["POST", "/api/me/passkeys/options", {}],
      ["POST", "/api/me/passkeys", {}],
      ["POST", "/api/me/methods/lnk_x/strong", {}],
    ] as const) {
      const res = await call(bg, m, p, body);
      expect(res.status, `${m} ${p}`).toBe(403);
      expect(JSON.stringify(await res.json())).toContain("break_glass_session");
    }
    expect(await audits()).toHaveLength(0);
  });

  it("refuses a v1 cookie (no session since ST-30c.8) and an admin API token", async () => {
    // An account-less v1 cookie, signed directly (the console no longer mints them).
    const v1Token = await signHmacToken(
      await importHmacKey(env.ADMIN_SESSION_SECRET!),
      "pkey.admin.v1|",
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: [GROUP],
        csrf: "c",
        exp: NOW + 8 * 3600,
        authAt: NOW,
        stepUpAt: NOW,
      },
    );
    const v1 = await call(
      { token: v1Token, csrf: "c" },
      "GET",
      "/api/me/methods",
    );
    expect(v1.status).toBe(401);
    // A stepped-up operator session mints the admin API token.
    const { token, session } = await consoleTestSession(
      env,
      db,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: [GROUP],
        authTime: NOW,
        stepUp: true,
      },
      NOW,
    );
    const minted = await call(
      { token, csrf: session.csrf },
      "POST",
      "/api/tokens",
      { label: "t", expiresInDays: 1, scopes: ["bundles:mint"] },
    );
    expect(minted.status).toBe(201);
    const secret = ((await minted.json()) as { secret: string }).secret;
    for (const [m, p] of [
      ["GET", "/api/me/methods"],
      ["POST", "/api/me/passkeys/options"],
      ["POST", "/api/me/methods/lnk_x/strong"],
    ] as const) {
      const res = await handleAdmin(
        new Request(`${ORIGIN}/manage${p}`, {
          method: m,
          headers: { authorization: `Bearer ${secret}` },
          ...(m === "POST" ? { body: "{}" } : {}),
        }) as unknown as Request,
        env,
        db,
        p,
        { now: NOW + 1 },
      );
      expect([401, 403], `${m} ${p}`).toContain(res.status);
    }
  });

  it("CSRF: a write without the header is refused", async () => {
    const a = await operator(1);
    const id = await portalPasskey(a.accountId);
    for (const [path, body] of [
      [`/api/me/methods/${id}/strong`, {}],
      ["/api/me/passkeys/options", {}],
      ["/api/me/passkeys", {}],
    ] as const) {
      const res = await call(a, "POST", path, body, NOW + 1, null);
      expect(res.status).toBe(403);
    }
    expect((await strongAt(id))!.strong_at).toBeNull();
  });

  it("the list is read-only and a PATCH, DELETE or removal route does not exist", async () => {
    const a = await operator(1);
    const id = await portalPasskey(a.accountId);
    for (const [m, p] of [
      ["DELETE", `/api/me/methods/${id}`],
      ["DELETE", `/api/me/passkeys/${id}`],
      ["PATCH", `/api/me/passkeys/${id}`],
      ["POST", "/api/me/methods"],
    ] as const) {
      const res = await call(a, m, p, {});
      expect([404, 405]).toContain(res.status);
    }
    expect(
      await db.all("SELECT 1 FROM account_links WHERE id = ?", id),
    ).toHaveLength(1);
  });
});
