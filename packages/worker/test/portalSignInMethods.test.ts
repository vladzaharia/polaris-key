// PX-W12 (PORTAL.md §4.26, §10.2 G27): Account → Sign-in methods. The methods list, connecting
// an email by code, disconnecting under step-up with the never-orphan guard and the only-email
// rule, and the audit row and notice every change writes. Provider connects (Google through its
// registered callback) are in the second half, on the recorded provider harness.

import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import {
  Device,
  lastCode,
  seededWorld,
  type CardWorld,
} from "./identityCardHarness.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { ACCOUNT_SESSION_COOKIE } from "../src/core/accounts/accountCookies.js";
import { PORTAL_CSRF_HEADER } from "../src/services/identity/portal/session.js";
import { STEP_UP_MAX_AGE_SECONDS } from "../src/services/identity/accounts/links.js";
import {
  cookieFrom,
  googleClaims,
  makeProviderHarness,
  nowSec,
  type ProviderHarness,
} from "./identityProviderHarness.js";
import { SIGNIN_BIND_COOKIE } from "../src/services/identity/providers/flow.js";
import { resetProviderCaches } from "../src/services/identity/providers/discovery.js";

const METHODS = "/api/me/methods";
const STALE = NOW + STEP_UP_MAX_AGE_SECONDS + 60;

interface Signed {
  d: Device;
  accountId: string;
}

async function emailAccount(
  w: CardWorld,
  email = "ada@example.com",
  now = NOW,
): Promise<Signed> {
  const d = new Device(w);
  expect((await d.signInWithCode(email, now)).status).toBe(200);
  expect((await d.me(now)).status).toBe(200);
  const row = await w.db.first<{ id: string }>(
    "SELECT id FROM accounts WHERE primary_email = ?",
    email,
  );
  return { d, accountId: row!.id };
}

/** An account whose only method is Steam (no email), signed in at `now`. */
async function steamOnlyAccount(
  w: CardWorld,
  id = "acct_steamonly",
  now = NOW,
): Promise<Signed> {
  await w.db.run(
    `INSERT INTO accounts (id, status, primary_email, primary_email_verified_at, display_name,
                           created_at, modified_at, last_sign_in_at)
     VALUES (?, 'active', NULL, NULL, 'marafox', ?, ?, ?)`,
    id,
    now,
    now,
    now,
  );
  await addSteam(w, id, `lnk_steam_${id}`, `7656119800000${id.length}`, now);
  const d = new Device(w);
  const { token } = await issuePortalSessionRow(
    w.env,
    w.db,
    { accountId: id, name: "marafox", email: null },
    now,
    ["steam"],
  );
  d.jar.set(ACCOUNT_SESSION_COOKIE, token);
  expect((await d.me(now)).status).toBe(200);
  return { d, accountId: id };
}

async function addSteam(
  w: CardWorld,
  accountId: string,
  linkId = "lnk_steam",
  subject = "76561198000000000",
  now = NOW,
): Promise<void> {
  await w.db.run(
    `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
                                email, email_verified, display_name, created_at, last_used_at)
     VALUES (?, ?, 'steam', '', ?, 'steam', NULL, 0, 'marafox', ?, ?)`,
    linkId,
    accountId,
    subject,
    now,
    now,
  );
}

async function audit(w: CardWorld, accountId: string): Promise<string[]> {
  return (
    await w.db.all<{ action: string }>(
      "SELECT action FROM portal_audit WHERE account_id = ? ORDER BY at, id",
      accountId,
    )
  ).map((r) => r.action);
}

interface MethodsBody {
  methods: Array<{
    id: string;
    kind: string;
    group: string;
    display: string | null;
    canRemove: boolean;
    reason: string | null;
  }>;
  emails: Array<{ email: string; primary: boolean; canRemove: boolean }>;
  providers: Array<{ kind: string; connected: boolean; available: boolean }>;
  passkey: { canAdd: boolean; reason: string | null };
  primaryEmail: string | null;
  hideMyEmail: boolean;
  stepUp: { fresh: boolean; maxAgeSeconds: number };
}

