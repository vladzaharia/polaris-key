/**
 * ST-34.6 — the console's approval card for `pkey login` (`GET|POST /manage/device`).
 *
 * The decision gates (session, member, budget, origin, CSRF, explicit decision, step-up, the
 * atomic decide), what is written (one audit row, one notice) and what the card prints.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAdminFlow } from "../../flowBinderHelper.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { asR2 } from "../../r2Mock.js";
import { LedgerBucket } from "../../eraseRestore.js";
import { makeEnv, NOW, seedProduct } from "../../seed.js";
import type { Env } from "../../../src/platform/env.js";
import type { Db } from "../../../src/db/types.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  type IdTokenVerifier,
} from "../../../src/console/auth.js";
import { resetConsoleSessionCache } from "../../../src/console/consoleSession.js";
import {
  ADMIN_COOKIE,
  issueSessionV2,
} from "../../../src/core/console/session.js";
import { forgeV1Cookie } from "../../consoleSessionHelper.js";
import { handlePortalApi } from "../../portalHarness.js";
import { issuePortalSessionRow } from "../../portalSessionRow.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../../../src/services/identity/portal/session.js";
import { sanitizeReturnTo } from "../../../src/console/auth.js";
import {
  MAX_LIVE_PERSONAL_TOKENS,
  mintAccountToken,
} from "../../../src/core/accounts/personalTokens.js";
import { getOrCreateAccountByEmail } from "../../../src/services/identity/portal/repo.js";

// A session that resolves to no grant: the principal is emptied while the flag is set.
const NO_GRANTS = { on: false };
vi.mock("../../../src/core/rbac/principal.js", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../../../src/core/rbac/principal.js")
    >();
  return {
    ...real,
    resolvePrincipal: async (
      ...args: Parameters<typeof real.resolvePrincipal>
    ) => {
      const p = await real.resolvePrincipal(...args);
      return NO_GRANTS.on ? { ...p, grants: [] } : p;
    },
  };
});

const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

interface World {
  env: Env;
  db: Db;
  sent: Array<{ to: string; subject: string; text: string }>;
}

async function world(): Promise<World> {
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  env.BLOBS = asR2(new LedgerBucket());
  const sent: World["sent"] = [];
  env.EMAIL = {
    send: async (m: { to: string; subject: string; text: string }) => {
      sent.push(m);
    },
  } as unknown as Env["EMAIL"];
  const db = await makeTestDb();
  await seedProduct(db, "djdl");
  resetConsoleSessionCache();
  return { env, db, sent };
}

interface Console {
  cookie: string;
  csrf: string;
  aid: string;
  sid: string;
  stepped: { cookie: string; csrf: string };
}

/** A real console sign-in (v2 cookie); `stepped` is the same session after a step-up. */
async function consoleSignIn(
  { env, db }: World,
  groups = [GROUP],
  email = "ada@example.com",
): Promise<Console | null> {
  const start = await handleAdminLogin(
    new Request("https://key.plrs.im/manage/login?go=1"),
    env,
  );
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: "op-" + email,
      email,
      emailVerified: true,
      name: "Ada",
      groups,
    }),
  };
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: { cookie: await bindAdminFlow(env, state) },
    }),
    env,
    db,
    NOW,
    verifier,
  );
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!cookie.startsWith(`${ADMIN_COOKIE}=`)) return null;
  const token = cookie.slice(cookie.indexOf("=") + 1);
  const claims = JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString(),
  ) as { aid: string; sid: string; csrf: string };
  const up = await issueSessionV2(
    env,
    {
      aid: claims.aid,
      sid: claims.sid,
      name: "Ada",
      email,
      authTime: NOW,
      stepUp: true,
    },
    NOW,
  );
  return {
    cookie,
    csrf: claims.csrf,
    aid: claims.aid,
    sid: claims.sid,
    stepped: {
      cookie: `${ADMIN_COOKIE}=${up.token}`,
      csrf: up.claims.csrf,
    },
  };
}

interface Started {
  id: string;
  code: string;
  binding: string;
}

