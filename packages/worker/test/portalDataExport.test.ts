/**
 * I-11: the person's own data. `GET /api/me/export` (the full account export),
 * `GET /api/products/<p>/export` (one product's) and `DELETE /api/products/<p>/data` ("Remove my
 * data from <Product>"), driven through `handlePortalApi` the way the composition root drives it.
 *
 * What is pinned, and why each is its own failure:
 *   - the gates: no session, no CSRF header (a GET too: it hands over personal data), a stale
 *     sign-in, the wrong method, the rate limit, and the same 404 for a product the account holds
 *     nothing in as for one that does not exist;
 *   - the documents conform to the OpenAPI schemas the spec publishes, which declare
 *     `additionalProperties: false` everywhere, so a column nobody chose to export fails here;
 *   - no credential, hash or other person's row is anywhere in the bytes (sentinels planted in
 *     every table an export reads, and in a second account that shares the products);
 *   - the removal's effects: stores, subject, devices, the developer's event, the licence kept
 *     unless chosen, and, when chosen, kept OUT of the library by the very next portal request.
 */

import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { handlePortalApi } from "./portalHarness.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { SPEC, validateAgainst } from "./specSchema.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { insertLicense, upsertDevice } from "../src/core/repo.js";
import {
  registerSubjectStore,
  unregisterSubjectStore,
} from "../src/core/accounts/subjectHooks.js";
import { hashKey } from "../src/platform/crypto.js";
import { attachLicense } from "../src/services/identity/accounts/claim.js";
import {
  ACCOUNT_DELETION_GRACE_SECONDS,
  scheduleAccountDeletion,
} from "../src/services/identity/accounts/lifecycle.js";
import type { AccountContext } from "../src/services/identity/accounts/links.js";
import { EXPORT_ACTIVITY_LIMIT } from "../src/services/identity/portal/dataExport.js";
import {
  ACCOUNT_EXPORT_LIMIT_PER_MINUTE,
  PRODUCT_DATA_REMOVE_LIMIT_PER_MINUTE,
  PRODUCT_EXPORT_LIMIT_PER_MINUTE,
} from "../src/services/identity/portal/dataRoutes.js";
import {
  getOrCreateAccountByEmail,
  portalAudit,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";

const ORIGIN = "https://key.plrs.im";
const PORTAL_SECRET = "test-portal-session-secret";
const ASSET = "a".repeat(64);
/** A stored secret value as the sealed store keeps it (`isSealedEnvelope`). */
const SEALED = JSON.stringify({ v: 2, ct: "SEALED-CIPHERTEXT-SECRET" });

/** Values planted where an export reads, that no export may ever carry. */
const SECRETS = {
  deviceToken: "DEVICE-TOKEN-HASH-SECRET",
  registryHash: "REGISTRY-TOKEN-HASH-SECRET",
  credentialId: "CRED-ID-SECRET",
  publicKey: "PUBLIC-KEY-SECRET",
  userHandle: "USER-HANDLE-SECRET",
  accountHandle: "ACCOUNT-USER-HANDLE-SECRET",
  pictureRef: "PICTURE-REF-HASH-SECRET",
  scopeHash: "SCOPE-HASH-SECRET",
  joinSnapshot: "JOIN-SNAPSHOT-SECRET",
  licenseOverride: "LICENSE-OVERRIDE-SECRET",
  sealed: "SEALED-CIPHERTEXT-SECRET",
  relinkReason: "RELINK-REASON-SECRET",
  relinkOperator: "RELINK-OPERATOR-SECRET",
  revokedBy: "REVOKED-BY-OPERATOR-SECRET",
  oldSession: "OLD-SESSION-HASH-SECRET",
  deviceOverride: "DEVICE-OVERRIDE-SECRET",
} as const;

// ── The world ───────────────────────────────────────────────────────────────────────────────

interface World {
  db: Db;
  env: Env;
  ctx: (now?: number) => AccountContext;
}

interface Person {
  email: string;
  accountId: string;
  cookie: string;
  csrf: string;
}

interface Store {
  deleted: string[];
}

let store: Store = { deleted: [] };

afterEach(() => unregisterSubjectStore("test.notes"));

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  env.EMAIL = {
    send: async () => {},
  } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  // A store of a developer's own subject-keyed data, beside the platform's registered ones.
  store = { deleted: [] };
  unregisterSubjectStore("test.notes");
  registerSubjectStore("test.notes", {
    merge: async () => {},
    delete: async (_ctx, { product, subject }) => {
      store.deleted.push(`${product}:${subject}`);
    },
    export: async (_ctx, { product, subject }) => ({
      notes: [`notes of ${subject} in ${product}`],
    }),
  });
  return {
    db,
    env,
    ctx: (now = NOW) => ({ db, env, now, origin: ORIGIN }),
  };
}

