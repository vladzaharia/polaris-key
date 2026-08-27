/**
 * RED TEAM R5 — multi-tenant isolation & IDOR proof-of-concepts.
 *
 * Every test here drives real worker code paths. Tests named `R5-NN` demonstrate a CONFIRMED
 * weakness; tests named `REFUTED` pin down a hypothesis that did NOT hold, so the assertion
 * fails loudly if the property ever regresses.
 *
 * Threat model: a legitimate tenant (product operator, or a user of a tenant whose IdP it
 * controls) reaching another tenant's data, or a portal account reaching another account's.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedProductSecret,
  seedTier,
} from "../seed.js";
import type { Env } from "../../src/env.js";
import type { Db } from "../../src/db/types.js";
import type { SqliteDb } from "../../src/db/sqlite.js";
import { loadProduct, type Product } from "../../src/core/products.js";
import { handleActivate } from "../../src/services/license/activation.js";
import { handleDevices } from "../../src/core/devices.js";
import { handleMintToken } from "../../src/services/config/mint.js";
import { activateFromIdentity } from "../../src/oidc.js";
import { handleAdminApi } from "../../src/admin/api.js";
import { handleMagicStart } from "../../src/portal/auth.js";
import { handlePortalApi } from "../../src/portal/api.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
  type SessionIdentity,
} from "../../src/admin/session.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../../src/portal/session.js";
import {
  createPortalDownloadToken,
  getOrCreateAccountByEmail,
  getOrCreateAccountByIdentity,
  getPortalDownloadToken,
  getPortalLicense,
  linkEmail,
  linkLicense,
  listPortalLicenses,
  portalAuthCapabilities,
  syncAccountLicenseLinks,
  upsertPortalProductSettings,
} from "../../src/portal/repo.js";
import { pk } from "../../src/kv.js";
import {
  type FetchImpl,
  getInstallationToken,
  installationTokenSlot,
} from "../../src/release/githubApp.js";
import { hashKey } from "../../src/crypto.js";

const PORTAL_SECRET = "r5-portal-session-secret";
const ADMIN_SECRET = "r5-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";

/** The victim tenant: an ordinary product on the platform IdP. */
const ACME = "acme";
/** The attacker tenant: a product whose OIDC issuer the attacker controls. */
const EVILCO = "evilco";

function env(kv = new KvMock()): Env {
  const e = makeEnv(kv, [ACME, EVILCO]);
  e.PORTAL_SESSION_SECRET = PORTAL_SECRET;
  e.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  e.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return e;
}

function req(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[PORTAL_CSRF_HEADER] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`https://key.plrs.im${path}`, init) as unknown as Request;
}

function adminReq(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.csrf) headers[CSRF_HEADER] = opts.csrf;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  return new Request(`https://key.plrs.im${path}`, init) as unknown as Request;
}

async function portalSessionFor(
  e: Env,
  accountId: string,
  email: string,
): Promise<{ cookie: string; csrf: string }> {
  const { token, session } = await issuePortalSession(
    e,
    { accountId, email, name: email },
    NOW,
  );
  return { cookie: `${PORTAL_COOKIE}=${token}`, csrf: session.csrf };
}

async function adminSessionFor(
  e: Env,
  identity: SessionIdentity,
): Promise<{ cookie: string; csrf: string }> {
  const { token, session } = await issueSession(e, identity, NOW);
  return { cookie: `${ADMIN_COOKIE}=${token}`, csrf: session.csrf };
}

/** Give a product an OIDC config whose group map entitles the `staff` group. */
async function seedOidcConfig(db: Db, slug: string): Promise<void> {
  await db.run(
    `INSERT INTO oidc_config
       (product, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    slug,
    `https://idp.${slug}.example`,
    "client-id",
    null,
    null,
    JSON.stringify({ staff: { role: "user" } }),
  );
  await db.run(
    "UPDATE oidc_config SET provider = 'custom' WHERE product = ?",
    slug,
  );
}

