// PX-W12 (PORTAL.md §4.11, §10.2 G27; S-16 §5.1 "Merge only with proof of both"): Link an
// existing account. A join needs a fresh proof of BOTH accounts collected in one browser, blocks
// on conflict, is audited and emailed to both, and can be undone for 72 hours: the absorbed
// account comes back with its methods, licences and sessions, and developers keep the alias they
// were told about.

import { describe, expect, it } from "vitest";
import { NOW, seedProduct } from "./seed.js";
import { Device, seededWorld, type CardWorld } from "./identityCardHarness.js";
import { insertLicense } from "../src/repo.js";
import {
  ACCOUNT_SESSION_COOKIE,
  LINK_FLOW_COOKIE,
} from "../src/core/accountCookies.js";
import { resolveSubject, subjectFor } from "../src/core/accountSubjects.js";
import {
  ACCOUNT_COLUMNS,
  MERGE_UNDO_SECONDS,
  pruneAccountMerges,
  undoMerge,
} from "../src/services/identity/accounts/mergeUndo.js";
import type { Db } from "../src/db/types.js";
import { EMAIL_ISSUER } from "../src/services/identity/accounts/repo.js";

const LINK = "/api/me/link";

interface Signed {
  d: Device;
  accountId: string;
  email: string;
}

async function emailAccount(
  w: CardWorld,
  email: string,
  now = NOW,
): Promise<Signed> {
  const d = new Device(w);
  expect((await d.signInWithCode(email, now)).status).toBe(200);
  expect((await d.me(now)).status).toBe(200);
  const row = await w.db.first<{ id: string }>(
    "SELECT id FROM accounts WHERE primary_email = ?",
    email,
  );
  return { d, accountId: row!.id, email };
}

/** In `d`, sign in to `email`'s account on the card (the session moves to it). */
async function signInHere(d: Device, email: string, now = NOW): Promise<void> {
  expect((await d.signInWithCode(email, now)).status).toBe(200);
  expect((await d.me(now)).status).toBe(200);
}

/** Start linking in `from`'s browser, then prove `other` there. */
async function proveBoth(
  from: Signed,
  other: Signed,
  times: { start?: number; other?: number } = {},
): Promise<void> {
  const start = await from.d.send(
    "POST",
    `${LINK}/start`,
    {},
    {
      now: times.start ?? NOW,
    },
  );
  expect(start.status).toBe(200);
  expect(from.d.jar.has(LINK_FLOW_COOKIE)).toBe(true);
  await signInHere(from.d, other.email, times.other ?? NOW);
}

async function join(
  d: Device,
  body: Record<string, unknown> = {},
  now = NOW,
): Promise<Response> {
  return d.send("POST", `${LINK}/confirm`, body, { now });
}

