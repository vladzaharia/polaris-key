import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkEmailSend,
  EMAIL_CODE_DIGITS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_SECONDS,
  EMAIL_LOCKOUT_SECONDS,
  EMAIL_LOCKOUT_THRESHOLD,
  EMAIL_LOCKOUT_WINDOW_SECONDS,
  EMAIL_SEND_PER_DEVICE_HOUR,
  EMAIL_SEND_PER_IP_HOUR,
  EMAIL_SEND_PER_NETWORK_HOUR,
  EMAIL_SEND_PER_RECIPIENT_DAY,
  EMAIL_SEND_PER_RECIPIENT_HOUR,
  EMAIL_SEND_PRODUCT_DAILY_DEFAULT,
  emailRecipientLocked,
  generateEmailCode,
  issueEmailCode,
  normalizeEmailCode,
  recipientHash,
  verifyEmailCode,
} from "../src/core/emailLimits.js";
import type { Env } from "../src/env.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import { singleUseMock } from "./singleUseMock.js";

// I-02: the email send and verify limits S-16 §5.4 item 4 specifies, as the primitives I-08
// builds on. The numbers are the specified defaults; these tests pin them.

const env = (): Env => {
  const e = makeEnv(new KvMock(), []);
  e.KEY_HASH_PEPPER = "email-limits-pepper";
  return e;
};
const reqFrom = (ip: string): Request =>
  new Request("https://key.plrs.im/djdl/identity/email/start", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
  }) as unknown as Request;
const T = NOW;

afterEach(() => {
  vi.useRealTimers();
});

describe("the S-16 default numbers", () => {
  it("are the specified values", () => {
    expect(EMAIL_CODE_DIGITS).toBe(6);
    expect(EMAIL_CODE_TTL_SECONDS).toBe(600);
    expect(EMAIL_CODE_MAX_ATTEMPTS).toBe(5);
    expect(EMAIL_LOCKOUT_THRESHOLD).toBe(10);
    expect(EMAIL_LOCKOUT_WINDOW_SECONDS).toBe(3600);
    expect(EMAIL_LOCKOUT_SECONDS).toBe(900);
    expect(EMAIL_SEND_PER_RECIPIENT_HOUR).toBe(5);
    expect(EMAIL_SEND_PER_RECIPIENT_DAY).toBe(20);
    expect(EMAIL_SEND_PER_DEVICE_HOUR).toBe(3);
    expect(EMAIL_SEND_PER_IP_HOUR).toBeGreaterThan(0);
    expect(EMAIL_SEND_PER_NETWORK_HOUR).toBeGreaterThanOrEqual(
      EMAIL_SEND_PER_IP_HOUR,
    );
    expect(EMAIL_SEND_PRODUCT_DAILY_DEFAULT).toBeGreaterThan(0);
  });
});

describe("codes", () => {
  it("are 6 digits, leading zeros kept, and spread over the space", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const c = generateEmailCode();
      expect(c).toMatch(/^\d{6}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(490);
  });

  it("normalise typed input and refuse anything else", () => {
    expect(normalizeEmailCode("123 456")).toBe("123456");
    expect(normalizeEmailCode("123-456")).toBe("123456");
    expect(normalizeEmailCode("12345")).toBeNull();
    expect(normalizeEmailCode("12345a")).toBeNull();
    expect(normalizeEmailCode("1234567")).toBeNull();
  });

  it("hash recipients case-insensitively and never key on the address", async () => {
    const e = env();
    expect(await recipientHash(e, " User@Example.com ")).toBe(
      await recipientHash(e, "user@example.com"),
    );
    const addr = {
      product: "djdl",
      recipient: "user@example.com",
      flowId: "f",
    };
    await issueEmailCode(e, addr, "{}");
    for (const k of singleUseMock(e).keys()) {
      expect(k).not.toContain("user@example.com");
      expect(k).not.toContain("example");
    }
  });
});

