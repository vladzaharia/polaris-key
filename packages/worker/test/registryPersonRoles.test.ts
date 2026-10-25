/**
 * ST-31.9: `personMayRead` reads the account's stored role bindings (F-33's item). A personal
 * token's account reads a private or entitled feed when its roles reach the owner, and only then
 * besides the licence path F-33 built. Every widening is pinned to the principal it is meant
 * for: the product, the area (`ship`), the account's own state, and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import "../src/mount.js";
import {
  authorizeFeedRead,
  forgetLicenceHolds,
} from "../src/services/distribution/registry/authorize.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import {
  PACKAGES_READ_SCOPE,
  mintAccountToken,
} from "../src/core/accounts/personalTokens.js";
import { forgetRegistryTokens } from "../src/core/registry/registryTokens.js";
import { newBindingId, stmtInsertBinding } from "../src/core/rbac/bindings.js";
import type { AreaId } from "../src/core/rbac/areas.js";
import type { GrantScope, Role } from "../src/core/rbac/can.js";
import { setServices } from "../src/core/products/store.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";

const ALPHA = "alpha";
const BETA = "beta";
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

async function seedOwner(slug: string, mode = "authenticated"): Promise<void> {
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
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes, updated_at)
     VALUES (?, 'npm', 1, ?, '{"scope":"@x"}', 1024, ?)`,
    slug,
    mode,
    NOW,
  );
}

async function setMode(slug: string, mode: string): Promise<void> {
  await db.run(
    "UPDATE dist_registry_feeds SET access_mode = ? WHERE product = ?",
    mode,
    slug,
  );
  forgetRegistrySettings();
}

async function account(who: string): Promise<{ id: string; token: string }> {
  const id = (await getOrCreateAccountByEmail(db, `${who}@example.com`, NOW))
    .id;
  const res = await mintAccountToken(
    env,
    db,
    {
      accountId: id,
      label: "t",
      scope: PACKAGES_READ_SCOPE,
      createdBy: `portal:${id}`,
    },
    NOW,
  );
  if (!res.ok) throw new Error(JSON.stringify(res));
  return { id, token: res.token };
}

async function bind(
  accountId: string | null,
  role: Role,
  scope: GrantScope,
  areas: AreaId[] | null,
  extra: { emailNorm?: string; source?: "grant" | "invite" | "creator" } = {},
): Promise<void> {
  const s = stmtInsertBinding({
    id: newBindingId(),
    accountId,
    emailNorm: extra.emailNorm ?? null,
    role,
    scope,
    areas,
    source: extra.source ?? "grant",
    grantedBy: null,
    grantedAt: NOW - 10,
    ...(accountId === null ? { expiresAt: NOW + 3600 } : {}),
  });
  await db.run(s.sql, ...s.params);
}

async function licence(accountId: string, product: string): Promise<void> {
  const { licenseId } = await seedLicenseWithKey(db, product);
  await linkLicense(db, accountId, product, licenseId, "admin", NOW);
  await db.run(
    "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
    accountId,
    product,
    licenseId,
  );
}

/** Whether `token` reads `owner`'s npm feed (list when `deliverable` is null). */
async function reads(
  token: string,
  owner: string,
  deliverable: string | null = null,
): Promise<boolean> {
  forgetRegistryTokens();
  const d = await authorizeFeedRead(
    { db, env, services: ON, nowMs: NOW * 1000 },
    { scheme: "bearer", token },
    owner,
    "npm",
    deliverable,
  );
  return d.ok;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  forgetRegistrySettings();
  forgetRegistryTokens();
  forgetLicenceHolds();
  db = makeTestDb();
  env = makeEnv(new KvMock(), []);
  env.KEY_HASH_PEPPER = "pepper";
  env.REGISTRY_TOKEN_KEY = "registry-token-key-for-tests";
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  env.BLOBS = asR2(new R2Mock());
  await seedOwner(ALPHA);
  await seedOwner(BETA);
  await seedOwner(SYSTEM_PRODUCT_SLUG);
  await db.run(
    "UPDATE products SET system = 1 WHERE slug = ?",
    SYSTEM_PRODUCT_SLUG,
  );
});
afterEach(() => vi.useRealTimers());