/** Activate a device on a product and return its bearer token. */
async function activateDevice(
  e: Env,
  db: SqliteDb,
  product: Product,
  deviceId: string,
  licenseId?: string,
): Promise<{ token: string; licenseId: string }> {
  const { key, licenseId: id } = await seedLicenseWithKey(db, product.slug, {
    ...(licenseId ? { id: licenseId } : {}),
  });
  const res = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-polaris-device": deviceId,
    }),
    e,
    db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  return {
    token: ((await res.json()) as { token: string }).token,
    licenseId: id,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// R5-01 — Cross-tenant license injection via an unverified OIDC email claim.
// oidc.ts:676 maps `email` with NO `email_verified` gate; portal/repo.ts:276 then joins
// `licenses` on `lower(email)` with NO `product` predicate, so a license minted in ANY
// product lands in the matching portal account platform-wide.
// ───────────────────────────────────────────────────────────────────────────────
// FIXED (R5-01, write side). Cross-PRODUCT portal visibility stays — that is the product
// decision — but the join that creates it is hardened: only emails the PORTAL itself verified
// drive a link, and only into products that opted into auto-linking.
// `portal_product_settings.auto_link_enabled` defaults to NULL = "derive from the issuer", and
// a product whose oidc_config.provider is 'custom' (a TENANT-CONTROLLED IdP, whose email claim
// the platform cannot vouch for) resolves to off. R5 proved this is an INJECTION primitive,
// not an extraction one, so the fix is on the write side.
describe("R5-01 cross-tenant license injection by unverified email", () => {
  it("a license minted in a custom-issuer product no longer reaches an unrelated victim's portal", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, ACME);
    await seedProduct(db, EVILCO);
    await seedOidcConfig(db, EVILCO);
    const evilco = (await loadProduct(e, db, EVILCO))!;

    const victimEmail = "ceo@victim-corp.example";

    // The victim's ONLY real relationship is with acme.
    await seedLicenseWithKey(db, ACME, { id: "lic_acme_victim" });
    await db.run(
      "UPDATE licenses SET email = ? WHERE product = ? AND id = ?",
      victimEmail,
      ACME,
      "lic_acme_victim",
    );

    // The attacker signs in through EVILCO's own IdP and simply ASSERTS the victim's email.
    // `mapClaims` (oidc.ts:676) never looks at `email_verified`, and activateFromIdentity
    // writes the claim straight into `licenses.email`.
    const minted = await activateFromIdentity(
      db,
      evilco,
      {
        sub: "attacker-subject-1",
        email: victimEmail, // unverified, attacker-chosen
        name: "ACME Billing Support",
        groups: ["staff"],
        claims: { email_verified: false },
      },
      NOW,
    );
    expect("licenseId" in minted).toBe(true);
    const injectedId = (minted as { licenseId: string }).licenseId;

    const stored = await db.first<{ email: string; sub: string }>(
      "SELECT email, sub FROM licenses WHERE product = ? AND id = ?",
      EVILCO,
      injectedId,
    );
    expect(stored?.email).toBe(victimEmail); // unverified claim persisted verbatim

    // The victim now signs in to the ROOT portal with their own (genuinely owned) inbox.
    const account = await getOrCreateAccountByEmail(db, victimEmail, NOW);
    const { cookie } = await portalSessionFor(e, account.id, victimEmail);
    const res = await handlePortalApi(
      req("GET", "/api/licenses", { cookie }),
      e,
      db,
      "/api/licenses",
      NOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      licenses: Array<{ id: string; product: string; name: string }>;
    };

    // Only the victim's REAL relationship is present. The attacker's row — and its
    // attacker-controlled display name — never enters the trusted surface.
    const products = body.licenses.map((l) => l.product).sort();
    expect(products).toEqual([ACME]);
    expect(body.licenses.some((l) => l.id === injectedId)).toBe(false);

    // Cross-PRODUCT visibility itself still works: an opted-in, platform-issuer product with
    // the same verified email still links, which is the behaviour the owner chose to keep.
    await upsertPortalProductSettings(
      db,
      EVILCO,
      { autoLinkEnabled: true },
      NOW,
    );
    await syncAccountLicenseLinks(db, account.id, NOW);
    const after = await listPortalLicenses(db, account.id);
    expect(after.map((r) => r.product).sort()).toEqual([ACME, EVILCO]);
  });

  it("the injected link also grants the victim's account release visibility for the attacker's product", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, EVILCO);
    // NOTE: no seedOidcConfig here, so EVILCO reads as a PLATFORM-issuer product and
    // auto-linking is on by default. This arm therefore still documents that a verified email
    // links cross-product by design — see the R5-01 header.
    const victimEmail = "target@victim-corp.example";

    await seedLicenseWithKey(db, EVILCO, { id: "lic_evil_bait" });
    await db.run(
      "UPDATE licenses SET email = ? WHERE product = ? AND id = ?",
      victimEmail,
      EVILCO,
      "lic_evil_bait",
    );

    const account = await getOrCreateAccountByEmail(db, victimEmail, NOW);
    await syncAccountLicenseLinks(db, account.id, NOW);

    // A `portal_license_links` row was written into the victim's account without consent.
    const links = await db.all<{ product: string; source: string }>(
      "SELECT product, source FROM portal_license_links WHERE account_id = ?",
      account.id,
    );
    expect(links).toEqual([{ product: EVILCO, source: "email" }]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R5-02 — The `sub` join (portal/repo.ts:297) is qualified by NEITHER product NOR issuer.
// `portal_account_identities.subject` is always minted by the PLATFORM IdP, while
// `licenses.sub` is minted by each tenant's own (possibly custom) IdP. One flat namespace.
// ───────────────────────────────────────────────────────────────────────────────
// FIXED (R5-02): the left side of this join is ALWAYS a platform-IdP subject (portal/auth.ts
// hardcodes provider "oidc" with the issuer from platformOidcConfig), so the right side is now
// restricted to licenses whose product also authenticates against the PLATFORM issuer. The
// qualifier is derived from oidc_config rather than a new denormalised column, so the
// product-OIDC lane needs no change. A tenant that mints `sub = "1000"` in its own namespace
// can no longer collide with a platform subject.
describe("R5-02 cross-issuer OIDC subject collision", () => {
  it("a tenant-controlled IdP subject can no longer link into a platform-IdP portal account", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, EVILCO);
    await seedOidcConfig(db, EVILCO);
    const evilco = (await loadProduct(e, db, EVILCO))!;

    // The victim's portal identity, minted by the PLATFORM IdP.
    const victim = await getOrCreateAccountByIdentity(
      db,
      {
        provider: "oidc",
        subject: "1000",
        email: "victim@corp.example",
        displayName: "Victim",
      },
      NOW,
    );

    // EVILCO runs its OWN issuer, so it chooses its own subject namespace. It picks "1000".
    // Note the email deliberately does NOT match: this is purely the `sub` join.
    const minted = await activateFromIdentity(
      db,
      evilco,
      {
        sub: "1000",
        email: "attacker@evil.example",
        name: "Attacker",
        groups: ["staff"],
        claims: {},
      },
      NOW,
    );
    const injectedId = (minted as { licenseId: string }).licenseId;

    await syncAccountLicenseLinks(db, victim.id, NOW);
    expect(await listPortalLicenses(db, victim.id)).toEqual([]);
    expect(
      await db.first(
        "SELECT source FROM portal_license_links WHERE account_id = ? AND product = ?",
        victim.id,
        EVILCO,
      ),
    ).toBeNull();

    // Even an explicit operator opt-in cannot re-open the SUBJECT join for a custom issuer:
    // auto_link_enabled governs the email join, the issuer qualifier governs this one.
    await upsertPortalProductSettings(
      db,
      EVILCO,
      { autoLinkEnabled: true },
      NOW,
    );
    await syncAccountLicenseLinks(db, victim.id, NOW);
    expect(await listPortalLicenses(db, victim.id)).toEqual([]);

    // Control: the same subject on a PLATFORM-issuer product still links, so idempotent
    // re-sign-in for first-party products is unaffected.
    await db.run(
      "UPDATE oidc_config SET provider = 'platform' WHERE product = ?",
      EVILCO,
    );
    await syncAccountLicenseLinks(db, victim.id, NOW);
    expect((await listPortalLicenses(db, victim.id)).map((r) => r.id)).toEqual([
      injectedId,
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R5-03 — The `_portal` rate-limit bucket carries no product dimension and lives in one
// global Durable Object shard (rateLimit.ts:23 idFromName("_portal"),
// portal/api.ts:264-285). One tenant's traffic 429s every other tenant for that account.
// It is also consumed by requests that never pass authorization.
// ───────────────────────────────────────────────────────────────────────────────
describe("R5-03 cross-tenant rate-limit bucket sharing", () => {
  // FIXED (R5-05): the bucket id carries the product and the counter lives in that product's
  // own DO shard, and the charge happens only once ownership is proven. Exhausting tenant A
  // therefore neither touches tenant B's budget nor can be done by a non-owner at all.
  it("a non-owner cannot spend the budget, and exhausting product A leaves product B untouched", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, ACME);
    await seedProduct(db, EVILCO);
    const account = await getOrCreateAccountByEmail(
      db,
      "user@example.com",
      NOW,
    );
    const { cookie, csrf } = await portalSessionFor(
      e,
      account.id,
      "user@example.com",
    );

    // 50 UNAUTHORIZED DELETEs against ACME (limit is 20). None of them may consume budget:
    // the charge now lands after `getPortalLicense` proves the caller owns the licence.
    for (let i = 0; i < 50; i++) {
      const path = `/api/licenses/${ACME}/lic_does_not_exist/devices/dev-${i}`;
      const res = await handlePortalApi(
        req("DELETE", path, { cookie, csrf }),
        e,
        db,
        path,
        NOW,
      );
      expect(res.status).toBe(404);
    }

    // Now genuinely own a licence on BOTH tenants and spend ACME's budget legitimately.
    await seedLicenseWithKey(db, ACME, { id: "lic_acme_own" });
    await seedLicenseWithKey(db, EVILCO, { id: "lic_evil_own" });
    await linkLicense(db, account.id, ACME, "lic_acme_own", "admin", NOW);
    await linkLicense(db, account.id, EVILCO, "lic_evil_own", "admin", NOW);

    const acmePath = `/api/licenses/${ACME}/lic_acme_own/devices/dev-x`;
    for (let i = 0; i < 20; i++) {
      const res = await handlePortalApi(
        req("DELETE", acmePath, { cookie, csrf }),
        e,
        db,
        acmePath,
        NOW,
      );
      expect(res.status).toBe(404); // no such device, but the budget IS charged
    }
    const limitedA = await handlePortalApi(
      req("DELETE", acmePath, { cookie, csrf }),
      e,
      db,
      acmePath,
      NOW,
    );
    expect(limitedA.status).toBe(429);

    // The other tenant is unaffected — different id dimension, different DO shard.
    const evilPath = `/api/licenses/${EVILCO}/lic_evil_own/devices/dev-y`;
    const stillFine = await handlePortalApi(
      req("DELETE", evilPath, { cookie, csrf }),
      e,
      db,
      evilPath,
      NOW,
    );
    expect(stillFine.status).toBe(404);
    expect(stillFine.status).not.toBe(429);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R5-04 — portalAuthCapabilities (portal/repo.ts:496-516) aggregates every tenant's
// portal_product_settings with no product predicate, so one tenant enabling a feature
// re-enables it platform-wide for tenants that switched it off.
// ───────────────────────────────────────────────────────────────────────────────
describe("R5-04 cross-tenant portal capability coupling", () => {
  it("one tenant keeping magic-link on overrides every other tenant's opt-out", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, ACME);
    await seedProduct(db, EVILCO);

    // ACME explicitly turns the portal AND magic-link sign-in off.
    await upsertPortalProductSettings(
      db,
      ACME,
      { portalEnabled: false, magicEnabled: false, oidcEnabled: false },
      NOW,
    );
    // EVILCO leaves the defaults (everything on).

    const caps = await portalAuthCapabilities(db);
    expect(caps.portalEnabled).toBe(true);
    expect(caps.magicEnabled).toBe(true);
    expect(caps.oidcEnabled).toBe(true);

    // And the gate really does open: the handler proceeds past the capability check and
    // fails later on email config (503) rather than refusing as disabled (404).
    const res = await handleMagicStart(
      req("POST", "/api/magic/start", { body: { email: "a@b.example" } }),
      e,
      db,
    );
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual(
      expect.objectContaining({ error: "email_not_configured" }),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R5-05 — There is no tenant-scoped admin role. admin/api.ts:12-13 documents "product
// routes need the product's admin_group", but admin/authz.ts:21-27 ignores the product
// entirely and grants on PLATFORM_ADMIN_GROUP alone.
// ───────────────────────────────────────────────────────────────────────────────
describe("R5-05 no tenant-scoped admin role exists", () => {
  it("a product's own admin_group grants nothing; a platform admin owns every tenant", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, ACME);
    await seedProduct(db, EVILCO);
    await db.run(
      "UPDATE products SET admin_group = ? WHERE slug = ?",
      "acme-admins",
      ACME,
    );
    await seedLicenseWithKey(db, ACME, { id: "lic_acme_1" });
    await seedLicenseWithKey(db, EVILCO, { id: "lic_evil_1" });

    // The operator of ACME, holding exactly ACME's declared admin_group.
    const acmeOp = await adminSessionFor(e, {
      sub: "acme-op",
      email: "op@acme.example",
      name: "ACME Operator",
      groups: ["acme-admins"],
    });
    const denied = await handleAdminApi(
      adminReq("GET", "/manage/api/products/acme/licenses", {
        cookie: acmeOp.cookie,
      }),
      e,
      db,
      "/api/products/acme/licenses",
      NOW,
    );
    // 403 on their OWN product: product-scoped admin is not implemented.
    expect(denied.status).toBe(403);

    // The only role that works is platform-wide, and it reaches EVERY tenant.
    const platform = await adminSessionFor(e, {
      sub: "plat",
      email: "plat@example.com",
      name: "Platform",
      groups: [PLATFORM_GROUP],
    });
    for (const slug of [ACME, EVILCO]) {
      const res = await handleAdminApi(
        adminReq("GET", `/manage/api/products/${slug}/licenses`, {
          cookie: platform.cookie,
        }),
        e,
        db,
        `/api/products/${slug}/licenses`,
        NOW,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { licenses: Array<{ id: string }> };
      expect(body.licenses.length).toBe(1);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R5-06 — edgeMint.ts:188-192: any licensed device of a product may mint ANY recipe id in
// that product. Recipe access is not entitlement/tier gated. (Intra-tenant, not cross.)
// ───────────────────────────────────────────────────────────────────────────────
describe("R5-06 edge-mint recipes are not entitlement-gated", () => {
  async function seedRecipe(db: Db, slug: string, id: string): Promise<void> {
    await db.run(
      `INSERT INTO edge_mint_config
         (product,id,alg,signing_key_secret,kid,claims_template_json,ttl_seconds,audience,auth_page_template)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      slug,
      id,
      "EdDSA",
      "mintkey",
      "kid-1",
      JSON.stringify({ iss: "TEAMID" }),
      3600,
      "https://api.example.com",
      null,
    );
  }

  it("a free-tier device mints the premium recipe it was never granted", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, ACME);
    await seedProductSecret(
      db,
      ACME,
      "mintkey",
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----",
    );
    await seedTier(db, ACME, "free");
    await seedRecipe(db, ACME, "premium-partner-api");
    const acme = (await loadProduct(e, db, ACME))!;

    const { key } = await seedLicenseWithKey(db, ACME, {
      id: "lic_free",
      tierId: "free",
    });
    const act = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-polaris-device": "dev-free",
      }),
      e,
      db,
      acme,
      NOW,
    );
    const token = ((await act.json()) as { token: string }).token;

    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      e,
      db,
      acme,
      "premium-partner-api",
      NOW,
    );
    expect(res.status).toBe(200); // no tier / entitlement check anywhere on this path
  });

  it("REFUTED: minting does NOT cross tenants — another product's recipe id is 404", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, ACME);
    await seedProduct(db, EVILCO);
    await seedProductSecret(
      db,
      ACME,
      "mintkey",
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBlV9cXFJlt08+qaVvnIkgRmgao8P0rhkVh3onqOXPW1\n-----END PRIVATE KEY-----",
    );
    await seedRecipe(db, ACME, "acme-secret-recipe");
    const evilco = (await loadProduct(e, db, EVILCO))!;
    const { token } = await activateDevice(e, db, evilco, "dev-evil");

    const res = await handleMintToken(
      mkReq("POST", { authorization: `Bearer ${token}` }),
      e,
      db,
      evilco,
      "acme-secret-recipe",
      NOW,
    );
    expect(res.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// R5-07 — getPortalDownloadToken (portal/repo.ts:613-616) looks a token up by hash with no
// product predicate, and the caller then TRUSTS row.product as the authorization scope,
// while the matching write (markPortalDownloadUsed) IS product-scoped. The table PK is
// (product, token_hash), so token_hash alone is not unique.
// ───────────────────────────────────────────────────────────────────────────────
describe("R5-07 download-token lookup is not product-scoped", () => {
  async function seedRelease(db: Db, slug: string): Promise<void> {
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url,
          metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'public', 'public', ?, NULL, ?, ?)`,
      slug,
      "rel-1",
      "1.0.0",
      "v1",
      null,
      null,
      null,
      NOW,
      NOW,
      NOW,
    );
  }

  // FIXED (R5-10 / R11-12 / R11-05): `idx_release_download_tokens_hash` (0015_data_integrity)
  // makes token_hash GLOBALLY unique, so the second tenant's insert is refused by the database
  // and the unscoped lookup can no longer resolve to an attacker-chosen `row.product`. The same
  // index turns what R11-05 measured as `SCAN release_download_tokens` on an unauthenticated,
  // unrate-limited endpoint into a single-row SEARCH.
  it("a second tenant can no longer hold the same token_hash", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, ACME);
    await seedProduct(db, EVILCO);
    await seedRelease(db, ACME);
    await seedRelease(db, EVILCO);

    const account = await getOrCreateAccountByEmail(db, "u@example.com", NOW);
    const token = await createPortalDownloadToken(e, db, {
      accountId: account.id,
      product: ACME,
      releaseId: "rel-1",
      artifactId: null as unknown as string,
      now: NOW,
    });
    const hash = await hashKey(token, e.KEY_HASH_PEPPER);

    // The PK is (product, token_hash), so the PK alone still permits a duplicate hash under a
    // second tenant — the UNIQUE index is what refuses it.
    await expect(
      db.run(
        `INSERT INTO release_download_tokens
           (product, token_hash, release_id, artifact_id, device_id,
            scope_json, expires_at, used_at, created_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?)`,
        EVILCO,
        hash,
        "rel-1",
        JSON.stringify({ portalAccountId: account.id }),
        NOW + 300,
        NOW,
      ),
    ).rejects.toThrow(/UNIQUE/i);

    const all = await db.all<{ product: string }>(
      "SELECT product FROM release_download_tokens WHERE token_hash = ?",
      hash,
    );
    expect(all.length).toBe(1); // the hash IS globally unique now

    // So the unscoped lookup is unambiguous: `row.product` is the minting tenant, and it is
    // safe for handlePortalDownload to use it as the authorization scope.
    const row = await getPortalDownloadToken(e, db, token, NOW);
    expect(row).not.toBeNull();
    expect(row!.product).toBe(ACME);

    // …and the lookup is now an index SEARCH rather than a full scan of a never-purged table.
    const plan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT * FROM release_download_tokens WHERE token_hash = ?",
      hash,
    );
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/SEARCH/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// REFUTED — KV key-namespace confusion.
// pk()/flowKey()/deviceFlowKey()/sessionKey() all place a CONSTANT `kind` segment between
// the tenant slug and the attacker-controlled id, so user input can only ever extend its
// own namespace; it can never shift into another one.
// ───────────────────────────────────────────────────────────────────────────────
describe("REFUTED: KV namespace confusion via crafted state / device_code / token", () => {
  const NASTY = [
    "../token/deadbeef",
    ":token:deadbeef",
    "x:token:deadbeef",
    "",
    "..%2Ftoken%2Fdeadbeef",
    "a:b:c:d:e",
    "p:acme:token:deadbeef",
  ];

  it("no crafted id can make a flow/device-flow key collide with a token key", () => {
    for (const s of NASTY) {
      const flow = `p:${ACME}:flow:${s}`;
      const deviceFlow = `p:${ACME}:device-flow:${s}`;
      const browser = `p:${ACME}:browser-session:${s}`;
      for (const other of [ACME, EVILCO]) {
        // A real token key for either tenant, with any hash the attacker can imagine.
        const tokenKey = pk(other, "token", s);
        expect(flow).not.toBe(tokenKey);
        expect(deviceFlow).not.toBe(tokenKey);
        expect(browser).not.toBe(tokenKey);
      }
      // Nor can it reach the platform-global admin/portal namespaces.
      expect(flow.startsWith("admin:flow:")).toBe(false);
      expect(flow.startsWith("portal:magic:")).toBe(false);
    }
  });

  it("a crafted OIDC poll state cannot read another namespace's KV entry", async () => {
    const db = makeTestDb();
    const kv = new KvMock();
    const e = env(kv);
    await seedProduct(db, ACME);
    const acme = (await loadProduct(e, db, ACME))!;
    const { token } = await activateDevice(e, db, acme, "dev-1");
    const tokenHash = await hashKey(token, e.KEY_HASH_PEPPER);
    expect(kv.keys()).toContain(pk(ACME, "token", tokenHash));

    const { handleAuthPoll } = await import("../../src/oidc.js");
    for (const s of [
      `../token/${tokenHash}`,
      `:token:${tokenHash}`,
      tokenHash,
    ]) {
      const url = `https://key.plrs.im/${ACME}/auth/poll?state=${encodeURIComponent(s)}&device=dev-1`;
      const res = await handleAuthPoll(
        new Request(url) as unknown as Request,
        e,
        db,
        acme,
        NOW,
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as { status: string }).toEqual({
        status: "timeout",
      });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// REFUTED — the ownership checks named in the brief actually hold.
// ───────────────────────────────────────────────────────────────────────────────
describe("REFUTED: IDOR sweep — ownership predicates hold", () => {
  it("admin devices/keys sub-resources reject a foreign licenseId (devices.ts:62, keys.ts:88)", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, ACME);
    const acme = (await loadProduct(e, db, ACME))!;
    await activateDevice(e, db, acme, "dev-a", "lic_a");
    await seedLicenseWithKey(db, ACME, { id: "lic_b" });

    const platform = await adminSessionFor(e, {
      sub: "plat",
      email: "p@e.com",
      name: "P",
      groups: [PLATFORM_GROUP],
    });

    // dev-a belongs to lic_a; asking for it under lic_b must 404.
    const dev = await handleAdminApi(
      adminReq(
        "DELETE",
        "/manage/api/products/acme/licenses/lic_b/devices/dev-a",
        {
          cookie: platform.cookie,
          csrf: platform.csrf,
        },
      ),
      e,
      db,
      "/api/products/acme/licenses/lic_b/devices/dev-a",
      NOW,
    );
    expect(dev.status).toBe(404);

    const keyRow = await db.first<{ key_hash: string }>(
      "SELECT key_hash FROM keys_index WHERE product = ? AND license_id = ?",
      ACME,
      "lic_a",
    );
    const keyRes = await handleAdminApi(
      adminReq(
        "POST",
        `/manage/api/products/acme/licenses/lic_b/keys/${keyRow!.key_hash}/revoke`,
        { cookie: platform.cookie, csrf: platform.csrf },
      ),
      e,
      db,
      `/api/products/acme/licenses/lic_b/keys/${keyRow!.key_hash}/revoke`,
      NOW,
    );
    expect(keyRes.status).toBe(404);
  });

  it("a portal account cannot read another account's license (portal/repo.ts:329-345)", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, ACME);
    await seedLicenseWithKey(db, ACME, { id: "lic_owner" });
    await db.run(
      "UPDATE licenses SET email = ? WHERE product = ? AND id = ?",
      "owner@example.com",
      ACME,
      "lic_owner",
    );
    const owner = await getOrCreateAccountByEmail(db, "owner@example.com", NOW);
    await syncAccountLicenseLinks(db, owner.id, NOW);
    expect(
      await getPortalLicense(db, owner.id, ACME, "lic_owner"),
    ).not.toBeNull();

    const stranger = await getOrCreateAccountByEmail(
      db,
      "stranger@example.com",
      NOW,
    );
    expect(
      await getPortalLicense(db, stranger.id, ACME, "lic_owner"),
    ).toBeNull();

    const { cookie } = await portalSessionFor(
      e,
      stranger.id,
      "stranger@example.com",
    );
    const path = `/api/licenses/${ACME}/lic_owner`;
    const res = await handlePortalApi(
      req("GET", path, { cookie }),
      e,
      db,
      path,
      NOW,
    );
    expect(res.status).toBe(404);
  });

  it("route.deviceId (decodeURIComponent'd) cannot touch another license's device", async () => {
    const db = makeTestDb();
    const e = env();
    await seedProduct(db, ACME);
    const acme = (await loadProduct(e, db, ACME))!;
    const a = await activateDevice(e, db, acme, "dev-a", "lic_a");
    await activateDevice(e, db, acme, "dev-b", "lic_b");

    // lic_a's token trying to delete lic_b's device.
    const res = await handleDevices(
      mkReq("DELETE", { authorization: `Bearer ${a.token}` }),
      e,
      db,
      acme,
      NOW,
      "dev-b",
    );
    expect(res.status).toBe(404);
    const still = await db.first<{ status: string }>(
      "SELECT status FROM devices WHERE product = ? AND device_id = ?",
      ACME,
      "dev-b",
    );
    expect(still?.status).toBe("authorized");
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// REFUTED (with a caveat) — controlling one inbox does NOT inherit other people's
// licenses. The root portal DOES gate on email_verified (portal/auth.ts:115, :286), and an
// (email -> account) binding is STICKY: ON CONFLICT never reassigns account_id.
// The caveat: stickiness is also a pre-hijack primitive — whoever binds an address first
// keeps it forever, and later sign-ins for that address land in the FIRST account.
// ───────────────────────────────────────────────────────────────────────────────
describe("REFUTED: portal email binding is sticky, so an inbox does not inherit foreign licenses", () => {
  it("linkEmail never reassigns an email to a second account", async () => {
    const db = makeTestDb();
    const first = await getOrCreateAccountByEmail(
      db,
      "shared@example.com",
      NOW,
    );
    const second = await getOrCreateAccountByEmail(
      db,
      "other@example.com",
      NOW,
    );

    await linkEmail(db, second.id, "shared@example.com", NOW + 10);
    const row = await db.first<{ account_id: string }>(
      "SELECT account_id FROM portal_account_emails WHERE email = ?",
      "shared@example.com",
    );
    expect(row?.account_id).toBe(first.id); // NOT moved to `second`

    // ...and a later sign-in for that address therefore resolves to the FIRST account,
    // which is exactly the pre-hijack sharp edge worth documenting.
    const resolved = await getOrCreateAccountByEmail(
      db,
      "shared@example.com",
      NOW + 20,
    );
    expect(resolved.id).toBe(first.id);
  });

  it("an attacker's own verified inbox yields only licenses bearing THAT address", async () => {
    const db = makeTestDb();
    await seedProduct(db, ACME);
    await seedLicenseWithKey(db, ACME, { id: "lic_victim" });
    await db.run(
      "UPDATE licenses SET email = ? WHERE product = ? AND id = ?",
      "victim@corp.example",
      ACME,
      "lic_victim",
    );
    const attacker = await getOrCreateAccountByEmail(
      db,
      "attacker@evil.example",
      NOW,
    );
    await syncAccountLicenseLinks(db, attacker.id, NOW);
    expect(await listPortalLicenses(db, attacker.id)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R5-03 — GitHub App installation tokens were minted UN-SCOPED, and the cache
//         scope was whatever the caller happened to pass.
// ═════════════════════════════════════════════════════════════════════════════
//
// FIXED. Two defects, and the ORDER matters: fixing the mint alone would have been defeated
// by the shared cache entry, because `installId` is identical for every product in an
// org-wide installation and the only other key component was a caller-supplied string that
// meant "repo name" at `linkRepo.ts`/`resync.ts` and "product slug" at
// `index.ts`/`health.ts`. So:
//
//   1. the cache key is now derived inside `getInstallationToken` from
//      `(installId, down-scope)` and ignores the caller's argument entirely; and
//   2. the mint POSTs `repositories` + a read-only `permissions` set, which GitHub enforces
//      server-side, instead of sending no body at all and getting installation-wide scope.
//
// The tests below are the original code-proven finding inverted into executable assertions.

/** A GitHub App env whose private key really signs, so the mint path is exercised for real. */
async function ghAppEnv(kv: KvMock): Promise<Env> {
  const env = makeEnv(kv, [ACME]);
  env.GITHUB_APP_ID = "123456";
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey(
    "pkcs8",
    pair.privateKey,
  )) as ArrayBuffer;
  let bin = "";
  for (const b of new Uint8Array(pkcs8)) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  env.GITHUB_APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${(b64.match(/.{1,64}/g) ?? [b64]).join("\n")}\n-----END PRIVATE KEY-----`;
  return env;
}

interface MintCall {
  url: string;
  body: { repositories?: string[]; permissions?: Record<string, string> };
}

/** A fetch stub that records every access-token POST and answers with a distinct token. */
function recordingMint(
  token = "ghs_token",
  status = 201,
): { fetchImpl: FetchImpl; mints: MintCall[] } {
  const mints: MintCall[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    if (url.includes("/access_tokens")) {
      mints.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")) as MintCall["body"],
      });
      return new Response(JSON.stringify({ token }), {
        status,
      }) as unknown as Response;
    }
    return new Response("{}", { status: 200 }) as unknown as Response;
  };
  return { fetchImpl, mints };
}

describe("R5-03 GitHub installation tokens are down-scoped to one repo", () => {
  it("FIXED: the mint POSTs `repositories` + read-only `permissions` (it used to send NO body)", async () => {
    const kv = new KvMock();
    const env = await ghAppEnv(kv);
    const { fetchImpl, mints } = recordingMint();

    await getInstallationToken(
      env,
      { owner: "acme", repo: "widget" },
      42,
      NOW,
      fetchImpl,
    );

    expect(mints).toHaveLength(1);
    expect(mints[0]!.url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    // The whole finding: an org-wide install used to hand back a token good for EVERY repo.
    expect(mints[0]!.body.repositories).toEqual(["widget"]);
    // ...and read-only, minimum permissions. Nothing on this path writes.
    expect(mints[0]!.body.permissions).toEqual({
      contents: "read",
      metadata: "read",
    });
    for (const level of Object.values(mints[0]!.body.permissions ?? {})) {
      expect(level).toBe("read");
    }
  });

  it("FIXED: a channel-workflow product asks for actions/pull_requests read — and nothing more", async () => {
    const kv = new KvMock();
    const env = await ghAppEnv(kv);
    const { fetchImpl, mints } = recordingMint();

    await getInstallationToken(
      env,
      { owner: "acme", repo: "widget", channelWorkflow: true },
      42,
      NOW,
      fetchImpl,
    );
    expect(mints[0]!.body.permissions).toEqual({
      contents: "read",
      metadata: "read",
      actions: "read",
      pull_requests: "read",
    });
  });

  it("FIXED: two products on ONE org-wide installation no longer share a cache entry", async () => {
    const kv = new KvMock();
    const env = await ghAppEnv(kv);
    // Same `installId` — the org-wide case. Before the fix the key was
    // `p:<caller-string>:gh-token:42`, so a slug caller and a repo-name caller could land on
    // one entry and be served each other's broad token.
    const INSTALL = 42;
    const a = installationTokenSlot(INSTALL, {
      owner: "acme",
      repo: "product-a",
    });
    const b = installationTokenSlot(INSTALL, {
      owner: "acme",
      repo: "product-b",
    });
    expect(a.key).not.toBe(b.key);
    expect(a.key).toBe(`gh:install:${INSTALL}:token:acme/product-a`);

    // Drive both through the real mint and confirm each got its OWN token, scoped to its own
    // repo, and that neither can read the other's slot.
    const first = recordingMint("ghs_for_a");
    await getInstallationToken(
      env,
      { owner: "acme", repo: "product-a" },
      INSTALL,
      NOW,
      first.fetchImpl,
    );
    const second = recordingMint("ghs_for_b");
    const tokenB = await getInstallationToken(
      env,
      { owner: "acme", repo: "product-b" },
      INSTALL,
      NOW,
      second.fetchImpl,
    );

    expect(first.mints[0]!.body.repositories).toEqual(["product-a"]);
    expect(second.mints[0]!.body.repositories).toEqual(["product-b"]);
    // B genuinely re-minted rather than reusing A's cached entry.
    expect(tokenB).toBe("ghs_for_b");
    expect(kv.keys().sort()).toEqual([a.key, b.key].sort());
  });

  it("FIXED: the cache key ignores the caller's scope argument entirely", async () => {
    // The caller disagreement documented in R5-isolation.md is still present in the two
    // off-limits call sites, so the key derivation has to be correct WITHOUT their help.
    // A bare string (repo name at linkRepo/resync, product slug at health) can never produce
    // the same slot as the structured, owner-qualified form.
    const bare = installationTokenSlot(42, "widget");
    const structured = installationTokenSlot(42, {
      owner: "acme",
      repo: "widget",
    });
    expect(bare.key).not.toBe(structured.key);
    // Neither lives in the product namespace any more, so no product slug can collide with it.
    expect(bare.key.startsWith("p:")).toBe(false);
    expect(structured.key.startsWith("p:")).toBe(false);
    // ...and the sealing AAD differs too, so even a guessed key yields an unopenable blob.
    expect(bare.ctx.id).not.toBe(structured.ctx.id);
  });

  it("FIXED: a legacy bare-string caller still gets a down-scoped token when the name IS a repo", async () => {
    const kv = new KvMock();
    const env = await ghAppEnv(kv);
    const { fetchImpl, mints } = recordingMint();
    await getInstallationToken(env, "widget", 42, NOW, fetchImpl);
    expect(mints).toHaveLength(1);
    expect(mints[0]!.body.repositories).toEqual(["widget"]);
  });

  it("availability: a 422 on the narrowing falls back rather than 500ing the release surface", async () => {
    // GitHub 422s a `repositories` entry that is not in the installation — which is what
    // `release/health.ts` produces, because it passes a PRODUCT SLUG. Falling back keeps the
    // health check working; the fallback token is still permission-minimised, and it is
    // reported in R10-dos.md as the one caller this lane could not fully scope.
    const kv = new KvMock();
    const env = await ghAppEnv(kv);
    const attempts: MintCall["body"][] = [];
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = String(input);
      if (!url.includes("/access_tokens"))
        return new Response("{}", { status: 200 }) as unknown as Response;
      const body = JSON.parse(String(init?.body ?? "{}")) as MintCall["body"];
      attempts.push(body);
      if (body.repositories)
        return new Response("no such repo", {
          status: 422,
        }) as unknown as Response;
      return new Response(JSON.stringify({ token: "ghs_wide" }), {
        status: 201,
      }) as unknown as Response;
    };

    const tok = await getInstallationToken(
      env,
      "not-a-repo",
      42,
      NOW,
      fetchImpl,
    );
    expect(tok).toBe("ghs_wide");
    expect(attempts).toHaveLength(2);
    // Even the fallback is read-only — never the old "no body at all", which inherited the
    // App's full write scopes.
    expect(attempts[1]!.repositories).toBeUndefined();
    expect(attempts[1]!.permissions).toEqual({
      contents: "read",
      metadata: "read",
    });
  });

  it("a STRUCTURED caller never silently widens: a 422 there is a hard failure", async () => {
    const kv = new KvMock();
    const env = await ghAppEnv(kv);
    const attempts: MintCall["body"][] = [];
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = String(input);
      if (!url.includes("/access_tokens"))
        return new Response("{}", { status: 200 }) as unknown as Response;
      attempts.push(JSON.parse(String(init?.body ?? "{}")) as MintCall["body"]);
      return new Response("nope", { status: 422 }) as unknown as Response;
    };
    await expect(
      getInstallationToken(
        env,
        { owner: "acme", repo: "widget" },
        42,
        NOW,
        fetchImpl,
      ),
    ).rejects.toThrow(/installation token failed: 422/);
    // One attempt only — no repositories-less retry for a caller that knows its coordinates.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.repositories).toEqual(["widget"]);
  });
});
