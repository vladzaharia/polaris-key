import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./seed.js";
import {
  Device,
  lastCode,
  lastLink,
  seededWorld,
  type CardWorld,
} from "./identityCardHarness.js";
import { EMAIL_CODE_TTL_SECONDS } from "../src/core/notify/emailLimits.js";
import {
  ACCOUNT_SESSION_COOKIE,
  SIGNIN_FLOW_COOKIE,
} from "../src/core/accounts/accountCookies.js";
import {
  EMAIL_FLOW_TTL_SECONDS,
  EMAIL_RESEND_AFTER_SECONDS,
} from "../src/services/identity/card/emailSignIn.js";

// PX-12 (SIGN-IN.md §3.13, §4.12 frame 15): a flow outlives its code, so the expired-link page
// can offer "Send a new code" to the masked address; the plain form POST lands on the code step,
// which reads GET /api/signin/flow.

afterEach(() => {
  vi.useRealTimers();
});

const START = "/api/signin/email/start";
const VERIFY = "/api/signin/email/verify";
const RESEND = "/api/signin/email/resend";
const FLOW = "/api/signin/flow";
const LATE = NOW + EMAIL_CODE_TTL_SECONDS + 5;

async function started(
  w: CardWorld,
  returnTo?: string,
): Promise<{ asker: Device; token: string }> {
  const asker = new Device(w);
  await asker.send("POST", START, {
    email: "ada@example.com",
    ...(returnTo ? { returnTo } : {}),
  });
  const token = new URL(lastLink(w, "ada@example.com")).searchParams.get(
    "token",
  )!;
  return { asker, token };
}

function later(at: number): void {
  vi.useFakeTimers();
  vi.setSystemTime(at * 1000);
}

describe("the flow outlives its code", () => {
  it("sets the flow cookie for an hour, not for the code's ten minutes", async () => {
    const w = await seededWorld();
    const res = await new Device(w).send("POST", START, {
      email: "ada@example.com",
    });
    expect(res.headers.get("set-cookie")).toContain(
      `Max-Age=${EMAIL_FLOW_TTL_SECONDS}`,
    );
  });

  it("answers a stale code as expired without counting it, and keeps the cookie", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const w = await seededWorld();
    const { asker } = await started(w);
    const code = lastCode(w, "ada@example.com");
    later(LATE);
    const res = await asker.send("POST", VERIFY, { code }, { now: LATE });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: "signin_expired" }),
    );
    expect(asker.jar.has(SIGNIN_FLOW_COOKIE)).toBe(true);
    expect(asker.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("the poll of a lapsed flow says expired and leaves the cookie for a resend", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const w = await seededWorld();
    const { asker } = await started(w);
    later(LATE);
    const res = await asker.send("POST", FLOW, undefined, { now: LATE });
    expect(await res.json()).toEqual({ status: "expired" });
    expect(asker.jar.has(SIGNIN_FLOW_COOKIE)).toBe(true);
  });

  it("is gone after the hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const w = await seededWorld();
    const { asker } = await started(w);
    const gone = NOW + EMAIL_FLOW_TTL_SECONDS + 5;
    later(gone);
    const res = await asker.send("GET", FLOW, undefined, { now: gone });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: "signin_expired" }),
    );
  });
});

describe("GET /api/signin/flow", () => {
  it("reads this browser's flow: the masked address and the waits", async () => {
    const w = await seededWorld();
    const { asker } = await started(w);
    const res = await asker.send("GET", FLOW, undefined, { now: NOW + 20 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      email: "a•••@example.com",
      expiresIn: EMAIL_CODE_TTL_SECONDS - 20,
      codeLength: 6,
      resendIn: EMAIL_RESEND_AFTER_SECONDS - 20,
    });
    expect(JSON.stringify(body)).not.toContain("ada@");
  });

  it("answers a browser with no flow signin_expired, and sets nothing", async () => {
    const w = await seededWorld();
    const res = await new Device(w).send("GET", FLOW);
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: "signin_expired" }),
    );
  });

  it("another browser, holding no cookie, learns nothing", async () => {
    const w = await seededWorld();
    await started(w);
    const res = await new Device(w, "198.51.100.9").send("GET", FLOW);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("example.com");
  });
});

