import { mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright";
import { handleAdmin } from "../../worker/src/console/index.js";
import { secureResponse } from "../../worker/src/core/securityHeaders.js";
import { resetConsoleSessionCache } from "../../worker/src/console/consoleSession.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSessionV2,
} from "../../worker/src/core/console/session.js";
import { consoleSignIn } from "../../worker/src/services/identity/public.js";
import {
  newBindingId,
  stmtInsertBinding,
} from "../../worker/src/core/rbac/bindings.js";
import { makeEnv } from "../../worker/test/seed.js";
import { makeTestDb } from "../../worker/test/helpers.js";
import { KvMock } from "../../worker/test/kvMock.js";
import { SoftAuthenticator } from "../../worker/test/softAuthenticator.js";
import { closeContext } from "./teardown.js";

/**
 * ST-30c.6: the console card's passkey button in real Chromium under the Worker's exact CSP, with
 * a CDP virtual authenticator holding a real enrolled console passkey. WebAuthn refuses an IP as
 * the RP id, so the page is reached as `localhost` (the server listens on loopback). Covers
 * passkey sign-in, passkey step-up, each refusal shown in place, zero CSP violations, the no-JS
 * card, keyboard focus and the announced error.
 */
const GROUP = "platform-admins";
const ISSUER = "https://id.example";
const now = () => Math.floor(Date.now() / 1000);

let browser: Browser;
let server: http.Server;
let origin = "";
let env: ReturnType<typeof makeEnv>;
let db: ReturnType<typeof makeTestDb>;
const realFetch = globalThis.fetch;

interface Member {
  accountId: string;
  auth: SoftAuthenticator;
  /** The console session cookie value of the IdP sign-in that enrolled the passkey. */
  token: string;
  email: string;
  uses: number;
}

let nextIp = 1;
const b64 = (u: Uint8Array | Buffer) => Buffer.from(u).toString("base64");

