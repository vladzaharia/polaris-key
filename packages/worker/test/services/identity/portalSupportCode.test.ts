/**
 * I-11: "Get a support code", `POST /api/products/<p>/support-code`, driven through
 * `handlePortalApi` the way the composition root drives it.
 *
 * What is pinned, and why each is its own failure:
 *   - the code is the person's pairwise subject for that product: created on the first ask and
 *     the same on every ask after, never the account id or anything else of hers, and one the
 *     console's relink accepts while its Users page still does not list it;
 *   - the gates: no session, no CSRF header, another method, the rate limit (charged only for a
 *     product she holds), and one 404 for a product that does not exist, one she holds nothing in
 *     and one whose developer has the portal off;
 *   - no recent sign-in is needed (the export and the removal need one);
 *   - removing her data from the product ends the code and the next ask makes another;
 *   - the published contract: the operation, its `PortalSupportCode` allow-list and the product
 *     page's `supportCode`, which is the same string.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { handlePortalApi } from "../../portalHarness.js";
import { issuePortalSessionRow } from "../../portalSessionRow.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  setPortalToggles,
} from "../../seed.js";
import { SPEC, validateAgainst } from "../../specSchema.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { SUPPORT_CODE_PATTERN } from "../../../src/core/accounts/supportCodes.js";
import { identityEnabled } from "../../../src/core/accounts/identityGate.js";
import { attachLicense } from "../../../src/services/identity/accounts/claim.js";
import type { AccountContext } from "../../../src/services/identity/accounts/links.js";
import { subjectForSupportCode } from "../../../src/core/accounts/supportCodes.js";
import { listProductUsers } from "../../../src/services/identity/accounts/productUsers.js";
import {
  addLibraryEntry,
  getOrCreateAccountByEmail,
} from "../../../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  type PortalSession,
} from "../../../src/services/identity/portal/session.js";
import {
  PRODUCT_SUPPORT_CODE_LIMIT_PER_MINUTE,
  handleProductSupportCode,
} from "../../../src/services/identity/portal/supportCode.js";

const ORIGIN = "https://key.plrs.im";
const PORTAL_SECRET = "test-portal-session-secret";

interface World {
  db: Db;
  env: Env;
}

interface Person {
  email: string;
  accountId: string;
  cookie: string;
  csrf: string;
}

async function person(w: World, email: string): Promise<Person> {
  const account = await getOrCreateAccountByEmail(w.db, email, NOW);
  const { token, session } = await issuePortalSessionRow(
    w.env,
    w.db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  return {
    email,
    accountId: account.id,
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
  };
}

interface CallOptions {
  /** `false`: no CSRF header; a string: that value instead of the session's. */
  csrf?: boolean | string;
  now?: number;
}

async function call(
  w: World,
  method: string,
  target: string,
  who: Person | null,
  opts: CallOptions = {},
): Promise<Response> {
  const url = new URL(`${ORIGIN}${target}`);
  const headers: Record<string, string> = {};
  if (who) {
    headers.cookie = who.cookie;
    if (opts.csrf === undefined || opts.csrf === true)
      headers[PORTAL_CSRF_HEADER] = who.csrf;
    else if (typeof opts.csrf === "string")
      headers[PORTAL_CSRF_HEADER] = opts.csrf;
  }
  const req = new Request(url, { method, headers }) as unknown as Request;
  return handlePortalApi(req, w.env, w.db, url.pathname, opts.now ?? NOW);
}

const ask = (
  w: World,
  who: Person | null,
  product: string,
  opts?: CallOptions,
) => call(w, "POST", `/api/products/${product}/support-code`, who, opts);

/** The code of a 200 answer. */
async function codeOf(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  const doc = (await res.json()) as { supportCode: string };
  return doc.supportCode;
}

const subjectRow = (db: Db, who: Person, product: string) =>
  db.first<{ subject: string; created_at: number }>(
    "SELECT subject, created_at FROM account_product_subjects WHERE account_id = ? AND product = ?",
    who.accountId,
    product,
  );