async function person(w: World, email: string, now = NOW): Promise<Person> {
  const account = await getOrCreateAccountByEmail(w.db, email, now);
  const { token, session } = await issuePortalSessionRow(
    w.env,
    w.db,
    {
      accountId: account.id,
      email: account.primary_email,
      name: account.display_name,
    },
    now,
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

const exportAccount = (w: World, who: Person | null, o?: CallOptions) =>
  call(w, "GET", "/api/me/export", who, o);
const exportProduct = (
  w: World,
  who: Person | null,
  product: string,
  o?: CallOptions,
) => call(w, "GET", `/api/products/${product}/export`, who, o);
const removeData = (
  w: World,
  who: Person | null,
  product: string,
  query = "",
  o?: CallOptions,
) => call(w, "DELETE", `/api/products/${product}/data${query}`, who, o);

// A licence the way a developer issues one, for an address; with no key unless given.
async function plainLicense(
  db: Db,
  product: string,
  id: string,
  email: string,
): Promise<void> {
  await insertLicense(db, {
    product,
    id,
    status: "active",
    sub: null,
    name: "Plain Holder",
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

interface Facts {
  ada: Person;
  bob: Person;
  adaSubject: { djdl: string; acme: string };
  bobSubject: { djdl: string; bobonly: string };
  /** Everything an export must never carry, as text. */
  secrets: string[];
  /** Everything that is Bob's alone, as text. */
  bobs: string[];
}

/**
 * Ada holds a licence in `djdl` (with a key and devices) and in `acme` (no key), has a library
 * entry in `free`, and every table an export reads has a row for her, with a sentinel secret in
 * each place a credential lives. Bob shares `djdl` and has `bobonly` to himself.
 */
async function seed(w: World): Promise<Facts> {
  const { db } = w;
  for (const slug of ["djdl", "acme", "free", "bobonly"])
    await seedProduct(db, slug);
  const ada = await person(w, "ada@example.com");
  const bob = await person(w, "bob@example.com");

  // Licences. Bob's carries his address before anything can attach it to Ada.
  const adaKey = await seedLicenseWithKey(db, "djdl", {
    secrets: {
      API_TOKEN: {
        state: "enforced",
        value: SECRETS.licenseOverride,
        updatedAt: NOW,
      },
    },
  });
  await plainLicense(db, "acme", "lic_acme_1", "ada@example.com");
  const bobKey = await seedLicenseWithKey(db, "djdl", { id: "lic_djdl_bob" });
  await db.run(
    "UPDATE licenses SET email = 'bob@example.com', name = 'Bob Barker' WHERE id = 'lic_djdl_bob'",
  );
  await plainLicense(db, "bobonly", "lic_bobonly_1", "bob@example.com");
  const attach = async (who: Person, product: string, licenseId: string) => {
    const r = await attachLicense(w.ctx(), {
      accountId: who.accountId,
      product,
      licenseId,
      via: "key",
    });
    if (!r.ok) throw new Error(`attach ${licenseId}: ${r.reason}`);
    return r.subject;
  };
  const adaSubject = {
    djdl: await attach(ada, "djdl", "lic_djdl_1"),
    acme: await attach(ada, "acme", "lic_acme_1"),
  };
  const bobSubject = {
    djdl: await attach(bob, "djdl", "lic_djdl_bob"),
    bobonly: await attach(bob, "bobonly", "lic_bobonly_1"),
  };

  // Devices: Ada's, one signed in as Bob on Ada's licence, one of Bob's.
  const device = (
    product: string,
    id: string,
    licenseId: string,
    label: string,
    subject: string | null,
  ) =>
    upsertDevice(db, {
      product,
      device_id: id,
      customer_id: null,
      license_id: licenseId,
      status: "authorized",
      first_seen: NOW - 100,
      last_seen: NOW - 10,
      ua: "PolarisKey-Test/1.0",
      label,
      overrides_json: JSON.stringify({ x: SECRETS.deviceOverride }),
      reported_json: JSON.stringify({ y: SECRETS.deviceOverride }),
      token_hash: SECRETS.deviceToken,
      platform: "macos",
      arch: "arm64",
      app_version: "1.2.3",
      sdk_name: "node",
      sdk_version: "4.5.6",
      subject,
    });
  await device("djdl", "dev-ada-1", "lic_djdl_1", "Ada's Mac", adaSubject.djdl);
  await device(
    "djdl",
    "dev-shared",
    "lic_djdl_1",
    "Bob's laptop",
    bobSubject.djdl,
  );
  await device("acme", "dev-ada-acme", "lic_acme_1", "Studio", null);
  await device(
    "djdl",
    "dev-bob-1",
    "lic_djdl_bob",
    "Bob's phone",
    bobSubject.djdl,
  );

  // The subject's history and what the registered stores hold for it.
  await db.run(
    `INSERT INTO account_product_subject_aliases (product, alias, subject, merged_at)
     VALUES ('djdl', 'ps_old_alias_00000000000', ?, ?)`,
    adaSubject.djdl,
    NOW - 500,
  );
  await db.run(
    `INSERT INTO subject_events (product, id, type, subject, payload_json, created_at)
     VALUES ('djdl', 'sev_merged', 'subject.merged', ?, '{"alias":"ps_old_alias_00000000000"}', ?)`,
    adaSubject.djdl,
    NOW - 500,
  );
  const overrides = (config: string, updatedBy: string) =>
    JSON.stringify({
      config: {
        theme: { state: "enforced", value: config, updatedAt: NOW - 50 },
      },
      secrets: {
        API: { state: "enforced", value: SEALED, updatedAt: NOW - 40 },
      },
    });
  for (const [subject, theme] of [
    [adaSubject.djdl, "ADA-DARK"],
    [bobSubject.djdl, "BOB-LIGHT"],
  ] as const)
    await db.run(
      `INSERT INTO account_overrides (product, subject, payload_json, updated_at, updated_by)
       VALUES ('djdl', ?, ?, ?, 'operator')`,
      subject,
      overrides(theme, "operator"),
      NOW - 40,
    );
  for (const [id, subject, keys] of [
    ["ent_ada", adaSubject.djdl, '["pro"]'],
    ["ent_bob", bobSubject.djdl, '["BOB-ENTITLEMENT"]'],
  ] as const)
    await db.run(
      `INSERT INTO entitlement_events (product, id, subject, license_id, keys_json, created_at)
       VALUES ('djdl', ?, ?, NULL, ?, ?)`,
      id,
      subject,
      keys,
      NOW - 30,
    );

  // The account itself: profile, methods, a passkey, pictures, sessions.
  await db.run(
    `UPDATE accounts SET display_name = 'Ada', locale = 'en-GB', avatar_key = ?,
            birthdate = '1815-12-10', birthdate_source = 'user', passkey_user_handle = ?,
            details_source_json = ?, last_sign_in_at = ?
      WHERE id = ?`,
    ASSET,
    SECRETS.accountHandle,
    JSON.stringify({
      name: { source: "explicit", explicit: true },
      picture: { source: "link:lnk_google", explicit: false },
    }),
    NOW - 5,
    ada.accountId,
  );
  await db.run(
    `INSERT INTO account_links
       (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified,
        display_name, amr_json, created_at, last_used_at, profile_json, groups_json, claims_json)
     VALUES ('lnk_google', ?, 'https://accounts.google.com', '', 'google-sub-1234', 'google',
             'ada.g@example.com', 1, 'Ada G', '["google"]', ?, ?, ?, '["staff"]', '{"dept":"eng"}')`,
    ada.accountId,
    NOW - 900,
    NOW - 60,
    JSON.stringify({
      name: "Ada G",
      locale: "en-GB",
      pictureRef: SECRETS.pictureRef,
      avatarKey: ASSET,
    }),
  );
  await db.run(
    `INSERT INTO account_links
       (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified,
        display_name, amr_json, created_at, last_used_at)
     VALUES ('lnk_passkey', ?, 'passkey', '', ?, 'passkey', NULL, 0, NULL, NULL, ?, ?)`,
    ada.accountId,
    SECRETS.credentialId,
    NOW - 800,
    NOW - 70,
  );
  await db.run(
    `INSERT INTO account_passkeys
       (credential_id, account_id, public_key, sign_count, transports_json, rp_id, user_handle,
        created_at, last_used_at, details_json)
     VALUES (?, ?, ?, 7, '["internal"]', 'key.plrs.im', ?, ?, ?, ?)`,
    SECRETS.credentialId,
    ada.accountId,
    SECRETS.publicKey,
    SECRETS.userHandle,
    NOW - 800,
    NOW - 70,
    JSON.stringify({
      aaguid: "00000000-0000-0000-0000-000000000000",
      deviceType: "multiDevice",
      backedUp: true,
      addedFrom: "Safari on macOS",
    }),
  );
  await db.run(
    `INSERT INTO account_avatars (asset, account_id, origin, bytes, created_at)
     VALUES (?, ?, 'provider', 1234, ?)`,
    ASSET,
    ada.accountId,
    NOW - 900,
  );
  await db.run(
    `INSERT INTO account_sessions
       (id_hash, account_id, created_at, last_seen_at, expires_at, revoked_at, user_agent, amr_json)
     VALUES (?, ?, ?, ?, ?, ?, 'Firefox on Windows', '["email"]')`,
    SECRETS.oldSession,
    ada.accountId,
    NOW - 86_400,
    NOW - 80_000,
    NOW + 100,
    NOW - 79_000,
  );

  // What she agreed to, kept, removed and minted.
  await db.run(
    `INSERT INTO account_product_grants (account_id, product, claims_json, granted_at, modified_at, scope_hash)
     VALUES (?, 'djdl', '["name"]', ?, ?, ?)`,
    ada.accountId,
    NOW - 700,
    NOW - 600,
    SECRETS.scopeHash,
  );
  for (const [product, version] of [
    ["djdl", "2026-01"],
    ["_platform", "2026-02"],
  ] as const)
    await db.run(
      `INSERT INTO account_terms_acceptances (account_id, product, version, url, accepted_at)
       VALUES (?, ?, ?, ?, ?)`,
      ada.accountId,
      product,
      version,
      `https://example.com/${product}/terms`,
      NOW - 650,
    );
  await db.run(
    `INSERT INTO library_entries (account_id, product, via, added_at)
     VALUES (?, 'free', 'open', ?)`,
    ada.accountId,
    NOW - 400,
  );
  await db.run(
    `INSERT INTO license_auto_attach_blocks (product, license_id, account_id, created_at)
     VALUES ('djdl', 'lic_removed_earlier', ?, ?)`,
    ada.accountId,
    NOW - 300,
  );
  const token = (
    id: string,
    product: string,
    licenseId: string | null,
    owner: string,
    revoked: boolean,
  ) =>
    db.run(
      `INSERT INTO registry_tokens
         (product, token_id, token_hash, hint, label, scopes_json, ecosystems_json, binding,
          license_id, presentation, created_by, portal_account_id, created_at, expires_at,
          last_used_at, revoked_at, revoked_by, revoke_reason)
       VALUES (?, ?, ?, 'abcd', ?, '["read"]', NULL, ?, ?, 'header', ?, ?, ?, ?, NULL, ?, ?, ?)`,
      product,
      id,
      `${SECRETS.registryHash}-${id}`,
      `label ${id}`,
      licenseId ? "license" : "owner",
      licenseId,
      `portal:${owner}`,
      owner,
      NOW - 200,
      NOW + 86_400,
      revoked ? NOW - 100 : null,
      revoked ? SECRETS.revokedBy : null,
      revoked ? "link_removed" : null,
    );
  await token("rtok_ada_lic", "djdl", "lic_djdl_1", ada.accountId, false);
  await token("rtok_ada_old", "acme", null, ada.accountId, true);
  await token("rtok_bob", "djdl", "lic_djdl_bob", bob.accountId, false);
  await db.run(
    `INSERT INTO account_merges (id, survivor_id, absorbed_id, merged_at, undo_until, undone_at, snapshot_json)
     VALUES ('mrg_1', ?, 'acct_absorbed', ?, ?, NULL, ?)`,
    ada.accountId,
    NOW - 100,
    NOW + 70_000,
    JSON.stringify({ handle: SECRETS.joinSnapshot }),
  );
  await db.run(
    `INSERT INTO license_relinks
       (product, id, license_id, from_account_id, to_account_id, from_subject, to_subject,
        reason, actor_sub, actor_name, notices_sent, created_at, undo_until)
     VALUES ('djdl', 'rl_1', 'lic_djdl_1', ?, NULL, ?, 'ps_someone_else_000000', ?, ?, ?, 0, ?, ?)`,
    ada.accountId,
    adaSubject.djdl,
    SECRETS.relinkReason,
    SECRETS.relinkOperator,
    SECRETS.relinkOperator,
    NOW - 90,
    NOW + 100,
  );
  for (const [product, action, summary] of [
    ["djdl", "portal.license.claim", "Claimed a licence with its key"],
    ["acme", "portal.device.rename", "Renamed a device"],
    [null, "portal.profile.update", "name"],
  ] as const)
    await portalAudit(db, {
      accountId: ada.accountId,
      action,
      product,
      targetKind: product ? "product" : "account",
      targetId: product ?? ada.accountId,
      summary,
      now: NOW - 20,
    });
  await portalAudit(db, {
    accountId: bob.accountId,
    action: "portal.license.claim",
    product: "djdl",
    targetKind: "license",
    targetId: "lic_djdl_bob",
    summary: "BOB-ACTIVITY-SUMMARY",
    now: NOW - 20,
  });

  const sessionHash = await db.first<{ id_hash: string }>(
    "SELECT id_hash FROM account_sessions WHERE account_id = ? AND id_hash != ?",
    ada.accountId,
    SECRETS.oldSession,
  );
  return {
    ada,
    bob,
    adaSubject,
    bobSubject,
    secrets: [
      ...Object.values(SECRETS),
      adaKey.key,
      await hashKey(adaKey.key),
      sessionHash!.id_hash,
      ada.csrf,
    ],
    bobs: [
      "bob@example.com",
      "Bob Barker",
      "lic_djdl_bob",
      "lic_bobonly_1",
      "bobonly",
      "dev-bob-1",
      "rtok_bob",
      "BOB-LIGHT",
      "BOB-ENTITLEMENT",
      "BOB-ACTIVITY-SUMMARY",
      bobSubject.djdl,
      bobSubject.bobonly,
      bob.accountId,
      bobKey.key,
      await hashKey(bobKey.key),
    ],
  };
}

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** The raw bytes of an export, which is what a secret would leak through. */
async function bytes(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  return res.text();
}

// ── The gates ───────────────────────────────────────────────────────────────────────────────

describe("the data routes' gates", () => {
  const routes: Array<
    [
      string,
      (w: World, who: Person | null, o?: CallOptions) => Promise<Response>,
    ]
  > = [
    ["GET /api/me/export", (w, who, o) => exportAccount(w, who, o)],
    [
      "GET /api/products/djdl/export",
      (w, who, o) => exportProduct(w, who, "djdl", o),
    ],
    [
      "DELETE /api/products/djdl/data",
      (w, who, o) => removeData(w, who, "djdl", "", o),
    ],
  ];

  for (const [name, send] of routes) {
    describe(name, () => {
      it("needs a portal session", async () => {
        const w = await world();
        await seed(w);
        const res = await send(w, null);
        expect(res.status).toBe(401);
        expect(await body(res)).toEqual({ error: "unauthorized" });
      });

      it("needs the CSRF header, a GET included, and refuses a wrong one", async () => {
        const w = await world();
        const { ada, bob } = await seed(w);
        const missing = await send(w, ada, { csrf: false });
        expect(missing.status).toBe(403);
        expect((await body(missing)).error).toBe("forbidden");
        const wrong = await send(w, ada, { csrf: "not-the-token" });
        expect(wrong.status).toBe(403);
        // Bob's token is no more valid for Ada's session than a guess.
        expect((await send(w, ada, { csrf: bob.csrf })).status).toBe(403);
      });

      it("needs a sign-in no older than five minutes", async () => {
        const w = await world();
        const { ada } = await seed(w);
        const stale = await send(w, ada, { now: NOW + 5 * 60 + 1 });
        expect(stale.status).toBe(401);
        expect(await body(stale)).toMatchObject({
          error: "step_up_required",
          maxAgeSeconds: 300,
        });
        // Nothing was read, charged or written.
        expect(
          await w.db.first(
            "SELECT 1 FROM portal_audit WHERE action LIKE 'portal.%.export'",
          ),
        ).toBeNull();
        expect(store.deleted).toEqual([]);
        const fresh = await send(w, ada, { now: NOW + 5 * 60 });
        expect(fresh.status).toBe(200);
      });
    });
  }

  it("answers 405 for another method, before anything else", async () => {
    const w = await world();
    const { ada } = await seed(w);
    for (const [method, path] of [
      ["POST", "/api/me/export"],
      ["DELETE", "/api/me/export"],
      ["POST", "/api/products/djdl/export"],
      ["GET", "/api/products/djdl/data"],
      ["PUT", "/api/products/djdl/data"],
    ] as const) {
      const res = await call(w, method, path, ada);
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(await body(res)).toEqual({ error: "method_not_allowed" });
    }
  });

  it("rate-limits each route per account, in the product's own shard", async () => {
    const w = await world();
    const { ada } = await seed(w);
    for (let i = 0; i < ACCOUNT_EXPORT_LIMIT_PER_MINUTE; i++)
      expect((await exportAccount(w, ada)).status).toBe(200);
    const limited = await exportAccount(w, ada);
    expect(limited.status).toBe(429);
    expect(await body(limited)).toMatchObject({ error: "rate_limited" });
    // The product exports have their own budget: the account's is not theirs.
    for (let i = 0; i < PRODUCT_EXPORT_LIMIT_PER_MINUTE; i++)
      expect((await exportProduct(w, ada, "djdl")).status).toBe(200);
    expect((await exportProduct(w, ada, "djdl")).status).toBe(429);
    // ...and per product: exhausting djdl leaves acme.
    expect((await exportProduct(w, ada, "acme")).status).toBe(200);
    // Removal: the limit is charged only for a request that gets past every other check.
    for (let i = 0; i < PRODUCT_DATA_REMOVE_LIMIT_PER_MINUTE; i++)
      expect((await removeData(w, ada, "djdl")).status).toBe(200);
    expect((await removeData(w, ada, "djdl")).status).toBe(429);
    // A new minute starts a new window (and the sign-in is still fresh).
    expect((await exportAccount(w, ada, { now: NOW + 60 })).status).toBe(200);
  });

  it("answers one 404 for a product that does not exist and one the account holds nothing in", async () => {
    const w = await world();
    const { ada, bob } = await seed(w);
    // `bobonly` exists and Bob holds it; for Ada it must look like `nope`.
    const answers: Array<[number, unknown]> = [];
    for (const product of ["bobonly", "nope", "Bad_Slug", "x".repeat(80)]) {
      for (const send of [
        () => exportProduct(w, ada, product),
        () => removeData(w, ada, product),
        () => removeData(w, ada, product, "?alsoRemoveLicense=1"),
      ]) {
        const res = await send();
        answers.push([res.status, await body(res)]);
      }
    }
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(
      new Set([JSON.stringify([404, { error: "not_found" }])]),
    );
    // Bob still holds everything: nothing was written.
    expect(
      await w.db.first(
        "SELECT 1 FROM account_product_subjects WHERE account_id = ? AND product = 'bobonly'",
        bob.accountId,
      ),
    ).toBeTruthy();
    expect(store.deleted).toEqual([]);
  });

  it("is a 404 and never the account summary for anything else under /api/me", async () => {
    const w = await world();
    const { ada } = await seed(w);
    for (const path of [
      "/api/me/exports",
      "/api/me/export/extra",
      "/api/me/nothing",
    ]) {
      const res = await call(w, "GET", path, ada);
      expect(res.status, path).toBe(404);
    }
    expect((await call(w, "GET", "/api/me", ada)).status).toBe(200);
    expect((await call(w, "POST", "/api/me", ada)).status).toBe(405);
    // The old fallthrough saved the summary as "account data": the export is not that.
    const doc = await body(await exportAccount(w, ada));
    expect(doc).toHaveProperty("schema", "pkey-account-export/1");
    expect(doc).not.toHaveProperty("csrf");
  });
});

// ── The full account export ─────────────────────────────────────────────────────────────────

describe("GET /api/me/export", () => {
  it("conforms to the published schema, and says what it is", async () => {
    const w = await world();
    const { ada } = await seed(w);
    const res = await exportAccount(w, ada);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="polaris-key-account-data.json"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const doc = await body(res);
    expect(validateAgainst("PortalAccountExport", doc)).toEqual([]);
    expect(doc.schema).toBe("pkey-account-export/1");
    expect(doc.exportedAt).toBe(NOW);
  });

  it("carries the account, its profile, methods, passkeys, pictures and sessions", async () => {
    const w = await world();
    const { ada } = await seed(w);
    await scheduleAccountDeletion(w.db, ada.accountId, NOW);
    const doc = await body<Record<string, any>>(await exportAccount(w, ada));

    expect(doc.account).toMatchObject({
      id: ada.accountId,
      status: "active",
      primaryEmail: "ada@example.com",
      lastSignInAt: NOW - 5,
      deletion: {
        requestedAt: NOW,
        dueAt: NOW + ACCOUNT_DELETION_GRACE_SECONDS,
      },
    });
    expect(doc.profile).toEqual({
      displayName: "Ada",
      displayNameSource: { kind: "typed" },
      explicitName: true,
      picture: {
        asset: ASSET,
        url: `/media/avatar/${ASSET}`,
        url96: `/media/avatar/${ASSET}-96`,
      },
      pictureSource: {
        kind: "provider",
        linkId: "lnk_google",
        provider: "google",
      },
      explicitPicture: false,
      locale: "en-GB",
      birthdate: "1815-12-10",
      birthdateSource: { kind: "user" },
    });
    expect(doc.pictures).toEqual([
      {
        asset: ASSET,
        origin: "provider",
        bytes: 1234,
        createdAt: NOW - 900,
        url: `/media/avatar/${ASSET}`,
        url96: `/media/avatar/${ASSET}-96`,
        inUse: true,
      },
    ]);
    const methods = Object.fromEntries(
      (doc.signInMethods as Array<Record<string, any>>).map((m) => [m.kind, m]),
    );
    expect(Object.keys(methods).sort()).toEqual(["email", "google", "passkey"]);
    expect(methods.email).toMatchObject({
      group: "email",
      email: "ada@example.com",
      emailVerified: true,
      providerSubject: null,
    });
    expect(methods.google).toMatchObject({
      group: "accounts",
      providerSubject: "google-sub-1234",
      email: "ada.g@example.com",
      displayName: "Ada G",
      groups: ["staff"],
      claims: { dept: "eng" },
      signedInWith: ["google"],
      profileImport: {
        name: "Ada G",
        locale: "en-GB",
        picture: { asset: ASSET },
      },
    });
    // A passkey's credential id is a credential: no provider subject for it.
    expect(methods.passkey).toMatchObject({
      group: "passkeys",
      providerSubject: null,
      email: null,
    });
    expect(doc.passkeys).toEqual([
      {
        methodId: "lnk_passkey",
        createdAt: NOW - 800,
        lastUsedAt: NOW - 70,
        transports: ["internal"],
        synced: true,
        aaguid: "00000000-0000-0000-0000-000000000000",
        addedFrom: "Safari on macOS",
      },
    ]);
    expect(doc.sessions).toHaveLength(2);
    expect(doc.sessions.filter((s: any) => s.current)).toHaveLength(1);
    expect(doc.sessions.find((s: any) => s.endedAt !== null)).toMatchObject({
      browser: "Firefox on Windows",
      signedInWith: ["email"],
      endedAt: NOW - 79_000,
      current: false,
    });
  });

  it("carries consents, terms, the library, removed licences, package tokens, joins and activity", async () => {
    const w = await world();
    const { ada } = await seed(w);
    const doc = await body<Record<string, any>>(await exportAccount(w, ada));
    expect(doc.connectedApps).toEqual([
      {
        product: "djdl",
        claims: ["name"],
        grantedAt: NOW - 700,
        modifiedAt: NOW - 600,
      },
    ]);
    expect(
      doc.termsAcceptances.map((t: any) => `${t.product}@${t.version}`),
    ).toEqual(["_platform@2026-02", "djdl@2026-01"]);
    expect(doc.library).toEqual({
      entries: [{ product: "free", via: "open", addedAt: NOW - 400 }],
      removedLicenses: [
        {
          product: "djdl",
          licenseId: "lic_removed_earlier",
          removedAt: NOW - 300,
        },
      ],
    });
    expect(doc.packageTokens.map((t: any) => t.tokenId).sort()).toEqual([
      "rtok_ada_lic",
      "rtok_ada_old",
    ]);
    expect(
      doc.packageTokens.find((t: any) => t.tokenId === "rtok_ada_old"),
    ).toMatchObject({
      product: "acme",
      status: "revoked",
      revokeReason: "link_removed",
      hint: "abcd",
    });
    expect(doc.joins).toEqual([
      { joinedAt: NOW - 100, undoableUntil: NOW + 70_000, undoneAt: null },
    ]);
    expect(doc.activityTruncated).toBe(false);
    expect(
      doc.activity.map((a: any) => `${a.product}:${a.action}`).sort(),
    ).toEqual(
      expect.arrayContaining([
        "djdl:portal.license.claim",
        "acme:portal.device.rename",
        "null:portal.profile.update",
      ]),
    );
  });

  it("carries one section per product the account holds a licence or a subject in, with its stores", async () => {
    const w = await world();
    const { ada, adaSubject } = await seed(w);
    const doc = await body<Record<string, any>>(await exportAccount(w, ada));
    expect(doc.products.map((p: any) => p.product.slug)).toEqual([
      "acme",
      "djdl",
    ]);
    const djdl = doc.products.find((p: any) => p.product.slug === "djdl");
    expect(djdl).toMatchObject({
      product: { slug: "djdl", name: "djdl" },
      subject: adaSubject.djdl,
      mergedSubjects: [
        { subject: "ps_old_alias_00000000000", mergedAt: NOW - 500 },
      ],
      events: [
        {
          id: "sev_merged",
          type: "subject.merged",
          alias: "ps_old_alias_00000000000",
        },
      ],
    });
    expect(djdl.licenses).toHaveLength(1);
    expect(djdl.licenses[0]).toMatchObject({
      id: "lic_djdl_1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      status: "active",
      // The licence carries an address, so the developer assigned it, key or not.
      origin: "developer",
      keys: [
        { label: null, status: "active", createdAt: NOW, lastUsedAt: null },
      ],
    });
    // A device signed in as somebody else is theirs: it is listed (it is on her licence) unnamed.
    const devices = Object.fromEntries(
      djdl.licenses[0].devices.map((d: any) => [d.deviceId, d.label]),
    );
    expect(devices).toEqual({ "dev-ada-1": "Ada's Mac", "dev-shared": null });
    expect(Object.keys(djdl.stores).sort()).toEqual([
      "config.accountOverrides",
      "core.entitlementEvents",
      "test.notes",
    ]);
    expect(djdl.stores["test.notes"]).toEqual({
      notes: [`notes of ${adaSubject.djdl} in djdl`],
    });
    expect(djdl.stores["core.entitlementEvents"]).toEqual([
      { id: "ent_ada", keys: ["pro"], createdAt: NOW - 30 },
    ]);
    // A secret is named and said to be set; its value, sealed or not, is not in the document.
    expect(djdl.stores["config.accountOverrides"].overrides.secrets).toEqual({
      API: { state: "enforced", configured: true, updatedAt: NOW - 40 },
    });
    // `acme`: a licence with no key, and a subject made by attaching it.
    const acme = doc.products.find((p: any) => p.product.slug === "acme");
    expect(acme.subject).toBe(adaSubject.acme);
    expect(acme.licenses[0]).toMatchObject({ id: "lic_acme_1", keys: [] });
  });

  it("holds no credential, hash or other person's data anywhere in its bytes", async () => {
    const w = await world();
    const f = await seed(w);
    const text = await bytes(await exportAccount(w, f.ada));
    for (const secret of f.secrets)
      expect(text, `leaked ${secret}`).not.toContain(secret);
    for (const theirs of f.bobs)
      expect(text, `leaked ${theirs}`).not.toContain(theirs);
    // And in the other direction: Bob's own export names none of Ada's.
    const bobs = await bytes(await exportAccount(w, f.bob));
    for (const hers of [
      "ada@example.com",
      f.ada.accountId,
      "lic_djdl_1",
      "ADA-DARK",
      f.adaSubject.djdl,
      "dev-ada-1",
      "rtok_ada_lic",
    ])
      expect(bobs, `leaked ${hers}`).not.toContain(hers);
    expect(validateAgainst("PortalAccountExport", JSON.parse(bobs))).toEqual(
      [],
    );
  });

  it("is read-only: it mints no subject, attaches no licence and writes only its audit row", async () => {
    const w = await world();
    const { ada } = await seed(w);
    const snapshot = async () =>
      JSON.stringify({
        subjects: await w.db.all(
          "SELECT * FROM account_product_subjects ORDER BY 1, 2",
        ),
        licenses: await w.db.all(
          "SELECT product, id, account_id FROM licenses ORDER BY 1, 2",
        ),
        links: await w.db.all("SELECT id FROM account_links ORDER BY 1"),
      });
    const before = await snapshot();
    await exportAccount(w, ada);
    expect(await snapshot()).toBe(before);
    const audit = await w.db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM portal_audit WHERE action = 'portal.account.export'",
    );
    expect(audit).toEqual([
      {
        action: "portal.account.export",
        summary: "Downloaded a copy of the account's data",
      },
    ]);
  });

  it("works while a deletion is pending, which is what the fourteen days are for", async () => {
    const w = await world();
    const { ada } = await seed(w);
    await scheduleAccountDeletion(w.db, ada.accountId, NOW);
    const res = await exportAccount(w, ada, { now: NOW + 120 });
    expect(res.status).toBe(200);
  });

  it("an account with nothing yet is a valid, small export", async () => {
    const w = await world();
    const eve = await person(w, "eve@example.com");
    const doc = await body<Record<string, any>>(await exportAccount(w, eve));
    expect(validateAgainst("PortalAccountExport", doc)).toEqual([]);
    expect(doc.products).toEqual([]);
    expect(doc.passkeys).toEqual([]);
    expect(doc.signInMethods.map((m: any) => m.kind)).toEqual(["email"]);
    expect(doc.profile.birthdate).toBeNull();
  });

  it("names how much activity it cut when it cuts any", async () => {
    const w = await world();
    const { ada } = await seed(w);
    // A busy account: more rows than one document carries.
    await w.db.batch(
      Array.from({ length: EXPORT_ACTIVITY_LIMIT + 5 }, (_, i) => ({
        sql: `INSERT INTO portal_audit (id, account_id, at, action, product, target_kind, target_id, summary)
              VALUES (?, ?, ?, 'portal.noise', NULL, NULL, NULL, NULL)`,
        params: [`paud_noise_${i}`, ada.accountId, NOW + 1000 + i],
      })),
    );
    const doc = await body<Record<string, any>>(await exportAccount(w, ada));
    expect(doc.activity).toHaveLength(EXPORT_ACTIVITY_LIMIT);
    expect(doc.activityTruncated).toBe(true);
    // Newest first: the cut drops the oldest.
    expect(doc.activity[0].at).toBeGreaterThan(doc.activity.at(-1).at);
  });
});

// ── One product's export ────────────────────────────────────────────────────────────────────

describe("GET /api/products/<product>/export", () => {
  it("conforms to the published schema and is a named download", async () => {
    const w = await world();
    const { ada } = await seed(w);
    const res = await exportProduct(w, ada, "djdl");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="polaris-key-djdl-data.json"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const doc = await body(res);
    expect(validateAgainst("PortalProductExport", doc)).toEqual([]);
    expect(doc.schema).toBe("pkey-product-export/1");
  });

  it("holds what is held for her in this product and nothing else of her account", async () => {
    const w = await world();
    const { ada, adaSubject } = await seed(w);
    const doc = await body<Record<string, any>>(
      await exportProduct(w, ada, "djdl"),
    );
    expect(doc).toMatchObject({
      product: { slug: "djdl", name: "djdl" },
      subject: adaSubject.djdl,
      mergedSubjects: [{ subject: "ps_old_alias_00000000000" }],
      consent: { product: "djdl", claims: ["name"] },
      libraryEntry: null,
      removedLicenses: [{ product: "djdl", licenseId: "lic_removed_earlier" }],
    });
    expect(doc.licenses.map((l: any) => l.id)).toEqual(["lic_djdl_1"]);
    expect(doc.termsAcceptances.map((t: any) => t.product)).toEqual(["djdl"]);
    expect(doc.packageTokens.map((t: any) => t.tokenId)).toEqual([
      "rtok_ada_lic",
    ]);
    expect(new Set(doc.activity.map((a: any) => a.product))).toEqual(
      new Set(["djdl"]),
    );
    expect(doc.activity.map((a: any) => a.action)).toContain(
      "portal.license.claim",
    );
    expect(doc.stores["test.notes"]).toEqual({
      notes: [`notes of ${adaSubject.djdl} in djdl`],
    });
    // Account-level things are the account export's, and the birth date is nobody's but hers.
    for (const member of [
      "account",
      "profile",
      "signInMethods",
      "passkeys",
      "sessions",
      "pictures",
      "connectedApps",
      "products",
    ])
      expect(doc).not.toHaveProperty(member);
    const text = JSON.stringify(doc);
    for (const nope of [
      "1815-12-10",
      "ada.g@example.com",
      "google-sub-1234",
      "Firefox on Windows",
      "lic_acme_1",
      "dev-ada-acme",
      "acme",
      ada.accountId,
    ])
      expect(text, `leaked ${nope}`).not.toContain(nope);
  });

  it("holds no credential, hash or other person's data", async () => {
    const w = await world();
    const f = await seed(w);
    for (const product of ["djdl", "acme"]) {
      const text = await bytes(await exportProduct(w, f.ada, product));
      for (const secret of f.secrets)
        expect(text, `${product} leaked ${secret}`).not.toContain(secret);
      for (const theirs of f.bobs)
        expect(text, `${product} leaked ${theirs}`).not.toContain(theirs);
    }
  });

  it("is read-only: a product with no subject yet exports none and creates none", async () => {
    const w = await world();
    const { ada } = await seed(w);
    const doc = await body<Record<string, any>>(
      await exportProduct(w, ada, "free"),
    );
    expect(validateAgainst("PortalProductExport", doc)).toEqual([]);
    expect(doc).toMatchObject({
      subject: null,
      subjectCreatedAt: null,
      mergedSubjects: [],
      licenses: [],
      stores: {},
      libraryEntry: { product: "free", via: "open", addedAt: NOW - 400 },
    });
    expect(
      await w.db.first(
        "SELECT 1 FROM account_product_subjects WHERE account_id = ? AND product = 'free'",
        ada.accountId,
      ),
    ).toBeNull();
    expect(
      await w.db.first(
        "SELECT summary FROM portal_audit WHERE action = 'portal.product.export' AND product = 'free'",
      ),
    ).toEqual({
      summary:
        "Downloaded a copy of the data held for the account in a product",
    });
  });

  it("works for a product whose portal is off: her right does not depend on a toggle", async () => {
    const w = await world();
    const { ada } = await seed(w);
    await upsertPortalProductSettings(
      w.db,
      "djdl",
      { portalEnabled: false },
      NOW,
    );
    expect((await exportProduct(w, ada, "djdl")).status).toBe(200);
  });

  it("is a 404 once the account is linked to nothing there, for a product that exists", async () => {
    const w = await world();
    const { ada } = await seed(w);
    // The licence leaves her for good: another address, so the sweep cannot take it back.
    await w.db.run(
      "UPDATE licenses SET account_id = NULL, email = 'elsewhere@example.com' WHERE product = 'acme'",
    );
    await w.db.run(
      "DELETE FROM account_product_subjects WHERE account_id = ? AND product = 'acme'",
      ada.accountId,
    );
    expect((await exportProduct(w, ada, "acme")).status).toBe(404);
  });
});

// ── Remove my data from this product ────────────────────────────────────────────────────────

describe("DELETE /api/products/<product>/data", () => {
  it("deletes her data in that product only, and keeps the licence", async () => {
    const w = await world();
    const { ada, bob, adaSubject, bobSubject } = await seed(w);
    const res = await removeData(w, ada, "djdl");
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      ok: true,
      product: "djdl",
      removed: true,
      detachedLicenses: [],
    });
    // The registered stores ran, for her subject alone.
    expect(store.deleted).toEqual([`djdl:${adaSubject.djdl}`]);
    expect(
      await w.db.first(
        "SELECT 1 FROM account_overrides WHERE subject = ?",
        adaSubject.djdl,
      ),
    ).toBeNull();
    expect(
      await w.db.first(
        "SELECT 1 FROM entitlement_events WHERE subject = ?",
        adaSubject.djdl,
      ),
    ).toBeNull();
    // The subject and the ids it replaced are gone; the next contact would mint a fresh one.
    expect(
      await w.db.first(
        "SELECT 1 FROM account_product_subjects WHERE account_id = ? AND product = 'djdl'",
        ada.accountId,
      ),
    ).toBeNull();
    expect(
      await w.db.first(
        "SELECT 1 FROM account_product_subject_aliases WHERE subject = ?",
        adaSubject.djdl,
      ),
    ).toBeNull();
    // The device she was signed in on lost the binding; the one signed in as Bob did not.
    const bound = await w.db.all<{ device_id: string; subject: string | null }>(
      "SELECT device_id, subject FROM devices WHERE product = 'djdl' ORDER BY device_id",
    );
    expect(bound).toEqual([
      { device_id: "dev-ada-1", subject: null },
      { device_id: "dev-bob-1", subject: bobSubject.djdl },
      { device_id: "dev-shared", subject: bobSubject.djdl },
    ]);
    // The licence stays, and so does everything in her other products.
    expect(
      await w.db.first(
        "SELECT account_id FROM licenses WHERE id = 'lic_djdl_1'",
      ),
    ).toEqual({ account_id: ada.accountId });
    expect(
      await w.db.first(
        "SELECT subject FROM account_product_subjects WHERE account_id = ? AND product = 'acme'",
        ada.accountId,
      ),
    ).toEqual({ subject: adaSubject.acme });
    // The developer is told: the pairwise subject and the licence ids, never the account.
    const event = await w.db.first<{
      type: string;
      subject: string;
      payload_json: string;
    }>(
      "SELECT type, subject, payload_json FROM subject_events WHERE type = 'subject.deleted'",
    );
    expect(event).toEqual({
      type: "subject.deleted",
      subject: adaSubject.djdl,
      payload_json: JSON.stringify({
        licenseIds: ["lic_djdl_1"],
        detached: false,
      }),
    });
    expect(event!.payload_json).not.toContain(ada.accountId);
    // It is in her history.
    expect(
      await w.db.first(
        "SELECT summary FROM portal_audit WHERE action = 'account.product.remove'",
      ),
    ).toEqual({ summary: "Removed product data" });
    // Nobody else's data moved.
    expect(
      await w.db.first(
        "SELECT 1 FROM account_overrides WHERE subject = ?",
        bobSubject.djdl,
      ),
    ).toBeTruthy();
    expect(
      await w.db.first(
        "SELECT subject FROM account_product_subjects WHERE account_id = ? AND product = 'djdl'",
        bob.accountId,
      ),
    ).toEqual({ subject: bobSubject.djdl });
  });

  it("then exports no data for the product, and repeating it is harmless", async () => {
    const w = await world();
    const { ada } = await seed(w);
    expect((await removeData(w, ada, "djdl")).status).toBe(200);
    const doc = await body<Record<string, any>>(
      await exportProduct(w, ada, "djdl"),
    );
    expect(doc).toMatchObject({
      subject: null,
      stores: {},
      mergedSubjects: [],
      events: [],
    });
    expect(doc.licenses.map((l: any) => l.id)).toEqual(["lic_djdl_1"]);
    const again = await removeData(w, ada, "djdl");
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual({
      ok: true,
      product: "djdl",
      removed: false,
      detachedLicenses: [],
    });
    expect(store.deleted).toHaveLength(1);
    expect(
      await w.db.all(
        "SELECT 1 FROM subject_events WHERE type = 'subject.deleted'",
      ),
    ).toHaveLength(1);
  });

  it("with alsoRemoveLicense, takes the licence out of the library for good", async () => {
    const w = await world();
    const { ada, bob, adaSubject } = await seed(w);
    const res = await removeData(w, ada, "djdl", "?alsoRemoveLicense=1");
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      ok: true,
      product: "djdl",
      removed: true,
      detachedLicenses: ["lic_djdl_1"],
    });
    expect(
      await w.db.first(
        "SELECT account_id FROM licenses WHERE id = 'lic_djdl_1'",
      ),
    ).toEqual({ account_id: null });
    // The invariants of the library's own Remove: a block that no sweep can undo...
    expect(
      await w.db.first(
        `SELECT created_at FROM license_auto_attach_blocks
          WHERE product = 'djdl' AND license_id = 'lic_djdl_1' AND account_id = ?`,
        ada.accountId,
      ),
    ).toEqual({ created_at: NOW });
    // ...her package token for it revoked, and both facts in her history.
    expect(
      await w.db.first(
        "SELECT revoked_at, revoke_reason FROM registry_tokens WHERE token_id = 'rtok_ada_lic'",
      ),
    ).toEqual({ revoked_at: NOW, revoke_reason: "link_removed" });
    expect(
      await w.db.all<{ action: string }>(
        `SELECT action FROM portal_audit
          WHERE action IN ('account.license.detach', 'account.license.auto_attach_block', 'account.product.remove')
          ORDER BY action`,
      ),
    ).toEqual([
      { action: "account.license.auto_attach_block" },
      { action: "account.license.detach" },
      { action: "account.product.remove" },
    ]);
    // The developer hears that the licences left with the subject.
    expect(
      await w.db.first<{ payload_json: string }>(
        "SELECT payload_json FROM subject_events WHERE type = 'subject.deleted' AND subject = ?",
        adaSubject.djdl,
      ),
    ).toEqual({
      payload_json: JSON.stringify({
        licenseIds: ["lic_djdl_1"],
        detached: true,
      }),
    });
    // The licence carries her address; the very next portal request must not take it back.
    const library = await body<{ products: Array<{ product: string }> }>(
      await call(w, "GET", "/api/library", ada),
    );
    // `free` is her library entry, `acme` the other licence: only `djdl` went.
    expect(library.products.map((p) => p.product).sort()).toEqual([
      "acme",
      "free",
    ]);
    expect(
      await w.db.first(
        "SELECT account_id FROM licenses WHERE id = 'lic_djdl_1'",
      ),
    ).toEqual({ account_id: null });
    // Bob's licence, token and subject in the same product are untouched.
    expect(
      await w.db.first(
        "SELECT account_id FROM licenses WHERE id = 'lic_djdl_bob'",
      ),
    ).toEqual({ account_id: bob.accountId });
    expect(
      await w.db.first(
        "SELECT revoked_at FROM registry_tokens WHERE token_id = 'rtok_bob'",
      ),
    ).toEqual({ revoked_at: null });
  });

  it("refuses to also remove a licence its key could not bring back, and writes nothing", async () => {
    const w = await world();
    const { ada, adaSubject } = await seed(w);
    // `acme`'s licence has no key: it could never be added back.
    const res = await removeData(w, ada, "acme", "?alsoRemoveLicense=true");
    expect(res.status).toBe(409);
    expect(await body(res)).toEqual({
      error: "not_removable",
      message: "this license could not be added back, so it stays",
      reason: "no_active_key",
    });
    expect(store.deleted).toEqual([]);
    expect(
      await w.db.first(
        "SELECT subject FROM account_product_subjects WHERE account_id = ? AND product = 'acme'",
        ada.accountId,
      ),
    ).toEqual({ subject: adaSubject.acme });
    expect(
      await w.db.first(
        "SELECT account_id FROM licenses WHERE id = 'lic_acme_1'",
      ),
    ).toEqual({ account_id: ada.accountId });
    // Keeping the licence is always allowed.
    expect((await removeData(w, ada, "acme")).status).toBe(200);
    expect(store.deleted).toEqual([`acme:${adaSubject.acme}`]);
  });

  it("is `key_claim_off` for a product whose portal is off, for the licence part only", async () => {
    const w = await world();
    const { ada } = await seed(w);
    await upsertPortalProductSettings(
      w.db,
      "djdl",
      { portalEnabled: false },
      NOW,
    );
    const res = await removeData(w, ada, "djdl", "?alsoRemoveLicense=1");
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ reason: "key_claim_off" });
    expect((await removeData(w, ada, "djdl")).status).toBe(200);
  });

  it("reads the licence choice strictly", async () => {
    const w = await world();
    const { ada } = await seed(w);
    for (const query of [
      "?alsoRemoveLicense=yes",
      "?alsoRemoveLicense=",
      "?alsoRemoveLicense=1&alsoRemoveLicense=1",
      "?alsoRemoveLicense=2",
    ]) {
      const res = await removeData(w, ada, "djdl", query);
      expect(res.status, query).toBe(400);
      expect(await body(res)).toMatchObject({ error: "bad_request" });
    }
    expect(store.deleted).toEqual([]);
    for (const query of [
      "",
      "?alsoRemoveLicense=0",
      "?alsoRemoveLicense=false",
    ]) {
      const w2 = await world();
      const f = await seed(w2);
      const res = await removeData(w2, f.ada, "djdl", query);
      expect(res.status, query).toBe(200);
      expect(await body(res)).toMatchObject({ detachedLicenses: [] });
    }
  });

  it("is a removal she can still ask for with a licence in no portal-visible state", async () => {
    const w = await world();
    const { ada } = await seed(w);
    // Linked by a library entry alone: nothing to remove, but it is hers to ask about.
    const res = await removeData(w, ada, "free");
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({
      ok: true,
      product: "free",
      removed: false,
      detachedLicenses: [],
    });
    expect(
      await w.db.first("SELECT 1 FROM library_entries WHERE product = 'free'"),
    ).toBeTruthy();
  });
});

