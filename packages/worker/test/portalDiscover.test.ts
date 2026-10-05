/**
 * PX-W10 — Discover (docs/design/PORTAL.md §4.16, §10.2 G24, G25):
 *
 *   GET  /api/discover               the products whose auto-issue policy would issue to the
 *                                    account, evaluated WITHOUT issuing, each with its terms and
 *                                    reason;
 *   POST /api/discover/<p>/claim     "Add to library", minted through the auto-issue path.
 *
 * The acceptance criteria pinned here: the listing writes nothing (a write-trapping database and
 * a whole-database comparison), a Discover claim is the same licence first-load auto-issue mints
 * (tier, limits, entitlements), and the claim is idempotent, double submit included.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct, seedTier } from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { getLicense, getLicenseBySub } from "../src/core/data.js";
import { licenseDeviceLimit, resolveEntitlements } from "../src/core/authz.js";
import { loadProductPublic } from "../src/core/products.js";
import {
  activateFromIdentity,
  type OidcIdentity,
} from "../src/services/identity/oidc.js";
import {
  getOrCreateAccountByEmail,
  getOrCreateAccountByIdentity,
  linkLicense,
  upsertPortalProductSettings,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../src/services/identity/portal/session.js";
import {
  discoverIdentity,
  discoverOffers,
} from "../src/services/identity/portal/discover.js";
import { handlePortalApi } from "./portalHarness.js";

const ISSUER = "https://id.plrs.im";
const SUB = "user-mara";
const EMAIL = "mara@fennick.studio";

function portalEnv(): Env {
  const env = makeEnv(new KvMock(), []);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  env.PLATFORM_OIDC_ISSUER = ISSUER;
  env.PLATFORM_OIDC_CLIENT_ID = "portal-client";
  return env;
}

interface Who {
  cookie: string;
  csrf: string;
  accountId: string;
}

async function issue(env: Env, accountId: string): Promise<Who> {
  const { token, session } = await issuePortalSession(
    env,
    { accountId, email: EMAIL, name: "Mara" },
    NOW,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf, accountId };
}

/** An account that signed in to the portal through the platform IdP, with these groups. */
async function platformAccount(
  env: Env,
  db: Db,
  groups: string[] | undefined = [],
): Promise<Who> {
  const account = await getOrCreateAccountByIdentity(
    db,
    {
      provider: ISSUER,
      subject: SUB,
      email: EMAIL,
      displayName: "Mara",
      groups,
    },
    NOW,
  );
  return issue(env, account.id);
}

async function services(
  db: Db,
  slug: string,
  over: Partial<ServicesMap> = {},
): Promise<void> {
  await setServices(
    db,
    slug,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: false },
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
        identity: { enabled: true },
        sync: { enabled: false },
        ...over,
      },
    }),
    "manifest",
    NOW,
  );
}

async function autoIssue(
  db: Db,
  slug: string,
  policy: Record<string, unknown> | null,
): Promise<void> {
  await db.run(
    "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
    policy ? JSON.stringify(policy) : null,
    slug,
  );
}

async function oidcConfig(
  db: Db,
  slug: string,
  opts: { provider?: string; groupRoleMap?: Record<string, unknown> } = {},
): Promise<void> {
  await db.run(
    "INSERT INTO oidc_config (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json) VALUES (?,?,?,?,?,?,?)",
    slug,
    opts.provider ?? "platform",
    opts.provider === "custom" ? "https://idp.example" : null,
    opts.provider === "custom" ? "client" : null,
    null,
    null,
    opts.groupRoleMap ? JSON.stringify(opts.groupRoleMap) : null,
  );
}

/** "Free with a Polaris Key account": the `oidcDefault` auto-issue rule on tier `free`. */
async function freeProduct(db: Db, slug: string): Promise<void> {
  await seedProduct(db, slug);
  await services(db, slug);
  await seedTier(db, slug, "free", { deviceLimit: 2, expiryDays: 90 });
  await autoIssue(db, slug, {
    enabled: true,
    tierId: "free",
    mode: "oidcDefault",
  });
}

/** An open beta for a group at the platform IdP: `groupRoleMap` only, no auto-issue rule. */
async function groupProduct(
  db: Db,
  slug: string,
  group: string,
): Promise<void> {
  await seedProduct(db, slug);
  await services(db, slug);
  await seedTier(db, slug, "beta", { deviceLimit: 3 });
  await oidcConfig(db, slug, {
    groupRoleMap: { [group]: { role: "user", tier: "beta" } },
  });
}

