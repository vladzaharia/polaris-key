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
  EMAIL_CODE_TTL_SECONDS,
  EMAIL_SEND_PER_RECIPIENT_HOUR,
} from "../src/core/emailLimits.js";
import {
  EMAIL_RESEND_AFTER_SECONDS,
  EMAIL_SENDS_PER_FLOW,
  EMAIL_START_PER_IP_MINUTE,
} from "../src/services/identity/card/emailSignIn.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import {
  ACCOUNT_SESSION_COOKIE,
  SIGNIN_FLOW_COOKIE,
} from "../src/core/accountCookies.js";

// PX-W4: the email code for the account sign-in on I-02's single-use store (PORTAL.md §4.4).
// I-07 built the start and the verify (`identityCardEmail.test.ts`); this covers what the code
// step adds on top, the **Resend**, and the races the store must win: one completion per code,
// one rotation per flow.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const START = "/api/signin/email/start";
const VERIFY = "/api/signin/email/verify";
const RESEND = "/api/signin/email/resend";
/** The first moment a resend is allowed after a start at `NOW`. */
const LATER = NOW + EMAIL_RESEND_AFTER_SECONDS;

/** An answer minus the one random value it carries (the flow cookie's secret). */
async function shape(res: Response): Promise<unknown> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = k === "set-cookie" ? v.replace(/=[^;]+;/, "=<secret>;") : v;
  });
  return { status: res.status, headers, body: await res.text() };
}

/** A device that has started an email sign-in for `email` at `NOW`. */
async function started(
  w: CardWorld,
  email = "ada@example.com",
  ip?: string,
  body: Record<string, unknown> = {},
): Promise<Device> {
  const d = new Device(w, ip);
  const res = await d.send("POST", START, { email, ...body });
  expect(res.status).toBe(200);
  return d;
}

describe("resend: enumeration safety", () => {
  it("known and unknown addresses get byte-identical answers, the start's bytes", async () => {
    const w = await seededWorld();
    await getOrCreateAccountByEmail(w.db, "known@example.com", NOW);
    const known = new Device(w, "198.51.100.1");
    const startAnswer = await shape(
      await known.send("POST", START, { email: "known@example.com" }),
    );
    const unknown = await started(w, "nobody@example.com", "198.51.100.2");

    const a = await known.send("POST", RESEND, undefined, { now: LATER });
    const b = await unknown.send("POST", RESEND, undefined, { now: LATER });
    expect(a.status).toBe(200);
    const shapeA = await shape(a);
    expect(shapeA).toEqual(await shape(b));
    expect(shapeA).toEqual(startAnswer);
    // Both got their second email: the resend never looks the address up either.
    expect(w.mail.map((m) => m.to).sort()).toEqual([
      "known@example.com",
      "known@example.com",
      "nobody@example.com",
      "nobody@example.com",
    ]);
  });

  it("a refused resend (over the recipient's hourly limit) answers exactly like a sent one", async () => {
    const w = await seededWorld();
    const d = new Device(w, "198.51.100.9");
    const startAnswer = await shape(
      await d.send("POST", START, { email: "ada@example.com" }),
    );
    // Others spend the rest of ada's hourly budget.
    for (let i = 1; i < EMAIL_SEND_PER_RECIPIENT_HOUR; i++)
      await started(w, "ada@example.com", `198.51.${i}.10`);
    expect(w.mail).toHaveLength(EMAIL_SEND_PER_RECIPIENT_HOUR);

    const refused = await d.send("POST", RESEND, undefined, { now: LATER });
    expect(await shape(refused)).toEqual(startAnswer);
    expect(w.mail).toHaveLength(EMAIL_SEND_PER_RECIPIENT_HOUR);
  });
});

