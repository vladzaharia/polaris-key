/**
 * ST-30c.6 (D-S2, SIGN-IN.md §3.13): the console card's passkey button and its one inline script,
 * pinned by hash. The block, the script and `script-src` appear together or not at all: only where
 * a ceremony can run (the console RP resolves for the request) and, on a step-up, only when the
 * signed-in account holds a console passkey.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW } from "../../seed.js";
import { SoftAuthenticator } from "../../softAuthenticator.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import { handleAdminLogin } from "../../../src/console/auth.js";
import { resetConsoleSessionCache } from "../../../src/console/consoleSession.js";
import {
  SIGNIN_SCRIPT,
  SIGNIN_SCRIPT_HASH,
} from "../../../src/console/signinScript.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSessionV2,
} from "../../../src/core/console/session.js";
import { consoleSignIn } from "../../../src/services/identity/public.js";

const GROUP = "platform-admins";
const ORIGIN = "https://key.plrs.im";

type Db = ReturnType<typeof makeTestDb>;
let env: Env;
let db: Db;

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  // The card reads the session at the wall clock; the fixtures are minted at NOW.
  vi.useFakeTimers({ toFake: ["Date"], now: (NOW + 5) * 1000 });
  resetConsoleSessionCache();
  env = makeEnv(new KvMock(), ["alpha"]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = GROUP;
  env.PLATFORM_OIDC_ISSUER = "https://id.example";
  env.PLATFORM_OIDC_CLIENT_ID = "console";
  env.KEY_HASH_PEPPER = "test-pepper";
  env.CONSOLE_ORIGIN = ORIGIN;
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  env.EMAIL = { send: async () => undefined } as unknown as Env["EMAIL"];
  db = makeTestDb();
});

const card = (query: string, cookie = "", e: Env = env, origin = ORIGIN) =>
  handleAdminLogin(
    new Request(`${origin}/manage/login${query}`, {
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        ...(cookie ? { cookie } : {}),
      },
    }) as unknown as Request,
    e,
    db,
  );

/** An operator signed in through the console IdP; `passkey` enrols a console passkey. */
async function member(n: number, passkey: boolean): Promise<string> {
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
      authTime: NOW,
      stepUp: true,
    },
    NOW,
  );
  if (passkey) {
    const headers = {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: claims.csrf,
    };
    const call = (path: string, body: unknown) =>
      handleAdmin(
        new Request(`${ORIGIN}/manage${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }) as unknown as Request,
        env,
        db,
        path,
        { now: NOW + 1 },
      );
    const auth = await SoftAuthenticator.create();
    const start = await call("/api/me/passkeys/options", {});
    const { options } = (await start.json()) as {
      options: Parameters<SoftAuthenticator["register"]>[0];
    };
    const added = await call("/api/me/passkeys", {
      response: await auth.register(options),
    });
    expect(added.status).toBe(201);
  }
  return `${ADMIN_COOKIE}=${token}`;
}

const sha = (t: string) =>
  `'sha256-${createHash("sha256").update(t, "utf8").digest("base64")}'`;
const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));
const scripts = (html: string) => [
  ...html.matchAll(/<script(?<attrs>[^>]*)>(?<body>[\s\S]*?)<\/script>/g),
];

describe("the hash pin", () => {
  it("the pinned constant is the SHA-256 of the script source", () => {
    expect(SIGNIN_SCRIPT_HASH).toBe(sha(SIGNIN_SCRIPT));
  });

  it.each(["", "?signedOut=1", "?ended=1", "?change=1"])(
    "the card %j serves exactly that script, and the CSP allows exactly its hash",
    async (query) => {
      const res = await card(query);
      const csp = res.headers.get("content-security-policy")!;
      const html = await res.text();
      const found = scripts(html);
      expect(found).toHaveLength(1);
      expect(found[0]!.groups!.attrs).toBe("");
      expect(found[0]!.groups!.body).toBe(SIGNIN_SCRIPT);
      expect(directive(csp, "script-src")).toBe(
        `script-src ${sha(found[0]!.groups!.body!)}`,
      );
      expect(directive(csp, "script-src")).toBe(
        `script-src ${SIGNIN_SCRIPT_HASH}`,
      );
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
      expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
      expect(directive(csp, "default-src")).toBe("default-src 'none'");
      expect(html).not.toMatch(/\son\w+=|\sstyle=|<script[^>]*\ssrc=/i);
    },
  );
});

describe("where the passkey block appears", () => {
  const none = async (res: Response) => {
    const csp = res.headers.get("content-security-policy")!;
    const html = await res.text();
    expect(scripts(html)).toHaveLength(0);
    expect(html).not.toContain('id="pk"');
    expect(html).not.toContain("webauthn");
    expect(csp).not.toMatch(/script-src|connect-src/);
  };

  it("the emergency card has no block, no script and no script-src", async () => {
    await none(await card("?breakGlass=1"));
  });

  it("without CONSOLE_ORIGIN no ceremony can run: no block, no script, no script-src", async () => {
    const e = { ...env, CONSOLE_ORIGIN: undefined } as Env;
    await none(await card("", "", e));
  });

  it("on another host than the console origin: none either", async () => {
    await none(await card("", "", env, "https://other.example"));
  });

  it("a step-up with no live session offers no passkey", async () => {
    await none(await card("?stepUp=1"));
  });

  it("a step-up whose account holds no passkey offers none", async () => {
    const cookie = await member(1, false);
    await none(await card("?stepUp=1", cookie));
  });

  it("a step-up whose account holds a console passkey leads with it, before Sign in again", async () => {
    const cookie = await member(2, true);
    const res = await card(
      `?stepUp=1&returnTo=${encodeURIComponent("/manage/#/p/alpha")}`,
      cookie,
    );
    const csp = res.headers.get("content-security-policy")!;
    const html = await res.text();
    expect(directive(csp, "script-src")).toBe(
      `script-src ${SIGNIN_SCRIPT_HASH}`,
    );
    expect(html).toContain('data-step-up="1"');
    expect(html).toContain('data-return-to="/manage/#/p/alpha"');
    expect(html).toContain(">Use your passkey</span>");
    expect(html).toContain('<button class="button" type="button" id="pk-go"');
    expect(html).toContain(">or</div>");
    // "Signing in as" names the account once, above both ways in.
    expect(html.indexOf("Signing in as")).toBeLessThan(
      html.indexOf('id="pk-go"'),
    );
    expect(html.match(/Signing in as/g)).toHaveLength(1);
    expect(html.indexOf('id="pk-go"')).toBeLessThan(
      html.indexOf(">Sign in again<"),
    );
    // Without script the block is hidden and Sign in again is the plain primary.
    expect(html).toContain('<div class="pk" id="pk" hidden');
  });
});

describe("the sign-in markup", () => {
  it("the block is hidden, ties its message to the button, and the field offers webauthn", async () => {
    const html = await (await card("")).text();
    expect(html).toContain('<div class="pk" id="pk" hidden>');
    expect(html).toContain(">or</div>");
    expect(html).toContain(">Sign in with a passkey</span>");
    expect(html).toContain('aria-describedby="pk-err"');
    expect(html).toContain('<div class="pk-err" id="pk-err" role="alert">');
    expect(html).toContain('autocomplete="username webauthn"');
    expect(html).toContain(">Continue");
    expect(html).toContain('class="field-err" id="pk-msg" hidden');
  });
});

describe("the script's copy", () => {
  it("names the refusals in house words, without a vendor or the break-glass name", () => {
    expect(SIGNIN_SCRIPT).toContain(
      "Your access needs a recent company sign-in.",
    );
    expect(SIGNIN_SCRIPT).toContain(
      'This passkey doesn’t open the console yet. Use "+via+", then choose Use for the console in Account → Sign-in methods.',
    );
    expect(SIGNIN_SCRIPT).toContain(
      "Can’t reach Polaris Key. Check your connection, then try again.",
    );
    expect(SIGNIN_SCRIPT).toContain(
      "Too many sign-in attempts. Wait a minute, then try again.",
    );
    expect(SIGNIN_SCRIPT).not.toMatch(/pocket|break.?glass/i);
  });
});