describe("verify side", () => {
  const addr = {
    product: "djdl",
    recipient: "user@example.com",
    flowId: "flow-1",
  };

  it("a right code verifies once and returns the payload", async () => {
    const e = env();
    const { code } = await issueEmailCode(e, addr, '{"flow":1}');
    expect(await verifyEmailCode(e, { ...addr, code })).toEqual({
      ok: true,
      payload: '{"flow":1}',
    });
    expect(await verifyEmailCode(e, { ...addr, code })).toEqual({ ok: false });
  });

  it("two concurrent verifies of one right code: exactly one succeeds", async () => {
    const e = env();
    const { code } = await issueEmailCode(e, addr, "p");
    const results = await Promise.all([
      verifyEmailCode(e, { ...addr, code }),
      verifyEmailCode(e, { ...addr, code }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("accepts the code as typed with a separator", async () => {
    const e = env();
    const { code } = await issueEmailCode(e, addr, "p");
    const typed = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect((await verifyEmailCode(e, { ...addr, code: typed })).ok).toBe(true);
  });

  it(`dies after ${EMAIL_CODE_MAX_ATTEMPTS} wrong attempts`, async () => {
    const e = env();
    const { code } = await issueEmailCode(e, addr, "p");
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++)
      expect(await verifyEmailCode(e, { ...addr, code: wrong })).toEqual({
        ok: false,
      });
    expect(await verifyEmailCode(e, { ...addr, code })).toEqual({ ok: false });
  });

  it("survives fewer than the cap", async () => {
    const e = env();
    const { code } = await issueEmailCode(e, addr, "p");
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS - 1; i++)
      await verifyEmailCode(e, { ...addr, code: wrong });
    expect((await verifyEmailCode(e, { ...addr, code })).ok).toBe(true);
  });

  it(`expires after ${EMAIL_CODE_TTL_SECONDS} seconds`, async () => {
    vi.useFakeTimers({ now: T * 1000 });
    const e = env();
    const { code } = await issueEmailCode(e, addr, "p");
    vi.setSystemTime((T + EMAIL_CODE_TTL_SECONDS) * 1000);
    expect((await verifyEmailCode(e, { ...addr, code })).ok).toBe(false);
  });

  it("a new code for the same recipient and flow invalidates the old one", async () => {
    const e = env();
    const first = await issueEmailCode(e, addr, "p1");
    let second = await issueEmailCode(e, addr, "p2");
    while (second.code === first.code)
      second = await issueEmailCode(e, addr, "p2");
    expect((await verifyEmailCode(e, { ...addr, code: first.code })).ok).toBe(
      false,
    );
    expect(await verifyEmailCode(e, { ...addr, code: second.code })).toEqual({
      ok: true,
      payload: "p2",
    });
  });

  it("a code is bound to its product, recipient and flow", async () => {
    const e = env();
    const { code } = await issueEmailCode(e, addr, "p");
    for (const other of [
      { ...addr, product: "acme" },
      { ...addr, recipient: "other@example.com" },
      { ...addr, flowId: "flow-2" },
    ])
      expect((await verifyEmailCode(e, { ...other, code })).ok).toBe(false);
    expect((await verifyEmailCode(e, { ...addr, code })).ok).toBe(true);
  });

  it(`locks the recipient out of new codes for ${EMAIL_LOCKOUT_SECONDS}s after ${EMAIL_LOCKOUT_THRESHOLD} wrong attempts across codes in an hour`, async () => {
    vi.useFakeTimers({ now: T * 1000 });
    const e = env();
    const req = reqFrom("192.0.2.10");
    // Two codes, five wrong guesses each (each code dies at its cap).
    for (const flowId of ["a", "b"]) {
      const flowAddr = { ...addr, flowId };
      const { code } = await issueEmailCode(e, flowAddr, "p");
      const wrong = code === "000000" ? "000001" : "000000";
      for (let i = 0; i < EMAIL_LOCKOUT_THRESHOLD / 2; i++) {
        expect(await emailRecipientLocked(e, "djdl", addr.recipient)).toBe(
          false,
        );
        await verifyEmailCode(e, { ...flowAddr, code: wrong });
      }
    }
    expect(await emailRecipientLocked(e, "djdl", addr.recipient)).toBe(true);
    expect(
      await checkEmailSend(
        e,
        { product: "djdl", recipient: addr.recipient, req },
        T,
      ),
    ).toEqual({ send: false });
    // Another product is unaffected (tenant isolation).
    expect(await emailRecipientLocked(e, "acme", addr.recipient)).toBe(false);
    vi.setSystemTime((T + EMAIL_LOCKOUT_SECONDS) * 1000);
    expect(await emailRecipientLocked(e, "djdl", addr.recipient)).toBe(false);
    expect(
      await checkEmailSend(
        e,
        { product: "djdl", recipient: addr.recipient, req },
        T + EMAIL_LOCKOUT_SECONDS,
      ),
    ).toEqual({ send: true });
  });

  it("wrong attempts spread over more than the window do not lock", async () => {
    vi.useFakeTimers({ now: T * 1000 });
    const e = env();
    const { code } = await issueEmailCode(e, addr, "p");
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < EMAIL_LOCKOUT_THRESHOLD; i++) {
      vi.setSystemTime((T + i * (EMAIL_LOCKOUT_WINDOW_SECONDS / 9 + 1)) * 1000);
      await verifyEmailCode(e, { ...addr, flowId: `f${i}`, code: wrong });
    }
    expect(await emailRecipientLocked(e, "djdl", addr.recipient)).toBe(false);
  });

  it("every refusal has the same shape (no reason leaks)", async () => {
    const e = env();
    const { code } = await issueEmailCode(e, addr, "p");
    const wrong = code === "000000" ? "000001" : "000000";
    const refusals = [
      await verifyEmailCode(e, { ...addr, code: wrong }),
      await verifyEmailCode(e, { ...addr, code: "nonsense" }),
      await verifyEmailCode(e, { ...addr, flowId: "missing", code }),
    ];
    for (const r of refusals) expect(r).toEqual({ ok: false });
  });
});

describe("send side", () => {
  const base = { product: "djdl", recipient: "victim@example.com" };

  it(`allows ${EMAIL_SEND_PER_RECIPIENT_HOUR} sends to one recipient an hour`, async () => {
    const e = env();
    const results: boolean[] = [];
    for (let i = 0; i < EMAIL_SEND_PER_RECIPIENT_HOUR + 1; i++) {
      // A fresh address each time, so only the recipient limit can refuse.
      const r = await checkEmailSend(
        e,
        { ...base, req: reqFrom(`10.0.${i}.1`) },
        T,
      );
      results.push(r.send);
    }
    expect(results).toEqual([
      ...Array<boolean>(EMAIL_SEND_PER_RECIPIENT_HOUR).fill(true),
      false,
    ]);
    // The next hour opens a new hourly window.
    expect(
      (await checkEmailSend(e, { ...base, req: reqFrom("10.9.9.9") }, T + 3600))
        .send,
    ).toBe(true);
  });

  it(`allows ${EMAIL_SEND_PER_RECIPIENT_DAY} sends to one recipient a day`, async () => {
    const e = env();
    // Align to a day boundary so every hour below falls in one daily window.
    const day = Math.floor(T / 86_400) * 86_400;
    let sent = 0;
    for (let hour = 0; hour < 6; hour++) {
      for (let i = 0; i < EMAIL_SEND_PER_RECIPIENT_HOUR; i++) {
        const r = await checkEmailSend(
          e,
          { ...base, req: reqFrom(`10.${hour}.${i}.1`) },
          day + hour * 3600,
        );
        if (r.send) sent++;
      }
    }
    expect(sent).toBe(EMAIL_SEND_PER_RECIPIENT_DAY);
  });

  it("recipient limits are per product", async () => {
    const e = env();
    for (let i = 0; i < EMAIL_SEND_PER_RECIPIENT_HOUR; i++)
      await checkEmailSend(e, { ...base, req: reqFrom(`10.1.${i}.1`) }, T);
    expect(
      (await checkEmailSend(e, { ...base, req: reqFrom("10.2.0.1") }, T)).send,
    ).toBe(false);
    expect(
      (
        await checkEmailSend(
          e,
          { ...base, product: "acme", req: reqFrom("10.2.0.1") },
          T,
        )
      ).send,
    ).toBe(true);
  });

  it(`limits one client address to ${EMAIL_SEND_PER_IP_HOUR} an hour`, async () => {
    const e = env();
    let sent = 0;
    for (let i = 0; i < EMAIL_SEND_PER_IP_HOUR + 3; i++) {
      const r = await checkEmailSend(
        e,
        {
          product: "djdl",
          recipient: `u${i}@example.com`,
          req: reqFrom("198.51.100.7"),
        },
        T,
      );
      if (r.send) sent++;
    }
    expect(sent).toBe(EMAIL_SEND_PER_IP_HOUR);
  });

  it(`limits one network to ${EMAIL_SEND_PER_NETWORK_HOUR} an hour, across its addresses`, async () => {
    const e = env();
    let sent = 0;
    for (let i = 0; i < EMAIL_SEND_PER_NETWORK_HOUR + 5; i++) {
      const r = await checkEmailSend(
        e,
        {
          product: "djdl",
          recipient: `u${i}@example.com`,
          req: reqFrom(`198.51.100.${i + 1}`),
        },
        T,
      );
      if (r.send) sent++;
    }
    expect(sent).toBe(EMAIL_SEND_PER_NETWORK_HOUR);
  });

  it(`limits one device to ${EMAIL_SEND_PER_DEVICE_HOUR} starts an hour`, async () => {
    const e = env();
    let sent = 0;
    for (let i = 0; i < EMAIL_SEND_PER_DEVICE_HOUR + 2; i++) {
      const r = await checkEmailSend(
        e,
        {
          product: "djdl",
          recipient: `u${i}@example.com`,
          req: reqFrom(`10.3.${i}.1`),
          deviceId: "dev-1",
        },
        T,
      );
      if (r.send) sent++;
    }
    expect(sent).toBe(EMAIL_SEND_PER_DEVICE_HOUR);
  });

  it("charges no product cap: the cap is I-18's, at send time, for passthrough mail only", async () => {
    const e = env();
    let sent = 0;
    for (let i = 0; i < 12; i++) {
      const r = await checkEmailSend(
        e,
        {
          product: "djdl",
          recipient: `u${i}@example.com`,
          req: reqFrom(`10.4.${i}.1`),
        },
        T,
      );
      if (r.send) sent++;
    }
    expect(sent).toBe(12);
  });

  it("fails closed when the store is unreachable", async () => {
    const e = env();
    singleUseMock(e).failing = true;
    expect(
      await checkEmailSend(e, { ...base, req: reqFrom("10.6.0.1") }, T),
    ).toEqual({ send: false });
  });
});
