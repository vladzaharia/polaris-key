// LK-07 (plans/LK-00.md §7.11, A3 §14.2; hard cutover, owner direction 2026-10-19): customer mail
// is Polaris Locker (sender, copy, lockup); operator and member mail stays Polaris Key.
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
  newDeviceSignInNotice,
  type NoticeMessage,
} from "../src/core/notify/templates.js";
import { sendMagicLink, sendSignInEmail } from "../src/core/notify/send.js";
import { checkSenderAppName } from "../src/core/notify/emailSender.js";
import type { Env } from "../src/platform/env.js";

const API = "https://key.plrs.im";

interface Sent {
  from: { name: string; email: string };
  subject: string;
  text: string;
  html?: string;
}

let env: Env;
let sent: Sent[];

beforeEach(() => {
  env = makeEnv(new KvMock(), []);
  env.CONSOLE_ORIGIN = API;
  env.EMAIL_SENDER_ADDRESS = "noreply@auth.plrs.im";
  sent = [];
  env.EMAIL = {
    send: async (m: Sent) => {
      sent.push(m);
      return { messageId: "m" };
    },
  } as unknown as Env["EMAIL"];
});

const msg = { subject: "S", text: "t", html: "<p>h</p>" };

describe("the sender name", () => {
  it("customer mail is Polaris Locker from the same address", async () => {
    const db = makeTestDb();
    const m: OutgoingEmail = {
      to: "a@example.com",
      sender: { kind: "platform" },
      ...msg,
    };
    await deliverEmail(env, db, m, NOW);
    expect(sent[0]!.from).toEqual({
      name: "Polaris Locker",
      email: "noreply@auth.plrs.im",
    });
  });

  it("operator and member mail stays Polaris Key", async () => {
    const m: OutgoingEmail = {
      to: "ops@example.com",
      sender: { kind: "platform", audience: "operator" },
      ...msg,
    };
    await deliverEmail(env, makeTestDb(), m, NOW);
    expect(sent[0]!.from.name).toBe("Polaris Key");
  });

  it("passthrough mail is '<App> via Polaris Locker'", async () => {
    const m: OutgoingEmail = {
      to: "a@example.com",
      sender: { kind: "passthrough", product: "acme", displayName: "Acme" },
      ...msg,
    };
    await deliverEmail(env, makeTestDb(), m, NOW);
    expect(sent[0]!.from.name).toBe("Acme via Polaris Locker");
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
  it("is the Key lockup unless brand is locker (operator mail)", () => {
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

describe("customer templates", () => {
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

  it("say Polaris Locker and never Polaris Key", () => {
    for (const [name, m] of Object.entries(msgs())) {
      expect(m.subject + m.text + m.html, name).not.toContain("Polaris Key");
      // The product-hero key mail shows no platform lockup unless it has a second link.
      if (name !== "keyEmail")
        expect(m.html, name).toContain(
          "/assets/branding/locker/locker-horizontal-light-640.png",
        );
    }
    expect(
      Object.fromEntries(
        Object.entries(msgs()).map(([k, m]) => [
          k,
          { subject: m.subject, text: m.text },
        ]),
      ),
    ).toMatchSnapshot();
  });

  it("the sign-in code and link mails are Polaris Locker end to end", async () => {
    const db = makeTestDb();
    await sendSignInEmail(
      env,
      db,
      "a@example.com",
      { code: "123456", link: `${API}/magic`, purpose: "signin" },
      NOW,
    );
    expect(sent[0]!.from.name).toBe("Polaris Locker");
    expect(sent[0]!.subject).toBe("Your Polaris Locker code: 123456");
    expect(sent[0]!.html).toContain('alt="Polaris Locker"');
    await sendMagicLink(env, db, "a@example.com", `${API}/magic`, NOW);
    expect(sent[1]!.subject).toBe("Sign in to Polaris Locker");
  });
});
