/**
 * I-12: the console's per-product Users page and the developer relink tool (S-16 §5.2, §5.4 items
 * 9 and 12, §5.5).
 *
 *   - product A's console sees nothing of product B, even for the same account;
 *   - no admin response carries the account id or the account's sign-in methods;
 *   - a product with Identity off still lists its licence owners, with no sign-in columns and no
 *     sign-in settings;
 *   - relink names its target only by a subject of this product, needs a step-up and a reason,
 *     notifies both accounts before the move, and can be undone for 72 hours;
 *   - per-subject export and data deletion go through Core's subject-store registry;
 *   - the operator step-up: `/manage/login?stepUp=1`, `auth_time`, and the hash `returnTo`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { insertLicense, setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import {
  attachLicenseAccount,
  subjectFor,
} from "../src/core/accountSubjects.js";
import {
  registerSubjectStore,
  unregisterSubjectStore,
} from "../src/core/subjectHooks.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  isSteppedUp,
  issueSession,
  verifySession,
} from "../src/admin/session.js";
import {
  handleAdminCallback,
  handleAdminLogin,
  sanitizeReturnTo,
  type IdTokenVerifier,
} from "../src/admin/auth.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import { deleteAccount } from "../src/services/identity/accounts/deletion.js";
import {
  RELINK_DAILY_ALERT_COUNT,
  RELINK_UNDO_SECONDS,
  consentedClaims,
} from "../src/services/identity/accounts/productUsers.js";

const PLATFORM_GROUP = "platform-admins";
const ISSUER = "https://idp.example";

interface World {
  db: Db;
  env: Env;
  sent: Array<{ to: string; subject: string }>;
  bodies: string[];
  call: (
    method: string,
    path: string,
    body?: unknown,
    opts?: { authAt?: number; now?: number; sub?: string },
  ) => Promise<Response>;
  json: <T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { authAt?: number; now?: number; sub?: string },
  ) => Promise<{ status: number; body: T }>;
}

async function setIdentity(db: Db, slug: string, on: boolean): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: false },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: on },
        sync: { enabled: false },
      },
    }),
    "admin",
    NOW,
  );
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  const sent: Array<{ to: string; subject: string }> = [];
  env.EMAIL = {
    send: async (m: { to: string; subject: string }) => {
      sent.push({ to: m.to, subject: m.subject });
    },
  } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  const bodies: string[] = [];
  const call: World["call"] = async (method, path, body, opts = {}) => {
    const now = opts.now ?? NOW;
    const { token, session } = await issueSession(
      env,
      {
        sub: opts.sub ?? "op-1",
        name: "Ada Operator",
        email: "ada@studio.example",
        groups: [PLATFORM_GROUP],
        authTime: opts.authAt ?? now,
      },
      now,
    );
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
    };
    if (method !== "GET") headers[CSRF_HEADER] = session.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const full = `/api/products${path}`;
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
    bodies.push(await res.clone().text());
    return res;
  };
  const json: World["json"] = async (method, path, body, opts) => {
    const res = await call(method, path, body, opts);
    return { status: res.status, body: (await res.json()) as never };
  };
  return { db, env, sent, bodies, call, json };
}

async function seedLicense(
  db: Db,
  product: string,
  id: string,
  email: string | null = null,
): Promise<void> {
  await insertLicense(db, {
    product,
    id,
    status: "active",
    sub: null,
    name: `Licence ${id}`,
    email,
    groups_json: null,
    tier_id: null,
    activated_at: NOW,
    expires_at: null,
    max_offline_days: null,
    overrides_json: null,
    channels_json: null,
    min_version: null,
    max_version: null,
    modified_by: null,
    modified_at: NOW,
  });
}

async function person(
  w: World,
  sub: string,
  email: string,
  product?: string,
): Promise<{ accountId: string; linkId: string }> {
  const r = await signIn(
    w.db,
    {
      issuerKey: ISSUER,
      subject: sub,
      kind: "steam",
      email,
      emailVerified: true,
    },
    NOW,
    product ? { product: { slug: product } } : {},
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  return { accountId: r.account.id, linkId: r.linkId };
}

const ctxOf = (w: World, now = NOW) => ({
  db: w.db,
  env: w.env,
  now,
  origin: "https://key.plrs.im",
});

async function attach(
  w: World,
  accountId: string,
  product: string,
  licenseId: string,
): Promise<void> {
  // The claim rules are I-05's and tested there; the fixture attaches through Core directly.
  if (!(await attachLicenseAccount(w.db, product, licenseId, accountId, NOW)))
    throw new Error(`attach ${licenseId}`);
  await subjectFor(w.db, accountId, product, NOW);
}

/**
 * Two products, `alpha` (Identity on) and `beta` (Identity off). Ada holds a licence of both and
 * has a device signed in to alpha; Bob holds a beta licence and signed in to alpha once.
 */
