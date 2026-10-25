/**
 * LX-33.2: the implicit Default tier is invisible.
 *
 * A licence on the product's implicit tier (`tiers.implicit = 1`) renders exactly the bytes a
 * licence with `tier_id` NULL renders today, on every device and customer surface. Driven through
 * the real handlers with a fixed `now` and the test signing key, so the signed documents compare
 * byte for byte. A non-implicit tier with the same values is the negative control.
 */
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  DJDL_CATALOG,
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
  setPortalToggles,
} from "../seed.js";
import type { Env } from "../../src/platform/env.js";
import type { SqliteDb } from "../../src/db/sqlite.js";
import { matchRoute } from "../../src/router.js";
import { dispatchService } from "../../src/core/registry.js";
import { loadProduct, type Product } from "../../src/core/products.js";
import { SERVICES, SETTINGS } from "../../src/mount.js";
import {
  handleBrowserSession,
  handleBrowserSessionLicense,
} from "../../src/services/identity/browserSession.js";
import { licenseDeviceLimit } from "../../src/core/licensing/authz.js";
import { getLicense, getTier } from "../../src/core/licensing/store.js";
import { upgradedTier } from "../../src/core/licensing/issue.js";
import {
  customerTierId,
  customerTierOf,
  isImplicitTier,
} from "../../src/core/licensing/implicitTier.js";
import { legacyLicenseChoices } from "../../src/services/identity/licenseChoice.js";
import { licenseConsentItem } from "../../src/services/identity/passthrough/anchor.js";
import { libraryView } from "../../src/services/identity/portal/library.js";
import { shapeLicenseSummary } from "../../src/services/identity/portal/api.js";
import {
  insertAccount,
  insertLink,
} from "../../src/services/identity/accounts/repo.js";
import { listPortalLicenses } from "../../src/services/identity/portal/repo.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TEST_ROOT } from "../paths.js";

const SLUG = "djdl";
const IMPLICIT = "default";
const OTHER = "pro";

interface World {
  db: SqliteDb;
  env: Env;
  product: Product;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  await seedProduct(db, SLUG, { catalog: DJDL_CATALOG });
  // The implicit Default tier holds the product's defaults (5 devices, 30 offline days) and
  // nothing else. A second, ordinary tier carries the same values for the negative control.
  await seedTier(db, SLUG, IMPLICIT, { deviceLimit: 5 });
  await db.run(
    "UPDATE tiers SET label = 'Default', implicit = 1, policy_offline_grace_days = 30 WHERE product = ? AND id = ?",
    SLUG,
    IMPLICIT,
  );
  await seedTier(db, SLUG, OTHER, { deviceLimit: 5 });
  await db.run(
    "UPDATE tiers SET label = 'Pro', policy_offline_grace_days = 30 WHERE product = ? AND id = ?",
    SLUG,
    OTHER,
  );
  return { db, env, product: (await loadProduct(env, db, SLUG))! };
}

async function call(
  w: World,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const route = matchRoute(path);
  if (route.kind !== "service") throw new Error(`not a service route: ${path}`);
  return dispatchService(SERVICES, route.slug, w.product.services, {
    req: mkReq(init.method ?? "GET", init.headers ?? {}),
    env: w.env,
    db: w.db,
    product: w.product,
    rest: route.rest,
    now: NOW,
  });
}

interface LicenceShape {
  name: string;
  channels?: string[];
  minVersion?: string;
  maxVersion?: string;
  deviceLimit?: number;
  maxOfflineDays?: number;
  /** A merged `deviceLimit` entitlement (a licence override). */
  entitlementDeviceLimit?: number;
}

const SHAPES: LicenceShape[] = [
  { name: "plain" },
  { name: "channels", channels: ["beta"] },
  { name: "versions", minVersion: "1.2.0", maxVersion: "3.0.0" },
  { name: "own-limit", deviceLimit: 3, maxOfflineDays: 7 },
  { name: "entitlement-limit", entitlementDeviceLimit: 2 },
  {
    name: "everything",
    channels: ["beta", "dev"],
    minVersion: "1.0.0",
    maxVersion: "2.0.0",
    deviceLimit: 4,
    maxOfflineDays: 14,
  },
];

