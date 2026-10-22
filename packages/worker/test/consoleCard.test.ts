/**
 * ST-30c.2: the console card's known-operator chip (D-S5), Change, the break-glass link and start
 * card, and the break-glass session's N2 (only the root group in the cookie) and N3 (no durable
 * credentials). The hint cookie is a convenience and never authorises.
 */
import { beforeEach, describe, expect, it } from "vitest";
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
import {
  ADMIN_COOKIE,
  BREAK_GLASS_TTL_SECONDS,
  CSRF_HEADER,
  issueSession,
  issueSessionV2,
  STEP_UP_MAX_AGE_SECONDS,
  type SessionIdentity,
} from "../src/core/console/session.js";
import { refuseBreakGlass } from "../src/console/lib/accountSession.js";
import { newBindingId, stmtInsertBinding } from "../src/core/rbac/bindings.js";
import { importHmacKey } from "../src/platform/hash.js";
import { signHmacToken } from "../src/platform/hmacToken.js";
import { breakGlassUsedNotice } from "../src/core/notify/templates.js";

const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const SECRET = "test-admin-session-secret";

type Db = ReturnType<typeof makeTestDb>;
interface Mail {
  to: string;
  subject: string;
  text: string;
}

let mail: Mail[];
let env: Env;
let db: Db;

beforeEach(() => {
  resetConsoleSessionCache();
  mail = [];
  env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = SECRET;
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  env.EMAIL = {
    send: async (m: Mail) => {
      mail.push(m);
    },
  } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  db = makeTestDb();
});

interface Idp {
  sub?: string;
  email?: string;
  groups?: string[];
  authTime?: number | null;
}

/** The start of a flow; returns the state and the authorize URL. */
async function start(query = "go=1&breakGlass=1", ip = "203.0.113.9") {
  const res = await handleAdminLogin(
    new Request(`https://key.plrs.im/manage/login?${query}`, {
      headers: { "cf-connecting-ip": ip },
    }) as unknown as Request,
    env,
  );
  const location = new URL(res.headers.get("location")!);
  return { res, location, state: location.searchParams.get("state")! };
}

/** One break-glass run through the real login and callback. */
async function breakGlass(
  idp: Idp = {},
  opts: { now?: number; cookie?: (state: string) => Promise<string> } = {},
) {
  const now = opts.now ?? NOW;
  const { state } = await start();
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: idp.sub ?? "idp-bg",
      email: idp.email ?? "bg@example.com",
      emailVerified: true,
      name: "Break Glass",
      groups: idp.groups ?? [GROUP],
      ...(idp.authTime === null ? {} : { authTime: idp.authTime ?? now }),
    }),
  };
  const cookie = opts.cookie
    ? await opts.cookie(state)
    : await bindAdminFlow(env, state);
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: { cookie, "cf-connecting-ip": "203.0.113.9" },
    }) as unknown as Request,
    env,
    db,
    now,
    verifier,
  );
  const set = setCookies(res).find((c) => c.startsWith(ADMIN_COOKIE));
  const token = set ? set.split(";")[0]!.slice(ADMIN_COOKIE.length + 1) : null;
  const body = token
    ? (JSON.parse(
        Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>)
    : null;
  return { res, token, body, set };
}

/** A normal root sign-in (the usual operator), so a Superadmin with an address exists. */
async function normalRoot(n: number) {
  const { state } = await start(`go=1`, `198.51.100.${n}`);
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: `idp-root-${n}`,
      email: `root${n}@example.com`,
      emailVerified: true,
      name: `Root ${n}`,
      groups: [GROUP],
    }),
  };
  const res = await handleAdminCallback(
    new Request(`https://key.plrs.im/manage/callback?code=c&state=${state}`, {
      headers: {
        cookie: await bindAdminFlow(env, state),
        "cf-connecting-ip": `198.51.100.${n}`,
      },
    }) as unknown as Request,
    env,
    db,
    NOW - 100,
    verifier,
  );
  expect(res.status).toBe(302);
}

