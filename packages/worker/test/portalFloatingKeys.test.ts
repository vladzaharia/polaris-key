/**
 * PX-23 — the portal's floating keys and licence origins (notes/S-24 §10, D19, D21, D22;
 * docs/design/PORTAL.md §4.17, §4.20):
 *
 *   1. The activate preview says how many devices an addable licence is already on (a count, no
 *      labels) and whether the product runs Cloud Sync.
 *   2. Every portal licence summary says how the licence reached the person: `key`, `store-key`,
 *      `store`, `developer` or `signin`, with the store for the store origins.
 *   3. `DELETE /api/licenses/<p>/<id>` removes a licence from the library through LX-26's
 *      `detachLicense`: it leaves the account, stays out on every later request, is audited, and
 *      the account's devices lose Cloud Sync for it; its key adds it back.
 */

import { issuePortalSessionRow } from "./portalSessionRow.js";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { handleActivate } from "../src/services/license/activation.js";
import { loadProduct, loadProductPublic } from "../src/core/products.js";
import { serializeServices } from "../src/core/services.js";
import { getDevice, setServices } from "../src/core/repo.js";
import {
  resolveSyncPrincipal,
  subjectFor,
} from "../src/core/accounts/accountSubjects.js";
import { applyStoreGrant } from "../src/services/license/storeGrants.js";
import {
  getOrCreateAccountByEmail,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import { portalLicenseOrigin } from "../src/services/identity/portal/origin.js";
import { LICENSE_REMOVE_LIMIT_PER_MINUTE } from "../src/services/identity/portal/selfService.js";
import { handlePortalApi } from "./portalHarness.js";

const SLUG = "djdl";
// The seeded licence carries ada@example.com (test/seed.ts).
const ADA = "ada@example.com";

function portalEnv(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  env.EMAIL = { send: async () => {} } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  return env;
}

interface Session {
  cookie: string;
  csrf: string;
  accountId: string;
}

async function session(env: Env, db: Db, email: string): Promise<Session> {
  const account = await getOrCreateAccountByEmail(db, email, NOW);
  const { token, session } = await issuePortalSessionRow(
    env,
    db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    NOW,
  );
  return {
    cookie: `${PORTAL_COOKIE}=${token}`,
    csrf: session.csrf,
    accountId: account.id,
  };
}

async function call(
  env: Env,
  db: Db,
  method: string,
  path: string,
  s: Session,
  opts: { body?: unknown; csrf?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { cookie: s.cookie };
  if (opts.csrf !== false) headers[PORTAL_CSRF_HEADER] = s.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return handlePortalApi(
    new Request(`https://key.plrs.im${path}`, init) as unknown as Request,
    env,
    db,
    path,
    NOW,
  );
}

async function json<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Turn Identity and Cloud Sync on (Cloud Sync requires Config and Identity). */
async function withCloudSync(db: Db, on: boolean): Promise<void> {
  await setServices(
    db,
    SLUG,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: true },
        sync: { enabled: on },
      },
    }),
    "manifest",
    NOW,
  );
}

async function activate(env: Env, db: Db, key: string, deviceId: string) {
  const product = (await loadProduct(env, db, SLUG))!;
  const res = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": deviceId,
    }),
    env,
    db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
}

/** A licence nobody was named for: no account, no email (floating). */
async function floating(db: Db, id?: string) {
  const seeded = await seedLicenseWithKey(db, SLUG, id ? { id } : {});
  await db.run(
    "UPDATE licenses SET email = NULL, name = NULL WHERE product = ? AND id = ?",
    SLUG,
    seeded.licenseId,
  );
  return seeded;
}

async function libraryProducts(env: Env, db: Db, s: Session) {
  const body = await json<{ products: Array<{ product: string }> }>(
    await call(env, db, "GET", "/api/library", s),
  );
  return body.products.map((p) => p.product);
}

