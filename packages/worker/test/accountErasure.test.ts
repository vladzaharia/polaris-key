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
import { runScheduledMaintenance } from "../src/scheduled.js";

const EMAIL = "erase-me@example.com";

async function world() {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
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
  return { db, env, ctx, id: r.account.id, subject: attached.subject };
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
      join(here, "..", "src", "services", "identity", "oidc.ts"),
      "utf8",
    );
    expect(oidc).toContain(`action: "${SIGNIN_LICENSE_CHOSEN_ACTION}"`);
  });
});
