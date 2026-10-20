// LK-07 (plans/LK-00.md §7.11, A3 §14.2): customer mail takes the Polaris Locker sender, copy and
// lockup only while `customer.host` is on, and is byte for byte today's output while it is off.
// Operator and member mail (the Polaris Key console side, owner direction 2026-10-19) stays Key.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import {
  deliverEmail,
  type OutgoingEmail,
} from "../src/core/notify/emailDelivery.js";
import { renderEmail } from "../src/core/notify/render.js";
import {
  accountDeletedNotice,
  licenseAddedNotice,
  licenseKeyEmail,
  lockerVariantOf,
  newDeviceSignInNotice,
  type NoticeMessage,
} from "../src/core/notify/templates.js";
import { sendMagicLink, sendSignInEmail } from "../src/core/notify/send.js";
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
  it("operator mail stays Polaris Key in either state", async () => {
    const m: OutgoingEmail = {
      to: "ops@example.com",
      sender: { kind: "platform", audience: "operator" },
      ...keyMsg,
      locker: lockerMsg,
    };
    await deliverEmail(env, db, m, NOW);
    await setMode("on");
    await deliverEmail(env, db, m, NOW);
    expect(sent.map((x) => [x.from.name, x.subject])).toEqual([
      ["Polaris Key", "Key"],
      ["Polaris Key", "Key"],
    ]);
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

describe("customer templates in both brands", () => {
  const origin = API;
  const msgs = (): Record<string, NoticeMessage> => ({
    added: licenseAddedNotice({
      productName: "Mossgarden",
      productSlug: "mossgarden",
      origin,
    }),
    newDevice: newDeviceSignInNotice({
      deviceLabel: "Studio PC",
      location: "Lisbon, Portugal",
      at: 1_800_000_000,
      origin,
    }),
    deleted: accountDeletedNotice({ origin }),
    keyEmail: licenseKeyEmail({
      productName: "Mossgarden",
      holderName: "Ada",
      key: "pkey_abc",
      signInUrl: `${origin}/signin?product=mossgarden`,
      origin,
    }),
  });

  it("the returned message is the Polaris Key one", () => {
    for (const [name, m] of Object.entries(msgs())) {
      if (name !== "keyEmail") expect(m.html).toContain('alt="Polaris Key"');
      expect(m.html).not.toContain("Locker");
      expect(m.subject + m.text).not.toContain("Locker");
    }
  });

  it("each has a Polaris Locker variant with no Polaris Key in it", () => {
    for (const [name, m] of Object.entries(msgs())) {
      const l = lockerVariantOf(m);
      expect(l, name).toBeDefined();
      expect(l!.subject + l!.text + l!.html, name).not.toContain("Polaris Key");
      // The product-hero key mail shows no platform lockup unless it has a second link.
      if (name !== "keyEmail")
        expect(l!.html, name).toContain(
          "/assets/branding/locker/locker-horizontal-light-640.png",
        );
    }
    expect(
      Object.fromEntries(
        Object.entries(msgs()).map(([k, m]) => [
          k,
          {
            subject: lockerVariantOf(m)!.subject,
            text: lockerVariantOf(m)!.text,
          },
        ]),
      ),
    ).toMatchSnapshot();
  });

  it("the sign-in code and link mails follow the switch end to end", async () => {
    await sendSignInEmail(
      env,
      db,
      "a@example.com",
      { code: "123456", link: `${API}/magic`, purpose: "signin" },
      NOW,
    );
    expect(sent[0]!.from.name).toBe("Polaris Key");
    expect(sent[0]!.subject).toBe("Your Polaris Key code: 123456");
    await setMode("on");
    await sendSignInEmail(
      env,
      db,
      "a@example.com",
      { code: "123456", link: `${API}/magic`, purpose: "signin" },
      NOW,
    );
    expect(sent[1]!.from.name).toBe("Polaris Locker");
    expect(sent[1]!.subject).toBe("Your Polaris Locker code: 123456");
    expect(sent[1]!.html).toContain('alt="Polaris Locker"');
    await sendMagicLink(env, db, "a@example.com", `${API}/magic`, NOW);
    expect(sent[2]!.subject).toBe("Sign in to Polaris Locker");
  });
});
