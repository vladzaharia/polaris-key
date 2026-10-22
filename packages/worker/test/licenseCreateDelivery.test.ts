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
import { ADMIN_COOKIE, CSRF_HEADER } from "../src/core/console/session.js";
import { getLicense } from "../src/core/licensing/store.js";
import {
  suppressEmail,
  unsuppressEmail,
} from "../src/core/notify/emailDelivery.js";
import { listAudit } from "../src/core/audit.js";
import { licenseKeyEmail } from "../src/core/notify/templates.js";
import { consoleTestSession } from "./consoleSessionHelper.js";

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
    const { token, session } = await consoleTestSession(
      env,
      db,
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
