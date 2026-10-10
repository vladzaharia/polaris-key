/**
 * PX-W14 — "Sign in with another device" (docs/design/PORTAL.md §4.23, §4.24, §10.2 G29):
 * start, lookup, approve or deny, poll. Codes expire and are single use; nothing approves a
 * request but an explicit decision; a new location needs a step-up.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import {
  getOrCreateAccountByEmail,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  verifyPortalSession,
} from "../src/services/identity/portal/session.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import {
  DEVICE_LOGIN_COOKIE,
  DEVICE_LOGIN_TTL_SECONDS,
  browserName,
  deviceSessionAuthenticatedAt,
  isNewLocation,
  requestLocation,
  requestingDevice,
} from "../src/services/identity/portal/deviceLogin.js";
import { STEP_UP_MAX_AGE_SECONDS } from "../src/services/identity/accounts/links.js";
import { handlePortalApi } from "./portalHarness.js";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

interface Session {
  cookie: string;
  csrf: string;
  accountId: string;
}

async function setup(): Promise<{
  env: Env;
  db: Db;
  sent: Array<{ to: string; subject: string; text: string }>;
}> {
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  env.EMAIL = {
    send: async (message: { to: string; subject: string; text: string }) => {
      sent.push(message);
    },
  } as unknown as Env["EMAIL"];
  const db = await makeTestDb();
  await seedProduct(db, "djdl");
  return { env, db, sent };
}

async function signIn(
  env: Env,
  db: Db,
  email: string,
  issuedAt = NOW,
): Promise<Session> {
  const account = await getOrCreateAccountByEmail(db, email, issuedAt);
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    issuedAt,
  );
  return {
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
    accountId: account.id,
  };
}

interface CallOpts {
  session?: Session | null;
  cookie?: string;
  body?: unknown;
  now?: number;
  country?: string;
  ua?: string;
  csrf?: boolean;
  ip?: string;
}

function call(
  env: Env,
  db: Db,
  method: string,
  path: string,
  opts: CallOpts = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "user-agent": opts.ua ?? CHROME_MAC,
    "cf-connecting-ip": opts.ip ?? "203.0.113.7",
  };
  if (opts.country) headers["cf-ipcountry"] = opts.country;
  const cookies: string[] = [];
  if (opts.session) {
    cookies.push(opts.session.cookie);
    if (opts.csrf !== false) headers[PORTAL_CSRF_HEADER] = opts.session.csrf;
  }
  if (opts.cookie) cookies.push(opts.cookie);
  if (cookies.length) headers.cookie = cookies.join("; ");
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const req = new Request(`https://key.plrs.im${path}`, init);
  return handlePortalApi(req, env, db, path, opts.now ?? NOW);
}

interface Started {
  id: string;
  code: string;
  qr: string | null;
  approveUrl: string;
  expiresIn: number;
  interval: number;
  /** `name=value` of the binding cookie. */
  binding: string;
}

async function start(env: Env, db: Db, opts: CallOpts = {}): Promise<Started> {
  const res = await call(env, db, "POST", "/api/device-login/start", {
    country: "PT",
    ...opts,
  });
  expect(res.status).toBe(201);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const binding = setCookie.split(";")[0]!;
  return { ...((await res.json()) as Omit<Started, "binding">), binding };
}

const poll = (env: Env, db: Db, s: Started, opts: CallOpts = {}) =>
  call(env, db, "GET", `/api/device-login/${s.id}`, {
    cookie: s.binding,
    ...opts,
  });

const lookup = (
  env: Env,
  db: Db,
  session: Session,
  code: string,
  opts: CallOpts = {},
) =>
  call(env, db, "POST", "/api/device-login/lookup", {
    session,
    body: { code },
    country: "PT",
    ...opts,
  });

const decide = (
  env: Env,
  db: Db,
  session: Session,
  code: string,
  decision: unknown,
  opts: CallOpts = {},
) =>
  call(env, db, "POST", "/api/device-login/approve", {
    session,
    body: { code, decision },
    country: "PT",
    ...opts,
  });