async function startCli(
  { env, db }: World,
  client: Record<string, string> = {
    name: "pkey",
    version: "1.2.3",
    host: "ada-mbp.local",
  },
): Promise<Started> {
  const res = await handlePortalApi(
    new Request("https://key.plrs.im/api/device-login/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": CHROME_MAC,
        "cf-connecting-ip": "203.0.113.7",
        "cf-ipcountry": "PT",
      },
      body: JSON.stringify({ purpose: "cli", scope: "admin", client }),
    }),
    env,
    db,
    "/api/device-login/start",
    NOW,
  );
  expect(res.status).toBe(201);
  const binding = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { ...((await res.json()) as Omit<Started, "binding">), binding };
}

const poll = ({ env, db }: World, s: Started) =>
  handlePortalApi(
    new Request(`https://key.plrs.im/api/device-login/${s.id}`, {
      headers: { cookie: s.binding },
    }),
    env,
    db,
    `/api/device-login/${s.id}`,
    NOW,
  );

function device(
  w: World,
  method: "GET" | "POST",
  opts: {
    path?: string;
    cookie?: string;
    form?: Record<string, string>;
    headers?: Record<string, string>;
    now?: number;
  } = {},
): Promise<Response> {
  const path = opts.path ?? "/device";
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  const init: RequestInit = { method, headers };
  if (opts.form) {
    init.body = new URLSearchParams(opts.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, init),
    w.env,
    w.db,
    path.split("?")[0]!,
    { now: opts.now ?? NOW },
  );
}

const decide = (
  w: World,
  s: { cookie: string; csrf: string },
  code: string,
  decision: string,
  extra: Record<string, string> = {},
) =>
  device(w, "POST", {
    cookie: s.cookie,
    form: { code, decision, csrf: s.csrf, ...extra },
  });

async function auditActions(db: Db): Promise<string[]> {
  const rows = await db.all<{ action: string }>(
    "SELECT action FROM platform_audit WHERE action LIKE 'cli.login.%' ORDER BY id",
  );
  return rows.map((r) => r.action);
}

let w: World;
beforeEach(async () => {
  w = await world();
});

describe("who may open and decide", () => {
  it("sends no session, a portal session, a v1 cookie and a token to sign in", async () => {
    const c = await consoleSignIn(w);
    const s = await startCli(w);
    const toLogin = (r: Response) => {
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toMatch(/^\/manage\/login\?/);
    };
    toLogin(await device(w, "GET", { path: `/device?code=${s.code}` }));

    const account = await getOrCreateAccountByEmail(w.db, "p@example.com", NOW);
    const { token, session } = await issuePortalSessionRow(
      w.env,
      w.db,
      {
        accountId: account.id,
        email: account.primary_email,
        name: account.display_name,
      },
      NOW,
    );
    toLogin(
      await device(w, "POST", {
        cookie: `${PORTAL_COOKIE}=${token}`,
        headers: { [PORTAL_CSRF_HEADER]: session.csrf },
        form: { code: s.code, decision: "approve", csrf: session.csrf },
      }),
    );

    const v1 = await forgeV1Cookie(
      w.env,
      { sub: "op-1", groups: [GROUP] },
      NOW,
    );
    toLogin(
      await device(w, "POST", {
        cookie: `${ADMIN_COOKIE}=${v1.token}`,
        form: { code: s.code, decision: "approve", csrf: v1.csrf },
      }),
    );

    // A bearer token opens nothing here.
    toLogin(
      await device(w, "POST", {
        headers: { authorization: "Bearer pkeyp_abc" },
        form: { code: s.code, decision: "approve", csrf: c!.csrf },
      }),
    );
    // None of it consumed the code.
    expect((await poll(w, s)).status).toBe(200);
    expect(await auditActions(w.db)).toEqual([]);
  });

  it("gives a session with no grant the no-access card, and decides nothing", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    NO_GRANTS.on = true;
    try {
      for (const res of [
        await device(w, "GET", {
          path: `/device?code=${s.code}`,
          cookie: c.stepped.cookie,
        }),
        await decide(w, c.stepped, s.code, "approve"),
      ]) {
        expect(res.status).toBe(403);
        expect(await res.text()).toContain("don’t have access");
      }
    } finally {
      NO_GRANTS.on = false;
    }
    expect(await auditActions(w.db)).toEqual([]);
    expect((await poll(w, s)).status).toBe(200);
  });
});

