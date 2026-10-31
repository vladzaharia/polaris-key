/**
 * DEVICE-REMOVAL: the account's licence-less devices (`GET /api/me/devices`) and removing one
 * (`DELETE /api/me/devices/<p>/<deviceId>`). Each rule has a test that fails without it.
 */
import { describe, expect, it } from "vitest";
import { issuePortalSessionRow } from "../../portalSessionRow.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "../../seed.js";
import type { Env } from "../../../src/platform/env.js";
import type { Db } from "../../../src/db/types.js";
import { getOrCreateAccountByEmail } from "../../../src/services/identity/portal/repo.js";
import { handlePortalApi } from "../../portalHarness.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../../../src/services/identity/portal/session.js";
import {
  RESTORE_ORIGIN_SECONDS,
  markRestoreOrigin,
  mintRestoreKey,
} from "../../../src/services/identity/restore/store.js";
import { setPortalToggles } from "../../seed.js";

const SECRET = "test-portal-session-secret";

interface Ctx {
  env: Env;
  db: Db;
  sent: Array<{ to: string; text: string }>;
}

async function ctx(): Promise<Ctx> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl", "other"]);
  env.PORTAL_SESSION_SECRET = SECRET;
  const sent: Ctx["sent"] = [];
  env.EMAIL = {
    send: async (m: { to: string; text: string }) => {
      sent.push(m);
    },
  } as unknown as Env["EMAIL"];
  await seedProduct(db, "djdl");
  await seedProduct(db, "other");
  return { env, db, sent };
}

async function session(c: Ctx, email: string) {
  const account = await getOrCreateAccountByEmail(c.db, email, NOW);
  const { token, session: row } = await issuePortalSessionRow(
    c.env,
    c.db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  return {
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: row.csrf,
    accountId: account.id,
  };
}

async function bind(c: Ctx, accountId: string, product: string, sub: string) {
  await c.db.run(
    "INSERT INTO account_product_subjects (account_id, product, subject, created_at) VALUES (?, ?, ?, ?)",
    accountId,
    product,
    sub,
    NOW,
  );
}

async function device(
  c: Ctx,
  product: string,
  id: string,
  subject: string,
  opts: { license?: string; label?: string; status?: string } = {},
) {
  await c.db.run(
    `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, label, platform)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'android')`,
    product,
    id,
    opts.license ?? "",
    opts.status ?? "authorized",
    NOW,
    NOW,
    subject,
    opts.label ?? `Phone ${id}`,
  );
}

const origin = (c: Ctx, id: string, subject: string, now = NOW) =>
  markRestoreOrigin(c.db, { product: "djdl", deviceId: id, subject, now });

const mint = (c: Ctx, id: string) =>
  mintRestoreKey(c.env, c.db, {
    product: "djdl",
    deviceId: id,
    subject: "sub-ada",
    boundSubject: "sub-ada",
    now: NOW,
  });

async function adaWithMine(c: Ctx) {
  const ada = await session(c, "ada@example.com");
  await bind(c, ada.accountId, "djdl", "sub-ada");
  await device(c, "djdl", "mine", "sub-ada");
  return ada;
}

async function twoAccounts(c: Ctx) {
  const ada = await session(c, "ada@example.com");
  const eve = await session(c, "eve@example.com");
  await bind(c, ada.accountId, "djdl", "sub-ada");
  await bind(c, eve.accountId, "djdl", "sub-eve");
  return { ada, eve };
}

function call(
  c: Ctx,
  s: { cookie: string; csrf: string },
  method: string,
  path: string,
  csrf = true,
) {
  const headers: Record<string, string> = { cookie: s.cookie };
  if (csrf) headers[PORTAL_CSRF_HEADER] = s.csrf;
  return handlePortalApi(
    new Request(`https://key.plrs.im${path}`, {
      method,
      headers,
    }) as unknown as Request,
    c.env,
    c.db,
    path,
    NOW,
  );
}

const status = (c: Ctx, product: string, id: string) =>
  c.db.first<{ status: string }>(
    "SELECT status FROM devices WHERE product = ? AND device_id = ?",
    product,
    id,
  );

const restoreRows = (c: Ctx, product: string) =>
  c.db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identity_restore_keys WHERE product = ?",
    product,
  );

