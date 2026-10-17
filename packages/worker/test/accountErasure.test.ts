/**
 * SEC-WP-04 (SEC-PRV-1, SEC-PRV-19): account erasure is a resumable, idempotent state machine.
 *
 * A store hook that fails mid-erasure leaves the account CLOSED (status `deleted`: no session, no
 * sign-in) with its progress recorded and everything the retry needs intact; the sweeper resumes
 * it after the back-off and the final batch removes every row; a double invoke is harmless; a
 * subject minted while the hooks ran is not orphaned.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { asR2, R2Mock } from "./r2Mock.js";
import { restoreDb, snapshotDb } from "./d1Restore.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { appendAudit, insertLicense, type AuditRow } from "../src/core/repo.js";
import {
  subjectFor,
  subjectForOrNull,
} from "../src/core/accounts/accountSubjects.js";
import {
  forgetRegistryTokens,
  lookupRegistryCredential,
  mintRegistryToken,
} from "../src/core/registry/registryTokens.js";
import {
  registerSubjectStore,
  unregisterSubjectStore,
} from "../src/core/accounts/subjectHooks.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { attachLicense } from "../src/services/identity/accounts/claim.js";
import { applyProvisionedAccountSecrets } from "../src/core/accounts/accountOverrides.js";
import * as deletion from "../src/services/identity/accounts/deletion.js";
import type { AccountContext } from "../src/services/identity/accounts/links.js";
import {
  ERASED_AUDIT_ACTOR,
  ERASED_AUDIT_SUMMARY,
  SIGNIN_LICENSE_CHOSEN_ACTION,
  stmtScrubAccountAudit,
} from "../src/services/identity/accounts/accountAudit.js";
import {
  getAccountRow,
  insertLink,
} from "../src/services/identity/accounts/repo.js";
import { erasureKey } from "../src/core/accounts/erasureFence.js";
import {
  ErasureLedgerError,
  recordErasure,
} from "../src/services/identity/accounts/erasureLedger.js";
import {
  ACCOUNT_DELETION_CLAIM_SECONDS,
  ACCOUNT_DELETION_GRACE_SECONDS,
  accountDeletionSchedule,
  cancelAccountDeletion,
  scheduleAccountDeletion,
  sweepAccountDeletions,
} from "../src/services/identity/accounts/lifecycle.js";
import { runScheduledMaintenance } from "../src/scheduled.js";

const EMAIL = "erase-me@example.com";

async function world(r2 = new R2Mock()) {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  // The erasure ledger (I-11) lives in the bucket: an erasure is recorded there before D1 changes.
  env.BLOBS = asR2(r2);
  const ctx = (now = NOW): AccountContext => ({
    db,
    env,
    now,
    origin: "https://key.plrs.im",
  });
  await seedProduct(db, "acme");
  await insertLicense(db, {
    product: "acme",
    id: "lic-1",
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
  const r = await signIn(
    db,
    { issuerKey: "email", subject: EMAIL, kind: "email" },
    NOW,
    { env },
  );
  if (r.status !== "signed_in") throw new Error("sign-in failed");
  const attached = await attachLicense(ctx(), {
    accountId: r.account.id,
    product: "acme",
    licenseId: "lic-1",
    via: "key",
  });
  if (!attached.ok) throw new Error("attach failed");
  await db.run(
    `INSERT INTO account_sessions (id_hash, account_id, created_at, expires_at, last_seen_at)
     VALUES ('sess-1', ?, ?, ?, ?)`,
    r.account.id,
    NOW,
    NOW + 3600,
    NOW,
  );
  return { db, env, r2, ctx, id: r.account.id, subject: attached.subject };
}

const count = async (db: Db, sql: string, ...p: string[]) =>
  (await db.first<{ n: number }>(sql, ...p))!.n;

/** Every table that names the account, so "nothing readable" is one assertion. */
async function rowsNaming(db: Db, id: string): Promise<Record<string, number>> {
  const q = (t: string, col = "account_id") =>
    count(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, id);
  return {
    accounts: await q("accounts", "id"),
    links: await q("account_links"),
    subjects: await q("account_product_subjects"),
    sessions: await q("account_sessions"),
    grants: await q("account_product_grants"),
    passkeys: await q("account_passkeys"),
    emails: await q("portal_account_emails"),
    erasures: await q("account_erasures"),
    licenses: await count(
      db,
      "SELECT COUNT(*) AS n FROM licenses WHERE account_id = ?",
      id,
    ),
  };
}

afterEach(() => {
  unregisterSubjectStore("flaky");
  unregisterSubjectStore("steady");
});