async function fixture(w: World) {
  await seedProduct(w.db, "alpha");
  await seedProduct(w.db, "beta");
  await setIdentity(w.db, "alpha", true);
  await setIdentity(w.db, "beta", false);
  const ada = await person(w, "idp-subject-ada-7731", "ada@player.example");
  const bob = await person(w, "idp-subject-bob-4410", "bob@player.example");
  await seedLicense(w.db, "alpha", "lic-alpha-ada", "buyer-ada@shop.example");
  await seedLicense(w.db, "beta", "lic-beta-ada", "beta-buyer@shop.example");
  await seedLicense(w.db, "beta", "lic-beta-bob");
  await attach(w, ada.accountId, "alpha", "lic-alpha-ada");
  await attach(w, ada.accountId, "beta", "lic-beta-ada");
  await attach(w, bob.accountId, "beta", "lic-beta-bob");
  // Bob signs in through alpha (no licence there): his alpha subject is created and listed.
  await person(w, "idp-subject-bob-4410", "bob@player.example", "alpha");
  const adaAlpha = await subjectFor(w.db, ada.accountId, "alpha", NOW);
  const adaBeta = await subjectFor(w.db, ada.accountId, "beta", NOW);
  const bobAlpha = await subjectFor(w.db, bob.accountId, "alpha", NOW);
  const bobBeta = await subjectFor(w.db, bob.accountId, "beta", NOW);
  await w.db.run(
    `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, bound_by, platform)
     VALUES ('alpha', 'dev-ada-1', 'lic-alpha-ada', 'authorized', ?, ?, ?, 'signin', 'ios')`,
    NOW,
    NOW,
    adaAlpha,
  );
  await w.db.run(
    `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, bound_by)
     VALUES ('beta', 'dev-ada-beta', 'lic-beta-ada', 'authorized', ?, ?, 'key')`,
    NOW,
    NOW,
  );
  return { ada, bob, adaAlpha, adaBeta, bobAlpha, bobBeta };
}

afterEach(() => {
  unregisterSubjectStore("test-store");
});

