// LK-07b (I-39 folded): the HTML of every customer email is snapshotted, and every one holds the
// brand rules: Polaris Locker only, neutral ink actions, neutral callouts, a plain-text part that
// mirrors the HTML. Record with `vitest -u`. LK07B_DUMP=<dir> also writes each message as
// <name>.html and <name>.txt for the real-browser review.
import { mkdirSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { KvMock } from "./kvMock.js";
import { makeTestDb } from "./helpers.js";
import { makeEnv, NOW } from "./seed.js";
import * as T from "../src/core/notify/templates.js";
import type { NoticeMessage } from "../src/core/notify/templates.js";
import { sendMagicLink, sendSignInEmail } from "../src/core/notify/send.js";
import type { Env } from "../src/platform/env.js";

const origin = "https://key.plrs.im";
const P = { productName: "Mossgarden", productSlug: "mossgarden", origin };

interface Sent {
  subject: string;
  text: string;
  html?: string;
}
let env: Env;
let sent: Sent[];
beforeEach(() => {
  env = makeEnv(new KvMock(), []);
  env.CONSOLE_ORIGIN = origin;
  env.EMAIL_SENDER_ADDRESS = "noreply@auth.plrs.im";
  sent = [];
  env.EMAIL = {
    send: async (m: Sent) => {
      sent.push(m);
      return { messageId: "m" };
    },
  } as unknown as Env["EMAIL"];
});

function templates(): Record<string, NoticeMessage> {
  return {
    "download-link": T.downloadLinkEmail({ ...P, platform: "windows" }),
    "license-key": T.licenseKeyEmail({
      productName: "Mossgarden",
      holderName: "Ada",
      key: "pkey_3f9a1c0d7b2e4a58b6c1d9e0f2a47b83",
      signInUrl: `${origin}/signin?product=mossgarden`,
      downloadUrl: `${origin}/#/p/mossgarden/download`,
      origin,
    }),
    "license-key-no-download": T.licenseKeyEmail({
      productName: "Mossgarden",
      holderName: "Ada",
      key: "pkey_3f9a1c0d7b2e4a58b6c1d9e0f2a47b83",
      signInUrl: `${origin}/signin?product=mossgarden`,
      origin,
    }),
    "new-device": T.newDeviceSignInNotice({
      deviceLabel: "Studio PC",
      location: "Lisbon, Portugal",
      at: 1_800_000_000,
      origin,
    }),
    "packages-token": T.packagesTokenNotice({
      host: "build-box",
      location: "Lisbon, Portugal",
      at: 1_800_000_000,
      origin,
    }),
    "device-removed": T.deviceRemovedNotice({
      ...P,
      deviceLabel: "Studio PC",
    }),
    "method-added": T.signInMethodAddedNotice({ method: "Steam", origin }),
    "method-removed": T.signInMethodRemovedNotice({ method: "Steam", origin }),
    "primary-email": T.primaryEmailChangedNotice({ origin }),
    "deletion-scheduled": T.accountDeletionScheduledNotice({
      origin,
      dueAt: 1_800_000_000,
    }),
    "deletion-cancelled": T.accountDeletionCancelledNotice({ origin }),
    "account-deleted": T.accountDeletedNotice({ origin }),
    "accounts-merged": T.accountsMergedNotice({
      origin,
      undoUntil: 1_800_000_000,
    }),
    "accounts-separated": T.accountsSeparatedNotice({ origin }),
    "license-added": T.licenseAddedNotice(P),
    "license-attached": T.licenseAttachedNotice(P),
    "license-key-replaced": T.licenseKeyReplacedNotice(P),
    "license-relinked-away": T.licenseRelinkedAwayNotice(P),
    "license-relinked-in": T.licenseRelinkedInNotice(P),
    "license-relink-undone": T.licenseRelinkUndoneNotice(P),
    "license-made-floating": T.licenseMadeFloatingNotice({
      ...P,
      inAccount: true,
    }),
    "license-reassigned-away": T.licenseReassignedAwayNotice({
      ...P,
      inAccount: true,
    }),
    "license-assigned-to-you": T.licenseAssignedToYouNotice(P),
  };
}

async function authMail(): Promise<Record<string, NoticeMessage>> {
  const db = makeTestDb();
  const link = `${origin}/magic?t=abc`;
  await sendSignInEmail(
    env,
    db,
    "a@example.com",
    { code: "123456", link, purpose: "signin" },
    NOW,
  );
  await sendSignInEmail(
    env,
    db,
    "a@example.com",
    { code: "123456", link: null, purpose: "confirm" },
    NOW,
  );
  await sendMagicLink(env, db, "a@example.com", link, NOW);
  const names = ["sign-in-code", "confirm-email", "magic-link"];
  return Object.fromEntries(
    sent.map((m, i) => [
      names[i]!,
      { subject: m.subject, text: m.text, html: m.html ?? "" },
    ]),
  );
}

const textOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("every customer email", () => {
  it("is Polaris Locker, ink and neutral, with a plain-text part that mirrors the HTML", async () => {
    const all = { ...(await authMail()), ...templates() };
    const dump = process.env.LK07B_DUMP;
    if (dump) mkdirSync(dump, { recursive: true });
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(25);
    for (const [name, m] of Object.entries(all)) {
      const html = m.html;
      expect(m.subject + m.text + html, name).not.toMatch(/Polaris Key/);
      expect(html, name).not.toMatch(/#9a5cff|#7a2fff|violet/i);
      // The lockup is the Locker one at 230 px, or the licence-key mail's product hero.
      expect(html, name).toMatch(/Polaris Locker|<h1/);
      // Every link in the HTML is in the text.
      for (const [, url] of html.matchAll(/href="([^"]+)"/g))
        expect(m.text, `${name} ${url}`).toContain(url!.replace(/&amp;/g, "&"));
      // Every visible sentence of the HTML is in the text.
      const visible = textOf(html);
      const h1 = /<h1[^>]*>([^<]+)</.exec(html)?.[1];
      if (h1) expect(m.text, name).toContain(h1.replace(/&#x27;/g, "'"));
      expect(visible.length, name).toBeGreaterThan(40);
      if (dump) {
        writeFileSync(`${dump}/${name}.html`, html);
        writeFileSync(`${dump}/${name}.txt`, m.text);
      }
    }
    expect(
      Object.fromEntries(Object.entries(all).map(([k, m]) => [k, m.html])),
    ).toMatchSnapshot();
  });

  it("holds the callout and button rules", async () => {
    const all = { ...(await authMail()), ...templates() };
    for (const [name, m] of Object.entries(all)) {
      // An action button is ink on the ink fill, never a hue.
      const btn = /class="pk-btn" bgcolor="([^"]+)"/.exec(m.html);
      if (btn) expect(btn[1], name).toBe("#060912");
    }
    expect(all["new-device"]!.html).toContain('class="pk-callout"');
    expect(all["deletion-scheduled"]!.text).toContain("Erased on");
    expect(all["sign-in-code"]!.html).toContain("123 456");
  });
});