async function call(
  token: string,
  now: number,
  method = "GET",
  path = "/api/me",
  csrf = "",
  body?: unknown,
) {
  return handleAdmin(
    new Request(`https://key.plrs.im/manage${path}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) as unknown as Request,
    env,
    db,
    path,
    { now },
  );
}

const setCookies = (res: Response): string[] =>
  (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();

const count = async (table: string) =>
  (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
const audit = (action: string) =>
  db.all<{ actor_sub: string | null; summary: string }>(
    "SELECT actor_sub, summary FROM platform_audit WHERE action = ?",
    action,
  );
const noAccountRows = async () => ({
  accounts: await count("accounts"),
  links: await count("account_links"),
  sessions: await count("account_sessions"),
});

const HINT = "__Host-pkey_console_hint";
const ORIGIN = "https://key.plrs.im";

const card = (query: string, cookie = "") =>
  handleAdminLogin(
    new Request(`${ORIGIN}/manage/login${query}`, {
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        ...(cookie ? { cookie } : {}),
      },
    }) as unknown as Request,
    env,
  );

/** A normal sign-in through the callback; returns the callback response. */
async function signIn(email = "root1@example.com", groups = [GROUP]) {
  const { state } = await start(`go=1`, "198.51.100.1");
  const verifier: IdTokenVerifier = {
    verify: async () => ({
      sub: "idp-root-1",
      email,
      emailVerified: true,
      name: "Root One",
      groups,
    }),
  };
  return handleAdminCallback(
    new Request(`${ORIGIN}/manage/callback?code=c&state=${state}`, {
      headers: {
        cookie: await bindAdminFlow(env, state),
        "cf-connecting-ip": "198.51.100.1",
      },
    }) as unknown as Request,
    env,
    db,
    NOW,
    verifier,
  );
}

describe("the known-operator chip (D-S5)", () => {
  it("an account sign-in sets the hint cookie: host-bound, HttpOnly, Secure, Strict, 30 days", async () => {
    const res = await signIn();
    expect(res.status).toBe(302);
    const hint = setCookies(res).find((c) => c.startsWith(`${HINT}=`))!;
    expect(hint).toBe(
      `${HINT}=root1%40example.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 86400}`,
    );
    expect(hint).not.toMatch(/Domain=/i);
  });

  it("break-glass never sets the hint", async () => {
    const r = await breakGlass();
    expect(r.res.status).toBe(302);
    expect(setCookies(r.res).some((c) => c.includes(HINT))).toBe(false);
  });

  it.each([
    ["", "Sign in to the console"],
    ["?signedOut=1", "You’re signed out"],
    ["?ended=1", "Your session ended"],
  ])(
    "the %s card shows 'email · Change' and carries the hidden login_hint",
    async (q, h1) => {
      const html = await (await card(q, `${HINT}=root1%40example.com`)).text();
      expect(html).toContain(h1);
      expect(html).toContain(
        '<span class="chip-email">root1<wbr>@example<wbr>.com</span>',
      );
      expect(html).toContain('name="login_hint" value="root1@example.com"');
      expect(html).toContain("Change</a>");
      expect(html).not.toContain('type="email"');
    },
  );

  it("survives sign-out: the card after /logout still shows it (the hint is not a session)", async () => {
    const out = await card("?signedOut=1", `${HINT}=root1%40example.com`);
    expect(out.headers.get("set-cookie")).toBeNull();
    expect(await out.text()).toContain('class="chip-email"');
  });

  it("a step-up card does not use the chip", async () => {
    const html = await (
      await card("?stepUp=1", `${HINT}=root1%40example.com`)
    ).text();
    expect(html).not.toContain('class="chip-email"');
  });

  it("Change clears the cookie and shows the empty field, keeping the state and returnTo", async () => {
    const html0 = await (
      await card(
        "?signedOut=1&returnTo=/manage/%23/p/alpha",
        `${HINT}=a%40b.io`,
      )
    ).text();
    expect(html0).toContain(
      'href="/manage/login?change=1&amp;signedOut=1&amp;returnTo=%2Fmanage%2F%23%2Fp%2Falpha"',
    );
    const res = await card("?change=1&signedOut=1", `${HINT}=a%40b.io`);
    const clear = res.headers.get("set-cookie")!;
    expect(clear).toContain(`${HINT}=;`);
    expect(clear).toContain("Max-Age=0");
    const html = await res.text();
    expect(html).toContain("You’re signed out");
    expect(html).toContain('type="email"');
    expect(html).not.toContain('class="chip-email"');
  });

  it.each([
    "not-an-email",
    "a%20b%40c.io",
    "%E0%A4%A",
    `${"a".repeat(300)}%40x.io`,
    "a%40b%40c",
  ])("a tampered hint (%s) is rejected: no chip, nothing echoed", async (v) => {
    const html = await (await card("", `${HINT}=${v}`)).text();
    expect(html).not.toContain('class="chip-email"');
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('type="email"');
  });

  it("an address that is valid but hostile is escaped", async () => {
    const html = await (
      await card("", `${HINT}=${encodeURIComponent('a"onfocus="x@b.io')}`)
    ).text();
    // `loginHint` rejects whitespace and a second @, but a quote passes: it must be escaped.
    expect(html).not.toContain('"onfocus="x');
    expect(html).toContain("&quot;onfocus=&quot;x@b.io");
  });

  it("a script in the address passes the shape check but is escaped, never raw", async () => {
    const html = await (
      await card(
        "",
        `${HINT}=${encodeURIComponent("<script>alert(1)</script>@x.io")}`,
      )
    ).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;@x.io");
  });

  it("a duplicate hint cookie is refused (cookie-tossing)", async () => {
    const html = await (
      await card("", `${HINT}=a%40b.io; ${HINT}=c%40d.io`)
    ).text();
    expect(html).not.toContain('class="chip-email"');
  });

  it("the CSP is the same with and without the chip", async () => {
    const a = (await card("")).headers.get("content-security-policy");
    const b = (await card("", `${HINT}=a%40b.io`)).headers.get(
      "content-security-policy",
    );
    expect(b).toBe(a);
    expect(a).not.toContain("script-src");
  });

  it("the hint is advisory: it is offered to the IdP as login_hint and authorises nothing", async () => {
    const res = await handleAdmin(
      new Request(`${ORIGIN}/manage/api/me`, {
        headers: { cookie: `${HINT}=root1%40example.com` },
      }) as unknown as Request,
      env,
      db,
      "/api/me",
      { now: NOW },
    );
    expect(res.status).toBe(401);
  });
});

describe("the break-glass link and start card", () => {
  it("the sign-in card links 'Emergency sign-in' quietly under the card; step-up and the start card do not", async () => {
    const html = await (await card("?returnTo=/manage/")).text();
    expect(html).toContain(
      '<a href="/manage/login?breakGlass=1&amp;returnTo=%2Fmanage%2F">Emergency sign-in</a>',
    );
    expect(await (await card("?stepUp=1")).text()).not.toContain(
      "Emergency sign-in</a>",
    );
    expect(await (await card("?breakGlass=1")).text()).not.toContain(
      "Emergency sign-in</a>",
    );
  });

  it("the start card has the lede, posts breakGlass=1 and starts no flow on view", async () => {
    const res = await card("?breakGlass=1", `${HINT}=a%40b.io`);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Emergency sign-in</h1>");
    expect(html).toContain(
      "For when your account can’t sign in. Superadmins only.",
    );
    // The elevated fact sits in a callout with a glyph, and Back to sign in is in the links row.
    expect(html).toContain(
      '<p class="callout-title">Every use is recorded and every Superadmin is emailed.</p>',
    );
    expect(html).toMatch(
      /<nav class="ac-links" aria-label="Help and links">.*Back to sign in<\/a><\/nav>/,
    );
    expect(html).not.toContain('<p class="fine"><a');
    expect(html).toContain('name="breakGlass" value="1"');
    expect(html).not.toContain('class="chip-email"');
    expect(html).not.toContain('type="email"');
    expect(html).toContain("Back to sign in");
  });

  it("Continue on the start card POSTs into the break-glass flow", async () => {
    const res = await handleAdminLogin(
      new Request(`${ORIGIN}/manage/login`, {
        method: "POST",
        body: "breakGlass=1",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          "cf-connecting-ip": "203.0.113.41",
        },
      }) as unknown as Request,
      env,
    );
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("prompt")).toBe("login");
    expect(to.searchParams.get("max_age")).toBe("0");
  });
});

describe("N2: the break-glass cookie carries only the root group", () => {
  it("a 200-group IdP list leaves one group and a small cookie; root is still re-checked per request", async () => {
    const many = Array.from(
      { length: 200 },
      (_, i) => `team-${i}-xxxxxxxxxxxx`,
    );
    const r = await breakGlass({ groups: [...many, GROUP] });
    expect(r.body!.groups).toEqual([GROUP]);
    expect(r.token!.length).toBeLessThan(1024);
    const me = await call(r.token!, NOW + 1);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { breakGlass: boolean }).breakGlass).toBe(
      true,
    );
    // Remove the group from the env: root is gone on the next request.
    env.PLATFORM_ADMIN_GROUP = "someone-else";
    const after = await call(
      r.token!,
      NOW + 2,
      "GET",
      "/api/platform/overview",
    );
    expect(after.status).toBe(403);
  });
});

describe("N3: a break-glass session mints no durable credential", () => {
  const cases: [string, string, unknown][] = [
    ["admin API token", "/api/tokens", { label: "x", expiresInDays: 1 }],
    [
      "service (CI) token",
      "/api/products/alpha/ci-tokens",
      { scopes: ["release:publish"], expiresInDays: 1 },
    ],
    [
      "registry token (platform feeds)",
      "/api/platform/feeds/tokens",
      { label: "x" },
    ],
    [
      "registry token (product feeds)",
      "/api/products/alpha/distribution/feeds/tokens",
      { label: "x" },
    ],
  ];
  it.each(cases)(
    "%s: 403 forbidden, reason break_glass_session",
    async (_n, path, body) => {
      await seedProduct(db, "alpha");
      const r = await breakGlass();
      const res = await call(
        r.token!,
        NOW + 1,
        "POST",
        path,
        String(r.body!.csrf),
        body,
      );
      expect(res.status).toBe(403);
      const j = (await res.json()) as {
        error: { code: string; reason?: string };
      };
      expect(j.error.code).toBe("forbidden");
      expect(j.error.reason).toBe("break_glass_session");
      expect(await count("admin_api_tokens")).toBe(0);
    },
  );

  it("a trusted-publisher policy (a repository minting CI tokens later) is refused too", async () => {
    await seedProduct(db, "alpha");
    const r = await breakGlass();
    const res = await call(
      r.token!,
      NOW + 1,
      "PUT",
      "/api/products/alpha/ci-publisher",
      String(r.body!.csrf),
      { repository: "acme/app", workflows: ["release.yml"] },
    );
    expect(res.status).toBe(403);
    const j = (await res.json()) as {
      error: { code: string; reason?: string };
    };
    expect(j.error.reason).toBe("break_glass_session");
  });

  it("personal tokens have no console mint route: the account-tokens rows are list and revoke only", async () => {
    const r = await breakGlass();
    const res = await call(
      r.token!,
      NOW + 1,
      "POST",
      "/api/account-tokens",
      String(r.body!.csrf),
      {},
    );
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(201);
  });

  it("revocation stays allowed (it is not refused as break_glass_session)", async () => {
    const r = await breakGlass();
    const res = await call(
      r.token!,
      NOW + 1,
      "DELETE",
      "/api/tokens/nope",
      String(r.body!.csrf),
    );
    const j = JSON.stringify(await res.json());
    expect(j).not.toContain("break_glass_session");
  });

  it("an ordinary Superadmin session still mints", async () => {
    await signIn();
    // covered by the token suites; here: the guard is a no-op for a normal session
    expect(refuseBreakGlass({})).toBeNull();
    expect(refuseBreakGlass({ breakGlass: true })!.status).toBe(403);
  });
});

describe("the chip, large text and the card's details (UX review)", () => {
  it("the chip wraps, breaks the address at @ and . and has no input look", async () => {
    const res = await card(
      "",
      `${HINT}=vlad.zaharia%40polaris-engineering.dev`,
    );
    const html = await res.text();
    expect(html).toContain(
      "vlad<wbr>.zaharia<wbr>@polaris-engineering<wbr>.dev",
    );
    expect(html).toMatch(/\.chip\{display:flex;flex-wrap:wrap/);
    expect(html).toContain(".chip-email{flex:1 1 12rem");
    expect(html).toContain(".chip-change:focus-visible{outline-offset:-2px}");
    // The house initials: the first two words of the local part, by code point.
    expect(html).toContain(
      '<span class="ac-mono" aria-hidden="true">VZ</span>',
    );
    const emoji = await (
      await card("", `${HINT}=${encodeURIComponent("😀x@b.io")}`)
    ).text();
    expect(emoji).toContain('aria-hidden="true">😀</span>');
  });

  it("the links landmark covers every link, with no separator dots; the lockup is 4 rem from 30 rem", async () => {
    const html = await (await card("")).text();
    expect(html).toContain('aria-label="Help and links"');
    expect(html).toContain(
      "[data-brand=console] .ac-links a+a::before{content:none}",
    );
    expect(html).toContain(
      "[data-brand=console] .ac-brand svg{width:13.875rem;height:4rem}",
    );
    expect(html).toContain("width:11.275rem;height:3.25rem");
    expect(html).toContain(
      "font-size:1.25rem;line-height:1.75rem;font-weight:500",
    );
  });

  it("Change puts focus on the empty field and not on the heading; the other cards keep the heading", async () => {
    const change = await (await card("?change=1", `${HINT}=a%40b.io`)).text();
    expect(change).toMatch(
      /<input id="email" type="email" name="login_hint" autofocus/,
    );
    expect(change).toContain("<h1>Sign in to the console</h1>");
    const plain = await (await card("")).text();
    expect(plain).not.toMatch(/<input id="email"[^>]* autofocus/);
    expect(plain).toContain('<h1 tabindex="-1" autofocus>');
  });

  it("the refusal and the mint refusal say 'emergency sign-in', one name for one thing", async () => {
    const r = await breakGlass({ groups: ["other"] });
    const html = await r.res.text();
    expect(html).toContain("Emergency sign-in is for Superadmins only.");
    expect(html).not.toMatch(/break-glass/i);
  });
});