describe("Users list and row", () => {
  it("lists only this product's subjects, with this product's licences and devices", async () => {
    const w = await world();
    const f = await fixture(w);
    const alpha = await w.json<{
      identityOn: boolean;
      users: Array<Record<string, unknown>>;
    }>("GET", "/alpha/users");
    expect(alpha.status).toBe(200);
    expect(alpha.body.identityOn).toBe(true);
    const subjects = alpha.body.users.map((u) => u.subject).sort();
    expect(subjects).toEqual([f.adaAlpha, f.bobAlpha].sort());
    const adaRow = alpha.body.users.find((u) => u.subject === f.adaAlpha)!;
    expect(adaRow).toMatchObject({
      licenses: 1,
      devices: 1,
      signedInDevices: 1,
      contactEmail: "buyer-ada@shop.example",
      contactSource: "license",
    });
    const bobRow = alpha.body.users.find((u) => u.subject === f.bobAlpha)!;
    expect(bobRow).toMatchObject({ licenses: 0, contactEmail: null });
    expect(bobRow.lastSignInAt).toBe(NOW);

    const row = await w.json<{
      user: {
        licenses: Array<{ id: string }>;
        devices: Array<{ deviceId: string; signedIn?: boolean }>;
        signIns: Array<{ method: string | null }>;
      };
    }>("GET", `/alpha/users/${f.adaAlpha}`);
    expect(row.status).toBe(200);
    expect(row.body.user.licenses.map((l) => l.id)).toEqual(["lic-alpha-ada"]);
    expect(row.body.user.devices).toEqual([
      expect.objectContaining({ deviceId: "dev-ada-1", signedIn: true }),
    ]);
    const bobDetail = await w.json<{
      user: { signIns: Array<{ method: string | null }> };
    }>("GET", `/alpha/users/${f.bobAlpha}`);
    // Only the method KIND reached this product: "steam", never the link or its subject.
    expect(bobDetail.body.user.signIns).toEqual([{ at: NOW, method: "steam" }]);
  });

  it("product A's console cannot see a subject, licence or datum of product B for the same account", async () => {
    const w = await world();
    const f = await fixture(w);
    // B's subject is not found under A, and vice versa.
    expect((await w.call("GET", `/alpha/users/${f.adaBeta}`)).status).toBe(404);
    expect((await w.call("GET", `/beta/users/${f.adaAlpha}`)).status).toBe(404);
    // A's row of the same account carries nothing of B.
    const res = await w.call("GET", `/alpha/users/${f.adaAlpha}`);
    const text = await res.text();
    for (const leak of [
      f.adaBeta,
      "lic-beta-ada",
      "beta-buyer@shop.example",
      "dev-ada-beta",
    ]) {
      expect(text).not.toContain(leak);
    }
    const exported = await (
      await w.call("GET", `/alpha/users/${f.adaAlpha}/export`)
    ).text();
    expect(exported).not.toContain("lic-beta-ada");
    expect(exported).not.toContain(f.adaBeta);
    // Search across products finds nothing: B's licence id and buyer email.
    for (const q of ["lic-beta-ada", "beta-buyer"]) {
      const r = await w.json<{ users: unknown[] }>(
        "GET",
        `/alpha/users?q=${encodeURIComponent(q)}`,
      );
      expect(r.body.users).toEqual([]);
    }
    // B's licence can't be detached or relinked through A's row.
    expect(
      (
        await w.call(
          "POST",
          `/alpha/users/${f.adaAlpha}/licenses/lic-beta-ada/detach`,
        )
      ).status,
    ).toBe(404);
    // A relink target from another product is refused: subjects are per product.
    const relink = await w.json(
      "POST",
      `/alpha/users/${f.adaAlpha}/licenses/lic-alpha-ada/relink`,
      {
        target: f.bobBeta,
        reason: "support ticket 12",
      },
    );
    expect(relink.status).toBe(404);
    expect(relink.body.code).toBe("target_not_found");
  });

  it("no admin response contains the account id or the account's link list", async () => {
    const w = await world();
    const f = await fixture(w);
    await w.call("GET", "/alpha/users");
    await w.call("GET", "/beta/users");
    await w.call("GET", "/alpha/users?q=ps_");
    await w.call("GET", `/alpha/users/${f.adaAlpha}`);
    await w.call("GET", `/alpha/users/${f.bobAlpha}`);
    await w.call("GET", `/beta/users/${f.adaBeta}`);
    await w.call("GET", `/alpha/users/${f.adaAlpha}/export`);
    await w.call("GET", "/alpha/users/events");
    await w.call("GET", "/alpha/license/licenses");
    await w.call("GET", "/alpha/license/licenses/lic-alpha-ada");
    await w.call("GET", "/alpha/devices");
    await w.call("GET", "/alpha/devices/dev-ada-1");
    await w.call("GET", "/alpha/activity");
    await w.call("GET", "/alpha/identity/sign-in-settings");
    await w.call(
      "POST",
      `/alpha/users/${f.adaAlpha}/licenses/lic-alpha-ada/relink`,
      { target: f.bobAlpha, reason: "Bought it for Bob" },
    );
    await w.call("GET", `/alpha/users/${f.bobAlpha}`);
    await w.call("GET", `/alpha/users/${f.adaAlpha}`);
    await w.call("GET", "/alpha/activity");
    const links = await w.db.all<{ id: string; subject: string }>(
      "SELECT id, subject FROM account_links",
    );
    expect(links.length).toBeGreaterThan(0);
    const forbidden = [
      f.ada.accountId,
      f.bob.accountId,
      ISSUER,
      ...links.flatMap((l) => [l.id, l.subject]),
    ];
    for (const body of w.bodies) {
      for (const value of forbidden) expect(body).not.toContain(value);
    }
  });

  it("shows the account email only with consent, and the consented name", async () => {
    const w = await world();
    const f = await fixture(w);
    let row = await w.json<{ user: { contact: unknown; name: unknown } }>(
      "GET",
      `/alpha/users/${f.bobAlpha}`,
    );
    expect(row.body.user.contact).toEqual({ email: null, source: null });
    expect(row.body.user.name).toBeNull();
    await w.db.run(
      `INSERT INTO account_product_grants (account_id, product, claims_json, granted_at, modified_at)
       VALUES (?, 'alpha', '["email","name"]', ?, ?)`,
      f.bob.accountId,
      NOW,
      NOW,
    );
    row = await w.json("GET", `/alpha/users/${f.bobAlpha}`);
    expect(row.body.user.contact).toEqual({
      email: "bob@player.example",
      source: "consented",
    });
    // Consent to alpha says nothing to beta.
    const beta = await w.json<{ user: { contact: unknown } }>(
      "GET",
      `/beta/users/${f.bobBeta}`,
    );
    expect(beta.body.user.contact).toEqual({ email: null, source: null });
    expect(consentedClaims('{"email":true,"name":false}')).toEqual(
      new Set(["email"]),
    );
    expect(consentedClaims("not json")).toEqual(new Set());
  });

  it("a merged subject resolves to the survivor's row (D21)", async () => {
    const w = await world();
    const f = await fixture(w);
    const proof = (accountId: string) => ({
      accountId,
      authenticatedAt: NOW,
    });
    const merged = await mergeAccounts(ctxOf(w), {
      survivor: proof(f.ada.accountId),
      absorbed: proof(f.bob.accountId),
    });
    expect(merged.ok).toBe(true);
    const alias = await w.json("GET", `/alpha/users/${f.bobAlpha}`);
    expect(alias.body).toEqual({ mergedInto: f.adaAlpha });
    const row = await w.json<{
      user: { mergedFrom: Array<{ subject: string }> };
    }>("GET", `/alpha/users/${f.adaAlpha}`);
    expect(row.body.user.mergedFrom.map((m) => m.subject)).toEqual([
      f.bobAlpha,
    ]);
    const events = await w.json<{
      events: Array<{ type: string; subject: string }>;
    }>("GET", "/alpha/users/events");
    expect(events.body.events).toEqual([
      expect.objectContaining({ type: "subject.merged", subject: f.adaAlpha }),
    ]);
  });
});