function req(
  method: string,
  path: string,
  who?: Who,
  opts: { csrf?: boolean; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = who.cookie;
  if (who && opts.csrf !== false && method !== "GET")
    headers[PORTAL_CSRF_HEADER] = who.csrf;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://key.plrs.im${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function call(
  env: Env,
  db: Db,
  method: string,
  path: string,
  who?: Who,
  opts: { csrf?: boolean; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await handlePortalApi(
    req(method, path, who, opts),
    env,
    db,
    path,
    NOW,
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

const list = (env: Env, db: Db, who: Who) =>
  call(env, db, "GET", "/api/discover", who);
const claim = (env: Env, db: Db, who: Who, slug: string) =>
  call(env, db, "POST", `/api/discover/${slug}/claim`, who);

/** Every row of every table, for a whole-database before/after comparison. */
async function dump(db: Db): Promise<Record<string, unknown[]>> {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables)
    out[name] = await db.all(`SELECT * FROM "${name}" ORDER BY rowid`);
  return out;
}

/** The database with every write refused: a read path that writes anything throws. */
function readOnly(db: Db): Db {
  const refuse = () => {
    throw new Error("discover listing attempted a write");
  };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "run" || prop === "runChanges" || prop === "batch")
        return refuse;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("GET /api/discover (G24)", () => {
  it("offers a product whose oidcDefault rule would issue, with its terms and reason", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    const who = await platformAccount(env, db);

    const { status, body } = await list(env, db, who);
    expect(status).toBe(200);
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]).toMatchObject({
      product: "mossgarden",
      name: "mossgarden",
      developerName: null,
      iconUrl: null,
      platforms: [],
      reason: "free_with_account",
      offer: {
        tier: "free",
        tierLabel: "free",
        deviceLimit: 2,
        expiresAt: NOW + 90 * 86400,
        expiryDays: 90,
      },
    });
  });

  it("offers a groupRoleMap product only to an account in the group, naming the group", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await groupProduct(db, "aperture", "aperture-beta");

    const outsider = await platformAccount(env, db, ["other"]);
    expect((await list(env, db, outsider)).body.offers).toEqual([]);

    await getOrCreateAccountByIdentity(
      db,
      {
        provider: ISSUER,
        subject: SUB,
        email: EMAIL,
        groups: ["aperture-beta"],
      },
      NOW,
    );
    const { body } = await list(env, db, outsider);
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]).toMatchObject({
      product: "aperture",
      reason: "group:aperture-beta",
      offer: {
        tier: "beta",
        deviceLimit: 3,
        expiresAt: null,
        expiryDays: null,
      },
    });
  });

  it("never offers purchase-only, anonymous-only, off, held, custom-issuer or License-less products", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    // Purchase-only: no auto-issue rule, no group map.
    await seedProduct(db, "bought");
    await services(db, "bought");
    // Auto-issue for anonymous enrolment only (per machine, never an account's offer).
    await seedProduct(db, "anon");
    await services(db, "anon");
    await seedTier(db, "anon", "free");
    await autoIssue(db, "anon", {
      enabled: true,
      tierId: "free",
      mode: "anonymous",
    });
    // Discover turned off by the developer.
    await freeProduct(db, "hidden");
    await upsertPortalProductSettings(
      db,
      "hidden",
      { discoverEnabled: false },
      NOW,
    );
    // The portal turned off.
    await freeProduct(db, "noportal");
    await upsertPortalProductSettings(
      db,
      "noportal",
      { portalEnabled: false },
      NOW,
    );
    // A tenant-controlled issuer: the platform subject means nothing there (R5-02).
    await freeProduct(db, "custom");
    await oidcConfig(db, "custom", { provider: "custom" });
    // License off.
    await freeProduct(db, "nolicense");
    await services(db, "nolicense", { license: { enabled: false } });
    // Deleted.
    await freeProduct(db, "gone");
    await db.run("UPDATE products SET status = 'deleted' WHERE slug = 'gone'");
    // Already held, through a key the account added.
    await freeProduct(db, "held");
    const who = await platformAccount(env, db);
    await db.run(
      `INSERT INTO licenses (product, id, status, tier_id, activated_at, modified_at)
       VALUES ('held', 'lic_held', 'active', 'free', ?, ?)`,
      NOW,
      NOW,
    );
    await linkLicense(
      db,
      who.accountId,
      "held",
      "lic_held",
      "license-key",
      NOW,
    );
    // The one that is offered.
    await freeProduct(db, "mossgarden");

    const { body } = await list(env, db, who);
    expect(body.offers.map((o: { product: string }) => o.product)).toEqual([
      "mossgarden",
    ]);
  });

  it("offers nothing to an account with no platform identity, or with no platform IdP configured", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    const emailOnly = await getOrCreateAccountByEmail(
      db,
      "sam@example.com",
      NOW,
    );
    expect(
      (await list(env, db, await issue(env, emailOnly.id))).body.offers,
    ).toEqual([]);

    const who = await platformAccount(env, db);
    const noIdp = portalEnv();
    delete (noIdp as Record<string, unknown>).PLATFORM_OIDC_ISSUER;
    expect((await list(noIdp, db, who)).body.offers).toEqual([]);
  });

  it("writes nothing: the evaluation runs on a database that refuses every write", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    await groupProduct(db, "aperture", "aperture-beta");
    await db.run(
      "INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json) VALUES (?,?,?,?,?,?,?)",
      "aperture",
      "email_verified",
      "betaAccess",
      JSON.stringify(true),
      null,
      null,
      null,
    );
    const who = await platformAccount(env, db, ["aperture-beta"]);

    const offers = await discoverOffers(env, readOnly(db), who.accountId, NOW);
    expect(offers.map((o) => o.product.slug).sort()).toEqual([
      "aperture",
      "mossgarden",
    ]);
  });

  it("writes nothing: the whole database is identical before and after the listing", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    await groupProduct(db, "aperture", "aperture-beta");
    const who = await platformAccount(env, db, ["aperture-beta"]);

    const before = await dump(db);
    const { status, body } = await list(env, db, who);
    expect(status).toBe(200);
    expect(body.offers).toHaveLength(2);
    expect(await dump(db)).toEqual(before);
    expect(await getLicenseBySub(db, "mossgarden", SUB)).toBeNull();
  });

  it("puts the offer count on GET /api/library for the nav", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    await freeProduct(db, "tidewater");
    const who = await platformAccount(env, db);

    expect(
      (await call(env, db, "GET", "/api/library", who)).body.discoverCount,
    ).toBe(2);
    await claim(env, db, who, "mossgarden");
    const library = (await call(env, db, "GET", "/api/library", who)).body;
    expect(library.discoverCount).toBe(1);
    expect(library.products.map((p: { product: string }) => p.product)).toEqual(
      ["mossgarden"],
    );
  });

  it("is GET only and needs a session", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    const who = await platformAccount(env, db);
    expect((await call(env, db, "POST", "/api/discover", who)).status).toBe(
      405,
    );
    expect((await call(env, db, "GET", "/api/discover")).status).toBe(401);
  });
});

