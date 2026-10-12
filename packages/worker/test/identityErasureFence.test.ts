/**
 * I-11: the request-time erasure fence at the sign-in and account doors.
 *
 * A D1 Time Travel restore rewinds the database but not R2, so an erased account comes back as
 * `active` with its links, subjects and licences while the ledger (`erasures/<id>` in `BLOBS`)
 * still names it. Until the cron replay re-erases it, only the fence (`erasureVerdict`) says it is
 * gone. Every gate here is exercised in that window (`eraseAndRestore`) and after the replay, with
 * an unreadable and an unbound ledger, and against an account that is NOT on the ledger in the same
 * world so that a gate that refuses everybody cannot pass:
 *
 *   - `signIn`: the existing-link branch (and a merge survivor), the join offer, `unfenced`;
 *   - the card's email code and magic link, through the real portal router;
 *   - the email gate's `gatePass` for an existing account (refused before the gate is consumed);
 *   - `linkIdentity`, `mergeAccounts`, `undoMerge`, `relinkLicense`.
 */
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { asR2 } from "./r2Mock.js";
import { eraseAndRestore, LedgerBucket } from "./eraseRestore.js";
import { snapshotDb } from "./d1Restore.js";
import {
  Device,
  lastLink,
  seededWorld,
  type CardWorld,
} from "./identityCardHarness.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { insertLicense } from "../src/core/repo.js";
import { subjectFor } from "../src/core/accounts/accountSubjects.js";
import { erasureKey } from "../src/core/accounts/erasureFence.js";
import {
  ACCOUNT_SESSION_COOKIE,
  EMAIL_GATE_COOKIE,
} from "../src/core/accounts/accountCookies.js";
import {
  signIn,
  type SignInOptions,
  type SignInResult,
  type VerifiedIdentity,
} from "../src/services/identity/accounts/signIn.js";
import {
  linkIdentity,
  type AccountContext,
} from "../src/services/identity/accounts/links.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import { undoMerge } from "../src/services/identity/accounts/mergeUndo.js";
import { attachLicense } from "../src/services/identity/accounts/claim.js";
import { relinkLicense } from "../src/services/identity/accounts/productUsers.js";
import { replayErasures } from "../src/services/identity/accounts/deletion.js";
import {
  getAccountRow,
  insertAccount,
  insertLink,
} from "../src/services/identity/accounts/repo.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import {
  beginProviderSignIn,
  EMAIL_GATE_LANDING,
  type ProviderSignIn,
} from "../src/services/identity/card/gate.js";
import { ACCOUNT_DISABLED_MESSAGE } from "../src/services/identity/card/http.js";

const ORIGIN = "https://key.plrs.im";
const ISSUER = "https://id.example";
const GOOGLE = "https://accounts.google.com";
const ADA = "ada@example.com";
const BOB = "bob@example.com";
const CY = "cy@example.com";
const DEE = "dee@example.com";

const REFUSED: SignInResult = {
  status: "refused",
  reason: "account_disabled",
};

const ctxOf = (db: Db, env: Env, now = NOW): AccountContext => ({
  db,
  env,
  now,
  origin: ORIGIN,
});

/**
 * A new Worker isolate over the same ledger: the bucket holds what it held, but the fence's memory
 * of what the old isolate erased (it is kept per binding) is gone, so every answer is read from R2
 * again. Rebinds `env.BLOBS` and answers the new bucket.
 */
async function coldIsolate(
  env: Env,
  from: LedgerBucket,
): Promise<LedgerBucket> {
  const next = new LedgerBucket();
  for (const key of from.keys()) {
    const object = await from.get(key);
    if (object && "text" in object) await next.put(key, await object.text());
  }
  env.BLOBS = asR2(next);
  return next;
}

const emailIdentity = (email: string): VerifiedIdentity => ({
  issuerKey: "email",
  subject: email,
  kind: "email",
});

const oidcIdentity = (sub: string, email?: string): VerifiedIdentity => ({
  issuerKey: ISSUER,
  subject: sub,
  kind: "oidc",
  email: email ?? null,
  emailVerified: Boolean(email),
});

type SignedIn = Extract<SignInResult, { status: "signed_in" }>;

async function signedIn(
  db: Db,
  identity: VerifiedIdentity,
  opts: SignInOptions = { unfenced: true },
  now = NOW,
): Promise<SignedIn> {
  const r = await signIn(db, identity, now, opts);
  if (r.status !== "signed_in")
    throw new Error(`expected signed_in, got ${r.status}`);
  return r;
}