describe("Identity off", () => {
  it("still lists licence owners' subjects, with no sign-in columns and no sign-in settings", async () => {
    const w = await world();
    const f = await fixture(w);
    const beta = await w.json<{
      identityOn: boolean;
      users: Array<Record<string, unknown>>;
    }>("GET", "/beta/users");
    expect(beta.body.identityOn).toBe(false);
    expect(beta.body.users.map((u) => u.subject).sort()).toEqual(
      [f.adaBeta, f.bobBeta].sort(),
    );
    for (const u of beta.body.users) {
      expect(u).not.toHaveProperty("signedInDevices");
      expect(u).not.toHaveProperty("lastSignInAt");
    }
    const row = await w.json<{ user: Record<string, unknown> }>(
      "GET",
      `/beta/users/${f.adaBeta}`,
    );
    expect(row.body.user.identityOn).toBe(false);
    expect(row.body.user).not.toHaveProperty("signIns");
    for (const d of row.body.user.devices as Array<Record<string, unknown>>)
      expect(d).not.toHaveProperty("signedIn");
    // A consent grant kept from when Identity was on is not product-user data now (PX-W17 Q5).
    await w.db.run(
      `INSERT INTO account_product_grants (account_id, product, claims_json, granted_at, modified_at)
       VALUES (?, 'beta', '["email","name"]', ?, ?)`,
      f.bob.accountId,
      NOW,
      NOW,
    );
    const bobRow = await w.json<{ user: { contact: unknown; name: unknown } }>(
      "GET",
      `/beta/users/${f.bobBeta}`,
    );
    expect(bobRow.body.user.contact).toEqual({ email: null, source: null });
    expect(bobRow.body.user.name).toBeNull();
    const listed = await w.json<{ users: Array<Record<string, unknown>> }>(
      "GET",
      "/beta/users",
    );
    expect(
      listed.body.users.find((u) => u.subject === f.bobBeta)?.contactEmail,
    ).toBeNull();
    expect(
      (await w.call("GET", "/beta/identity/sign-in-settings")).status,
    ).toBe(404);
    expect(
      (
        await w.call("PATCH", "/beta/identity/sign-in-settings", {
          claimByKey: true,
        })
      ).status,
    ).toBe(404);
  });
});

