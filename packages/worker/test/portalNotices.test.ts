/**
 * PX-W7: the portal's emails (docs/design/PORTAL.md §6.3; gaps G15c, G18, G23).
 *
 * Three layers: the templates' copy is pinned by snapshot (subject and plain text for every
 * template, full HTML for one plain and one security notice), the rules every template must
 * hold are asserted directly (named "Polaris Key", never "portal"; product names and device
 * labels, never ids; deep links into the app, never tokens; "Wasn't you?" exactly on the
 * security notices), and the handlers are driven end to end for who receives what.
 */

import { issuePortalSessionRow } from "./portalSessionRow.js";
import { describe, expect, it } from "vitest";
import { THEME_TOKENS } from "@polaris-key/brand";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import { handlePortalApi } from "./portalHarness.js";
import {
  linkEmail,
  getOrCreateAccountByEmail,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../src/services/identity/portal/session.js";
import {
  NOTICE_VALUE_MAX,
  accountDeletedNotice,
  appLink,
  deviceRemovedNotice,
  displayValue,
  downloadLinkEmail,
  licenseAddedNotice,
  newDeviceSignInNotice,
  signInMethodAddedNotice,
  signInMethodRemovedNotice,
  type NoticeMessage,
} from "../src/services/identity/portal/notices.js";
import {
  securityNoticeRecipients,
  sendSecurityNotice,
} from "../src/services/identity/portal/email.js";
import { EMAIL_DOWNLOAD_PER_HOUR } from "../src/services/identity/portal/api.js";

const ORIGIN = "https://key.plrs.im";

const TEMPLATES: Record<string, () => NoticeMessage> = {
  licenseAdded: () =>
    licenseAddedNotice({
      productName: "Mossgarden",
      productSlug: "mossgarden",
      origin: ORIGIN,
    }),
  downloadLink: () =>
    downloadLinkEmail({
      productName: "Mossgarden",
      productSlug: "mossgarden",
      platform: "macos",
      origin: ORIGIN,
    }),
  deviceRemoved: () =>
    deviceRemovedNotice({
      deviceLabel: "Studio PC",
      productName: "Tidewater Studio",
      productSlug: "tidewater",
      origin: ORIGIN,
    }),
  newDeviceSignIn: () =>
    newDeviceSignInNotice({
      deviceLabel: "Mara's MacBook Pro",
      location: "Lisbon, Portugal",
      origin: ORIGIN,
    }),
  methodAdded: () =>
    signInMethodAddedNotice({ method: "Steam", origin: ORIGIN }),
  methodRemoved: () =>
    signInMethodRemovedNotice({ method: "Steam", origin: ORIGIN }),
  accountDeleted: () => accountDeletedNotice({ origin: ORIGIN }),
};

const SECURITY = new Set([
  "deviceRemoved",
  "newDeviceSignIn",
  "methodAdded",
  "methodRemoved",
]);

describe("notice templates: copy", () => {
  for (const [name, build] of Object.entries(TEMPLATES)) {
    it(`${name}: subject and plain text`, () => {
      const m = build();
      expect({ subject: m.subject, text: m.text }).toMatchSnapshot();
    });
  }

  it("full HTML of a plain notice and a security notice", () => {
    expect(TEMPLATES.licenseAdded!().html).toMatchSnapshot();
    expect(TEMPLATES.methodRemoved!().html).toMatchSnapshot();
  });

  it("uses the subjects PORTAL.md §6.3 names", () => {
    expect(TEMPLATES.licenseAdded!().subject).toBe(
      "Mossgarden is in your library",
    );
    expect(TEMPLATES.deviceRemoved!().subject).toBe(
      "Studio PC was removed from Tidewater Studio",
    );
    expect(TEMPLATES.methodRemoved!().subject).toBe(
      "Steam was disconnected from your Polaris Key account",
    );
    expect(TEMPLATES.newDeviceSignIn!().subject).toBe(
      "A new device signed in to Polaris Key",
    );
  });
});

describe("notice templates: rules", () => {
  for (const [name, build] of Object.entries(TEMPLATES)) {
    it(`${name}: "Polaris Key", never "portal"; branded and dark-mode safe`, () => {
      const m = build();
      for (const part of [m.subject, m.text, m.html]) {
        expect(part).not.toMatch(/portal/i);
      }
      expect(`${m.text}\n${m.html}`).toContain("Polaris Key");
      expect(m.html).toContain(
        '<meta name="color-scheme" content="light dark">',
      );
      expect(m.html).toContain("@media (prefers-color-scheme: dark)");
      expect(m.html).toContain(THEME_TOKENS.dark.surface.page);
      expect(m.html).toContain(
        `${ORIGIN}/assets/branding/key/key-horizontal-light-944.png`,
      );
      expect(m.html).not.toMatch(/<script|\son\w+=|powered by/i);
    });

    it(`${name}: "Wasn't you?" only on security notices`, () => {
      const m = build();
      const secure = SECURITY.has(name);
      expect(m.text.includes("Wasn't you? Secure your account")).toBe(secure);
      expect(m.html.includes("Wasn&#x27;t you?")).toBe(secure);
      if (secure) {
        expect(m.text).toContain(`${ORIGIN}/#/account/methods`);
        expect(m.text).toContain("every verified email on the account");
      }
    });
  }

  it("deep-links to the exact section, with no credential in the link", () => {
    const urls = (m: NoticeMessage) => m.text.match(/https:\/\/\S+/g) ?? [];
    expect(urls(TEMPLATES.licenseAdded!())).toEqual([
      `${ORIGIN}/#/p/mossgarden`,
    ]);
    expect(urls(TEMPLATES.downloadLink!())).toEqual([
      `${ORIGIN}/#/p/mossgarden/download?platform=macos`,
    ]);
    expect(urls(TEMPLATES.deviceRemoved!())[0]).toBe(
      `${ORIGIN}/#/p/tidewater/devices`,
    );
    expect(urls(TEMPLATES.methodAdded!())[0]).toBe(
      `${ORIGIN}/#/account/methods`,
    );
    expect(urls(TEMPLATES.newDeviceSignIn!())[0]).toBe(
      `${ORIGIN}/#/account/sessions`,
    );
    expect(urls(TEMPLATES.accountDeleted!())).toEqual([]);
    for (const build of Object.values(TEMPLATES)) {
      expect(build().text).not.toMatch(/token|pkey_/i);
    }
  });

  it("names the platform for people, and the slug only inside the link", () => {
    const m = TEMPLATES.downloadLink!();
    expect(m.subject).toBe("Download Mossgarden for macOS");
    expect(m.text.replace(/https:\/\/\S+/g, "")).not.toContain("mossgarden");
  });

  it("escapes and bounds display values from apps and operators", () => {
    const hostile = deviceRemovedNotice({
      deviceLabel: "PC\r\nBcc: victim@example.com <img src=x onerror=alert(1)>",
      productName: "Evil\u202egnp.exe",
      productSlug: "evil",
      origin: ORIGIN,
    });
    expect(hostile.subject).not.toMatch(/[\r\n\u202e]/);
    expect(hostile.html).not.toContain("<img src=x");
    expect(hostile.html).toContain("&lt;img src=x");
    expect(hostile.html).not.toContain("\u202e");
  });

  it("displayValue: controls out, length bounded, fallback when empty", () => {
    expect(displayValue("  Studio\tPC   ", "x")).toBe("Studio PC");
    expect(displayValue("\u202e\u0007", "A device")).toBe("A device");
    expect(displayValue(null, "A device")).toBe("A device");
    const long = displayValue("a".repeat(200), "x");
    expect(Array.from(long)).toHaveLength(NOTICE_VALUE_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  it("falls back to plain words without a label or a name", () => {
    expect(
      deviceRemovedNotice({
        deviceLabel: null,
        productName: null,
        productSlug: "x",
        origin: ORIGIN,
      }).subject,
    ).toBe("A device was removed from your product");
    expect(appLink(ORIGIN, "account")).toBe(`${ORIGIN}/#/account`);
  });
});

// ── Delivery ─────────────────────────────────────────────────────────────────────────────────

type Sent = {
  to: string;
  subject: string;
  text: string;
  from: { name: string; email: string };
};

function portalEnv(): { env: Env; sent: Sent[] } {
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  const sent: Sent[] = [];
  env.EMAIL = {
    send: async (m: Sent) => {
      sent.push(m);
    },
  } as unknown as Env["EMAIL"];
  return { env, sent };
}

function req(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[PORTAL_CSRF_HEADER] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`${ORIGIN}${path}`, init) as unknown as Request;
}

async function session(env: Env, db: Db, email = "ada@example.com") {
  const account = await getOrCreateAccountByEmail(db, email, NOW);
  const { token, session: s } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  return {
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: s.csrf,
    accountId: account.id,
  };
}

async function namedProduct(db: Db, release = true): Promise<void> {
  await seedProduct(db, "djdl");
  await db.run(
    "UPDATE products SET name = ? WHERE slug = ?",
    "DJ Download",
    "djdl",
  );
  if (release) {
    await setServices(
      db,
      "djdl",
      serializeServices({
        services: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: true },
          distribution: { enabled: true },
          update: { enabled: false },
          identity: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
  }
}

describe("security notices reach every verified address", () => {
  it("de-duplicates case-insensitively and sends one message per address", async () => {
    const db = makeTestDb();
    const { env, sent } = portalEnv();
    const s = await session(env, db);
    await linkEmail(db, s.accountId, "ada.work@example.com", NOW);
    expect(
      await securityNoticeRecipients(db, s.accountId, "ADA@example.com"),
    ).toHaveLength(2);
    const n = await sendSecurityNotice(
      env,
      db,
      s.accountId,
      "ada@example.com",
      signInMethodRemovedNotice({ method: "Steam", origin: ORIGIN }),
      NOW,
    );
    expect(n).toBe(2);
    expect(sent.map((m) => m.to).sort()).toEqual([
      "ada.work@example.com",
      "ada@example.com",
    ]);
    // Platform mail, From "Polaris Key" (core/emailSender.ts platformSender, I-18).
    for (const m of sent)
      expect(m.from).toEqual({ name: "Polaris Key", email: "noreply@plrs.im" });
  });

  it("device removal: label and product name, to every verified address", async () => {
    const db = makeTestDb();
    const { env, sent } = portalEnv();
    await namedProduct(db, false);
    const { licenseId } = await seedLicenseWithKey(db, "djdl");
    const s = await session(env, db);
    await linkEmail(db, s.accountId, "ada.work@example.com", NOW);
    await db.run(
      `INSERT INTO devices (product, device_id, license_id, status, label, first_seen, last_seen)
       VALUES (?, ?, ?, 'authorized', ?, ?, ?)`,
      "djdl",
      "dev-1",
      licenseId,
      "Studio PC",
      NOW,
      NOW,
    );
    const path = `/api/licenses/djdl/${licenseId}/devices/dev-1`;
    const res = await handlePortalApi(
      req("DELETE", path, { cookie: s.cookie, csrf: s.csrf }),
      env,
      db,
      path,
      NOW,
    );
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.to).sort()).toEqual([
      "ada.work@example.com",
      "ada@example.com",
    ]);
    expect(sent[0]!.subject).toBe("Studio PC was removed from DJ Download");
    expect(sent[0]!.text).toContain(`${ORIGIN}/#/p/djdl/devices`);
    expect(sent[0]!.text).not.toContain("dev-1");
  });

  it("license added by key: the product's name, linked to its page", async () => {
    const db = makeTestDb();
    const { env, sent } = portalEnv();
    await namedProduct(db, false);
    // The licence carries ada@example.com; claimByKey lets another address add it (PX-W5).
    await upsertPortalProductSettings(db, "djdl", { claimByKey: true }, NOW);
    const { key } = await seedLicenseWithKey(db, "djdl");
    const s = await session(env, db, "someone@example.com");
    const res = await handlePortalApi(
      req("POST", "/api/claim/license-key", {
        cookie: s.cookie,
        csrf: s.csrf,
        body: { key },
      }),
      env,
      db,
      "/api/claim/license-key",
      NOW,
    );
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.to).sort()).toEqual([
      "ada@example.com",
      "someone@example.com",
    ]);
    const added = sent.find((m) => m.to === "someone@example.com")!;
    expect(added.subject).toBe("DJ Download is in your library");
    expect(added.text).toContain(`${ORIGIN}/#/p/djdl`);
    // S-16: the licence's own address hears about it, without learning which account.
    const owner = sent.find((m) => m.to === "ada@example.com")!;
    expect(owner.subject).toBe(
      "Your DJ Download license was added to a Polaris Key account",
    );
    expect(owner.text).not.toContain("someone@example.com");
    for (const m of sent) expect(m.text).not.toContain(key);
  });

  it("account deletion: every verified address, and no 'portal' in the copy", async () => {
    const db = makeTestDb();
    const { env, sent } = portalEnv();
    const s = await session(env, db);
    await linkEmail(db, s.accountId, "ada.work@example.com", NOW);
    const res = await handlePortalApi(
      req("DELETE", "/api/me", { cookie: s.cookie, csrf: s.csrf }),
      env,
      db,
      "/api/me",
      NOW,
    );
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.to).sort()).toEqual([
      "ada.work@example.com",
      "ada@example.com",
    ]);
    expect(sent[0]!.subject).toBe("Your Polaris Key account has been deleted");
    expect(`${sent[0]!.subject}${sent[0]!.text}`).not.toMatch(/portal/i);
  });

  it("account deletion: a failed send never blocks it, and the others still go out", async () => {
    const db = makeTestDb();
    const { env, sent } = portalEnv();
    const send = env.EMAIL!.send.bind(env.EMAIL);
    env.EMAIL = {
      send: async (m: Sent) => {
        if (m.to === "ada.work@example.com") throw new Error("mail down");
        return send(m as never);
      },
    } as unknown as Env["EMAIL"];
    const s = await session(env, db);
    await linkEmail(db, s.accountId, "ada.work@example.com", NOW);
    const res = await handlePortalApi(
      req("DELETE", "/api/me", { cookie: s.cookie, csrf: s.csrf }),
      env,
      db,
      "/api/me",
      NOW,
    );
    expect(res.status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["ada@example.com"]);
  });
});