describe("POST /api/device-login/start", () => {
  it("returns a code, a QR code, an expiry and a poll handle, and binds the browser", async () => {
    const { env, db } = await setup();
    const res = await call(env, db, "POST", "/api/device-login/start", {
      country: "PT",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toMatch(
      /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
    );
    expect(body.id).toMatch(/^dl_[A-Za-z0-9_-]{43}$/);
    expect(body.expiresIn).toBe(DEVICE_LOGIN_TTL_SECONDS);
    expect(DEVICE_LOGIN_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(body.approveUrl).toBe(
      `https://key.plrs.im/#/account/approve?code=${body.code as string}`,
    );
    expect(body.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = atob((body.qr as string).split(",")[1]!);
    expect(svg).toContain("<svg");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${DEVICE_LOGIN_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Max-Age=${DEVICE_LOGIN_TTL_SECONDS}`);
  });

  it("is refused while the portal is off and accepts only POST", async () => {
    const { env, db } = await setup();
    expect((await call(env, db, "GET", "/api/device-login/start")).status).toBe(
      405,
    );
    await upsertPortalProductSettings(
      db,
      "djdl",
      { portalEnabled: false },
      NOW,
    );
    const res = await call(env, db, "POST", "/api/device-login/start");
    expect(res.status).toBe(404);
  });

  it("is rate-limited per client network", async () => {
    const { env, db } = await setup();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await call(env, db, "POST", "/api/device-login/start")).status;
    }
    expect(last).toBe(429);
  });
});

describe("GET /api/device-login/:id", () => {
  it("answers pending to the browser that started it, and expired to anyone else", async () => {
    const { env, db } = await setup();
    const s = await start(env, db);
    const res = await poll(env, db, s);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "pending",
      expiresIn: DEVICE_LOGIN_TTL_SECONDS,
    });
    // No binding cookie, a wrong one, a malformed id, an unknown id: all the same answer.
    expect((await poll(env, db, s, { cookie: "" })).status).toBe(410);
    expect(
      (await poll(env, db, s, { cookie: `${DEVICE_LOGIN_COOKIE}=nope` }))
        .status,
    ).toBe(410);
    expect(
      (
        await call(env, db, "GET", "/api/device-login/not-an-id", {
          cookie: s.binding,
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await call(env, db, "GET", `/api/device-login/dl_${"A".repeat(43)}`, {
          cookie: s.binding,
        })
      ).status,
    ).toBe(410);
  });

  it("expires with the request", async () => {
    const { env, db } = await setup();
    const s = await start(env, db);
    const res = await poll(env, db, s, { now: NOW + DEVICE_LOGIN_TTL_SECONDS });
    expect(res.status).toBe(410);
  });
});

describe("approving a new device", () => {
  it("shows what is asking, and looking never approves", async () => {
    const { env, db } = await setup();
    const me = await signIn(env, db, "ana@example.com");
    const s = await start(env, db);
    const res = await lookup(env, db, me, s.code.toLowerCase());
    expect(res.status).toBe(200);
    const { request } = (await res.json()) as {
      request: Record<string, unknown>;
    };
    expect(request).toMatchObject({
      code: s.code,
      device: { label: "Chrome on macOS", browser: "Chrome", os: "macOS" },
      location: { country: "PT", label: "Portugal" },
      requestedAt: NOW,
      approverCountry: "PT",
      newLocation: false,
      stepUpRequired: false,
    });
    // Looked at twice, still pending: only an explicit decision moves it.
    await lookup(env, db, me, s.code);
    expect(await (await poll(env, db, s)).json()).toMatchObject({
      status: "pending",
    });
  });

  it("refuses a decision that is not explicit", async () => {
    const { env, db } = await setup();
    const me = await signIn(env, db, "ana@example.com");
    const s = await start(env, db);
    for (const decision of [undefined, "", "yes", true, "APPROVE"]) {
      const res = await decide(env, db, me, s.code, decision);
      expect(res.status).toBe(422);
    }
    expect(await (await poll(env, db, s)).json()).toMatchObject({
      status: "pending",
    });
  });

  it("approves once: the new device is signed in to the approver's account, audited and emailed", async () => {
    const { env, db, sent } = await setup();
    const me = await signIn(env, db, "ana@example.com");
    const s = await start(env, db);
    const res = await decide(env, db, me, s.code, "approve");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "approved" });

    // The code is spent: neither approving again nor looking it up finds it.
    expect((await decide(env, db, me, s.code, "approve")).status).toBe(410);
    expect((await lookup(env, db, me, s.code)).status).toBe(410);

    const polled = await poll(env, db, s);
    expect(polled.status).toBe(200);
    expect(await polled.json()).toEqual({ status: "approved" });
    const cookies = polled.headers.get("set-cookie") ?? "";
    const token = cookies.match(new RegExp(`${PORTAL_COOKIE}=([^;]+)`))?.[1];
    const session = await verifyPortalSession(env, token ?? null, NOW);
    expect(session?.accountId).toBe(me.accountId);
    expect(cookies).toContain(`${DEVICE_LOGIN_COOKIE}=;`);
    // It is an account session like any other (I-07): a live row, named by the cookie.
    expect(typeof session?.sid).toBe("string");
    const rows = await db.all<{ amr_json: string }>(
      "SELECT amr_json FROM account_sessions WHERE account_id = ? ORDER BY created_at, rowid",
      me.accountId,
    );
    expect(rows.map((r) => JSON.parse(r.amr_json))).toEqual([
      ["email"],
      ["device"],
    ]);

    // Exactly one poll is signed in.
    expect((await poll(env, db, s)).status).toBe(410);

    const audit = await db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM portal_audit WHERE account_id = ? AND action LIKE 'portal.%device%' ORDER BY at, action",
      me.accountId,
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      "portal.device_login.approve",
      "portal.login.device",
    ]);
    expect(
      audit.find((a) => a.action === "portal.device_login.approve")?.summary,
    ).toBe("Approved a sign-in on Chrome on macOS near Portugal");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ana@example.com");
    // SIGN-IN.md §3.15: signin.mail.newDevice.* and Open Polaris Key.
    expect(sent[0]!.subject).toBe(
      "A new device signed in to your Polaris Key account",
    );
    expect(sent[0]!.text).toContain("Chrome on macOS signed in on ");
    expect(sent[0]!.text).toContain("from Portugal");
    expect(sent[0]!.text).toContain(
      "If this wasn't you, sign it out in Polaris Key under Where you're signed in.",
    );
    expect(sent[0]!.text).toContain("Open Polaris Key: ");
  });

  it("denies: the poll answers denied and nobody is signed in", async () => {
    const { env, db, sent } = await setup();
    const me = await signIn(env, db, "ana@example.com");
    const s = await start(env, db);
    const res = await decide(env, db, me, s.code, "deny");
    expect(await res.json()).toEqual({ ok: true, status: "denied" });
    const polled = await poll(env, db, s);
    expect(await polled.json()).toEqual({ status: "denied" });
    expect(polled.headers.get("set-cookie") ?? "").not.toContain(PORTAL_COOKIE);
    expect((await decide(env, db, me, s.code, "approve")).status).toBe(410);
    expect(sent).toHaveLength(0);
    const audit = await db.all<{ action: string }>(
      "SELECT action FROM portal_audit WHERE account_id = ? AND action LIKE 'portal.device_login.%'",
      me.accountId,
    );
    expect(audit.map((a) => a.action)).toEqual(["portal.device_login.deny"]);
  });

  it("lets only one of two racing approvals land", async () => {
    const { env, db } = await setup();
    const a = await signIn(env, db, "ana@example.com");
    const b = await signIn(env, db, "bo@example.com");
    const s = await start(env, db);
    const results = await Promise.all([
      decide(env, db, a, s.code, "approve"),
      decide(env, db, b, s.code, "approve"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
  });

  it("expires: a code past its lifetime cannot be looked up or approved", async () => {
    const { env, db } = await setup();
    const me = await signIn(env, db, "ana@example.com", NOW);
    const s = await start(env, db);
    const later = NOW + DEVICE_LOGIN_TTL_SECONDS;
    expect((await lookup(env, db, me, s.code, { now: later })).status).toBe(
      410,
    );
    expect(
      (await decide(env, db, me, s.code, "approve", { now: later })).status,
    ).toBe(410);
  });

  it("needs a recent sign-in to approve a device in another place, and keeps the code for the retry", async () => {
    const { env, db } = await setup();
    const now = NOW + 3600;
    const stale = await signIn(env, db, "ana@example.com", NOW);
    const s = await start(env, db, { country: "BR", now });

    const seen = (await (
      await lookup(env, db, stale, s.code, { now })
    ).json()) as { request: Record<string, unknown> };
    expect(seen.request).toMatchObject({
      newLocation: true,
      stepUpRequired: true,
      approverCountry: "PT",
    });

    const refused = await decide(env, db, stale, s.code, "approve", { now });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      error: "step_up_required",
      maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
    });
    // Denying needs no step-up; but first, a fresh sign-in approves the same code.
    const fresh = await signIn(env, db, "ana@example.com", now - 60);
    const ok = await decide(env, db, fresh, s.code, "approve", { now });
    expect(ok.status).toBe(200);
    expect(await (await poll(env, db, s, { now })).json()).toEqual({
      status: "approved",
    });
  });

  it("audits an approval refused for want of a step-up", async () => {
    const { env, db } = await setup();
    const now = NOW + 3600;
    const stale = await signIn(env, db, "ana@example.com", NOW);
    const s = await start(env, db, { country: "BR", now });
    expect(
      (await decide(env, db, stale, s.code, "approve", { now })).status,
    ).toBe(401);
    const audit = await db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM portal_audit WHERE account_id = ? AND action LIKE 'portal.device_login.%'",
      stale.accountId,
    );
    expect(audit).toEqual([
      {
        action: "portal.device_login.step_up_required",
        summary:
          "Asked to sign in again before approving Chrome on macOS near Brazil",
      },
    ]);
  });

  it("never mints a fresh session: an approved device carries the approver's sign-in time", async () => {
    const { env, db } = await setup();
    const now = NOW + 3600;
    // Signed in an hour ago, so not fresh; a same-country request needs no step-up.
    const stale = await signIn(env, db, "ana@example.com", NOW);
    const s = await start(env, db, { country: "PT", now });
    expect(
      (await decide(env, db, stale, s.code, "approve", { now })).status,
    ).toBe(200);
    const polled = await poll(env, db, s, { now });
    const cookies = polled.headers.get("set-cookie") ?? "";
    const token = cookies.match(new RegExp(`${PORTAL_COOKIE}=([^;]+)`))?.[1];
    const session = await verifyPortalSession(env, token ?? null, now);
    expect(session?.accountId).toBe(stale.accountId);
    expect(session?.iat).toBe(NOW);
    const approved: Session = {
      cookie: `${PORTAL_COOKIE}=${token}`,
      csrf: session!.csrf,
      accountId: session!.accountId,
    };

    // The second hop: the approved device tries to approve a device in another country.
    const far = await start(env, db, {
      country: "BR",
      now,
      ip: "198.51.100.9",
    });
    const seen = (await (
      await lookup(env, db, approved, far.code, { now })
    ).json()) as { request: Record<string, unknown> };
    expect(seen.request).toMatchObject({
      newLocation: true,
      stepUpRequired: true,
    });
    const refused = await decide(env, db, approved, far.code, "approve", {
      now,
    });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: "step_up_required" });
  });

  it("dates an approved device's session from the approver's sign-in, never later than now", async () => {
    const { env, db } = await setup();
    const now = NOW + 3600;
    const fresh = await signIn(env, db, "ana@example.com", now - 60);
    const s = await start(env, db, { country: "BR", now });
    expect(
      (await decide(env, db, fresh, s.code, "approve", { now })).status,
    ).toBe(200);
    const later = now + 30;
    const polled = await poll(env, db, s, { now: later });
    const token = (polled.headers.get("set-cookie") ?? "").match(
      new RegExp(`${PORTAL_COOKIE}=([^;]+)`),
    )?.[1];
    const session = await verifyPortalSession(env, token ?? null, later);
    expect(session?.iat).toBe(now - 60);

    expect(
      deviceSessionAuthenticatedAt({ approverAuthenticatedAt: now + 99 }, now),
    ).toBe(now);
    // A record without the field fails closed: past the step-up window.
    expect(deviceSessionAuthenticatedAt({}, now)).toBe(
      now - STEP_UP_MAX_AGE_SECONDS - 1,
    );
  });

  it("treats an unknown place as a new one", async () => {
    const { env, db } = await setup();
    const now = NOW + 3600;
    const stale = await signIn(env, db, "ana@example.com", NOW);
    const s = await start(env, db, { country: "XX", now });
    const res = await decide(env, db, stale, s.code, "approve", { now });
    expect(res.status).toBe(401);
    // A denial is always allowed.
    expect((await decide(env, db, stale, s.code, "deny", { now })).status).toBe(
      200,
    );
  });

  it("needs a session and the CSRF header, and a well-formed code", async () => {
    const { env, db } = await setup();
    const me = await signIn(env, db, "ana@example.com");
    const s = await start(env, db);
    expect(
      (
        await call(env, db, "POST", "/api/device-login/approve", {
          body: { code: s.code, decision: "approve" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(env, db, "POST", "/api/device-login/approve", {
          session: me,
          csrf: false,
          body: { code: s.code, decision: "approve" },
        })
      ).status,
    ).toBe(403);
    expect((await lookup(env, db, me, "1234-5678")).status).toBe(422);
    expect((await lookup(env, db, me, "BCDF-GHJK")).status).toBe(410);
    expect(
      (await call(env, db, "GET", "/api/device-login/lookup", { session: me }))
        .status,
    ).toBe(405);
  });

  it("bounds code guessing per account", async () => {
    const { env, db } = await setup();
    const me = await signIn(env, db, "ana@example.com");
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await lookup(env, db, me, "BCDF-GHJK")).status;
    }
    expect(last).toBe(429);
  });

  it("bounds code guessing per account across client addresses", async () => {
    const { env, db } = await setup();
    const me = await signIn(env, db, "ana@example.com");
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (
        await lookup(env, db, me, "BCDF-GHJK", { ip: `2001:db8::${i + 1}` })
      ).status;
    }
    expect(last).toBe(429);
  });
});

describe("what is asking", () => {
  it("names the browser and the OS", () => {
    expect(browserName(CHROME_MAC)).toBe("Chrome");
    expect(
      requestingDevice(new Headers({ "user-agent": SAFARI_IPHONE })).label,
    ).toBe("Safari on iPhone and iPad");
    expect(
      requestingDevice(
        new Headers({
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
        }),
      ).label,
    ).toBe("Edge on Windows");
    expect(requestingDevice(new Headers()).label).toBe("A device");
  });

  it("reads Cloudflare's place, never trusting what it cannot clean", () => {
    const req = new Request("https://key.plrs.im/");
    Object.defineProperty(req, "cf", {
      value: { city: "Lisbon", region: "Lisbon", country: "PT" },
    });
    expect(requestLocation(req)).toEqual({
      city: "Lisbon",
      region: "Lisbon",
      country: "PT",
      label: "Lisbon, Portugal",
    });
    const tor = new Request("https://key.plrs.im/", {
      headers: { "cf-ipcountry": "T1" },
    });
    expect(requestLocation(tor)).toMatchObject({ country: null, label: null });
    const odd = new Request("https://key.plrs.im/");
    Object.defineProperty(odd, "cf", {
      value: { city: "Evil‮City\n", country: "PT" },
    });
    expect(requestLocation(odd).city).toBe("Evil City");
  });

  it("decides a new location in one place, failing closed", () => {
    const at = (country: string | null) => ({
      city: null,
      region: null,
      country,
      label: null,
    });
    expect(isNewLocation(at("PT"), at("PT"))).toBe(false);
    expect(isNewLocation(at("PT"), at("BR"))).toBe(true);
    expect(isNewLocation(at(null), at("PT"))).toBe(true);
    expect(isNewLocation(at("PT"), at(null))).toBe(true);
  });
});
