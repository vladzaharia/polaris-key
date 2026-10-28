/**
 * P0-19 (CQW-05): descriptor contributions replace the module-load registries.
 *
 *   1. No side-effect registration remains: no service module registers itself by being
 *      imported, and the three retired registrars are gone from `src/`.
 *   2. Every enabled service answers an integration contribution (ST-40's input), and a service
 *      that is off is absent from the answer.
 *   3. `mount.ts` binds the table, and what the descriptors contribute is what Core runs.
 *   4. A new-authorization listener runs only while its service is enabled for the product.
 *   5. `serviceContext()` builds each kind's members and no others.
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import { SRC, stripComments, walkTs } from "../srcScan.js";
import { SERVICES } from "../../src/mount.js";
import {
  contributedAuthorizationListeners,
  contributedLicenseHolders,
  contributedSubjectStores,
  integrationContributions,
  maintenanceContributions,
  productDeletionStatements,
} from "../../src/core/contributions.js";
import { serviceContext } from "../../src/core/registry.js";
import { loadProduct } from "../../src/core/products.js";
import { SERVICE_SLUGS, type ServicesMap } from "../../src/core/services.js";
import { subjectStoreNames } from "../../src/core/accounts/subjectHooks.js";

const rel = (abs: string) => relative(SRC, abs).split("\\").join("/");
const sources = () =>
  walkTs(SRC).map((abs) => ({
    file: rel(abs),
    code: stripComments(readFileSync(abs, "utf8")),
  }));

const allOn = (): ServicesMap =>
  Object.fromEntries(
    SERVICE_SLUGS.map((s) => [s, { enabled: true }]),
  ) as ServicesMap;

describe("no side-effect registration (P0-19)", () => {
  it('has no bare `import "../x.js"` in a service', () => {
    const bad = sources()
      .filter((s) => s.file.startsWith("services/"))
      .filter((s) => /^\s*import\s+["']\.{1,2}\//m.test(s.code))
      .map((s) => s.file);
    expect(bad).toEqual([]);
  });

  it("has retired the three module-load registrars", () => {
    const names = [
      "registerLicenseHolderHooks",
      "registerAuthorizationListener",
    ];
    const hits = sources()
      .filter((s) => names.some((n) => s.code.includes(n)))
      .map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it("calls registerSubjectStore nowhere in src/ but its own module (a test fixture hook)", () => {
    const hits = sources()
      .filter((s) => s.code.includes("registerSubjectStore("))
      .map((s) => s.file);
    expect(hits).toEqual(["core/accounts/subjectHooks.ts"]);
  });
});

describe("what the descriptors contribute", () => {
  it("is bound by mount.ts: stores, holder hooks, maintenance and deletion are all there", () => {
    expect(contributedSubjectStores().map(([n]) => n)).toEqual([
      "config.accountOverrides",
      "sync.cloudSync",
      "connect.rings",
    ]);
    // Core's own store is listed beside the contributed one.
    expect(subjectStoreNames()).toEqual([
      "config.accountOverrides",
      "connect.rings",
      "core.entitlementEvents",
      "core.keyring",
      "core.provisionedSecretMoves",
      "sync.cloudSync",
    ]);
    expect(contributedLicenseHolders()).not.toBeNull();
    expect(maintenanceContributions().length).toBeGreaterThanOrEqual(3);
    const stmts = productDeletionStatements("p", NOW).map((s) => s.sql);
    for (const table of [
      "licenses",
      "account_product_subjects",
      "account_overrides",
      "dist_registry_owners",
    ])
      expect(
        stmts.some((q) => q.includes(table)),
        table,
      ).toBe(true);
  });

  it("runs an authorization listener only while its service is enabled", () => {
    expect(contributedAuthorizationListeners(allOn())).toHaveLength(1);
    const identityOff = { ...allOn(), identity: { enabled: false } };
    expect(contributedAuthorizationListeners(identityOff)).toHaveLength(0);
  });
});

describe("integration contributions (consumed by ST-40)", () => {
  it("every enabled service answers prerequisites and facts", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    await seedProduct(db, "p1");
    const product = (await loadProduct(env, db, "p1"))!;
    const services = allOn();
    const hooks = serviceContext("host", SERVICES, services, {
      env,
      db,
      product,
      now: NOW,
    }).hooks;
    const out = await integrationContributions(
      SERVICES,
      services,
      { env, db, product, now: NOW },
      hooks,
    );
    for (const slug of SERVICE_SLUGS) {
      const c = out[slug];
      expect(c, `${slug} should answer`).toBeTruthy();
      expect(Array.isArray(c!.prerequisites)).toBe(true);
      expect(typeof c!.facts).toBe("object");
    }
    // A fresh product has no tiers, no catalog and no releases.
    expect(out.license!.prerequisites).toEqual([{ id: "tiers", met: false }]);
    expect(out.license!.facts.licenses).toBe(0);
    expect(out.release!.facts.releases).toBe(0);
  });

  it("omits a service that is off for the product", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    await seedProduct(db, "p2");
    const product = (await loadProduct(env, db, "p2"))!;
    const services = { ...allOn(), license: { enabled: false } };
    const hooks = serviceContext("host", SERVICES, services, {
      env,
      db,
      product,
      now: NOW,
    }).hooks;
    const out = await integrationContributions(
      SERVICES,
      services,
      { env, db, product, now: NOW },
      hooks,
    );
    expect(out.license).toBeUndefined();
    expect(out.config).toBeTruthy();
  });
});

describe("serviceContext()", () => {
  it("builds each kind's members and no others", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    await seedProduct(db, "p3");
    const product = (await loadProduct(env, db, "p3"))!;
    const base = { env, db, product, now: NOW };
    const keys = (kind: "request" | "admin" | "scheduled" | "host") =>
      Object.keys(serviceContext(kind, SERVICES, allOn(), base)).sort();
    expect(keys("request")).toEqual(
      ["hooks", "ingest", "licenseMerge", "settings", "storeGrants"].sort(),
    );
    expect(keys("admin")).toEqual(
      ["hooks", "ingest", "licenseDelete", "settings"].sort(),
    );
    expect(keys("scheduled")).toEqual(["hooks", "storeGrants"]);
    expect(keys("host")).toEqual(["hooks"]);
  });
});