describe("POST /api/products/:product/email-download (G23)", () => {
  const path = "/api/products/djdl/email-download";

  async function setup(release = true) {
    const db = makeTestDb();
    const { env, sent } = portalEnv();
    await namedProduct(db, release);
    await seedLicenseWithKey(db, "djdl");
    const s = await session(env, db);
    const call = (body: unknown = { platform: "windows" }, csrf = s.csrf) =>
      handlePortalApi(
        req("POST", path, { cookie: s.cookie, csrf, body }),
        env,
        db,
        path,
        NOW,
      );
    return { db, env, sent, s, call };
  }

  it("mails the account's own address a deep link, never a token", async () => {
    const { sent, call } = await setup();
    const res = await call();
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ada@example.com");
    expect(sent[0]!.subject).toBe("Download DJ Download for Windows");
    expect(sent[0]!.text.match(/https:\/\/\S+/g)).toEqual([
      `${ORIGIN}/#/p/djdl/download?platform=windows`,
    ]);
  });

  it("refuses an unknown platform", async () => {
    const { sent, call } = await setup();
    expect((await call({ platform: "amiga" })).status).toBe(422);
    expect((await call({})).status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it("404 when the product does not run Release", async () => {
    const { sent, call } = await setup(false);
    expect((await call()).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ["releases_enabled", 1, 0],
    ["portal_enabled", 0, 1],
  ] as const)(
    "404 when the product's %s is off",
    async (_flag, portal, releases) => {
      const { db, sent, call } = await setup();
      await db.run(
        `INSERT INTO portal_product_settings
           (product, portal_enabled, oidc_enabled, magic_enabled,
            license_key_claim_enabled, releases_enabled, branding_json, created_at, modified_at)
         VALUES (?, ?, 1, 1, 1, ?, NULL, ?, ?)`,
        "djdl",
        portal,
        releases,
        NOW,
        NOW,
      );
      expect((await call()).status).toBe(404);
      expect(sent).toHaveLength(0);
    },
  );

  it("404 without a license for the product, and for an unknown product", async () => {
    const { env, db, sent } = await setup();
    const other = await session(env, db, "stranger@example.com");
    const res = await handlePortalApi(
      req("POST", path, {
        cookie: other.cookie,
        csrf: other.csrf,
        body: { platform: "windows" },
      }),
      env,
      db,
      path,
      NOW,
    );
    expect(res.status).toBe(404);
    const missing = "/api/products/nope/email-download";
    const res2 = await handlePortalApi(
      req("POST", missing, {
        cookie: other.cookie,
        csrf: other.csrf,
        body: { platform: "windows" },
      }),
      env,
      db,
      missing,
      NOW,
    );
    expect(res2.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("needs the CSRF header, a session and POST", async () => {
    const { env, db, call } = await setup();
    expect((await call(undefined, "wrong")).status).toBe(403);
    const anon = await handlePortalApi(
      req("POST", path, { body: { platform: "windows" } }),
      env,
      db,
      path,
      NOW,
    );
    expect(anon.status).toBe(401);
  });

  it("503 when email is not configured", async () => {
    const { env, call } = await setup();
    env.EMAIL = undefined;
    expect((await call()).status).toBe(503);
  });

  it(`stops after ${EMAIL_DOWNLOAD_PER_HOUR} an hour`, async () => {
    const { sent, call } = await setup();
    for (let i = 0; i < EMAIL_DOWNLOAD_PER_HOUR; i++) {
      expect((await call()).status).toBe(202);
    }
    expect((await call()).status).toBe(429);
    expect(sent).toHaveLength(EMAIL_DOWNLOAD_PER_HOUR);
  });
});