describe("SEC-PRV-1: erasure survives a failing store hook", () => {
  it("closes the account, records progress, isolates hooks, and the sweeper completes it", async () => {
    const w = await world();
    let failing = true;
    const calls: string[] = [];
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        calls.push("flaky");
        if (failing) throw new Error("DO unavailable");
      },
    });
    registerSubjectStore("steady", {
      merge: async () => {},
      delete: async () => {
        calls.push("steady");
      },
    });

    // The request does not throw; the account is erasing, not half-deleted-and-forgotten.
    const first = await deletion.deleteAccount(w.ctx(), w.id);
    expect(first).toEqual({ ok: true, erasing: true });
    expect(calls).toEqual(["flaky", "steady"]); // per-hook isolation
    expect((await getAccountRow(w.db, w.id))?.status).toBe("deleted");
    const row = await w.db.first<{
      attempts: number;
      failed_step: string;
      last_error: string;
      next_attempt_at: number;
      lease_until: number;
    }>("SELECT * FROM account_erasures WHERE account_id = ?", w.id);
    expect(row).toMatchObject({
      attempts: 1,
      failed_step: "store:flaky",
      lease_until: 0,
    });
    expect(row!.last_error).toContain("DO unavailable");
    expect(row!.next_attempt_at).toBeGreaterThan(NOW);
    // Sessions are dead at once; what the retry needs (subject, link, licence) is still there.
    expect((await rowsNaming(w.db, w.id)).sessions).toBe(0);
    expect((await rowsNaming(w.db, w.id)).subjects).toBe(1);
    expect((await rowsNaming(w.db, w.id)).licenses).toBe(1);
    // No tombstone yet, and no subject.deleted event yet.
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM account_tombstones WHERE id = ?",
        w.id,
      ),
    ).toBe(0);

    // Before the back-off elapses the sweeper leaves it alone.
    expect(await deletion.sweepErasures(w.ctx(NOW + 60))).toEqual({
      completed: 0,
      attempted: 0,
    });

    // The store recovers; after the back-off the sweeper finishes the erasure.
    failing = false;
    const swept = await deletion.sweepErasures(w.ctx(NOW + 2 * 3600));
    expect(swept).toEqual({ completed: 1, attempted: 1 });
    expect(await getAccountRow(w.db, w.id)).toBeNull();
    expect(Object.values(await rowsNaming(w.db, w.id))).toEqual(
      Object.values(await rowsNaming(w.db, w.id)).map(() => 0),
    );
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM account_tombstones WHERE id = ?",
        w.id,
      ),
    ).toBe(1);
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM subject_events WHERE type = 'subject.deleted'",
      ),
    ).toBe(1);
  });

  it("a double invoke is idempotent, before and after completion", async () => {
    const w = await world();
    let failing = true;
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        if (failing) throw new Error("R2 5xx");
      },
    });
    expect(await deletion.deleteAccount(w.ctx(), w.id)).toEqual({
      ok: true,
      erasing: true,
    });
    // Same request again while still failing: still erasing, still one progress row.
    expect(await deletion.deleteAccount(w.ctx(NOW + 5), w.id)).toEqual({
      ok: true,
      erasing: true,
    });
    expect(
      await count(w.db, "SELECT COUNT(*) AS n FROM account_erasures"),
    ).toBe(1);
    failing = false;
    expect(await deletion.deleteAccount(w.ctx(NOW + 10), w.id)).toEqual({
      ok: true,
    });
    // After completion there is no account left to erase; nothing is duplicated.
    expect(await deletion.deleteAccount(w.ctx(NOW + 20), w.id)).toEqual({
      ok: false,
    });
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM subject_events WHERE type = 'subject.deleted'",
      ),
    ).toBe(1);
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM portal_audit WHERE action = 'portal.account.delete'",
      ),
    ).toBe(1);
  });

  it("an attempt that holds the lease is not run twice at once", async () => {
    const w = await world();
    let running = 0;
    let peak = 0;
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
      },
    });
    const [a, b] = await Promise.all([
      deletion.deleteAccount(w.ctx(), w.id),
      deletion.deleteAccount(w.ctx(), w.id),
    ]);
    expect(peak).toBe(1);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(await getAccountRow(w.db, w.id)).toBeNull();
  });

  it("sign-in during erasing is refused and does not resurrect the account", async () => {
    const w = await world();
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        throw new Error("down");
      },
    });
    await deletion.deleteAccount(w.ctx(), w.id);
    const again = await signIn(
      w.db,
      { issuerKey: "email", subject: EMAIL, kind: "email" },
      NOW + 30,
      { env: w.env },
    );
    expect(again.status).toBe("refused");
    expect((await getAccountRow(w.db, w.id))?.status).toBe("deleted");
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM accounts WHERE id != ?",
        w.id,
      ),
    ).toBe(0);
  });

  it("nothing is readable by id after erased, and a new sign-in is a fresh account", async () => {
    const w = await world();
    await deletion.deleteAccount(w.ctx(), w.id);
    const after = await rowsNaming(w.db, w.id);
    expect(after).toEqual(
      Object.fromEntries(Object.keys(after).map((k) => [k, 0])),
    );
    const again = await signIn(
      w.db,
      { issuerKey: "email", subject: EMAIL, kind: "email" },
      NOW + 30,
      { env: w.env },
    );
    expect(again.status).toBe("signed_in");
    if (again.status === "signed_in") expect(again.account.id).not.toBe(w.id);
  });

  it("adopts an account a pre-fix Worker left at status deleted with no progress row", async () => {
    const w = await world();
    await w.db.run("UPDATE accounts SET status = 'deleted' WHERE id = ?", w.id);
    const r = await deletion.sweepErasures(w.ctx(NOW + 60));
    expect(r).toEqual({ completed: 1, attempted: 1 });
    expect(await getAccountRow(w.db, w.id)).toBeNull();
  });

  it("the nightly maintenance reports an erasure that keeps failing", async () => {
    const w = await world();
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        throw new Error("down");
      },
    });
    let now = NOW;
    await deletion.deleteAccount(w.ctx(now), w.id);
    for (let i = 0; i < deletion.ERASURE_STUCK_ATTEMPTS; i++) {
      now += 2 * 86400;
      await deletion.sweepErasures(w.ctx(now));
    }
    const report = await runScheduledMaintenance(w.db, now, w.env);
    expect(report.failures.erasures).toContain(w.id);
    expect(report.failures.erasures).toContain("store:flaky");
  });
});

