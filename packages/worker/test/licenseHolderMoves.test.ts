/**
 * LX-30 (notes/S-24 §5.5, D20): the relink tool's two holder moves, keyed by the licence.
 *
 *   - Make floating and Reassign… need a step-up, a reason and the typed confirmation (the
 *     licence's name, or its id), which the Worker compares;
 *   - Make floating takes the licence out of its account through `reassignLicense` (one auto-attach
 *     block, for that account), clears its own name and email, tells the old side first and signs
 *     its devices out only when asked; it also reaches a licence waiting for its email;
 *   - Reassign… tells the old side and the new address first, then the licence waits for the new
 *     address or joins the account that verified it (S-24 D3); the answer never says which (D4);
 *   - both undo within 72 hours, restoring the account, the name and the email, and lifting the
 *     block; a claim, a later change or the window closes the undo;
 *   - product B never sees or moves product A's licence;
 *   - the batch list pages, and Disable unused keys checks a typed label when one is sent.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedTier } from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { attachLicenseAccount } from "../src/core/accounts/accountSubjects.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { RELINK_UNDO_SECONDS } from "../src/services/identity/accounts/productUsers.js";

const SLUG = "tonebox";
const OTHER = "other";
const PLATFORM_GROUP = "admins";

let db: SqliteDb;
let env: Env;
let sent: Array<{ to: string; subject: string; text: string }>;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG, OTHER]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  sent = [];
  env.EMAIL = {
    send: async (m: { to: string; subject: string; text: string }) => {
      sent.push({ to: m.to, subject: m.subject, text: m.text });
    },
  } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  await seedProduct(db, SLUG);
  await seedProduct(db, OTHER);
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { authAt?: number; now?: number; product?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const now = opts.now ?? NOW;
  const { token, session } = await issueSession(
    env,
    {
      sub: "op-1",
      name: "Ada Operator",
      email: "op@studio.example",
      groups: [PLATFORM_GROUP],
      authTime: opts.authAt ?? now,
      stepUp: true,
    },
    now,
  );
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
    [CSRF_HEADER]: session.csrf,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const full = `/api/products/${opts.product ?? SLUG}${path}`;
  const res = await handleAdmin(
    new Request(`https://key.plrs.im/manage${full}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as unknown as Request,
    env,
    db,
    full.split("?")[0]!,
    { now },
  );
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

/** An account that verified `email` with an email code. */
async function account(email: string): Promise<{ id: string }> {
  const r = await signIn(
    db,
    { issuerKey: "email", subject: email, kind: "email" },
    NOW,
    { product: { slug: SLUG } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  return { id: r.account.id };
}

async function create(
  body: Record<string, unknown>,
  product = SLUG,
): Promise<string> {
  const res = await call("POST", "/license/licenses", body, { product });
  expect(res.status).toBe(201);
  return res.body.licenseId as string;
}

async function row(id: string): Promise<{
  account_id: string | null;
  name: string | null;
  email: string | null;
}> {
  return (await db.first<{
    account_id: string | null;
    name: string | null;
    email: string | null;
  }>(
    "SELECT account_id, name, email FROM licenses WHERE product = ? AND id = ?",
    SLUG,
    id,
  ))!;
}

async function blocks(id: string): Promise<string[]> {
  return (
    await db.all<{ account_id: string }>(
      "SELECT account_id FROM license_auto_attach_blocks WHERE product = ? AND license_id = ? ORDER BY account_id",
      SLUG,
      id,
    )
  ).map((r) => r.account_id);
}

async function addDevice(licenseId: string, deviceId: string): Promise<void> {
  await db.run(
    `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, bound_by, platform)
     VALUES (?, ?, ?, 'authorized', ?, ?, 'key', 'macos')`,
    SLUG,
    deviceId,
    licenseId,
    NOW,
    NOW,
  );
}

const floatPath = (id: string) => `/users/licenses/${id}/make-floating`;
const reassignPath = (id: string) => `/users/licenses/${id}/reassign`;
const undoPath = (id: string) => `/users/relinks/${id}/undo`;

describe("the controls: step-up, typed confirmation, reason", () => {
  it("Make floating and Reassign refuse a stale sign-in, a wrong confirmation and no reason, and change nothing", async () => {
    await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const before = await row(id);
    for (const path of [floatPath(id), reassignPath(id)]) {
      const stale = await call(
        "POST",
        path,
        {
          reason: "ticket 1",
          confirm: "Studio Pro",
          email: "bo@example.com",
        },
        { authAt: NOW - 301 },
      );
      expect(stale.status, path).toBe(403);
      expect(stale.body.code).toBe("step_up_required");

      for (const confirm of [undefined, "", "studio pro", "Studio"]) {
        const wrong = await call("POST", path, {
          reason: "ticket 1",
          confirm,
          email: "bo@example.com",
        });
        expect(wrong.status, `${path} ${String(confirm)}`).toBe(400);
        expect(wrong.body).toMatchObject({
          code: "bad_request",
          reason: "confirm_required",
          fields: ["confirm"],
        });
      }

      const noReason = await call("POST", path, {
        reason: "  ",
        confirm: "Studio Pro",
        email: "bo@example.com",
      });
      expect(noReason.status, path).toBe(422);
      expect(noReason.body.code).toBe("reason_required");
    }
    expect(await row(id)).toEqual(before);
    expect(sent).toEqual([]);
  });

  it("the licence id is always a valid confirmation (a licence with no name types its id)", async () => {
    await account("ada@example.com");
    const id = await create({ email: "ada@example.com" });
    const res = await call("POST", floatPath(id), {
      reason: "ticket 2",
      confirm: id,
    });
    expect(res.status).toBe(200);
  });
});

describe("Make floating", () => {
  it("takes an in-account licence out of the account, clears its name and email, writes one block and notifies first", async () => {
    const ada = await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    expect((await row(id)).account_id).toBe(ada.id);
    await addDevice(id, "dev-1");

    const res = await call("POST", floatPath(id), {
      reason: "Refunded (ticket 77)",
      confirm: "Studio Pro",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      undoUntil: NOW + RELINK_UNDO_SECONDS,
      noticesSent: 1,
      alert: false,
      devicesSignedOut: 0,
    });
    expect(res.body.relinkId).toMatch(/^rlk_/);
    expect(await row(id)).toEqual({
      account_id: null,
      name: null,
      email: null,
    });
    expect(await blocks(id)).toEqual([ada.id]);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      [
        "ada@example.com",
        "The developer removed a tonebox license from your account",
      ],
    ]);
    // The device keeps running: no sign-out unless asked.
    const dev = await db.first<{ status: string }>(
      "SELECT status FROM devices WHERE device_id = 'dev-1'",
    );
    expect(dev?.status).toBe("authorized");

    const read = await call("GET", `/license/licenses/${id}`);
    expect(read.body.holder).toEqual({ kind: "floating" });

    const audit = await db.first<{ summary: string; target_id: string }>(
      "SELECT summary, target_id FROM audit WHERE product = ? AND action = 'user.license.make_floating'",
      SLUG,
    );
    expect(audit?.target_id).toBe(id);
    expect(JSON.parse(audit!.summary)).toMatchObject({
      relink: res.body.relinkId,
      before: { name: "Studio Pro", email: "ada@example.com" },
      after: null,
      reason: "Refunded (ticket 77)",
      signOutDevices: false,
    });
  });

  it("signs every device out when asked", async () => {
    await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    await addDevice(id, "dev-1");
    await addDevice(id, "dev-2");
    const res = await call("POST", floatPath(id), {
      reason: "Leaked key",
      confirm: "Studio Pro",
      signOutDevices: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.devicesSignedOut).toBe(2);
    const statuses = await db.all<{ status: string }>(
      "SELECT status FROM devices WHERE license_id = ? ORDER BY device_id",
      id,
    );
    expect(statuses.map((d) => d.status)).toEqual([
      "deauthorized",
      "deauthorized",
    ]);
    const moves = await call("GET", `/users/licenses/${id}/relinks`);
    expect(
      (moves.body.relinks as Array<Record<string, unknown>>)[0],
    ).toMatchObject({ kind: "floating", devicesSignedOut: 2 });
  });

  it("a sign-out that fails partway keeps the move, its undo, its audit row and the alert count, and answers the partial count", async () => {
    await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    await addDevice(id, "dev-a");
    await addDevice(id, "dev-b");
    // dev-b's token cannot be evicted: its deauthorize throws, and the sign-out stops there.
    await db.run(
      "UPDATE devices SET token_hash = 'tok-bad' WHERE product = ? AND device_id = 'dev-b'",
      SLUG,
    );
    const realDelete = env.HOT.delete.bind(env.HOT);
    env.HOT.delete = (async (key: string) => {
      if (key.includes("tok-bad")) throw new Error("KV unavailable");
      return realDelete(key);
    }) as typeof env.HOT.delete;
    const prior = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM license_relinks WHERE actor_sub = 'op-1'",
    );
    const res = await call("POST", floatPath(id), {
      reason: "Leaked key",
      confirm: "Studio Pro",
      signOutDevices: true,
    });
    expect(res.status).toBe(200);
    // Whichever device came first: one signed out before the failure, or none.
    const signedOut = res.body.devicesSignedOut as number;
    expect(signedOut).toBeLessThan(2);
    // Each device signed out has its own audit row; the one that failed has none.
    const deauthorized = await db.all<{ target_id: string }>(
      "SELECT target_id FROM audit WHERE product = ? AND action = 'device.deauthorize'",
      SLUG,
    );
    expect(deauthorized.length).toBe(signedOut);
    const moves = await call("GET", `/users/licenses/${id}/relinks`);
    expect(
      (moves.body.relinks as Array<Record<string, unknown>>)[0],
    ).toMatchObject({ kind: "floating", devicesSignedOut: signedOut });
    // The move's row is there (the undo works), counted towards the alert, and audited.
    const after = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM license_relinks WHERE actor_sub = 'op-1'",
    );
    expect(after!.n).toBe(prior!.n + 1);
    const audited = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ? AND target_id = ? AND action = 'user.license.make_floating'",
      SLUG,
      id,
    );
    expect(audited.length).toBe(1);
    env.HOT.delete = realDelete as typeof env.HOT.delete;
    const undo = await call("POST", undoPath(res.body.relinkId as string), {
      reason: "Wrong licence",
    });
    expect(undo.status).toBe(200);
    expect((await row(id)).email).toBe("ada@example.com");
  });

  it("reaches a licence waiting for its email, which has no account and no subject", async () => {
    const id = await create({ name: "Bo", email: "bo@example.com" });
    expect((await row(id)).account_id).toBeNull();
    const res = await call("POST", floatPath(id), {
      reason: "Wrong address",
      confirm: "Bo",
    });
    expect(res.status).toBe(200);
    expect(res.body.noticesSent).toBe(1);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ["bo@example.com", "A tonebox license is no longer assigned to you"],
    ]);
    // A waiting address has no account: no "Secure your account" link.
    expect(sent[0]!.text).not.toContain("Secure your account");
    expect(await row(id)).toEqual({
      account_id: null,
      name: null,
      email: null,
    });
    expect(await blocks(id)).toEqual([]);
  });

  it("refuses a licence that is already floating", async () => {
    const id = await create({});
    const res = await call("POST", floatPath(id), {
      reason: "x",
      confirm: id,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_floating");
  });

  it("is undone within 72 hours: the account, the name and the email come back and the block goes", async () => {
    const ada = await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const res = await call("POST", floatPath(id), {
      reason: "Refunded",
      confirm: "Studio Pro",
    });
    sent.length = 0;
    const later = NOW + RELINK_UNDO_SECONDS - 60;
    const undo = await call(
      "POST",
      undoPath(res.body.relinkId as string),
      { reason: "The refund was reversed" },
      { now: later },
    );
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ ok: true, licenseId: id });
    expect(typeof undo.body.subject).toBe("string");
    expect(await row(id)).toEqual({
      account_id: ada.id,
      name: "Studio Pro",
      email: "ada@example.com",
    });
    expect(await blocks(id)).toEqual([]);
    expect(sent.map((m) => m.to)).toEqual(["ada@example.com"]);
    const moves = await call(
      "GET",
      `/users/licenses/${id}/relinks`,
      undefined,
      {
        now: later,
      },
    );
    expect(
      (moves.body.relinks as Array<Record<string, unknown>>)[0],
    ).toMatchObject({ undoneAt: later, undoable: false });
  });

  it("cannot be undone once someone added the key to an account, or after 72 hours", async () => {
    await account("ada@example.com");
    const bo = await account("bo@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const first = await call("POST", floatPath(id), {
      reason: "Refunded",
      confirm: "Studio Pro",
    });
    const late = await call(
      "POST",
      undoPath(first.body.relinkId as string),
      { reason: "too late" },
      { now: NOW + RELINK_UNDO_SECONDS },
    );
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("undo_unavailable");

    // Bo adds the floating key to his account.
    expect(await attachLicenseAccount(db, SLUG, id, bo.id, NOW)).toBe(true);
    const claimed = await call(
      "POST",
      undoPath(first.body.relinkId as string),
      {
        reason: "undo",
      },
    );
    expect(claimed.status).toBe(409);
    expect(claimed.body.code).toBe("undo_unavailable");
    expect((await row(id)).account_id).toBe(bo.id);
  });
});