describe("personMayRead: product roles", () => {
  it("a product admin narrowed to [ship] reads that product's private and entitled feeds, no licence needed", async () => {
    const ann = await account("ann");
    expect(await reads(ann.token, ALPHA)).toBe(false);
    await bind(ann.id, "product_admin", `product:${ALPHA}`, ["ship"]);
    expect(await reads(ann.token, ALPHA)).toBe(true);
    for (const mode of ["authenticated", "licensed", "entitled"]) {
      await setMode(ALPHA, mode);
      expect(await reads(ann.token, ALPHA, "sdk"), mode).toBe(true);
      expect(await reads(ann.token, ALPHA), mode).toBe(true);
    }
  });

  it("reads only the bound product among customer products (the system feeds are for any console member, below)", async () => {
    const ann = await account("ann");
    await bind(ann.id, "product_admin", `product:${ALPHA}`, ["ship"]);
    expect(await reads(ann.token, BETA)).toBe(false);
  });

  it("a binding narrowed to [keys] (no ship) is refused", async () => {
    const ann = await account("ann");
    await bind(ann.id, "product_admin", `product:${ALPHA}`, ["keys"]);
    expect(await reads(ann.token, ALPHA)).toBe(false);
  });

  it("an unnarrowed product admin reads its product", async () => {
    const ann = await account("ann");
    await bind(ann.id, "product_admin", `product:${ALPHA}`, null);
    expect(await reads(ann.token, ALPHA)).toBe(true);
    expect(await reads(ann.token, BETA)).toBe(false);
  });

  it("products:* reads every customer product", async () => {
    const ann = await account("ann");
    await bind(ann.id, "product_admin", "products:*", null);
    expect(await reads(ann.token, ALPHA)).toBe(true);
    expect(await reads(ann.token, BETA)).toBe(true);
    // Its read of the system feeds is as a console member, not through `products:*`: the product
    // rule alone (`can()` evaluates the system product as the platform) would refuse it.
    const noRole = await account("zed");
    await bind(noRole.id, "console_access", "platform", null);
    expect(await reads(noRole.token, ALPHA)).toBe(false);
  });

  it("a Platform admin or console_access holder reads no customer product", async () => {
    const pa = await account("pa");
    await bind(pa.id, "platform_admin", "platform", null);
    const ca = await account("ca");
    await bind(ca.id, "console_access", "platform", null);
    for (const owner of [ALPHA, BETA]) {
      expect(await reads(pa.token, owner)).toBe(false);
      expect(await reads(ca.token, owner)).toBe(false);
    }
  });

  it("a person with no binding reads nothing new", async () => {
    const dan = await account("dan");
    for (const owner of [ALPHA, BETA, SYSTEM_PRODUCT_SLUG])
      expect(await reads(dan.token, owner)).toBe(false);
    // An invite row for the address is not a grant.
    await bind(null, "product_admin", `product:${ALPHA}`, null, {
      emailNorm: "dan@example.com",
      source: "invite",
    });
    expect(await reads(dan.token, ALPHA)).toBe(false);
  });

  it("another account's binding does not read for this account", async () => {
    const ann = await account("ann");
    const eve = await account("eve");
    await bind(ann.id, "product_admin", `product:${ALPHA}`, ["ship"]);
    expect(await reads(eve.token, ALPHA)).toBe(false);
  });

  it("a deleted binding stops reading on the next request", async () => {
    const ann = await account("ann");
    await bind(ann.id, "product_admin", `product:${ALPHA}`, ["ship"]);
    expect(await reads(ann.token, ALPHA)).toBe(true);
    await db.run(
      "DELETE FROM console_role_bindings WHERE account_id = ?",
      ann.id,
    );
    expect(await reads(ann.token, ALPHA)).toBe(false);
  });
});