async function licenceIds(env: Env, db: Db, s: Session) {
  const body = await json<{ licenses: Array<{ id: string }> }>(
    await call(env, db, "GET", "/api/licenses", s),
  );
  return body.licenses.map((l) => l.id);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("the activate preview: a floating key's devices (S-24 D22)", () => {
  it("counts the authorized devices of an addable licence, and says whether Cloud Sync runs", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    await withCloudSync(db, true);
    const { key, licenseId } = await floating(db);
    await activate(env, db, key, "dev-a");
    await activate(env, db, key, "dev-b");
    await activate(env, db, key, "dev-c");
    await db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = 'dev-c'",
      SLUG,
    );
    const s = await session(env, db, "mara@fennick.studio");
    const body = await json(
      await call(env, db, "POST", "/api/activate/preview", s, {
        body: { key },
      }),
    );
    expect(body).toMatchObject({
      verdict: "addable",
      devices: 2,
      cloudSync: true,
    });
    // A count only: no device id, label or platform reaches the key holder.
    const text = JSON.stringify(body);
    for (const id of ["dev-a", "dev-b", "dev-c", licenseId])
      expect(text).not.toContain(id);
  });

  it("answers 0 for a licence on no device, and cloudSync false without the service", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    await withCloudSync(db, false);
    const { key } = await floating(db);
    const s = await session(env, db, "mara@fennick.studio");
    const body = await json(
      await call(env, db, "POST", "/api/activate/preview", s, {
        body: { key },
      }),
    );
    expect(body).toMatchObject({
      verdict: "addable",
      devices: 0,
      cloudSync: false,
    });
  });

  it("carries no device count on a refusal", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    // Carries ada@example.com, which this account has not verified.
    const { key } = await seedLicenseWithKey(db, SLUG);
    await activate(env, db, key, "dev-a");
    const s = await session(env, db, "mara@fennick.studio");
    const body = await json(
      await call(env, db, "POST", "/api/activate/preview", s, {
        body: { key },
      }),
    );
    expect(body.verdict).toBe("email_mismatch");
    expect(body.devices).toBeUndefined();
    expect(body.cloudSync).toBeUndefined();
  });

  it("the devices come with it: the claim keeps them on the licence", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    const { key, licenseId } = await floating(db);
    await activate(env, db, key, "dev-a");
    const s = await session(env, db, "mara@fennick.studio");
    const claimed = await call(env, db, "POST", "/api/claim/license-key", s, {
      body: { key },
    });
    expect(claimed.status).toBe(200);
    expect((await json(claimed)).license).toMatchObject({
      id: licenseId,
      deviceCount: 1,
      origin: "key",
    });
    expect((await getDevice(db, SLUG, "dev-a"))?.status).toBe("authorized");
  });
});