async function methods(d: Device, now = NOW): Promise<MethodsBody> {
  const res = await d.send("GET", METHODS, undefined, { now });
  expect(res.status).toBe(200);
  return (await res.json()) as MethodsBody;
}

describe("GET /api/me/methods", () => {
  it("needs a session", async () => {
    const w = await seededWorld();
    const res = await new Device(w).send("GET", METHODS);
    expect(res.status).toBe(401);
  });

  it("lists every method grouped, Apple, Google and Steam always, and the step-up state", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    // Connected a second after the email, so the list's oldest-first order is fixed.
    await addSteam(w, accountId, "lnk_steam", "76561198000000000", NOW + 1);
    const body = await methods(d);
    expect(body.methods.map((m) => [m.kind, m.group, m.display])).toEqual([
      ["email", "email", "ada@example.com"],
      ["steam", "accounts", "marafox"],
    ]);
    expect(body.methods.every((m) => m.canRemove)).toBe(false);
    // The only email is the primary: it stays; Steam can go.
    expect(body.emails).toEqual([
      expect.objectContaining({
        email: "ada@example.com",
        primary: true,
        canRemove: false,
      }),
    ]);
    expect(body.providers.map((p) => [p.kind, p.connected])).toEqual([
      ["google", false],
      ["apple", false],
      ["steam", true],
    ]);
    expect(body.primaryEmail).toBe("ada@example.com");
    expect(body.hideMyEmail).toBe(false);
    expect(body.passkey.canAdd).toBe(true);
    expect(body.stepUp).toEqual(
      expect.objectContaining({ fresh: true, maxAgeSeconds: 300 }),
    );
    expect((await methods(d, STALE)).stepUp.fresh).toBe(false);
    // Nothing developer-facing: no subject, no account id.
    expect(JSON.stringify(body)).not.toContain(accountId);
    expect(JSON.stringify(body)).not.toContain("76561198000000000");
  });

  it("marks the last method `last_link`", async () => {
    const w = await seededWorld();
    const { d } = await steamOnlyAccount(w);
    const body = await methods(d);
    expect(body.methods).toEqual([
      expect.objectContaining({
        kind: "steam",
        canRemove: false,
        reason: "last_link",
      }),
    ]);
    expect(body.passkey).toEqual({ canAdd: false, reason: "email_unverified" });
  });
});