async function seedLicense(
  w: CardWorld,
  product: string,
  id: string,
  accountId: string,
): Promise<void> {
  await insertLicense(w.db, {
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
  await w.db.run(
    "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
    accountId,
    product,
    id,
  );
}

async function exists(w: CardWorld, accountId: string): Promise<boolean> {
  return (
    (await w.db.first("SELECT id FROM accounts WHERE id = ?", accountId)) !==
    null
  );
}

async function linksOf(w: CardWorld, accountId: string): Promise<string[]> {
  return (
    await w.db.all<{ subject: string }>(
      "SELECT subject FROM account_links WHERE account_id = ? ORDER BY subject",
      accountId,
    )
  ).map((r) => r.subject);
}

async function audit(w: CardWorld, accountId: string): Promise<string[]> {
  return (
    await w.db.all<{ action: string }>(
      "SELECT action FROM portal_audit WHERE account_id = ? ORDER BY at, id",
      accountId,
    )
  ).map((r) => r.action);
}

describe("joining needs proof of both accounts in one browser", () => {
  it("starts only with a fresh sign-in", async () => {
    const w = await seededWorld();
    const a = await emailAccount(w, "a@example.com");
    const res = await a.d.send("POST", `${LINK}/start`, {}, { now: NOW + 600 });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "step_up_required",
    );
    expect(a.d.jar.has(LINK_FLOW_COOKIE)).toBe(false);
  });

  it("refuses to join before the other account is proven", async () => {
    const w = await seededWorld();
    const a = await emailAccount(w, "a@example.com");
    await a.d.send("POST", `${LINK}/start`, {});
    const res = await join(a.d);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        error: "bad_request",
        reason: "sign_in_other",
      }),
    );
    const view = (await (await a.d.send("GET", LINK)).json()) as {
      flow: { reason: string; canJoin: boolean };
    };
    expect(view.flow).toEqual(
      expect.objectContaining({ canJoin: false, reason: "sign_in_other" }),
    );
  });

  it("shows both accounts, how each was proven, and joins into the other one by default", async () => {
    const w = await seededWorld();
    const b = await emailAccount(w, "mara@fennick.studio");
    const a = await emailAccount(w, "a@example.com");
    await proveBoth(a, b);
    const view = (await (await a.d.send("GET", LINK)).json()) as {
      flow: Record<string, unknown> & {
        started: Record<string, unknown>;
        other: Record<string, unknown>;
      };
    };
    expect(view.flow).toEqual(
      expect.objectContaining({
        canJoin: true,
        reason: null,
        keep: "other",
        result: { products: 0, primaryEmail: "mara@fennick.studio" },
      }),
    );
    expect(view.flow.started).toEqual(
      expect.objectContaining({
        role: "started",
        current: false,
        email: "a@example.com",
        methods: ["email"],
        proven: { by: "email", at: NOW, fresh: true },
      }),
    );
    expect(view.flow.other).toEqual(
      expect.objectContaining({
        role: "other",
        current: true,
        email: "mara@fennick.studio",
      }),
    );
    // No account id reaches the page.
    expect(JSON.stringify(view)).not.toContain(a.accountId);
    expect(JSON.stringify(view)).not.toContain(b.accountId);

    w.mail.length = 0;
    const res = await join(a.d);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      kept: string;
      merge: { id: string; undoUntil: number };
    };
    expect(body).toEqual({
      status: "joined",
      kept: "other",
      merge: {
        id: expect.stringMatching(/^amrg_/),
        undoUntil: NOW + MERGE_UNDO_SECONDS,
      },
    });
    expect(a.d.jar.has(LINK_FLOW_COOKIE)).toBe(false);
    expect(await exists(w, a.accountId)).toBe(false);
    expect(await linksOf(w, b.accountId)).toEqual([
      "a@example.com",
      "mara@fennick.studio",
    ]);
    expect(await audit(w, b.accountId)).toContain("account.merge");
    // Emailed to both addresses, with the undo window.
    expect(w.mail.map((m) => m.to).sort()).toEqual([
      "a@example.com",
      "mara@fennick.studio",
    ]);
    for (const m of w.mail) {
      expect(m.subject).toBe("Two Polaris Key accounts were joined");
      expect(m.text).toContain("You can separate them again until");
    }
  });

  it("keeps the started account on request", async () => {
    const w = await seededWorld();
    const b = await emailAccount(w, "b@example.com");
    const a = await emailAccount(w, "a@example.com");
    await proveBoth(a, b);
    const res = await join(a.d, { keep: "started" });
    expect(res.status).toBe(200);
    expect(await exists(w, a.accountId)).toBe(true);
    expect(await exists(w, b.accountId)).toBe(false);
    // The browser's session (the absorbed account's) now acts as the survivor.
    const me = (await (await a.d.me()).json()) as {
      account: { email: string };
    };
    expect(me.account.email).toBe("a@example.com");
  });

  it("refuses a stale proof, and joins once that account is proven again", async () => {
    const w = await seededWorld();
    const b = await emailAccount(w, "b@example.com");
    const a = await emailAccount(w, "a@example.com");
    await proveBoth(a, b, { start: NOW, other: NOW + 200 });
    const stale = await join(a.d, {}, NOW + 400);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual(
      expect.objectContaining({
        error: "step_up_required",
        stale: ["started"],
      }),
    );
    expect(await exists(w, a.accountId)).toBe(true);
    // Sign in to the started account again in this browser: its proof is refreshed.
    await signInHere(a.d, "a@example.com", NOW + 400);
    const res = await join(a.d, {}, NOW + 450);
    expect(res.status).toBe(200);
    expect(await exists(w, a.accountId)).toBe(false);
  });

  it("never takes a proof from another browser", async () => {
    const w = await seededWorld();
    const b = await emailAccount(w, "b@example.com");
    const a = await emailAccount(w, "a@example.com");
    await a.d.send("POST", `${LINK}/start`, {});
    // B confirms from its own browser: there is no link flow there.
    const res = await join(b.d);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "signin_expired",
    );
    expect(await exists(w, a.accountId)).toBe(true);
    expect(await exists(w, b.accountId)).toBe(true);
  });

  it("is cancelled by signing out of a proven session", async () => {
    const w = await seededWorld();
    const b = await emailAccount(w, "b@example.com");
    const a = await emailAccount(w, "a@example.com");
    await proveBoth(a, b);
    await w.db.run(
      "UPDATE account_sessions SET revoked_at = ? WHERE account_id = ?",
      NOW,
      a.accountId,
    );
    const res = await join(a.d);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(
      expect.objectContaining({ stale: ["started"] }),
    );
  });

  it("refuses to join an account to itself", async () => {
    const w = await seededWorld();
    const a = await emailAccount(w, "a@example.com");
    await a.d.send("POST", `${LINK}/start`, {});
    // Signing in to the same account again only refreshes its own proof.
    await signInHere(a.d, "a@example.com");
    const res = await join(a.d);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      expect.objectContaining({ reason: "sign_in_other" }),
    );
  });

  it("blocks a join while either account can still undo a join of its own", async () => {
    const w = await seededWorld();
    const b = await emailAccount(w, "b@example.com");
    const a = await emailAccount(w, "a@example.com");
    await proveBoth(a, b);
    expect((await join(a.d)).status).toBe(200); // B absorbed A: B can undo for 72 h.
    const c = await emailAccount(w, "c@example.com");
    // From B, link C keeping C: B would be absorbed and its undo lost.
    await proveBoth({ ...b, d: a.d }, c);
    const view = (await (await a.d.send("GET", LINK)).json()) as {
      flow: { reason: string };
    };
    expect(view.flow.reason).toBe("merge_pending");
    const refused = await join(a.d);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(
      expect.objectContaining({ error: "forbidden", reason: "merge_pending" }),
    );
    expect(await exists(w, b.accountId)).toBe(true);
    expect(await exists(w, c.accountId)).toBe(true);
    // Keeping B is refused too: undoing B's join would hand C's data and aliases to A. (The
    // refusal used up the flow; this browser is signed in to C now, so it starts from C.)
    await proveBoth({ ...c, d: a.d }, b);
    const kept = await join(a.d);
    expect(kept.status).toBe(403);
    expect(await kept.json()).toEqual(
      expect.objectContaining({ reason: "merge_pending" }),
    );
    expect(await exists(w, c.accountId)).toBe(true);
  });

  it("merges once when two confirms race", async () => {
    const w = await seededWorld();
    const b = await emailAccount(w, "b@example.com");
    const a = await emailAccount(w, "a@example.com");
    await proveBoth(a, b);
    const [x, y] = await Promise.all([join(a.d), join(a.d)]);
    expect([x.status, y.status].sort()).toEqual([200, 400]);
    expect(
      await w.db.all(
        "SELECT id FROM account_merges WHERE survivor_id = ?",
        b.accountId,
      ),
    ).toHaveLength(1);
  });

  it("shows the started account only while its session is live, and sign-out ends the flow", async () => {
    const w = await seededWorld();
    const b = await emailAccount(w, "b@example.com");
    const a = await emailAccount(w, "a@example.com");
    await proveBoth(a, b);
    await w.db.run(
      "UPDATE account_sessions SET revoked_at = ? WHERE account_id = ?",
      NOW,
      a.accountId,
    );
    const view = await a.d.send("GET", LINK);
    expect(((await view.json()) as { flow: unknown }).flow).toBeNull();
    expect(a.d.jar.has(LINK_FLOW_COOKIE)).toBe(false);

    // Signing out clears the flow's cookie.
    const c = await emailAccount(w, "c@example.com");
    await c.d.send("POST", `${LINK}/start`, {});
    expect(c.d.jar.has(LINK_FLOW_COOKIE)).toBe(true);
    await c.d.send("POST", "/logout");
    expect(c.d.jar.has(LINK_FLOW_COOKIE)).toBe(false);
  });
});

