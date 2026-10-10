import { describe, expect, it } from "vitest";
import {
  deliverEmail,
  emailSuppressed,
  HARD_BOUNCE_SUPPRESSION_SECONDS,
  productDailyEmailCap,
  recordDeliveryEvent,
  setProductDailyEmailCap,
  suppressEmail,
  unsuppressEmail,
  type OutgoingEmail,
} from "../src/core/emailDelivery.js";
import {
  EMAIL_SEND_PRODUCT_DAILY_DEFAULT,
  recipientHash,
} from "../src/core/emailLimits.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";

// I-18: the one send choke point. No test sends real email: the binding is a recorder (or a
// thrower standing in for Cloudflare's refusals).

interface Sent {
  from: { name: string; email: string };
  to: string;
  subject: string;
}

function setup(opts: { throwCode?: string } = {}): {
  env: Env;
  db: Db;
  sent: Sent[];
} {
  const env = makeEnv(new KvMock(), []);
  env.KEY_HASH_PEPPER = "email-delivery-pepper";
  env.EMAIL_SENDER_ADDRESS = "noreply@auth.plrs.im";
  const sent: Sent[] = [];
  env.EMAIL = {
    send: async (m: Sent) => {
      if (opts.throwCode)
        throw Object.assign(new Error("refused"), { code: opts.throwCode });
      sent.push(m);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as Env["EMAIL"];
  return { env, db: makeTestDb(), sent };
}

const platform = (to: string): OutgoingEmail => ({
  to,
  subject: "Sign in to Polaris Key",
  text: "code 123456",
  sender: { kind: "platform" },
});
const passthrough = (to: string, product = "acme"): OutgoingEmail => ({
  to,
  subject: "Your Acme code",
  text: "code 123456",
  sender: { kind: "passthrough", product, displayName: "Acme Games" },
});

describe("senders", () => {
  it("platform mail goes out as 'Polaris Key' from the shared address", async () => {
    const { env, db, sent } = setup();
    expect(await deliverEmail(env, db, platform("a@example.com"), NOW)).toEqual(
      { ok: true },
    );
    expect(sent[0]!.from).toEqual({
      name: "Polaris Key",
      email: "noreply@auth.plrs.im",
    });
  });

  it("passthrough mail goes out as '<App> via Polaris Key'", async () => {
    const { env, db, sent } = setup();
    await deliverEmail(env, db, passthrough("a@example.com"), NOW);
    expect(sent[0]!.from.name).toBe("Acme Games via Polaris Key");
  });

  it("a product whose name and slug are both reserved sends nothing", async () => {
    const { env, db, sent } = setup();
    const msg: OutgoingEmail = {
      ...passthrough("a@example.com"),
      sender: {
        kind: "passthrough",
        product: "polaris-tools",
        displayName: "Polaris Security",
      },
    };
    expect(await deliverEmail(env, db, msg, NOW)).toEqual({
      ok: false,
      reason: "email_unavailable",
    });
    expect(sent).toHaveLength(0);
  });

  it("no binding answers email_unavailable", async () => {
    const { env, db } = setup();
    env.EMAIL = undefined;
    expect(await deliverEmail(env, db, platform("a@example.com"), NOW)).toEqual(
      { ok: false, reason: "email_unavailable" },
    );
  });
});

describe("suppression", () => {
  it("a suppressed address is never sent to, platform or passthrough", async () => {
    const { env, db, sent } = setup();
    await suppressEmail(env, db, "Gone@Example.com", "complaint", NOW);
    for (const msg of [
      platform("gone@example.com"),
      passthrough(" GONE@example.com "),
    ])
      expect(await deliverEmail(env, db, msg, NOW)).toEqual({
        ok: false,
        reason: "suppressed",
      });
    expect(sent).toHaveLength(0);
    // Other recipients are unaffected.
    expect(await deliverEmail(env, db, platform("b@example.com"), NOW)).toEqual(
      { ok: true },
    );
  });

  it("stores only the peppered hash, never the address", async () => {
    const { env, db } = setup();
    await suppressEmail(env, db, "secret.person@example.com", "operator", NOW);
    const rows = await db.all<Record<string, unknown>>(
      "SELECT * FROM email_suppressions",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/secret|example/);
  });

  it("a hard bounce expires; a complaint does not; a bounce never shortens a complaint", async () => {
    const { env, db } = setup();
    await recordDeliveryEvent(
      env,
      db,
      { type: "hard_bounce", recipient: "b@example.com" },
      NOW,
    );
    expect(await emailSuppressed(env, db, "b@example.com", NOW)).toBe(true);
    expect(
      await emailSuppressed(
        env,
        db,
        "b@example.com",
        NOW + HARD_BOUNCE_SUPPRESSION_SECONDS + 1,
      ),
    ).toBe(false);

    await recordDeliveryEvent(
      env,
      db,
      { type: "complaint", recipient: "c@example.com" },
      NOW,
    );
    await recordDeliveryEvent(
      env,
      db,
      { type: "hard_bounce", recipient: "c@example.com" },
      NOW + 10,
    );
    expect(
      await emailSuppressed(env, db, "c@example.com", NOW + 10 * 365 * 86_400),
    ).toBe(true);
    const row = await db.first<{ reason: string; expires_at: number | null }>(
      "SELECT reason, expires_at FROM email_suppressions WHERE address_hash = ?",
      await recipientHash(env, "c@example.com"),
    );
    expect(row).toEqual({ reason: "complaint", expires_at: null });

    // A soft bounce changes nothing; an operator can clear an entry.
    await recordDeliveryEvent(
      env,
      db,
      { type: "soft_bounce", recipient: "s@example.com" },
      NOW,
    );
    expect(await emailSuppressed(env, db, "s@example.com", NOW)).toBe(false);
    await unsuppressEmail(env, db, "c@example.com");
    expect(await emailSuppressed(env, db, "c@example.com", NOW)).toBe(false);
  });

  it("Cloudflare's E_RECIPIENT_SUPPRESSED is recorded and answers suppressed", async () => {
    const { env, db, sent } = setup({ throwCode: "E_RECIPIENT_SUPPRESSED" });
    expect(await deliverEmail(env, db, platform("x@example.com"), NOW)).toEqual(
      { ok: false, reason: "suppressed" },
    );
    expect(sent).toHaveLength(0);
    expect(await emailSuppressed(env, db, "x@example.com", NOW)).toBe(true);
  });

  it("fails closed when the list cannot be read", async () => {
    const { env, sent } = setup();
    const broken = {
      first: async () => {
        throw new Error("D1 down");
      },
    } as unknown as Db;
    expect(
      await deliverEmail(env, broken, platform("a@example.com"), NOW),
    ).toEqual({ ok: false, reason: "email_unavailable" });
    expect(sent).toHaveLength(0);
  });
});

describe("per-product caps", () => {
  it("a capped product gets email_unavailable; other products and platform mail are untouched", async () => {
    const { env, db, sent } = setup();
    await setProductDailyEmailCap(db, "acme", 3, NOW);
    const results = [];
    for (let i = 0; i < 5; i++)
      results.push(
        await deliverEmail(env, db, passthrough(`u${i}@example.com`), NOW),
      );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.slice(3)).toEqual([
      { ok: false, reason: "email_unavailable" },
      { ok: false, reason: "email_unavailable" },
    ]);
    // Another tenant's budget is its own.
    expect(
      await deliverEmail(env, db, passthrough("v@example.com", "other"), NOW),
    ).toEqual({ ok: true });
    // Platform mail is never capped (D21/D23 notices included).
    for (let i = 0; i < 5; i++)
      expect(
        await deliverEmail(env, db, platform(`p${i}@example.com`), NOW),
      ).toEqual({ ok: true });
    expect(sent).toHaveLength(3 + 1 + 5);
  });

  it("a suppressed recipient spends no cap", async () => {
    const { env, db } = setup();
    await setProductDailyEmailCap(db, "acme", 1, NOW);
    await suppressEmail(env, db, "gone@example.com", "complaint", NOW);
    await deliverEmail(env, db, passthrough("gone@example.com"), NOW);
    expect(
      await deliverEmail(env, db, passthrough("ok@example.com"), NOW),
    ).toEqual({ ok: true });
  });

  it("resolves row, then var, then the operational default", async () => {
    const { env, db } = setup();
    expect(await productDailyEmailCap(env, db, "acme")).toBe(
      EMAIL_SEND_PRODUCT_DAILY_DEFAULT,
    );
    env.EMAIL_PRODUCT_DAILY_CAP = "250";
    expect(await productDailyEmailCap(env, db, "acme")).toBe(250);
    env.EMAIL_PRODUCT_DAILY_CAP = "-1";
    expect(await productDailyEmailCap(env, db, "acme")).toBe(
      EMAIL_SEND_PRODUCT_DAILY_DEFAULT,
    );
    await setProductDailyEmailCap(db, "acme", 40, NOW);
    expect(await productDailyEmailCap(env, db, "acme")).toBe(40);
    await setProductDailyEmailCap(db, "acme", null, NOW);
    expect(await productDailyEmailCap(env, db, "acme")).toBe(
      EMAIL_SEND_PRODUCT_DAILY_DEFAULT,
    );
    await expect(setProductDailyEmailCap(db, "acme", 0, NOW)).rejects.toThrow();
  });
});

describe("provider failures and Apple private relay", () => {
  it("every other provider refusal answers email_unavailable, never throws", async () => {
    for (const code of [
      "E_DAILY_LIMIT_EXCEEDED",
      "E_RATE_LIMIT_EXCEEDED",
      "E_SENDER_NOT_VERIFIED",
      "E_INTERNAL_SERVER_ERROR",
      undefined,
    ]) {
      const { env, db } = setup({ throwCode: code ?? "" });
      if (code === undefined)
        env.EMAIL = {
          send: async () => {
            throw new Error("network");
          },
        } as unknown as Env["EMAIL"];
      expect(
        await deliverEmail(env, db, platform("a@example.com"), NOW),
      ).toEqual({ ok: false, reason: "email_unavailable" });
      expect(await emailSuppressed(env, db, "a@example.com", NOW)).toBe(false);
    }
  });

  it("relay recipients wait for the owner's Apple registration", async () => {
    const { env, db, sent } = setup();
    const relay = "abc123@privaterelay.appleid.com";
    expect(await deliverEmail(env, db, platform(relay), NOW)).toEqual({
      ok: false,
      reason: "email_unavailable",
    });
    expect(sent).toHaveLength(0);
    env.EMAIL_APPLE_RELAY = "registered";
    expect(await deliverEmail(env, db, platform(relay), NOW)).toEqual({
      ok: true,
    });
    expect(sent[0]!.to).toBe(relay);
  });
});

describe("only a bare addr-spec is mailed", () => {
  it("refuses a display-name wrapped recipient before the provider", async () => {
    const { env, db, sent } = await (async () => {
      const sent: unknown[] = [];
      const env = makeEnv(new KvMock(), []);
      env.KEY_HASH_PEPPER = "p";
      (env as { EMAIL?: unknown }).EMAIL = {
        send: async (m: unknown) => void sent.push(m),
      };
      return { env, db: await makeTestDb(), sent };
    })();
    const r = await deliverEmail(
      env,
      db,
      {
        to: "Name<victim@example.com>",
        subject: "s",
        text: "t",
        sender: { kind: "platform" },
      } as OutgoingEmail,
      NOW,
    );
    expect(r).toEqual({ ok: false, reason: "email_unavailable" });
    expect(sent).toHaveLength(0);
  });
});