describe("resend", () => {
  it("mails a new code and link to the same address, keeps returnTo, and retires the old ones", async () => {
    const w = await seededWorld();
    const d = await started(w, "ada@example.com", undefined, {
      returnTo: "/library",
    });
    const oldCode = lastCode(w, "ada@example.com");
    const oldToken = new URL(lastLink(w, "ada@example.com")).searchParams.get(
      "token",
    )!;
    const oldFlow = d.jar.get(SIGNIN_FLOW_COOKIE)!;

    const res = await d.send("POST", RESEND, undefined, { now: LATER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      expiresIn: EMAIL_CODE_TTL_SECONDS,
      codeLength: EMAIL_CODE_DIGITS,
      resendIn: EMAIL_RESEND_AFTER_SECONDS,
    });
    const newFlow = d.jar.get(SIGNIN_FLOW_COOKIE)!;
    expect(newFlow).toBeDefined();
    expect(newFlow).not.toBe(oldFlow);
    expect(w.mail).toHaveLength(2);
    expect(w.mail[1]!.to).toBe("ada@example.com");
    const newCode = lastCode(w, "ada@example.com");
    const newToken = new URL(lastLink(w, "ada@example.com")).searchParams.get(
      "token",
    )!;
    expect(newToken).not.toBe(oldToken);

    // The old link is gone, in the asking browser too.
    const oldLink = await d.send(
      "POST",
      "/magic/verify",
      { token: oldToken },
      { form: true, now: LATER },
    );
    expect(oldLink.status).toBe(400);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    // The old cookie no longer names a flow.
    const stale = new Device(w);
    stale.jar.set(SIGNIN_FLOW_COOKIE, oldFlow);
    const staleVerify = await stale.send(
      "POST",
      VERIFY,
      { code: oldCode },
      { now: LATER },
    );
    expect(staleVerify.status).toBe(400);
    expect(await staleVerify.json()).toEqual(
      expect.objectContaining({ error: "signin_expired" }),
    );
    // The old code is not this flow's code (a collision is a one-in-a-million chance).
    if (oldCode !== newCode) {
      const wrong = await d.send(
        "POST",
        VERIFY,
        { code: oldCode },
        { now: LATER },
      );
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toEqual(
        expect.objectContaining({ error: "invalid_code" }),
      );
    }
    // The new code signs in, headed where the start said.
    const ok = await d.send("POST", VERIFY, { code: newCode }, { now: LATER });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(
      expect.objectContaining({ status: "signed_in", next: "/library" }),
    );
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(d.jar.has(SIGNIN_FLOW_COOKIE)).toBe(false);
  });

  it(`waits ${EMAIL_RESEND_AFTER_SECONDS} seconds after the last code and changes nothing meanwhile`, async () => {
    const w = await seededWorld();
    const d = await started(w);
    const flow = d.jar.get(SIGNIN_FLOW_COOKIE);
    const early = await d.send("POST", RESEND, undefined, { now: NOW + 10 });
    expect(early.status).toBe(429);
    expect(early.headers.get("retry-after")).toBe(
      String(EMAIL_RESEND_AFTER_SECONDS - 10),
    );
    expect(early.headers.get("set-cookie")).toBeNull();
    expect(await early.json()).toEqual({
      error: "rate_limited",
      message: "Wait a minute, then send a new code.",
      retryAfter: EMAIL_RESEND_AFTER_SECONDS - 10,
    });
    expect(w.mail).toHaveLength(1);
    expect(d.jar.get(SIGNIN_FLOW_COOKIE)).toBe(flow);
    // The code from the start still works.
    const ok = await d.send(
      "POST",
      VERIFY,
      { code: lastCode(w, "ada@example.com") },
      { now: NOW + 10 },
    );
    expect(ok.status).toBe(200);
  });

  it(`sends at most ${EMAIL_SENDS_PER_FLOW} emails per sign-in, its start included; the latest code still works`, async () => {
    const w = await seededWorld();
    const d = await started(w);
    let at = NOW;
    for (let i = 1; i < EMAIL_SENDS_PER_FLOW; i++) {
      at += EMAIL_RESEND_AFTER_SECONDS;
      const res = await d.send("POST", RESEND, undefined, { now: at });
      expect(res.status).toBe(200);
    }
    expect(w.mail).toHaveLength(EMAIL_SENDS_PER_FLOW);
    at += EMAIL_RESEND_AFTER_SECONDS;
    const capped = await d.send("POST", RESEND, undefined, { now: at });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({
      error: "rate_limited",
      message: "Too many codes for this sign-in. Start again.",
    });
    expect(w.mail).toHaveLength(EMAIL_SENDS_PER_FLOW);
    const ok = await d.send(
      "POST",
      VERIFY,
      { code: lastCode(w, "ada@example.com") },
      { now: at },
    );
    expect(ok.status).toBe(200);
  });

  it("needs a live flow in this browser: none, or one already completed, is signin_expired", async () => {
    const w = await seededWorld();
    const none = await new Device(w).send("POST", RESEND, undefined, {
      now: LATER,
    });
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual(
      expect.objectContaining({ error: "signin_expired" }),
    );

    const d = await started(w);
    const flow = d.jar.get(SIGNIN_FLOW_COOKIE)!;
    expect(
      (
        await d.send(
          "POST",
          VERIFY,
          { code: lastCode(w, "ada@example.com") },
          { now: LATER },
        )
      ).status,
    ).toBe(200);
    d.jar.set(SIGNIN_FLOW_COOKIE, flow);
    const done = await d.send("POST", RESEND, undefined, { now: LATER });
    expect(done.status).toBe(400);
    expect(await done.json()).toEqual(
      expect.objectContaining({ error: "signin_expired" }),
    );
    expect(w.mail).toHaveLength(1);
  });

  it("asks for no new Turnstile token: the flow passed one", async () => {
    const w = await seededWorld();
    w.env.TURNSTILE_SECRET_KEY = "secret";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Response.json({ success: true });
      }),
    );
    const d = await started(w, "ada@example.com", undefined, {
      turnstileToken: "tok",
    });
    expect(calls).toHaveLength(1);
    const res = await d.send("POST", RESEND, undefined, { now: LATER });
    expect(res.status).toBe(200);
    expect(w.mail).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it("shares the start's per-address minute bucket in the _portal scope", async () => {
    const w = await seededWorld();
    const ip = "198.51.100.40";
    const d = await started(w, "ada@example.com", ip);
    // A fresh minute: other starts from the same address spend it.
    const other = new Device(w, ip);
    for (let i = 0; i < EMAIL_START_PER_IP_MINUTE; i++)
      await other.send(
        "POST",
        START,
        { email: `p${i}@example.com` },
        { now: LATER },
      );
    const mailed = w.mail.length;
    const res = await d.send("POST", RESEND, undefined, { now: LATER });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(w.mail).toHaveLength(mailed);
  });

  it("is POST only", async () => {
    const w = await seededWorld();
    const d = await started(w);
    const res = await d.send("GET", RESEND, undefined, { now: LATER });
    expect(res.status).toBe(405);
    expect(w.mail).toHaveLength(1);
  });
});