describe("the review card", () => {
  it("shows the machine as unverified, the roles, the end date, and no Approve without a step-up", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const res = await device(w, "GET", {
      path: `/device?code=${s.code}`,
      cookie: c.cookie,
    });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Let pkey sign in as you?");
    // The code sits inside the "check this matches" panel, and is not a row of a list.
    expect(page).toMatch(
      new RegExp(
        `Check this matches your terminal</p><p class="code">${s.code}</p>`,
      ),
    );
    expect(page).not.toContain("<dt>");
    // The host once, "unverified" once, the date in the console's format, the cap on packages.
    expect(page).toContain("ada-mbp.local");
    expect(page.match(/>unverified</g)).toHaveLength(1);
    expect(page).toContain("Ends Nov 21, 2023");
    expect(page).toContain("Can’t install packages");
    expect(page).toContain("Portugal (approximate)");
    expect(page).toContain("Didn’t just run pkey login? Cancel.");
    // One way forward, and "Sign in again to approve" said once.
    expect(page.match(/Sign in again to approve/g)).toHaveLength(1);
    expect(page).toContain("Not you?");
    expect(page).not.toMatch(/value="approve"/);
    expect(page).toContain(
      `/manage/login?stepUp=1&amp;returnTo=${encodeURIComponent(`/manage/device?code=${s.code}`)}`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("with a step-up shows Approve and Cancel as two forms carrying the CSRF field", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const page = await (
      await device(w, "GET", {
        path: `/device/${s.code}`,
        cookie: c.stepped.cookie,
      })
    ).text();
    expect(page).toMatch(/value="approve"/);
    expect(page).toMatch(/value="deny"/);
    expect(page.match(/name="csrf"/g)).toHaveLength(2);
    expect(page).toContain(c.stepped.csrf);
    expect(page).not.toContain("Sign in again to approve");
  });

  it("has no inline script and the sign-in page's CSP", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const res = await device(w, "GET", {
      path: `/device?code=${s.code}`,
      cookie: c.stepped.cookie,
    });
    const page = await res.text();
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("asks for a code when there is none, and shows expired for an unknown or lapsed one", async () => {
    const c = (await consoleSignIn(w))!;
    const entry = await device(w, "GET", { cookie: c.cookie });
    expect(entry.status).toBe(200);
    const entryPage = await entry.text();
    expect(entryPage).toContain("Enter the code from your terminal");
    expect(entryPage).toContain("autofocus");
    expect(entryPage).toContain("Like QXKM-TPRW");
    const unknown = await device(w, "GET", {
      path: "/device?code=ZZZZ-ZZZZ",
      cookie: c.cookie,
    });
    expect(unknown.status).toBe(410);
    const unknownPage = await unknown.text();
    expect(unknownPage).toContain("This code can’t be used");
    expect(unknownPage).toContain("wrong, expired or already used");
    expect(unknownPage).not.toContain("Nothing was approved");
    const s = await startCli(w);
    const late = await device(w, "GET", {
      path: `/device?code=${s.code}`,
      cookie: c.cookie,
      now: NOW + 301,
    });
    expect(late.status).toBe(410);
    expect(await late.text()).toContain("This code can’t be used");
  });

  it("cleans spaces and case before the shape check, and keeps what was typed on an error", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const lower = s.code.toLowerCase().replace("-", " ");
    const ok = await device(w, "GET", {
      path: `/device?entered=1&code=${encodeURIComponent(lower)}`,
      cookie: c.cookie,
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Let pkey sign in as you?");
    // Not a code: the form again, the value kept, the reason under the field, nothing looked up.
    const bad = await device(w, "GET", {
      path: "/device?entered=1&code=hello%20there",
      cookie: c.cookie,
    });
    expect(bad.status).toBe(200);
    const badPage = await bad.text();
    expect(badPage).toContain('value="hello there"');
    expect(badPage).toContain('aria-invalid="true"');
    expect(badPage).toMatch(/class="field-err"[^>]*role="alert"/);
    expect(badPage).toContain("That isn’t a code");
    // A well-formed code that is not live: the form again from the form, the card from a link.
    const unknown = await device(w, "GET", {
      path: "/device?entered=1&code=zzzz-zzzz",
      cookie: c.cookie,
    });
    expect(unknown.status).toBe(200);
    const unknownPage = await unknown.text();
    expect(unknownPage).toContain('value="ZZZZ-ZZZZ"');
    expect(unknownPage).toContain("wrong, expired or already used");
    expect(unknownPage).not.toContain("Nothing was approved");
  });

  it("marks a value cut at its limit with an ellipsis", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w, {
      name: "pkey",
      version: "1.2.3",
      host: "h".repeat(70),
    });
    const page = await (
      await device(w, "GET", {
        path: `/device?code=${s.code}`,
        cookie: c.cookie,
      })
    ).text();
    expect(page).toContain(`${"h".repeat(64)}…`);
  });

  it("names roles like the console, sorted, and the passport pane carries what the terminal claims", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const page = await (
      await device(w, "GET", {
        path: `/device?code=${s.code}`,
        cookie: c.cookie,
      })
    ).text();
    expect(page).toContain(
      '<p class="tags"><span class="tag">Superadmin</span>',
    );
    expect(page).toContain("ac-passport");
    expect(page).toContain("on <bdi>ada-mbp.local</bdi>");
    expect(page).toContain("1.2.3");
    expect(page).toContain(
      "Your Superadmin role comes from your sign-in provider, so pkey stops working 8 hours after your last console sign-in.",
    );
  });

  it("escapes the host, the program name and the version", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w, {
      name: `<img src=x onerror=alert(1)>`,
      version: `"><script>alert(2)</script>`,
      host: `<script>alert(3)</script>&"'`,
    });
    const page = await (
      await device(w, "GET", {
        path: `/device?code=${s.code}`,
        cookie: c.stepped.cookie,
      })
    ).text();
    // The label and the place are escaped too.
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;script&gt;alert(3)");
  });

  it("leaks no account id", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    for (const cookie of [c.cookie, c.stepped.cookie]) {
      const page = await (
        await device(w, "GET", { path: `/device?code=${s.code}`, cookie })
      ).text();
      expect(page).not.toContain(c.aid);
      expect(page).not.toMatch(/acct_[A-Za-z0-9]/);
    }
    const done = await decide(w, c.stepped, s.code, "approve");
    expect(await done.text()).not.toContain(c.aid);
  });
});