/** Seed the licence on `tierId`, activate a device, and return every device-visible byte. */
async function render(shape: LicenceShape, tierId: string | null) {
  const w = await world();
  const { licenseId, key } = await seedLicenseWithKey(w.db, SLUG, {
    id: "lic_1",
    tierId,
    channels: shape.channels,
    minVersion: shape.minVersion ?? null,
    maxVersion: shape.maxVersion ?? null,
    entitlements:
      shape.entitlementDeviceLimit === undefined
        ? undefined
        : {
            deviceLimit: {
              state: "enforced",
              value: shape.entitlementDeviceLimit,
              updatedAt: NOW,
            },
          },
  });
  await w.db.run(
    "UPDATE licenses SET device_limit = ?, max_offline_days = ? WHERE product = ? AND id = ?",
    shape.deviceLimit ?? null,
    shape.maxOfflineDays ?? null,
    SLUG,
    licenseId,
  );
  const activate = await call(w, `/${SLUG}/license/activate`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "x-pkey-device": "dev-1" },
  });
  expect(activate.status).toBe(200);
  const activation = (await activate.json()) as {
    token: string;
    license: Record<string, unknown>;
  };
  const headers = {
    authorization: `Bearer ${activation.token}`,
    "x-pkey-version": "1.5.0",
  };
  const licenceDoc = await (
    await call(w, `/${SLUG}/license/document`, { headers })
  ).text();
  const configDoc = await (
    await call(w, `/${SLUG}/config/document`, { headers })
  ).text();

  const login = await handleBrowserSessionLicense(
    new Request(`https://key.plrs.im/${SLUG}/identity/session/license`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    }) as unknown as Request,
    w.env,
    w.db,
    w.product,
    NOW,
    SETTINGS,
  );
  expect(login.status).toBe(201);
  const session = await (
    await handleBrowserSession(
      new Request(`https://key.plrs.im/${SLUG}/identity/session`, {
        headers: { cookie: login.headers.get("set-cookie")! },
      }) as unknown as Request,
      w.env,
      w.db,
      w.product,
      NOW,
      SETTINGS,
    )
  ).text();

  const row = (await getLicense(w.db, SLUG, licenseId))!;
  const limit = await licenseDeviceLimit(w.db, w.product, row, NOW);
  return {
    activation: activation.license,
    licenceDoc,
    configDoc,
    // The CSRF token is random per login; everything else is the signed document.
    session: session.replace(/"csrfToken":"[^"]*"/, '"csrfToken":"-"'),
    limit,
  };
}

