/**
 * Personal tokens (F-33, plans/I-27.md §2.5): the `pkeyp_` store, the portal's Account → Packages
 * API, the cascades, and the registry host's per-owner resolution of a person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRegistryHost } from "../src/core/registry/registryHost.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import {
  REGISTRY_OWNERLESS_ROUTES,
  REGISTRY_ROUTES,
  SERVICES,
} from "../src/mount.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import { forgetLicenceHolds } from "../src/services/distribution/registry/authorize.js";
import {
  REGISTRY_TOKEN_TTL_SECONDS,
  forgetRegistryTokens,
  lookupRegistryCredential,
  mintRegistryToken,
} from "../src/core/registry/registryTokens.js";
import {
  ADMIN_SCOPE,
  MAX_LIVE_PERSONAL_TOKENS,
  PACKAGES_READ_SCOPE,
  resolvePersonalTokenById,
  hashPersonalToken,
  listAccountTokens,
  mintAccountToken,
  purgeAccountTokens,
  resolvePersonalToken,
  revokeAccountToken,
  revokeAllAccountTokens,
  stmtMoveAccountTokens,
  stmtRevokeAccountTokens,
} from "../src/core/accounts/personalTokens.js";
import { exportAccountData } from "../src/services/identity/portal/dataExport.js";
import { erasureKey } from "../src/core/accounts/erasureFence.js";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
} from "../src/services/identity/portal/session.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import { issuePortalSessionRow } from "./portalSessionRow.js";
import { handlePortalApi } from "./portalHarness.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { OCI_REPO, publishOciFixture } from "./ociFixture.js";

const PKG = "https://pkg.example.test";
const HOST = "pkg.example.test";
const OWNER = "acme";
const OTHER = "globex";
const NAME = `${OWNER}/${OCI_REPO}`;
const ON: ServicesMap = {
  license: { enabled: true },
  config: { enabled: false },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: false },
  identity: { enabled: false },
  sync: { enabled: false },
  commerce: { enabled: false },
};

let db: Db;
let env: Env;
let bucket: R2Mock;
let ada: string;
let bob: string;
let clock: number;

async function seedOwner(slug: string): Promise<void> {
  await seedProduct(db, slug);
  await setServices(
    db,
    slug,
    serializeServices({ services: ON }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
    slug,
    NOW,
  );
  for (const eco of ["oci", "swift"])
    await db.run(
      `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes, updated_at)
       VALUES (?, ?, 1, 'authenticated', ?, 52428800, ?)`,
      slug,
      eco,
      eco === "swift" ? '{"scope":"acme"}' : "{}",
      NOW,
    );
}

async function mint(
  accountId: string,
  over: { days?: number; scope?: string } = {},
) {
  const res = await mintAccountToken(
    env,
    db,
    {
      accountId,
      label: "laptop",
      scope: over.scope ?? PACKAGES_READ_SCOPE,
      createdBy: `portal:${accountId}`,
      ...(over.days !== undefined ? { expiresInDays: over.days } : {}),
    },
    NOW,
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  return res;
}

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return dispatchRegistryHost(
    new Request(`${PKG}${path}`, init),
    env,
    db,
    REGISTRY_ROUTES,
    SERVICES,
    undefined,
    REGISTRY_OWNERLESS_ROUTES,
  );
}

beforeEach(async () => {
  clock = NOW * 1000;
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  forgetRegistrySettings();
  forgetRegistryTokens();
  forgetLicenceHolds();
  db = makeTestDb();
  env = makeEnv(new KvMock(), []);
  env.PKG_ORIGIN = PKG;
  env.KEY_HASH_PEPPER = "pepper";
  env.REGISTRY_TOKEN_KEY = "registry-token-key-for-tests";
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  bucket = new R2Mock();
  env.BLOBS = asR2(bucket);
  await seedOwner(OWNER);
  await seedOwner(OTHER);
  await publishOciFixture(db, env, bucket, OWNER, NOW);
  ada = (await getOrCreateAccountByEmail(db, "ada@example.com", NOW)).id;
  bob = (await getOrCreateAccountByEmail(db, "bob@example.com", NOW)).id;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("personal tokens: the store", () => {
  it("mints pkeyp_ + 256 bits, stores only the peppered hash and a hint, one scope, 90 days", async () => {
    const res = await mint(ada);
    expect(res.token).toMatch(/^pkeyp_[A-Za-z0-9_-]{43}$/);
    expect(res.view).toMatchObject({
      hint: res.token.slice(-4),
      scope: "packages:read",
      expiresAt: NOW + 90 * 86_400,
      status: "active",
    });
    const rows = await db.all<Record<string, unknown>>(
      "SELECT * FROM account_tokens",
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(res.token);
    expect(rows[0]!.token_hash).toBe(await hashPersonalToken(env, res.token));
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await listAccountTokens(db, ada, NOW))).not.toContain(
      res.token,
    );
  });

  it("refuses an unknown or compound scope, a bad label and a bad lifetime", async () => {
    const base = { accountId: ada, createdBy: "portal:x" };
    for (const [over, field] of [
      [{ label: "a", scope: "admin2" }, "scope"],
      [{ label: "a", scope: ["packages:read"] as unknown as string }, "scope"],
      [{ label: "a", scope: "packages:read,admin" }, "scope"],
      [{ label: "", scope: PACKAGES_READ_SCOPE }, "label"],
      [{ label: "x".repeat(65), scope: PACKAGES_READ_SCOPE }, "label"],
      [
        { label: "a", scope: PACKAGES_READ_SCOPE, expiresInDays: 366 },
        "expiresInDays",
      ],
      [
        { label: "a", scope: PACKAGES_READ_SCOPE, expiresInDays: 0 },
        "expiresInDays",
      ],
    ] as const) {
      const res = await mintAccountToken(env, db, { ...base, ...over }, NOW);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.fields).toContain(field);
    }
    expect(await db.all("SELECT 1 FROM account_tokens")).toEqual([]);
  });

  it("mints an admin token: 7 days by default, 30 at most, the same label and cap rules", async () => {
    const def = await mint(ada, { scope: ADMIN_SCOPE });
    expect(def.view).toMatchObject({
      scope: "admin",
      expiresAt: NOW + 7 * 86_400,
      status: "active",
    });
    expect(
      (await mint(ada, { scope: ADMIN_SCOPE, days: 30 })).view.expiresAt,
    ).toBe(NOW + 30 * 86_400);
    for (const expiresInDays of [31, 0, 1.5]) {
      const res = await mintAccountToken(
        env,
        db,
        {
          accountId: ada,
          label: "a",
          scope: ADMIN_SCOPE,
          createdBy: "x",
          expiresInDays,
        },
        NOW,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.fields).toEqual(["expiresInDays"]);
    }
    const bad = await mintAccountToken(
      env,
      db,
      { accountId: ada, label: " ", scope: ADMIN_SCOPE, createdBy: "x" },
      NOW,
    );
    expect(bad.ok === false && bad.fields).toEqual(["label"]);
    // The 25-live cap counts both scopes (2 admin so far).
    for (let i = 0; i < MAX_LIVE_PERSONAL_TOKENS - 2 - 1; i++) await mint(ada);
    await mint(ada, { scope: ADMIN_SCOPE });
    const over = await mintAccountToken(
      env,
      db,
      {
        accountId: ada,
        label: "a",
        scope: PACKAGES_READ_SCOPE,
        createdBy: "x",
      },
      NOW,
    );
    expect(over).toMatchObject({ ok: false, reason: "token_limit" });
  });

  it("an admin row never resolves for packages:read, and a packages row never for admin", async () => {
    const admin = await mint(ada, { scope: ADMIN_SCOPE });
    const pkg = await mint(ada);
    expect(
      await resolvePersonalToken(
        env,
        db,
        admin.token,
        PACKAGES_READ_SCOPE,
        NOW,
      ),
    ).toBeNull();
    expect(
      await resolvePersonalTokenById(
        env,
        db,
        admin.view.id,
        PACKAGES_READ_SCOPE,
        NOW,
      ),
    ).toBeNull();
    expect(
      await resolvePersonalToken(env, db, pkg.token, ADMIN_SCOPE, NOW),
    ).toBeNull();
    expect(
      await resolvePersonalTokenById(env, db, pkg.view.id, ADMIN_SCOPE, NOW),
    ).toBeNull();
    // The store itself does resolve it for the scope the (future) admin API will name.
    expect(
      await resolvePersonalToken(env, db, admin.token, ADMIN_SCOPE, NOW),
    ).toMatchObject({ accountId: ada, scope: "admin" });
  });

  it("holds an account to its live-token limit, and expired or revoked ones do not count", async () => {
    for (let i = 0; i < MAX_LIVE_PERSONAL_TOKENS; i++) await mint(ada);
    const over = await mintAccountToken(
      env,
      db,
      {
        accountId: ada,
        label: "x",
        scope: PACKAGES_READ_SCOPE,
        createdBy: "portal:x",
      },
      NOW,
    );
    expect(over).toMatchObject({
      ok: false,
      status: 409,
      reason: "token_limit",
    });
    expect((await mint(bob)).ok).toBe(true);
    const [first] = await listAccountTokens(db, ada, NOW);
    await revokeAccountToken(db, ada, first!.id, "portal:x", "manual", NOW);
    expect((await mint(ada)).ok).toBe(true);
  });

  it("lists live tokens first, then newest, revoked and expired ones after", async () => {
    const old = await mint(ada);
    const mid = await mint(ada);
    const newest = await mint(ada);
    await revokeAccountToken(
      db,
      ada,
      newest.view.id,
      "portal:x",
      "manual",
      NOW,
    );
    await db.run(
      "UPDATE account_tokens SET created_at = created_at + ? WHERE id = ?",
      10,
      newest.view.id,
    );
    await db.run(
      "UPDATE account_tokens SET created_at = created_at + ? WHERE id = ?",
      5,
      old.view.id,
    );
    const ids = (await listAccountTokens(db, ada, NOW)).map((t) => t.id);
    // Live (old is newer than mid) before the revoked one, though the revoked one is newest.
    expect(ids).toEqual([old.view.id, mid.view.id, newest.view.id]);
  });

  it("resolves only a live token of the scope the caller accepts, and writes last_used at most hourly", async () => {
    const { token, view } = await mint(ada);
    expect(
      await resolvePersonalToken(env, db, token, PACKAGES_READ_SCOPE, NOW),
    ).toEqual({ accountId: ada, tokenId: view.id, scope: "packages:read" });
    const used = async () =>
      (await db.first<{ last_used_at: number }>(
        "SELECT last_used_at FROM account_tokens WHERE id = ?",
        view.id,
      ))!.last_used_at;
    expect(await used()).toBe(NOW);
    await resolvePersonalToken(env, db, token, PACKAGES_READ_SCOPE, NOW + 60);
    expect(await used()).toBe(NOW);
    await resolvePersonalToken(env, db, token, PACKAGES_READ_SCOPE, NOW + 7200);
    expect(await used()).toBe(NOW + 7200);
    // Malformed, unknown, foreign prefixes.
    for (const t of [
      "",
      "pkeyp_short",
      `pkeyr_${"a".repeat(43)}`,
      `pkeyp_${"a".repeat(43)}`,
    ])
      expect(
        await resolvePersonalToken(env, db, t, PACKAGES_READ_SCOPE, NOW),
      ).toBeNull();
    // Expired.
    expect(
      await resolvePersonalToken(
        env,
        db,
        token,
        PACKAGES_READ_SCOPE,
        NOW + 91 * 86_400,
      ),
    ).toBeNull();
    // A row whose scope this caller does not accept resolves to nothing (an `admin` token is not
    // a registry credential, whatever the row says).
    await db.run(
      "UPDATE account_tokens SET scope = 'admin' WHERE id = ?",
      view.id,
    );
    expect(
      await resolvePersonalToken(env, db, token, PACKAGES_READ_SCOPE, NOW),
    ).toBeNull();
    expect(
      (await lookupRegistryCredential(env, db, token)).resolved,
    ).toBeNull();
  });

  it("revokes by the person, by an admin, in bulk, and by the erasure statement", async () => {
    const a = await mint(ada);
    const b = await mint(ada);
    const c = await mint(ada);
    expect(
      await revokeAccountToken(db, bob, a.view.id, "portal:bob", "manual", NOW),
    ).toBeNull();
    const v = await revokeAccountToken(
      db,
      ada,
      a.view.id,
      "portal:ada",
      "manual",
      NOW,
    );
    expect(v).toMatchObject({ status: "revoked", revokeReason: "manual" });
    expect(
      await revokeAllAccountTokens(db, ada, "admin:root", "admin", NOW),
    ).toBe(2);
    expect(
      (await listAccountTokens(db, ada, NOW)).map((t) => t.revokeReason).sort(),
    ).toEqual(["admin", "admin", "manual"]);
    const d = await mint(ada);
    await db.batch([stmtRevokeAccountTokens(ada, NOW)]);
    expect(
      (await listAccountTokens(db, ada, NOW)).find((t) => t.id === d.view.id),
    ).toMatchObject({ status: "revoked", revokeReason: "account_deleted" });
    for (const t of [a, b, c, d])
      expect(
        await resolvePersonalToken(env, db, t.token, PACKAGES_READ_SCOPE, NOW),
      ).toBeNull();
  });

  it("moves with a merge, and the nightly purge removes rows 90 days after they ended", async () => {
    const a = await mint(bob);
    await db.batch([stmtMoveAccountTokens(bob, ada)]);
    expect(
      (await resolvePersonalToken(env, db, a.token, PACKAGES_READ_SCOPE, NOW))
        ?.accountId,
    ).toBe(ada);
    await revokeAccountToken(db, ada, a.view.id, "portal:ada", "manual", NOW);
    expect(await purgeAccountTokens(db, NOW + 89 * 86_400)).toBe(0);
    expect(await purgeAccountTokens(db, NOW + 91 * 86_400)).toBe(1);
  });

  it("the account export lists an admin token's scope, with no plaintext or hash", async () => {
    const admin = await mint(ada, { scope: ADMIN_SCOPE });
    const out = await exportAccountData({ db, env, now: NOW }, ada, null);
    const tokens = (out as unknown as { personalTokens: { scope: string }[] })
      .personalTokens;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ id: admin.view.id, scope: "admin" });
    const text = JSON.stringify(out);
    expect(text).not.toContain(admin.token);
    expect(text).not.toContain(await hashPersonalToken(env, admin.token));
  });

  it("the erasure fence: an account on the ledger resolves to nothing, an unreadable ledger too", async () => {
    const { token } = await mint(ada);
    await bucket.put(erasureKey(ada), "x");
    expect(
      await resolvePersonalToken(env, db, token, PACKAGES_READ_SCOPE, NOW),
    ).toBeNull();
    const live = await mint(bob);
    expect(
      await resolvePersonalToken(env, db, live.token, PACKAGES_READ_SCOPE, NOW),
    ).not.toBeNull();
    const noLedger = { ...env, BLOBS: undefined } as unknown as Env;
    expect(
      await resolvePersonalToken(
        noLedger,
        db,
        live.token,
        PACKAGES_READ_SCOPE,
        NOW + 3600,
      ),
    ).toBeNull();
  });
});

describe("personal tokens: Account → Packages (portal API)", () => {
  let cookie: string;
  let csrf: string;

  async function session(accountId: string, authenticatedAt = NOW) {
    const { token, session } = await issuePortalSessionRow(
      env,
      db,
      { accountId, email: "a@example.com", name: "A" },
      authenticatedAt,
    );
    return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf };
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
    opts: { csrf?: boolean; auth?: { cookie: string; csrf: string } } = {},
  ): Promise<Response> {
    const a = opts.auth ?? { cookie, csrf };
    const headers: Record<string, string> = { cookie: a.cookie };
    if (opts.csrf !== false) headers[PORTAL_CSRF_HEADER] = a.csrf;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    return handlePortalApi(
      new Request(`https://key.plrs.im/portal${path}`, init),
      env,
      db,
      path,
      NOW,
    );
  }

  beforeEach(async () => {
    ({ cookie, csrf } = await session(ada));
  });

  it("mints once (the token is in that answer only), lists without it, and audits without it", async () => {
    const res = await call("POST", "/api/me/tokens", { label: "laptop" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; view: { id: string } };
    expect(body.token).toMatch(/^pkeyp_/);
    const list = await call("GET", "/api/me/tokens");
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(body.token);
    expect(JSON.parse(text)).toMatchObject({
      username: "__token__",
      registryOrigin: PKG,
      tokens: [{ id: body.view.id, label: "laptop", status: "active" }],
      limits: { maxDays: 365, defaultDays: 90 },
    });
    const audit = JSON.stringify(
      await db.all(
        "SELECT * FROM portal_audit WHERE action LIKE 'portal.personal_token.%'",
      ),
    );
    expect(audit).toContain("portal.personal_token.create");
    expect(audit).not.toContain(body.token);
  });

  it("lists the private feeds the account's usable licenses reach, once per product and ecosystem, never the system product's", async () => {
    await seedOwner(SYSTEM_PRODUCT_SLUG);
    for (const product of [OWNER, SYSTEM_PRODUCT_SLUG]) {
      const { licenseId } = await seedLicenseWithKey(db, product);
      await linkLicense(db, ada, product, licenseId, "admin", NOW);
    }
    const body = (await (await call("GET", "/api/me/tokens")).json()) as {
      feeds: { product: string; ecosystem: string }[];
    };
    expect(body.feeds.map((f) => `${f.product}/${f.ecosystem}`).sort()).toEqual(
      [`${OWNER}/oci`, `${OWNER}/swift`],
    );
    // The account's pre-F-33 licence tokens are listed for revocation, with the feed namespace.
    expect(body.feeds[0]).toMatchObject({
      namespace: expect.anything(),
      licenseId: expect.any(String),
    });
    const lic = body.feeds.find((f) => f.product === OWNER) as unknown as {
      licenseId: string;
    };
    await mintRegistryToken(
      env,
      db,
      {
        product: OWNER,
        label: "old",
        ecosystems: null,
        binding: "license",
        licenseId: lic.licenseId,
        presentation: "header",
        createdBy: `portal:${ada}`,
        portalAccountId: ada,
      },
      NOW,
    );
    const again = (await (await call("GET", "/api/me/tokens")).json()) as {
      legacy: { label: string; product: string; licenseId: string }[];
    };
    expect(again.legacy).toHaveLength(1);
    expect(again.legacy[0]).toMatchObject({ label: "old", product: OWNER });
    expect(JSON.stringify(again)).not.toContain("pkeyr_");
    // Bob holds no licence: nothing to set up.
    const other = await session(bob);
    const none = (await (
      await call("GET", "/api/me/tokens", undefined, { auth: other })
    ).json()) as { feeds: unknown[] };
    expect(none.feeds).toEqual([]);
  });

  it("needs the CSRF header and a fresh sign-in to mint, and refuses a scope other than packages:read", async () => {
    expect(
      (await call("POST", "/api/me/tokens", { label: "x" }, { csrf: false }))
        .status,
    ).toBe(403);
    const stale = await session(ada, NOW - 3600);
    const old = await call(
      "POST",
      "/api/me/tokens",
      { label: "x" },
      { auth: stale },
    );
    expect(old.status).toBe(401);
    expect(((await old.json()) as { error: string }).error).toBe(
      "step_up_required",
    );
    for (const scope of ["admin", "packages:read admin", 1]) {
      const r = await call("POST", "/api/me/tokens", { label: "x", scope });
      expect(r.status).toBe(422);
      expect(((await r.json()) as { fields?: string[] }).fields).toEqual([
        "scope",
      ]);
    }
    expect(await db.all("SELECT 1 FROM account_tokens")).toEqual([]);
  });

  it("revokes the account's own token, 404s another account's, audits, and drops the cache", async () => {
    const mine = await mint(ada);
    const theirs = await mint(bob);
    expect(
      (await call("DELETE", `/api/me/tokens/${theirs.view.id}`)).status,
    ).toBe(404);
    expect(
      (
        await resolvePersonalToken(
          env,
          db,
          theirs.token,
          PACKAGES_READ_SCOPE,
          NOW,
        )
      )?.accountId,
    ).toBe(bob);
    // Resolved once through the registry cache, then revoked here: gone at once on this isolate.
    expect(
      (await lookupRegistryCredential(env, db, mine.token)).resolved,
    ).not.toBeNull();
    const r = await call("DELETE", `/api/me/tokens/${mine.view.id}`);
    expect(r.status).toBe(200);
    expect(
      (await lookupRegistryCredential(env, db, mine.token)).resolved,
    ).toBeNull();
    expect(
      await db.all(
        "SELECT 1 FROM portal_audit WHERE action = 'portal.personal_token.revoke'",
      ),
    ).toHaveLength(1);
  });

  it("requires a session, and lists nothing of another account", async () => {
    await mint(bob);
    const anon = await handlePortalApi(
      new Request("https://key.plrs.im/portal/api/me/tokens"),
      env,
      db,
      "/api/me/tokens",
      NOW,
    );
    expect(anon.status).toBe(401);
    const list = (await (await call("GET", "/api/me/tokens")).json()) as {
      tokens: unknown[];
    };
    expect(list.tokens).toEqual([]);
  });
});

describe("personal tokens: the registry host", () => {
  const tags = `/v2/${NAME}/tags/list`;

  async function licence(accountId: string, product: string): Promise<string> {
    const { licenseId } = await seedLicenseWithKey(db, product);
    await linkLicense(db, accountId, product, licenseId, "admin", NOW);
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      accountId,
      product,
      licenseId,
    );
    return licenseId;
  }

  async function pull(token: string, scope = `repository:${NAME}:pull`) {
    return get(`/v2/token?service=${HOST}&scope=${encodeURIComponent(scope)}`, {
      headers: { authorization: `Basic ${btoa(`__token__:${token}`)}` },
    });
  }

  it("one token reads the feeds of every product the account holds a licence in, and no other", async () => {
    await licence(ada, OWNER);
    await licence(ada, OTHER);
    const { token } = await mint(ada);
    const res = await get(tags, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    // The second product's feed answers the same token (its own mode, its own owner).
    const swift = (owner: string) =>
      get(`/swift/${owner}/login`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await swift(OWNER)).status).toBe(200);
    expect((await swift(OTHER)).status).toBe(200);
  });

  it("an account with no licence in the owner is refused 403, and a stranger's token 401", async () => {
    await licence(bob, OTHER);
    const { token } = await mint(bob);
    const res = await get(tags, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const bad = await get(tags, {
      headers: { authorization: `Bearer pkeyp_${"z".repeat(43)}` },
    });
    expect(bad.status).toBe(401);
  });

  it("an inactive licence reads nothing", async () => {
    const id = await licence(ada, OWNER);
    const { token } = await mint(ada);
    await db.run(
      "UPDATE licenses SET status = 'disabled' WHERE product = ? AND id = ?",
      OWNER,
      id,
    );
    const res = await get(tags, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("the platform's own product is never read by a customer's token, licence or not", async () => {
    await seedProduct(db, SYSTEM_PRODUCT_SLUG).catch(() => undefined);
    const { token } = await mint(ada);
    await db.run(
      "INSERT OR IGNORE INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
      SYSTEM_PRODUCT_SLUG,
      NOW,
    );
    const res = await get(`/swift/${SYSTEM_PRODUCT_SLUG}/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect([401, 403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it("an admin token is refused on every presentation exactly as an unknown token is", async () => {
    await licence(ada, OWNER);
    const { token } = await mint(ada, { scope: ADMIN_SCOPE });
    const unknown = `pkeyp_${"z".repeat(43)}`;
    const shape = async (r: Response) => ({
      status: r.status,
      www: r.headers.get("www-authenticate"),
      body: await r.text(),
    });
    const bearer = (t: string) =>
      get(tags, { headers: { authorization: `Bearer ${t}` } });
    const basic = (t: string) =>
      get(tags, {
        headers: { authorization: `Basic ${btoa(`__token__:${t}`)}` },
      });
    for (const via of [bearer, basic, pull]) {
      const got = await shape(await via(token));
      expect(got.status).toBe(401);
      expect(got).toEqual(await shape(await via(unknown)));
    }
    const swift = await get(`/swift/${OWNER}/login`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(swift.status).toBe(401);
  });

  it("an OCI pull token for a personal token covers several owners, dies with the token, and cannot push", async () => {
    await licence(ada, OWNER);
    const { token, view } = await mint(ada);
    const t = await pull(token);
    expect(t.status).toBe(200);
    const pullToken = ((await t.json()) as { token: string }).token;
    const auth = { headers: { authorization: `Bearer ${pullToken}` } };
    expect((await get(tags, auth)).status).toBe(200);
    // Push is a publisher's: a personal token is read-only by scope.
    const push = await pull(token, `repository:${NAME}:pull,push`);
    expect(push.status).toBe(403);
    // Revoked on another isolate: the pull token stops within the 30-second window.
    await db.run(
      "UPDATE account_tokens SET revoked_at = ? WHERE id = ?",
      NOW,
      view.id,
    );
    expect((await get(tags, auth)).status).toBe(200);
    clock += (REGISTRY_TOKEN_TTL_SECONDS + 1) * 1000;
    vi.setSystemTime(clock);
    expect((await get(tags, auth)).status).toBe(401);
  });

  it("a revoked token stops on this isolate at once through the portal, and elsewhere within the window", async () => {
    await licence(ada, OWNER);
    const { token, view } = await mint(ada);
    const auth = { headers: { authorization: `Bearer ${token}` } };
    expect((await get(tags, auth)).status).toBe(200);
    await db.run(
      "UPDATE account_tokens SET revoked_at = ? WHERE id = ?",
      NOW,
      view.id,
    );
    expect((await get(tags, auth)).status).toBe(200);
    clock += (REGISTRY_TOKEN_TTL_SECONDS + 1) * 1000;
    vi.setSystemTime(clock);
    expect((await get(tags, auth)).status).toBe(401);
  });
});