describe("closing the account closes its credentials", () => {
  it("a portal (licence-bound) registry token stops authenticating at once, while erasing", async () => {
    const w = await world();
    const res = await mintRegistryToken(
      w.env,
      w.db,
      {
        product: "acme",
        label: "laptop",
        binding: "license",
        licenseId: "lic-1",
        createdBy: `portal:${w.id}`,
        portalAccountId: w.id,
      },
      NOW,
    );
    if (!res.ok) throw new Error(JSON.stringify(res));
    forgetRegistryTokens();
    const live = await lookupRegistryCredential(w.env, w.db, res.token, {
      nowMs: NOW * 1000,
    });
    expect(live.resolved).not.toBeNull();
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        throw new Error("down");
      },
    });
    expect(await deletion.deleteAccount(w.ctx(), w.id)).toEqual({
      ok: true,
      erasing: true,
    });
    const after = await lookupRegistryCredential(w.env, w.db, res.token, {
      nowMs: NOW * 1000 + 1000,
    });
    expect(after.resolved).toBeNull();
  });

  it("subjectFor mints nothing for an account being erased", async () => {
    const w = await world();
    await seedProduct(w.db, "other");
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        throw new Error("down");
      },
    });
    await deletion.deleteAccount(w.ctx(), w.id);
    await expect(subjectFor(w.db, w.id, "other", NOW)).rejects.toThrow(
      /being erased/,
    );
    expect(await subjectForOrNull(w.db, w.id, "other", NOW)).toBeNull();
  });
});

describe("no new subject is minted for an erasing account", () => {
  it("applyProvisionedAccountSecrets (the OIDC sign-in path) skips it instead of throwing", async () => {
    const w = await world();
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        throw new Error("down");
      },
    });
    await seedProduct(w.db, "other");
    await deletion.deleteAccount(w.ctx(), w.id);
    await expect(
      applyProvisionedAccountSecrets(
        w.env,
        w.db,
        "other",
        w.id,
        { K: { value: "v" } as never },
        new Set(["K"]),
        NOW,
      ),
    ).resolves.toBeUndefined();
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM account_product_subjects WHERE account_id = ? AND product = 'other'",
        w.id,
      ),
    ).toBe(0);
  });
});

describe("SEC-PRV-19: a subject minted during erasure is not orphaned", () => {
  it("its store data is deleted, it is announced, and no subject or alias row survives", async () => {
    const w = await world();
    await seedProduct(w.db, "other");
    let minted: string | null = null;
    const seen: string[] = [];
    registerSubjectStore("steady", {
      merge: async () => {},
      delete: async ({ db }, { product }) => {
        seen.push(product);
        if (!minted) {
          minted = "sub_late_minted";
          // A request racing the closing batch (subjectFor itself refuses while erasing).
          await db.run(
            `INSERT INTO account_product_subjects (account_id, product, subject, created_at)
             VALUES (?, 'other', ?, ?)`,
            w.id,
            minted,
            NOW,
          );
          // A merge alias for the late subject (no foreign key holds it).
          await db.run(
            `INSERT INTO account_product_subject_aliases (product, alias, subject, merged_at)
             VALUES ('other', 'sub_alias_late', ?, ?)`,
            minted,
            NOW,
          );
        }
      },
    });
    expect(await deletion.deleteAccount(w.ctx(), w.id)).toEqual({ ok: true });
    // The store heard about the late subject too, not only the one read at the start.
    expect(seen).toEqual(["acme", "other"]);
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM account_product_subjects WHERE account_id = ?",
        w.id,
      ),
    ).toBe(0);
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM account_product_subject_aliases WHERE product = 'other'",
      ),
    ).toBe(0);
    expect(
      await count(
        w.db,
        "SELECT COUNT(*) AS n FROM subject_events WHERE type = 'subject.deleted'",
      ),
    ).toBe(2);
  });
});

