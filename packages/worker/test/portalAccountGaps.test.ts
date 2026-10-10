// PX-W19 (PORTAL.md §4.26): Make primary on a verified email, Rename on a passkey, and the
// products each address brought in.

import { describe, expect, it } from "vitest";
import { NOW, seedProduct } from "./seed.js";
import {
  Device,
  lastCode,
  seededWorld,
  type CardWorld,
} from "./identityCardHarness.js";
import { STEP_UP_MAX_AGE_SECONDS } from "../src/services/identity/accounts/links.js";

const METHODS = "/api/me/methods";
const PASSKEYS = "/api/me/passkeys";
const STALE = NOW + STEP_UP_MAX_AGE_SECONDS + 60;

async function emailAccount(w: CardWorld, email = "ada@example.com") {
  const d = new Device(w);
  expect((await d.signInWithCode(email, NOW)).status).toBe(200);
  expect((await d.me(NOW)).status).toBe(200);
  const row = await w.db.first<{ id: string }>(
    "SELECT id FROM accounts WHERE primary_email = ?",
    email,
  );
  return { d, accountId: row!.id };
}

async function connectEmail(w: CardWorld, d: Device, email: string) {
  const start = await d.send("POST", `${METHODS}/email/start`, { email });
  expect(start.status).toBe(200);
  const done = await d.send("POST", `${METHODS}/email/verify`, {
    code: lastCode(w, email),
  });
  expect(done.status).toBe(201);
}

interface Body {
  emails: Array<{
    methodId: string;
    email: string;
    primary: boolean;
    productCount: number;
  }>;
  passkeys: Array<{ id: string; methodId: string; name: string | null }>;
  methods: Array<{ id: string; kind: string; display: string | null }>;
  primaryEmail: string | null;
}