/** A and B, B absorbing A in A's browser; answers the merge id. */
async function joined(w: CardWorld): Promise<{
  a: Signed;
  b: Signed;
  aCookie: string;
  mergeId: string;
}> {
  const b = await emailAccount(w, "mara@fennick.studio");
  const a = await emailAccount(w, "a@example.com");
  const aCookie = a.d.jar.get(ACCOUNT_SESSION_COOKIE)!;
  await proveBoth(a, b);
  const res = await join(a.d);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { merge: { id: string } };
  return { a, b, aCookie, mergeId: body.merge.id };
}

describe("undo within 72 hours", () => {
  it("lists the join as undoable, and separates the accounts again", async () => {
    const w = await seededWorld();
    await seedProduct(w.db, "other");
    const b0 = await emailAccount(w, "mara@fennick.studio");
    const a0 = await emailAccount(w, "a@example.com");
    // Both know acme; only A knows other. A device of A is bound at acme.
    await seedLicense(w, "acme", "lic-a", a0.accountId);
    await seedLicense(w, "acme", "lic-b", b0.accountId);
    await seedLicense(w, "other", "lic-o", a0.accountId);
    const subjA = await subjectFor(w.db, a0.accountId, "acme", NOW);
    const subjB = await subjectFor(w.db, b0.accountId, "acme", NOW);
    const subjOther = await subjectFor(w.db, a0.accountId, "other", NOW);
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject)
       VALUES ('acme', 'dev-a', 'lic-a', 'authorized', ?, ?, ?)`,
      NOW,
      NOW,
      subjA,
    );
    const aCookie = a0.d.jar.get(ACCOUNT_SESSION_COOKIE)!;
    await proveBoth(a0, b0);
    const res = await join(a0.d);
    const mergeId = ((await res.json()) as { merge: { id: string } }).merge.id;
    const d = a0.d;

    // Joined: everything is B's; A's cookie acts as B.
    const aBrowser = new Device(w);
    aBrowser.jar.set(ACCOUNT_SESSION_COOKIE, aCookie);
    expect(
      ((await (await aBrowser.me()).json()) as { account: { email: string } })
        .account.email,
    ).toBe("mara@fennick.studio");
    const listed = (await (await d.send("GET", LINK)).json()) as {
      undoable: Array<{ id: string; undoUntil: number; joined: unknown }>;
    };
    expect(listed.undoable).toEqual([
      {
        id: mergeId,
        mergedAt: NOW,
        undoUntil: NOW + MERGE_UNDO_SECONDS,
        joined: { email: "a@example.com", name: expect.anything() },
      },
    ]);

    w.mail.length = 0;
    const undo = await d.send(
      "POST",
      `${LINK}/undo`,
      { merge: mergeId },
      { now: NOW + 3600 },
    );
    // The session signed in at NOW: an hour later it is stale.
    expect(undo.status).toBe(401);
    await signInHere(d, "mara@fennick.studio", NOW + 3600);
    const ok = await d.send(
      "POST",
      `${LINK}/undo`,
      { merge: mergeId },
      { now: NOW + 3600 },
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "separated" });

    // A is back, with its own method, licences and session.
    expect(await exists(w, a0.accountId)).toBe(true);
    expect(await linksOf(w, a0.accountId)).toEqual(["a@example.com"]);
    expect(await linksOf(w, b0.accountId)).toEqual(["mara@fennick.studio"]);
    const owners = await w.db.all<{ id: string; account_id: string }>(
      "SELECT id, account_id FROM licenses ORDER BY id",
    );
    expect(owners).toEqual([
      { id: "lic-a", account_id: a0.accountId },
      { id: "lic-b", account_id: b0.accountId },
      { id: "lic-o", account_id: a0.accountId },
    ]);
    expect(
      (
        (await (await aBrowser.me(NOW + 3600)).json()) as {
          account: { email: string };
        }
      ).account.email,
    ).toBe("a@example.com");
    // Developers keep the alias they were told about; A gets a fresh subject at acme next time,
    // and its own subject back where it moved over whole.
    expect(await resolveSubject(w.db, "acme", subjA)).toBe(subjB);
    const fresh = await subjectFor(w.db, a0.accountId, "acme", NOW + 3600);
    expect(fresh).not.toBe(subjA);
    expect(fresh).not.toBe(subjB);
    expect(await subjectFor(w.db, a0.accountId, "other", NOW + 3600)).toBe(
      subjOther,
    );
    // A's device, re-keyed onto B's subject by the join, lost the binding.
    const dev = await w.db.first<{ subject: string | null }>(
      "SELECT subject FROM devices WHERE device_id = 'dev-a'",
    );
    expect(dev?.subject).toBeNull();
    // Audited on both, emailed to both.
    expect(await audit(w, a0.accountId)).toContain("account.merge.undo");
    expect(await audit(w, b0.accountId)).toContain("account.merge.undo");
    const notices = w.mail.filter((m) => !m.subject.includes("code"));
    expect(notices.map((m) => [m.to, m.subject]).sort()).toEqual([
      ["a@example.com", "Your Polaris Key accounts were separated"],
      ["mara@fennick.studio", "Your Polaris Key accounts were separated"],
    ]);
    // Once only; and the snapshot is gone.
    const again = await d.send(
      "POST",
      `${LINK}/undo`,
      { merge: mergeId },
      { now: NOW + 3600 },
    );
    expect(again.status).toBe(404);
    const row = await w.db.first<{ snapshot_json: string | null }>(
      "SELECT snapshot_json FROM account_merges WHERE id = ?",
      mergeId,
    );
    expect(row?.snapshot_json).toBeNull();
  });

  it("is refused once 72 hours have passed", async () => {
    const w = await seededWorld();
    const { a, mergeId } = await joined(w);
    const late = NOW + MERGE_UNDO_SECONDS + 1;
    await signInHere(a.d, "mara@fennick.studio", late);
    const res = await a.d.send(
      "POST",
      `${LINK}/undo`,
      { merge: mergeId },
      { now: late },
    );
    expect(res.status).toBe(404);
    expect(await exists(w, a.accountId)).toBe(false);
  });

  it("never brings back a method disconnected since the join", async () => {
    const w = await seededWorld();
    const { a, b, mergeId } = await joined(w);
    const methods = (await (
      await a.d.send("GET", "/api/me/methods")
    ).json()) as {
      methods: Array<{ id: string; display: string }>;
    };
    const aEmail = methods.methods.find((m) => m.display === "a@example.com")!;
    expect(
      (await a.d.send("DELETE", `/api/me/methods/${aEmail.id}`)).status,
    ).toBe(200);
    expect(await linksOf(w, b.accountId)).toEqual(["mara@fennick.studio"]);
    // A's only method is gone: the undo would bring A back with none, so it is refused.
    const res = await a.d.send("POST", `${LINK}/undo`, { merge: mergeId });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("last_link");
    expect(await exists(w, a.accountId)).toBe(false);
    expect(
      await w.db.first(
        "SELECT id FROM account_links WHERE subject = 'a@example.com'",
      ),
    ).toBeNull();
  });

  it("restores only the methods still on the survivor", async () => {
    const w = await seededWorld();
    const b = await emailAccount(w, "mara@fennick.studio");
    const a = await emailAccount(w, "a@example.com");
    // A also has Steam, removed from the kept account after the join.
    await w.db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
                                  email, email_verified, display_name, created_at, last_used_at)
       VALUES ('lnk_steam_a', ?, 'steam', '', '76561198000000001', 'steam', NULL, 0, 'marafox', ?, ?)`,
      a.accountId,
      NOW,
      NOW,
    );
    await proveBoth(a, b);
    const mergeId = (
      (await (await join(a.d)).json()) as { merge: { id: string } }
    ).merge.id;
    expect(
      (await a.d.send("DELETE", "/api/me/methods/lnk_steam_a")).status,
    ).toBe(200);
    const res = await a.d.send("POST", `${LINK}/undo`, { merge: mergeId });
    expect(res.status).toBe(200);
    expect(await linksOf(w, a.accountId)).toEqual(["a@example.com"]);
    expect(
      await w.db.first("SELECT id FROM account_links WHERE id = 'lnk_steam_a'"),
    ).toBeNull();
  });

  it("refuses atomically when a method goes between the check and the undo (last_link)", async () => {
    const w = await seededWorld();
    const { a, b, mergeId } = await joined(w);
    const own = await w.db.first<{ id: string }>(
      "SELECT id FROM account_links WHERE account_id = ? AND subject = 'mara@fennick.studio'",
      b.accountId,
    );
    // The removal lands after the undo's own check, right before its batch.
    const racy = Object.create(w.db) as Db;
    racy.batch = async (stmts) => {
      await w.db.run("DELETE FROM account_links WHERE id = ?", own!.id);
      return w.db.batch(stmts);
    };
    const result = await undoMerge(
      { db: racy, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      { accountId: b.accountId, authenticatedAt: NOW },
      mergeId,
    );
    expect(result).toEqual({ ok: false, error: "last_link" });
    expect(await exists(w, a.accountId)).toBe(false);
    expect(await linksOf(w, b.accountId)).toEqual(["a@example.com"]);
    // Nothing applied, and the join can still be undone.
    const row = await w.db.first<{ undone_at: number | null }>(
      "SELECT undone_at FROM account_merges WHERE id = ?",
      mergeId,
    );
    expect(row?.undone_at).toBeNull();
  });

  it("revokes the registry tokens the survivor minted on a licence that goes back", async () => {
    const w = await seededWorld();
    const b = await emailAccount(w, "mara@fennick.studio");
    const a = await emailAccount(w, "a@example.com");
    await seedLicense(w, "acme", "lic-a", a.accountId);
    const token = (id: string, accountId: string) =>
      w.db.run(
        `INSERT INTO registry_tokens (product, token_id, token_hash, hint, label, scopes_json,
           binding, license_id, created_by, portal_account_id, created_at, expires_at)
         VALUES ('acme', ?, ?, 'abcd', ?, '["read"]', 'license', 'lic-a', ?, ?, ?, ?)`,
        id,
        `h-${id}`,
        id,
        `portal:${accountId}`,
        accountId,
        NOW,
        NOW + 86400,
      );
    await token("rtok_a", a.accountId); // A's own, before the join.
    await proveBoth(a, b);
    const mergeId = (
      (await (await join(a.d)).json()) as { merge: { id: string } }
    ).merge.id;
    await token("rtok_s", b.accountId); // Minted by the kept account during the window.
    expect(
      (await a.d.send("POST", `${LINK}/undo`, { merge: mergeId })).status,
    ).toBe(200);
    const rows = await w.db.all<{
      token_id: string;
      portal_account_id: string;
      revoked_at: number | null;
    }>(
      "SELECT token_id, portal_account_id, revoked_at FROM registry_tokens ORDER BY token_id",
    );
    expect(rows).toEqual([
      { token_id: "rtok_a", portal_account_id: a.accountId, revoked_at: null },
      { token_id: "rtok_s", portal_account_id: b.accountId, revoked_at: NOW },
    ]);
  });

  it("keeps the survivor's passkey user handle while it holds a passkey created under it", async () => {
    for (const enrolled of [true, false]) {
      const w = await seededWorld();
      const b = await emailAccount(w, "mara@fennick.studio");
      const a = await emailAccount(w, "a@example.com");
      await w.db.run(
        "UPDATE accounts SET passkey_user_handle = 'h-a' WHERE id = ?",
        a.accountId,
      );
      await proveBoth(a, b);
      const mergeId = (
        (await (await join(a.d)).json()) as { merge: { id: string } }
      ).merge.id;
      if (enrolled) {
        // The kept account added a passkey during the window, under the handle it took.
        await w.db.run(
          `INSERT INTO account_passkeys (credential_id, account_id, public_key, rp_id, user_handle,
                                         created_at)
           VALUES ('cred-new', ?, 'pk', 'key.plrs.im', 'h-a', ?)`,
          b.accountId,
          NOW,
        );
      }
      expect(
        (await a.d.send("POST", `${LINK}/undo`, { merge: mergeId })).status,
      ).toBe(200);
      const handle = await w.db.first<{ passkey_user_handle: string | null }>(
        "SELECT passkey_user_handle FROM accounts WHERE id = ?",
        b.accountId,
      );
      expect(handle?.passkey_user_handle).toBe(enrolled ? "h-a" : null);
    }
  });

  it("gives the joined account its library entries back; the kept account keeps its own", async () => {
    const w = await seededWorld();
    await seedProduct(w.db, "other");
    const b = await emailAccount(w, "mara@fennick.studio");
    const a = await emailAccount(w, "a@example.com");
    const entry = (accountId: string, product: string, at: number) =>
      w.db.run(
        "INSERT INTO library_entries (account_id, product, via, added_at) VALUES (?, ?, 'open', ?)",
        accountId,
        product,
        at,
      );
    const library = async (accountId: string) =>
      (
        await w.db.all<{ product: string; added_at: number }>(
          "SELECT product, added_at FROM library_entries WHERE account_id = ? ORDER BY product",
          accountId,
        )
      ).map((r) => [r.product, r.added_at]);
    await entry(a.accountId, "acme", NOW - 20);
    await entry(a.accountId, "other", NOW - 10);
    await entry(b.accountId, "other", NOW - 5);
    await proveBoth(a, b);
    const mergeId = (
      (await (await join(a.d)).json()) as { merge: { id: string } }
    ).merge.id;
    // Joined: the kept account's own entry won for the product both had.
    expect(await library(b.accountId)).toEqual([
      ["acme", NOW - 20],
      ["other", NOW - 5],
    ]);
    expect(
      (await a.d.send("POST", `${LINK}/undo`, { merge: mergeId })).status,
    ).toBe(200);
    expect(await library(a.accountId)).toEqual([
      ["acme", NOW - 20],
      ["other", NOW - 10],
    ]);
    expect(await library(b.accountId)).toEqual([["other", NOW - 5]]);
  });

  it("never restores a primary email the joined account no longer holds", async () => {
    const primary = (w: CardWorld, accountId: string) =>
      w.db.first<{
        primary_email: string | null;
        primary_email_verified_at: number | null;
      }>(
        "SELECT primary_email, primary_email_verified_at FROM accounts WHERE id = ?",
        accountId,
      );
    const disconnect = async (d: Device, display: string) => {
      const methods = (await (
        await d.send("GET", "/api/me/methods")
      ).json()) as {
        methods: Array<{ id: string; display: string }>;
      };
      const m = methods.methods.find((x) => x.display === display)!;
      expect((await d.send("DELETE", `/api/me/methods/${m.id}`)).status).toBe(
        200,
      );
    };
    const otherMethod = (w: CardWorld, accountId: string, row: string) =>
      w.db.run(
        `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
                                    email, email_verified, display_name, created_at, last_used_at)
         VALUES ${row}`,
        accountId,
      );

    // Its primary address was disconnected during the window; its other address takes over.
    {
      const w = await seededWorld();
      const b = await emailAccount(w, "mara@fennick.studio");
      const a = await emailAccount(w, "a@example.com");
      await otherMethod(
        w,
        a.accountId,
        `('lnk_a2', ?, '${EMAIL_ISSUER}', '', 'a2@example.com', 'email', 'a2@example.com', 1,
          NULL, ${NOW + 1}, ${NOW + 1})`,
      );
      await proveBoth(a, b);
      const mergeId = (
        (await (await join(a.d)).json()) as { merge: { id: string } }
      ).merge.id;
      await disconnect(a.d, "a@example.com");
      expect(
        (await a.d.send("POST", `${LINK}/undo`, { merge: mergeId })).status,
      ).toBe(200);
      expect(await primary(w, a.accountId)).toEqual({
        primary_email: "a2@example.com",
        primary_email_verified_at: NOW + 1,
      });
    }

    // Disconnected, and another account's since: with no other address, it has none.
    {
      const w = await seededWorld();
      const b = await emailAccount(w, "mara@fennick.studio");
      const a = await emailAccount(w, "a@example.com");
      await otherMethod(
        w,
        a.accountId,
        `('lnk_steam_a', ?, 'steam', '', '76561198000000001', 'steam', NULL, 0, 'marafox',
          ${NOW}, ${NOW})`,
      );
      await proveBoth(a, b);
      const mergeId = (
        (await (await join(a.d)).json()) as { merge: { id: string } }
      ).merge.id;
      await disconnect(a.d, "a@example.com");
      const c = await emailAccount(w, "a@example.com");
      expect(
        (await a.d.send("POST", `${LINK}/undo`, { merge: mergeId })).status,
      ).toBe(200);
      expect(await linksOf(w, a.accountId)).toEqual(["76561198000000001"]);
      expect(await primary(w, a.accountId)).toEqual({
        primary_email: null,
        primary_email_verified_at: null,
      });
      expect((await primary(w, c.accountId))?.primary_email).toBe(
        "a@example.com",
      );
    }
  });

  it("never orphans the survivor (last_link)", async () => {
    const w = await seededWorld();
    const { a, b, mergeId } = await joined(w);
    const methods = (await (
      await a.d.send("GET", "/api/me/methods")
    ).json()) as {
      methods: Array<{ id: string; display: string }>;
    };
    const bEmail = methods.methods.find(
      (m) => m.display === "mara@fennick.studio",
    )!;
    expect(
      (await a.d.send("DELETE", `/api/me/methods/${bEmail.id}`)).status,
    ).toBe(200);
    const res = await a.d.send("POST", `${LINK}/undo`, { merge: mergeId });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("last_link");
    expect(await exists(w, a.accountId)).toBe(false);
    expect(await linksOf(w, b.accountId)).toEqual(["a@example.com"]);
  });

  it("is only the survivor's to undo", async () => {
    const w = await seededWorld();
    const { mergeId } = await joined(w);
    const stranger = await emailAccount(w, "s@example.com");
    const res = await stranger.d.send("POST", `${LINK}/undo`, {
      merge: mergeId,
    });
    expect(res.status).toBe(404);
  });

  it("keeps no snapshot past the window, nor past the survivor's deletion", async () => {
    const w = await seededWorld();
    const { a, mergeId } = await joined(w);
    expect(await pruneAccountMerges(w.db, NOW + 60)).toBe(0);
    // Deleting the survivor deletes its join records.
    expect((await a.d.send("DELETE", "/api/me")).status).toBe(200);
    expect(
      await w.db.first("SELECT id FROM account_merges WHERE id = ?", mergeId),
    ).toBeNull();

    const w2 = await seededWorld();
    await joined(w2);
    expect(await pruneAccountMerges(w2.db, NOW + MERGE_UNDO_SECONDS)).toBe(1);
  });
});

describe("the undo snapshot covers every column it restores", () => {
  it.each([["accounts", ACCOUNT_COLUMNS]] as const)(
    "%s",
    async (table, columns) => {
      const w = await seededWorld();
      const rows = await w.db.all<{ name: string }>(
        `SELECT name FROM pragma_table_info('${table}')`,
      );
      expect([...columns].sort()).toEqual(rows.map((r) => r.name).sort());
    },
  );
});