describe("GET /api/me/devices", () => {
  it("lists only the caller's own licence-less authorized devices, with the backup badge", async () => {
    const c = await ctx();
    const { ada } = await twoAccounts(c);
    await device(c, "djdl", "mine", "sub-ada");
    await device(c, "djdl", "restored", "sub-ada");
    await origin(c, "restored", "sub-ada", NOW);
    await device(c, "djdl", "gone", "sub-ada", { status: "deauthorized" });
    await device(c, "djdl", "licensed", "sub-ada", { license: "lic_1" });
    await device(c, "djdl", "eves", "sub-eve");
    await origin(c, "eves", "sub-eve", NOW);

    const res = await call(c, ada, "GET", "/api/me/devices", false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      devices: Array<{ deviceId: string; restored: boolean; label: string }>;
    };
    expect(body.devices.map((d) => d.deviceId).sort()).toEqual([
      "mine",
      "restored",
    ]);
    expect(body.devices.find((d) => d.deviceId === "restored")!.restored).toBe(
      true,
    );
    expect(body.devices.find((d) => d.deviceId === "mine")!.restored).toBe(
      false,
    );
    // The other account's mark never shows in this account's list.
    expect(JSON.stringify(body)).not.toContain("eves");
  });

  it("drops the badge once the origin mark is older than 270 days", async () => {
    const c = await ctx();
    const ada = await session(c, "ada@example.com");
    await bind(c, ada.accountId, "djdl", "sub-ada");
    await device(c, "djdl", "old", "sub-ada");
    await origin(c, "old", "sub-ada", NOW - RESTORE_ORIGIN_SECONDS - 1);
    const res = await call(c, ada, "GET", "/api/me/devices", false);
    const body = (await res.json()) as {
      devices: Array<{ restored: boolean }>;
    };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]!.restored).toBe(false);
  });

  it("needs a session", async () => {
    const c = await ctx();
    const res = await handlePortalApi(
      new Request("https://key.plrs.im/api/me/devices") as unknown as Request,
      c.env,
      c.db,
      "/api/me/devices",
      NOW,
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/me/devices/<product>/<deviceId>", () => {
  it("removes the caller's licence-less device, audits it and emails the account", async () => {
    const c = await ctx();
    const ada = await session(c, "ada@example.com");
    await bind(c, ada.accountId, "djdl", "sub-ada");
    await device(c, "djdl", "mine", "sub-ada", { label: "Pixel 9" });
    const res = await call(c, ada, "DELETE", "/api/me/devices/djdl/mine");
    expect(res.status).toBe(200);
    expect((await status(c, "djdl", "mine"))!.status).toBe("deauthorized");
    const audit = await c.db.first<{ target_id: string }>(
      "SELECT target_id FROM portal_audit WHERE account_id = ? AND action = 'portal.device.disconnect'",
      ada.accountId,
    );
    expect(audit?.target_id).toBe("mine");
    expect(c.sent.length).toBeGreaterThan(0);
    expect(c.sent.some((m) => m.text.includes("Pixel 9"))).toBe(true);
  });

  it("answers 404 for another account's device and leaves it", async () => {
    const c = await ctx();
    const { ada } = await twoAccounts(c);
    await device(c, "djdl", "eves", "sub-eve");
    const res = await call(c, ada, "DELETE", "/api/me/devices/djdl/eves");
    expect(res.status).toBe(404);
    expect((await status(c, "djdl", "eves"))!.status).toBe("authorized");
  });

  it("answers 404 for a licence-bound device, even the caller's own", async () => {
    const c = await ctx();
    const ada = await session(c, "ada@example.com");
    await bind(c, ada.accountId, "djdl", "sub-ada");
    await seedLicenseWithKey(c.db, "djdl");
    await device(c, "djdl", "licensed", "sub-ada", { license: "lic_1" });
    const res = await call(c, ada, "DELETE", "/api/me/devices/djdl/licensed");
    expect(res.status).toBe(404);
    expect((await status(c, "djdl", "licensed"))!.status).toBe("authorized");
    // No removal ran: no audit row (the sweep's own "licence linked" mail is not ours).
    expect(
      await c.db.first(
        "SELECT 1 AS x FROM portal_audit WHERE action = 'portal.device.disconnect'",
      ),
    ).toBeNull();
  });

  it("answers 404 for a product the caller has no subject in, and for an unknown device", async () => {
    const c = await ctx();
    const ada = await session(c, "ada@example.com");
    await bind(c, ada.accountId, "djdl", "sub-ada");
    await device(c, "other", "x", "sub-ada");
    expect(
      (await call(c, ada, "DELETE", "/api/me/devices/other/x")).status,
    ).toBe(404);
    expect(
      (await call(c, ada, "DELETE", "/api/me/devices/djdl/nope")).status,
    ).toBe(404);
  });

  it("hides the product and answers 404 while its portal is off", async () => {
    const c = await ctx();
    const ada = await adaWithMine(c);
    await setPortalToggles(c.db, "djdl", { portalEnabled: false });
    const list = await call(c, ada, "GET", "/api/me/devices", false);
    expect(((await list.json()) as { devices: unknown[] }).devices).toEqual([]);
    expect(
      (await call(c, ada, "DELETE", "/api/me/devices/djdl/mine")).status,
    ).toBe(404);
    expect((await status(c, "djdl", "mine"))!.status).toBe("authorized");
  });

  it("refuses a request without the CSRF header", async () => {
    const c = await ctx();
    const ada = await adaWithMine(c);
    const res = await call(
      c,
      ada,
      "DELETE",
      "/api/me/devices/djdl/mine",
      false,
    );
    expect(res.status).toBe(403);
    expect((await status(c, "djdl", "mine"))!.status).toBe("authorized");
  });

  it("removing a device that signed in by restore deletes every restore key of the account", async () => {
    const c = await ctx();
    const ada = await session(c, "ada@example.com");
    await bind(c, ada.accountId, "djdl", "sub-ada");
    await device(c, "djdl", "restored", "sub-ada");
    await device(c, "djdl", "other-dev", "sub-ada");
    for (const d of ["restored", "other-dev"])
      expect(await mint(c, d)).not.toBeNull();
    await origin(c, "restored", "sub-ada", NOW);
    expect((await restoreRows(c, "djdl"))!.n).toBe(2);
    const res = await call(c, ada, "DELETE", "/api/me/devices/djdl/restored");
    expect(res.status).toBe(200);
    expect((await restoreRows(c, "djdl"))!.n).toBe(0);
    // The other device itself stays signed in.
    expect((await status(c, "djdl", "other-dev"))!.status).toBe("authorized");
  });

  it("removing an ordinary device keeps the other restore keys", async () => {
    const c = await ctx();
    const ada = await session(c, "ada@example.com");
    await bind(c, ada.accountId, "djdl", "sub-ada");
    await device(c, "djdl", "plain", "sub-ada");
    await device(c, "djdl", "keeper", "sub-ada");
    for (const d of ["plain", "keeper"]) await mint(c, d);
    await call(c, ada, "DELETE", "/api/me/devices/djdl/plain");
    expect((await restoreRows(c, "djdl"))!.n).toBe(1);
  });

  it("shares the licence Remove's budget: the 21st removal in a minute is 429", async () => {
    const c = await ctx();
    const ada = await session(c, "ada@example.com");
    await bind(c, ada.accountId, "djdl", "sub-ada");
    for (let i = 0; i < 21; i++) await device(c, "djdl", `d${i}`, "sub-ada");
    let last = 0;
    for (let i = 0; i < 21; i++)
      last = (await call(c, ada, "DELETE", `/api/me/devices/djdl/d${i}`))
        .status;
    expect(last).toBe(429);
  });
});