/** The code stored for a person in a product, undashed, with the subject it names. */
const codeRow = (db: Db, who: Person, product: string) =>
  db.first<{ code: string; subject: string }>(
    `SELECT c.code, c.subject FROM support_codes c
       JOIN account_product_subjects s ON s.product = c.product AND s.subject = c.subject
      WHERE s.account_id = ? AND c.product = ?`,
    who.accountId,
    product,
  );

const createdAudits = (db: Db) =>
  db.all<Record<string, unknown>>(
    `SELECT account_id, action, product, target_kind, target_id, summary
       FROM portal_audit WHERE action = 'portal.support_code.create'`,
  );

interface Facts extends World {
  ada: Person;
  bob: Person;
  /** The subjects a licence attach made: Ada's and Bob's in `djdl`. */
  adaDjdl: string;
  bobDjdl: string;
}

/**
 * Ada holds a licence in `djdl` (which made her subject there) and an open library entry in
 * `free` (which made none). Bob shares `djdl` and holds `bobonly` alone. `plain` exists and nobody
 * holds it.
 */
async function world(): Promise<Facts> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  const w: World = { db, env };
  for (const slug of ["djdl", "free", "bobonly", "plain"])
    await seedProduct(db, slug);
  const ada = await person(w, "ada@example.com");
  const bob = await person(w, "bob@example.com");

  await seedLicenseWithKey(db, "djdl");
  await seedLicenseWithKey(db, "djdl", { id: "lic_djdl_bob" });
  await seedLicenseWithKey(db, "bobonly");
  // Bob's licences carry his address before anything can attach them to Ada.
  await db.run(
    "UPDATE licenses SET email = 'bob@example.com', name = 'Bob Barker' WHERE id IN ('lic_djdl_bob', 'lic_bobonly_1')",
  );
  const ctx: AccountContext = { db, env, now: NOW, origin: ORIGIN };
  const attach = async (who: Person, product: string, licenseId: string) => {
    const r = await attachLicense(ctx, {
      accountId: who.accountId,
      product,
      licenseId,
      via: "key",
    });
    if (!r.ok) throw new Error(`attach ${licenseId}: ${r.reason}`);
    return r.subject;
  };
  const adaDjdl = await attach(ada, "djdl", "lic_djdl_1");
  const bobDjdl = await attach(bob, "djdl", "lic_djdl_bob");
  await attach(bob, "bobonly", "lic_bobonly_1");
  await addLibraryEntry(db, {
    accountId: ada.accountId,
    product: "free",
    via: "open",
    now: NOW - 400,
  });
  return { ...w, ada, bob, adaDjdl, bobDjdl };
}

// ── The code ────────────────────────────────────────────────────────────────────────────────