async function methods(d: Device, now = NOW): Promise<Body> {
  const res = await d.send("GET", METHODS, undefined, { now });
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

async function addPasskey(
  w: CardWorld,
  accountId: string,
  id: string,
): Promise<string> {
  await w.db.run(
    `INSERT INTO account_passkeys (credential_id, account_id, public_key, sign_count, rp_id,
                                   user_handle, created_at)
     VALUES (?, ?, 'pk', 0, 'key.test', 'uh', ?)`,
    id,
    accountId,
    NOW,
  );
  await w.db.run(
    `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind,
                                email, email_verified, created_at, last_used_at)
     VALUES (?, ?, 'passkey', '', ?, 'passkey', NULL, 0, ?, ?)`,
    `lnk_${id}`,
    accountId,
    id,
    NOW,
    NOW,
  );
  return `lnk_${id}`;
}

async function audit(w: CardWorld, accountId: string): Promise<string[]> {
  return (
    await w.db.all<{ action: string }>(
      "SELECT action FROM portal_audit WHERE account_id = ? ORDER BY at, id",
      accountId,
    )
  ).map((r) => r.action);
}

async function primaryOf(w: CardWorld, accountId: string) {
  return w.db.first<{ p: string; v: number }>(
    "SELECT primary_email AS p, primary_email_verified_at AS v FROM accounts WHERE id = ?",
    accountId,
  );
}

describe("POST /api/me/methods/<id>/primary", () => {
  async function twoEmails() {
    const w = await seededWorld();
    const s = await emailAccount(w);
    await connectEmail(w, s.d, "ada@work.example");
    const b = await methods(s.d);
    const work = b.emails.find((e) => e.email === "ada@work.example")!;
    const home = b.emails.find((e) => e.email === "ada@example.com")!;
    return { w, ...s, work, home };
  }

  it("makes an own verified email primary, audits it and mails every verified address", async () => {
    const { w, d, accountId, work, home } = await twoEmails();
    expect(home.primary).toBe(true);
    w.mail.length = 0;
    const res = await d.send("POST", `${METHODS}/${work.methodId}/primary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.primaryEmail).toBe("ada@work.example");
    expect(body.emails[0]).toEqual(
      expect.objectContaining({ email: "ada@work.example", primary: true }),
    );
    const link = await w.db.first<{ created_at: number }>(
      "SELECT created_at FROM account_links WHERE id = ?",
      work.methodId,
    );
    expect(await primaryOf(w, accountId)).toEqual({
      p: "ada@work.example",
      v: link!.created_at,
    });
    expect(await audit(w, accountId)).toContain("account.email.primary");
    expect(w.mail.map((m) => m.to).sort()).toEqual([
      "ada@example.com",
      "ada@work.example",
    ]);
    // Names no address.
    for (const m of w.mail) {
      expect(m.subject).toBe("Your Polaris Key primary email was changed");
      expect(m.text).not.toContain("@");
    }
  });

  it("answers 200 and writes nothing when the address is already primary", async () => {
    const { w, d, accountId, home } = await twoEmails();
    w.mail.length = 0;
    const before = await audit(w, accountId);
    const res = await d.send("POST", `${METHODS}/${home.methodId}/primary`);
    expect(res.status).toBe(200);
    expect(await audit(w, accountId)).toEqual(before);
    expect(w.mail).toHaveLength(0);
  });

  it("needs a fresh sign-in", async () => {
    const { w, d, accountId, work } = await twoEmails();
    const res = await d.send(
      "POST",
      `${METHODS}/${work.methodId}/primary`,
      undefined,
      { now: STALE },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: "step_up_required" }),
    );
    expect((await primaryOf(w, accountId))!.p).toBe("ada@example.com");
  });

  it("answers 404 for an unknown id and for another account's method", async () => {
    const { w, d } = await twoEmails();
    const other = await emailAccount(w, "bo@example.com");
    const theirs = (await methods(other.d)).emails[0]!.methodId;
    const a = await d.send("POST", `${METHODS}/lnk_nope/primary`);
    const b = await d.send("POST", `${METHODS}/${theirs}/primary`);
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(await b.json()).toEqual(await a.json());
  });

  it("answers 422 for the caller's own non-email method", async () => {
    const { w, d, accountId } = await twoEmails();
    const link = await addPasskey(w, accountId, "cred1");
    const res = await d.send("POST", `${METHODS}/${link}/primary`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: "bad_request" }),
    );
  });

  it("leaves the primary alone when the method is removed between read and write", async () => {
    const { w, d, accountId, work } = await twoEmails();
    // The removal wins the race: the conditional write finds no method and changes nothing.
    await w.db.run("DELETE FROM account_links WHERE id = ?", work.methodId);
    const res = await d.send("POST", `${METHODS}/${work.methodId}/primary`);
    expect(res.status).toBe(404);
    expect((await primaryOf(w, accountId))!.p).toBe("ada@example.com");
    // And the statement itself is guarded, not only the read before it.
    const changed = await w.db.runChanges(
      `UPDATE accounts SET primary_email = ? WHERE id = ? AND primary_email IS NOT ?
        AND EXISTS (SELECT 1 FROM account_links WHERE id = ? AND account_id = ?)`,
      "ada@work.example",
      accountId,
      "ada@work.example",
      work.methodId,
      accountId,
    );
    expect(changed).toBe(0);
  });
});

describe("PATCH /api/me/passkeys/<id>", () => {
  async function withPasskey() {
    const w = await seededWorld();
    const s = await emailAccount(w);
    await addPasskey(w, s.accountId, "cred1");
    return { w, ...s };
  }
  const patch = (d: Device, name: unknown, id = "cred1", now = NOW) =>
    d.send("PATCH", `${PASSKEYS}/${id}`, { name }, { now });

  it("names and clears a passkey, in both lists, audited and not mailed", async () => {
    const { w, d, accountId } = await withPasskey();
    w.mail.length = 0;
    const res = await patch(d, "  Work laptop ");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Body;
    expect(list.passkeys[0]!.name).toBe("Work laptop");
    const m = await methods(d);
    expect(m.passkeys[0]!.name).toBe("Work laptop");
    expect(m.methods.find((x) => x.kind === "passkey")!.display).toBe(
      "Work laptop",
    );
    const audited = await w.db.first<{ summary: string }>(
      "SELECT summary FROM portal_audit WHERE account_id = ? AND action = 'account.passkey.rename'",
      accountId,
    );
    expect(audited!.summary).not.toContain("Work");
    expect(w.mail).toHaveLength(0);
    for (const clear of [null, "   "]) {
      await patch(d, "x");
      expect((await patch(d, clear)).status).toBe(200);
      expect((await methods(d)).passkeys[0]!.name).toBeNull();
    }
    const get = await d.send("GET", PASSKEYS);
    expect(((await get.json()) as Body).passkeys[0]!.name).toBeNull();
  });

  it("refuses a stale sign-in", async () => {
    const { d } = await withPasskey();
    const res = await patch(d, "x", "cred1", STALE);
    expect(res.status).toBe(401);
  });

  it("bounds the name: 64 characters, no control characters, a string", async () => {
    const { d } = await withPasskey();
    expect((await patch(d, "a".repeat(64))).status).toBe(200);
    for (const bad of ["a".repeat(65), "a\nb", "a‮b", "a\u0000b", 5]) {
      expect((await patch(d, bad)).status).toBe(422);
    }
    const noName = await d.send("PATCH", `${PASSKEYS}/cred1`, {});
    expect(noName.status).toBe(422);
    const big = await d.send("PATCH", `${PASSKEYS}/cred1`, {
      name: "a".repeat(5000),
    });
    expect(big.status).toBe(422);
  });

  it("answers the same 404 for an unknown passkey and another account's", async () => {
    const { w, d } = await withPasskey();
    const other = await emailAccount(w, "bo@example.com");
    await addPasskey(w, other.accountId, "cred2");
    const a = await patch(d, "x", "nope");
    const b = await patch(d, "x", "cred2");
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(await b.json()).toEqual(await a.json());
    const untouched = await w.db.first<{ name: string | null }>(
      "SELECT name FROM account_passkeys WHERE credential_id = 'cred2'",
    );
    expect(untouched!.name).toBeNull();
  });
});

describe("emails[].productCount", () => {
  it("counts distinct portal-visible products by the licence's own email, case-insensitively", async () => {
    const w = await seededWorld();
    const { d, accountId } = await emailAccount(w);
    await connectEmail(w, d, "ada@work.example");
    for (const slug of ["beta", "gone", "off"]) await seedProduct(w.db, slug);
    await w.db.run(
      "UPDATE products SET status = 'deleted' WHERE slug = 'gone'",
    );
    await w.db.run(
      "INSERT INTO portal_product_settings (product, portal_enabled, created_at, modified_at) VALUES ('off', 0, ?, ?)",
      NOW,
      NOW,
    );
    const lic = (product: string, id: string, email: string | null) =>
      w.db.run(
        `INSERT INTO licenses (product, id, status, email, activated_at, modified_at, account_id)
         VALUES (?, ?, 'active', ?, ?, ?, ?)`,
        product,
        id,
        email,
        NOW,
        NOW,
        accountId,
      );
    await lic("acme", "l1", "ADA@Example.com");
    await lic("acme", "l2", "ada@example.com"); // same product twice: one
    await lic("beta", "l3", "ada@example.com");
    await lic("gone", "l4", "ada@example.com"); // deleted: left out
    await lic("off", "l5", "ada@example.com"); // portal off: left out
    await lic("beta", "l6", "ada@work.example");
    await lic("acme", "l7", null); // no email on the licence
    const b = await methods(d);
    const count = (e: string) =>
      b.emails.find((x) => x.email === e)!.productCount;
    expect(count("ada@example.com")).toBe(2);
    expect(count("ada@work.example")).toBe(1);
  });

  it("is 0 with no licences", async () => {
    const w = await seededWorld();
    const { d } = await emailAccount(w);
    expect((await methods(d)).emails[0]!.productCount).toBe(0);
  });
});