describe("the published contract", () => {
  it("documents all three routes under the portal tag, with their gates", () => {
    for (const [path, method] of [
      ["/api/me/export", "get"],
      ["/api/products/{product}/export", "get"],
      ["/api/products/{product}/data", "delete"],
    ] as const) {
      const op = (SPEC.paths[path] as Record<string, any>)[method];
      expect(op.tags, path).toEqual(["portal"]);
      expect(Object.keys(op.responses), path).toEqual(
        expect.arrayContaining(["401", "403", "405", "429"]),
      );
    }
  });

  it("every object the export schemas declare refuses members nobody listed", () => {
    const names = Object.keys(SPEC.components.schemas).filter(
      (n) =>
        n.startsWith("PortalExport") ||
        /^Portal(Account|Product)Export$/.test(n),
    );
    expect(names.length).toBeGreaterThan(15);
    const offenders: string[] = [];
    const walk = (node: unknown, where: string): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node))
        return node.forEach((n, i) => walk(n, `${where}[${i}]`));
      const o = node as Record<string, unknown>;
      if (o.properties && o.additionalProperties === undefined && where !== "")
        offenders.push(where);
      for (const [k, v] of Object.entries(o)) walk(v, `${where}.${k}`);
    };
    for (const n of names) walk(SPEC.components.schemas[n], n);
    // `stores` is the one free-form member: each registered store's own export.
    expect(offenders).toEqual([]);
  });
});

describe("the schema check is a real allow-list", () => {
  it("fails on a member nobody listed, at any depth, and passes the real document", async () => {
    const w = await world();
    const { ada } = await seed(w);
    const doc = await body<Record<string, any>>(
      await exportProduct(w, ada, "djdl"),
    );
    expect(validateAgainst("PortalProductExport", doc)).toEqual([]);
    doc.licenses[0].keys[0].hash = "a-key-hash";
    doc.tokenHash = "a-token-hash";
    const errors = validateAgainst("PortalProductExport", doc);
    expect(errors.join("\n")).toContain("undocumented member hash");
    expect(errors.join("\n")).toContain("undocumented member tokenHash");
  });
});
