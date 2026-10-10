import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import {
  Device,
  lastCode,
  lastLink,
  seededWorld,
  type CardWorld,
} from "./identityCardHarness.js";
import {
  EMAIL_CODE_DIGITS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_SECONDS,
  EMAIL_LOCKOUT_THRESHOLD,
  EMAIL_SEND_PER_IP_HOUR,
  EMAIL_SEND_PER_RECIPIENT_DAY,
  EMAIL_SEND_PER_RECIPIENT_HOUR,
} from "../src/core/notify/emailLimits.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import {
  ACCOUNT_SESSION_COOKIE,
  SIGNIN_FLOW_COOKIE,
} from "../src/core/accounts/accountCookies.js";
import { TURNSTILE_VERIFY_URL } from "../src/services/identity/card/turnstile.js";
import { EMAIL_RESEND_AFTER_SECONDS } from "../src/services/identity/card/emailSignIn.js";
import { disableAccount } from "../src/services/identity/accounts/deletion.js";

// I-07: the login card's email sign-in (S-16 §5.4 item 4; PORTAL.md §4.1, §4.4). A code and a
// magic link in one email, bound to the browser that asked; identical answers for known and
// unknown addresses; I-02's limits and lifetimes enforced end to end.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const START = "/api/signin/email/start";
const VERIFY = "/api/signin/email/verify";

/** A start's answer minus the one random value it carries (the flow cookie's secret). */
async function startShape(res: Response): Promise<unknown> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = k === "set-cookie" ? v.replace(/=[^;]+;/, "=<secret>;") : v;
  });
  return { status: res.status, headers, body: await res.text() };
}