describe("DELETE /api/me/methods/<id>: never orphan, step-up, audit and notice", () => {
  it("refuses to remove the last method with last_link, even with a fresh sign-in", async () => {
    const w = await seededWorld();
    const { d, accountId } = await steamOnlyAccount(w);
    const res = await d.send("DELETE", `${METHODS}/lnk_steam_${accountId}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("last_link");
    expect(
      await w.db.first(
        "SELECT id FROM account_links WHERE account_id = ?",
        accountId,
      ),
    ).not.toBeNull();
    expect(await audit(w, accountId)).not.toContain("account.link.remove");
  });

  it("never lets two concurrent removals orphan the account", async () => {
    const w = await seededWorld();
    const { d, accountId } = await steamOnlyAccount(w);
    await w.db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
                                  email, email_verified, created_at, last_used_at)
       VALUES ('lnk_g', ?, 'google', '', 'g-1', 'google', NULL, 0, ?, ?)`,
      accountId,
      NOW,
      NOW,
    );
    const [a, b] = await Promise.all([
      d.send("DELETE", `${METHODS}/lnk_steam_${accountId}`),
      d.send("DELETE", `${METHODS}/lnk_g`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const left = await w.db.all(
      "SELECT id FROM account_links WHERE account_id = ?",
      accountId,
    );
    expect(left).toHaveLength(1);
  });

  it("needs a sign-in no older than 5 minutes", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    await addSteam(w, accountId);
    const stale = await d.send("DELETE", `${METHODS}/lnk_steam`, undefined, {
      now: STALE,
    });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual(
      expect.objectContaining({
        error: "step_up_required",
        maxAgeSeconds: 300,
      }),
    );
    expect(
      await w.db.first("SELECT id FROM account_links WHERE id = 'lnk_steam'"),
    ).not.toBeNull();
  });

  it("removes a method, audits it, and emails every verified address", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    await addSteam(w, accountId);
    w.mail.length = 0;
    const res = await d.send("DELETE", `${METHODS}/lnk_steam`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      removed: { id: "lnk_steam", kind: "steam" },
    });
    expect(await audit(w, accountId)).toContain("account.link.remove");
    expect(w.mail).toEqual([
      expect.objectContaining({
        to: "ada@example.com",
        subject: "Steam was disconnected from your Polaris Key account",
      }),
    ]);
  });

  it("keeps the only email while it is the primary; with another address, promotes it", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    await addSteam(w, accountId);
    const emailId = (await methods(d)).methods.find(
      (m) => m.kind === "email",
    )!.id;
    const refused = await d.send("DELETE", `${METHODS}/${emailId}`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(
      expect.objectContaining({ error: "forbidden", reason: "only_email" }),
    );

    // Connect a second address, then the primary can go and the other takes its place.
    await connectEmail(w, d, "ada@work.example");
    w.mail.length = 0;
    const removed = await d.send("DELETE", `${METHODS}/${emailId}`);
    expect(removed.status).toBe(200);
    const account = await w.db.first<{ primary_email: string }>(
      "SELECT primary_email FROM accounts WHERE id = ?",
      accountId,
    );
    expect(account?.primary_email).toBe("ada@work.example");
    // Named generically, and the removed address hears about it too.
    expect(w.mail.map((m) => [m.to, m.subject]).sort()).toEqual([
      [
        "ada@example.com",
        "An email address was disconnected from your Polaris Key account",
      ],
      [
        "ada@work.example",
        "An email address was disconnected from your Polaris Key account",
      ],
    ]);
  });

  it("never lets two concurrent removals take the last address, and promotes the one left", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    await addSteam(w, accountId);
    await connectEmail(w, d, "ada@work.example");
    const ids = (await methods(d)).methods
      .filter((m) => m.kind === "email")
      .map((m) => m.id);
    expect(ids).toHaveLength(2);
    const [x, y] = await Promise.all(
      ids.map((id) => d.send("DELETE", `${METHODS}/${id}`)),
    );
    expect([x!.status, y!.status].sort()).toEqual([200, 403]);
    const left = await w.db.all<{ subject: string }>(
      "SELECT subject FROM account_links WHERE account_id = ? AND kind = 'email'",
      accountId,
    );
    expect(left).toHaveLength(1);
    const account = await w.db.first<{ primary_email: string }>(
      "SELECT primary_email FROM accounts WHERE id = ?",
      accountId,
    );
    expect(account?.primary_email).toBe(left[0]!.subject);
  });

  it("answers not_found for another account's method", async () => {
    const w = await seededWorld();
    const { d } = await emailAccount(w);
    const other = await steamOnlyAccount(w, "acct_other");
    const res = await d.send(
      "DELETE",
      `${METHODS}/lnk_steam_${other.accountId}`,
    );
    expect(res.status).toBe(404);
  });
});

async function connectEmail(
  w: CardWorld,
  d: Device,
  email: string,
  now = NOW,
): Promise<Response> {
  const start = await d.send(
    "POST",
    `${METHODS}/email/start`,
    { email },
    { now },
  );
  expect(start.status).toBe(200);
  return d.send(
    "POST",
    `${METHODS}/email/verify`,
    { code: lastCode(w, email) },
    { now },
  );
}

