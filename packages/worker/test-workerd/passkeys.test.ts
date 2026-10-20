/// <reference types="@cloudflare/workers-types" />
// I-16: passkeys under workerd. `@simplewebauthn/server` and its ASN.1 and CBOR dependencies must
// load in the runtime that ships (module-scope work only, no code generation), verify ES256 and
// Ed25519 assertions with workerd's WebCrypto, and the challenge must be single use on the REAL
// single-use Durable Object and D1: a replayed answer and a racing duplicate both fail.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Db } from "../src/db/d1.js";
import type { Env as WorkerEnv } from "../src/platform/env.js";
import { handlePortal } from "../src/services/identity/portal/index.js";
import { startAccountSession } from "../src/services/identity/portal/accountSessions.js";
import { recordErasure } from "../src/services/identity/accounts/erasureLedger.js";
import { PORTAL_CSRF_HEADER } from "../src/services/identity/portal/session.js";
import {
  ACCOUNT_SESSION_COOKIE,
  PASSKEY_FLOW_COOKIE,
} from "../src/core/accounts/accountCookies.js";
import { SoftAuthenticator } from "../test/softAuthenticator.js";
import { NOW, seedProduct } from "./seed.js";

const workerEnv = {
  ...(env as unknown as WorkerEnv),
  PORTAL_SESSION_SECRET: "workerd-passkey-session-secret",
  KEY_HASH_PEPPER: "workerd-passkey-pepper",
} as WorkerEnv;
/** The customer host on (LK-05): ceremonies there use the console host's RP id. */
const lockerEnv = {
  ...workerEnv,
  CONSOLE_ORIGIN: "https://key.plrs.im",
  CUSTOMER_ORIGIN: "https://polaris.locker",
} as WorkerEnv;
const db = new D1Db(env.DB);

/** A browser: a cookie jar and the CSRF token. */
class Browser {
  jar = new Map<string, string>();
  csrf: string | null = null;

  constructor(
    readonly origin = "https://key.plrs.im",
    readonly workerEnv_: WorkerEnv = workerEnv,
  ) {}