describe("licence origins on the portal summary (S-24 D21, O-11, O-17)", () => {
  it("is one rule: store first, then sign-in, then a named holder, then a key", () => {
    const base = {
      origin: "admin",
      sub: null,
      email: null,
      keyCount: 1,
      store: null,
    };
    expect(portalLicenseOrigin(base)).toEqual({
      origin: "key",
      originStore: null,
    });
    // The developer named someone: "From <Developer>", even though it has a key.
    expect(portalLicenseOrigin({ ...base, email: "ada@example.com" })).toEqual({
      origin: "developer",
      originStore: null,
    });
    // A blank email is no email (S-24 D1's one rule).
    expect(portalLicenseOrigin({ ...base, email: "  " }).origin).toBe("key");
    expect(portalLicenseOrigin({ ...base, keyCount: 0 }).origin).toBe(
      "developer",
    );
    expect(
      portalLicenseOrigin({
        ...base,
        origin: "oidc",
        keyCount: 0,
        email: "ada@example.com",
      }).origin,
    ).toBe("signin");
    expect(
      portalLicenseOrigin({ ...base, sub: "legacy-sub", keyCount: 0 }).origin,
    ).toBe("signin");
    expect(
      portalLicenseOrigin({
        ...base,
        email: "ada@example.com",
        store: "steam",
      }),
    ).toEqual({ origin: "store-key", originStore: "steam" });
    expect(
      portalLicenseOrigin({ ...base, keyCount: 0, store: "app-store" }),
    ).toEqual({ origin: "store", originStore: "app-store" });
  });

  it("each origin reaches the list and the detail", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    const s = await session(env, db, ADA);
    // A floating key Ada added: "Key ending …".
    const added = await floating(db, "lic_key");
    expect(
      (
        await call(env, db, "POST", "/api/claim/license-key", s, {
          body: { key: added.key },
        })
      ).status,
    ).toBe(200);
    // Assigned to her email by the developer: joins by email, "From <Developer>".
    await seedLicenseWithKey(db, SLUG, { id: "lic_dev" });
    // Issued by signing in: no key.
    await seedLicenseWithKey(db, SLUG, { id: "lic_signin" });
    await db.run(
      "UPDATE licenses SET origin = 'oidc' WHERE product = ? AND id = 'lic_signin'",
      SLUG,
    );
    await db.run(
      "DELETE FROM keys_index WHERE product = ? AND license_id = 'lic_signin'",
      SLUG,
    );
    // Bought on Steam, with a key: "Steam key ending …".
    await seedLicenseWithKey(db, SLUG, { id: "lic_steam" });
    const product = (await loadProductPublic(db, SLUG))!;
    expect(
      await applyStoreGrant(
        { env, db, product, now: NOW },
        {
          licenseId: "lic_steam",
          flag: "pro",
          store: "steam",
          purchaseKeyHash: "hash-steam",
          action: "grant",
          summary: "grant pro from steam",
        },
      ),
    ).toMatchObject({ ok: true });

    const list = await json<{ licenses: Array<Record<string, unknown>> }>(
      await call(env, db, "GET", "/api/licenses", s),
    );
    const origins: Record<string, [unknown, unknown]> = Object.fromEntries(
      list.licenses.map((l) => [l.id, [l.origin, l.originStore]]),
    );
    expect(origins).toEqual({
      lic_key: ["key", null],
      lic_dev: ["developer", null],
      lic_signin: ["signin", null],
      lic_steam: ["store-key", "steam"],
    });
    for (const [id, [origin, store]] of Object.entries(origins)) {
      const detail = await json(
        await call(env, db, "GET", `/api/licenses/${SLUG}/${id}`, s),
      );
      expect([detail.origin, detail.originStore]).toEqual([origin, store]);
    }
  });
});