describe("connect an email by code", () => {
  it("connects the address once the code is entered, audits it and emails every verified address", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    w.mail.length = 0;
    const start = await d.send("POST", `${METHODS}/email/start`, {
      email: "Ada@Work.Example",
    });
    expect(await start.json()).toEqual({
      status: "code_sent",
      email: "ada@work.example",
      expiresIn: 600,
      codeLength: 6,
    });
    // Nothing is connected before the code.
    expect((await methods(d)).emails).toHaveLength(1);
    const res = await d.send("POST", `${METHODS}/email/verify`, {
      code: lastCode(w, "ada@work.example"),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        status: "connected",
        already: false,
        email: "ada@work.example",
      }),
    );
    expect((await methods(d)).emails.map((e) => [e.email, e.primary])).toEqual([
      ["ada@example.com", true],
      ["ada@work.example", false],
    ]);
    expect(await audit(w, accountId)).toContain("account.link.add");
    const notices = w.mail.filter((m) => m.subject.includes("connected"));
    expect(notices.map((m) => [m.to, m.subject]).sort()).toEqual([
      [
        "ada@example.com",
        "An email address was connected to your Polaris Key account",
      ],
      [
        "ada@work.example",
        "An email address was connected to your Polaris Key account",
      ],
    ]);
  });

  it("gives an account with no email its first, as the primary", async () => {
    const w = await seededWorld();
    const { d, accountId } = await steamOnlyAccount(w);
    expect((await connectEmail(w, d, "mara@fennick.studio")).status).toBe(201);
    const account = await w.db.first<{
      primary_email: string;
      primary_email_verified_at: number;
    }>(
      "SELECT primary_email, primary_email_verified_at FROM accounts WHERE id = ?",
      accountId,
    );
    expect(account).toEqual({
      primary_email: "mara@fennick.studio",
      primary_email_verified_at: NOW,
    });
    expect((await methods(d)).passkey.canAdd).toBe(true);
  });

  it("answers the start identically for another account's address, and refuses it once proven", async () => {
    const w = await seededWorld();
    await emailAccount(w, "taken@example.com");
    const { d, accountId } = await emailAccount(w);
    const free = await d.send("POST", `${METHODS}/email/start`, {
      email: "free@example.com",
    });
    const taken = await d.send("POST", `${METHODS}/email/start`, {
      email: "taken@example.com",
    });
    expect(taken.status).toBe(free.status);
    expect(Object.keys((await taken.json()) as object).sort()).toEqual(
      Object.keys((await free.json()) as object).sort(),
    );
    const res = await d.send("POST", `${METHODS}/email/verify`, {
      code: lastCode(w, "taken@example.com"),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "link_conflict",
    );
    expect(
      await w.db.all(
        "SELECT id FROM account_links WHERE account_id = ? AND kind = 'email'",
        accountId,
      ),
    ).toHaveLength(1);
  });

  it("refuses a wrong code with the tries left, and a stale sign-in with step_up_required", async () => {
    const w = await seededWorld();
    const { d } = await emailAccount(w);
    await d.send("POST", `${METHODS}/email/start`, { email: "b@example.com" });
    const wrong = await d.send("POST", `${METHODS}/email/verify`, {
      code: "000000",
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual(
      expect.objectContaining({ error: "invalid_code", triesLeft: 4 }),
    );
    const stale = await d.send(
      "POST",
      `${METHODS}/email/start`,
      { email: "c@example.com" },
      { now: STALE },
    );
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { error: string }).error).toBe(
      "step_up_required",
    );
  });

  it("binds the code to the session that asked", async () => {
    const w = await seededWorld();
    const { d } = await emailAccount(w);
    await d.send("POST", `${METHODS}/email/start`, { email: "b@example.com" });
    // Another browser of the same account cannot finish it.
    const other = await emailAccount(w);
    const res = await other.d.send("POST", `${METHODS}/email/verify`, {
      code: lastCode(w, "b@example.com"),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "signin_expired",
    );
  });

  it("starts a passkey with I-16's registration challenge, and refuses an unknown kind", async () => {
    const w = await seededWorld();
    const { d } = await emailAccount(w);
    const pk = await d.send("POST", `${METHODS}/passkey/start`, {});
    expect(pk.status).toBe(200);
    expect(await pk.json()).toEqual(
      expect.objectContaining({ expiresIn: 300 }),
    );
    expect((await d.send("POST", `${METHODS}/discord/start`, {})).status).toBe(
      404,
    );
  });
});