describe("actions", () => {
  it("export and data deletion run through the subject-store registry; the subject stays", async () => {
    const w = await world();
    const f = await fixture(w);
    const deleted: string[] = [];
    registerSubjectStore("test-store", {
      merge: async () => {},
      delete: async (_ctx, args) => {
        deleted.push(`${args.product}:${args.subject}`);
      },
      export: async (_ctx, args) => ({
        overrides: { volume: 3 },
        of: args.subject,
      }),
      size: async () => 42,
    });
    const row = await w.json<{ user: { data: { bytes: number } } }>(
      "GET",
      `/alpha/users/${f.adaAlpha}`,
    );
    expect(row.body.user.data.bytes).toBe(42);
    const exp = await w.call("GET", `/alpha/users/${f.adaAlpha}/export`);
    expect(exp.headers.get("content-disposition")).toContain("attachment");
    const doc = (await exp.json()) as Record<string, unknown>;
    expect(doc.subject).toBe(f.adaAlpha);
    expect(doc.stores).toEqual({
      "test-store": { overrides: { volume: 3 }, of: f.adaAlpha },
    });
    const del = await w.json("POST", `/alpha/users/${f.adaAlpha}/data/delete`);
    expect(del.body).toEqual({ ok: true, stores: ["test-store"] });
    expect(deleted).toEqual([`alpha:${f.adaAlpha}`]);
    // The subject and its licence are untouched: the developer never deletes the account.
    expect((await w.call("GET", `/alpha/users/${f.adaAlpha}`)).status).toBe(
      200,
    );
    const audit = await w.db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = 'alpha' ORDER BY at, id",
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["user.export", "user.data.delete"]),
    );
  });

  it("detach makes the licence floating and keeps the device binding", async () => {
    const w = await world();
    const f = await fixture(w);
    const r = await w.json(
      "POST",
      `/alpha/users/${f.adaAlpha}/licenses/lic-alpha-ada/detach`,
    );
    expect(r.body).toEqual({ ok: true });
    const lic = await w.db.first<{ account_id: string | null }>(
      "SELECT account_id FROM licenses WHERE product = 'alpha' AND id = 'lic-alpha-ada'",
    );
    expect(lic?.account_id).toBeNull();
    const dev = await w.db.first<{ subject: string | null }>(
      "SELECT subject FROM devices WHERE product = 'alpha' AND device_id = 'dev-ada-1'",
    );
    expect(dev?.subject).toBe(f.adaAlpha);
  });
});