describe("DELETE /api/licenses/:product/:licenseId: Remove from my library (S-24 D19)", () => {
  it("removes it; it stays out of the library on every later request; audited; the key adds it back", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    // The developer assigned it to Ada's email: it joins her library on her first request.
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG);
    const s = await session(env, db, ADA);
    expect(await libraryProducts(env, db, s)).toEqual([SLUG]);

    const removed = await call(
      env,
      db,
      "DELETE",
      `/api/licenses/${SLUG}/${licenseId}`,
      s,
    );
    expect(removed.status).toBe(200);
    expect(await json(removed)).toEqual({
      ok: true,
      product: SLUG,
      licenseId,
    });

    // "Reloads": the library, the licence list, the detail and the session read each run the
    // per-request link sweep, and none of them brings it back (LX-26's block).
    for (let i = 0; i < 2; i++) {
      expect(await libraryProducts(env, db, s)).toEqual([]);
      expect(await licenceIds(env, db, s)).toEqual([]);
      expect(
        (await call(env, db, "GET", `/api/licenses/${SLUG}/${licenseId}`, s))
          .status,
      ).toBe(404);
      expect((await call(env, db, "GET", "/api/me", s)).status).toBe(200);
      expect(
        (await call(env, db, "GET", `/api/products/${SLUG}`, s)).status,
      ).toBe(404);
    }
    // It keeps its email: not in an account (assigned and waiting), never floating.
    expect(
      await db.first(
        "SELECT account_id, email FROM licenses WHERE product = ? AND id = ?",
        SLUG,
        licenseId,
      ),
    ).toEqual({ account_id: null, email: ADA });
    const audit = await db.all<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM portal_audit WHERE account_id = ? ORDER BY at, id",
      s.accountId,
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "account.license.auto_attach_block",
        "account.license.detach",
      ]),
    );

    // Removing it again: not yours any more.
    expect(
      (await call(env, db, "DELETE", `/api/licenses/${SLUG}/${licenseId}`, s))
        .status,
    ).toBe(404);

    // The key adds it back (an explicit act lifts the block).
    const preview = await json(
      await call(env, db, "POST", "/api/activate/preview", s, {
        body: { key },
      }),
    );
    expect(preview.verdict).toBe("addable");
    expect(
      (
        await call(env, db, "POST", "/api/claim/license-key", s, {
          body: { key },
        })
      ).status,
    ).toBe(200);
    expect(await licenceIds(env, db, s)).toEqual([licenseId]);
  });

  it("a removed floating key floats again: anyone with the key can add it", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    const { key, licenseId } = await floating(db);
    const mara = await session(env, db, "mara@fennick.studio");
    await call(env, db, "POST", "/api/claim/license-key", mara, {
      body: { key },
    });
    expect(
      (
        await call(
          env,
          db,
          "DELETE",
          `/api/licenses/${SLUG}/${licenseId}`,
          mara,
        )
      ).status,
    ).toBe(200);
    expect(await licenceIds(env, db, mara)).toEqual([]);
    const bo = await session(env, db, "bo@example.com");
    expect(
      (
        await json(
          await call(env, db, "POST", "/api/claim/license-key", bo, {
            body: { key },
          }),
        )
      ).license,
    ).toMatchObject({ id: licenseId, origin: "key" });
  });

  it("the removing account's devices lose Cloud Sync for it; the devices keep running", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    await withCloudSync(db, true);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG);
    await activate(env, db, key, "dev-a");
    const s = await session(env, db, ADA);
    await libraryProducts(env, db, s); // joins by email
    // Ada signed in on the device: its Cloud Sync principal is her pairwise subject.
    const subject = await subjectFor(db, s.accountId, SLUG, NOW);
    await db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = 'dev-a'",
      subject,
      SLUG,
    );
    const before = (await getDevice(db, SLUG, "dev-a"))!;
    expect((await resolveSyncPrincipal(db, before))?.subject).toBe(subject);

    expect(
      (await call(env, db, "DELETE", `/api/licenses/${SLUG}/${licenseId}`, s))
        .status,
    ).toBe(200);
    const after = (await getDevice(db, SLUG, "dev-a"))!;
    expect(after.status).toBe("authorized");
    expect(after.subject).toBe(subject); // a plain detach signs nobody out
    expect(await resolveSyncPrincipal(db, after)).toBeNull();
  });

  it("is 404 for someone else's licence and on a portal-off product, and needs the CSRF header", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    const ada = await session(env, db, ADA);
    await libraryProducts(env, db, ada);
    const bo = await session(env, db, "bo@example.com");
    const path = `/api/licenses/${SLUG}/${licenseId}`;
    expect((await call(env, db, "DELETE", path, bo)).status).toBe(404);
    expect(
      (await call(env, db, "DELETE", path, ada, { csrf: false })).status,
    ).toBe(403);
    await upsertPortalProductSettings(db, SLUG, { portalEnabled: false }, NOW);
    expect((await call(env, db, "DELETE", path, ada)).status).toBe(404);
    await upsertPortalProductSettings(db, SLUG, { portalEnabled: true }, NOW);
    expect(await licenceIds(env, db, ada)).toEqual([licenseId]);
  });

  it("only a licence its key can bring back is removable; the rest are refused with 409 not_removable and nothing written", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    // A key licence the developer assigned to Ada: removable.
    await seedLicenseWithKey(db, SLUG, { id: "lic_key" });
    // A sign-in licence: issued by signing in, no key.
    await seedLicenseWithKey(db, SLUG, { id: "lic_signin" });
    await db.run(
      "UPDATE licenses SET origin = 'oidc', sub = 'oidc-ada' WHERE product = ? AND id = 'lic_signin'",
      SLUG,
    );
    await db.run(
      "DELETE FROM keys_index WHERE product = ? AND license_id = 'lic_signin'",
      SLUG,
    );
    // Its only key was revoked: nothing can bring it back either.
    await seedLicenseWithKey(db, SLUG, { id: "lic_revoked" });
    await db.run(
      "UPDATE keys_index SET status = 'revoked' WHERE product = ? AND license_id = 'lic_revoked'",
      SLUG,
    );
    const s = await session(env, db, ADA);
    const list = await json<{
      licenses: Array<{ id: string; removable: boolean }>;
    }>(await call(env, db, "GET", "/api/licenses", s));
    expect(
      Object.fromEntries(list.licenses.map((l) => [l.id, l.removable])),
    ).toEqual({ lic_key: true, lic_signin: false, lic_revoked: false });
    expect(
      (
        await json(
          await call(env, db, "GET", `/api/licenses/${SLUG}/lic_signin`, s),
        )
      ).removable,
    ).toBe(false);

    for (const id of ["lic_signin", "lic_revoked"]) {
      const refused = await call(
        env,
        db,
        "DELETE",
        `/api/licenses/${SLUG}/${id}`,
        s,
      );
      expect(refused.status).toBe(409);
      expect(await json(refused)).toMatchObject({
        error: "not_removable",
        reason: "no_active_key",
      });
    }
    // Nothing was written: both still in the account, no block, no audit row.
    expect((await licenceIds(env, db, s)).sort()).toEqual([
      "lic_key",
      "lic_revoked",
      "lic_signin",
    ]);
    expect(
      await db.all(
        "SELECT * FROM license_auto_attach_blocks WHERE product = ?",
        SLUG,
      ),
    ).toEqual([]);
    expect(
      await db.all(
        "SELECT action FROM portal_audit WHERE account_id = ? AND action LIKE 'account.license.%' AND action != 'account.license.attach'",
        s.accountId,
      ),
    ).toEqual([]);
  });

  it("a key licence is not removable while the product turns key claims off", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    const { licenseId } = await seedLicenseWithKey(db, SLUG);
    const s = await session(env, db, ADA);
    await upsertPortalProductSettings(
      db,
      SLUG,
      { licenseKeyClaimEnabled: false },
      NOW,
    );
    const detail = await json(
      await call(env, db, "GET", `/api/licenses/${SLUG}/${licenseId}`, s),
    );
    expect(detail).toMatchObject({ id: licenseId, removable: false });
    const refused = await call(
      env,
      db,
      "DELETE",
      `/api/licenses/${SLUG}/${licenseId}`,
      s,
    );
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({
      error: "not_removable",
      reason: "key_claim_off",
    });
    expect(await licenceIds(env, db, s)).toEqual([licenseId]);
    // Turned back on, it is removable again.
    await upsertPortalProductSettings(
      db,
      SLUG,
      { licenseKeyClaimEnabled: true },
      NOW,
    );
    expect(
      (
        await json(
          await call(env, db, "GET", `/api/licenses/${SLUG}/${licenseId}`, s),
        )
      ).removable,
    ).toBe(true);
  });

  it(`is rate limited to ${LICENSE_REMOVE_LIMIT_PER_MINUTE} a minute per account and product`, async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, SLUG);
    const ids: string[] = [];
    for (let i = 0; i <= LICENSE_REMOVE_LIMIT_PER_MINUTE; i++)
      ids.push(
        (await seedLicenseWithKey(db, SLUG, { id: `lic_${i}` })).licenseId,
      );
    const s = await session(env, db, ADA);
    expect((await licenceIds(env, db, s)).sort()).toEqual([...ids].sort());
    const statuses: number[] = [];
    for (const id of ids)
      statuses.push(
        (await call(env, db, "DELETE", `/api/licenses/${SLUG}/${id}`, s))
          .status,
      );
    expect(statuses.slice(0, -1).every((st) => st === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(await licenceIds(env, db, s)).toEqual([ids.at(-1)]);
  });
});