// ── Provider connect: Google through its registered callback ───────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals();
  resetProviderCaches();
});

interface ProviderSession {
  accountId: string;
  cookie: string;
  csrf: string;
}

async function providerAccount(
  h: ProviderHarness,
  id = "acct_mara",
): Promise<ProviderSession> {
  const t = nowSec();
  const email = `${id.replace(/^acct_/, "")}@fennick.studio`;
  await h.db.run(
    `INSERT INTO accounts (id, status, primary_email, primary_email_verified_at, display_name,
                           created_at, modified_at, last_sign_in_at)
     VALUES (?, 'active', ?, ?, 'Mara', ?, ?, ?)`,
    id,
    email,
    t,
    t,
    t,
    t,
  );
  await h.db.run(
    `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email,
                                email_verified, created_at, last_used_at)
     VALUES (?, ?, 'email', '', ?, 'email', ?, 1, ?, ?)`,
    `lnk_email_${id}`,
    id,
    email,
    email,
    t,
    t,
  );
  const { token, session } = await issuePortalSessionRow(
    h.env,
    h.db,
    { accountId: id, name: "Mara", email },
    t,
  );
  return {
    accountId: id,
    cookie: `${ACCOUNT_SESSION_COOKIE}=${token}`,
    csrf: session.csrf,
  };
}

/** Connect Google from `s`: start, then Google's callback with `claims`. */
async function connectGoogle(
  h: ProviderHarness,
  s: ProviderSession,
  claims: (nonce: string) => Record<string, unknown>,
  beforeCallback?: () => Promise<void>,
): Promise<Response> {
  const start = await h.request("/api/me/methods/google/start", {
    method: "POST",
    cookie: s.cookie,
    headers: { [PORTAL_CSRF_HEADER]: s.csrf },
  });
  expect(start.status).toBe(200);
  const { redirect } = (await start.json()) as { redirect: string };
  const bind = cookieFrom(start, SIGNIN_BIND_COOKIE);
  expect(bind).not.toBeNull();
  const location = new URL(redirect);
  expect(location.origin).toBe("https://accounts.google.com");
  // The same registered callback the login card uses.
  expect(location.searchParams.get("redirect_uri")).toBe(
    "https://key.plrs.im/login/google/callback",
  );
  h.idToken.google = await h.signGoogle(
    claims(location.searchParams.get("nonce")!),
  );
  await beforeCallback?.();
  const qs = new URLSearchParams({
    code: "4/0AQSTgQ-code",
    state: location.searchParams.get("state")!,
    iss: "https://accounts.google.com",
  });
  return h.request(`/login/google/callback?${qs}`, { cookie: bind! });
}