describe("personMayRead: the system product", () => {
  it("any console member reads the system feeds", async () => {
    for (const [who, role, scope, areas] of [
      ["pa", "platform_admin", "platform", null],
      ["ca", "console_access", "platform", null],
      ["su", "superadmin", "platform", null],
      ["pr", "product_admin", `product:${ALPHA}`, ["keys"]],
    ] as const) {
      const p = await account(who);
      await bind(p.id, role, scope, areas as AreaId[] | null);
      expect(await reads(p.token, SYSTEM_PRODUCT_SLUG), who).toBe(true);
    }
  });

  it("a licence-only account, and an account with no binding, read nothing of it", async () => {
    const lic = await account("lic");
    await licence(lic.id, SYSTEM_PRODUCT_SLUG).catch(() => undefined);
    expect(await reads(lic.token, SYSTEM_PRODUCT_SLUG)).toBe(false);
    const none = await account("none");
    expect(await reads(none.token, SYSTEM_PRODUCT_SLUG)).toBe(false);
  });

  it("a root-only Superadmin (no stored binding) is not seen here (D-f2)", async () => {
    const root = await account("root");
    expect(await reads(root.token, SYSTEM_PRODUCT_SLUG)).toBe(false);
  });
});

describe("personMayRead: the account must be live", () => {
  it("a disabled account reads nothing through its roles", async () => {
    const ann = await account("ann");
    await bind(ann.id, "product_admin", `product:${ALPHA}`, ["ship"]);
    await bind(ann.id, "platform_admin", "platform", null);
    expect(await reads(ann.token, ALPHA)).toBe(true);
    await db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      ann.id,
    );
    expect(await reads(ann.token, ALPHA)).toBe(false);
    expect(await reads(ann.token, SYSTEM_PRODUCT_SLUG)).toBe(false);
  });

  it("an erased account reads nothing, whatever bindings survive", async () => {
    const ann = await account("ann");
    await bind(ann.id, "product_admin", `product:${ALPHA}`, ["ship"]);
    await db.run(
      "UPDATE accounts SET status = 'deleted', deleted_at = ? WHERE id = ?",
      NOW,
      ann.id,
    );
    expect(await reads(ann.token, ALPHA)).toBe(false);
  });

  it("a binding on a row the reader cannot understand grants nothing", async () => {
    const ann = await account("ann");
    await db.run(
      `INSERT INTO console_role_bindings (id, account_id, role, scope, areas_json, source, granted_at)
       VALUES ('crb_bad', ?, 'product_admin', ?, '["ship","nonsense"]', 'grant', ?)`,
      ann.id,
      `product:${ALPHA}`,
      NOW,
    );
    expect(await reads(ann.token, ALPHA)).toBe(false);
  });
});

describe("personMayRead: the licence path is unchanged", () => {
  it("a licence-only account keeps the old answers", async () => {
    const lic = await account("lic");
    expect(await reads(lic.token, ALPHA)).toBe(false);
    await licence(lic.id, ALPHA);
    expect(await reads(lic.token, ALPHA)).toBe(true);
    expect(await reads(lic.token, BETA)).toBe(false);
    // An entitled deliverable with no flag still admits no licence.
    await setMode(ALPHA, "entitled");
    expect(await reads(lic.token, ALPHA, "sdk")).toBe(false);
  });

  it("a role holder narrowed away from ship falls back to its licence", async () => {
    const ann = await account("ann");
    await bind(ann.id, "product_admin", `product:${ALPHA}`, ["keys"]);
    await licence(ann.id, ALPHA);
    expect(await reads(ann.token, ALPHA)).toBe(true);
  });

  it("public feeds never look at roles", async () => {
    await setMode(ALPHA, "public");
    const d = await authorizeFeedRead(
      { db, env, services: ON, nowMs: NOW * 1000 },
      null,
      ALPHA,
      "npm",
      null,
    );
    expect(d).toEqual({ ok: true, cache: "public" });
  });
});