async function seedFloating(db: Db, product: string, id: string) {
  await insertLicense(db, {
    product,
    id,
    status: "active",
    sub: null,
    name: null,
    email: null,
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

const proof = (accountId: string, authenticatedAt = NOW) => ({
  accountId,
  authenticatedAt,
});
const pair = (survivor: string, absorbed: string) => ({
  survivor: proof(survivor),
  absorbed: proof(absorbed),
});

async function count(db: Db, sql: string, ...params: string[]) {
  return (await db.first<{ n: number }>(sql, ...params))?.n ?? 0;
}

// ── The account layer ─────────────────────────────────────────────────────────────────────────

interface World {
  db: Db;
  env: Env;
  /** The ledger the fence reads; `coldIsolate` replaces it. */
  bucket: LedgerBucket;
  sent: Array<{ to: string; subject: string }>;
  ctx: (now?: number) => AccountContext;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["acme"]);
  const bucket = new LedgerBucket();
  env.BLOBS = asR2(bucket);
  const sent: Array<{ to: string; subject: string }> = [];
  env.EMAIL = {
    send: async (m: { to: string; subject: string }) => {
      sent.push({ to: m.to, subject: m.subject });
    },
  } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  await seedProduct(db, "acme");
  await seedProduct(db, "other");
  const w: World = {
    db,
    env,
    bucket,
    sent,
    ctx: (now = NOW) => ctxOf(db, env, now),
  };
  return w;
}

/**
 * Ada, restored from an erasure the ledger still holds, and Bob, who never was on it. Ada signed in
 * through `acme` before the erasure, so she holds an `acme` subject; nobody has used `other`.
 */
async function adaErasedBobLive(w: World) {
  const ada = await signedIn(w.db, emailIdentity(ADA), {
    unfenced: true,
    product: { slug: "acme" },
  });
  const bob = await signedIn(w.db, emailIdentity(BOB), { unfenced: true });
  await eraseAndRestore(w.ctx(), ada.account.id);
  // The window: D1 says `active` again, the ledger says erased.
  expect((await getAccountRow(w.db, ada.account.id))?.status).toBe("active");
  expect(w.bucket.has(erasureKey(ada.account.id))).toBe(true);
  return { ada: ada.account.id, bob: bob.account.id };
}

describe("signIn through an existing link", () => {
  it("refuses an erased account restored by D1 and writes nothing, in the window and after the replay", async () => {
    const w = await world();
    const { ada, bob } = await adaErasedBobLive(w);
    const restored = await snapshotDb(w.db);

    for (const product of [undefined, { slug: "acme" }, { slug: "other" }]) {
      expect(
        await signIn(w.db, emailIdentity(ADA), NOW + 150, {
          env: w.env,
          product,
        }),
      ).toEqual(REFUSED);
    }
    // Nothing: no touched link, no audit row, no session, no pairwise subject for a new product.
    expect(await snapshotDb(w.db)).toEqual(restored);
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM account_product_subjects WHERE account_id = ? AND product = 'other'",
        ada,
      ),
    ).toBe(0);

    // The same world signs somebody who is not on the ledger in, subject and audit row included.
    const control = await signIn(w.db, emailIdentity(BOB), NOW + 150, {
      env: w.env,
      product: { slug: "acme" },
    });
    expect(control).toMatchObject({
      status: "signed_in",
      created: false,
      account: { id: bob },
      subject: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    });

    // What both cron ticks run: the account is erased in D1 for real. The person who signs in again
    // is a fresh account, and the erased id stays on the ledger.
    expect(await replayErasures(w.ctx(NOW + 200))).toMatchObject({
      reapplied: 1,
      failures: [],
    });
    expect(await getAccountRow(w.db, ada)).toBeNull();
    const again = await signIn(w.db, emailIdentity(ADA), NOW + 300, {
      env: w.env,
    });
    expect(again).toMatchObject({ status: "signed_in", created: true });
    if (again.status === "signed_in") expect(again.account.id).not.toBe(ada);
    expect(w.bucket.has(erasureKey(ada))).toBe(true);
  });

  it("refuses the same way when the ledger cannot be read, writing nothing, and recovers when it can", async () => {
    const w = await world();
    const { ada, bob } = await adaErasedBobLive(w);
    // A new isolate: it has not seen the erasure, so everything is read from R2.
    w.bucket = await coldIsolate(w.env, w.bucket);
    w.bucket.down = true;
    const restored = await snapshotDb(w.db);

    for (const who of [ADA, BOB]) {
      expect(
        await signIn(w.db, emailIdentity(who), NOW + 150, {
          env: w.env,
          product: { slug: "acme" },
        }),
      ).toEqual(REFUSED);
    }
    expect(await snapshotDb(w.db)).toEqual(restored);
    expect(w.bucket.heads).toContain(erasureKey(ada));
    expect(w.bucket.heads).toContain(erasureKey(bob));

    // R2 answers again: Bob is let in, Ada is on the ledger.
    w.bucket.down = false;
    expect(
      await signIn(w.db, emailIdentity(BOB), NOW + 160, { env: w.env }),
    ).toMatchObject({ status: "signed_in", account: { id: bob } });
    expect(
      await signIn(w.db, emailIdentity(ADA), NOW + 160, { env: w.env }),
    ).toEqual(REFUSED);
  });

  it("refuses everybody when BLOBS is unbound, and lets Bob in once it is bound", async () => {
    const w = await world();
    const { bob } = await adaErasedBobLive(w);
    const restored = await snapshotDb(w.db);
    const bound = w.env.BLOBS;
    delete w.env.BLOBS;

    for (const who of [ADA, BOB]) {
      expect(
        await signIn(w.db, emailIdentity(who), NOW + 150, { env: w.env }),
      ).toEqual(REFUSED);
    }
    expect(await snapshotDb(w.db)).toEqual(restored);

    w.env.BLOBS = bound;
    expect(
      await signIn(w.db, emailIdentity(BOB), NOW + 160, { env: w.env }),
    ).toMatchObject({ status: "signed_in", account: { id: bob } });
  });

  it("`unfenced` reads no ledger: it still signs the restored account in (what the flag means)", async () => {
    const w = await world();
    const { ada } = await adaErasedBobLive(w);
    const heads = w.bucket.heads.length;
    expect(
      await signIn(w.db, emailIdentity(ADA), NOW + 150, { unfenced: true }),
    ).toMatchObject({ status: "signed_in", account: { id: ada } });
    expect(w.bucket.heads).toHaveLength(heads);
  });

  it("asks about the merge survivor too: a link still on an absorbed account whose survivor is erased is refused", async () => {
    const w = await world();
    const s = await signedIn(w.db, emailIdentity(ADA));
    const b = await signedIn(w.db, emailIdentity(BOB));
    const c = await signedIn(w.db, emailIdentity(CY));
    const d = await signedIn(w.db, emailIdentity(DEE));
    for (const [survivor, absorbed] of [
      [s, b],
      [c, d],
    ] as const) {
      expect(
        (
          await mergeAccounts(
            w.ctx(),
            pair(survivor.account.id, absorbed.account.id),
          )
        ).ok,
      ).toBe(true);
    }
    // A method that still names the absorbed account (the join tombstoned it, redirecting to the
    // survivor): the ledger knows only the survivor.
    await w.db.run("PRAGMA foreign_keys = OFF");
    for (const [email, id] of [
      [BOB, b.account.id],
      [DEE, d.account.id],
    ] as const) {
      await w.db.run(
        "UPDATE account_links SET account_id = ? WHERE issuer_key = 'email' AND subject = ?",
        id,
        email,
      );
    }
    await w.db.run("PRAGMA foreign_keys = ON");
    expect(await getAccountRow(w.db, b.account.id)).toBeNull();

    await eraseAndRestore(w.ctx(NOW + 100), s.account.id);
    const restored = await snapshotDb(w.db);
    expect(
      await signIn(w.db, emailIdentity(BOB), NOW + 150, { env: w.env }),
    ).toEqual(REFUSED);
    expect(await snapshotDb(w.db)).toEqual(restored);
    // The pair whose survivor is not erased signs in, as the survivor.
    expect(
      await signIn(w.db, emailIdentity(DEE), NOW + 150, { env: w.env }),
    ).toMatchObject({ status: "signed_in", account: { id: c.account.id } });
    // Only the fence refused it: the link resolves to an `active` survivor.
    expect(
      await signIn(w.db, emailIdentity(BOB), NOW + 160, { unfenced: true }),
    ).toMatchObject({ status: "signed_in", account: { id: s.account.id } });
  });
});

