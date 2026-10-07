/**
 * LX-26: licence holders on the Worker (notes/S-24 §5, §6.1, §6.3; D1–D4, D19).
 *
 *   - Every licence read carries a derived `holder`: floating (no account, no email) or assigned
 *     (in an account, or waiting for its email); legacy rows need no migration. The list filters
 *     on it.
 *   - A licence created with an email joins, in the same request, the account that verified that
 *     address; one whose address no account verified waits and joins at the address's first
 *     verification. The create answer has the same shape either way (D4).
 *   - PATCH assigns a floating licence and refuses to clear an assigned one's email.
 *   - After "Remove from my library" (`detachLicense`) no automatic path re-attaches the licence
 *     to that account (the per-request link sweep, a sign-in, the email hook, an email change);
 *     another account that verifies the email still can, and the key still adds it back.
 *   - A merge moves the blocks to the survivor; a relink's undo removes the block the relink wrote;
 *     an account deletion and a licence deletion remove them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { handlePortalApi } from "./portalHarness.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { listAudit } from "../src/repo.js";
import {
  isFloatingLicense,
  floatingLicenseSql,
} from "../src/core/accountSubjects.js";
import {
  licenseHolder,
  licenseHolderHooksRegistered,
  onAccountEmailVerified,
} from "../src/core/licenseHolders.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import type { AccountContext } from "../src/services/identity/accounts/links.js";
import { linkIdentity } from "../src/services/identity/accounts/links.js";
import {
  attachLicense,
  detachLicense,
  reassignLicense,
} from "../src/services/identity/accounts/claim.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import { deleteAccount } from "../src/services/identity/accounts/deletion.js";
import {
  relinkLicense,
  undoRelink,
} from "../src/services/identity/accounts/productUsers.js";
import {
  accountsVerifyingEmail,
  insertLink,
  verifiedAccountEmails,
} from "../src/services/identity/accounts/repo.js";
import { deleteProduct } from "../src/admin/repo.js";
import type { Db, DbStatement } from "../src/db/types.js";
import {
  syncAccountLicenseLinks,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import { PORTAL_COOKIE } from "../src/services/identity/portal/session.js";

const SLUG = "tonebox";
const PLATFORM_GROUP = "admins";
const PORTAL_SECRET = "test-portal-session-secret";

let db: SqliteDb;
let env: Env;
let ctx: AccountContext;
let call: (method: string, path: string, body?: unknown) => Promise<Response>;

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [SLUG]);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  env.EMAIL = { send: async () => {} } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  await seedProduct(db, SLUG);
  ctx = { db, env, now: NOW, origin: "https://key.plrs.im" };
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Op", email: "op@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  call = (method, path, body) => {
    const full = `/api/products/${SLUG}${path}`;
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${full}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      db,
      full.split("?")[0]!,
      { now: NOW },
    );
  };
});

/** An account that verified `email` with an email code (its email sign-in method). */
async function account(
  email: string,
): Promise<{ id: string; subject: string }> {
  const r = await signIn(
    db,
    { issuerKey: "email", subject: email, kind: "email" },
    NOW,
    { product: { slug: SLUG } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  return { id: r.account.id, subject: r.subject! };
}

async function create(body: Record<string, unknown>) {
  const res = await call("POST", "/license/licenses", body);
  expect(res.status).toBe(201);
  return (await res.json()) as {
    licenseId: string;
    key: string;
    license: Record<string, unknown> & { holder: unknown };
  };
}

async function ownerOf(licenseId: string): Promise<string | null> {
  const row = await db.first<{ account_id: string | null }>(
    "SELECT account_id FROM licenses WHERE product = ? AND id = ?",
    SLUG,
    licenseId,
  );
  return row?.account_id ?? null;
}

async function blocks(licenseId: string): Promise<string[]> {
  const rows = await db.all<{ account_id: string }>(
    `SELECT account_id FROM license_auto_attach_blocks
      WHERE product = ? AND license_id = ? ORDER BY account_id`,
    SLUG,
    licenseId,
  );
  return rows.map((r) => r.account_id);
}

async function portalAudit(accountId: string, action: string) {
  return db.all<{ product: string; target_id: string; summary: string }>(
    `SELECT product, target_id, summary FROM portal_audit
      WHERE account_id = ? AND action = ? ORDER BY at, id`,
    accountId,
    action,
  );
}

/** A portal request as the signed-in account (`GET /api/me` runs the link sweep). */
async function portalMe(accountId: string): Promise<number> {
  const { token } = await issuePortalSessionRow(
    env,
    db,
    { accountId, email: null, name: null },
    NOW,
  );
  const res = await handlePortalApi(
    new Request("https://key.plrs.im/api/me", {
      headers: { cookie: `${PORTAL_COOKIE}=${token}` },
    }),
    env,
    db,
    "/api/me",
    NOW,
  );
  return res.status;
}

/** Recursively, the member names of a JSON value: its shape, not its values. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, shape((v as Record<string, unknown>)[k])]),
    );
  return "value";
}

describe("the holder rule (S-24 D1)", () => {
  it("is one predicate in TypeScript and SQL, with a blank email counting as none", async () => {
    const cases = [
      { account_id: null, email: null, floating: true },
      { account_id: null, email: "", floating: true },
      { account_id: null, email: "   ", floating: true },
      { account_id: null, email: "ada@example.com", floating: false },
      { account_id: "acct_1", email: null, floating: false },
      { account_id: "acct_1", email: "ada@example.com", floating: false },
    ];
    for (const c of cases) {
      expect(isFloatingLicense(c), JSON.stringify(c)).toBe(c.floating);
      const row = await db.first<{ f: number }>(
        `SELECT ${floatingLicenseSql("l")} AS f FROM (SELECT ? AS account_id, ? AS email) l`,
        c.account_id,
        c.email,
      );
      expect(row?.f === 1, `SQL ${JSON.stringify(c)}`).toBe(c.floating);
    }
    expect(licenseHolder({ account_id: null, email: null })).toEqual({
      kind: "floating",
    });
    expect(licenseHolder({ account_id: null, email: "ada@x.io" })).toEqual({
      kind: "assigned",
      inAccount: false,
      email: "ada@x.io",
    });
    expect(licenseHolder({ account_id: "acct_1", email: null })).toEqual({
      kind: "assigned",
      inAccount: true,
    });
  });

  it("Identity's hooks are registered at the composition root", () => {
    expect(licenseHolderHooksRegistered()).toBe(true);
  });
});

describe("holder on licence reads, and the list filter", () => {
  it("is correct for floating, waiting and in-account licences, legacy rows included", async () => {
    const ada = await account("ada@example.com");
    const floating = await create({});
    const waiting = await create({ name: "Bo", email: "bo@example.com" });
    const inAccount = await create({ email: "ada@example.com" });
    // Legacy rows, written the way older code did (no migration): an email and no account is
    // waiting; an empty email and no account is floating; an account and no email is in it.
    await seedLicenseWithKey(db, SLUG, { id: "lic_legacy_waiting" });
    await seedLicenseWithKey(db, SLUG, { id: "lic_legacy_blank" });
    await db.run(
      "UPDATE licenses SET email = '' WHERE product = ? AND id = 'lic_legacy_blank'",
      SLUG,
    );
    await seedLicenseWithKey(db, SLUG, { id: "lic_legacy_owned" });
    await db.run(
      "UPDATE licenses SET email = NULL, account_id = ? WHERE product = ? AND id = 'lic_legacy_owned'",
      ada.id,
      SLUG,
    );

    const expected: Record<string, unknown> = {
      [floating.licenseId]: { kind: "floating" },
      [waiting.licenseId]: {
        kind: "assigned",
        inAccount: false,
        email: "bo@example.com",
      },
      [inAccount.licenseId]: {
        kind: "assigned",
        inAccount: true,
        email: "ada@example.com",
      },
      lic_legacy_waiting: {
        kind: "assigned",
        inAccount: false,
        email: "ada@example.com",
      },
      lic_legacy_blank: { kind: "floating" },
      lic_legacy_owned: { kind: "assigned", inAccount: true },
    };
    // `lic_legacy_waiting` names ada@example.com, which an account verified: it waits for the
    // next sweep (no write on read).
    for (const [id, holder] of Object.entries(expected)) {
      const res = await call("GET", `/license/licenses/${id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { holder: unknown };
      expect(body.holder, id).toEqual(holder);
      // The holder never carries the account's details.
      expect(JSON.stringify(body)).not.toContain(ada.id);
    }
    const list = (await (await call("GET", "/license/licenses")).json()) as {
      licenses: Array<{ id: string; holder: unknown }>;
    };
    for (const l of list.licenses)
      expect(l.holder, l.id).toEqual(expected[l.id]);

    const ids = async (holder: string) => {
      const res = await call("GET", `/license/licenses?holder=${holder}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { licenses: Array<{ id: string }> };
      return body.licenses.map((l) => l.id).sort();
    };
    expect(await ids("floating")).toEqual(
      [floating.licenseId, "lic_legacy_blank"].sort(),
    );
    expect(await ids("waiting")).toEqual(
      [waiting.licenseId, "lic_legacy_waiting"].sort(),
    );
    expect(await ids("inAccount")).toEqual(
      [inAccount.licenseId, "lic_legacy_owned"].sort(),
    );
    expect(await ids("assigned")).toEqual(
      [
        waiting.licenseId,
        inAccount.licenseId,
        "lic_legacy_waiting",
        "lic_legacy_owned",
      ].sort(),
    );
    const bad = await call("GET", "/license/licenses?holder=nobody");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      code: "bad_request",
      fields: ["holder"],
    });
  });
});

describe("association at creation (S-24 D3, D4)", () => {
  it("attaches a licence created for a verified account's email in the same request", async () => {
    const ada = await account("ada@example.com");
    const created = await create({
      name: "Ada",
      email: "  Ada@Example.com ",
    });
    expect(created.license.holder).toEqual({
      kind: "assigned",
      inAccount: true,
      email: "Ada@Example.com",
    });
    expect(await ownerOf(created.licenseId)).toBe(ada.id);
    expect(await portalAudit(ada.id, "account.license.attach")).toEqual([
      {
        product: SLUG,
        target_id: created.licenseId,
        summary: "Attached a license (email)",
      },
    ]);
    const audit = await listAudit(db, SLUG);
    const row = audit.find((a) => a.action === "license.create");
    expect(row?.summary).toContain("(holder: assigned, in an account)");
    // The create answer carries the pairwise subject, never the account id.
    expect(created.license.ownerSubject).toBe(ada.subject);
    expect(JSON.stringify(created)).not.toContain(ada.id);
  });

  it("a licence for an unknown email waits, then joins at the address's first verification", async () => {
    const created = await create({ email: "cy@example.com" });
    expect(created.license.holder).toEqual({
      kind: "assigned",
      inAccount: false,
      email: "cy@example.com",
    });
    expect(await ownerOf(created.licenseId)).toBeNull();
    const audit = await listAudit(db, SLUG);
    expect(audit.find((a) => a.action === "license.create")?.summary).toContain(
      "(holder: assigned, waiting)",
    );

    // The first sign-in with that address creates the account; the hook brings the licence.
    const cy = await account("cy@example.com");
    expect(await onAccountEmailVerified(db, cy.id, "CY@example.com", NOW)).toBe(
      1,
    );
    expect(await ownerOf(created.licenseId)).toBe(cy.id);
    // Idempotent: nothing more to attach.
    expect(await onAccountEmailVerified(db, cy.id, "cy@example.com", NOW)).toBe(
      0,
    );
  });

  it("joins when an existing account adds the address as a sign-in method", async () => {
    const created = await create({ email: "dee@example.com" });
    const dee = await account("dee.old@example.com");
    const linked = await linkIdentity(
      ctx,
      { accountId: dee.id, authenticatedAt: NOW },
      {
        issuerKey: "https://accounts.google.com",
        subject: "google-dee",
        kind: "google",
        email: "dee@example.com",
        emailVerified: true,
      },
    );
    expect(linked.ok).toBe(true);
    expect(await ownerOf(created.licenseId)).toBe(dee.id);
  });

  it("the hook attaches nothing for an address the account has not verified", async () => {
    const created = await create({ email: "eve@example.com" });
    const mallory = await account("mallory@example.com");
    expect(
      await onAccountEmailVerified(db, mallory.id, "eve@example.com", NOW),
    ).toBe(0);
    expect(await ownerOf(created.licenseId)).toBeNull();
  });

  it("answers the same shape whether or not an account verified the email", async () => {
    await account("ada@example.com");
    const known = await create({ name: "A", email: "ada@example.com" });
    const unknown = await create({ name: "B", email: "nobody@example.com" });
    expect(shape(known)).toEqual(shape(unknown));
    expect(Object.keys(known.license.holder as object).sort()).toEqual(
      Object.keys(unknown.license.holder as object).sort(),
    );
  });

  it("a floating licence (no email, or a blank one) attaches nowhere", async () => {
    await account("ada@example.com");
    for (const body of [{}, { email: null }, { email: "   " }]) {
      const created = await create(body);
      expect(created.license.holder).toEqual({ kind: "floating" });
      expect(await ownerOf(created.licenseId)).toBeNull();
      const row = await db.first<{ email: string | null }>(
        "SELECT email FROM licenses WHERE product = ? AND id = ?",
        SLUG,
        created.licenseId,
      );
      expect(row?.email).toBeNull();
    }
  });

  it("does not attach on a product whose auto-link resolves off; the licence waits", async () => {
    const ada = await account("ada@example.com");
    await upsertPortalProductSettings(
      db,
      SLUG,
      { autoLinkEnabled: false },
      NOW,
    );
    const created = await create({ email: "ada@example.com" });
    expect(created.license.holder).toEqual({
      kind: "assigned",
      inAccount: false,
      email: "ada@example.com",
    });
    expect(await ownerOf(created.licenseId)).toBeNull();
    expect(
      await onAccountEmailVerified(db, ada.id, "ada@example.com", NOW),
    ).toBe(0);
  });
});

describe("PATCH assigns; clearing an assigned email is refused", () => {
  it("setting an email on a floating licence assigns it and attaches it to the verified account", async () => {
    const ada = await account("ada@example.com");
    const created = await create({});
    const res = await call("PATCH", `/license/licenses/${created.licenseId}`, {
      name: "Ada",
      email: "ada@example.com",
    });
    expect(res.status).toBe(200);
    expect(await ownerOf(created.licenseId)).toBe(ada.id);
    const audit = await listAudit(db, SLUG);
    expect(audit.map((a) => a.action)).toContain("license.holder.assign");
    const read = (await (
      await call("GET", `/license/licenses/${created.licenseId}`)
    ).json()) as { holder: unknown };
    expect(read.holder).toEqual({
      kind: "assigned",
      inAccount: true,
      email: "ada@example.com",
    });
  });

  it("refuses to clear the email of an assigned licence with 400 bad_request", async () => {
    const created = await create({ email: "bo@example.com" });
    for (const email of [null, "", "  "]) {
      const res = await call(
        "PATCH",
        `/license/licenses/${created.licenseId}`,
        { email },
      );
      expect(res.status, JSON.stringify(email)).toBe(400);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("bad_request");
      expect(body.message).toContain("Make floating");
    }
    const row = await db.first<{ email: string | null }>(
      "SELECT email FROM licenses WHERE product = ? AND id = ?",
      SLUG,
      created.licenseId,
    );
    expect(row?.email).toBe("bo@example.com");
    // On a floating licence there is nothing to clear: a no-op, not a refusal.
    const floating = await create({});
    const ok = await call("PATCH", `/license/licenses/${floating.licenseId}`, {
      email: null,
    });
    expect(ok.status).toBe(200);
  });
});

describe("Remove from my library stays removed (S-24 D19, H5)", () => {
  it("no portal request, sign-in, verification or email change re-attaches it; another account still can; the key adds it back", async () => {
    const ada = await account("ada@example.com");
    const created = await create({ email: "ada@example.com" });
    expect(await ownerOf(created.licenseId)).toBe(ada.id);

    expect(
      await detachLicense(ctx, {
        accountId: ada.id,
        product: SLUG,
        licenseId: created.licenseId,
      }),
    ).toEqual({ ok: true });
    expect(await ownerOf(created.licenseId)).toBeNull();
    expect(await blocks(created.licenseId)).toEqual([ada.id]);
    expect(
      await portalAudit(ada.id, "account.license.auto_attach_block"),
    ).toEqual([
      {
        product: SLUG,
        target_id: created.licenseId,
        summary:
          "This license will not be added to the library again automatically",
      },
    ]);
    // It keeps its email: assigned and waiting, for any OTHER account that verifies it.
    expect(
      (
        (await (
          await call("GET", `/license/licenses/${created.licenseId}`)
        ).json()) as { holder: unknown }
      ).holder,
    ).toEqual({ kind: "assigned", inAccount: false, email: "ada@example.com" });

    // A portal request (the per-request sweep), a sign-in (signIn + the sweep a sign-in runs),
    // the email hook and an operator's email edit: none brings it back.
    expect(await portalMe(ada.id)).toBe(200);
    expect(await ownerOf(created.licenseId)).toBeNull();
    await account("ada@example.com");
    await syncAccountLicenseLinks(db, ada.id, NOW);
    expect(await ownerOf(created.licenseId)).toBeNull();
    expect(
      await onAccountEmailVerified(db, ada.id, "ada@example.com", NOW),
    ).toBe(0);
    const patched = await call(
      "PATCH",
      `/license/licenses/${created.licenseId}`,
      { email: "ADA@example.com" },
    );
    expect(patched.status).toBe(200);
    expect(await ownerOf(created.licenseId)).toBeNull();

    // Another account that verifies the address still gets it.
    const bo = await account("bo@example.com");
    await insertLink(
      db,
      bo.id,
      {
        issuerKey: "https://accounts.google.com",
        tenantScope: "",
        subject: "google-bo",
        kind: "google",
        email: "ada@example.com",
        emailVerified: true,
        displayName: null,
        amr: null,
      },
      NOW,
    );
    expect(
      await onAccountEmailVerified(db, bo.id, "ada@example.com", NOW),
    ).toBe(1);
    expect(await ownerOf(created.licenseId)).toBe(bo.id);

    // And the person can always add it back with the key; that lifts their block.
    await detachLicense(ctx, {
      accountId: bo.id,
      product: SLUG,
      licenseId: created.licenseId,
    });
    expect(await blocks(created.licenseId)).toEqual([ada.id, bo.id].sort());
    const back = await attachLicense(ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId: created.licenseId,
      via: "key",
    });
    expect(back).toMatchObject({ ok: true, attached: true });
    expect(await blocks(created.licenseId)).toEqual([bo.id]);
  });

  it("the OIDC-subject half of the sweep honours the block too", async () => {
    const ada = await account("ada@example.com");
    await insertLink(
      db,
      ada.id,
      {
        issuerKey: "https://id.plrs.im",
        tenantScope: "",
        subject: "oidc-ada",
        kind: "oidc",
        email: null,
        emailVerified: false,
        displayName: null,
        amr: null,
      },
      NOW,
    );
    const created = await create({});
    await db.run(
      "UPDATE licenses SET sub = 'oidc-ada' WHERE product = ? AND id = ?",
      SLUG,
      created.licenseId,
    );
    await syncAccountLicenseLinks(db, ada.id, NOW);
    expect(await ownerOf(created.licenseId)).toBe(ada.id);
    await detachLicense(ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId: created.licenseId,
    });
    await syncAccountLicenseLinks(db, ada.id, NOW);
    expect(await ownerOf(created.licenseId)).toBeNull();
  });

  it("an email change on a removed licence never lands it back in the account that removed it", async () => {
    const ada = await account("ada@example.com");
    const created = await create({ email: "other@example.com" });
    // In ada's library (as a claim the developer allowed would put it), then removed by her.
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      ada.id,
      SLUG,
      created.licenseId,
    );
    await detachLicense(ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId: created.licenseId,
    });
    // LX-30: a PATCH no longer gives an email-bearing licence another address (that is
    // Reassign…, below); the refusal changes nothing.
    const res = await call("PATCH", `/license/licenses/${created.licenseId}`, {
      email: "ada@example.com",
    });
    expect(res.status).toBe(400);
    expect(await ownerOf(created.licenseId)).toBeNull();
    // Reassign… to her address does not land it back in her library either: the block holds.
    const moved = await call(
      "POST",
      `/users/licenses/${created.licenseId}/reassign`,
      {
        email: "ada@example.com",
        reason: "Back to Ada",
        confirm: created.licenseId,
      },
    );
    expect(moved.status).toBe(200);
    expect(await ownerOf(created.licenseId)).toBeNull();
  });
});

describe("PATCH never gives an email-bearing licence to another address (LX-30, S-24 D20)", () => {
  const patch = (id: string, body: Record<string, unknown>) =>
    call("PATCH", `/license/licenses/${id}`, body);
  const emailOf = async (id: string) =>
    (
      await db.first<{ email: string | null }>(
        "SELECT email FROM licenses WHERE product = ? AND id = ?",
        SLUG,
        id,
      )
    )?.email ?? null;

  it("refuses another address on a waiting licence and on one in an account, pointing at Reassign", async () => {
    await account("ada@example.com");
    const inAccount = await create({ email: "ada@example.com" });
    expect(await ownerOf(inAccount.licenseId)).not.toBeNull();
    const waiting = await create({ email: "bo@example.com" });
    for (const id of [inAccount.licenseId, waiting.licenseId]) {
      const before = await emailOf(id);
      const res = await patch(id, { email: "cy@example.com" });
      expect(res.status, id).toBe(400);
      const body = (await res.json()) as {
        code: string;
        message: string;
        fields: string[];
      };
      expect(body).toMatchObject({ code: "bad_request", fields: ["email"] });
      expect(body.message).toContain("Reassign");
      expect(await emailOf(id)).toBe(before);
    }
  });

  it("allows a case-only edit, a first email on a floating licence (Assign) and on an in-account licence with none", async () => {
    const waiting = await create({ email: "bo@example.com" });
    expect(
      (await patch(waiting.licenseId, { email: " BO@example.com " })).status,
    ).toBe(200);
    expect(await emailOf(waiting.licenseId)).toBe("BO@example.com");

    const floating = await create({});
    expect(
      (await patch(floating.licenseId, { email: "dee@example.com" })).status,
    ).toBe(200);
    expect(await emailOf(floating.licenseId)).toBe("dee@example.com");

    const ada = await account("ada@example.com");
    const noEmail = await create({});
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      ada.id,
      SLUG,
      noEmail.licenseId,
    );
    expect(
      (await patch(noEmail.licenseId, { email: "ada@example.com" })).status,
    ).toBe(200);
    expect(await emailOf(noEmail.licenseId)).toBe("ada@example.com");
    expect(await ownerOf(noEmail.licenseId)).toBe(ada.id);
  });
});

describe("blocks follow merges, relinks and deletions", () => {
  it("a merge moves the absorbed account's blocks to the survivor", async () => {
    const absorbed = await account("old@example.com");
    const survivor = await account("new@example.com");
    const created = await create({ email: "old@example.com" });
    expect(await ownerOf(created.licenseId)).toBe(absorbed.id);
    await detachLicense(ctx, {
      accountId: absorbed.id,
      product: SLUG,
      licenseId: created.licenseId,
    });
    expect(await blocks(created.licenseId)).toEqual([absorbed.id]);
    const merged = await mergeAccounts(ctx, {
      survivor: { accountId: survivor.id, authenticatedAt: NOW },
      absorbed: { accountId: absorbed.id, authenticatedAt: NOW },
    });
    expect(merged.ok).toBe(true);
    expect(await blocks(created.licenseId)).toEqual([survivor.id]);
    // The survivor now holds old@example.com (the absorbed account's email method moved with the
    // merge), and the licence still stays out.
    await syncAccountLicenseLinks(db, survivor.id, NOW);
    expect(await ownerOf(created.licenseId)).toBeNull();
  });

  it("a relink writes a block for the account it moved the licence from, and its undo removes it", async () => {
    const ada = await account("ada@example.com");
    const bo = await account("bo@example.com");
    const created = await create({ email: "ada@example.com" });
    expect(await ownerOf(created.licenseId)).toBe(ada.id);
    const relinked = await relinkLicense(ctx, {
      product: SLUG,
      from: { subject: ada.subject, accountId: ada.id },
      licenseId: created.licenseId,
      target: bo.subject,
      reason: "support ticket 42",
      actor: { sub: "u1", name: "Op" },
    });
    expect(relinked.ok).toBe(true);
    expect(await ownerOf(created.licenseId)).toBe(bo.id);
    expect(await blocks(created.licenseId)).toEqual([ada.id]);
    if (!relinked.ok) return;
    const undone = await undoRelink(ctx, {
      product: SLUG,
      relinkId: relinked.relinkId,
      reason: "wrong account",
      actor: { sub: "u1", name: "Op" },
    });
    expect(undone.ok).toBe(true);
    expect(await ownerOf(created.licenseId)).toBe(ada.id);
    // The undo's move into ada lifted the block the relink wrote (the move away from bo wrote
    // bo's, which keeps the licence from bouncing back to bo by email).
    expect(await blocks(created.licenseId)).toEqual([bo.id]);
  });

  it("an account deletion removes its blocks", async () => {
    const ada = await account("ada@example.com");
    const created = await create({ email: "ada@example.com" });
    await detachLicense(ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId: created.licenseId,
    });
    expect(await blocks(created.licenseId)).toEqual([ada.id]);
    expect(await deleteAccount(ctx, ada.id)).toEqual({ ok: true });
    expect(await blocks(created.licenseId)).toEqual([]);
  });
});

/** A provider sign-in method on `accountId` whose email is (or is not) provider-verified. */
async function providerLink(
  accountId: string,
  subject: string,
  email: string,
  emailVerified: boolean,
): Promise<void> {
  await insertLink(
    db,
    accountId,
    {
      issuerKey: "https://accounts.google.com",
      tenantScope: "",
      subject,
      kind: "google",
      email,
      emailVerified,
      displayName: null,
      amr: null,
    },
    NOW,
  );
}

describe("which account an email attaches to (D2, D3)", () => {
  it("two provider-only accounts leave the licence waiting; an email-method account wins; an unverified link never attaches", async () => {
    // Two accounts that each verified shared@ only through a provider: ambiguous, so it waits.
    const a = await account("a@example.com");
    const b = await account("b@example.com");
    await providerLink(a.id, "g-a", "shared@example.com", true);
    await providerLink(b.id, "g-b", "shared@example.com", true);
    const shared = await create({ email: "shared@example.com" });
    expect(shared.license.holder).toEqual({
      kind: "assigned",
      inAccount: false,
      email: "shared@example.com",
    });
    expect(await ownerOf(shared.licenseId)).toBeNull();

    // The account holding the address as its email sign-in method beats a provider one.
    const c = await account("c@example.com");
    const d = await account("d@example.com");
    await providerLink(d.id, "g-d", "c@example.com", true);
    const forC = await create({ email: "c@example.com" });
    expect(await ownerOf(forC.licenseId)).toBe(c.id);

    // A link whose email the provider did NOT verify is no proof: nothing attaches.
    const e = await account("e@example.com");
    await providerLink(e.id, "g-e", "unverified@example.com", false);
    const unverified = await create({ email: "unverified@example.com" });
    expect(await ownerOf(unverified.licenseId)).toBeNull();
    expect(
      await onAccountEmailVerified(db, e.id, "unverified@example.com", NOW),
    ).toBe(0);
  });

  it("accountsVerifyingEmail is the exact inverse of verifiedAccountEmails (active accounts)", async () => {
    const a = await account("a@example.com");
    const b = await account("b@example.com");
    const c = await account("c@example.com");
    await providerLink(a.id, "g-a", "x@example.com", true);
    await providerLink(b.id, "g-b", "x@example.com", false);
    await providerLink(c.id, "g-c", "y@example.com", true);
    // A verified primary email with no email method, and an unverified one.
    await db.run(
      "UPDATE accounts SET primary_email = 'z@example.com', primary_email_verified_at = ? WHERE id = ?",
      NOW,
      b.id,
    );
    await db.run(
      "UPDATE accounts SET primary_email = 'w@example.com', primary_email_verified_at = NULL WHERE id = ?",
      c.id,
    );
    const accounts = [a.id, b.id, c.id];
    const addresses = [
      "a@example.com",
      "b@example.com",
      "c@example.com",
      "x@example.com",
      "y@example.com",
      "z@example.com",
      "w@example.com",
    ];
    const verified = new Map<string, string[]>();
    for (const id of accounts)
      verified.set(id, await verifiedAccountEmails(db, id));
    for (const address of addresses) {
      const forward = accounts
        .filter((id) => verified.get(id)!.includes(address))
        .sort();
      const inverse = (await accountsVerifyingEmail(db, address))
        .map((r) => r.accountId)
        .sort();
      expect(inverse, address).toEqual(forward);
    }
    // A disabled account answers neither direction's licence question.
    await db.run("UPDATE accounts SET status = 'disabled' WHERE id = ?", a.id);
    expect(
      (await accountsVerifyingEmail(db, "x@example.com")).map(
        (r) => r.accountId,
      ),
    ).toEqual([]);
  });
});

/**
 * `db`, with a callback run just before the batch that moves a licence's owner pointer
 * (`moveLicenseOwnerEndingLinks`): the moment a sweep could slip in.
 */
function beforeOwnerMove(inner: Db, onMove: () => Promise<void>): Db {
  const moves = (stmts: DbStatement[]) =>
    stmts.some((s) => /UPDATE licenses SET account_id/.test(s.sql));
  return new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (
        (prop === "batch" || prop === "batchChanges") &&
        typeof value === "function"
      )
        return async (stmts: DbStatement[]) => {
          if (moves(stmts)) await onMove();
          return (value as (s: DbStatement[]) => Promise<unknown>).call(
            target,
            stmts,
          );
        };
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe("the block lands before the owner moves (no sweep in between re-attaches)", () => {
  it("detach: blocked at the moment of the move; a sweep then attaches nothing", async () => {
    const ada = await account("ada@example.com");
    const created = await create({ email: "ada@example.com" });
    const seen: string[][] = [];
    const spy = beforeOwnerMove(db, async () => {
      seen.push(await blocks(created.licenseId));
    });
    expect(
      await detachLicense(
        { ...ctx, db: spy },
        { accountId: ada.id, product: SLUG, licenseId: created.licenseId },
      ),
    ).toEqual({ ok: true });
    expect(seen).toEqual([[ada.id]]);
    await syncAccountLicenseLinks(db, ada.id, NOW);
    expect(await ownerOf(created.licenseId)).toBeNull();
  });

  it("detach that loses the race: no new block is left behind, an earlier one is kept", async () => {
    const ada = await account("ada@example.com");
    const bo = await account("bo@example.com");
    const created = await create({ email: "ada@example.com" });
    // Someone else moves the licence between the check and the move: the move fails.
    const racing = beforeOwnerMove(db, async () => {
      await db.run(
        "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
        bo.id,
        SLUG,
        created.licenseId,
      );
    });
    expect(
      await detachLicense(
        { ...ctx, db: racing },
        { accountId: ada.id, product: SLUG, licenseId: created.licenseId },
      ),
    ).toEqual({ ok: false });
    expect(await blocks(created.licenseId)).toEqual([]);
    expect(
      await portalAudit(ada.id, "account.license.auto_attach_block"),
    ).toEqual([]);

    // With a block already there (an earlier removal), a lost race keeps it.
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      ada.id,
      SLUG,
      created.licenseId,
    );
    await db.run(
      "INSERT INTO license_auto_attach_blocks (product, license_id, account_id, created_at) VALUES (?, ?, ?, ?)",
      SLUG,
      created.licenseId,
      ada.id,
      NOW - 60,
    );
    expect(
      await detachLicense(
        { ...ctx, db: racing },
        { accountId: ada.id, product: SLUG, licenseId: created.licenseId },
      ),
    ).toEqual({ ok: false });
    expect(await blocks(created.licenseId)).toEqual([ada.id]);
  });

  it("reassign: the previous owner is blocked at the moment of the move", async () => {
    const ada = await account("ada@example.com");
    const bo = await account("bo@example.com");
    const created = await create({ email: "ada@example.com" });
    const seen: string[][] = [];
    const spy = beforeOwnerMove(db, async () => {
      seen.push(await blocks(created.licenseId));
    });
    const moved = await reassignLicense(
      { ...ctx, db: spy },
      {
        product: SLUG,
        licenseId: created.licenseId,
        toAccountId: bo.id,
        actor: "admin:u1",
        expectedPreviousAccountId: ada.id,
      },
    );
    expect(moved).toEqual({ ok: true, previousAccountId: ada.id });
    expect(seen).toEqual([[ada.id]]);
    expect(await ownerOf(created.licenseId)).toBe(bo.id);
  });
});

describe("a product deletion removes its licences' blocks", () => {
  it("leaves no account id behind", async () => {
    const ada = await account("ada@example.com");
    const created = await create({ email: "ada@example.com" });
    await detachLicense(ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId: created.licenseId,
    });
    expect(await blocks(created.licenseId)).toEqual([ada.id]);
    await deleteProduct(db, SLUG, NOW);
    expect(await blocks(created.licenseId)).toEqual([]);
  });
});