  async send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "cf-connecting-ip": "203.0.113.70",
      "content-type": "application/json",
    };
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.cookie = cookie;
    if (this.csrf && method !== "GET") headers[PORTAL_CSRF_HEADER] = this.csrf;
    const req = new Request(`${this.origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handlePortal(
      req,
      this.workerEnv_,
      db,
      new URL(req.url).pathname,
      {
        now: NOW,
      },
    );
    const setCookies =
      (
        res.headers as Headers & { getSetCookie?: () => string[] }
      ).getSetCookie?.() ?? [];
    for (const c of setCookies) {
      const [pair, ...attrs] = c.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1);
      if (value === "" || attrs.some((a: string) => a.trim() === "Max-Age=0"))
        this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
}

let seeded = false;
async function world(
  email: string,
): Promise<{ browser: Browser; accountId: string }> {
  if (!seeded) {
    await seedProduct(workerEnv, db, "pkdemo", { version: 1, keys: [] });
    seeded = true;
  }
  const accountId = `acct_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.run(
    `INSERT INTO accounts (id, status, primary_email, primary_email_verified_at, display_name,
                           created_at, modified_at, last_sign_in_at)
     VALUES (?, 'active', ?, ?, 'Ada', ?, ?, ?)`,
    accountId,
    email,
    NOW,
    NOW,
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email,
                                email_verified, created_at, last_used_at)
     VALUES (?, ?, 'email', '', ?, 'email', ?, 1, ?, ?)`,
    `lnk_${accountId}`,
    accountId,
    email,
    email,
    NOW,
    NOW,
  );
  const { cookie, session } = await startAccountSession(
    workerEnv,
    db,
    {
      account: { id: accountId, display_name: "Ada", primary_email: email },
      amr: ["email"],
    },
    NOW,
  );
  const browser = new Browser();
  browser.jar.set(
    ACCOUNT_SESSION_COOKIE,
    cookie.split(";")[0]!.slice(ACCOUNT_SESSION_COOKIE.length + 1),
  );
  browser.csrf = session.csrf;
  return { browser, accountId };
}

async function enrol(
  browser: Browser,
  auth: SoftAuthenticator,
): Promise<Response> {
  const start = await browser.send("POST", "/api/me/passkeys/options", {});
  expect(start.status).toBe(200);
  const { options } = (await start.json()) as {
    options: Parameters<SoftAuthenticator["register"]>[0];
  };
  return browser.send("POST", "/api/me/passkeys", {
    response: await auth.register(options),
  });
}

async function challenge(
  browser: Browser,
): Promise<{ challenge: string; rpId: string }> {
  const start = await browser.send("POST", "/api/signin/passkey/options", {});
  expect(start.status).toBe(200);
  return (
    (await start.json()) as { options: { challenge: string; rpId: string } }
  ).options;
}

describe("passkeys on workerd", () => {
  for (const alg of ["ES256", "Ed25519"] as const) {
    it(`enrols an ${alg} passkey and signs in with it`, async () => {
      const { browser } = await world(`${alg.toLowerCase()}@example.com`);
      const auth = await SoftAuthenticator.create({ alg });
      expect((await enrol(browser, auth)).status).toBe(201);

      const card = new Browser();
      const options = await challenge(card);
      const res = await card.send("POST", "/api/signin/passkey/verify", {
        response: await auth.assert(options),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "signed_in" });
      expect(card.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
      expect(card.jar.has(PASSKEY_FLOW_COOKIE)).toBe(false);
    });
  }

  it("a replayed answer fails, and of two racing verifications exactly one signs in", async () => {
    const { browser } = await world("race@example.com");
    const auth = await SoftAuthenticator.create();
    expect((await enrol(browser, auth)).status).toBe(201);

    const card = new Browser();
    const options = await challenge(card);
    const flow = card.jar.get(PASSKEY_FLOW_COOKIE)!;
    const response = await auth.assert(options);
    const twins = [new Browser(), new Browser()];
    for (const t of twins) t.jar.set(PASSKEY_FLOW_COOKIE, flow);
    const results = await Promise.all(
      twins.map((t) =>
        t.send("POST", "/api/signin/passkey/verify", { response }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);

    const replay = new Browser();
    replay.jar.set(PASSKEY_FLOW_COOKIE, flow);
    const again = await replay.send("POST", "/api/signin/passkey/verify", {
      response,
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "signin_expired" });
  });

  it("refuses an assertion made for another origin", async () => {
    const { browser } = await world("origin@example.com");
    const auth = await SoftAuthenticator.create();
    expect((await enrol(browser, auth)).status).toBe(201);
    const card = new Browser();
    const options = await challenge(card);
    const res = await card.send("POST", "/api/signin/passkey/verify", {
      response: await auth.assert(options, { origin: "https://evil.example" }),
    });
    expect(res.status).toBe(401);
    expect(card.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("refuses the passkey of an account the erasure ledger holds, as a D1 restore leaves it (I-11)", async () => {
    const { browser, accountId } = await world("restored@example.com");
    const auth = await SoftAuthenticator.create();
    expect((await enrol(browser, auth)).status).toBe(201);
    // A restore brings the account back `active` with its passkey; only the ledger says it was
    // erased, so the ledger record is all this test needs to stand in for the restore.
    expect(await recordErasure(workerEnv, accountId, NOW)).toBe("created");
    const card = new Browser();
    const options = await challenge(card);
    const res = await card.send("POST", "/api/signin/passkey/verify", {
      response: await auth.assert(options),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(card.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  describe("on the customer origin (LK-05)", () => {
    const LOCKER = "https://polaris.locker";

    it("enrols on one origin and signs in on the other, always with rpId key.plrs.im", async () => {
      const { browser } = await world("locker@example.com");
      const auth = await SoftAuthenticator.create();
      expect((await enrol(browser, auth)).status).toBe(201);

      const card = new Browser(LOCKER, lockerEnv);
      const options = await challenge(card);
      expect(options.rpId).toBe("key.plrs.im");
      const res = await card.send("POST", "/api/signin/passkey/verify", {
        response: await auth.assert(options, { origin: LOCKER }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "signed_in" });
    });

    it("registers on the customer origin with rp.name Polaris Locker", async () => {
      const { browser } = await world("lockerreg@example.com");
      const onLocker = new Browser(LOCKER, lockerEnv);
      onLocker.jar = browser.jar;
      onLocker.csrf = browser.csrf;
      const start = await onLocker.send("POST", "/api/me/passkeys/options", {});
      expect(start.status).toBe(200);
      const { options } = (await start.json()) as {
        options: Parameters<SoftAuthenticator["register"]>[0];
      };
      expect(options.rp).toMatchObject({
        id: "key.plrs.im",
        name: "Polaris Locker",
      });
      const auth = await SoftAuthenticator.create();
      const res = await onLocker.send("POST", "/api/me/passkeys", {
        response: await auth.register(options, { origin: LOCKER }),
      });
      expect(res.status).toBe(201);
    });

    it("refuses a cross-origin ceremony (crossOrigin: true), at sign-in and at registration", async () => {
      const { browser } = await world("lockerframe@example.com");
      const auth = await SoftAuthenticator.create();
      expect((await enrol(browser, auth)).status).toBe(201);
      const card = new Browser(LOCKER, lockerEnv);
      const options = await challenge(card);
      const res = await card.send("POST", "/api/signin/passkey/verify", {
        response: await auth.assert(options, {
          origin: LOCKER,
          crossOrigin: true,
        }),
      });
      expect(res.status).toBe(401);
      const start = await browser.send("POST", "/api/me/passkeys/options", {});
      const { options: reg } = (await start.json()) as {
        options: Parameters<SoftAuthenticator["register"]>[0];
      };
      const other = await SoftAuthenticator.create();
      const made = await browser.send("POST", "/api/me/passkeys", {
        response: await other.register(reg, { crossOrigin: true }),
      });
      expect(made.status).toBeGreaterThanOrEqual(400);
    });

    it("refuses an assertion for the customer origin once the customer host is unusable", async () => {
      const { browser } = await world("lockergone@example.com");
      const auth = await SoftAuthenticator.create();
      expect((await enrol(browser, auth)).status).toBe(201);
      const card = new Browser(LOCKER, lockerEnv);
      const options = await challenge(card);
      // CUSTOMER_ORIGIN removed between the challenge and the answer.
      const gone = new Browser("https://key.plrs.im", {
        ...lockerEnv,
        CUSTOMER_ORIGIN: undefined,
      } as WorkerEnv);
      gone.jar = card.jar;
      const res = await gone.send("POST", "/api/signin/passkey/verify", {
        response: await auth.assert(options, { origin: LOCKER }),
      });
      expect(res.status).toBe(401);
    });

    it("refuses an origin that is not on the list, and a ceremony on an unlisted host", async () => {
      const { browser } = await world("lockerbad@example.com");
      const auth = await SoftAuthenticator.create();
      expect((await enrol(browser, auth)).status).toBe(201);
      const card = new Browser(LOCKER, lockerEnv);
      const options = await challenge(card);
      const res = await card.send("POST", "/api/signin/passkey/verify", {
        response: await auth.assert(options, {
          origin: "https://polaris.locker.evil.example",
        }),
      });
      expect(res.status).toBe(401);
      // The customer host is not configured: its origin runs no ceremony.
      const off = new Browser(LOCKER, {
        ...workerEnv,
        CONSOLE_ORIGIN: "https://key.plrs.im",
      } as WorkerEnv);
      const refused = await off.send("POST", "/api/signin/passkey/options", {});
      expect(refused.status).not.toBe(200);
    });
  });
});
