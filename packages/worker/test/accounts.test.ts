/**
 * I-05: the layer-1 account model (plans/I-04.md §6; S-16 §5.1).
 *
 * signIn(verifiedIdentity), the link engine (link_conflict, last_link, step-up), merge with proof
 * of both (aliases, tombstone, subject.merged), the licence claim rules (license_owned, the
 * email-bound rule, claimByKey, the licence-email notice), pairwise subjects and tenant-scoped
 * links, the device binding with Core's clearing hook, subjectFor with the Identity toggle off, an
 * Identity-only sign-in with no licence row, deletion through the registered stores, and the rule
 * that the account id never reaches a developer-facing response.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { getDevice, insertLicense, setServices } from "../src/repo.js";
import { MERGE_UNDO_SECONDS } from "../src/services/identity/accounts/mergeUndo.js";
import { serializeServices } from "../src/core/services.js";
import { loadProduct } from "../src/core/products.js";
import {
  PAIRWISE_SUBJECT_PATTERN,
  accountForSubject,
  licenseOwnerSubject,
  resolveSubject,
  setDeviceSubject,
  subjectFor,
} from "../src/core/accountSubjects.js";
import {
  clearDeviceSubjects,
  registerSubjectStore,
  unregisterSubjectStore,
} from "../src/core/subjectHooks.js";
import { registerDeviceBinding } from "../src/core/devices.js";
import { getTokenRecord } from "../src/kv.js";
import { hashKey } from "../src/crypto.js";
import { handleActivate } from "../src/services/license/activation.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import {
  linkIdentity,
  unlinkIdentity,
  type AccountContext,
} from "../src/services/identity/accounts/links.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import {
  attachLicense,
  detachLicense,
  reassignLicense,
} from "../src/services/identity/accounts/claim.js";
import {
  deleteAccount,
  removeProductData,
} from "../src/services/identity/accounts/deletion.js";
import { resolveAccount } from "../src/services/identity/accounts/repo.js";
import { upsertPortalProductSettings } from "../src/services/identity/portal/repo.js";

const ISSUER = "https://id.example";

interface World {
  db: Db;
  env: Env;
  sent: Array<{ to: string; subject: string }>;
  ctx: (now?: number) => AccountContext;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  const sent: Array<{ to: string; subject: string }> = [];
  env.EMAIL = {
    send: async (m: { to: string; subject: string }) => {
      sent.push({ to: m.to, subject: m.subject });
    },
  } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  return {
    db,
    env,
    sent,
    ctx: (now = NOW) => ({ db, env, now, origin: "https://key.plrs.im" }),
  };
}

async function signedIn(
  db: Db,
  identity: Parameters<typeof signIn>[1],
  now = NOW,
  opts: Parameters<typeof signIn>[3] = {},
) {
  const r = await signIn(db, identity, now, opts);
  if (r.status !== "signed_in")
    throw new Error(`expected signed_in, got ${r.status}`);
  return r;
}

const emailIdentity = (email: string) => ({
  issuerKey: "email",
  subject: email,
  kind: "email",
});

const oidcIdentity = (sub: string, email?: string) => ({
  issuerKey: ISSUER,
  subject: sub,
  kind: "oidc",
  email: email ?? null,
  emailVerified: Boolean(email),
});

async function seedFloating(
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
    name: null,
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

async function setIdentityServices(
  db: Db,
  slug: string,
  services: { license: boolean; identity: boolean },
): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({
      services: {
        license: { enabled: services.license },
        config: { enabled: false },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: services.identity },
        sync: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
}

// ── signIn ────────────────────────────────────────────────────────────────────────────────────

describe("signIn(verifiedIdentity)", () => {
  it("creates an account on the first verified credential, then signs the same identity back in", async () => {
    const { db } = await world();
    expect(await db.all("SELECT id FROM accounts")).toEqual([]);
    const first = await signedIn(db, oidcIdentity("u1", "ada@example.com"));
    expect(first.created).toBe(true);
    expect(first.account.primary_email).toBe("ada@example.com");
    // The provider-verified address is also the account's email sign-in method.
    const links = await db.all<{ kind: string; subject: string }>(
      "SELECT kind, subject FROM account_links WHERE account_id = ? ORDER BY kind",
      first.account.id,
    );
    expect(links).toEqual([
      { kind: "email", subject: "ada@example.com" },
      { kind: "oidc", subject: "u1" },
    ]);
    const again = await signedIn(db, oidcIdentity("u1", "ada@example.com"));
    expect(again.created).toBe(false);
    expect(again.account.id).toBe(first.account.id);
    // ...and by the email method too: one person, one account.
    expect(
      (await signedIn(db, emailIdentity("ADA@example.com"))).account.id,
    ).toBe(first.account.id);
  });

  it("never attaches by email match: an unknown identity with another account's verified email is a join offer that writes nothing", async () => {
    const { db } = await world();
    const existing = await signedIn(db, emailIdentity("ada@example.com"));
    const before = await db.all("SELECT * FROM account_links ORDER BY id");
    const r = await signIn(
      db,
      oidcIdentity("google-1", "ada@example.com"),
      NOW,
    );
    expect(r).toEqual({
      status: "join_offer",
      existingAccountId: existing.account.id,
      email: "ada@example.com",
    });
    expect(await db.all("SELECT * FROM account_links ORDER BY id")).toEqual(
      before,
    );
    expect(await db.all("SELECT id FROM accounts")).toHaveLength(1);
    // An UNVERIFIED claim of the same address is no join offer and attaches nothing either.
    const unverified = await signedIn(db, {
      ...oidcIdentity("google-2"),
      email: "ada@example.com",
      emailVerified: false,
    });
    expect(unverified.created).toBe(true);
    expect(unverified.account.id).not.toBe(existing.account.id);
    expect(unverified.account.primary_email).toBeNull();
  });

  it("refuses a disabled account and an unusable identity", async () => {
    const { db } = await world();
    const a = await signedIn(db, emailIdentity("ada@example.com"));
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      a.account.id,
    );
    expect(await signIn(db, emailIdentity("ada@example.com"), NOW)).toEqual({
      status: "refused",
      reason: "account_disabled",
    });
    expect(
      await signIn(db, { issuerKey: ISSUER, subject: " ", kind: "oidc" }, NOW),
    ).toEqual({ status: "refused", reason: "invalid_identity" });
  });

  it("a tenant-scoped link of team A never resolves an account for a product of team B", async () => {
    const { db } = await world();
    await seedProduct(db, "game-a");
    await seedProduct(db, "game-b");
    const gamecenter = (team: string) => ({
      issuerKey: "gamecenter",
      tenantScope: team,
      subject: "player-42",
      kind: "gamecenter",
    });
    const productA = { slug: "game-a", tenantScopes: ["team-a"] };
    const productB = { slug: "game-b", tenantScopes: ["team-b"] };

    const a = await signedIn(db, gamecenter("team-a"), NOW, {
      product: productA,
    });
    // The same subject string under team B is a different identity: it finds no link.
    const b = await signedIn(db, gamecenter("team-b"), NOW, {
      product: productB,
    });
    expect(b.created).toBe(true);
    expect(b.account.id).not.toBe(a.account.id);
    // Team A's identity presented to team B's product is refused outright.
    expect(
      await signIn(db, gamecenter("team-a"), NOW, { product: productB }),
    ).toEqual({
      status: "refused",
      reason: "tenant_scope_mismatch",
    });
    // And a tenant-scoped identity is recognised only inside a product of its scope.
    expect(await signIn(db, gamecenter("team-a"), NOW)).toEqual({
      status: "refused",
      reason: "tenant_scope_mismatch",
    });
  });

  it("a sign-in through a product gives it a pairwise subject: stored, random, per product", async () => {
    const { db } = await world();
    await seedProduct(db, "acme");
    await seedProduct(db, "other");
    const viaAcme = await signedIn(db, emailIdentity("ada@example.com"), NOW, {
      product: { slug: "acme" },
    });
    const viaOther = await signedIn(db, emailIdentity("ada@example.com"), NOW, {
      product: { slug: "other" },
    });
    expect(viaAcme.subject).toMatch(PAIRWISE_SUBJECT_PATTERN);
    expect(viaOther.subject).toMatch(PAIRWISE_SUBJECT_PATTERN);
    expect(viaAcme.subject).not.toBe(viaOther.subject);
    expect(viaAcme.subject).not.toContain(viaAcme.account.id);
    expect(await subjectFor(db, viaAcme.account.id, "acme", NOW)).toBe(
      viaAcme.subject,
    );
  });
});

// ── The link engine ──────────────────────────────────────────────────────────────────────────

describe("the link engine", () => {
  it("link_conflict: a link held by another account is refused and nothing moves", async () => {
    const w = await world();
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const b = await signedIn(w.db, oidcIdentity("u-b"));
    const r = await linkIdentity(
      w.ctx(),
      { accountId: a.account.id, authenticatedAt: NOW },
      oidcIdentity("u-b"),
    );
    expect(r).toEqual({ ok: false, error: "link_conflict" });
    const owner = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM account_links WHERE subject = 'u-b'",
    );
    expect(owner?.account_id).toBe(b.account.id);
  });

  it("connects under step-up, audits and emails every verified address", async () => {
    const w = await world();
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const stale = await linkIdentity(
      w.ctx(),
      { accountId: a.account.id, authenticatedAt: NOW - 301 },
      oidcIdentity("u-new"),
    );
    expect(stale).toEqual({ ok: false, error: "step_up_required" });
    const ok = await linkIdentity(
      w.ctx(),
      { accountId: a.account.id, authenticatedAt: NOW - 60 },
      oidcIdentity("u-new"),
    );
    expect(ok.ok).toBe(true);
    expect(w.sent.map((m) => m.to)).toEqual(["a@example.com"]);
    expect(w.sent[0]!.subject).toMatch(/was connected/);
    const audit = await w.db.all<{ action: string }>(
      "SELECT action FROM portal_audit WHERE account_id = ? AND action LIKE 'account.link.%'",
      a.account.id,
    );
    expect(audit.map((r) => r.action)).toEqual(["account.link.add"]);
    // Idempotent for the same account.
    expect(
      await linkIdentity(
        w.ctx(),
        { accountId: a.account.id, authenticatedAt: NOW },
        oidcIdentity("u-new"),
      ),
    ).toMatchObject({ ok: true, already: true });
  });

  it("last_link: the last sign-in method cannot be removed; any other can, under step-up", async () => {
    const w = await world();
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const [only] = await w.db.all<{ id: string }>(
      "SELECT id FROM account_links WHERE account_id = ?",
      a.account.id,
    );
    const proof = { accountId: a.account.id, authenticatedAt: NOW };
    expect(await unlinkIdentity(w.ctx(), proof, only!.id)).toEqual({
      ok: false,
      error: "last_link",
    });
    const added = await linkIdentity(w.ctx(), proof, oidcIdentity("u-2"));
    if (!added.ok) throw new Error("link failed");
    expect(
      await unlinkIdentity(
        w.ctx(),
        { ...proof, authenticatedAt: NOW - 600 },
        added.link.id,
      ),
    ).toEqual({ ok: false, error: "step_up_required" });
    w.sent.length = 0;
    expect(await unlinkIdentity(w.ctx(), proof, only!.id)).toEqual({
      ok: true,
    });
    // The removed address hears about it too.
    expect(w.sent.map((m) => m.to)).toContain("a@example.com");
    expect(w.sent[0]!.subject).toMatch(/disconnected/);
    expect(await unlinkIdentity(w.ctx(), proof, added.link.id)).toEqual({
      ok: false,
      error: "last_link",
    });
  });

  it("a removal that loses a race to a move is not_found, never only_email, without the email rule", async () => {
    const w = await world();
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const b = await signedIn(w.db, emailIdentity("b@example.com"));
    const proof = { accountId: a.account.id, authenticatedAt: NOW };
    const moving = await linkIdentity(w.ctx(), proof, oidcIdentity("u-2"));
    if (!moving.ok) throw new Error("link failed");
    expect((await linkIdentity(w.ctx(), proof, oidcIdentity("u-3"))).ok).toBe(
      true,
    );
    // The method moves to another account between the read and the DELETE (a join's undo).
    const racy = Object.create(w.db) as Db;
    racy.batch = async (stmts) => {
      await w.db.run(
        "UPDATE account_links SET account_id = ? WHERE id = ?",
        b.account.id,
        moving.link.id,
      );
      return w.db.batch(stmts);
    };
    expect(
      await unlinkIdentity({ ...w.ctx(), db: racy }, proof, moving.link.id),
    ).toEqual({ ok: false, error: "not_found" });
    const held = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM account_links WHERE id = ?",
      moving.link.id,
    );
    expect(held?.account_id).toBe(b.account.id);
  });
});

// ── Merge ─────────────────────────────────────────────────────────────────────────────────────

describe("merge with proof of both", () => {
  afterEach(() => unregisterSubjectStore("test-store"));

  it("never merges without two fresh sign-ins", async () => {
    const w = await world();
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const b = await signedIn(w.db, emailIdentity("b@example.com"));
    for (const [sa, sb] of [
      [NOW - 301, NOW],
      [NOW, NOW - 301],
      [NOW - 3600, NOW - 3600],
    ] as const) {
      expect(
        await mergeAccounts(w.ctx(), {
          survivor: { accountId: a.account.id, authenticatedAt: sa },
          absorbed: { accountId: b.account.id, authenticatedAt: sb },
        }),
      ).toEqual({ ok: false, reason: "step_up_required" });
    }
    expect(
      await mergeAccounts(w.ctx(), {
        survivor: { accountId: a.account.id, authenticatedAt: NOW },
        absorbed: { accountId: a.account.id, authenticatedAt: NOW },
      }),
    ).toEqual({ ok: false, reason: "same_account" });
    expect(await w.db.all("SELECT id FROM accounts ORDER BY id")).toHaveLength(
      2,
    );
  });

  it("keeps the absorbed subject resolvable as an alias for each product, moves links and licences, and tombstones the absorbed account", async () => {
    const w = await world();
    await seedProduct(w.db, "acme");
    await seedProduct(w.db, "other");
    await seedFloating(w.db, "acme", "lic-a");
    await seedFloating(w.db, "acme", "lic-b");
    await seedFloating(w.db, "other", "lic-o");
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const b = await signedIn(w.db, emailIdentity("b@example.com"));
    const merges: Array<{ product: string; from: string; to: string }> = [];
    registerSubjectStore("test-store", {
      merge: async (_ctx, args) => {
        merges.push(args);
      },
      delete: async () => {},
    });

    // Both touched acme; only the absorbed account touched other.
    await attachLicense(w.ctx(), {
      accountId: a.account.id,
      product: "acme",
      licenseId: "lic-a",
      via: "key",
    });
    await attachLicense(w.ctx(), {
      accountId: b.account.id,
      product: "acme",
      licenseId: "lic-b",
      via: "key",
    });
    await attachLicense(w.ctx(), {
      accountId: b.account.id,
      product: "other",
      licenseId: "lic-o",
      via: "key",
    });
    const subjA = await subjectFor(w.db, a.account.id, "acme", NOW);
    const subjB = await subjectFor(w.db, b.account.id, "acme", NOW);
    const subjOther = await subjectFor(w.db, b.account.id, "other", NOW);
    // A device signed in with the absorbed subject.
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject)
       VALUES ('acme', 'dev-b', 'lic-b', 'authorized', ?, ?, ?)`,
      NOW,
      NOW,
      subjB,
    );
    await w.db.run(
      `INSERT INTO registry_tokens (product, token_id, token_hash, hint, label, scopes_json, binding,
         license_id, created_by, portal_account_id, created_at, expires_at)
       VALUES ('acme', 'rtok_b', 'hb', 'abcd', 'b', '["read"]', 'license', 'lic-b', ?, ?, ?, ?)`,
      `portal:${b.account.id}`,
      b.account.id,
      NOW,
      NOW + 86400,
    );

    const r = await mergeAccounts(w.ctx(), {
      survivor: { accountId: a.account.id, authenticatedAt: NOW - 10 },
      absorbed: { accountId: b.account.id, authenticatedAt: NOW - 20 },
    });
    expect(r).toEqual({
      ok: true,
      products: [
        { product: "acme", subject: subjA, alias: subjB },
        { product: "other", subject: subjOther, alias: null },
      ],
      // PX-W12: the join's undo handle and window.
      mergeId: expect.stringMatching(/^amrg_/),
      undoUntil: NOW + MERGE_UNDO_SECONDS,
    });
    // The survivor's subject wins; the absorbed one is an alias of it.
    expect(await resolveSubject(w.db, "acme", subjB)).toBe(subjA);
    expect(await resolveSubject(w.db, "acme", subjA)).toBe(subjA);
    expect(await resolveSubject(w.db, "other", subjOther)).toBe(subjOther);
    expect(await accountForSubject(w.db, "acme", subjB)).toBe(a.account.id);
    expect(merges).toEqual([{ product: "acme", from: subjB, to: subjA }]);
    // Licences and links moved; the device is re-keyed; the developer hears subject.merged.
    const owned = await w.db.all<{ id: string }>(
      "SELECT id FROM licenses WHERE account_id = ? ORDER BY id",
      a.account.id,
    );
    expect(owned.map((l) => l.id)).toEqual(["lic-a", "lic-b", "lic-o"]);
    expect(
      (
        await w.db.all(
          "SELECT id FROM account_links WHERE account_id = ?",
          a.account.id,
        )
      ).length,
    ).toBe(2);
    expect((await getDevice(w.db, "acme", "dev-b"))?.subject).toBe(subjA);
    const events = await w.db.all<{
      type: string;
      subject: string;
      payload_json: string;
    }>(
      "SELECT type, subject, payload_json FROM subject_events WHERE product = 'acme'",
    );
    expect(events).toEqual([
      {
        type: "subject.merged",
        subject: subjA,
        payload_json: JSON.stringify({ alias: subjB }),
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(a.account.id);
    expect(JSON.stringify(events)).not.toContain(b.account.id);
    // The absorbed account is a tombstone redirecting to the survivor for 30 days.
    expect(
      await w.db.first("SELECT id FROM accounts WHERE id = ?", b.account.id),
    ).toBeNull();
    expect((await resolveAccount(w.db, b.account.id, NOW + 86400))?.id).toBe(
      a.account.id,
    );
    expect(
      await resolveAccount(w.db, b.account.id, NOW + 31 * 86400),
    ).toBeNull();
    const row = await w.db.first<{ portal_account_id: string }>(
      "SELECT portal_account_id FROM registry_tokens WHERE token_id = 'rtok_b'",
    );
    expect(row?.portal_account_id).toBe(a.account.id);
    // Both accounts' addresses were told.
    expect(w.sent.map((m) => m.to).sort()).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });
});

// ── Licence claim rules ──────────────────────────────────────────────────────────────────────

describe("licence claim rules", () => {
  it("license_owned: an owned licence never moves by key, by device, or by email match", async () => {
    const w = await world();
    await seedProduct(w.db, "acme");
    await seedFloating(w.db, "acme", "lic-1");
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const b = await signedIn(w.db, emailIdentity("b@example.com"));
    expect(
      await attachLicense(w.ctx(), {
        accountId: a.account.id,
        product: "acme",
        licenseId: "lic-1",
        via: "key",
      }),
    ).toMatchObject({ ok: true, attached: true });
    for (const via of ["key", "device", "email", "oidc"] as const) {
      expect(
        await attachLicense(w.ctx(), {
          accountId: b.account.id,
          product: "acme",
          licenseId: "lic-1",
          via,
        }),
      ).toEqual({ ok: false, reason: "license_owned" });
    }
    // Idempotent for the owner, and the owner pointer never changed.
    expect(
      await attachLicense(w.ctx(), {
        accountId: a.account.id,
        product: "acme",
        licenseId: "lic-1",
        via: "key",
      }),
    ).toMatchObject({ ok: true, attached: false });
    const row = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM licenses WHERE id = 'lic-1'",
    );
    expect(row?.account_id).toBe(a.account.id);
  });

  it("an email-carrying licence cannot be attached by key unless claimByKey, and attaching notifies the licence email", async () => {
    const w = await world();
    await seedProduct(w.db, "acme");
    await seedFloating(w.db, "acme", "lic-1", "buyer@example.com");
    const a = await signedIn(w.db, emailIdentity("someone@example.com"));
    expect(
      await attachLicense(w.ctx(), {
        accountId: a.account.id,
        product: "acme",
        licenseId: "lic-1",
        via: "key",
      }),
    ).toEqual({
      ok: false,
      reason: "license_email_bound",
      email: "buyer@example.com",
    });
    expect(
      await attachLicense(w.ctx(), {
        accountId: a.account.id,
        product: "acme",
        licenseId: "lic-1",
        via: "device",
      }),
    ).toMatchObject({ ok: false, reason: "license_email_bound" });
    expect(w.sent).toEqual([]);

    await upsertPortalProductSettings(w.db, "acme", { claimByKey: true }, NOW);
    const ok = await attachLicense(w.ctx(), {
      accountId: a.account.id,
      product: "acme",
      licenseId: "lic-1",
      via: "key",
    });
    expect(ok).toMatchObject({ ok: true, attached: true });
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.subject).toMatch(PAIRWISE_SUBJECT_PATTERN);
    expect(w.sent.map((m) => m.to)).toEqual(["buyer@example.com"]);
    expect(w.sent[0]!.subject).toMatch(/added to a Polaris Key account/);
  });

  it("an account that verified the licence's email attaches it without claimByKey and is not emailed about itself", async () => {
    const w = await world();
    await seedProduct(w.db, "acme");
    await seedFloating(w.db, "acme", "lic-1", "Buyer@Example.com");
    const a = await signedIn(w.db, emailIdentity("buyer@example.com"));
    expect(
      await attachLicense(w.ctx(), {
        accountId: a.account.id,
        product: "acme",
        licenseId: "lic-1",
        via: "key",
      }),
    ).toMatchObject({ ok: true, attached: true });
    expect(w.sent).toEqual([]);
  });

  it("detach makes the licence floating, revokes the account's registry tokens for it, and keeps the device binding", async () => {
    const w = await world();
    await seedProduct(w.db, "acme");
    await seedFloating(w.db, "acme", "lic-1");
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const attached = await attachLicense(w.ctx(), {
      accountId: a.account.id,
      product: "acme",
      licenseId: "lic-1",
      via: "key",
    });
    if (!attached.ok) throw new Error("attach failed");
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, bound_by)
       VALUES ('acme', 'dev-1', 'lic-1', 'authorized', ?, ?, ?, 'signin')`,
      NOW,
      NOW,
      attached.subject,
    );
    await w.db.run(
      `INSERT INTO registry_tokens (product, token_id, token_hash, hint, label, scopes_json, binding,
         license_id, created_by, portal_account_id, created_at, expires_at)
       VALUES ('acme', 'rtok_1', 'h1', 'abcd', 'mine', '["read"]', 'license', 'lic-1', ?, ?, ?, ?)`,
      `portal:${a.account.id}`,
      a.account.id,
      NOW,
      NOW + 86400,
    );
    expect(
      await detachLicense(w.ctx(), {
        accountId: a.account.id,
        product: "acme",
        licenseId: "lic-1",
      }),
    ).toEqual({ ok: true });
    const lic = await w.db.first<{ account_id: string | null }>(
      "SELECT account_id FROM licenses WHERE id = 'lic-1'",
    );
    expect(lic?.account_id).toBeNull();
    const tok = await w.db.first<{
      revoked_at: number | null;
      revoke_reason: string | null;
    }>(
      "SELECT revoked_at, revoke_reason FROM registry_tokens WHERE token_id = 'rtok_1'",
    );
    expect(tok).toEqual({ revoked_at: NOW, revoke_reason: "link_removed" });
    // S-17 §5.8 item 2: a plain detach signs nobody out.
    expect((await getDevice(w.db, "acme", "dev-1"))?.subject).toBe(
      attached.subject,
    );
  });

  it("the reassign primitive moves a licence, clears the old owner's bindings, and is undone by passing the previous owner back", async () => {
    const w = await world();
    await seedProduct(w.db, "acme");
    await seedFloating(w.db, "acme", "lic-1");
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const b = await signedIn(w.db, emailIdentity("b@example.com"));
    const attached = await attachLicense(w.ctx(), {
      accountId: a.account.id,
      product: "acme",
      licenseId: "lic-1",
      via: "key",
    });
    if (!attached.ok) throw new Error("attach failed");
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, bound_by)
       VALUES ('acme', 'dev-1', 'lic-1', 'authorized', ?, ?, ?, 'key')`,
      NOW,
      NOW,
      attached.subject,
    );
    const moved = await reassignLicense(w.ctx(), {
      product: "acme",
      licenseId: "lic-1",
      toAccountId: b.account.id,
      actor: "admin:op",
    });
    expect(moved).toEqual({ ok: true, previousAccountId: a.account.id });
    expect(
      (await getDevice(w.db, "acme", "dev-1"))?.subject ?? null,
    ).toBeNull();
    const undo = await reassignLicense(w.ctx(), {
      product: "acme",
      licenseId: "lic-1",
      toAccountId: moved.ok ? moved.previousAccountId : null,
      actor: "admin:op",
    });
    expect(undo).toEqual({ ok: true, previousAccountId: b.account.id });
    const lic = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM licenses WHERE id = 'lic-1'",
    );
    expect(lic?.account_id).toBe(a.account.id);
  });
});

// ── The device binding ───────────────────────────────────────────────────────────────────────

describe("the device binding and Core's clearing hook", () => {
  it("licence-key activation never sets the binding; it records bound_by = key", async () => {
    const w = await world();
    await seedProduct(w.db, "djdl");
    const product = (await loadProduct(w.env, w.db, "djdl"))!;
    const { key, licenseId } = await seedLicenseWithKey(w.db, "djdl");
    const a = await signedIn(w.db, emailIdentity("ada@example.com"));
    // Even when the licence is owned by an account, key entry binds no subject.
    await attachLicense(w.ctx(), {
      accountId: a.account.id,
      product: "djdl",
      licenseId,
      via: "key",
    });
    const res = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-1",
      }),
      w.env,
      w.db,
      product,
      NOW,
    );
    expect(res.status).toBe(200);
    const device = await getDevice(w.db, "djdl", "dev-1");
    expect(device?.subject ?? null).toBeNull();
    expect(device?.bound_by).toBe("key");
    const { token } = (await res.json()) as { token: string };
    const rec = await getTokenRecord(
      w.env,
      "djdl",
      await hashKey(token, w.env.KEY_HASH_PEPPER),
    );
    expect(rec?.subject).toBeUndefined();
  });

  it("sign-out clears the binding; it releases the device only when the sign-in bound it to that account's licence", async () => {
    const w = await world();
    await seedProduct(w.db, "djdl");
    // A binding needs Identity on (PX-W17's bind guard).
    await setIdentityServices(w.db, "djdl", { license: true, identity: true });
    const product = (await loadProduct(w.env, w.db, "djdl"))!;
    const { key, licenseId } = await seedLicenseWithKey(w.db, "djdl");
    const a = await signedIn(w.db, emailIdentity("ada@example.com"), NOW, {
      product: { slug: "djdl" },
    });
    await attachLicense(w.ctx(), {
      accountId: a.account.id,
      product: "djdl",
      licenseId,
      via: "key",
    });
    const activated = (await (
      await handleActivate(
        mkReq("POST", {
          authorization: `Bearer ${key}`,
          "x-pkey-device": "dev-key",
        }),
        w.env,
        w.db,
        product,
        NOW,
      )
    ).json()) as { token: string };
    // A key-bound device that later signs in.
    expect(
      await setDeviceSubject(w.env, w.db, "djdl", "dev-key", a.subject!),
    ).toBe(true);
    const hash = await hashKey(activated.token, w.env.KEY_HASH_PEPPER);
    expect((await getTokenRecord(w.env, "djdl", hash))?.subject).toBe(
      a.subject,
    );
    // A device the sign-in itself bound.
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, bound_by, token_hash)
       VALUES ('djdl', 'dev-signin', ?, 'authorized', ?, ?, ?, 'signin', 'th-signin')`,
      licenseId,
      NOW,
      NOW,
      a.subject,
    );

    const keyOut = await clearDeviceSubjects(
      w.db,
      w.env,
      { kind: "device", product: "djdl", deviceId: "dev-key" },
      "signout",
    );
    expect(keyOut).toEqual({ cleared: 1, released: [] });
    const keyDevice = await getDevice(w.db, "djdl", "dev-key");
    expect(keyDevice?.subject ?? null).toBeNull();
    expect(keyDevice?.status).toBe("authorized");
    expect(
      (await getTokenRecord(w.env, "djdl", hash))?.subject,
    ).toBeUndefined();

    const signinOut = await clearDeviceSubjects(
      w.db,
      w.env,
      { kind: "device", product: "djdl", deviceId: "dev-signin" },
      "signout",
    );
    expect(signinOut).toEqual({ cleared: 1, released: ["djdl:dev-signin"] });
    expect((await getDevice(w.db, "djdl", "dev-signin"))?.status).toBe(
      "deauthorized",
    );
  });

  it("subjectFor resolves the licence owner's subject for a product with the Identity toggle off", async () => {
    const w = await world();
    await seedProduct(w.db, "acme");
    await setIdentityServices(w.db, "acme", { license: true, identity: false });
    await seedFloating(w.db, "acme", "lic-1");
    expect(await licenseOwnerSubject(w.db, "acme", "lic-1", NOW)).toBeNull();
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    await attachLicense(w.ctx(), {
      accountId: a.account.id,
      product: "acme",
      licenseId: "lic-1",
      via: "key",
    });
    const owner = await licenseOwnerSubject(w.db, "acme", "lic-1", NOW);
    expect(owner).toMatch(PAIRWISE_SUBJECT_PATTERN);
    expect(owner).toBe(await subjectFor(w.db, a.account.id, "acme", NOW));
  });

  it("an Identity-only product signs in without a licenses row", async () => {
    const w = await world();
    await seedProduct(w.db, "idonly");
    await setIdentityServices(w.db, "idonly", {
      license: false,
      identity: true,
    });
    const product = (await loadProduct(w.env, w.db, "idonly"))!;
    const r = await signedIn(w.db, oidcIdentity("u1", "ada@example.com"), NOW, {
      product: { slug: "idonly" },
    });
    const { token, device } = await registerDeviceBinding(
      w.env,
      w.db,
      product,
      "dev-1",
      NOW,
      {
        existing: null,
        presented: null,
        metadata: {
          userAgent: null,
          platform: null,
          arch: null,
          appVersion: null,
          sdkName: null,
          sdkVersion: null,
        },
        boundBy: "signin",
        subject: r.subject,
      },
    );
    expect(token).toMatch(/^pkeyt_/);
    expect(device.license_id).toBe("");
    const stored = await getDevice(w.db, "idonly", "dev-1");
    expect(stored?.subject).toBe(r.subject);
    expect(stored?.bound_by).toBe("signin");
    expect(
      await w.db.all("SELECT id FROM licenses WHERE product = 'idonly'"),
    ).toEqual([]);
  });
});

// ── Deletion and per-product removal ─────────────────────────────────────────────────────────

describe("deletion and per-product removal call the registered stores first", () => {
  afterEach(() => unregisterSubjectStore("test-store"));

  it("account deletion: stores delete, bindings clear, licences detach, subject.deleted carries the licence ids", async () => {
    const w = await world();
    await seedProduct(w.db, "acme");
    await seedFloating(w.db, "acme", "lic-1");
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const attached = await attachLicense(w.ctx(), {
      accountId: a.account.id,
      product: "acme",
      licenseId: "lic-1",
      via: "key",
    });
    if (!attached.ok) throw new Error("attach failed");
    const seen: string[] = [];
    registerSubjectStore("test-store", {
      merge: async () => {},
      delete: async ({ db }, { product, subject }) => {
        // Called while the subject still resolves.
        seen.push(
          `${product}:${(await resolveSubject(db, product, subject)) ?? "gone"}`,
        );
      },
    });
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, bound_by)
       VALUES ('acme', 'dev-1', 'lic-1', 'authorized', ?, ?, ?, 'key')`,
      NOW,
      NOW,
      attached.subject,
    );
    expect(await deleteAccount(w.ctx(), a.account.id)).toEqual({ ok: true });
    expect(seen).toEqual([`acme:${attached.subject}`]);
    expect(await resolveSubject(w.db, "acme", attached.subject)).toBeNull();
    expect(
      (await getDevice(w.db, "acme", "dev-1"))?.subject ?? null,
    ).toBeNull();
    const lic = await w.db.first<{
      account_id: string | null;
      email: string | null;
    }>("SELECT account_id, email FROM licenses WHERE id = 'lic-1'");
    expect(lic?.account_id).toBeNull();
    const events = await w.db.all<{ type: string; payload_json: string }>(
      "SELECT type, payload_json FROM subject_events WHERE product = 'acme'",
    );
    expect(events).toEqual([
      {
        type: "subject.deleted",
        payload_json: JSON.stringify({ licenseIds: ["lic-1"], detached: true }),
      },
    ]);
    for (const table of [
      "accounts",
      "account_links",
      "account_product_subjects",
    ]) {
      const col = table === "accounts" ? "id" : "account_id";
      expect(
        await w.db.first(
          `SELECT 1 FROM ${table} WHERE ${col} = ?`,
          a.account.id,
        ),
      ).toBeNull();
    }
    expect(
      await w.db.first<{ merged_into: string | null }>(
        "SELECT merged_into FROM account_tombstones WHERE id = ?",
        a.account.id,
      ),
    ).toEqual({ merged_into: null });
  });

  it("per-product removal keeps the licence unless also removed, and the next contact gets a fresh subject", async () => {
    const w = await world();
    await seedProduct(w.db, "acme");
    await seedFloating(w.db, "acme", "lic-1");
    const a = await signedIn(w.db, emailIdentity("a@example.com"));
    const attached = await attachLicense(w.ctx(), {
      accountId: a.account.id,
      product: "acme",
      licenseId: "lic-1",
      via: "key",
    });
    if (!attached.ok) throw new Error("attach failed");
    const deleted: string[] = [];
    registerSubjectStore("test-store", {
      merge: async () => {},
      delete: async (_ctx, { subject }) => {
        deleted.push(subject);
      },
    });
    expect(
      await removeProductData(w.ctx(), {
        accountId: a.account.id,
        product: "acme",
        alsoDetachLicenses: false,
      }),
    ).toEqual({ ok: true, detached: [] });
    expect(deleted).toEqual([attached.subject]);
    expect(await resolveSubject(w.db, "acme", attached.subject)).toBeNull();
    // D25: the licence stays, so the next contact re-creates a (fresh) subject for it.
    const fresh = await licenseOwnerSubject(w.db, "acme", "lic-1", NOW);
    expect(fresh).toMatch(PAIRWISE_SUBJECT_PATTERN);
    expect(fresh).not.toBe(attached.subject);
    expect(
      await removeProductData(w.ctx(), {
        accountId: a.account.id,
        product: "acme",
        alsoDetachLicenses: true,
      }),
    ).toEqual({ ok: true, detached: ["lic-1"] });
    const lic = await w.db.first<{ account_id: string | null }>(
      "SELECT account_id FROM licenses WHERE id = 'lic-1'",
    );
    expect(lic?.account_id).toBeNull();
  });
});