describe("Reassign", () => {
  it("moves an in-account licence to an address no account verified: it waits, and both addresses are told first", async () => {
    const ada = await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const res = await call("POST", reassignPath(id), {
      email: "  bo@example.com ",
      name: "Bo",
      reason: "Sold to Bo (ticket 5)",
      confirm: "Studio Pro",
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ["alert", "noticesSent", "ok", "relinkId", "undoUntil"].sort(),
    );
    expect(res.body.noticesSent).toBe(2);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      [
        "ada@example.com",
        "The developer assigned your tonebox license to someone else",
      ],
      ["bo@example.com", "A tonebox license was assigned to you"],
    ]);
    expect(await row(id)).toEqual({
      account_id: null,
      name: "Bo",
      email: "bo@example.com",
    });
    expect(await blocks(id)).toEqual([ada.id]);
    const read = await call("GET", `/license/licenses/${id}`);
    expect(read.body.holder).toEqual({
      kind: "assigned",
      inAccount: false,
      email: "bo@example.com",
    });
    const audit = await db.first<{ summary: string }>(
      "SELECT summary FROM audit WHERE product = ? AND action = 'user.license.reassign'",
      SLUG,
    );
    expect(JSON.parse(audit!.summary)).toMatchObject({
      before: { name: "Studio Pro", email: "ada@example.com" },
      after: { name: "Bo", email: "bo@example.com" },
      reason: "Sold to Bo (ticket 5)",
    });
  });

  it("joins the account that verified the new address, with the same answer", async () => {
    await account("ada@example.com");
    const bo = await account("bo@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const res = await call("POST", reassignPath(id), {
      email: "BO@example.com",
      reason: "Sold to Bo",
      confirm: "Studio Pro",
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ["alert", "noticesSent", "ok", "relinkId", "undoUntil"].sort(),
    );
    const after = await row(id);
    expect(after.account_id).toBe(bo.id);
    expect(after.name).toBeNull();
    const moves = await call("GET", `/users/licenses/${id}/relinks`);
    const move = (moves.body.relinks as Array<Record<string, unknown>>)[0]!;
    expect(move).toMatchObject({
      kind: "reassign",
      from: { name: "Studio Pro", email: "ada@example.com" },
      to: { name: null, email: "BO@example.com" },
      undoable: true,
    });
    expect(typeof move.fromSubject).toBe("string");
    expect(typeof move.toSubject).toBe("string");
  });

  it("refuses the same address, a floating licence and a bad email", async () => {
    await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const same = await call("POST", reassignPath(id), {
      email: "ADA@example.com",
      reason: "x",
      confirm: "Studio Pro",
    });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe("same_holder");
    for (const email of [undefined, "", "not-an-email", "a b@example.com"]) {
      const bad = await call("POST", reassignPath(id), {
        email,
        reason: "x",
        confirm: "Studio Pro",
      });
      expect(bad.status, String(email)).toBe(422);
      expect(bad.body).toMatchObject({
        code: "bad_request",
        fields: ["email"],
      });
    }
    const floating = await create({});
    const res = await call("POST", reassignPath(floating), {
      email: "bo@example.com",
      reason: "x",
      confirm: floating,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("license_floating");
    expect(sent).toEqual([]);
  });

  it("is undone within 72 hours, even after the new address joined its account", async () => {
    const ada = await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const res = await call("POST", reassignPath(id), {
      email: "bo@example.com",
      name: "Bo",
      reason: "Sold to Bo",
      confirm: "Studio Pro",
    });
    // Bo verifies the address after the move: the licence joins his account through it.
    const bo = await account("bo@example.com");
    const { onAccountEmailVerified } =
      await import("../src/core/licensing/licenseHolders.js");
    await onAccountEmailVerified(db, bo.id, "bo@example.com", NOW);
    expect((await row(id)).account_id).toBe(bo.id);

    const undo = await call("POST", undoPath(res.body.relinkId as string), {
      reason: "Bo was the wrong buyer",
    });
    expect(undo.status).toBe(200);
    expect(await row(id)).toEqual({
      account_id: ada.id,
      name: "Studio Pro",
      email: "ada@example.com",
    });
    // Ada's block is lifted; Bo, whom the undo moved it away from, is blocked from it.
    expect(await blocks(id)).toEqual([bo.id]);
  });

  it("a second undo of the same move is refused", async () => {
    await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const res = await call("POST", reassignPath(id), {
      email: "bo@example.com",
      reason: "Sold",
      confirm: "Studio Pro",
    });
    const relink = res.body.relinkId as string;
    expect(
      (await call("POST", undoPath(relink), { reason: "undo" })).status,
    ).toBe(200);
    const again = await call("POST", undoPath(relink), { reason: "undo" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("undo_unavailable");
    expect((await row(id)).email).toBe("ada@example.com");
  });

  it("a later email edit closes the undo", async () => {
    await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const res = await call("POST", reassignPath(id), {
      email: "bo@example.com",
      reason: "Sold",
      confirm: "Studio Pro",
    });
    await db.run(
      "UPDATE licenses SET email = 'cy@example.com' WHERE product = ? AND id = ?",
      SLUG,
      id,
    );
    const undo = await call("POST", undoPath(res.body.relinkId as string), {
      reason: "undo",
    });
    expect(undo.status).toBe(409);
    expect(undo.body.code).toBe("undo_unavailable");
  });
});

describe("holder moves count towards the operator's daily relink alert", () => {
  it("the sixth move in 24 hours raises identity.relink.alert", async () => {
    const answers: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await create({ name: `Lic ${i}`, email: `p${i}@example.com` });
      const res =
        i % 2 === 0
          ? await call("POST", floatPath(id), {
              reason: "Refunded",
              confirm: `Lic ${i}`,
            })
          : await call("POST", reassignPath(id), {
              email: `q${i}@example.com`,
              reason: "Sold",
              confirm: `Lic ${i}`,
            });
      expect(res.status).toBe(200);
      answers.push(res.body.alert as boolean);
    }
    expect(answers).toEqual([false, false, false, false, false, true]);
    const alerts = await db.all<{ action: string }>(
      "SELECT action FROM platform_audit WHERE action = 'identity.relink.alert'",
    );
    expect(alerts.length).toBe(1);
  });
});

describe("a product deletion takes its relink history", () => {
  it("leaves no license_relinks row (names, emails, accounts) behind", async () => {
    const { deleteProduct } = await import("../src/core/console/repo.js");
    await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    expect(
      (
        await call("POST", floatPath(id), {
          reason: "Refunded",
          confirm: "Studio Pro",
        })
      ).status,
    ).toBe(200);
    const count = async (product: string) =>
      (await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM license_relinks WHERE product = ?",
        product,
      ))!.n;
    const other = await create(
      { name: "Other", email: "o@example.com" },
      OTHER,
    );
    await call(
      "POST",
      floatPath(other),
      { reason: "Refunded", confirm: "Other" },
      { product: OTHER },
    );
    expect(await count(SLUG)).toBe(1);
    await deleteProduct(db, SLUG, NOW);
    expect(await count(SLUG)).toBe(0);
    expect(await count(OTHER)).toBe(1);
  });
});

describe("one product's console never reaches another's licence", () => {
  it("404 for a licence of another product on every route", async () => {
    await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const opts = { product: OTHER };
    for (const [method, path] of [
      ["POST", floatPath(id)],
      ["POST", reassignPath(id)],
      ["GET", `/users/licenses/${id}/relinks`],
    ] as const) {
      const res = await call(
        method,
        path,
        method === "POST"
          ? { reason: "x", confirm: id, email: "bo@example.com" }
          : undefined,
        opts,
      );
      expect(res.status, path).toBe(404);
      expect(res.body.code).toBe("license_not_found");
    }
    // A move of product A's licence is not product B's to undo.
    const moved = await call("POST", floatPath(id), {
      reason: "x",
      confirm: id,
    });
    const undo = await call(
      "POST",
      undoPath(moved.body.relinkId as string),
      { reason: "x" },
      opts,
    );
    expect(undo.status).toBe(404);
    expect(undo.body.code).toBe("relink_not_found");
  });
});

describe("the Users page lists holder moves", () => {
  it("as their kind, with no subject on the side that has none", async () => {
    await account("ada@example.com");
    const id = await create({ name: "Studio Pro", email: "ada@example.com" });
    const owner = await db.first<{ subject: string }>(
      `SELECT s.subject FROM account_product_subjects s
         JOIN licenses l ON l.account_id = s.account_id AND l.product = s.product
        WHERE l.product = ? AND l.id = ?`,
      SLUG,
      id,
    );
    await call("POST", floatPath(id), { reason: "x", confirm: id });
    const user = await call("GET", `/users/${owner!.subject}`);
    const relinks = (user.body.user as { relinks: unknown[] }).relinks;
    expect(relinks).toEqual([
      expect.objectContaining({
        kind: "floating",
        licenseId: id,
        direction: "out",
        otherSubject: null,
        undoable: true,
      }),
    ]);
  });
});

describe("batches (LX-28 follow-ups)", () => {
  async function batch(label: string, at: number): Promise<string> {
    const res = await call(
      "POST",
      "/license/batches",
      { label, count: 1, tier: "pro" },
      { now: at },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.batchId as string;
  }

  beforeEach(async () => {
    env.KEY_HASH_PEPPER = "test-pepper";
    await seedTier(db, SLUG, "pro", { deviceLimit: 3, expiryDays: 30 });
  });

  it("the list pages newest first with limit and cursor", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await batch(`Batch ${i}`, NOW + i));
    const first = await call("GET", "/license/batches?limit=2");
    expect(first.status).toBe(200);
    const page1 = first.body.batches as Array<{ id: string }>;
    expect(page1.map((b) => b.id)).toEqual([ids[4], ids[3]]);
    expect(typeof first.body.nextCursor).toBe("string");
    const second = await call(
      "GET",
      `/license/batches?limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
    );
    expect(
      (second.body.batches as Array<{ id: string }>).map((b) => b.id),
    ).toEqual([ids[2], ids[1]]);
    const third = await call(
      "GET",
      `/license/batches?limit=2&cursor=${encodeURIComponent(second.body.nextCursor as string)}`,
    );
    expect(
      (third.body.batches as Array<{ id: string }>).map((b) => b.id),
    ).toEqual([ids[0]]);
    expect(third.body.nextCursor).toBeNull();
    // No limit: the default page holds all five, and says there is no more.
    const all = await call("GET", "/license/batches");
    expect((all.body.batches as unknown[]).length).toBe(5);
    expect(all.body.nextCursor).toBeNull();
  });

  it("refuses a bad limit or cursor", async () => {
    for (const q of ["limit=0", "limit=501", "limit=abc", "limit=1.5"]) {
      const res = await call("GET", `/license/batches?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.fields).toEqual(["limit"]);
    }
    const res = await call("GET", "/license/batches?cursor=nope");
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["cursor"]);
  });

  it("Disable unused keys refuses a wrong typed label and accepts the right one", async () => {
    const id = await batch("Steam keys, October", NOW);
    const wrong = await call("POST", `/license/batches/${id}/disable-unused`, {
      confirm: "steam keys, october",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({
      code: "bad_request",
      reason: "confirm_required",
      fields: ["confirm"],
    });
    const right = await call("POST", `/license/batches/${id}/disable-unused`, {
      confirm: "Steam keys, October",
    });
    expect(right.status).toBe(200);
    expect(right.body).toEqual({ disabled: 1 });
  });
});
