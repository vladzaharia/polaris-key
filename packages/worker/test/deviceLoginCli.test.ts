/**
 * ST-34.5 — `purpose: "cli"` device login (PX-W14's second purpose, for `pkey login`).
 *
 * The CLI starts a request (the portal may be off), a console session decides it through
 * Identity's public `cliDeviceLoginLookup` / `cliDeviceLoginDecide`, and the poll mints one
 * `admin` personal token. A portal session can never decide it: to the portal it is expired.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedProduct, setPortalToggles } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import {
  cliTokenLabel,
  DEVICE_LOGIN_COOKIE,
} from "../src/services/identity/portal/deviceLogin.js";
import { PERSONAL_TOKEN_LABEL_MAX } from "../src/core/accounts/personalTokens.js";
import {
  cliDeviceLoginDecide,
  cliDeviceLoginLookup,
} from "../src/services/identity/public.js";
import {
  mintAccountToken,
  resolvePersonalToken,
} from "../src/core/accounts/personalTokens.js";
import { memberIdFor } from "../src/core/console/memberId.js";
import { handlePortalApi } from "./portalHarness.js";
import { eraseAndRestore, LedgerBucket } from "./eraseRestore.js";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

interface Session {
  cookie: string;
  csrf: string;
  accountId: string;
}

async function setup(): Promise<{ env: Env; db: Db; ledger: LedgerBucket }> {
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  const ledger = new LedgerBucket();
  env.BLOBS = asR2(ledger);
  const db = await makeTestDb();
  await seedProduct(db, "djdl");
  return { env, db, ledger };
}

async function signIn(env: Env, db: Db, email: string): Promise<Session> {
  const account = await getOrCreateAccountByEmail(db, email, NOW);
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  return {
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
    accountId: account.id,
  };
}

function call(
  env: Env,
  db: Db,
  method: string,
  path: string,
  opts: {
    session?: Session;
    cookie?: string;
    body?: unknown;
    now?: number;
    ip?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "user-agent": CHROME_MAC,
    "cf-connecting-ip": opts.ip ?? "203.0.113.7",
    "cf-ipcountry": "PT",
  };
  const cookies: string[] = [];
  if (opts.session) {
    cookies.push(opts.session.cookie);
    headers[PORTAL_CSRF_HEADER] = opts.session.csrf;
  }
  if (opts.cookie) cookies.push(opts.cookie);
  if (cookies.length) headers.cookie = cookies.join("; ");
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return handlePortalApi(
    new Request(`https://key.plrs.im${path}`, init),
    env,
    db,
    path,
    opts.now ?? NOW,
  );
}

const CLI_START = {
  purpose: "cli",
  scope: "admin",
  client: { name: "pkey", version: "1.2.3", host: "ada-mbp.local" },
};

interface Started {
  id: string;
  code: string;
  approveUrl: string;
  qr: string | null;
  binding: string;
}

async function startCli(
  env: Env,
  db: Db,
  body: unknown = CLI_START,
  ip?: string,
): Promise<Started> {
  const res = await call(env, db, "POST", "/api/device-login/start", {
    body,
    ...(ip ? { ip } : {}),
  });
  expect(res.status).toBe(201);
  const binding = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { ...((await res.json()) as Omit<Started, "binding">), binding };
}

const poll = (
  env: Env,
  db: Db,
  s: Started,
  cookie: string | null = s.binding,
) =>
  call(env, db, "GET", `/api/device-login/${s.id}`, {
    ...(cookie ? { cookie } : {}),
  });

const portalApprove = (
  env: Env,
  db: Db,
  session: Session,
  code: string,
  decision = "approve",
) =>
  call(env, db, "POST", "/api/device-login/approve", {
    session,
    body: { code, decision },
  });

describe("POST /api/device-login/start with purpose cli", () => {
  it("works with the portal off, and its approve URL is the console card, with no QR", async () => {
    const { env, db } = await setup();
    await setPortalToggles(db, "djdl", { portalEnabled: false }, NOW);
    const s = await startCli(env, db);
    expect(s.approveUrl).toBe(
      `https://key.plrs.im/manage/device?code=${s.code}`,
    );
    expect(s.qr).toBeNull();
    expect(s).toMatchObject({
      purpose: "cli",
      scope: "admin",
      client: { host: "ada-mbp.local" },
    });
    // The portal purpose is still refused while the portal is off.
    const portal = await call(env, db, "POST", "/api/device-login/start", {
      body: {},
    });
    expect(portal.status).toBe(404);
  });

  it("refuses packages:read, a missing scope and an unknown purpose with 422 bad_request", async () => {
    const { env, db } = await setup();
    for (const body of [
      { ...CLI_START, scope: "packages:read" },
      { purpose: "cli", client: CLI_START.client },
      { ...CLI_START, scope: "root" },
      { purpose: "admin", scope: "admin" },
    ]) {
      const res = await call(env, db, "POST", "/api/device-login/start", {
        body,
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
    }
  });

  it("cleans the host: control characters dropped, 64 characters at most, an empty one named", async () => {
    const { env, db } = await setup();
    const s = await startCli(env, db, {
      ...CLI_START,
      client: {
        name: "pkey",
        version: "1",
        host: `  evil‮\n${"h".repeat(100)}`,
      },
    });
    const view = await cliDeviceLoginLookup(env, s.code, NOW);
    expect(view!.client.host.length).toBeLessThanOrEqual(64);
    expect(view!.client.host).not.toMatch(/[‮\n]/);
    const blank = await startCli(
      env,
      db,
      { ...CLI_START, client: { host: "   " } },
      "203.0.113.8",
    );
    expect(
      (await cliDeviceLoginLookup(env, blank.code, NOW))!.client.host,
    ).toBe("an unnamed host");
  });
});

describe("the portal and a CLI record", () => {
  it("answers lookup and approve exactly as an expired request, and leaves the code live for the console", async () => {
    const { env, db } = await setup();
    const ada = await signIn(env, db, "ada@example.com");
    const s = await startCli(env, db);
    const lookup = await call(env, db, "POST", "/api/device-login/lookup", {
      session: ada,
      body: { code: s.code },
    });
    expect(lookup.status).toBe(410);
    expect(await lookup.json()).toMatchObject({ error: "expired" });
    const approve = await portalApprove(env, db, ada, s.code);
    expect(approve.status).toBe(410);
    expect(await approve.json()).toMatchObject({ error: "expired" });
    const deny = await portalApprove(env, db, ada, s.code, "deny");
    expect(deny.status).toBe(410);
    // Same body as an unknown code.
    const unknown = await portalApprove(env, db, ada, "BCDF-GHJK");
    expect(unknown.status).toBe(410);
    // Still pending, and the poll says so.
    expect(await (await poll(env, db, s)).json()).toMatchObject({
      status: "pending",
    });
    expect(await cliDeviceLoginLookup(env, s.code, NOW)).not.toBeNull();
  });

  it("does not let the console functions touch a portal-purpose record", async () => {
    const { env, db } = await setup();
    const ada = await signIn(env, db, "ada@example.com");
    const res = await call(env, db, "POST", "/api/device-login/start", {
      body: {},
    });
    const portal = (await res.json()) as { code: string };
    expect(await cliDeviceLoginLookup(env, portal.code, NOW)).toBeNull();
    expect(
      await cliDeviceLoginDecide(
        env,
        { code: portal.code, accountId: ada.accountId, decision: "approve" },
        NOW,
      ),
    ).toEqual({ ok: false });
    // The portal can still decide it.
    expect((await portalApprove(env, db, ada, portal.code)).status).toBe(200);
  });
});

describe("the console's lookup and decision", () => {
  it("shows the device, place and client, and a decision is single use", async () => {
    const { env, db } = await setup();
    const ada = await signIn(env, db, "ada@example.com");
    const s = await startCli(env, db);
    const view = await cliDeviceLoginLookup(env, s.code, NOW);
    expect(view).toMatchObject({
      code: s.code,
      device: { label: "Chrome on macOS" },
      client: { name: "pkey", version: "1.2.3", host: "ada-mbp.local" },
      scope: "admin",
    });
    expect(view!.location.country).toBe("PT");
    const input = {
      code: s.code,
      accountId: ada.accountId,
      decision: "approve" as const,
    };
    expect(await cliDeviceLoginDecide(env, input, NOW)).toEqual({
      ok: true,
      status: "approved",
    });
    expect(await cliDeviceLoginDecide(env, input, NOW)).toEqual({ ok: false });
    expect(await cliDeviceLoginLookup(env, s.code, NOW)).toBeNull();
  });

  it("does not decide an expired code", async () => {
    const { env, db } = await setup();
    const ada = await signIn(env, db, "ada@example.com");
    const s = await startCli(env, db);
    expect(await cliDeviceLoginLookup(env, s.code, NOW + 301)).toBeNull();
    expect(
      await cliDeviceLoginDecide(
        env,
        { code: s.code, accountId: ada.accountId, decision: "approve" },
        NOW + 301,
      ),
    ).toEqual({ ok: false });
  });
});

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("the poll of a CLI record", () => {
  async function approved() {
    const w = await setup();
    const ada = await signIn(w.env, w.db, "ada@example.com");
    const s = await startCli(w.env, w.db);
    await cliDeviceLoginDecide(
      w.env,
      { code: s.code, accountId: ada.accountId, decision: "approve" },
      NOW,
    );
    return { ...w, ada, s };
  }

  it("mints exactly one admin token, sets no session cookie, and a second poll is 410", async () => {
    const { env, db, ada, s } = await approved();
    const res = await poll(env, db, s);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toContain(`${PORTAL_COOKIE}=`);
    expect(setCookie).toContain(`${DEVICE_LOGIN_COOKIE}=;`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "approved",
      scope: "admin",
      label: "pkey on ada-mbp.local",
      expiresAt: NOW + 7 * 86_400,
    });
    expect(body.token).toMatch(/^pkeyp_/);
    const rows = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM account_tokens WHERE account_id = ? AND scope = 'admin'",
      ada.accountId,
    );
    expect(rows[0]!.n).toBe(1);
    // The token works for the admin scope and only that.
    expect(
      await resolvePersonalToken(env, db, body.token as string, "admin", NOW),
    ).not.toBeNull();
    expect(
      await resolvePersonalToken(
        env,
        db,
        body.token as string,
        "packages:read",
        NOW,
      ),
    ).toBeNull();
    expect((await poll(env, db, s)).status).toBe(410);
    const again = await db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM account_tokens WHERE account_id = ?",
      ada.accountId,
    );
    expect(again[0]!.n).toBe(1);
  });

  it("keeps the plaintext out of the stored artefact and out of the audit", async () => {
    const { env, db, s } = await approved();
    const res = await poll(env, db, s);
    const token = ((await res.json()) as { token: string }).token;
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    for (const { name } of tables) {
      const dump = JSON.stringify(await db.all(`SELECT * FROM "${name}"`));
      expect(dump).not.toContain(token);
    }
  });

  it("cleans client text by code points: no lone surrogate, no invisible fillers, no zalgo", async () => {
    const { env, db } = await setup();
    const emoji = await startCli(env, db, {
      ...CLI_START,
      client: {
        host: `${"a".repeat(63)}\u{1F600}`,
        name: "n".repeat(31) + "\u{1F600}x",
      },
    });
    const v = (await cliDeviceLoginLookup(env, emoji.code, NOW))!;
    expect(Array.from(v.client.host)).toHaveLength(64);
    expect(v.client.host.endsWith("\u{1F600}")).toBe(true);
    expect(Array.from(v.client.name)).toHaveLength(32);
    for (const t of [v.client.host, v.client.name])
      expect(t).not.toMatch(LONE_SURROGATE);
    // 63 + emoji = 66 UTF-16 units but 64 points; one more point is cut whole.
    const over = await startCli(
      env,
      db,
      { ...CLI_START, client: { host: `${"a".repeat(63)}\u{1F600}\u{1F600}` } },
      "203.0.113.8",
    );
    const ov = (await cliDeviceLoginLookup(env, over.code, NOW))!;
    expect(ov.client.host).not.toMatch(LONE_SURROGATE);
    expect(Array.from(ov.client.host)).toHaveLength(64);
    const fill = await startCli(
      env,
      db,
      {
        ...CLI_START,
        client: { host: "\u3164\u115F\u1160\uFFA0\u2800\u200B" },
      },
      "203.0.113.9",
    );
    const fv = (await cliDeviceLoginLookup(env, fill.code, NOW))!;
    expect(fv.client.host).toBe("an unnamed host");
    const zalgo = await startCli(
      env,
      db,
      { ...CLI_START, client: { host: `z${"\u0301".repeat(40)}` } },
      "203.0.113.10",
    );
    const zv = (await cliDeviceLoginLookup(env, zalgo.code, NOW))!;
    expect(zv.client.host.length).toBeLessThanOrEqual(4);
  });

  it("keeps an astral host's label within the mint's UTF-16 cap, cut between whole code points", () => {
    for (const host of [`${"a".repeat(55)}\u{1F4BB}`, "\u{1F4BB}".repeat(40)]) {
      const label = cliTokenLabel({ name: "pkey", version: "", host });
      expect(label.length).toBeLessThanOrEqual(PERSONAL_TOKEN_LABEL_MAX);
      expect(label).not.toMatch(LONE_SURROGATE);
    }
  });

  it("answers denied with no token", async () => {
    const { env, db } = await setup();
    const ada = await signIn(env, db, "ada@example.com");
    const s = await startCli(env, db);
    await cliDeviceLoginDecide(
      env,
      { code: s.code, accountId: ada.accountId, decision: "deny" },
      NOW,
    );
    const res = await poll(env, db, s);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "denied" });
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM account_tokens",
    );
    expect(n!.n).toBe(0);
    expect((await poll(env, db, s)).status).toBe(410);
  });

  it("is pending until decided", async () => {
    const { env, db } = await setup();
    const s = await startCli(env, db);
    const res = await poll(env, db, s);
    expect(await res.json()).toMatchObject({ status: "pending" });
  });

  it("requires the binding cookie: without it, or with another's, it is 410 and mints nothing", async () => {
    const { env, db, ada, s } = await approved();
    expect((await poll(env, db, s, null)).status).toBe(410);
    const other = await startCli(env, db, CLI_START, "203.0.113.9");
    expect((await poll(env, db, s, other.binding)).status).toBe(410);
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM account_tokens WHERE account_id = ?",
      ada.accountId,
    );
    expect(n!.n).toBe(0);
    // The record survives the refused polls: the right browser still gets it.
    expect((await poll(env, db, s)).status).toBe(200);
  });

  it("is expired after five minutes", async () => {
    const { env, db, s } = await approved();
    const res = await call(env, db, "GET", `/api/device-login/${s.id}`, {
      cookie: s.binding,
      now: NOW + 301,
    });
    expect(res.status).toBe(410);
  });

  it("refuses an approval by an erased account with 403 and mints nothing", async () => {
    const w = await setup();
    const ada = await signIn(w.env, w.db, "ada@example.com");
    const s = await startCli(w.env, w.db);
    await cliDeviceLoginDecide(
      w.env,
      { code: s.code, accountId: ada.accountId, decision: "approve" },
      NOW,
    );
    await eraseAndRestore(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      ada.accountId,
    );
    const res = await poll(w.env, w.db, s);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "account_disabled" });
    const n = await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM account_tokens WHERE scope = 'admin' AND revoked_at IS NULL",
    );
    expect(n!.n).toBe(0);
  });

  it("refuses an approval by a disabled account", async () => {
    const { env, db, ada, s } = await approved();
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      ada.accountId,
    );
    const res = await poll(env, db, s);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "account_disabled" });
  });

  it("writes the create audit row on a successful CLI mint, with the approver's member id and no plaintext", async () => {
    const { env, db, ada, s } = await approved();
    const res = await poll(env, db, s);
    const body = (await res.json()) as { token: string };
    const rows = await db.all<{
      account_id: string;
      action: string;
      target_kind: string;
      target_id: string;
      summary: string;
    }>(
      "SELECT * FROM portal_audit WHERE action = 'portal.personal_token.create'",
    );
    expect(rows).toHaveLength(1);
    const tok = await db.first<{ id: string }>(
      "SELECT id FROM account_tokens WHERE account_id = ?",
      ada.accountId,
    );
    expect(rows[0]).toMatchObject({
      account_id: ada.accountId,
      target_kind: "account_token",
      target_id: tok!.id,
    });
    expect(rows[0]!.summary).toContain("pkey on ada-mbp.local");
    expect(rows[0]!.summary).toContain("admin");
    expect(rows[0]!.summary).toContain(await memberIdFor(env, ada.accountId));
    expect(rows[0]!.summary).not.toContain(body.token);
  });

  it("writes no create row for a refused mint (token_limit, 409)", async () => {
    const { env, db, ada, s } = await approved();
    for (let i = 0; i < 25; i++)
      await mintAccountToken(
        env,
        db,
        {
          accountId: ada.accountId,
          label: `t${i}`,
          scope: "packages:read",
          createdBy: "x",
        },
        NOW,
      );
    const res = await poll(env, db, s);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "token_limit" });
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM portal_audit WHERE action = 'portal.personal_token.create'",
    );
    expect(n!.n).toBe(0);
  });

  it("answers expired and mints nothing when the approver was merged away before the poll", async () => {
    const { env, db, ada, s } = await approved();
    const bob = await signIn(env, db, "bob@example.com");
    await db.run("PRAGMA foreign_keys = OFF");
    await db.run("DELETE FROM accounts WHERE id = ?", ada.accountId);
    await db.run(
      "INSERT INTO account_tombstones (id, merged_into, deleted_at) VALUES (?, ?, ?)",
      ada.accountId,
      bob.accountId,
      NOW,
    );
    await db.run("PRAGMA foreign_keys = ON");
    const res = await poll(env, db, s);
    expect(res.status).toBe(410);
    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM account_tokens WHERE scope = 'admin'",
    );
    expect(n!.n).toBe(0);
  });
});