describe("POST /api/discover/<p>/claim (G25)", () => {
  it("mints, links into the library, and audits with source discover", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    const who = await platformAccount(env, db);

    const { status, body } = await claim(env, db, who, "mossgarden");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      added: true,
      product: "mossgarden",
      license: {
        tier: "free",
        status: "active",
        usable: true,
        deviceLimit: 2,
        expiresAt: NOW + 90 * 86400,
      },
    });
    const row = await getLicense(db, "mossgarden", body.license.id);
    expect(row).toMatchObject({ sub: SUB, email: EMAIL, origin: "oidc" });

    const product = (
      await call(env, db, "GET", "/api/products/mossgarden", who)
    ).body;
    expect(product.licenses[0].id).toBe(body.license.id);
    expect((await list(env, db, who)).body.offers).toEqual([]);

    const portalAudit = await db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM portal_audit WHERE action = 'portal.discover.claim'",
    );
    expect(portalAudit).toHaveLength(1);
    expect(portalAudit[0]!.summary).toContain("source: discover");
    const audit = await db.all<{
      action: string;
      summary: string;
      target_id: string;
    }>(
      "SELECT action, summary, target_id FROM audit WHERE product = 'mossgarden'",
    );
    expect(audit).toEqual([
      expect.objectContaining({
        action: "license.create",
        target_id: body.license.id,
        summary: expect.stringContaining("source: discover"),
      }),
    ]);
  });

  it("parity: a Discover claim is the licence first-load auto-issue mints (tier, limits, entitlements)", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    // Two identical products: one claimed from Discover, one issued by the sign-in path.
    for (const slug of ["viadiscover", "viasignin"]) {
      await groupProduct(db, slug, "aperture-beta");
      await seedTier(db, slug, "free", { deviceLimit: 1, expiryDays: 30 });
      await autoIssue(db, slug, {
        enabled: true,
        tierId: "free",
        mode: "both",
      });
      await db.run(
        "INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json) VALUES (?,?,?,?,?,?,?)",
        slug,
        "email_verified",
        "cloudSaves",
        JSON.stringify({ slots: 3 }),
        null,
        null,
        null,
      );
    }
    const who = await platformAccount(env, db, ["aperture-beta"]);
    const claimed = await claim(env, db, who, "viadiscover");
    expect(claimed.status).toBe(200);

    // The identity the product's own first sign-in would present for the same person.
    const identity = (await discoverIdentity(
      env,
      db,
      who.accountId,
    )) as OidcIdentity;
    const product = (await loadProductPublic(db, "viasignin"))!;
    const issued = await activateFromIdentity(db, product, identity, NOW);
    if ("error" in issued) throw new Error(issued.error);

    const a = (await getLicense(db, "viadiscover", claimed.body.license.id))!;
    const b = (await getLicense(db, "viasignin", issued.licenseId))!;
    const comparable = (r: typeof a) => ({
      status: r.status,
      sub: r.sub,
      name: r.name,
      email: r.email,
      groups_json: r.groups_json,
      tier_id: r.tier_id,
      activated_at: r.activated_at,
      expires_at: r.expires_at,
      max_offline_days: r.max_offline_days,
      overrides_json: r.overrides_json,
      channels_json: r.channels_json,
      min_version: r.min_version,
      max_version: r.max_version,
      origin: r.origin,
      modified_by: r.modified_by,
    });
    expect(comparable(a)).toEqual(comparable(b));
    expect(a.tier_id).toBe("beta");

    const pa = (await loadProductPublic(db, "viadiscover"))!;
    expect(await licenseDeviceLimit(db, pa, a, NOW)).toBe(
      await licenseDeviceLimit(db, product, b, NOW),
    );
    const ea = await resolveEntitlements(db, "viadiscover", a, null, NOW);
    const eb = await resolveEntitlements(db, "viasignin", b, null, NOW);
    expect(ea).toEqual(eb);
    expect(ea.cloudSaves?.value).toEqual({ slots: 3 });
    // And the offer listed before the claim promised exactly that.
    expect(claimed.body.license).toMatchObject({
      tier: "beta",
      deviceLimit: 3,
    });
  });

  it("is idempotent: a second submit answers the same licence and mints nothing", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    const who = await platformAccount(env, db);

    const first = await claim(env, db, who, "mossgarden");
    const second = await claim(env, db, who, "mossgarden");
    expect(first.body.added).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      added: false,
      license: { id: first.body.license.id },
    });
    const rows = await db.all(
      "SELECT id FROM licenses WHERE product = 'mossgarden'",
    );
    expect(rows).toHaveLength(1);
  });

  it("a held claim links a floating auto-issue licence back, and never answers one another account owns (I-05)", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    const who = await platformAccount(env, db);
    const first = await claim(env, db, who, "mossgarden");
    const id = first.body.license.id as string;

    // Detached (floating): the claim relinks it to this account and answers it.
    await db.run(
      "UPDATE licenses SET account_id = NULL WHERE product = 'mossgarden' AND id = ?",
      id,
    );
    const relinked = await claim(env, db, who, "mossgarden");
    expect(relinked.status).toBe(200);
    expect(relinked.body).toMatchObject({ added: false, license: { id } });
    expect(
      await db.first(
        "SELECT account_id FROM licenses WHERE product = 'mossgarden' AND id = ?",
        id,
      ),
    ).toEqual({ account_id: who.accountId });

    // Owned by another account: refused, and nothing about the licence is answered.
    const other = await getOrCreateAccountByIdentity(
      db,
      { provider: ISSUER, subject: "someone-else", email: "else@example.com" },
      NOW,
    );
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = 'mossgarden' AND id = ?",
      other.id,
      id,
    );
    const refused = await claim(env, db, who, "mossgarden");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("not_eligible");
    expect(JSON.stringify(refused.body)).not.toContain(id);
  });

  it("is idempotent under a double submit: one licence, one audit, both answers the same", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    const who = await platformAccount(env, db);

    const [a, b] = await Promise.all([
      claim(env, db, who, "mossgarden"),
      claim(env, db, who, "mossgarden"),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.license.id).toBe(b.body.license.id);
    expect([a.body.added, b.body.added].filter(Boolean)).toHaveLength(1);
    expect(
      await db.all("SELECT id FROM licenses WHERE product = 'mossgarden'"),
    ).toHaveLength(1);
    expect(
      await db.all("SELECT id FROM audit WHERE product = 'mossgarden'"),
    ).toHaveLength(1);
    expect(
      await db.all(
        "SELECT id FROM portal_audit WHERE action = 'portal.discover.claim'",
      ),
    ).toHaveLength(1);
  });

  it("answers 409 not_eligible when the offer changed after it was listed, and mints nothing", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    await freeProduct(db, "hidden");
    const who = await platformAccount(env, db);
    expect((await list(env, db, who)).body.offers).toHaveLength(2);

    await autoIssue(db, "mossgarden", null);
    await upsertPortalProductSettings(
      db,
      "hidden",
      { discoverEnabled: false },
      NOW,
    );
    for (const slug of ["mossgarden", "hidden", "no-such-product"]) {
      const res = await claim(env, db, who, slug);
      expect(res.status, slug).toBe(409);
      expect(res.body.error).toBe("not_eligible");
    }
    expect(await db.all("SELECT id FROM licenses")).toEqual([]);
  });

  it("answers 409 to an account the policy never covered (a group it does not hold)", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await groupProduct(db, "aperture", "aperture-beta");
    const who = await platformAccount(env, db, ["other"]);
    expect((await claim(env, db, who, "aperture")).status).toBe(409);
  });

  it("is POST only and needs the CSRF header", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    const who = await platformAccount(env, db);
    expect(
      (
        await call(env, db, "POST", "/api/discover/mossgarden/claim", who, {
          csrf: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(env, db, "GET", "/api/discover/mossgarden/claim", who))
        .status,
    ).toBe(405);
    expect(await db.all("SELECT id FROM licenses")).toEqual([]);
  });

  it("spends the one per-account bucket the activate preview and the key claim spend", async () => {
    const env = portalEnv();
    const db = makeTestDb();
    await freeProduct(db, "mossgarden");
    const who = await platformAccount(env, db);
    for (let i = 0; i < 10; i++) {
      await call(env, db, "POST", "/api/activate/preview", who, {
        body: { key: "not-a-key" },
      });
    }
    const res = await claim(env, db, who, "mossgarden");
    expect(res.status).toBe(429);
    expect(await db.all("SELECT id FROM licenses")).toEqual([]);
  });
});

describe("the stored groups claim (migrations/0071)", () => {
  it("records groups at sign-in, replaces them at the next, and NULLs a missing claim", async () => {
    const db = makeTestDb();
    const read = async () =>
      (
        await db.first<{ groups_json: string | null }>(
          "SELECT groups_json FROM account_links WHERE subject = ?",
          SUB,
        )
      )?.groups_json;
    const signIn = (groups?: string[]) =>
      getOrCreateAccountByIdentity(
        db,
        { provider: ISSUER, subject: SUB, email: EMAIL, groups },
        NOW,
      );
    await signIn(["a", "b"]);
    expect(await read()).toBe('["a","b"]');
    await signIn(["c"]);
    expect(await read()).toBe('["c"]');
    await signIn(undefined);
    expect(await read()).toBeNull();
  });

  it("reads the discover switch back through the settings view, on by default", async () => {
    const db = makeTestDb();
    await seedProduct(db, "mossgarden");
    const on = await upsertPortalProductSettings(db, "mossgarden", {}, NOW);
    expect(on.discover_enabled).toBe(1);
    const off = await upsertPortalProductSettings(
      db,
      "mossgarden",
      { discoverEnabled: false },
      NOW,
    );
    expect(off.discover_enabled).toBe(0);
  });
});