describe("an implicit-tier licence renders as a tierless one", () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: licence document, config document, browser session, activation and seat limit are byte-identical`, async () => {
      const tierless = await render(shape, null);
      const implicit = await render(shape, IMPLICIT);
      expect(implicit.licenceDoc).toBe(tierless.licenceDoc);
      expect(implicit.configDoc).toBe(tierless.configDoc);
      expect(implicit.session).toBe(tierless.session);
      expect(implicit.limit).toBe(tierless.limit);
      expect(implicit.activation).toEqual(tierless.activation);
      expect(implicit.activation["tierId"]).toBeNull();
    });
  }

  it("the matrix is meaningful: an entitlement limit and an own limit reach the seat limit", async () => {
    const ent = await render(
      SHAPES.find((s) => s.name === "entitlement-limit")!,
      IMPLICIT,
    );
    expect(ent.limit).toBe(2); // not the implicit tier's 5
    const own = await render(
      SHAPES.find((s) => s.name === "own-limit")!,
      IMPLICIT,
    );
    expect(own.limit).toBe(3);
  });

  it("negative control: the same values on a non-implicit tier do change the licence document", async () => {
    const shape = SHAPES[0]!;
    const tierless = await render(shape, null);
    const pro = await render(shape, OTHER);
    expect(pro.licenceDoc).not.toBe(tierless.licenceDoc);
    expect(pro.activation["tierId"]).toBe(OTHER);
  });
});

describe("customer surfaces answer a null tier for the implicit tier", () => {
  async function accountWorld(tierId: string | null) {
    const w = await world();
    await setPortalToggles(w.db, SLUG, { portalEnabled: true });
    await seedLicenseWithKey(w.db, SLUG, { id: "lic_1", tierId });
    const account = await insertAccount(
      w.db,
      {
        primaryEmail: "ada@example.com",
        primaryEmailVerified: true,
        displayName: "Ada",
      },
      NOW,
    );
    await insertLink(
      w.db,
      account.id,
      {
        issuerKey: "https://idp.example",
        tenantScope: "",
        subject: "sub-1",
        kind: "oidc",
        email: "ada@example.com",
        emailVerified: true,
        displayName: "Ada",
        amr: null,
      },
      NOW,
    );
    await w.db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = 'lic_1'",
      account.id,
      SLUG,
    );
    return { w, accountId: account.id };
  }

  it("the library, the licence summary, the consent line and LicenseChoice", async () => {
    const out: Record<string, unknown>[] = [];
    for (const tierId of [null, IMPLICIT]) {
      const { w, accountId } = await accountWorld(tierId);
      const lib = await libraryView(w.env, w.db, accountId, NOW, undefined);
      const rows = await listPortalLicenses(w.db, accountId);
      const summary = await shapeLicenseSummary(w.db, rows[0]!, NOW);
      const consent = await licenseConsentItem(w.db, accountId, w.product, NOW);
      const choice = await legacyLicenseChoices(w.db, w.product, {
        accountId,
        sub: "sub-1",
        deviceId: "dev-new",
        grantTierId: null,
        origin: "https://keys.example",
        deviceLabel: "Mac",
        now: NOW,
      });
      out.push({
        lib: (lib.products[0]!["license"] as Record<string, unknown>)["tier"],
        summaryTier: summary["tier"],
        consent: consent.anchor,
        choice: choice.rows.map((r) => r.tierName),
      });
    }
    expect(out[1]).toEqual(out[0]);
    expect(out[1]!["lib"]).toBeNull();
    expect(out[1]!["summaryTier"]).toBeNull();
    expect((out[1]!["consent"] as { tierName: unknown }).tierName).toBeNull();
    expect(out[1]!["choice"]).toEqual(["License"]);
  });

  it("negative control: a non-implicit tier is shown", async () => {
    const { w, accountId } = await accountWorld(OTHER);
    const lib = await libraryView(w.env, w.db, accountId, NOW, undefined);
    expect((lib.products[0]!["license"] as { tier: unknown }).tier).toBe(OTHER);
    const consent = await licenseConsentItem(w.db, accountId, w.product, NOW);
    expect(consent.anchor?.tierName).toBe("Pro");
  });

  it("the helper: implicit and absent read as no tier; a dangling id keeps its id", async () => {
    const w = await world();
    const implicit = await getTier(w.db, SLUG, IMPLICIT);
    const pro = await getTier(w.db, SLUG, OTHER);
    expect(isImplicitTier(implicit)).toBe(true);
    expect(isImplicitTier(pro)).toBe(false);
    expect(customerTierOf({ tier_id: IMPLICIT }, implicit)).toBeNull();
    expect(customerTierOf({ tier_id: null }, null)).toBeNull();
    expect(customerTierOf({ tier_id: OTHER }, pro)).toEqual({
      id: OTHER,
      label: "Pro",
    });
    expect(customerTierOf({ tier_id: "gone" }, null)).toEqual({
      id: "gone",
      label: null,
    });
    expect(
      await customerTierId(w.db, { product: SLUG, tier_id: IMPLICIT }),
    ).toBeNull();
    expect(await customerTierId(w.db, { product: SLUG, tier_id: OTHER })).toBe(
      OTHER,
    );
  });
});

describe("syncTierOnSignIn leaves an implicit-tier licence alone", () => {
  it("never upgrades off the implicit tier, as for a tierless licence; upgrades off an ordinary one", async () => {
    const w = await world();
    await seedTier(w.db, SLUG, "gold");
    await w.db.run(
      "UPDATE tiers SET rank = 5 WHERE product = ? AND id = 'gold'",
      SLUG,
    );
    await w.db.run(
      "UPDATE tiers SET rank = 1 WHERE product = ? AND id = ?",
      SLUG,
      OTHER,
    );
    const reader = async () => "upgradeOnly";
    const mk = async (id: string, tierId: string | null) => {
      await seedLicenseWithKey(w.db, SLUG, { id, tierId });
      return (await getLicense(w.db, SLUG, id))!;
    };
    const args = (l: Awaited<ReturnType<typeof mk>>) =>
      upgradedTier(w.db, w.product, l, "gold", reader);
    expect(await args(await mk("l_none", null))).toBeNull();
    expect(await args(await mk("l_impl", IMPLICIT))).toBeNull();
    expect((await args(await mk("l_pro", OTHER)))?.id).toBe("gold");
  });
});

describe("source scan: customer answers read a tier only through the helper", () => {
  const SRC = join(TEST_ROOT, "..", "src");
  function walk(dir: string, out: string[] = []): string[] {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }
  // Each pattern is a way a customer answer could carry the raw tier.
  const STRAYS = [
    /\btier:\s*(?:l\.row|row|license|l)\.tier_id\b/,
    /\btierId:\s*(?:l|license)\.tier_id\b/,
    /\btier\?\.label\b/,
  ];
  const files = walk(join(SRC, "services", "identity"));

  it("services/identity has no raw tier in an answer", () => {
    const hits: string[] = [];
    for (const f of files) {
      // Operator-facing (the console's user detail, which may show "Default") or the store
      // policy's chosen tier, never a licence's tier in a customer answer.
      if (/accounts[\\/]productUsers\.ts$|store[\\/]obtain\.ts$/.test(f))
        continue;
      const text = readFileSync(f, "utf8");
      for (const re of STRAYS) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it("negative control: the scan catches the old shapes", () => {
    expect(STRAYS[0]!.test("tier: license.tier_id,")).toBe(true);
    expect(STRAYS[2]!.test("tierName: tier?.label ?? null")).toBe(true);
  });

  it("every identity file that imports getTier also imports the helper", () => {
    const bad = files.filter((f) => {
      const t = readFileSync(f, "utf8");
      return /\bgetTier\b/.test(t) && !/implicitTier\.js/.test(t);
    });
    // store/ reads the purchase policy's chosen tier, never a licence's tier; named, not skipped.
    expect(bad.map((f) => f.slice(SRC.length))).toEqual([
      "/services/identity/portal/store/obtain.ts",
      "/services/identity/portal/store/panelStatus.ts",
    ]);
  });
});