describe("relink", () => {
  const path = (s: string) => `/alpha/users/${s}/licenses/lic-alpha-ada/relink`;

  it("requires a step-up no older than 5 minutes", async () => {
    const w = await world();
    const f = await fixture(w);
    const stale = await w.json(
      "POST",
      path(f.adaAlpha),
      { target: f.bobAlpha, reason: "ticket 1" },
      { authAt: NOW - 301 },
    );
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe("step_up_required");
    expect(w.sent).toEqual([]);
    const owner = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM licenses WHERE id = 'lic-alpha-ada'",
    );
    expect(owner?.account_id).toBe(f.ada.accountId);
  });

  it("requires a reason, and refuses a target that is not an existing subject of this product", async () => {
    const w = await world();
    const f = await fixture(w);
    const noReason = await w.json("POST", path(f.adaAlpha), {
      target: f.bobAlpha,
      reason: "   ",
    });
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe("reason_required");
    for (const target of [
      "bob@player.example", // never by email
      "ps_AAAAAAAAAAAAAAAAAAAAAA", // well formed, but no such subject
      f.bobBeta, // a real subject of ANOTHER product
    ]) {
      const r = await w.json("POST", path(f.adaAlpha), {
        target,
        reason: "ticket 2",
      });
      expect(r.status, target).toBe(404);
      expect(r.body.code).toBe("target_not_found");
    }
    const same = await w.json("POST", path(f.adaAlpha), {
      target: f.adaAlpha,
      reason: "ticket 3",
    });
    expect(same.body.code).toBe("same_subject");
    expect(w.sent).toEqual([]);
  });

  it("moves the licence, notifies both accounts first, audits before and after, and undoes within 72 hours", async () => {
    const w = await world();
    const f = await fixture(w);
    const r = await w.json<{
      ok: boolean;
      relinkId: string;
      subject: string;
      undoUntil: number;
      noticesSent: number;
    }>("POST", path(f.adaAlpha), {
      target: f.bobAlpha,
      reason: "Bought as a gift for Bob (ticket 991)",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      subject: f.bobAlpha,
      undoUntil: NOW + RELINK_UNDO_SECONDS,
    });
    expect(w.sent.map((m) => m.to).sort()).toEqual(
      ["ada@player.example", "bob@player.example"].sort(),
    );
    expect(r.body.noticesSent).toBe(2);
    const owner = async () =>
      (
        await w.db.first<{ account_id: string | null }>(
          "SELECT account_id FROM licenses WHERE id = 'lic-alpha-ada'",
        )
      )?.account_id;
    expect(await owner()).toBe(f.bob.accountId);
    // The previous owner's sign-in binding on the licence's device is cleared.
    const dev = await w.db.first<{ subject: string | null }>(
      "SELECT subject FROM devices WHERE device_id = 'dev-ada-1'",
    );
    expect(dev?.subject).toBeNull();
    const audit = await w.db.first<{ summary: string }>(
      "SELECT summary FROM audit WHERE product = 'alpha' AND action = 'user.license.relink'",
    );
    expect(JSON.parse(audit!.summary)).toMatchObject({
      before: f.adaAlpha,
      after: f.bobAlpha,
      reason: "Bought as a gift for Bob (ticket 991)",
    });
    // Both rows show the relink; the row now holding it can undo it.
    const bobRow = await w.json<{
      user: { relinks: Array<{ direction: string; undoable: boolean }> };
    }>("GET", `/alpha/users/${f.bobAlpha}`);
    expect(bobRow.body.user.relinks).toEqual([
      expect.objectContaining({ direction: "in", undoable: true }),
    ]);

    const undoPath = `/alpha/users/relinks/${r.body.relinkId}/undo`;
    // The undo needs the step-up and a reason too.
    expect(
      (await w.json("POST", undoPath, { reason: "x" }, { authAt: NOW - 600 }))
        .status,
    ).toBe(403);
    expect((await w.json("POST", undoPath, { reason: "" })).body.code).toBe(
      "reason_required",
    );
    w.sent.length = 0;
    const later = NOW + RELINK_UNDO_SECONDS - 60;
    const undo = await w.json(
      "POST",
      undoPath,
      { reason: "Ada says it was not a gift" },
      { now: later },
    );
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ ok: true, subject: f.adaAlpha });
    expect(await owner()).toBe(f.ada.accountId);
    expect(w.sent).toHaveLength(2);
    // Once undone, never again.
    const again = await w.json(
      "POST",
      undoPath,
      { reason: "again" },
      { now: later },
    );
    expect(again.body.code).toBe("undo_unavailable");
  });

  it("a licence that moves while the notices go out stays put: conflict, no undo row, no audit", async () => {
    const w = await world();
    const f = await fixture(w);
    const owner = async () =>
      (
        await w.db.first<{ account_id: string | null }>(
          "SELECT account_id FROM licenses WHERE id = 'lic-alpha-ada'",
        )
      )?.account_id;
    // Between the ownership check and the move, someone else detaches the licence.
    const send = w.env.EMAIL!.send.bind(w.env.EMAIL);
    let interfere: (() => Promise<void>) | null = async () => {
      await w.db.run(
        "UPDATE licenses SET account_id = NULL WHERE product = 'alpha' AND id = 'lic-alpha-ada'",
      );
    };
    w.env.EMAIL = {
      send: async (m: never) => {
        const run = interfere;
        interfere = null;
        if (run) await run();
        return send(m);
      },
    } as unknown as Env["EMAIL"];
    const r = await w.json("POST", path(f.adaAlpha), {
      target: f.bobAlpha,
      reason: "ticket 77",
    });
    expect(r.body.code).toBe("conflict");
    expect(await owner()).toBeNull();
    expect(
      await w.db.first(
        "SELECT id FROM license_relinks WHERE product = 'alpha'",
      ),
    ).toBeNull();
    expect(
      await w.db.first(
        "SELECT id FROM audit WHERE product = 'alpha' AND action = 'user.license.relink'",
      ),
    ).toBeNull();

    // The undo is held to the same rule: a licence moved on mid-undo is not pulled back.
    await w.db.run(
      "UPDATE licenses SET account_id = ? WHERE product = 'alpha' AND id = 'lic-alpha-ada'",
      f.ada.accountId,
    );
    const done = await w.json<{ relinkId: string }>("POST", path(f.adaAlpha), {
      target: f.bobAlpha,
      reason: "ticket 78",
    });
    expect(done.status).toBe(200);
    interfere = async () => {
      await w.db.run(
        "UPDATE licenses SET account_id = NULL WHERE product = 'alpha' AND id = 'lic-alpha-ada'",
      );
    };
    const undo = await w.json(
      "POST",
      `/alpha/users/relinks/${done.body.relinkId}/undo`,
      { reason: "undo while it moves" },
    );
    expect(undo.body.code).toBe("conflict");
    expect(await owner()).toBeNull();
    const row = await w.db.first<{ undone_at: number | null }>(
      "SELECT undone_at FROM license_relinks WHERE id = ?",
      done.body.relinkId,
    );
    expect(row?.undone_at).toBeNull();
  });

  it("cannot be undone after 72 hours, or once the licence moved on", async () => {
    const w = await world();
    const f = await fixture(w);
    const first = await w.json<{ relinkId: string }>("POST", path(f.adaAlpha), {
      target: f.bobAlpha,
      reason: "ticket 4",
    });
    const late = await w.json(
      "POST",
      `/alpha/users/relinks/${first.body.relinkId}/undo`,
      { reason: "too late" },
      { now: NOW + RELINK_UNDO_SECONDS },
    );
    expect(late.body.code).toBe("undo_unavailable");
    // A later detach by the new holder's developer closes the undo too.
    await w.json(
      "POST",
      `/alpha/users/${f.bobAlpha}/licenses/lic-alpha-ada/detach`,
    );
    const moved = await w.json(
      "POST",
      `/alpha/users/relinks/${first.body.relinkId}/undo`,
      { reason: "moved on" },
    );
    expect(moved.body.code).toBe("undo_unavailable");
  });

  it("alerts above the daily per-operator count", async () => {
    const w = await world();
    const f = await fixture(w);
    let holder = f.adaAlpha;
    let other = f.bobAlpha;
    const alerts: boolean[] = [];
    for (let i = 0; i <= RELINK_DAILY_ALERT_COUNT; i++) {
      const r = await w.json<{ alert: boolean }>("POST", path(holder), {
        target: other,
        reason: `ticket ${i}`,
      });
      expect(r.status).toBe(200);
      alerts.push(r.body.alert);
      [holder, other] = [other, holder];
    }
    expect(alerts.slice(0, RELINK_DAILY_ALERT_COUNT).every((a) => !a)).toBe(
      true,
    );
    expect(alerts[RELINK_DAILY_ALERT_COUNT]).toBe(true);
    const events = await w.db.all<{ action: string }>(
      "SELECT action FROM platform_audit WHERE action = 'identity.relink.alert'",
    );
    expect(events).toHaveLength(1);
    // Another operator starts from zero.
    const fresh = await w.json<{ alert: boolean }>(
      "POST",
      path(holder),
      { target: other, reason: "ticket z" },
      { sub: "op-2" },
    );
    expect(fresh.body.alert).toBe(false);
  });

  it("an account deletion clears the relink's account ids; the undo then leaves the licence floating", async () => {
    const w = await world();
    const f = await fixture(w);
    const r = await w.json<{ relinkId: string }>("POST", path(f.adaAlpha), {
      target: f.bobAlpha,
      reason: "ticket 5",
    });
    await deleteAccount(ctxOf(w), f.ada.accountId);
    const row = await w.db.first<{
      from_account_id: string | null;
      from_subject: string;
    }>("SELECT from_account_id, from_subject FROM license_relinks");
    expect(row).toEqual({ from_account_id: null, from_subject: f.adaAlpha });
    const undo = await w.json(
      "POST",
      `/alpha/users/relinks/${r.body.relinkId}/undo`,
      { reason: "chargeback" },
    );
    expect(undo.body).toMatchObject({ ok: true, subject: null });
    const lic = await w.db.first<{ account_id: string | null }>(
      "SELECT account_id FROM licenses WHERE id = 'lic-alpha-ada'",
    );
    expect(lic?.account_id).toBeNull();
  });
});