describe("POST /api/products/<product>/support-code", () => {
  it("creates her pairwise subject for a product she holds as an entry, and answers it", async () => {
    const w = await world();
    expect(await subjectRow(w.db, w.ada, "free")).toBeNull();
    const res = await ask(w, w.ada, "free");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const doc = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["supportCode"]);
    expect(doc.supportCode).toMatch(SUPPORT_CODE_PATTERN);
    expect(validateAgainst("PortalSupportCode", doc)).toEqual([]);
    const subject = await subjectRow(w.db, w.ada, "free");
    expect(subject?.created_at).toBe(NOW);
    // The code is a name for the subject, never the subject itself.
    expect(doc.supportCode).not.toBe(subject?.subject);
    expect((await codeRow(w.db, w.ada, "free"))?.code).toBe(
      String(doc.supportCode).replaceAll("-", ""),
    );
  });

  it("is the code the product page shows and the console's relink accepts for a product with Identity off, and its Users page still does not list it", async () => {
    const w = await world();
    // The relink path matters most where there is no sign-in through the product to mint one.
    expect(await identityEnabled(w.db, "free")).toBe(false);
    // The page shows no code until she asks, and the code she asked for after.
    const pageBefore = await call(w, "GET", "/api/products/free", w.ada);
    expect(await pageBefore.json()).toMatchObject({ supportCode: null });
    const code = await codeOf(await ask(w, w.ada, "free"));
    const pageAfter = await call(w, "GET", "/api/products/free", w.ada);
    expect(await pageAfter.json()).toMatchObject({ supportCode: code });
    // The code resolves, in this product only, to the subject the relink and the Users page use.
    const subject = (await subjectRow(w.db, w.ada, "free"))!.subject;
    expect(await subjectForSupportCode(w.db, "free", code)).toBe(subject);
    expect(await subjectForSupportCode(w.db, "djdl", code)).toBeNull();
    // A subject made only for a code stays off the Users page (S-16 §5.2), audit row and all.
    for (const identityOn of [false, true])
      expect(
        (await listProductUsers(w.db, "free", { identityOn })).users,
        `identityOn=${identityOn}`,
      ).toEqual([]);
  });

  it("answers the same code on every ask: one row, and only the creation is audited", async () => {
    const w = await world();
    const first = await codeOf(await ask(w, w.ada, "free"));
    expect(await codeOf(await ask(w, w.ada, "free"))).toBe(first);
    expect(await codeOf(await ask(w, w.ada, "free", { now: NOW + 90 }))).toBe(
      first,
    );
    expect(
      await w.db.all(
        `SELECT code FROM support_codes c WHERE c.product = 'free'
            AND c.subject IN (SELECT subject FROM account_product_subjects WHERE account_id = ?)`,
        w.ada.accountId,
      ),
    ).toEqual([{ code: first.replaceAll("-", "") }]);
    const audits = await createdAudits(w.db);
    expect(audits).toEqual([
      {
        account_id: w.ada.accountId,
        action: "portal.support_code.create",
        product: "free",
        target_kind: "product",
        target_id: "free",
        summary: "Created a support code for a product",
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(first);
  });

  it("names the subject a licence attach already made, with a code of its own for each person", async () => {
    const w = await world();
    const adas = await codeOf(await ask(w, w.ada, "djdl"));
    expect(await subjectForSupportCode(w.db, "djdl", adas)).toBe(w.adaDjdl);
    // The subject was there; the code is new, so the creation is audited once.
    expect(await createdAudits(w.db)).toHaveLength(1);
    const rows = await w.db.all<{ subject: string }>(
      "SELECT subject FROM account_product_subjects WHERE product = 'djdl'",
    );
    expect(rows.map((r) => r.subject).sort()).toEqual(
      [w.adaDjdl, w.bobDjdl].sort(),
    );
    // Bob shares the product and gets his own, never hers.
    const bobs = await codeOf(await ask(w, w.bob, "djdl"));
    expect(await subjectForSupportCode(w.db, "djdl", bobs)).toBe(w.bobDjdl);
    expect(bobs).not.toBe(adas);
  });

  it("answers the code and nothing else: no account id, address, licence or other product's id", async () => {
    const w = await world();
    for (const [who, product] of [
      [w.ada, "free"],
      [w.ada, "djdl"],
      [w.bob, "bobonly"],
    ] as const) {
      const text = await (await ask(w, who, product)).text();
      expect(Object.keys(JSON.parse(text))).toEqual(["supportCode"]);
      for (const other of [
        w.ada.accountId,
        w.bob.accountId,
        w.ada.email,
        w.bob.email,
        "lic_",
        "acct_",
      ])
        expect(text, `${product}: ${other}`).not.toContain(other);
    }
    // The code she gets for `free` is not her `djdl` one.
    expect(await codeOf(await ask(w, w.ada, "free"))).not.toBe(
      await codeOf(await ask(w, w.ada, "djdl")),
    );
  });

  it("ends with her data in the product, and the next ask makes another", async () => {
    const w = await world();
    const first = await codeOf(await ask(w, w.ada, "free"));
    const removed = await call(w, "DELETE", "/api/products/free/data", w.ada);
    expect(removed.status).toBe(200);
    expect(await subjectRow(w.db, w.ada, "free")).toBeNull();
    expect(await subjectForSupportCode(w.db, "free", first)).toBeNull();
    expect(await w.db.all("SELECT 1 FROM support_codes")).toEqual([]);
    const second = await codeOf(await ask(w, w.ada, "free"));
    expect(second).toMatch(SUPPORT_CODE_PATTERN);
    expect(second).not.toBe(first);
    expect(await subjectForSupportCode(w.db, "free", second)).not.toBeNull();
  });
});

// ── The gates ───────────────────────────────────────────────────────────────────────────────

describe("the support-code route's gates", () => {
  it("needs a portal session", async () => {
    const w = await world();
    const res = await ask(w, null, "free");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(await subjectRow(w.db, w.ada, "free")).toBeNull();
  });

  it("needs the CSRF header, and refuses a wrong one or another person's", async () => {
    const w = await world();
    const missing = await ask(w, w.ada, "free", { csrf: false });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ error: "forbidden" });
    expect(
      (await ask(w, w.ada, "free", { csrf: "not-the-token" })).status,
    ).toBe(403);
    expect((await ask(w, w.ada, "free", { csrf: w.bob.csrf })).status).toBe(
      403,
    );
    // Nothing was made for her.
    expect(await subjectRow(w.db, w.ada, "free")).toBeNull();
    expect(await createdAudits(w.db)).toEqual([]);
  });

  it("answers 405 for another method, with the CSRF header and without", async () => {
    const w = await world();
    for (const method of ["GET", "PUT", "PATCH", "DELETE"])
      for (const csrf of [true, false]) {
        const res = await call(
          w,
          method,
          "/api/products/free/support-code",
          w.ada,
          { csrf },
        );
        // A change without the header is refused before the route; a GET reaches the route.
        const refusedByCsrf = method !== "GET" && !csrf;
        expect(res.status, `${method} csrf=${csrf}`).toBe(
          refusedByCsrf ? 403 : 405,
        );
        if (!refusedByCsrf)
          expect(await res.json()).toEqual({ error: "method_not_allowed" });
      }
    expect(await subjectRow(w.db, w.ada, "free")).toBeNull();
  });

  it("needs no recent sign-in, which the export and the removal do", async () => {
    const w = await world();
    const stale = NOW + 5 * 60 + 1;
    const export_ = await call(w, "GET", "/api/products/free/export", w.ada, {
      now: stale,
    });
    expect(export_.status).toBe(401);
    expect(await export_.json()).toMatchObject({ error: "step_up_required" });
    await codeOf(await ask(w, w.ada, "free", { now: stale }));
    expect((await subjectRow(w.db, w.ada, "free"))?.created_at).toBe(stale);
  });

  it("is limited per account, network and product, and charged only for a product she holds", async () => {
    const w = await world();
    // Never charged for a product she holds nothing in: more than the budget stays a 404.
    for (const product of ["bobonly", "nope"])
      for (let i = 0; i < PRODUCT_SUPPORT_CODE_LIMIT_PER_MINUTE + 3; i++)
        expect((await ask(w, w.ada, product)).status, product).toBe(404);
    for (let i = 0; i < PRODUCT_SUPPORT_CODE_LIMIT_PER_MINUTE; i++)
      expect((await ask(w, w.ada, "free")).status).toBe(200);
    const limited = await ask(w, w.ada, "free");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    // The budget is her own, in the product's own shard: Bob, and her other product, are untouched.
    expect((await ask(w, w.bob, "djdl")).status).toBe(200);
    expect((await ask(w, w.ada, "djdl")).status).toBe(200);
    // A new minute starts a new window.
    expect((await ask(w, w.ada, "free", { now: NOW + 60 })).status).toBe(200);
  });

  it("answers one 404 for a product that does not exist, one she holds nothing in and one whose portal is off", async () => {
    const w = await world();
    const before = await subjectRow(w.db, w.ada, "djdl");
    await setPortalToggles(w.db, "djdl", { portalEnabled: false }, NOW);
    // `bobonly` exists and Bob holds it; `plain` exists and nobody does; `djdl` is hers, switched
    // off. All of them must look like `nope`.
    const answers = new Set<string>();
    for (const product of [
      "bobonly",
      "plain",
      "djdl",
      "nope",
      "Bad_Slug",
      "x".repeat(80),
    ]) {
      const res = await ask(w, w.ada, product);
      answers.add(JSON.stringify([res.status, await res.json()]));
    }
    expect(answers).toEqual(
      new Set([JSON.stringify([404, { error: "not_found" }])]),
    );
    // Nothing was made for her in a product that is not hers, and her own code stands.
    for (const product of ["bobonly", "plain"])
      expect(await subjectRow(w.db, w.ada, product), product).toBeNull();
    expect(await subjectRow(w.db, w.ada, "djdl")).toEqual(before);
    expect(await createdAudits(w.db)).toEqual([]);
    // Switched on again, the same ask answers the same code.
    await setPortalToggles(w.db, "djdl", { portalEnabled: true }, NOW);
    expect(await subjectRow(w.db, w.ada, "djdl")).toEqual(before);
    expect(
      await subjectForSupportCode(
        w.db,
        "djdl",
        await codeOf(await ask(w, w.ada, "djdl")),
      ),
    ).toBe(w.adaDjdl);
  });

  it("is a 401 and makes nothing when her erasure began after the session was checked", async () => {
    const w = await world();
    await w.db.run(
      "UPDATE accounts SET status = 'deleted' WHERE id = ?",
      w.ada.accountId,
    );
    const session: PortalSession = {
      accountId: w.ada.accountId,
      name: "Ada",
      email: w.ada.email,
      csrf: "unused",
      exp: NOW + 1000,
    };
    const req = new Request(`${ORIGIN}/api/products/free/support-code`, {
      method: "POST",
    }) as unknown as Request;
    const res = await handleProductSupportCode(
      req,
      w.env,
      w.db,
      session,
      "free",
      NOW,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(await subjectRow(w.db, w.ada, "free")).toBeNull();
    expect(await createdAudits(w.db)).toEqual([]);
    // Through the portal itself, the session is already refused.
    expect((await ask(w, w.ada, "free")).status).toBe(401);
  });
});

// ── The published contract ──────────────────────────────────────────────────────────────────

describe("the published contract", () => {
  it("documents the route under the portal tag, with its gates and an example that conforms", () => {
    const item = SPEC.paths["/api/products/{product}/support-code"] as Record<
      string,
      any
    >;
    expect(Object.keys(item)).toEqual(["post"]);
    expect(item.post.tags).toEqual(["portal"]);
    expect(Object.keys(item.post.responses)).toEqual([
      "200",
      "401",
      "403",
      "404",
      "405",
      "429",
    ]);
    const ok = item.post.responses["200"].content["application/json"];
    expect(ok.schema).toEqual({
      $ref: "#/components/schemas/PortalSupportCode",
    });
    expect(
      validateAgainst("PortalSupportCode", ok.examples.code.value),
    ).toEqual([]);
  });

  it("publishes the code's shape as an allow-list of one member, the readable-code pattern", () => {
    const schema = SPEC.components.schemas.PortalSupportCode as Record<
      string,
      any
    >;
    expect(schema.properties.supportCode.pattern).toBe(
      SUPPORT_CODE_PATTERN.source,
    );
    const code = "K7M-4QX-9TZ";
    expect(validateAgainst("PortalSupportCode", { supportCode: code })).toEqual(
      [],
    );
    expect(
      validateAgainst("PortalSupportCode", {
        supportCode: code,
        accountId: "acct_1",
      }).join("\n"),
    ).toContain("undocumented member accountId");
    expect(
      validateAgainst("PortalSupportCode", { supportCode: "short" }).join("\n"),
    ).toContain("does not match the pattern");
    expect(validateAgainst("PortalSupportCode", {}).join("\n")).toContain(
      "missing required member supportCode",
    );
  });

  it("declares the product page's `supportCode` as the same string, or null before one exists", () => {
    const product = SPEC.components.schemas.PortalProduct as Record<
      string,
      any
    >;
    const declared = product.allOf
      .map((part: Record<string, any>) => part.properties?.supportCode)
      .find(Boolean);
    expect(declared.type).toEqual(["string", "null"]);
    expect(declared.pattern).toBe(SUPPORT_CODE_PATTERN.source);
    // Optional: a Worker that predates it sends none.
    expect(
      product.allOf.flatMap((part: Record<string, any>) => part.required ?? []),
    ).not.toContain("supportCode");
  });
});