describe("signIn's join offer", () => {
  it("never offers to join an erased account that came back, writing nothing, in the window and after the replay", async () => {
    const w = await world();
    const { ada, bob } = await adaErasedBobLive(w);
    const restored = await snapshotDb(w.db);

    // A new identity with an address only the restored account uses.
    expect(
      await signIn(w.db, oidcIdentity("u-new", ADA), NOW + 150, {
        env: w.env,
      }),
    ).toEqual(REFUSED);
    expect(await snapshotDb(w.db)).toEqual(restored);
    // The same door offers a join to a live account that uses the address.
    expect(
      await signIn(w.db, oidcIdentity("u-new-2", BOB), NOW + 150, {
        env: w.env,
      }),
    ).toEqual({ status: "join_offer", existingAccountId: bob, email: BOB });
    // Without the fence the restored account is offered (what `unfenced` means).
    expect(
      await signIn(w.db, oidcIdentity("u-new", ADA), NOW + 150, {
        unfenced: true,
        linkedOnly: false,
      }),
    ).toEqual({ status: "join_offer", existingAccountId: ada, email: ADA });
    expect(await snapshotDb(w.db)).toEqual(restored);

    // After the replay no account uses the address any more: the person starts a fresh one, and
    // never the erased one.
    expect(await replayErasures(w.ctx(NOW + 200))).toMatchObject({
      reapplied: 1,
      failures: [],
    });
    const fresh = await signIn(w.db, oidcIdentity("u-new", ADA), NOW + 300, {
      env: w.env,
    });
    expect(fresh).toMatchObject({ status: "signed_in", created: true });
    if (fresh.status === "signed_in") expect(fresh.account.id).not.toBe(ada);
  });

  it("refuses the join offer when the ledger cannot be read (live or erased), then recovers", async () => {
    const w = await world();
    const { ada, bob } = await adaErasedBobLive(w);
    w.bucket = await coldIsolate(w.env, w.bucket);
    w.bucket.down = true;
    const restored = await snapshotDb(w.db);

    for (const [sub, email] of [
      ["u-1", ADA],
      ["u-2", BOB],
    ] as const) {
      expect(
        await signIn(w.db, oidcIdentity(sub, email), NOW + 150, {
          env: w.env,
        }),
      ).toEqual(REFUSED);
    }
    expect(await snapshotDb(w.db)).toEqual(restored);
    expect(w.bucket.heads).toEqual(
      expect.arrayContaining([erasureKey(ada), erasureKey(bob)]),
    );

    w.bucket.down = false;
    expect(
      await signIn(w.db, oidcIdentity("u-2", BOB), NOW + 160, { env: w.env }),
    ).toEqual({ status: "join_offer", existingAccountId: bob, email: BOB });
    expect(
      await signIn(w.db, oidcIdentity("u-1", ADA), NOW + 160, { env: w.env }),
    ).toEqual(REFUSED);
  });
});