describe("sign-in settings (Identity on)", () => {
  it("reads and edits claimByKey and the passthrough name under the reserved-name validator", async () => {
    const w = await world();
    await fixture(w);
    const got = await w.json<{ settings: Record<string, unknown> }>(
      "GET",
      "/alpha/identity/sign-in-settings",
    );
    expect(got.body.settings).toEqual({
      claimByKey: false,
      passthroughName: null,
      effectiveName: "alpha",
      // dev-ada-1 is an iOS device and no native Apple sign-in is declared (App Review 4.8).
      appReview48Warning: true,
    });
    for (const bad of ["Polaris Key", "Evil <script>", "x".repeat(41)]) {
      const r = await w.json("PATCH", "/alpha/identity/sign-in-settings", {
        passthroughName: bad,
      });
      expect(r.status, bad).toBe(422);
    }
    const ok = await w.json<{ settings: Record<string, unknown> }>(
      "PATCH",
      "/alpha/identity/sign-in-settings",
      { passthroughName: "  Alpha   Quest ", claimByKey: true },
    );
    expect(ok.body.settings).toMatchObject({
      claimByKey: true,
      passthroughName: "Alpha Quest",
      effectiveName: "Alpha Quest",
    });
    const cleared = await w.json<{ settings: Record<string, unknown> }>(
      "PATCH",
      "/alpha/identity/sign-in-settings",
      { passthroughName: null },
    );
    expect(cleared.body.settings.effectiveName).toBe("alpha");
  });
});

