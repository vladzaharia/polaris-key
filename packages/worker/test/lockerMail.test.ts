// LK-07 (plans/LK-00.md §7.11, A3 §14.2/§14.4): operator and member mail takes the Polaris Locker
// sender and lockup ungated; customer mail takes them only while `customer.host` is on, and is
// byte for byte today's output while it is off.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import {
  deliverEmail,
  type OutgoingEmail,
} from "../src/core/notify/emailDelivery.js";
import { renderEmail } from "../src/core/notify/render.js";
import { checkSenderAppName } from "../src/core/notify/emailSender.js";
import { invalidatePlatformSettings } from "../src/core/platformSettings.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";

const API = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";

interface Sent {
  from: { name: string; email: string };
  subject: string;
  text: string;
  html?: string;
}

let db: SqliteDb;
let env: Env;
let sent: Sent[];

beforeEach(() => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), []);
  env.CONSOLE_ORIGIN = API;
  env.CUSTOMER_ORIGIN = CUSTOMER;
  env.EMAIL_SENDER_ADDRESS = "noreply@auth.plrs.im";
  sent = [];
  env.EMAIL = {
    send: async (m: Sent) => {
      sent.push(m);
      return { messageId: "m" };
    },
  } as unknown as Env["EMAIL"];
});

async function setMode(mode: string): Promise<void> {
  await db.run(
    "INSERT OR REPLACE INTO platform_settings (key, value_json, version, updated_at, updated_by) VALUES ('CUSTOMER_HOST', ?, 1, ?, 'test')",
    JSON.stringify(mode),
    NOW,
  );
  invalidatePlatformSettings(env, db);
}

const keyMsg = { subject: "Key", text: "key text", html: "<p>key</p>" };
const lockerMsg = {
  subject: "Locker",
  text: "locker text",
  html: "<p>locker</p>",
};

describe("the sender name", () => {
  it("operator mail is Polaris Locker with the switch off", async () => {
    await deliverEmail(
      env,
      db,
      {
        to: "ops@example.com",
        sender: { kind: "platform", audience: "operator" },
        ...lockerMsg,
      },
      NOW,
    );
    expect(sent[0]!.from).toEqual({
      name: "Polaris Locker",
      email: "noreply@auth.plrs.im",
    });
    expect(sent[0]!.subject).toBe("Locker");
  });

  const customer = (): OutgoingEmail => ({
    to: "a@example.com",
    sender: { kind: "platform" },
    ...keyMsg,
    locker: lockerMsg,
  });

  it("customer mail is Polaris Key and the Key copy while the switch is off", async () => {
    await deliverEmail(env, db, customer(), NOW);
    expect(sent[0]!.from.name).toBe("Polaris Key");
    expect(sent[0]!.subject).toBe("Key");
  });

  it("customer mail is Polaris Locker and the Locker copy once it is on", async () => {
    await setMode("on");
    await deliverEmail(env, db, customer(), NOW);
    expect(sent[0]!.from.name).toBe("Polaris Locker");
    expect(sent[0]!.subject).toBe("Locker");
  });

  it("passthrough mail is '<App> via Polaris Locker' once it is on", async () => {
    const m: OutgoingEmail = {
      to: "a@example.com",
      sender: { kind: "passthrough", product: "acme", displayName: "Acme" },
      ...keyMsg,
    };
    await deliverEmail(env, db, m, NOW);
    expect(sent[0]!.from.name).toBe("Acme via Polaris Key");
    await setMode("on");
    await deliverEmail(env, db, m, NOW);
    expect(sent[1]!.from.name).toBe("Acme via Polaris Locker");
  });

  it("no app may be named Locker", () => {
    expect(checkSenderAppName("Locker")).toEqual({
      ok: false,
      reason: "reserved",
    });
    expect(checkSenderAppName("Locker Room Games").ok).toBe(true);
  });
});

describe("the lockup", () => {
  const base = {
    subject: "S",
    heading: "H",
    paragraphs: ["p"],
    footer: "f",
    origin: API,
  };
  it("is the Key lockup unless brand is locker", () => {
    const html = renderEmail(base);
    expect(html).toContain("/assets/branding/key/key-horizontal-light-944.png");
    expect(html).toContain('alt="Polaris Key"');
    expect(html).not.toContain("Locker");
  });
  it("is the Locker lockup at 230 x 64, light and dark, with neutral actions", () => {
    const html = renderEmail({
      ...base,
      brand: "locker",
      action: { label: "Go", url: `${API}/manage` },
    });
    expect(html).toContain(
      `${API}/assets/branding/locker/locker-horizontal-light-640.png`,
    );
    expect(html).toContain(
      `${API}/assets/branding/locker/locker-horizontal-dark-640.png`,
    );
    expect(html).toContain('width="230" height="64" alt="Polaris Locker"');
    expect(html).not.toContain("Polaris Key");
    expect(html).not.toContain("#9a5cff");
    expect(html).not.toContain("#7a2fff");
  });
  it("falls back to a Locker text wordmark without an origin", () => {
    const html = renderEmail({ ...base, origin: null, brand: "locker" });
    expect(html).toContain(">Polaris Locker</p>");
  });
});