describe("email start (identifier-first)", () => {
  it("known and unknown emails get byte-identical answers", async () => {
    const w = await seededWorld();
    await getOrCreateAccountByEmail(w.db, "known@example.com", NOW);
    const known = await new Device(w, "198.51.100.1").send("POST", START, {
      email: "known@example.com",
    });
    const unknown = await new Device(w, "198.51.100.2").send("POST", START, {
      email: "nobody@example.com",
    });
    expect(known.status).toBe(200);
    expect(await startShape(known)).toEqual(await startShape(unknown));
    // Both got mail: the start never looks the address up.
    expect(w.mail.map((m) => m.to).sort()).toEqual([
      "known@example.com",
      "nobody@example.com",
    ]);
  });

  it("a refused send (over the recipient limit) answers exactly like a sent one", async () => {
    const w = await seededWorld();
    const answers: unknown[] = [];
    for (let i = 0; i <= EMAIL_SEND_PER_RECIPIENT_HOUR; i++) {
      const res = await new Device(w, `198.51.${i}.9`).send("POST", START, {
        email: "ada@example.com",
      });
      answers.push(await startShape(res));
    }
    expect(w.mail).toHaveLength(EMAIL_SEND_PER_RECIPIENT_HOUR);
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
  });

  it("caps one recipient at 20 a day across hours", async () => {
    const w = await seededWorld();
    // The limiter counts fixed windows: start just after a UTC midnight so six hours stay in one day.
    let at = Math.ceil(NOW / 86_400) * 86_400 + 60;
    let n = 0;
    for (let hour = 0; hour < 6; hour++) {
      for (let i = 0; i < EMAIL_SEND_PER_RECIPIENT_HOUR; i++) {
        await new Device(w, `192.0.${n % 250}.${n}`).send(
          "POST",
          START,
          { email: "ada@example.com" },
          { now: at },
        );
        n++;
      }
      at += 3601;
    }
    expect(w.mail).toHaveLength(EMAIL_SEND_PER_RECIPIENT_DAY);
  });

  it("caps one client address per hour, whatever the recipients", async () => {
    const w = await seededWorld();
    const d = new Device(w, "198.51.100.77");
    for (let i = 0; i < EMAIL_SEND_PER_IP_HOUR + 3; i++) {
      // Spread over minutes so the per-minute start limit is not what refuses.
      await d.send(
        "POST",
        START,
        { email: `p${i}@example.com` },
        { now: NOW + i * 61 },
      );
    }
    expect(w.mail).toHaveLength(EMAIL_SEND_PER_IP_HOUR);
  });

  it("sends a 6-digit code and a link in one message, and sets a host-only flow cookie", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    const res = await d.send("POST", START, { email: "Ada@Example.com" });
    expect(await res.json()).toEqual({
      ok: true,
      expiresIn: EMAIL_CODE_TTL_SECONDS,
      codeLength: EMAIL_CODE_DIGITS,
      resendIn: EMAIL_RESEND_AFTER_SECONDS,
    });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${SIGNIN_FLOW_COOKIE}=`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain");
    expect(w.mail).toHaveLength(1);
    expect(w.mail[0]!.to).toBe("ada@example.com");
    expect(lastCode(w, "ada@example.com")).toMatch(/^\d{6}$/);
    expect(lastLink(w, "ada@example.com")).toMatch(
      /^https:\/\/key\.plrs\.im\/magic\/verify\?token=/,
    );
  });

  it("rejects a malformed address before anything is sent", async () => {
    const w = await seededWorld();
    const res = await new Device(w).send("POST", START, {
      email: "not-an-email",
    });
    expect(res.status).toBe(422);
    expect(w.mail).toHaveLength(0);
  });
});

describe("email code", () => {
  it("signs the asking browser in: an account session row and the host-only cookie", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    const res = await d.signInWithCode("ada@example.com");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({ status: "signed_in", next: "/", nudge: true }),
    );
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(d.jar.has(SIGNIN_FLOW_COOKIE)).toBe(false);
    const rows = await w.db.all<{ amr_json: string }>(
      "SELECT amr_json FROM account_sessions",
    );
    expect(rows).toEqual([{ amr_json: '["email"]' }]);
    expect((await d.me()).status).toBe(200);
  });

  it("is single-use: the same code cannot complete twice", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await d.send("POST", START, { email: "ada@example.com" });
    const code = lastCode(w, "ada@example.com");
    const flow = d.jar.get(SIGNIN_FLOW_COOKIE)!;
    expect((await d.send("POST", VERIFY, { code })).status).toBe(200);
    d.jar.set(SIGNIN_FLOW_COOKIE, flow);
    const again = await d.send("POST", VERIFY, { code });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual(
      expect.objectContaining({ error: "signin_expired" }),
    );
  });

  it("is bound to the browser that asked: another browser cannot redeem it", async () => {
    const w = await seededWorld();
    const asker = new Device(w);
    await asker.send("POST", START, { email: "ada@example.com" });
    const thief = new Device(w, "198.51.100.66");
    const res = await thief.send("POST", VERIFY, {
      code: lastCode(w, "ada@example.com"),
    });
    expect(res.status).toBe(400);
    expect(thief.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("dies after 5 wrong attempts, even before the right one", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    await d.send("POST", START, { email: "ada@example.com" });
    const code = lastCode(w, "ada@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    const messages: string[] = [];
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
      const res = await d.send("POST", VERIFY, { code: wrong });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body).toEqual(
        expect.objectContaining({
          error: "invalid_code",
          triesLeft: EMAIL_CODE_MAX_ATTEMPTS - 1 - i,
        }),
      );
      messages.push(body.message);
    }
    // SIGN-IN.md §3.4: the wrong-code copy, with the tries left once two or fewer remain.
    expect(messages.slice(-3)).toEqual([
      "That code isn't right. Check the email and try again. 2 tries left.",
      "That code isn't right. Check the email and try again. 1 try left.",
      "Too many tries. Send a new code.",
    ]);
    expect(messages[0]).toBe(
      "That code isn't right. Check the email and try again.",
    );
    expect((await d.send("POST", VERIFY, { code })).status).toBe(400);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("expires after 10 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const w = await seededWorld();
    const d = new Device(w);
    await d.send("POST", START, { email: "ada@example.com" });
    const code = lastCode(w, "ada@example.com");
    vi.setSystemTime((NOW + EMAIL_CODE_TTL_SECONDS + 1) * 1000);
    const res = await d.send(
      "POST",
      VERIFY,
      { code },
      {
        now: NOW + EMAIL_CODE_TTL_SECONDS + 1,
      },
    );
    expect(res.status).toBe(400);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("locks a recipient out of new codes after 10 wrong attempts in an hour, silently", async () => {
    const w = await seededWorld();
    let strikes = 0;
    let n = 0;
    while (strikes < EMAIL_LOCKOUT_THRESHOLD) {
      const d = new Device(w, `192.0.2.${n++}`);
      await d.send(
        "POST",
        START,
        { email: "ada@example.com" },
        { now: NOW + n * 61 },
      );
      for (let i = 0; i < 2 && strikes < EMAIL_LOCKOUT_THRESHOLD; i++) {
        const code = lastCode(w, "ada@example.com");
        await d.send(
          "POST",
          VERIFY,
          { code: code === "000000" ? "111111" : "000000" },
          { now: NOW + n * 61 },
        );
        strikes++;
      }
    }
    const before = w.mail.length;
    const locked = await new Device(w, "192.0.2.200").send(
      "POST",
      START,
      { email: "ada@example.com" },
      { now: NOW + 3000 },
    );
    expect(locked.status).toBe(200);
    expect(w.mail.length).toBe(before);
  });
});

describe("magic link", () => {
  async function started(
    w: CardWorld,
  ): Promise<{ asker: Device; token: string; link: string }> {
    const asker = new Device(w);
    await asker.send("POST", START, { email: "ada@example.com" });
    const link = lastLink(w, "ada@example.com");
    return { asker, link, token: new URL(link).searchParams.get("token")! };
  }

  it("opening the link consumes nothing: a scanner's GET leaves it working", async () => {
    const w = await seededWorld();
    const { asker, link } = await started(w);
    const path = new URL(link).pathname + new URL(link).search;
    const scanner = new Device(w, "198.51.100.200");
    for (let i = 0; i < 3; i++) {
      const page = await scanner.send("GET", path);
      expect(page.status).toBe(200);
      expect(page.headers.get("set-cookie")).toBeNull();
    }
    const landing = await asker.send("GET", path);
    expect(await landing.text()).toContain("Continue as ada@example.com.");
  });

  it("in the asking browser, the landing page's POST signs in", async () => {
    const w = await seededWorld();
    const { asker, token } = await started(w);
    const res = await asker.send(
      "POST",
      "/magic/verify",
      { token },
      { form: true },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(asker.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(asker.jar.has(SIGNIN_FLOW_COOKIE)).toBe(false);
  });

  it("on another device it asks to confirm a sign-in requested at <time> from <place>, and signs only the asker in", async () => {
    const w = await seededWorld();
    const { asker, link, token } = await started(w);
    const phone = new Device(w, "198.51.100.50");
    const page = await phone.send(
      "GET",
      new URL(link).pathname + new URL(link).search,
    );
    const html = await page.text();
    expect(html).toContain("Confirm sign-in");
    expect(html).toMatch(
      /Confirm sign-in, requested at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC from an unknown location/,
    );
    expect(html).toContain("The device that asked signs in, not this one.");

    // Before confirmation, the asker's poll is pending.
    const pending = await asker.send("POST", "/api/signin/flow");
    expect(await pending.json()).toEqual(
      expect.objectContaining({ status: "pending" }),
    );

    const confirmed = await phone.send(
      "POST",
      "/magic/verify",
      { token },
      { form: true },
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).toContain("Sign-in confirmed");
    // The phone is NOT signed in (relay phishing yields the attacker nothing).
    expect(phone.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);

    const done = await asker.send("POST", "/api/signin/flow");
    expect(await done.json()).toEqual(
      expect.objectContaining({ status: "signed_in" }),
    );
    expect(asker.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    // And only once.
    const again = await asker.send("POST", "/api/signin/flow");
    expect(await again.json()).toEqual({ status: "expired" });
  });

  it("the link and the code complete one flow once: the code after the link fails", async () => {
    const w = await seededWorld();
    const { asker, token } = await started(w);
    const code = lastCode(w, "ada@example.com");
    const flow = asker.jar.get(SIGNIN_FLOW_COOKIE)!;
    expect(
      (await asker.send("POST", "/magic/verify", { token }, { form: true }))
        .status,
    ).toBe(302);
    asker.jar.set(SIGNIN_FLOW_COOKIE, flow);
    expect((await asker.send("POST", VERIFY, { code })).status).toBe(400);
  });
});

describe("an account that can't sign in (SIGN-IN.md §3.13, Account disabled)", () => {
  async function disabledAda(w: CardWorld): Promise<void> {
    const account = await getOrCreateAccountByEmail(
      w.db,
      "ada@example.com",
      NOW,
    );
    expect(
      await disableAccount(
        { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
        account.id,
      ),
    ).toEqual({ ok: true });
  }

  it("the code answers 403 forbidden, naming no channel to contact", async () => {
    const w = await seededWorld();
    await disabledAda(w);
    const d = new Device(w);
    const res = await d.signInWithCode("ada@example.com");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      message: "This account can't sign in.",
    });
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("the link's page offers another account, back where the sign-in was headed", async () => {
    const w = await seededWorld();
    await disabledAda(w);
    const asker = new Device(w);
    await asker.send("POST", START, {
      email: "ada@example.com",
      returnTo: "/#/p/acme",
    });
    const token = new URL(lastLink(w, "ada@example.com")).searchParams.get(
      "token",
    )!;
    const res = await asker.send(
      "POST",
      "/magic/verify",
      { token },
      { form: true },
    );
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toMatch(/This account can(&#39;|&#x27;|')t sign in/);
    expect(html).toContain(
      '<a class="button" href="/#/p/acme">Sign in with another account</a>',
    );
    expect(html).not.toContain("Polaris Key support");
    expect(html).not.toContain("Back to ");
    expect(asker.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });
});

describe("Turnstile on the email start", () => {
  it("is not asked for when the deploy has no secret", async () => {
    const w = await seededWorld();
    const caps = await new Device(w).send("GET", "/api/capabilities");
    expect(await caps.json()).toEqual(
      expect.objectContaining({ turnstileSiteKey: null }),
    );
  });

  it("refuses a missing or failing token, and sends nothing", async () => {
    const w = await seededWorld();
    w.env.TURNSTILE_SECRET_KEY = "secret";
    w.env.TURNSTILE_SITE_KEY = "0x4AAAAAAAsite";
    const verdicts: boolean[] = [false];
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return Response.json({ success: verdicts.shift() ?? true });
      }),
    );
    const caps = await new Device(w).send("GET", "/api/capabilities");
    expect(await caps.json()).toEqual(
      expect.objectContaining({ turnstileSiteKey: "0x4AAAAAAAsite" }),
    );
    const none = await new Device(w).send("POST", START, {
      email: "ada@example.com",
    });
    expect(none.status).toBe(403);
    expect(calls).toHaveLength(0);
    const bad = await new Device(w).send("POST", START, {
      email: "ada@example.com",
      turnstileToken: "tok-bad",
    });
    expect(bad.status).toBe(403);
    expect(w.mail).toHaveLength(0);
    const good = await new Device(w, "198.51.100.3").send("POST", START, {
      email: "ada@example.com",
      turnstileToken: "tok-good",
    });
    expect(good.status).toBe(200);
    expect(w.mail).toHaveLength(1);
    expect(calls[1]!.url).toBe(TURNSTILE_VERIFY_URL);
    expect(calls[1]!.body).toContain("secret=secret");
    expect(calls[1]!.body).toContain("remoteip=198.51.100.3");
  });

  it("fails closed when Cloudflare cannot be reached", async () => {
    const w = await seededWorld();
    w.env.TURNSTILE_SECRET_KEY = "secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const res = await new Device(w).send("POST", START, {
      email: "ada@example.com",
      turnstileToken: "tok",
    });
    expect(res.status).toBe(403);
  });
});

describe("the older start name", () => {
  it("POST /api/magic/start is the same handler", async () => {
    const w = await seededWorld();
    const d = new Device(w);
    const res = await d.send("POST", "/api/magic/start", {
      email: "ada@example.com",
    });
    expect(res.status).toBe(200);
    expect(d.jar.has(SIGNIN_FLOW_COOKIE)).toBe(true);
    expect(
      (await d.send("POST", VERIFY, { code: lastCode(w, "ada@example.com") }))
        .status,
    ).toBe(200);
  });
});