describe("operator step-up", () => {
  it("issues sessions with authAt from auth_time, never from the future", async () => {
    const env = makeEnv(new KvMock(), []);
    env.ADMIN_SESSION_SECRET = "s";
    const base = { sub: "op", groups: ["g"] };
    const a = await issueSession(env, { ...base, authTime: NOW - 100 }, NOW);
    expect(a.session.authAt).toBe(NOW - 100);
    expect(isSteppedUp(a.session, NOW)).toBe(true);
    const b = await issueSession(env, { ...base, authTime: NOW + 999 }, NOW);
    expect(b.session.authAt).toBe(NOW);
    expect(isSteppedUp(b.session, NOW + 301)).toBe(false);
    const verified = await verifySession(env, a.token, NOW);
    expect(verified?.authAt).toBe(NOW - 100);
    expect(isSteppedUp({ ...a.session, authAt: undefined }, NOW)).toBe(false);
  });

  it("asks the IdP for a fresh sign-in and refuses a stale auth_time", async () => {
    const env = makeEnv(new KvMock(), []);
    env.ADMIN_SESSION_SECRET = "s";
    env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
    env.PLATFORM_OIDC_ISSUER = "https://id.example";
    env.PLATFORM_OIDC_CLIENT_ID = "console";
    const login = await handleAdminLogin(
      new Request(
        "https://key.plrs.im/manage/login?stepUp=1&returnTo=/manage/%23/p/alpha/users",
      ) as unknown as Request,
      env,
    );
    const location = new URL(login.headers.get("location")!);
    expect(location.searchParams.get("prompt")).toBe("login");
    expect(location.searchParams.get("max_age")).toBe("0");
    const state = location.searchParams.get("state")!;
    const stale: IdTokenVerifier = {
      verify: async () => ({
        sub: "op",
        groups: [PLATFORM_GROUP],
        authTime: NOW - 3600,
      }),
    };
    const db = makeTestDb();
    const cb = await handleAdminCallback(
      new Request(
        `https://key.plrs.im/manage/callback?code=c&state=${state}`,
      ) as unknown as Request,
      env,
      db,
      NOW,
      stale,
    );
    expect(cb.status).toBe(401);
    expect(cb.headers.get("set-cookie")).toBeNull();
  });

  it("lets a step-up return to a console hash route, and nothing looser", () => {
    expect(sanitizeReturnTo("/manage/#/p/alpha/users/ps_abc")).toBe(
      "/manage/#/p/alpha/users/ps_abc",
    );
    for (const bad of [
      "/docs/#/x",
      "/manage/#//evil.example",
      "/manage/#/p/../x",
      "/manage/#/p?x=1",
      "/manage/#https://evil.example",
      "/manage#/p",
    ]) {
      expect(sanitizeReturnTo(bad), bad).toBeNull();
    }
  });
});
