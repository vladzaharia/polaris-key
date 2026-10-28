// LX-27c.2: POST …/licenses/<id>/send-invite. Resends the invitation to a waiting licence, mints
// nothing, shares send-key's 10-minute window, and keeps the address out of the audit.

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, mkReq, NOW, seedProduct } from "../../seed.js";
import type { SqliteDb } from "../../../src/db/sqlite.js";
import type { Env } from "../../../src/platform/env.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import {
  getLicense,
  listKeysByLicense,
} from "../../../src/core/licensing/store.js";
import { suppressEmail } from "../../../src/core/notify/emailDelivery.js";
import { listAudit } from "../../../src/core/audit.js";
import { signIn } from "../../../src/services/identity/accounts/signIn.js";

const PLATFORM_GROUP = "admins";
type Sent = { to: string; subject: string; text: string; html: string };

describe("send-invite (LX-27c.2)", () => {
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
    await seedProduct(db, "djdl");
    await db.run(
      "UPDATE products SET name = 'Mossgarden', services_json = ? WHERE slug = 'djdl'",
      JSON.stringify({
        license: { enabled: true },
        identity: { enabled: true },
      }),
    );
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
  async function waiting(email = "holder@example.com"): Promise<string> {
    const res = await admin("POST", "", { email, name: "Grace" });
    return ((await res.json()) as { licenseId: string }).licenseId;
  }
  const invite = (id: string, body: unknown = {}) =>
    admin("POST", `/${id}/send-invite`, body);

  it("sends one invitation, mints nothing and stamps invited_at", async () => {
    const id = await waiting();
    const keys = (await listKeysByLicense(db, "djdl", id)).length;
    const res = await invite(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: { invite: "sent" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("holder@example.com");
    expect(sent[0]!.subject).toBe("Your Mossgarden license is ready");
    expect(sent[0]!.text).toContain("your invitation was sent again");
    expect(sent[0]!.text + sent[0]!.html).not.toContain("pkey_");
    expect(await listKeysByLicense(db, "djdl", id)).toHaveLength(keys);
    expect((await getLicense(db, "djdl", id))!.invited_at).toBe(clock);
  });

  it("context assigned words the footer; another context is a 422", async () => {
    const id = await waiting();
    expect((await invite(id, { context: "assigned" })).status).toBe(200);
    expect(sent[0]!.text).toContain("a license was assigned to this address");
    const id2 = await waiting("b@example.com");
    expect((await invite(id2, { context: "x" })).status).toBe(422);
  });

  it("a failed send says why, leaves invited_at empty and frees the window", async () => {
    const id = await waiting();
    failSend = true;
    const res = await invite(id);
    expect(await res.json()).toEqual({
      delivered: { invite: "failed", reason: "provider_refused" },
    });
    expect((await getLicense(db, "djdl", id))!.invited_at ?? null).toBeNull();
    failSend = false;
    const again = await invite(id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { delivered: unknown }).delivered).toEqual({
      invite: "sent",
    });
  });

  it("two concurrent sends claim the window atomically: one sends, one is refused (SEND-CLAIM)", async () => {
    const id = await waiting();
    const keys = (await listKeysByLicense(db, "djdl", id)).length;
    const [a, b] = await Promise.all([
      invite(id),
      admin("POST", `/${id}/send-key`, {}),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200 === a.status ? 200 : 201, 429].sort());
    expect(sent).toHaveLength(1);
    const loser = a.status === 429 ? a : b;
    expect(((await loser.json()) as { code?: string }).code).toBe(
      "rate_limited",
    );
    // A refused send-key mints nothing.
    const minted = (await listKeysByLicense(db, "djdl", id)).length - keys;
    expect(minted).toBe(b.status === 201 ? 1 : 0);
  });

  it("many concurrent invitations send exactly one", async () => {
    const id = await waiting();
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => invite(id)));
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    expect(all.filter((r) => r.status === 429)).toHaveLength(4);
    expect(sent).toHaveLength(1);
  });

  it("allows one a window per licence, 429 with retryAfter, shared with send-key", async () => {
    const id = await waiting();
    expect((await invite(id)).status).toBe(200);
    clock += 100;
    const limited = await invite(id);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: "rate_limited" },
      retryAfter: 500,
    });
    expect(limited.headers.get("retry-after")).toBe("500");
    // send-key is held by the invitation's window.
    expect((await admin("POST", `/${id}/send-key`, {})).status).toBe(429);
    clock += 500;
    expect((await invite(id)).status).toBe(200);
    // And an invitation is held by a key send.
    clock += 601;
    expect((await admin("POST", `/${id}/send-key`, {})).status).toBe(201);
    expect((await invite(id)).status).toBe(429);
  });

  it("a failed key send frees an invitation too", async () => {
    const id = await waiting();
    failSend = true;
    await admin("POST", `/${id}/send-key`, {});
    failSend = false;
    expect((await invite(id)).status).toBe(200);
  });

  it("refuses a floating licence (400) and one in an account (409 in_account)", async () => {
    const floating = (await (await admin("POST", "", {})).json()) as {
      licenseId: string;
    };
    expect((await invite(floating.licenseId)).status).toBe(400);
    const r = await signIn(
      db,
      { issuerKey: "email", subject: "ada@example.com", kind: "email" },
      clock,
      { unfenced: true, product: { slug: "djdl" } },
    );
    if (r.status !== "signed_in") throw new Error(r.status);
    const id = await waiting("ada@example.com");
    expect((await getLicense(db, "djdl", id))!.account_id).toBe(r.account.id);
    const res = await invite(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "in_account" });
    expect(sent).toHaveLength(0);
  });

  it("refuses each 409 reason before sending", async () => {
    const id = await waiting();
    await db.run(
      "UPDATE licenses SET expires_at = ? WHERE id = ?",
      clock - 5,
      id,
    );
    let res = await invite(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "license_expired" });
    await db.run("UPDATE licenses SET expires_at = NULL WHERE id = ?", id);
    await admin("POST", `/${id}/disable`, {});
    res = await invite(id);
    expect(await res.json()).toMatchObject({ reason: "license_not_active" });
    await admin("POST", `/${id}/enable`, {});

    await suppressEmail(env, db, "holder@example.com", "operator", clock);
    expect(await (await invite(id)).json()).toMatchObject({
      reason: "suppressed",
    });
    await db.run("DELETE FROM email_suppressions");
    await db.run(
      "UPDATE licenses SET email = 'not-an-address' WHERE id = ?",
      id,
    );
    expect(await (await invite(id)).json()).toMatchObject({
      reason: "address_unusable",
    });
    await db.run(
      "UPDATE licenses SET email = 'holder@example.com' WHERE id = ?",
      id,
    );
    await db.run(
      `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
       VALUES ('djdl', 'email.dailyCap', '1', 'console', 1, ?, 'test')`,
      clock,
    );
    await db.run("DELETE FROM email_suppressions");
    await invite(id); // spends the cap
    clock += 700;
    expect(await (await invite(id)).json()).toMatchObject({
      reason: "daily_cap",
    });
    await db.run("DELETE FROM product_settings WHERE key = 'email.dailyCap'");
    const sentBefore = sent.length;
    env.EMAIL = undefined;
    expect(await (await invite(id)).json()).toMatchObject({
      reason: "no_mail_binding",
    });
    expect(sent.length).toBe(sentBefore);
  });

  it("refuses when Identity is off or auto-link resolves off", async () => {
    const id = await waiting();
    await db.run(
      `INSERT INTO oidc_config (product, issuer, client_id, provider)
       VALUES ('djdl', 'https://id.example.com', 'c', 'custom')`,
    );
    expect(await (await invite(id)).json()).toMatchObject({
      reason: "auto_link_off",
    });
    await db.run("DELETE FROM oidc_config");
    await db.run(
      "UPDATE products SET services_json = ? WHERE slug = 'djdl'",
      JSON.stringify({
        license: { enabled: true },
        identity: { enabled: false },
      }),
    );
    expect(await (await invite(id)).json()).toMatchObject({
      reason: "identity_off",
    });
    expect(sent).toHaveLength(0);
  });

  it("the audit rows carry the id and outcome, never the address", async () => {
    const id = await waiting("secret.person@example.com");
    await invite(id);
    failSend = true;
    clock += 700;
    await invite(id);
    const rows = (await listAudit(db, "djdl", { limit: 50 })).filter((a) =>
      a.action.startsWith("license.invite.send"),
    );
    expect(rows.map((r) => r.action).sort()).toEqual([
      "license.invite.send",
      "license.invite.send",
      "license.invite.send.failed",
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret.person");
    expect(JSON.stringify(rows)).not.toContain("pkey_");
  });
});