describe("the expired-link page", () => {
  it("offers Send a new code to the masked address in the browser that asked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const w = await seededWorld();
    const { asker, token } = await started(w);
    later(LATE);
    const res = await asker.send(
      "GET",
      `/magic/verify?token=${token}`,
      undefined,
      { now: LATE },
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("That code or link has expired");
    expect(html).toContain("Codes and links work once, for 10 minutes.");
    expect(html).toContain(
      '<form method="post" action="/api/signin/email/resend">',
    );
    expect(html).toContain("Send a new code");
    expect(html).toContain("a•••@example.com");
    expect(html).toContain("Use a different email");
    expect(html).not.toContain("ada@example.com");
    expect(html).not.toContain("<script");
  });

  it("names no address to anyone else: Sign in again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const w = await seededWorld();
    const { token } = await started(w);
    later(LATE);
    const res = await new Device(w, "198.51.100.9").send(
      "GET",
      `/magic/verify?token=${token}`,
      undefined,
      { now: LATE },
    );
    const html = await res.text();
    expect(html).toContain("Sign in again");
    expect(html).not.toContain("Send a new code");
    expect(html).not.toContain("example.com");
  });

  it("a used link has no flow left: Sign in again", async () => {
    const w = await seededWorld();
    const { asker, token } = await started(w);
    await asker.send("POST", "/magic/verify", { token }, { form: true });
    const res = await asker.send("GET", `/magic/verify?token=${token}`);
    const html = await res.text();
    expect(html).toContain("That code or link has expired");
    expect(html).toContain("Sign in again");
    expect(html).not.toContain("Send a new code");
  });
});

describe("the plain form POST into the resend", () => {
  it("sends a new code and lands on the sign-in page's code step", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const w = await seededWorld();
    const { asker } = await started(w);
    const oldCode = lastCode(w, "ada@example.com");
    const mails = w.mail.length;
    later(LATE);
    const res = await asker.send("POST", RESEND, {}, { form: true, now: LATE });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?signin=code");
    expect(w.mail.length).toBe(mails + 1);
    // The new flow is in the cookie: the code step reads it, and the new code signs in.
    const flow = await asker.send("GET", FLOW, undefined, { now: LATE });
    expect(await flow.json()).toEqual(
      expect.objectContaining({
        email: "a•••@example.com",
        resendIn: EMAIL_RESEND_AFTER_SECONDS,
      }),
    );
    const stale = await asker.send(
      "POST",
      VERIFY,
      { code: oldCode },
      { now: LATE },
    );
    expect(stale.status).toBe(400);
    const ok = await asker.send(
      "POST",
      VERIFY,
      { code: lastCode(w, "ada@example.com") },
      { now: LATE },
    );
    expect(ok.status).toBe(200);
  });

  it("keeps returnTo and the request handle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const w = await seededWorld();
    const { asker } = await started(w, "/signin?request=rq_abc123");
    later(LATE);
    const res = await asker.send("POST", RESEND, {}, { form: true, now: LATE });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/signin?request=rq_abc123&signin=code",
    );
    // The new flow still holds it: the verify's `next` is the original page.
    const ok = await asker.send(
      "POST",
      VERIFY,
      { code: lastCode(w, "ada@example.com") },
      { now: LATE },
    );
    expect(ok.status).toBe(200);
  });

  it("asked too soon, lands on the code step too: its countdown says when", async () => {
    const w = await seededWorld();
    const { asker } = await started(w);
    const res = await asker.send(
      "POST",
      RESEND,
      {},
      { form: true, now: NOW + 5 },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?signin=code");
    expect(w.mail.length).toBe(1);
  });

  it("without a flow, ends on the expired page with Sign in again", async () => {
    const w = await seededWorld();
    const res = await new Device(w).send("POST", RESEND, {}, { form: true });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Sign in again");
    expect(html).not.toContain("Send a new code");
  });

  it("a cross-site form arrives without the Lax cookie and resends nothing", async () => {
    const w = await seededWorld();
    await started(w);
    const res = await new Device(w, "198.51.100.9").send(
      "POST",
      RESEND,
      {},
      { form: true },
    );
    expect(res.status).toBe(400);
    expect(w.mail.length).toBe(1);
  });
});