// ── I-11: the product `audit` rows that name the person ───────────────────────────────────────

const PLATFORM = "https://id.example";
const SUB = "pocket-sub-ada";
const PERSON_EMAIL = "ada@example.com";
const PERSON_NAME = "Ada Lovelace";
/** The person as the platform IdP knows them: what the portal and the product sign-in write. */
const AS_PERSON = {
  actor_sub: SUB,
  actor_name: PERSON_NAME,
  actor_email: PERSON_EMAIL,
};

const auditRow = (
  p: Partial<AuditRow> & Pick<AuditRow, "id" | "action">,
): AuditRow => ({
  product: "acme",
  at: NOW,
  actor_sub: null,
  actor_name: null,
  actor_email: null,
  target_kind: null,
  target_id: null,
  parent_id: null,
  summary: null,
  ...p,
});

const auditRows = (db: Db) =>
  db.all<AuditRow>(
    `SELECT product, id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id,
            parent_id, summary
       FROM audit ORDER BY product, id`,
  );

async function seedLicense(
  db: Db,
  product: string,
  id: string,
  sub: string | null,
  accountId: string | null,
): Promise<void> {
  await insertLicense(db, {
    product,
    id,
    status: "active",
    sub,
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
  if (accountId)
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      accountId,
      product,
      id,
    );
}

/**
 * The account holds a platform sign-in (subject SUB). Its product audit holds the rows the four
 * writers leave for such a person (`scrubbed`) and rows that merely look like them (`untouched`).
 */
async function auditWorld() {
  const w = await world();
  await seedProduct(w.db, "other");
  await insertLink(
    w.db,
    w.id,
    {
      issuerKey: PLATFORM,
      tenantScope: "",
      subject: SUB,
      kind: "oidc",
      email: PERSON_EMAIL,
      emailVerified: true,
      displayName: PERSON_NAME,
      amr: null,
    },
    NOW,
  );
  // Minted for the person (keyed by their subject) and still in their library...
  await seedLicense(w.db, "acme", "lic-held", SUB, w.id);
  // ...one they removed from it since (a floating licence keeps its subject)...
  await seedLicense(w.db, "other", "lic-gone", SUB, null);
  // ...and other people's.
  await seedLicense(w.db, "acme", "lic-else", "user-else", null);
  await seedLicense(w.db, "other", "lic-else2", "user-else", null);
  const scrubbed = [
    // The portal's Discover claim.
    auditRow({
      id: "s1-discover",
      ...AS_PERSON,
      action: "license.create",
      target_kind: "license",
      target_id: "lic-held",
      summary: `Auto-issued to ${PERSON_EMAIL} from the portal's Discover (source: discover; path: auto_issue; reason: free_with_account)`,
    }),
    // The product sign-in's tier change, licence merge and licence chooser (`oidc.ts`).
    auditRow({
      id: "s2-tier",
      ...AS_PERSON,
      action: "license.tier.change",
      target_kind: "license",
      target_id: "lic-held",
      summary:
        "Moved from tier free to the higher-rank tier pro at sign-in (syncTierOnSignIn: upgradeOnly)",
    }),
    auditRow({
      id: "s3-merge",
      ...AS_PERSON,
      action: "license.merge",
      target_kind: "license",
      target_id: "lic-held",
      parent_id: "lic-enrolled",
      summary: `Claimed the auto-issued license for ${PERSON_EMAIL}`,
    }),
    auditRow({
      id: "s4-removed",
      product: "other",
      ...AS_PERSON,
      action: "license.create",
      target_kind: "license",
      target_id: "lic-gone",
      summary: `Auto-issued to ${PERSON_EMAIL} from the portal's Discover (source: discover; path: group; reason: group:beta)`,
    }),
    auditRow({
      id: "s5-chooser",
      ...AS_PERSON,
      action: SIGNIN_LICENSE_CHOSEN_ACTION,
      target_kind: "license",
      target_id: null,
      summary: "Chose a new free license to sign in Ada's MacBook",
    }),
  ];
  const untouched = [
    // The same subject acting as an operator on someone else's licence or on the product itself
    // (the console signs operators in at the same IdP): console history stays attributed.
    auditRow({
      id: "u1-operator",
      ...AS_PERSON,
      action: "license.disable",
      target_kind: "license",
      target_id: "lic-else",
      summary: "Disabled license lic-else",
    }),
    auditRow({
      id: "u2-operator-other-product",
      product: "other",
      ...AS_PERSON,
      action: "license.disable",
      target_kind: "license",
      target_id: "lic-else2",
    }),
    auditRow({
      id: "u3-operator-product",
      ...AS_PERSON,
      action: "schema.publish",
      target_kind: "product",
      target_id: "acme",
    }),
    // The same address and name under another subject: an address alone is not a link, even on
    // the person's own licence.
    auditRow({
      id: "u4-email-only",
      actor_sub: "g-1",
      actor_name: "A. Lovelace",
      actor_email: PERSON_EMAIL,
      action: "license.create",
      target_kind: "license",
      target_id: "lic-held",
      summary: `Created for ${PERSON_EMAIL}`,
    }),
    // Another person on their own licence.
    auditRow({
      id: "u5-someone-else",
      actor_sub: "user-else",
      actor_name: "Else",
      actor_email: "else@example.com",
      action: "license.create",
      target_kind: "license",
      target_id: "lic-else",
      summary: "Auto-issued to else@example.com",
    }),
    // The developer's record: the person's pairwise subject, never an identity of theirs.
    auditRow({
      id: "u6-pairwise",
      actor_sub: w.subject,
      action: "license.attach",
      target_kind: "license",
      target_id: "lic-1",
      summary: `Added to the account of ${w.subject} from device dev-1 (via device)`,
    }),
    // A row the runtime wrote.
    auditRow({ id: "u7-system", action: "device.deauthorize" }),
  ];
  for (const row of [...scrubbed, ...untouched]) await appendAudit(w.db, row);
  return { w, scrubbed, untouched };
}

const anonymised = (row: AuditRow): AuditRow => ({
  ...row,
  actor_sub: ERASED_AUDIT_ACTOR,
  actor_name: null,
  actor_email: null,
  summary: ERASED_AUDIT_SUMMARY,
});

describe("I-11: erasure anonymises the product audit rows that name the person", () => {
  it("replaces actor, name, email and summary on the person's rows, keeps the event and its object, and leaves every other row as it was", async () => {
    const { w, scrubbed, untouched } = await auditWorld();
    expect(await deletion.deleteAccount(w.ctx(), w.id)).toEqual({ ok: true });

    const after = await auditRows(w.db);
    expect(after).toHaveLength(scrubbed.length + untouched.length);
    const row = (r: AuditRow) =>
      after.find((a) => a.product === r.product && a.id === r.id);
    for (const r of scrubbed) expect(row(r)).toEqual(anonymised(r));
    for (const r of untouched) expect(row(r)).toEqual(r);
    // Nothing that identified the person survives on a row that was theirs.
    const theirs = JSON.stringify(scrubbed.map(row));
    for (const pii of [SUB, PERSON_EMAIL, PERSON_NAME, "Lovelace", "MacBook"])
      expect(theirs).not.toContain(pii);
  });

  it("waits for the commit: a failing store leaves the rows alone until the retry finishes the erasure", async () => {
    const { w, scrubbed } = await auditWorld();
    let failing = true;
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        if (failing) throw new Error("DO unavailable");
      },
    });
    const before = await auditRows(w.db);
    expect(await deletion.deleteAccount(w.ctx(), w.id)).toEqual({
      ok: true,
      erasing: true,
    });
    expect(await auditRows(w.db)).toEqual(before);

    failing = false;
    expect(await deletion.sweepErasures(w.ctx(NOW + 2 * 3600))).toEqual({
      completed: 1,
      attempted: 1,
    });
    expect(
      (await auditRows(w.db))
        .filter((r) => r.actor_sub === ERASED_AUDIT_ACTOR)
        .map((r) => r.id)
        .sort(),
    ).toEqual(scrubbed.map((r) => r.id).sort());
  });

  it("anonymises nothing for an account with no platform sign-in: an address, a Google subject or a tenant-scoped subject is no link", async () => {
    const w = await world();
    await insertLink(
      w.db,
      w.id,
      {
        issuerKey: "https://accounts.google.com",
        tenantScope: "",
        subject: "g-1",
        kind: "google",
        email: EMAIL,
        emailVerified: true,
        displayName: null,
        amr: null,
      },
      NOW,
    );
    await insertLink(
      w.db,
      w.id,
      {
        issuerKey: PLATFORM,
        tenantScope: "team-1",
        subject: "tenant-sub",
        kind: "oidc",
        email: null,
        emailVerified: false,
        displayName: null,
        amr: null,
      },
      NOW,
    );
    const rows = [
      // The account's own verified address and its own licence.
      auditRow({
        id: "e1",
        actor_sub: "x-1",
        actor_name: "Erase Me",
        actor_email: EMAIL,
        action: "license.create",
        target_kind: "license",
        target_id: "lic-1",
        summary: `Auto-issued to ${EMAIL}`,
      }),
      ...["g-1", "tenant-sub", SUB].map((sub, i) =>
        auditRow({
          id: `e${i + 2}`,
          actor_sub: sub,
          actor_name: "Erase Me",
          action: "license.create",
          target_kind: "license",
          target_id: "lic-1",
        }),
      ),
    ];
    for (const r of rows) await appendAudit(w.db, r);
    expect(await deletion.deleteAccount(w.ctx(), w.id)).toEqual({ ok: true });
    expect(await auditRows(w.db)).toEqual(rows);
  });

  it("searches the audit index by product instead of scanning the whole table (R11-08)", async () => {
    const { w } = await auditWorld();
    const stmt = stmtScrubAccountAudit(w.id);
    const plan = (
      await w.db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${stmt.sql}`,
        ...stmt.params,
      )
    )
      .map((p) => p.detail)
      .join(" | ");
    expect(plan).toMatch(
      /SEARCH audit USING INDEX idx_audit_time \(product=\?\)/,
    );
    expect(plan).not.toMatch(/SCAN audit/);
  });

  it("names the sign-in chooser's action exactly as the product sign-in writes it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const oidc = readFileSync(
      join(
        here,
        "..",
        "src",
        "services",
        "identity",
        "productOidc",
        "chooser.ts",
      ),
      "utf8",
    );
    expect(oidc).toContain(`action: "${SIGNIN_LICENSE_CHOSEN_ACTION}"`);
  });
});

// ── I-11: the erasure ledger, written ahead and replayed after a restore ─────────────────────

/** A bucket whose writes can be made to fail, and that shows D1 at the moment of each write. */
class LedgerBucket extends R2Mock {
  failWrites = false;
  beforeWrite: (key: string) => Promise<void> = async () => {};
  override async put(...args: Parameters<R2Mock["put"]>) {
    await this.beforeWrite(args[0]);
    if (this.failWrites) throw new Error("R2 5xx: the bucket is unavailable");
    return super.put(...args);
  }
}

const ledgerText = async (r2: R2Mock, accountId: string) =>
  await ((await r2.get(erasureKey(accountId))) as R2ObjectBody).text();

describe("I-11: the erasure is recorded outside D1 before anything irreversible happens", () => {
  it("writes the record BEFORE any D1 change, and the record is the opaque id and a time, nothing else", async () => {
    const r2 = new LedgerBucket();
    const w = await world(r2);
    const seen: Array<Record<string, unknown>> = [];
    r2.beforeWrite = async (key) => {
      const named = await rowsNaming(w.db, w.id);
      seen.push({
        key,
        status: (await getAccountRow(w.db, w.id))!.status,
        sessions: named.sessions,
        progress: named.erasures,
      });
    };
    expect(await deletion.deleteAccount(w.ctx(), w.id)).toEqual({ ok: true });
    // When R2 was written, the account was still whole.
    expect(seen).toEqual([
      { key: `erasures/${w.id}`, status: "active", sessions: 1, progress: 0 },
    ]);
    // The bucket holds that one object, and no email, name or product is in it.
    expect(r2.keys()).toEqual([`erasures/${w.id}`]);
    const raw = await ledgerText(r2, w.id);
    expect(raw).toBe(JSON.stringify({ v: 1, accountId: w.id, erasedAt: NOW }));
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain("acme");
    expect((await r2.head(`erasures/${w.id}`))?.httpMetadata?.contentType).toBe(
      "application/json",
    );
  });

  it("an unavailable ledger refuses the erasure with D1 untouched; the retry completes it", async () => {
    const r2 = new LedgerBucket();
    const w = await world(r2);
    const calls: string[] = [];
    registerSubjectStore("steady", {
      merge: async () => {},
      delete: async () => {
        calls.push("steady");
      },
    });
    const before = await snapshotDb(w.db);
    r2.failWrites = true;
    await expect(deletion.deleteAccount(w.ctx(), w.id)).rejects.toThrow(
      ErasureLedgerError,
    );
    // Not a row, not a session, not a registry token changed; no store was asked to delete.
    expect(await snapshotDb(w.db)).toEqual(before);
    expect(calls).toEqual([]);
    expect(r2.keys()).toEqual([]);
    r2.failWrites = false;
    expect(await deletion.deleteAccount(w.ctx(NOW + 60), w.id)).toEqual({
      ok: true,
    });
    expect(calls).toEqual(["steady"]);
    expect(r2.keys()).toEqual([`erasures/${w.id}`]);
    expect(await getAccountRow(w.db, w.id)).toBeNull();
  });

  it("an unbound BLOBS bucket refuses the erasure the same way", async () => {
    const w = await world();
    delete w.env.BLOBS;
    const before = await snapshotDb(w.db);
    await expect(deletion.deleteAccount(w.ctx(), w.id)).rejects.toThrow(
      /BLOBS bucket is not bound/,
    );
    expect(await snapshotDb(w.db)).toEqual(before);
  });

  it("an account that does not exist is not recorded", async () => {
    const w = await world();
    expect(await deletion.deleteAccount(w.ctx(), "acct_missing")).toEqual({
      ok: false,
    });
    expect(w.r2.keys()).toEqual([]);
  });

  it("a retry, a double invoke and the sweeper never rewrite the record: the first one stands", async () => {
    const w = await world();
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        throw new Error("down");
      },
    });
    await deletion.deleteAccount(w.ctx(NOW), w.id);
    const first = await w.r2.head(`erasures/${w.id}`);
    await deletion.deleteAccount(w.ctx(NOW + 5), w.id);
    await deletion.sweepErasures(w.ctx(NOW + 2 * 3600));
    expect((await w.r2.head(`erasures/${w.id}`))?.etag).toBe(first?.etag);
    expect(JSON.parse(await ledgerText(w.r2, w.id)).erasedAt).toBe(NOW);
    expect(w.r2.keys()).toEqual([`erasures/${w.id}`]);
  });

  it("a request that is only scheduled is not recorded, cancelled or not; the due claim records it", async () => {
    const w = await world();
    await scheduleAccountDeletion(w.db, w.id, NOW);
    expect(w.r2.keys()).toEqual([]);
    expect(await cancelAccountDeletion(w.db, w.id, NOW + 60)).toBe("cancelled");
    expect(w.r2.keys()).toEqual([]);
    await scheduleAccountDeletion(w.db, w.id, NOW + 120);
    const due = NOW + 120 + ACCOUNT_DELETION_GRACE_SECONDS;
    expect(await sweepAccountDeletions(w.ctx(due - 1))).toEqual({
      attempted: 0,
      started: 0,
    });
    expect(w.r2.keys()).toEqual([]);
    expect(await sweepAccountDeletions(w.ctx(due))).toEqual({
      attempted: 1,
      started: 1,
    });
    expect(w.r2.keys()).toEqual([`erasures/${w.id}`]);
    expect(await getAccountRow(w.db, w.id)).toBeNull();
  });

  it("a due deletion that cannot be recorded keeps its request and is claimed again after its lease", async () => {
    const r2 = new LedgerBucket();
    const w = await world(r2);
    await scheduleAccountDeletion(w.db, w.id, NOW);
    const due = NOW + ACCOUNT_DELETION_GRACE_SECONDS;
    r2.failWrites = true;
    await expect(sweepAccountDeletions(w.ctx(due))).rejects.toThrow(
      ErasureLedgerError,
    );
    expect((await getAccountRow(w.db, w.id))?.status).toBe("active");
    expect(await accountDeletionSchedule(w.db, w.id)).not.toBeNull();
    // The lease holds the claim, so nothing is hammered while R2 is down...
    expect(await sweepAccountDeletions(w.ctx(due + 60))).toEqual({
      attempted: 0,
      started: 0,
    });
    // ...and once it is back the next claim completes the erasure.
    r2.failWrites = false;
    expect(
      await sweepAccountDeletions(w.ctx(due + ACCOUNT_DELETION_CLAIM_SECONDS)),
    ).toEqual({ attempted: 1, started: 1 });
    expect(await getAccountRow(w.db, w.id)).toBeNull();
    expect(r2.keys()).toEqual([`erasures/${w.id}`]);
  });

  it("an erasure an older Worker closed is recorded before its first hook; a failing ledger runs no hook", async () => {
    const r2 = new LedgerBucket();
    const w = await world(r2);
    const calls: string[] = [];
    registerSubjectStore("steady", {
      merge: async () => {},
      delete: async () => {
        calls.push("steady");
      },
    });
    await w.db.run("UPDATE accounts SET status = 'deleted' WHERE id = ?", w.id);
    r2.failWrites = true;
    expect(await deletion.sweepErasures(w.ctx(NOW + 60))).toEqual({
      completed: 0,
      attempted: 1,
    });
    expect(calls).toEqual([]);
    expect(
      await w.db.first(
        "SELECT attempts, failed_step, lease_until FROM account_erasures WHERE account_id = ?",
        w.id,
      ),
    ).toEqual({ attempts: 1, failed_step: "ledger", lease_until: 0 });
    expect(await getAccountRow(w.db, w.id)).not.toBeNull();
    r2.failWrites = false;
    expect(await deletion.sweepErasures(w.ctx(NOW + 2 * 3600))).toEqual({
      completed: 1,
      attempted: 1,
    });
    expect(calls).toEqual(["steady"]);
    expect(r2.keys()).toEqual([`erasures/${w.id}`]);
  });
});

describe("I-11: a D1 restore does not resurrect an erased account", () => {
  it("the replay recreates the tombstone, closes the restored account and erases what the restore brought back", async () => {
    const w = await world();
    await w.db.run(
      `INSERT INTO devices (product, device_id, license_id, status, first_seen, last_seen, subject, bound_by, token_hash)
       VALUES ('acme', 'dev-1', 'lic-1', 'authorized', ?, ?, ?, 'signin', 'th-dev-1')`,
      NOW,
      NOW,
      w.subject,
    );
    const live = await rowsNaming(w.db, w.id);
    expect(live).toMatchObject({ accounts: 1, subjects: 1, sessions: 1 });

    // The bookmark. The erasure completes after it.
    const bookmark = await snapshotDb(w.db);
    expect(await deletion.deleteAccount(w.ctx(NOW + 100), w.id)).toEqual({
      ok: true,
    });
    const tombstone = (db: Db) =>
      db.first(
        "SELECT id, email_hash, merged_into FROM account_tombstones WHERE id = ?",
        w.id,
      );
    expect(await tombstone(w.db)).toEqual({
      id: w.id,
      email_hash: null,
      merged_into: null,
    });

    // Time Travel restores the bookmark: D1 rewinds, the bucket does not.
    await restoreDb(w.db, bookmark);
    expect(await tombstone(w.db)).toBeNull();
    expect(await rowsNaming(w.db, w.id)).toEqual(live);
    expect(w.r2.keys()).toEqual([`erasures/${w.id}`]);

    // The request-time fence: D1 says `active` again, but the ledger holds the id, so the sign-in
    // door refuses before it writes anything, from the restore until (and after) the replay.
    const restored = await snapshotDb(w.db);
    const during = await signIn(
      w.db,
      { issuerKey: "email", subject: EMAIL, kind: "email" },
      NOW + 150,
      { env: w.env },
    );
    expect(during).toEqual({ status: "refused", reason: "account_disabled" });
    expect(await snapshotDb(w.db)).toEqual(restored);

    // What both cron ticks run.
    expect(await deletion.replayErasures(w.ctx(NOW + 200))).toEqual({
      scanned: 1,
      tombstoned: 1,
      reapplied: 1,
      deferred: 0,
      mirrored: 0,
      more: false,
      failures: [],
    });
    expect(await getAccountRow(w.db, w.id)).toBeNull();
    const after = await rowsNaming(w.db, w.id);
    expect(after).toEqual(
      Object.fromEntries(Object.keys(after).map((k) => [k, 0])),
    );
    expect(await tombstone(w.db)).toEqual({
      id: w.id,
      email_hash: null,
      merged_into: null,
    });
    expect(
      (
        await w.db.first<{ subject: string | null }>(
          "SELECT subject FROM devices WHERE device_id = 'dev-1'",
        )
      )?.subject ?? null,
    ).toBeNull();
    // The record is the one the erasure wrote: the replay never rewrites it.
    expect(JSON.parse(await ledgerText(w.r2, w.id))).toEqual({
      v: 1,
      accountId: w.id,
      erasedAt: NOW + 100,
    });
    // The person signing in again is a fresh account, not the restored one.
    const again = await signIn(
      w.db,
      { issuerKey: "email", subject: EMAIL, kind: "email" },
      NOW + 300,
      { env: w.env },
    );
    expect(again.status).toBe("signed_in");
    if (again.status === "signed_in") expect(again.account.id).not.toBe(w.id);
  });

  it("a second pass over a consistent state changes nothing", async () => {
    const w = await world();
    const bookmark = await snapshotDb(w.db);
    await deletion.deleteAccount(w.ctx(NOW + 100), w.id);
    await restoreDb(w.db, bookmark);
    await deletion.replayErasures(w.ctx(NOW + 200));
    const settled = await snapshotDb(w.db);
    const writes = w.r2.putAttempts.length;
    expect(await deletion.replayErasures(w.ctx(NOW + 300))).toEqual({
      scanned: 1,
      tombstoned: 0,
      reapplied: 0,
      deferred: 0,
      mirrored: 0,
      more: false,
      failures: [],
    });
    expect(await snapshotDb(w.db)).toEqual(settled);
    expect(w.r2.putAttempts).toHaveLength(writes);
  });

  it("an erasure interrupted after the ledger write is finished by the replay", async () => {
    const w = await world();
    // The Worker died between the record and the closing batch: R2 names the account, D1 never moved.
    await recordErasure(w.env, w.id, NOW);
    expect((await getAccountRow(w.db, w.id))?.status).toBe("active");
    expect(await deletion.replayErasures(w.ctx(NOW + 60))).toMatchObject({
      scanned: 1,
      tombstoned: 1,
      reapplied: 1,
      failures: [],
    });
    expect(await getAccountRow(w.db, w.id)).toBeNull();
  });

  it("a restored account whose store hook fails is closed and left to the sweeper's back-off", async () => {
    const w = await world();
    let failing = true;
    registerSubjectStore("flaky", {
      merge: async () => {},
      delete: async () => {
        if (failing) throw new Error("DO unavailable");
      },
    });
    await recordErasure(w.env, w.id, NOW);
    // A hook failure is pending work, not a replay failure.
    expect(await deletion.replayErasures(w.ctx(NOW + 60))).toMatchObject({
      reapplied: 1,
      failures: [],
    });
    expect((await getAccountRow(w.db, w.id))?.status).toBe("deleted");
    const progress = () =>
      w.db.first(
        "SELECT attempts, failed_step, next_attempt_at FROM account_erasures WHERE account_id = ?",
        w.id,
      );
    const waiting = await progress();
    expect(waiting).toMatchObject({ attempts: 1, failed_step: "store:flaky" });
    // While it is erasing the replay leaves it alone: its attempts and back-off are the sweeper's.
    expect(await deletion.replayErasures(w.ctx(NOW + 120))).toMatchObject({
      reapplied: 0,
      failures: [],
    });
    expect(await progress()).toEqual(waiting);
    failing = false;
    expect(await deletion.sweepErasures(w.ctx(NOW + 2 * 3600))).toEqual({
      completed: 1,
      attempted: 1,
    });
    expect(await getAccountRow(w.db, w.id)).toBeNull();
  });
});