async function member(
  n: number,
  binding: boolean,
  enrol = true,
): Promise<Member> {
  const t = now();
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
    t,
  );
  if (r.status !== "ok") throw new Error("fixture");
  const { token, claims } = await issueSessionV2(
    env,
    {
      aid: r.accountId,
      sid: r.sid,
      name: r.name,
      email: r.email,
      authTime: t,
      stepUp: true,
    },
    t,
  );
  const auth = await SoftAuthenticator.create({ synced: true });
  const call = (path: string, body: unknown) =>
    handleAdmin(
      new Request(`${origin}/manage${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: claims.csrf,
        },
        body: JSON.stringify(body),
      }) as unknown as Request,
      env,
      db,
      path,
      { now: now() },
    );
  if (enrol) {
    const start = await call("/api/me/passkeys/options", {});
    const { options } = (await start.json()) as {
      options: Parameters<SoftAuthenticator["register"]>[0];
    };
    const added = await call("/api/me/passkeys", {
      response: await auth.register(options, { origin }),
    });
    if (added.status !== 201) throw new Error(`enrol ${added.status}`);
  }
  if (binding) {
    const s = stmtInsertBinding({
      id: newBindingId(),
      accountId: r.accountId,
      emailNorm: null,
      role: "console_access",
      scope: "platform",
      areas: null,
      source: "grant",
      grantedBy: null,
      grantedAt: t - 10,
    });
    await db.run(s.sql, ...s.params);
  }
  return { accountId: r.accountId, auth, token, email: r.email, uses: 0 };
}

let ada: Member;
let bob: Member;
let nogrant: Member;
let nopass: Member;

beforeAll(async () => {
  resetConsoleSessionCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === `${ISSUER}/.well-known/openid-configuration`)
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          response_types_supported: ["code"],
        }),
        { headers: { "content-type": "application/json" } },
      );
    return realFetch(input, init);
  }) as typeof fetch;
  env = makeEnv(new KvMock(), []);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  env.KEY_HASH_PEPPER = "test-pepper";
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  env.EMAIL = { send: async () => undefined } as unknown as typeof env.EMAIL;
  db = makeTestDb();
  server = http.createServer(async (q, r) => {
    const url = new URL(q.url!, origin);
    const chunks: Buffer[] = [];
    for await (const c of q) chunks.push(c as Buffer);
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.50" });
    for (const [k, v] of Object.entries(q.headers))
      if (typeof v === "string") headers.set(k, v);
    const req = new Request(url, {
      method: q.method,
      headers,
      ...(q.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
    });
    const path = url.pathname.replace(/^\/manage/, "") || "/";
    // The SPA is not under test: a signed-in navigation lands on a stub.
    const res =
      path === "/"
        ? new Response(
            "<!doctype html><title>Console</title><h1>Console</h1>",
            {
              headers: { "content-type": "text/html" },
            },
          )
        : await handleAdmin(req, env, db, path, { now: now() });
    const served = secureResponse(res);
    const out: Record<string, string | string[]> = {};
    served.headers.forEach((v, k) => {
      if (k !== "set-cookie") out[k] = v;
    });
    const cookies = (
      served.headers as Headers & { getSetCookie(): string[] }
    ).getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    r.writeHead(served.status, out);
    r.end(Buffer.from(await served.arrayBuffer()));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  env.CONSOLE_ORIGIN = origin;
  ada = await member(1, true);
  bob = await member(2, true);
  nogrant = await member(3, false);
  nopass = await member(4, true, false);
  // No grant and no console-IdP link: the passkey is the only thing it has.
  await db.run(
    "DELETE FROM account_links WHERE account_id = ? AND kind = 'oidc'",
    nogrant.accountId,
  );
  browser = await chromium.launch();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await browser?.close();
  await new Promise((ok) => server?.close(ok));
});

/** A context + page whose virtual authenticator holds `m`'s enrolled passkey. */
async function open(
  m: Member | null,
  opts: Parameters<Browser["newContext"]>[0] = {},
  /** Chromium's virtual authenticator answers conditional UI at once; off, only the button signs in. */
  conditional = false,
): Promise<{
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  violations: string[];
}> {
  const context = await browser.newContext(opts);
  // Each browser is its own network, so the per-network passkey budget never couples two cases.
  await context.setExtraHTTPHeaders({
    "cf-connecting-ip": `203.0.113.${(nextIp = (nextIp % 250) + 1)}`,
  });
  if (!conditional)
    await context.addInitScript(() => {
      PublicKeyCredential.isConditionalMediationAvailable = async () => false;
    });
  const page = await context.newPage();
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy|violates/i.test(msg.text()))
      violations.push(msg.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  if (m)
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: {
        credentialId: b64(m.auth.credentialId),
        isResidentCredential: true,
        rpId: "localhost",
        privateKey: b64(await m.auth.pkcs8()),
        userHandle: b64(Buffer.from(m.auth.userHandle!, "base64url")),
        // The Worker refuses a counter that does not advance, so each browser starts higher.
        signCount: (m.uses += 10),
      },
    });
  return { context, page, cdp, violations };
}

const signedIn = async (context: BrowserContext, m: Member) =>
  context.addCookies([
    {
      name: ADMIN_COOKIE,
      value: m.token,
      domain: "localhost",
      path: "/",
      secure: true,
    },
  ]);

const shot = async (page: Page, name: string, tag: string, full = false) => {
  if (!process.env.PK_SHOTS_DIR) return;
  mkdirSync(process.env.PK_SHOTS_DIR, { recursive: true });
  await page.screenshot({
    path: `${process.env.PK_SHOTS_DIR}/${name}-${tag}.png`,
    fullPage: full,
  });
};

describe("the passkey button (ST-30c.6)", () => {
  it("is revealed by the script, and a passkey signs in to the console with zero CSP violations", async () => {
    const { context, page, violations } = await open(ada);
    await page.goto(
      `${origin}/manage/login?returnTo=${encodeURIComponent("/manage/")}`,
    );
    const button = page.getByRole("button", { name: "Sign in with a passkey" });
    await button.waitFor();
    expect(await button.isVisible()).toBe(true);
    const sent = page.waitForResponse((r) =>
      r.url().endsWith("/login/passkey/verify"),
    );
    await button.click();
    const verify = await sent;
    expect(verify.status()).toBe(200);
    await page.waitForURL(`${origin}/manage/`);
    await page.getByRole("heading", { name: "Console" }).waitFor();
    const cookies = (await context.cookies(origin)).map((c) => c.name);
    expect(cookies).toContain(ADMIN_COOKIE);
    expect(violations).toEqual([]);
    await closeContext(context);
  });

  it("conditional UI: the email field offers the passkey (autocomplete=username webauthn) and signs in", async () => {
    const { context, page, violations } = await open(ada, {}, true);
    const html = await (
      await page.request.get(`${origin}/manage/login`)
    ).text();
    expect(html).toContain('autocomplete="username webauthn"');
    const verify = page.waitForResponse((r) =>
      r.url().endsWith("/login/passkey/verify"),
    );
    await page.goto(`${origin}/manage/login`);
    expect((await verify).status()).toBe(200);
    await page.waitForURL(`${origin}/manage/`);
    expect(violations).toEqual([]);
    await closeContext(context);
  });

  it("a step-up offers Use your passkey beside Sign in again, and the same account's passkey confirms it", async () => {
    const { context, page, violations } = await open(ada);
    await signedIn(context, ada);
    await page.goto(`${origin}/manage/login?stepUp=1`);
    await page.getByRole("button", { name: "Sign in again" }).waitFor();
    const use = page.getByRole("button", { name: "Use your passkey" });
    await use.waitFor();
    expect(await page.getByText("Sign in with a passkey").count()).toBe(0);
    await use.click();
    await page.waitForURL(`${origin}/manage/`);
    expect(violations).toEqual([]);
    await closeContext(context);
  });

  it("a step-up answered by another account's passkey is refused in place", async () => {
    const { context, page } = await open(bob);
    await signedIn(context, ada);
    await page.goto(`${origin}/manage/login?stepUp=1`);
    await page.getByRole("button", { name: "Use your passkey" }).click();
    const alert = page.getByRole("alert");
    await alert
      .getByText("Use a passkey of the account you’re signed in with.")
      .waitFor();
    expect(new URL(page.url()).pathname).toBe("/manage/login");
    await closeContext(context);
  });

  it("a passkey with no console grant says what to do, in place", async () => {
    const { context, page } = await open(nogrant);
    await page.goto(`${origin}/manage/login`);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page
      .getByRole("alert")
      .getByText("Ask a Superadmin to add you.")
      .waitFor();
    expect(new URL(page.url()).pathname).toBe("/manage/login");
    await closeContext(context);
  });

  const REASONS: [string, number, string][] = [
    [
      "method",
      403,
      "This passkey doesn’t open the console yet. Use Continue, then choose Use for the console in Account → Sign-in methods.",
    ],
    [
      "idp_first",
      403,
      "Your access needs a recent company sign-in. Use Continue this time.",
    ],
    [
      "account",
      403,
      "This account can’t sign in here. Ask a Superadmin for help.",
    ],
    [
      "step_up_account",
      403,
      "Use a passkey of the account you’re signed in with.",
    ],
    ["invalid", 401, "That passkey didn’t work. Try again, or use Continue."],
    ["expired", 400, "This passkey request expired. Try again."],
    ["rate", 429, "Too many sign-in attempts. Wait a minute, then try again."],
  ];

  it("a network failure says it can't reach Polaris Key", async () => {
    const { context, page } = await open(ada);
    await page.goto(`${origin}/manage/login`);
    await context.route("**/login/passkey/options", (route) => route.abort());
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page
      .getByRole("alert")
      .getByText(
        "Can’t reach Polaris Key. Check your connection, then try again.",
      )
      .waitFor();
    await closeContext(context);
  });

  it("the message carries a glyph and the button points at it", async () => {
    const { context, page } = await open(nogrant);
    await page.goto(`${origin}/manage/login`);
    const button = page.getByRole("button", { name: "Sign in with a passkey" });
    expect(await button.getAttribute("aria-describedby")).toBe("pk-err");
    await button.click();
    await page.locator("#pk-msg").waitFor();
    expect(await page.locator("#pk-msg svg").count()).toBe(1);
    expect(await page.locator("#pk-msg").isVisible()).toBe(true);
    await closeContext(context);
  });

  it("after the sheet closes the button reads Signing in… and stays busy through the navigation", async () => {
    const { context, page } = await open(ada);
    await context.route("**/login/passkey/verify", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.goto(`${origin}/manage/login`);
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await page.getByRole("button", { name: "Signing in…" }).waitFor();
    expect(await page.locator("#pk-go").getAttribute("aria-busy")).toBe("true");
    await page.waitForURL(`${origin}/manage/`);
    await closeContext(context);
  });

  it("a step-up for an account with no passkey offers none, and no script", async () => {
    const { context, page } = await open(null);
    await signedIn(context, nopass);
    const res = await page.goto(`${origin}/manage/login?stepUp=1`);
    await page.getByRole("button", { name: "Sign in again" }).waitFor();
    expect(await page.locator("#pk").count()).toBe(0);
    expect(res!.headers()["content-security-policy"]).not.toContain(
      "script-src",
    );
    await closeContext(context);
  });

  it("a step-up with a passkey leads with it: the primary, then or, then the ghost Sign in again", async () => {
    const { context, page } = await open(ada);
    await signedIn(context, ada);
    await page.goto(`${origin}/manage/login?stepUp=1`);
    const use = page.getByRole("button", { name: "Use your passkey" });
    await use.waitFor();
    const again = page.getByRole("button", { name: "Sign in again" });
    const [u, a] = await Promise.all([use.boundingBox(), again.boundingBox()]);
    expect(u!.y).toBeLessThan(a!.y);
    const fill = (l: typeof use) =>
      l.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await fill(again)).toBe("rgba(0, 0, 0, 0)");
    expect(await fill(use)).not.toBe("rgba(0, 0, 0, 0)");
    await closeContext(context);
  });

  it("conditional UI: one refused pick keeps its message and does not loop", async () => {
    const context = await browser.newContext();
    await context.setExtraHTTPHeaders({ "cf-connecting-ip": "203.0.113.200" });
    // One pick from the field, answered by the real virtual authenticator; later conditional
    // requests wait, as a field nobody touched does.
    await context.addInitScript(() => {
      const get = navigator.credentials.get.bind(navigator.credentials);
      let picks = 0;
      (window as unknown as { __gets: number }).__gets = 0;
      navigator.credentials.get = (o?: CredentialRequestOptions) => {
        (window as unknown as { __gets: number }).__gets++;
        if (o?.mediation === "conditional") {
          if (picks++ === 0) {
            const { mediation: _m, ...rest } = o;
            return get(rest);
          }
          return new Promise((_ok, no) =>
            o.signal?.addEventListener("abort", () =>
              no(new DOMException("aborted", "AbortError")),
            ),
          );
        }
        return get(o);
      };
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    );
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: {
        credentialId: b64(nogrant.auth.credentialId),
        isResidentCredential: true,
        rpId: "localhost",
        privateKey: b64(await nogrant.auth.pkcs8()),
        userHandle: b64(Buffer.from(nogrant.auth.userHandle!, "base64url")),
        signCount: (nogrant.uses += 10),
      },
    });
    let optionsCalls = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/login/passkey/options")) optionsCalls++;
    });
    await page.goto(`${origin}/manage/login`);
    const alert = page.getByRole("alert");
    await alert.getByText("Ask a Superadmin to add you.").waitFor();
    await page.waitForTimeout(1500);
    expect(
      await alert.getByText("Ask a Superadmin to add you.").isVisible(),
    ).toBe(true);
    expect(optionsCalls).toBeLessThanOrEqual(2);
    expect(
      await page.evaluate(
        () => (window as unknown as { __gets: number }).__gets,
      ),
    ).toBeLessThanOrEqual(2);
    await closeContext(context);
  });

  it.each(REASONS)(
    "the refusal %s is shown in place and announced",
    async (reason, status, text) => {
      const { context, page, violations } = await open(ada);
      await context.route("**/login/passkey/verify", (route) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(
            reason === "invalid"
              ? { error: "unauthorized" }
              : reason === "expired"
                ? { error: "signin_expired" }
                : reason === "rate"
                  ? { error: "rate_limited" }
                  : { error: "forbidden", reason },
          ),
        }),
      );
      await page.goto(`${origin}/manage/login`);
      await page
        .getByRole("button", { name: "Sign in with a passkey" })
        .click();
      const alert = page.getByRole("alert");
      await alert.getByText(text, { exact: false }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/manage/login");
      expect(violations).toEqual([]);
      // The button is usable again, and still the focus target.
      expect(
        await page
          .getByRole("button", { name: "Sign in with a passkey" })
          .getAttribute("aria-disabled"),
      ).toBeNull();
      await closeContext(context);
    },
  );
});

describe("the card without script, and keyboard (ST-30c.6)", () => {
  it("with JS off the card has no passkey button and Continue still starts the sign-in", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const idp = page.waitForRequest(`${ISSUER}/authorize**`, {
      timeout: 15_000,
    });
    await context.route(`${ISSUER}/**`, (route) => route.abort());
    await page.goto(`${origin}/manage/login`);
    expect(await page.getByText("Sign in with a passkey").isVisible()).toBe(
      false,
    );
    expect(await page.locator("#pk").isVisible()).toBe(false);
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
    expect(new URL((await idp).url()).searchParams.get("login_hint")).toBe(
      "ada@example.com",
    );
    await closeContext(context);
  });

  it("without WebAuthn the script leaves the block hidden", async () => {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).PublicKeyCredential;
    });
    const page = await context.newPage();
    await page.goto(`${origin}/manage/login`);
    await page.getByRole("button", { name: "Continue" }).waitFor();
    expect(await page.locator("#pk").isVisible()).toBe(false);
    await closeContext(context);
  });

  it("the passkey button is next in the tab order, with a visible focus ring, and no motion", async () => {
    const { context, page } = await open(null, { reducedMotion: "reduce" });
    await page.goto(`${origin}/manage/login`);
    await page
      .getByRole("button", { name: "Sign in with a passkey" })
      .waitFor();
    await page.locator("#email").focus();
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => document.activeElement?.textContent),
    ).toContain("Continue");
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return {
        text: el.textContent,
        style: s.outlineStyle,
        width: parseFloat(s.outlineWidth),
        transition: s.transitionDuration,
        animation: s.animationName,
      };
    });
    expect(ring.text).toBe("Sign in with a passkey");
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);
    expect(ring.transition).toBe("0s");
    expect(ring.animation).toBe("none");
    // Enter activates it from the keyboard: the ceremony starts (options requested).
    const options = page.waitForResponse((r) =>
      r.url().endsWith("/login/passkey/options"),
    );
    await page.keyboard.press("Enter");
    expect((await options).status()).toBe(200);
    await closeContext(context);
  });
});

describe("shots for the built UX review (PK_SHOTS_DIR)", () => {
  it.each([
    ["dark", 1440, 900, 100],
    ["light", 390, 844, 100],
    ["light", 390, 844, 200],
  ] as const)(
    "every passkey state, %s at %i px, %i %% text",
    async (scheme, width, height, pct) => {
      if (!process.env.PK_SHOTS_DIR) return;
      const tag = `${width}-${scheme}${pct === 100 ? "" : `-text${pct}`}`;
      const { context, page } = await open(ada, {
        colorScheme: scheme,
        viewport: { width, height },
      });
      const fit = async () => {
        if (pct !== 100)
          await page.evaluate(
            (p) =>
              document.documentElement.style.setProperty("font-size", `${p}%`),
            pct,
          );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      };
      for (const [name, query] of [
        ["signin-passkey", ""],
        ["signedout-passkey", "?signedOut=1"],
        ["ended-passkey", "?ended=1"],
      ] as const) {
        await page.goto(`${origin}/manage/login${query}`);
        await page
          .getByRole("button", { name: "Sign in with a passkey" })
          .waitFor();
        await fit();
        await shot(page, name, tag);
      }
      await page.goto(`${origin}/manage/login`);
      await page.locator("#email").focus();
      await fit();
      await shot(page, "conditional-email-focus", tag);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await shot(page, "keyboard-focus-passkey", tag);
      await signedIn(context, ada);
      await page.goto(`${origin}/manage/login?stepUp=1`);
      await page.getByRole("button", { name: "Use your passkey" }).waitFor();
      await fit();
      await shot(page, "stepup", tag);
      await page.route("**/login/passkey/verify", (route) =>
        route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: "forbidden",
            reason: "step_up_account",
          }),
        }),
      );
      await page.getByRole("button", { name: "Use your passkey" }).click();
      await page.getByRole("alert").getByText(/\S/).waitFor();
      await fit();
      await shot(page, "stepup-error-step_up_account", tag, true);
      for (const [reason, status] of [
        ["method", 403],
        ["idp_first", 403],
        ["no_grant", 403],
        ["account", 403],
        ["step_up_account", 403],
        ["invalid", 401],
      ] as const) {
        await page.unroute("**/login/passkey/verify").catch(() => {});
        await page.route("**/login/passkey/verify", (route) =>
          route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify(
              reason === "invalid"
                ? { error: "unauthorized" }
                : { error: "forbidden", reason },
            ),
          }),
        );
        await context.clearCookies({ name: ADMIN_COOKIE });
        await page.goto(`${origin}/manage/login`);
        await page
          .getByRole("button", { name: "Sign in with a passkey" })
          .click();
        await page.getByRole("alert").getByText(/\S/).waitFor();
        await fit();
        await shot(page, `error-${reason}`, tag, true);
      }
      await closeContext(context);
      const plain = await browser.newContext({
        colorScheme: scheme,
        viewport: { width, height },
        javaScriptEnabled: false,
      });
      const p = await plain.newPage();
      await p.goto(`${origin}/manage/login`);
      await p.getByRole("button", { name: "Continue" }).waitFor();
      await shot(p, "nojs", tag);
      await closeContext(plain);
    },
  );
});