describe("the decision", () => {
  it("approve: one audit row, one notice, the terminal's poll gets one token", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const res = await decide(w, c.stepped, s.code, "approve");
    expect(res.status).toBe(200);
    const done = await res.text();
    expect(done).toContain("Go back to your terminal");
    expect(done).toContain(
      "pkey on ada-mbp.local can act as you until Nov 21, 2023",
    );
    expect(done).toContain('class="ic lg"');
    expect(await auditActions(w.db)).toEqual(["cli.login.approve"]);
    const row = await w.db.all<{ actor_sub: string; summary: string }>(
      "SELECT actor_sub, summary FROM platform_audit WHERE action = 'cli.login.approve'",
    );
    expect(row[0]!.actor_sub).toMatch(/^mbr_/);
    expect(row[0]!.summary).toContain("ada-mbp.local");
    expect(w.sent).toHaveLength(1);
    // The D-17 notice is the console's, not Locker's: its remedy is Personal tokens.
    const mail = w.sent[0]!;
    expect(mail.subject).toBe(
      "A command line signed in to the Polaris Key console as you",
    );
    expect(mail.text).toContain("pkey on ada-mbp.local");
    expect(mail.text).toContain("Personal tokens");
    expect(mail.text).toContain("https://key.plrs.im/manage/");
    expect(mail.text).not.toContain("Locker");
    expect(mail.text).not.toContain("account/sessions");
    const polled = await poll(w, s);
    expect(polled.status).toBe(200);
    expect(((await polled.json()) as { token: string }).token).toMatch(
      /^pkeyp_/,
    );
  });

  it("deny: one audit row, no notice, and the poll answers denied with no token", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    // A plain (not stepped-up) session may cancel: it ends a request and mints nothing.
    const res = await decide(
      w,
      { cookie: c.cookie, csrf: c.csrf },
      s.code,
      "deny",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sign-in canceled");
    expect(await auditActions(w.db)).toEqual(["cli.login.deny"]);
    expect(w.sent).toHaveLength(0);
    const polled = await poll(w, s);
    expect(await polled.json()).toEqual({ status: "denied" });
    const tokens = await w.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM account_tokens",
    );
    expect(tokens[0]!.n).toBe(0);
    expect((await poll(w, s)).status).toBe(410);
  });

  it("refuses approve without a step-up (403), keeps the code live and audits the refusal", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const res = await decide(
      w,
      { cookie: c.cookie, csrf: c.csrf },
      s.code,
      "approve",
    );
    expect(res.status).toBe(403);
    const page = await res.text();
    expect(page).toContain("Sign in again to approve");
    expect(page).not.toMatch(/value="approve"/);
    expect(await auditActions(w.db)).toEqual(["cli.login.step_up_required"]);
    expect(w.sent).toHaveLength(0);
    // The code is still live: the stepped-up session can approve it.
    expect((await decide(w, c.stepped, s.code, "approve")).status).toBe(200);
  });

  it("refuses a stale step-up (six minutes old) with 403 and the code still live", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const old = await issueSessionV2(
      w.env,
      {
        aid: c.aid,
        sid: c.sid,
        name: "Ada",
        email: "ada@example.com",
        authTime: NOW - 400,
        stepUp: true,
      },
      NOW - 400,
    );
    const res = await device(w, "POST", {
      cookie: `${ADMIN_COOKIE}=${old.token}`,
      form: { code: s.code, decision: "approve", csrf: old.claims.csrf },
    });
    expect(res.status).toBe(403);
    const page = await res.text();
    expect(page).toContain(
      "Approving needs a sign-in from the last five minutes.",
    );
    expect(page).toMatch(/<p role="alert">/);
    expect(page).not.toMatch(/value="approve"/);
    expect(await auditActions(w.db)).toEqual(["cli.login.step_up_required"]);
    expect(w.sent).toHaveLength(0);
    // The code is still live, and a session inside the window approves it.
    expect((await poll(w, s)).status).toBe(200);
    const fresh = await device(w, "POST", {
      cookie: c.stepped.cookie,
      form: { code: s.code, decision: "approve", csrf: c.stepped.csrf },
      now: NOW + 120,
    });
    expect(fresh.status).toBe(200); // still inside five minutes
  });

  it("refuses a missing, wrong or another session's CSRF field with 403 and decides nothing", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    for (const form of [
      { code: s.code, decision: "approve" } as Record<string, string>,
      { code: s.code, decision: "approve", csrf: "nope" },
      { code: s.code, decision: "approve", csrf: c.csrf }, // the unstepped cookie's token, wrong cookie
    ]) {
      const res = await device(w, "POST", {
        cookie: c.stepped.cookie,
        form,
      });
      expect(res.status).toBe(403);
    }
    expect(await auditActions(w.db)).toEqual([]);
    expect((await poll(w, s)).status).toBe(200);
  });

  it("refuses a cross-origin POST and an unknown decision", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const form = { code: s.code, decision: "approve", csrf: c.stepped.csrf };
    const refused: Array<Record<string, string>> = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none" },
    ];
    for (const headers of refused) {
      const cross = await device(w, "POST", {
        cookie: c.stepped.cookie,
        headers,
        form,
      });
      expect(cross.status, JSON.stringify(headers)).toBe(403);
    }
    for (const decision of ["", "yes", "APPROVE", "approve,deny"]) {
      const res = await decide(w, c.stepped, s.code, decision);
      expect(res.status).toBe(400);
    }
    expect(await auditActions(w.db)).toEqual([]);
  });

  it("accepts what a browser really sends: Origin null under no-referrer, with Sec-Fetch-Site same-origin, or with no fetch metadata at all", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const post = (headers: Record<string, string>, decision: string) =>
      device(w, "POST", {
        cookie: c.stepped.cookie,
        headers,
        form: { code: s.code, decision, csrf: c.stepped.csrf },
      });
    // A page served with `referrer-policy: no-referrer`: Chromium and WebKit send `Origin: null`.
    const meta = await device(w, "GET", {
      path: `/device?code=${s.code}`,
      cookie: c.stepped.cookie,
    });
    expect(meta.headers.get("referrer-policy")).toBe("no-referrer");
    expect(
      (await post({ origin: "null", "sec-fetch-site": "same-origin" }, "deny"))
        .status,
    ).toBe(200);
    // No headers at all (curl): accepted; the CSRF field is still required.
    const s2 = await startCli(w);
    const bare = await device(w, "POST", {
      cookie: c.stepped.cookie,
      form: { code: s2.code, decision: "approve", csrf: c.stepped.csrf },
    });
    expect(bare.status).toBe(200);
    const s3 = await startCli(w);
    const noCsrf = await device(w, "POST", {
      cookie: c.stepped.cookie,
      headers: { origin: "null" },
      form: { code: s3.code, decision: "approve" },
    });
    expect(noCsrf.status).toBe(403);
    // The same host's own Origin passes without fetch metadata; `null` does too (the same rule
    // the device-flow pages use, lifted into Core).
    const own = await device(w, "POST", {
      cookie: c.stepped.cookie,
      headers: { origin: "https://key.plrs.im" },
      form: { code: s3.code, decision: "deny", csrf: c.stepped.csrf },
    });
    expect(own.status).toBe(200);
  });

  it("denying needs the CSRF field too", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    for (const csrf of [undefined, "nope", c.stepped.csrf]) {
      const res = await device(w, "POST", {
        cookie: c.cookie, // the unstepped session: its own token is c.csrf
        form: { code: s.code, decision: "deny", ...(csrf ? { csrf } : {}) },
      });
      expect(res.status).toBe(403);
    }
    expect(await auditActions(w.db)).toEqual([]);
    expect((await poll(w, s)).status).toBe(200);
  });

  it("caps the body by the bytes read, not by Content-Length", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const body = new URLSearchParams({
      code: s.code,
      decision: "deny",
      csrf: c.stepped.csrf,
      pad: "x".repeat(4000),
    }).toString();
    const res = await handleAdmin(
      new Request("https://key.plrs.im/manage/device", {
        method: "POST",
        headers: {
          cookie: c.stepped.cookie,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": "10", // a lie
        },
        body,
      }),
      w.env,
      w.db,
      "/device",
      { now: NOW },
    );
    expect(res.status).toBe(413);
    expect(await auditActions(w.db)).toEqual([]);
  });

  it("escapes the client's label and the approximate place in the card", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w, {
      name: "pkey",
      version: "1",
      host: `<b onmouseover="x">&amp;`,
    });
    const page = await (
      await device(w, "GET", {
        path: `/device?code=${s.code}`,
        cookie: c.cookie,
      })
    ).text();
    expect(page).not.toContain("<b onmouseover");
    expect(page).toContain("&lt;b onmouseover=&quot;x&quot;&gt;&amp;amp;");
  });

  it("still sends the notice when the audit write fails", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const real = w.db.run.bind(w.db);
    const spy = vi.spyOn(w.db, "run").mockImplementation(async (sql, ...a) => {
      if (/INSERT INTO platform_audit/i.test(String(sql)))
        throw new Error("audit down");
      return (real as (...x: unknown[]) => unknown)(sql, ...a) as never;
    });
    try {
      await decide(w, c.stepped, s.code, "approve").catch(() => null);
    } finally {
      spy.mockRestore();
    }
    expect(w.sent).toHaveLength(1);
    expect(await auditActions(w.db)).toEqual([]); // the audit write really failed
  });

  it("a reused code is the expired card, with no second audit row or notice", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    expect((await decide(w, c.stepped, s.code, "approve")).status).toBe(200);
    const again = await decide(w, c.stepped, s.code, "approve");
    expect(again.status).toBe(410);
    expect(await auditActions(w.db)).toEqual(["cli.login.approve"]);
    expect(w.sent).toHaveLength(1);
  });

  it("an expired code decides nothing", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    const res = await device(w, "POST", {
      cookie: c.stepped.cookie,
      form: { code: s.code, decision: "approve", csrf: c.stepped.csrf },
      now: NOW + 301,
    });
    expect(res.status).toBe(410);
    expect(await auditActions(w.db)).toEqual([]);
  });

  it("is rate limited per member before any code is looked up", async () => {
    const c = (await consoleSignIn(w))!;
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (
        await device(w, "GET", {
          path: "/device?code=ZZZZ-ZZZZ",
          cookie: c.cookie,
        })
      ).status;
    }
    expect(last).toBe(429);
  });

  it("answers other methods with 405", async () => {
    const c = (await consoleSignIn(w))!;
    const res = await handleAdmin(
      new Request("https://key.plrs.im/manage/device", {
        method: "PUT",
        headers: { cookie: c.cookie },
      }),
      w.env,
      w.db,
      "/device",
      { now: NOW },
    );
    expect(res.status).toBe(405);
  });
});