describe("races on the single-use store", () => {
  it("a code is single-use under concurrent verify: one of five racing verifications signs in", async () => {
    const w = await seededWorld();
    const d = await started(w);
    const code = lastCode(w, "ada@example.com");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => d.send("POST", VERIFY, { code })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      200, 400, 400, 400, 400,
    ]);
    const signedIn = await Promise.all(
      results.map(
        async (r) => ((await r.json()) as { status?: string }).status,
      ),
    );
    expect(signedIn.filter((s) => s === "signed_in")).toHaveLength(1);
    const rows = await w.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM account_sessions",
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it("two concurrent resends (a double click) retire the flow once: one new email, the winner's cookie kept", async () => {
    const w = await seededWorld();
    const d = await started(w);
    const results = await Promise.all([
      d.send("POST", RESEND, undefined, { now: LATER }),
      d.send("POST", RESEND, undefined, { now: LATER }),
    ]);
    const [winner, loser] =
      results[0]!.status === 200 ? results : [results[1]!, results[0]!];
    expect(winner!.status).toBe(200);
    // The loser either lost the retirement (wait) or read the flow after it (expired); either
    // way it sets no cookie, so it cannot drop the one the winner set.
    expect([400, 429]).toContain(loser!.status);
    expect(loser!.headers.get("set-cookie")).toBeNull();
    expect(w.mail).toHaveLength(2);
    // The winner's cookie names the live flow; its code signs in.
    const ok = await d.send(
      "POST",
      VERIFY,
      { code: lastCode(w, "ada@example.com") },
      { now: LATER },
    );
    expect(ok.status).toBe(200);
  });

  it("a code racing a resend: one wins, never a session and a new email both", async () => {
    const w = await seededWorld();
    const d = await started(w);
    const code = lastCode(w, "ada@example.com");
    const [verified, resent] = await Promise.all([
      d.send("POST", VERIFY, { code }, { now: LATER }),
      d.send("POST", RESEND, undefined, { now: LATER }),
    ]);
    const sessions = (
      await w.db.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM account_sessions",
      )
    )[0]!.n;
    const newEmails = w.mail.length - 1;
    expect(sessions + newEmails).toBe(1);
    expect([verified.status, resent.status].sort()).toEqual(
      sessions === 1 ? [200, 429] : [200, 400],
    );
  });
});