describe("linkIdentity, mergeAccounts, undoMerge, relinkLicense", () => {
  it("linkIdentity: an erased account takes no new method; D1 is unchanged; a live one does", async () => {
    const w = await world();
    const { ada, bob } = await adaErasedBobLive(w);
    const restored = await snapshotDb(w.db);

    expect(
      await linkIdentity(w.ctx(), proof(ada), oidcIdentity("u-ada")),
    ).toEqual({ ok: false, error: "not_found" });
    expect(await snapshotDb(w.db)).toEqual(restored);
    expect(w.sent).toEqual([]);

    const linked = await linkIdentity(
      w.ctx(),
      proof(bob),
      oidcIdentity("u-bob"),
    );
    expect(linked).toMatchObject({ ok: true, already: false });

    // After the replay the account is gone from D1; the answer is the same.
    expect(await replayErasures(w.ctx(NOW + 200))).toMatchObject({
      failures: [],
    });
    expect(
      await linkIdentity(
        w.ctx(NOW + 210),
        proof(ada, NOW + 210),
        oidcIdentity("u-ada"),
      ),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("linkIdentity: an unreadable ledger refuses a live account too, then recovers", async () => {
    const w = await world();
    const { ada, bob } = await adaErasedBobLive(w);
    w.bucket = await coldIsolate(w.env, w.bucket);
    w.bucket.down = true;
    const restored = await snapshotDb(w.db);
    for (const id of [ada, bob]) {
      expect(
        await linkIdentity(w.ctx(), proof(id), oidcIdentity(`u-${id}`)),
      ).toEqual({ ok: false, error: "not_found" });
    }
    expect(await snapshotDb(w.db)).toEqual(restored);
    expect(w.sent).toEqual([]);

    w.bucket.down = false;
    expect(
      await linkIdentity(w.ctx(), proof(bob), oidcIdentity("u-bob")),
    ).toMatchObject({ ok: true });
    expect(
      await linkIdentity(w.ctx(), proof(ada), oidcIdentity("u-ada")),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("mergeAccounts: a join with an erased account on either side is account_disabled and moves nothing; two live accounts join", async () => {
    const w = await world();
    const { ada, bob } = await adaErasedBobLive(w);
    const cy = (await signedIn(w.db, emailIdentity(CY))).account.id;
    const dee = (await signedIn(w.db, emailIdentity(DEE))).account.id;
    const restored = await snapshotDb(w.db);

    for (const [survivor, absorbed] of [
      [bob, ada],
      [ada, bob],
    ] as const) {
      expect(await mergeAccounts(w.ctx(), pair(survivor, absorbed))).toEqual({
        ok: false,
        reason: "account_disabled",
      });
    }
    expect(await snapshotDb(w.db)).toEqual(restored);
    expect(w.sent).toEqual([]);

    expect(await mergeAccounts(w.ctx(), pair(cy, dee))).toMatchObject({
      ok: true,
    });

    // After the replay the erased account has no row: still no join.
    expect(await replayErasures(w.ctx(NOW + 200))).toMatchObject({
      failures: [],
    });
    expect(await mergeAccounts(w.ctx(NOW + 210), pair(bob, ada))).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("mergeAccounts: an unreadable ledger refuses a join of two live accounts, then recovers", async () => {
    const w = await world();
    const bob = (await signedIn(w.db, emailIdentity(BOB))).account.id;
    const cy = (await signedIn(w.db, emailIdentity(CY))).account.id;
    w.bucket = await coldIsolate(w.env, w.bucket);
    w.bucket.down = true;
    const before = await snapshotDb(w.db);
    expect(await mergeAccounts(w.ctx(), pair(bob, cy))).toEqual({
      ok: false,
      reason: "account_disabled",
    });
    expect(await snapshotDb(w.db)).toEqual(before);
    expect(w.sent).toEqual([]);
    expect(w.bucket.heads).toEqual(
      expect.arrayContaining([erasureKey(bob), erasureKey(cy)]),
    );

    w.bucket.down = false;
    expect(await mergeAccounts(w.ctx(), pair(bob, cy))).toMatchObject({
      ok: true,
    });
  });

  it("undoMerge: an erased survivor gets nothing rebuilt; another live join undoes", async () => {
    const w = await world();
    const s = (await signedIn(w.db, emailIdentity(ADA))).account.id;
    const b = (await signedIn(w.db, emailIdentity(BOB))).account.id;
    const c = (await signedIn(w.db, emailIdentity(CY))).account.id;
    const d = (await signedIn(w.db, emailIdentity(DEE))).account.id;
    const joined = async (survivor: string, absorbed: string) => {
      const r = await mergeAccounts(w.ctx(), pair(survivor, absorbed));
      if (!r.ok) throw new Error(`merge: ${r.reason}`);
      return r.mergeId;
    };
    const erasedJoin = await joined(s, b);
    const liveJoin = await joined(c, d);

    await eraseAndRestore(w.ctx(), s);
    expect((await getAccountRow(w.db, s))?.status).toBe("active");
    const restored = await snapshotDb(w.db);
    expect(
      await undoMerge(w.ctx(NOW + 60), proof(s, NOW + 60), erasedJoin),
    ).toEqual({ ok: false, error: "not_found" });
    // The absorbed account was not rebuilt, and nothing else moved.
    expect(await getAccountRow(w.db, b)).toBeNull();
    expect(await snapshotDb(w.db)).toEqual(restored);

    expect(
      await undoMerge(w.ctx(NOW + 60), proof(c, NOW + 60), liveJoin),
    ).toMatchObject({ ok: true, restoredAccountId: d });

    expect(await replayErasures(w.ctx(NOW + 200))).toMatchObject({
      failures: [],
    });
    expect(
      await undoMerge(w.ctx(NOW + 210), proof(s, NOW + 210), erasedJoin),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("undoMerge: an unreadable ledger refuses an undo of a live join, then recovers", async () => {
    const w = await world();
    const c = (await signedIn(w.db, emailIdentity(CY))).account.id;
    const d = (await signedIn(w.db, emailIdentity(DEE))).account.id;
    const r = await mergeAccounts(w.ctx(), pair(c, d));
    if (!r.ok) throw new Error(`merge: ${r.reason}`);
    w.bucket = await coldIsolate(w.env, w.bucket);
    w.bucket.down = true;
    const before = await snapshotDb(w.db);
    expect(
      await undoMerge(w.ctx(NOW + 60), proof(c, NOW + 60), r.mergeId),
    ).toEqual({ ok: false, error: "not_found" });
    expect(await snapshotDb(w.db)).toEqual(before);
    expect(w.bucket.heads).toContain(erasureKey(c));

    w.bucket.down = false;
    expect(
      await undoMerge(w.ctx(NOW + 60), proof(c, NOW + 60), r.mergeId),
    ).toMatchObject({ ok: true, restoredAccountId: d });
  });

  /** Ada's licence on `lic-1`, and a target account per address (each has an `acme` subject). */
  async function relinkWorld(w: World) {
    const through = (email: string) =>
      signedIn(w.db, emailIdentity(email), {
        unfenced: true,
        product: { slug: "acme" },
      });
    const owner = await through(CY);
    const erasedTarget = await through(ADA);
    const liveTarget = await through(BOB);
    await seedFloating(w.db, "acme", "lic-1");
    await attachLicense(w.ctx(), {
      accountId: owner.account.id,
      product: "acme",
      licenseId: "lic-1",
      via: "key",
    });
    const relink = (to: SignedIn, now = NOW) =>
      relinkLicense(w.ctx(now), {
        product: "acme",
        from: { subject: owner.subject!, accountId: owner.account.id },
        licenseId: "lic-1",
        target: to.subject!,
        reason: "support ticket 42",
        actor: { sub: "u1", name: "Op" },
      });
    return { owner, erasedTarget, liveTarget, relink };
  }

  it("relinkLicense: a licence is not moved to an erased target; D1 is unchanged; a live target takes it", async () => {
    const w = await world();
    const { erasedTarget, liveTarget, relink } = await relinkWorld(w);
    await eraseAndRestore(w.ctx(), erasedTarget.account.id);
    const restored = await snapshotDb(w.db);

    expect(await relink(erasedTarget)).toEqual({
      ok: false,
      reason: "target_unavailable",
    });
    expect(await snapshotDb(w.db)).toEqual(restored);
    expect(w.sent).toEqual([]);

    expect(await relink(liveTarget)).toMatchObject({ ok: true });
  });

  it("relinkLicense: an unreadable ledger refuses a live target, then recovers", async () => {
    const w = await world();
    const { liveTarget, relink } = await relinkWorld(w);
    w.bucket = await coldIsolate(w.env, w.bucket);
    w.bucket.down = true;
    const before = await snapshotDb(w.db);
    expect(await relink(liveTarget)).toEqual({
      ok: false,
      reason: "target_unavailable",
    });
    expect(await snapshotDb(w.db)).toEqual(before);
    expect(w.bucket.heads).toContain(erasureKey(liveTarget.account.id));

    w.bucket.down = false;
    expect(await relink(liveTarget)).toMatchObject({ ok: true });
  });
});

// ── The card ──────────────────────────────────────────────────────────────────────────────────

/** A card world whose bucket records what the fence reads and can fail. */
function cardLedger(w: CardWorld): LedgerBucket {
  const bucket = new LedgerBucket();
  w.env.BLOBS = asR2(bucket);
  return bucket;
}

const START = "/api/signin/email/start";
const FORBIDDEN = {
  error: "forbidden",
  message: "This account can't sign in.",
};

/**
 * Ada (to be erased and restored) and Bob (not on the ledger), signed up by email, in a card world
 * whose bucket is the one the fence reads.
 */
async function cardAdaBob(w: CardWorld) {
  const bucket = cardLedger(w);
  const ada = await getOrCreateAccountByEmail(w.db, ADA, NOW);
  const bob = await getOrCreateAccountByEmail(w.db, BOB, NOW);
  await eraseAndRestore(ctxOf(w.db, w.env), ada.id);
  expect(bucket.has(erasureKey(ada.id))).toBe(true);
  return { ada: ada.id, bob: bob.id, bucket };
}

describe("the card's email sign-in", () => {
  it("the code answers 403 forbidden for a restored erased account, in the window and after the replay, and sets no session", async () => {
    const w = await seededWorld();
    const { ada, bob } = await cardAdaBob(w);

    const d = new Device(w);
    const res = await d.signInWithCode(ADA);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(FORBIDDEN);
    expect(res.headers.get("set-cookie") ?? "").not.toContain(
      ACCOUNT_SESSION_COOKIE,
    );
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(
      await count(w.db, "SELECT COUNT(*) AS n FROM account_sessions"),
    ).toBe(0);

    // Bob, on the same card, in the same world, gets his session.
    const ok = new Device(w, "198.51.100.2");
    expect((await ok.signInWithCode(BOB)).status).toBe(200);
    expect(ok.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM account_sessions WHERE account_id = ?",
        bob,
      ),
    ).toBe(1);

    // After the replay the address is a new account's: never the erased one.
    expect(await replayErasures(ctxOf(w.db, w.env, NOW + 200))).toMatchObject({
      reapplied: 1,
      failures: [],
    });
    const later = new Device(w, "198.51.100.3");
    expect((await later.signInWithCode(ADA, NOW + 300)).status).toBe(200);
    const link = await w.db.first<{ account_id: string }>(
      "SELECT account_id FROM account_links WHERE issuer_key = 'email' AND subject = ?",
      ADA,
    );
    expect(link?.account_id).toBeTruthy();
    expect(link?.account_id).not.toBe(ada);
  });

  it("the link's page answers 403 and sets no session for a restored erased account", async () => {
    const w = await seededWorld();
    await cardAdaBob(w);

    const asker = new Device(w);
    await asker.send("POST", START, { email: ADA, returnTo: "/#/p/acme" });
    const token = new URL(lastLink(w, ADA)).searchParams.get("token")!;
    const res = await asker.send(
      "POST",
      "/magic/verify",
      { token },
      { form: true },
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(
      /This account can(&#39;|&#x27;|')t sign in/,
    );
    expect(asker.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(
      await count(w.db, "SELECT COUNT(*) AS n FROM account_sessions"),
    ).toBe(0);

    const bobAsker = new Device(w, "198.51.100.2");
    await bobAsker.send("POST", START, { email: BOB });
    const bobToken = new URL(lastLink(w, BOB)).searchParams.get("token")!;
    const bobRes = await bobAsker.send(
      "POST",
      "/magic/verify",
      { token: bobToken },
      { form: true },
    );
    expect(bobRes.status).toBe(302);
    expect(bobAsker.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
  });

  it("an unreadable ledger refuses the code the same way (403, never a 500), sets no session, and works again when readable", async () => {
    const w = await seededWorld();
    const { ada, bob, bucket: first } = await cardAdaBob(w);
    // A new isolate over the same ledger, with R2 failing.
    const bucket = await coldIsolate(w.env, first);
    bucket.down = true;

    for (const [who, ip] of [
      [ADA, "198.51.100.10"],
      [BOB, "198.51.100.11"],
    ] as const) {
      const d = new Device(w, ip);
      const res = await d.signInWithCode(who);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(FORBIDDEN);
      expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    }
    expect(
      await count(w.db, "SELECT COUNT(*) AS n FROM account_sessions"),
    ).toBe(0);
    expect(bucket.heads).toEqual(
      expect.arrayContaining([erasureKey(ada), erasureKey(bob)]),
    );

    bucket.down = false;
    const ok = new Device(w, "198.51.100.12");
    expect((await ok.signInWithCode(BOB)).status).toBe(200);
    expect(ok.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    const still = new Device(w, "198.51.100.13");
    const refused = await still.signInWithCode(ADA);
    expect(refused.status).toBe(403);
    expect(still.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("an unbound BLOBS refuses the code with the same 403 and sets no session", async () => {
    const w = await seededWorld();
    await cardAdaBob(w);
    delete w.env.BLOBS;
    const d = new Device(w);
    const res = await d.signInWithCode(BOB);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(FORBIDDEN);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });
});

// ── The email gate ────────────────────────────────────────────────────────────────────────────

const GATE = "/api/signin/confirm-email";

function google(subject: string, email: string): ProviderSignIn {
  return {
    identity: {
      issuerKey: GOOGLE,
      subject,
      kind: "google",
      email,
      emailVerified: true,
      displayName: "Ada Lovelace",
    },
  };
}

/** The front door's hand-off: the gate cookie lands in the device's jar. */
async function arrive(
  w: CardWorld,
  d: Device,
  input: ProviderSignIn,
): Promise<Response> {
  const res = await beginProviderSignIn(
    d.request("GET", "/signin/google/callback"),
    w.env,
    w.db,
    input,
    NOW,
  );
  return d.absorb(res);
}

/** An account that signs in with Google and has confirmed no email yet: the gate completes it. */
async function googleOnly(w: CardWorld, subject: string): Promise<string> {
  const account = await insertAccount(
    w.db,
    { primaryEmail: null, primaryEmailVerified: false, displayName: null },
    NOW,
  );
  await insertLink(
    w.db,
    account.id,
    {
      issuerKey: GOOGLE,
      tenantScope: "",
      subject,
      kind: "google",
      email: null,
      emailVerified: false,
      displayName: null,
      amr: null,
    },
    NOW,
  );
  return account.id;
}

async function primaryEmailOf(w: CardWorld, id: string) {
  const row = await w.db.first<{ primary_email: string | null }>(
    "SELECT primary_email FROM accounts WHERE id = ?",
    id,
  );
  return row?.primary_email ?? null;
}

describe("the email gate's completion of an existing account (gatePass)", () => {
  const sessions = (w: CardWorld) =>
    count(w.db, "SELECT COUNT(*) AS n FROM account_sessions");

  it("refuses a restored erased account with 403 before the gate is consumed, in the window and after the replay", async () => {
    const w = await seededWorld();
    const bucket = cardLedger(w);
    const erased = await googleOnly(w, "g-1");
    const live = await googleOnly(w, "g-2");
    await eraseAndRestore(ctxOf(w.db, w.env), erased);
    expect(bucket.has(erasureKey(erased))).toBe(true);

    const d = new Device(w);
    const landing = await arrive(w, d, google("g-1", "ada@gmail.com"));
    expect(landing.headers.get("location")).toBe(EMAIL_GATE_LANDING);
    const cookie = d.jar.get(EMAIL_GATE_COOKIE)!;

    const res = await d.send("POST", GATE, { choice: "provider" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      message: ACCOUNT_DISABLED_MESSAGE,
    });
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(await sessions(w)).toBe(0);
    expect(await primaryEmailOf(w, erased)).toBeNull();

    // The refusal came before the gate was taken: the same record still answers.
    d.jar.set(EMAIL_GATE_COOKIE, cookie);
    const view = await d.send("GET", GATE);
    expect(view.status).toBe(200);
    expect(await view.json()).toEqual(
      expect.objectContaining({ status: "gate" }),
    );

    // An account that is not on the ledger passes the same gate in the same world.
    const other = new Device(w, "198.51.100.2");
    await arrive(w, other, google("g-2", "bob@gmail.com"));
    const passed = await other.send("POST", GATE, { choice: "provider" });
    expect(passed.status).toBe(200);
    expect(await passed.json()).toEqual(
      expect.objectContaining({ status: "signed_in" }),
    );
    expect(other.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(await primaryEmailOf(w, live)).toBe("bob@gmail.com");

    // After the replay the same gate record is still refused.
    expect(await replayErasures(ctxOf(w.db, w.env, NOW + 200))).toMatchObject({
      reapplied: 1,
      failures: [],
    });
    d.jar.set(EMAIL_GATE_COOKIE, cookie);
    const after = await d.send("POST", GATE, { choice: "provider" });
    expect(after.status).toBe(403);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
  });

  it("an unreadable ledger answers 503 unavailable, burns nothing, and the same gate completes once it is readable", async () => {
    const w = await seededWorld();
    const bucket = cardLedger(w);
    const account = await googleOnly(w, "g-1");
    bucket.down = true;

    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com"));
    const cookie = d.jar.get(EMAIL_GATE_COOKIE)!;
    const res = await d.send("POST", GATE, { choice: "provider" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "erasure_ledger_unavailable",
      message: expect.any(String),
    });
    expect(bucket.heads).toContain(erasureKey(account));
    expect(d.jar.get(EMAIL_GATE_COOKIE)).toBe(cookie);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(await sessions(w)).toBe(0);
    expect(await primaryEmailOf(w, account)).toBeNull();
    // Still the gate: nothing was consumed.
    const view = await d.send("GET", GATE);
    expect(await view.json()).toEqual(
      expect.objectContaining({ status: "gate" }),
    );

    bucket.down = false;
    const done = await d.send("POST", GATE, { choice: "provider" });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(
      expect.objectContaining({ status: "signed_in" }),
    );
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
    expect(await primaryEmailOf(w, account)).toBe("ada@gmail.com");
  });

  it("an erased account behind an unreadable ledger is 503 with the gate intact, then 403 once the ledger is read", async () => {
    const w = await seededWorld();
    const first = cardLedger(w);
    const erased = await googleOnly(w, "g-1");
    await eraseAndRestore(ctxOf(w.db, w.env), erased);
    const bucket = await coldIsolate(w.env, first);
    bucket.down = true;

    const d = new Device(w);
    await arrive(w, d, google("g-1", "ada@gmail.com"));
    const cookie = d.jar.get(EMAIL_GATE_COOKIE)!;
    const res = await d.send("POST", GATE, { choice: "provider" });
    expect(res.status).toBe(503);
    expect(d.jar.get(EMAIL_GATE_COOKIE)).toBe(cookie);
    expect(await sessions(w)).toBe(0);

    bucket.down = false;
    const refused = await d.send("POST", GATE, { choice: "provider" });
    expect(refused.status).toBe(403);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(await sessions(w)).toBe(0);
    expect(await primaryEmailOf(w, erased)).toBeNull();
  });

  it("the existing-link fast path (an account with a confirmed email) is refused for a restored erased account and passes for a live one", async () => {
    const w = await seededWorld();
    const bucket = cardLedger(w);
    const mk = async (subject: string, email: string) => {
      const r = await signedIn(
        w.db,
        {
          issuerKey: GOOGLE,
          subject,
          kind: "google",
          email,
          emailVerified: true,
        },
        { unfenced: true },
      );
      return r.account.id;
    };
    const erased = await mk("g-1", "ada@gmail.com");
    await mk("g-2", "bob@gmail.com");
    await eraseAndRestore(ctxOf(w.db, w.env), erased);
    expect(bucket.has(erasureKey(erased))).toBe(true);

    const d = new Device(w);
    const res = await arrive(w, d, google("g-1", "ada@gmail.com"));
    expect(res.status).toBe(403);
    expect(d.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(false);
    expect(d.jar.has(EMAIL_GATE_COOKIE)).toBe(false);
    expect(await sessions(w)).toBe(0);

    const other = new Device(w, "198.51.100.2");
    const ok = await arrive(w, other, google("g-2", "bob@gmail.com"));
    expect(ok.status).toBe(302);
    expect(other.jar.has(ACCOUNT_SESSION_COOKIE)).toBe(true);
  });
});