describe("connect Google", () => {
  it("links the identity to the signed-in account and never signs anyone in", async () => {
    const h = await makeProviderHarness();
    const s = await providerAccount(h);
    const res = await connectGoogle(h, s, (n) =>
      googleClaims(n, { email: "mara.fennick@gmail.com" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/#/account/methods?connected=google",
    );
    // No session cookie is minted by a Connect.
    expect(cookieFrom(res, ACCOUNT_SESSION_COOKIE)).toBeNull();
    const link = await h.db.first<{
      account_id: string;
      email: string;
      email_verified: number;
    }>(
      "SELECT account_id, email, email_verified FROM account_links WHERE kind = 'google'",
    );
    expect(link).toEqual({
      account_id: s.accountId,
      email: "mara.fennick@gmail.com",
      email_verified: 1,
    });
    const actions = await h.db.all<{ action: string }>(
      "SELECT action FROM portal_audit WHERE account_id = ?",
      s.accountId,
    );
    expect(actions.map((a) => a.action)).toContain("account.link.add");
  });

  it("stores a Google address Google does not vouch for as unverified (the narrowed value)", async () => {
    const h = await makeProviderHarness();
    const s = await providerAccount(h);
    // `email_verified: true` on a non-Google domain with no matching `hd`: not vouched for.
    await connectGoogle(h, s, (n) => googleClaims(n));
    const link = await h.db.first<{ email_verified: number }>(
      "SELECT email_verified FROM account_links WHERE kind = 'google'",
    );
    expect(link?.email_verified).toBe(0);
  });

  it("never verifies an address another account already uses", async () => {
    const h = await makeProviderHarness();
    await providerAccount(h, "acct_other");
    await h.db.run(
      "UPDATE accounts SET primary_email = 'shared@gmail.com' WHERE id = 'acct_other'",
    );
    const s = await providerAccount(h, "acct_mara2");
    await connectGoogle(h, s, (n) =>
      googleClaims(n, { email: "shared@gmail.com" }),
    );
    const link = await h.db.first<{
      account_id: string;
      email_verified: number;
    }>(
      "SELECT account_id, email_verified FROM account_links WHERE kind = 'google'",
    );
    expect(link).toEqual({ account_id: s.accountId, email_verified: 0 });
  });

  it("refuses an identity another account holds (link_conflict) and moves nothing", async () => {
    const h = await makeProviderHarness();
    await providerAccount(h, "acct_holder");
    await h.db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
                                  email, email_verified, created_at, last_used_at)
       VALUES ('lnk_g_held', 'acct_holder', 'https://accounts.google.com', '',
               '110169484474386276334', 'google',
               NULL, 0, 1, 1)`,
    );
    const s = await providerAccount(h, "acct_mara3");
    const res = await connectGoogle(h, s, (n) => googleClaims(n));
    expect(res.headers.get("location")).toBe(
      "/#/account/methods?error=link_conflict&method=google",
    );
    const held = await h.db.first<{ account_id: string }>(
      "SELECT account_id FROM account_links WHERE id = 'lnk_g_held'",
    );
    expect(held?.account_id).toBe("acct_holder");
  });

  it("is cancelled when the session that started it signs out", async () => {
    const h = await makeProviderHarness();
    const s = await providerAccount(h);
    const res = await connectGoogle(
      h,
      s,
      (n) => googleClaims(n),
      async () => {
        await h.db.run(
          "UPDATE account_sessions SET revoked_at = 1 WHERE account_id = ?",
          s.accountId,
        );
      },
    );
    expect(res.headers.get("location")).toBe(
      "/#/account/methods?error=signin_expired&method=google",
    );
    expect(
      await h.db.first("SELECT id FROM account_links WHERE kind = 'google'"),
    ).toBeNull();
  });

  it("needs a fresh sign-in to start", async () => {
    const h = await makeProviderHarness();
    const s = await providerAccount(h);
    // A session that signed in 10 minutes ago.
    const t = nowSec() - 600;
    const { token, session } = await issuePortalSessionRow(
      h.env,
      h.db,
      { accountId: s.accountId, name: "Mara", email: "mara@fennick.studio" },
      t,
    );
    const res = await h.request("/api/me/methods/google/start", {
      method: "POST",
      cookie: `${ACCOUNT_SESSION_COOKIE}=${token}`,
      headers: { [PORTAL_CSRF_HEADER]: session.csrf },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "step_up_required",
    );
  });

  it("answers auth_method_disabled for a provider this deploy has not configured", async () => {
    const h = await makeProviderHarness({ configure: ["google"] });
    const s = await providerAccount(h);
    const res = await h.request("/api/me/methods/steam/start", {
      method: "POST",
      cookie: s.cookie,
      headers: { [PORTAL_CSRF_HEADER]: s.csrf },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "auth_method_disabled",
    );
  });
});
