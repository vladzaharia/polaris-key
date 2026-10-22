// LX-27: a licence created with its own device limit and its key emailed in the same request,
// and send-key (a fresh key, optionally revoking the others, once per 10 minutes).

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW, seedProduct, seedTier } from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { getLicense } from "../src/core/licensing/store.js";
import {
  suppressEmail,
  unsuppressEmail,
} from "../src/core/notify/emailDelivery.js";
import { listAudit } from "../src/core/audit.js";
import {
  licenseInvitationEmail,
  licenseKeyEmail,
} from "../src/core/notify/templates.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { listKeysByLicense } from "../src/core/licensing/store.js";

/** ST-11: a product's own cap is the `email.dailyCap` `product_settings` row. */
async function setProductDailyEmailCap(
  db: Db,
  product: string,
  cap: number | null,
  now: number,
): Promise<void> {
  if (cap === null) {
    await db.run(
      "DELETE FROM product_settings WHERE product = ? AND key = 'email.dailyCap'",
      product,
    );
    return;
  }
  if (!Number.isInteger(cap) || cap <= 0)
    throw new Error("a daily cap is a positive integer");
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
     VALUES (?, 'email.dailyCap', ?, 'console', 1, ?, 'test')
     ON CONFLICT(product, key) DO UPDATE SET value_json = excluded.value_json`,
    product,
    JSON.stringify(cap),
    now,
  );
}

const PLATFORM_GROUP = "admins";

type Sent = {
  to: string;
  subject: string;
  text: string;
  html: string;
  from: { name: string; email: string };
};

describe("create with deviceLimit and delivery, and send-key (LX-27)", () => {
  let db: SqliteDb;
  let env: Env;
  let sent: Sent[];
  let failSend = false;
  let clock = NOW;

  beforeEach(async () => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), ["djdl"]);
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
    sent = [];
    failSend = false;
    clock = NOW;
    env.EMAIL = {
      send: async (m: Sent) => {
        if (failSend) throw new Error("mail down");
        sent.push(m);
      },
    } as unknown as Env["EMAIL"];
    await seedProduct(db, "djdl"); // product default: 5 devices
    await db.run(
      "UPDATE products SET name = ? WHERE slug = ?",
      "Mossgarden",
      "djdl",
    );
    await seedTier(db, "djdl", "pro", { deviceLimit: 3 });
  });

  async function admin(method: string, path: string, body?: unknown) {
    const { token, session } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: [PLATFORM_GROUP] },
      clock,
    );
    return handleAdmin(
      mkReq(
        method,
        {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body,
      ),
      env,
      db,
      `/api/products/djdl/license/licenses${path}`,
      { now: clock },
    );
  }
  const create = (body: Record<string, unknown>) => admin("POST", "", body);
  type Created = {
    licenseId: string;
    key: string;
    delivered?: { email: string };
    license: Record<string, unknown>;
  };

  it("stores deviceLimit at creation and it wins over the tier", async () => {
    const res = await create({ tier: "pro", deviceLimit: 2 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;
    expect((await getLicense(db, "djdl", body.licenseId))!.device_limit).toBe(
      2,
    );
    expect(body.license.effectiveDeviceLimit).toBe(2);
    expect(body.license.deviceLimitSource).toBe("license");
  });

  it("refuses a bad deviceLimit", async () => {
    for (const deviceLimit of [0, 1.5, "3"]) {
      const res = await create({ deviceLimit });
      expect(res.status).toBe(422);
    }
  });

  it("delivery.email sends exactly one email with the key, via Polaris Locker", async () => {
    const res = await create({
      email: "holder@example.com",
      name: "Grace",
      delivery: { email: true },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;
    expect(body.delivered).toEqual({ email: "sent" });
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.to).toBe("holder@example.com");
    expect(m.from.name).toBe("Mossgarden via Polaris Locker");
    expect(m.subject).toBe("Your Mossgarden license");
    expect(m.subject).not.toContain(body.key);
    expect(m.text).toContain(body.key);
    expect(m.html.replaceAll("<wbr>", "")).toContain(body.key);
    expect(m.text).toContain("Hi Grace,");
    expect(m.text).toMatch(
      /Open in Polaris Locker: https?:\/\/[^\s]+\/signin\?product=djdl/,
    );
  });

  it("delivery.email without an email is refused, and creates nothing", async () => {
    const res = await create({ delivery: { email: true } });
    expect(res.status).toBe(422);
    expect(sent).toHaveLength(0);
    const list = (await (await admin("GET", "")).json()) as {
      licenses: unknown[];
    };
    expect(list.licenses).toHaveLength(0);
  });

  it("a failed send keeps the licence and says failed", async () => {
    failSend = true;
    const res = await create({
      email: "holder@example.com",
      delivery: { email: true },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;
    expect(body.delivered).toEqual({
      email: "failed",
      reason: "provider_refused",
    });
    expect(await getLicense(db, "djdl", body.licenseId)).not.toBeNull();
  });

  it("no key appears in an audit row", async () => {
    const created = (await (
      await create({ email: "holder@example.com", delivery: { email: true } })
    ).json()) as Created;
    clock += 1;
    const sk = (await (
      await admin("POST", `/${created.licenseId}/send-key`, {})
    ).json()) as { key: string; hash: string };
    const dump = JSON.stringify(await listAudit(db, "djdl"));
    expect(dump).not.toContain(created.key);
    expect(dump).not.toContain(sk.key);
    expect(dump).not.toContain(sk.hash);
    expect(dump).not.toContain("holder@example.com");
    expect(dump).toContain("license.create");
    expect(dump).toContain("license.key.send");
  });

  it("send-key mints, emails and revokes others on request; once per 10 minutes", async () => {
    const created = (await (
      await create({ email: "holder@example.com" })
    ).json()) as Created;
    const id = created.licenseId;
    const res = await admin("POST", `/${id}/send-key`, { revokeOthers: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      key: string;
      delivered: { email: string };
      revoked: number;
    };
    expect(body.delivered.email).toBe("sent");
    expect(body.revoked).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(body.key);

    const detail = (await (await admin("GET", `/${id}`)).json()) as {
      keys: { status: string; label?: string }[];
    };
    expect(detail.keys.filter((k) => k.status === "active")).toEqual([
      expect.objectContaining({ label: "Sent by email" }),
    ]);

    clock += 60;
    const again = await admin("POST", `/${id}/send-key`, {});
    expect(again.status).toBe(429);
    const limited = (await again.json()) as {
      code: string;
      retryAfter: number;
    };
    expect(limited.code).toBe("rate_limited");
    expect(limited.retryAfter).toBe(540);
    expect(sent).toHaveLength(1);

    clock += 540;
    expect((await admin("POST", `/${id}/send-key`, {})).status).toBe(201);
    expect(sent).toHaveLength(2);
  });

  it("a failed send-key stays retryable at once; the new key stays valid", async () => {
    const created = (await (
      await create({ email: "holder@example.com" })
    ).json()) as Created;
    failSend = true;
    const first = await admin("POST", `/${created.licenseId}/send-key`, {});
    expect(first.status).toBe(201);
    expect(
      ((await first.json()) as { delivered: { email: string } }).delivered
        .email,
    ).toBe("failed");
    failSend = false;
    expect(
      (await admin("POST", `/${created.licenseId}/send-key`, {})).status,
    ).toBe(201);
    expect(sent).toHaveLength(1);
  });

  it("refuses before minting when mail is not configured or the recipient is suppressed", async () => {
    const created = (await (
      await create({ email: "holder@example.com" })
    ).json()) as Created;
    const count = async () =>
      (
        (await (await admin("GET", `/${created.licenseId}`)).json()) as {
          keys: unknown[];
        }
      ).keys.length;
    expect(await count()).toBe(1);
    await suppressEmail(env, db, "holder@example.com", "operator", clock);
    const sup = await admin("POST", `/${created.licenseId}/send-key`, {});
    expect(sup.status).toBe(409);
    expect(await sup.json()).toMatchObject({ reason: "suppressed" });
    await unsuppressEmail(env, db, "holder@example.com");
    const mail = env.EMAIL;
    env.EMAIL = undefined as unknown as Env["EMAIL"];
    const none = await admin("POST", `/${created.licenseId}/send-key`, {});
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ reason: "no_mail_binding" });
    env.EMAIL = mail;
    expect(await count()).toBe(1);
  });

  it("refuses before minting an unusable address, a spent daily cap and an expired licence (409)", async () => {
    const relay = (await (
      await create({ email: "x@privaterelay.appleid.com" })
    ).json()) as Created;
    const r = await admin("POST", `/${relay.licenseId}/send-key`, {});
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: "address_unusable" });

    await setProductDailyEmailCap(db, "djdl", 1, clock);
    const ok = (await (
      await create({ email: "holder@example.com", delivery: { email: true } })
    ).json()) as Created;
    expect(ok.delivered).toEqual({ email: "sent" });
    const capped = await admin("POST", `/${ok.licenseId}/send-key`, {});
    expect(capped.status).toBe(409);
    expect(await capped.json()).toMatchObject({ reason: "daily_cap" });
    await setProductDailyEmailCap(db, "djdl", null, clock);

    await db.run(
      "UPDATE licenses SET expires_at = ? WHERE id = ?",
      clock - 10,
      ok.licenseId,
    );
    const old = await admin("POST", `/${ok.licenseId}/send-key`, {});
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ reason: "license_expired" });
  });

  it("a failed send says why, and a disabled licence is refused (409)", async () => {
    const created = (await (
      await create({ email: "holder@example.com", delivery: { email: true } })
    ).json()) as Created;
    expect(created.delivered).toEqual({ email: "sent" });
    failSend = true;
    const res = await admin("POST", `/${created.licenseId}/send-key`, {});
    expect(((await res.json()) as { delivered: unknown }).delivered).toEqual({
      email: "failed",
      reason: "provider_refused",
    });
    await admin("POST", `/${created.licenseId}/disable`, {});
    const off = await admin("POST", `/${created.licenseId}/send-key`, {});
    expect(off.status).toBe(409);
  });

  it("send-key is refused on a floating licence and on a bad body", async () => {
    const created = (await (await create({})).json()) as Created;
    const res = await admin("POST", `/${created.licenseId}/send-key`, {});
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
    const bad = await admin("POST", `/${created.licenseId}/send-key`, {
      revokeOthers: "yes",
    });
    expect(bad.status).toBe(422);
  });

  // ── LX-27c.1: the invitation ────────────────────────────────────────────────────────────────

  async function identityOn() {
    await db.run(
      "UPDATE products SET services_json = ? WHERE slug = 'djdl'",
      JSON.stringify({
        license: { enabled: true },
        identity: { enabled: true },
      }),
    );
  }
  async function verifiedAccount(email: string) {
    const r = await signIn(
      db,
      { issuerKey: "email", subject: email, kind: "email" },
      clock,
      { unfenced: true, product: { slug: "djdl" } },
    );
    if (r.status !== "signed_in") throw new Error(r.status);
    return r.account.id;
  }
  type Invited = {
    licenseId: string;
    key?: string;
    hash?: string;
    delivered?: { email?: string; invite?: string; reason?: string };
    license: Record<string, unknown>;
  };

  it("invite with key: false mints no key row and sends one email with no key and no address in a URL", async () => {
    await identityOn();
    const res = await create({
      email: "holder@example.com",
      name: "Grace",
      key: false,
      delivery: { invite: true },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Invited;
    expect(body.key).toBeUndefined();
    expect(body.hash).toBeUndefined();
    expect(body.delivered).toEqual({ invite: "sent" });
    expect(await listKeysByLicense(db, "djdl", body.licenseId)).toHaveLength(0);
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.to).toBe("holder@example.com");
    expect(m.subject).toBe("Your Mossgarden license is ready");
    expect(m.from.name).toBe("Mossgarden via Polaris Locker");
    expect(m.text + m.html).not.toContain("pkey_");
    expect(m.text).toContain("Sign in with holder@example.com to use it.");
    const urls = (m.text + m.html).match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    for (const u of urls) {
      expect(u).not.toContain("holder");
      expect(decodeURIComponent(u)).not.toContain("@");
    }
    expect(m.text).toContain("/signin?product=djdl");
    const row = await getLicense(db, "djdl", body.licenseId);
    expect(row!.invited_at).toBe(clock);
    expect(body.license.invitedAt).toBe(clock);
    const audit = (await listAudit(db, "djdl", { limit: 20 })).find(
      (a) => a.action === "license.create",
    )!;
    expect(audit.summary).toContain("invitation sent");
    expect(audit.summary).toContain("no key");
    expect(audit.summary).not.toContain("holder@");
    expect(audit.summary).not.toContain("pkey_");
  });

  it("invite with a key returns it once, mints it, and does not email it", async () => {
    await identityOn();
    const res = await create({
      email: "holder@example.com",
      delivery: { invite: true },
    });
    const body = (await res.json()) as Invited;
    expect(body.key).toMatch(/^pkey_djdl_/);
    expect(await listKeysByLicense(db, "djdl", body.licenseId)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text + sent[0]!.html).not.toContain(body.key!);
    expect(sent[0]!.text + sent[0]!.html).not.toContain("pkey_");
  });

  it("refuses each bad invitation request with 422 and a reason", async () => {
    await identityOn();
    const cases: [Record<string, unknown>, string | undefined, string][] = [
      [{ delivery: { invite: true } }, undefined, "delivery"],
      [
        { email: "a@example.com", delivery: { invite: true, email: true } },
        "email_and_invite",
        "delivery",
      ],
      [
        { email: "a@example.com", key: false },
        "key_false_without_invite",
        "delivery",
      ],
      [
        { email: "a@example.com", key: false, delivery: { email: true } },
        "key_false_without_invite",
        "delivery",
      ],
      [{ email: "a@example.com", key: "no" }, undefined, "key"],
      [
        { email: "a@example.com", delivery: { invite: "yes" } },
        undefined,
        "delivery",
      ],
    ];
    for (const [body, reason, field] of cases) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      const j = (await res.json()) as { reason?: string; fields?: string[] };
      expect(j.fields).toEqual([field]);
      expect(j.reason).toBe(reason);
    }
    expect(sent).toHaveLength(0);
    expect(
      await db.first("SELECT 1 FROM licenses WHERE product = 'djdl'"),
    ).toBeNull();
  });

  it("refuses an invitation when Identity is off or auto-link resolves off, creating nothing", async () => {
    const off = await create({
      email: "a@example.com",
      delivery: { invite: true },
    });
    expect(off.status).toBe(422);
    expect(await off.json()).toMatchObject({
      reason: "identity_off",
      fields: ["delivery"],
    });
    await identityOn();
    await db.run(
      `INSERT INTO oidc_config (product, issuer, client_id, provider)
       VALUES ('djdl', 'https://id.example.com', 'c', 'custom')`,
    );
    const noLink = await create({
      email: "a@example.com",
      delivery: { invite: true },
    });
    expect(noLink.status).toBe(422);
    expect(await noLink.json()).toMatchObject({ reason: "auto_link_off" });
    // The key half is unchanged on such a product.
    expect((await create({ email: "a@example.com" })).status).toBe(201);
    expect(sent).toHaveLength(0);
    expect(
      await db.first(
        "SELECT COUNT(*) AS n FROM licenses WHERE email = 'a@example.com' HAVING n <> 1",
      ),
    ).toBeNull();
  });

  it("a blocked or failed invitation still creates the licence and leaves invited_at empty", async () => {
    await identityOn();
    failSend = true;
    const failed = (await (
      await create({
        email: "a@example.com",
        key: false,
        delivery: { invite: true },
      })
    ).json()) as Invited;
    expect(failed.delivered).toEqual({
      invite: "failed",
      reason: "provider_refused",
    });
    expect(
      (await getLicense(db, "djdl", failed.licenseId))!.invited_at ?? null,
    ).toBeNull();
    failSend = false;
    await suppressEmail(env, db, "b@example.com", "operator", clock);
    const blocked = (await (
      await create({
        email: "b@example.com",
        key: false,
        delivery: { invite: true },
      })
    ).json()) as Invited;
    expect(blocked.delivered).toEqual({
      invite: "failed",
      reason: "suppressed",
    });
    expect(blocked.license.invitedAt).toBeNull();
    env.EMAIL = undefined;
    const none = (await (
      await create({
        email: "c@example.com",
        key: false,
        delivery: { invite: true },
      })
    ).json()) as Invited;
    expect(none.delivered).toEqual({
      invite: "failed",
      reason: "no_mail_binding",
    });
    expect(await getLicense(db, "djdl", none.licenseId)).not.toBeNull();
  });

  it("association at creation still runs, and the answer and email are identical with and without an account", async () => {
    await identityOn();
    const accountId = await verifiedAccount("ada@example.com");
    const req = (email: string) =>
      create({ email, name: "Ada", key: false, delivery: { invite: true } });
    const withAccount = (await (
      await req("ada@example.com")
    ).json()) as Invited;
    const without = (await (await req("zed@example.com")).json()) as Invited;
    expect(
      (await getLicense(db, "djdl", withAccount.licenseId))!.account_id,
    ).toBe(accountId);
    expect(
      (await getLicense(db, "djdl", without.licenseId))!.account_id ?? null,
    ).toBeNull();
    const norm = (b: Invited, email: string) =>
      JSON.stringify(b, (k, v) =>
        k === "licenseId" || k === "id" ? "ID" : v,
      ).replaceAll(email, "ADDR");
    expect(norm(withAccount, "ada@example.com")).toBe(
      norm(without, "zed@example.com"),
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]!.html.replaceAll("ada@example.com", "ADDR")).toBe(
      sent[1]!.html.replaceAll("zed@example.com", "ADDR"),
    );
    expect(sent[0]!.text.replaceAll("ada@example.com", "ADDR")).toBe(
      sent[1]!.text.replaceAll("zed@example.com", "ADDR"),
    );
    expect(withAccount.license.holder).toEqual({
      kind: "assigned",
      inAccount: false,
      email: "ada@example.com",
    });
  });

  it("the licence list's first page says whether invitations are on, and why not", async () => {
    const first = async () =>
      (
        (await (await admin("GET", "")).json()) as {
          holders?: { invitations: boolean; invitationsOff: string | null };
        }
      ).holders;
    expect(await first()).toEqual({
      invitations: false,
      invitationsOff: "identity_off",
    });
    await identityOn();
    expect(await first()).toEqual({ invitations: true, invitationsOff: null });
    await db.run(
      `INSERT INTO oidc_config (product, issuer, client_id, provider)
       VALUES ('djdl', 'https://id.example.com', 'c', 'custom')`,
    );
    expect(await first()).toEqual({
      invitations: false,
      invitationsOff: "auto_link_off",
    });

    // No mail binding: an invitation could not go out, so none is offered (B1).
    await db.run("DELETE FROM oidc_config");
    env.EMAIL = undefined;
    expect(await first()).toEqual({
      invitations: false,
      invitationsOff: "no_mail",
    });
  });

  it("the invitation names a long address in full, breakably, and strips control characters", () => {
    const long42 = "nour.alhuda.the.very.long.name@studio-harbour.example";
    const long90 = `${"abcdefghij".repeat(6)}@${"studio".repeat(4)}.example`;
    for (const address of [long42, long90, `a\u202Eb@x.io\u0007`]) {
      const m = licenseInvitationEmail({
        productName: "Mossgarden",
        holderName: null,
        address,
        signInUrl: "https://key.plrs.im/signin?product=djdl",
        origin: "https://key.plrs.im",
      });
      const shown = address.replace(/[\u0000-\u001f\u202e]/g, "");
      expect(m.text).toContain(`Sign in with ${shown} to use it.`);
      expect(m.html).toContain(shown);
      expect(m.html).toContain("overflow-wrap:anywhere");
      expect({ address: shown, text: m.text }).toMatchSnapshot();
    }
    // No product name: neutral copy, not "Your app license".
    expect(
      licenseInvitationEmail({
        productName: null,
        holderName: null,
        address: "a@b.io",
        signInUrl: "https://key.plrs.im/signin",
        origin: "https://key.plrs.io",
      }).text,
    ).toContain("Your license is ready.");
  });

  it("invitation template snapshots: created and assigned, with and without a name and a download", () => {
    const base = {
      productName: "Mossgarden",
      address: "grace@example.com",
      signInUrl: "https://key.plrs.im/signin?product=djdl",
      origin: "https://key.plrs.im",
    };
    const variants = {
      createdNamedDownload: licenseInvitationEmail({
        ...base,
        holderName: "Grace",
        downloadUrl: "https://key.plrs.im/#/p/djdl/download",
        context: "created",
      }),
      createdAnonymous: licenseInvitationEmail({
        ...base,
        holderName: null,
        context: "created",
      }),
      assignedNamed: licenseInvitationEmail({
        ...base,
        holderName: "Grace",
        context: "assigned",
      }),
      assignedDownload: licenseInvitationEmail({
        ...base,
        holderName: null,
        downloadUrl: "https://key.plrs.im/#/p/djdl/download",
        context: "assigned",
      }),
    };
    for (const [name, m] of Object.entries(variants)) {
      expect({ name, subject: m.subject, text: m.text }).toMatchSnapshot();
      expect(m.html, name).toMatchSnapshot();
      expect(m.text + m.html).not.toContain("pkey_");
    }
  });

  it("template snapshot", () => {
    const m = licenseKeyEmail({
      productName: "Mossgarden",
      holderName: "Grace",
      key: "pkey_djdl_EXAMPLEKEY",
      signInUrl: "https://key.plrs.im/signin?product=djdl",
      downloadUrl: "https://key.plrs.im/#/p/djdl/download",
      origin: "https://key.plrs.im",
    });
    expect({ subject: m.subject, text: m.text }).toMatchSnapshot();
    expect(m.html).toMatchSnapshot();
  });
});