describe("signed out", () => {
  it("goes to sign-in with a step-up, and a cross-site landing gets a script-free meta refresh", async () => {
    const s = await startCli(w);
    const plain = await device(w, "GET", { path: `/device?code=${s.code}` });
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe(
      `/manage/login?stepUp=1&returnTo=${encodeURIComponent(`/manage/device?code=${s.code}`)}`,
    );
    const hop = await device(w, "GET", {
      path: `/device?code=${s.code}`,
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(hop.status).toBe(200);
    const page = await hop.text();
    expect(page).toContain(
      `<meta http-equiv="refresh" content="0;url=/manage/device?code=${s.code}">`,
    );
    expect(page).toContain(`href="/manage/device?code=${s.code}"`);
    expect(page).not.toMatch(/<script/i);
    // A same-origin visit with no session still gets the 303.
    expect(
      (
        await device(w, "GET", {
          path: `/device?code=${s.code}`,
          headers: { "sec-fetch-site": "same-origin" },
        })
      ).status,
    ).toBe(303);
  });
});

describe("the account's token limit", () => {
  it("says so on the card and on a forged approve, and keeps the code live", async () => {
    const c = (await consoleSignIn(w))!;
    const s = await startCli(w);
    for (let i = 0; i < MAX_LIVE_PERSONAL_TOKENS; i++) {
      const m = await mintAccountToken(
        w.env,
        w.db,
        {
          accountId: c.aid,
          label: `t${i}`,
          scope: "packages:read",
          createdBy: "test",
        },
        NOW,
      );
      expect(m.ok).toBe(true);
    }
    const get = await device(w, "GET", {
      path: `/device?code=${s.code}`,
      cookie: c.stepped.cookie,
    });
    expect(get.status).toBe(409);
    const page = await get.text();
    expect(page).toContain("Too many tokens");
    expect(page).not.toMatch(/value="approve"/);
    const post = await decide(w, c.stepped, s.code, "approve");
    expect(post.status).toBe(409);
    expect(await auditActions(w.db)).toEqual([]);
    expect(w.sent).toHaveLength(0);
    // Nothing was consumed: the request is still pending, and Cancel still works.
    expect((await decide(w, c.stepped, s.code, "deny")).status).toBe(200);
  });
});

describe("the step-up returnTo", () => {
  it("lands a step-up back on the card, and opens no redirect", () => {
    expect(sanitizeReturnTo("/manage/device?code=QXKM-TPRW")).toBe(
      "/manage/device?code=QXKM-TPRW",
    );
    for (const bad of [
      "https://evil.example/manage/device?code=QXKM-TPRW",
      "//evil.example/manage/device?code=QXKM-TPRW",
      "/manage/device?code=QXKM-TPRW&next=https://evil.example",
      "/manage/device?code=QXKM-TPRW#x",
      "/manage/device?code=",
      "/manage/device?code=a/../b",
      "/manage/device?code=%2F%2Fevil",
      "/manage/device%3Fcode=QXKM-TPRW",
      "/manage/deviceX?code=QXKM-TPRW",
      "/manage/device?other=QXKM-TPRW",
      "/manage/device?code=QXKM-TPRW\r\nx: y",
      "/manage/device?code=" + "A".repeat(21),
      "\\evil.example",
      "/\\evil.example",
    ])
      expect(sanitizeReturnTo(bad), bad).toBeNull();
  });

  it("round-trips through the real sign-in card as a hidden field", async () => {
    const res = await handleAdmin(
      new Request(
        `https://key.plrs.im/manage/login?stepUp=1&returnTo=${encodeURIComponent("/manage/device?code=QXKM-TPRW")}`,
      ),
      w.env,
      w.db,
      "/login",
      { now: NOW },
    );
    expect(await res.text()).toContain(
      'name="returnTo" value="/manage/device?code=QXKM-TPRW"',
    );
  });
});
