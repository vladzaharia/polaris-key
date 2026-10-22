/**
 * F-34.4: the P0-49 job `distribution.feed-access-customers`. A feed at Authenticated or Entitled
 * becomes Customers (`licensed`) and NO principal gains (or loses) a read: `authorizeFeedRead`
 * answers identically before and after the apply for every principal, list and per-deliverable
 * read, feed mode, own-row state and app-row state. Then the runner's properties: a fresh dry run
 * after the apply reports 0 changes, an apply killed after its write resumes as a no-op, and
 * `down` restores every row exactly. The ladder itself is not edited and not asserted here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import {
  authorizeFeedRead,
  forgetLicenceHolds,
  type FeedCredential,
} from "../src/services/distribution/registry/authorize.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import {
  forgetRegistryTokens,
  mintRegistryToken,
} from "../src/core/registry/registryTokens.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { mintAccountToken } from "../src/core/accounts/personalTokens.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import {
  bindServiceRegistry,
  bound,
  migrationJobs,
} from "../src/core/contributions.js";
import { apply, down, dryRun } from "../src/core/migrate/runner.js";
import type {
  MigrationContext,
  MigrationJob,
} from "../src/core/migrate/job.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { SERVICES } from "../src/mount.js";
import { feedAccessCustomersJob } from "../src/services/distribution/feedAccessJob.js";

const OWNER = "acme";
const PKG_ID = "npm.sdk";
const FLAG = "dlc";
const ACTOR = { sub: "op", name: "Op", email: null };
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

interface Who {
  name: string;
  credential: FeedCredential | null;
}
let principals: Who[] = [];

const bearer = (token: string): FeedCredential => ({ scheme: "bearer", token });

async function seedPackage(id = PKG_ID, ecosystem = "npm"): Promise<void> {
  await db.run(
    `INSERT INTO release_deliverables
       (product, deliverable_id, kind, def_source, def_json, created_at, modified_at, ecosystem, package_name)
     VALUES (?, ?, 'package', 'manifest', ?, ?, ?, ?, ?)`,
    OWNER,
    id,
    JSON.stringify({
      kind: "package",
      ecosystem,
      name: ecosystem === "npm" ? `@acme/${id}` : `acme.${id}`,
      artifacts: { files: { match: "*" } },
    }),
    NOW,
    NOW,
    ecosystem,
    id,
  );
}

async function setFeed(
  mode: string,
  ecosystem = "npm",
  ext = "{}",
): Promise<void> {
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes, ext_json, updated_at)
     VALUES (?, ?, 1, ?, '{}', 52428800, ?, ?)
     ON CONFLICT (product, ecosystem) DO UPDATE SET access_mode = excluded.access_mode`,
    OWNER,
    ecosystem,
    mode,
    ext,
    NOW,
  );
}

async function setAccessRow(
  id: string,
  row: { mode: string; entitlement: string | null; source?: string } | null,
): Promise<void> {
  await db.run(
    "DELETE FROM dist_access WHERE product = ? AND deliverable_id = ?",
    OWNER,
    id,
  );
  if (row)
    await db.run(
      `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      OWNER,
      id,
      row.mode,
      row.entitlement,
      row.source ?? "manifest",
      NOW - 100,
    );
}

function caches(): void {
  forgetRegistrySettings();
  forgetRegistryTokens();
  forgetLicenceHolds();
}

/** Every principal x (list, per-deliverable) answer for the current rows. */
async function answers(ecosystem = "npm", id = PKG_ID): Promise<string[]> {
  const out: string[] = [];
  for (const who of principals)
    for (const deliverable of [null, id]) {
      caches();
      const d = await authorizeFeedRead(
        { db, env, services: ON, nowMs: NOW * 1000 },
        who.credential,
        OWNER,
        ecosystem as never,
        deliverable,
      );
      out.push(
        `${who.name}|${deliverable ?? "list"}|${JSON.stringify(
          d.ok
            ? {
                ok: true,
                cache: d.cache,
                kind: "principal" in d ? d.principal.kind : null,
              }
            : d,
        )}`,
      );
    }
  return out;
}

const ctx = (at = NOW): MigrationContext => ({ env, db, now: at });

async function runJob(job: MigrationJob = feedAccessCustomersJob) {
  const report = await dryRun(ctx(), job, ACTOR);
  const applied = await apply(ctx(NOW + 1), job, ACTOR, report.id);
  if (!applied.ok) throw new Error(JSON.stringify(applied));
  return { report, applied };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  caches();
  db = makeTestDb();
  env = makeEnv(new KvMock(), []);
  env.KEY_HASH_PEPPER = "pepper";
  env.REGISTRY_TOKEN_KEY = "registry-token-key-for-tests";
  await seedProduct(db, OWNER);
  await setServices(
    db,
    OWNER,
    serializeServices({ services: ON }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
    OWNER,
    NOW,
  );
  await db.run(
    `INSERT OR IGNORE INTO dist_registry_policy (ecosystem, enabled, max_package_bytes_ceiling)
     VALUES ('npm', 1, 104857600), ('maven', 1, 104857600)`,
  );
  await seedPackage();

  // Licences: one holding the package's flag, one without it, one holding it but expired.
  const holder = await seedLicenseWithKey(db, OWNER, {
    id: "lic_holder",
    entitlements: {
      [FLAG]: { state: "enforced", value: true, updatedAt: NOW },
    },
  });
  const plain = await seedLicenseWithKey(db, OWNER, { id: "lic_plain" });
  const expired = await seedLicenseWithKey(db, OWNER, {
    id: "lic_expired",
    expiresAt: NOW - 1000,
    entitlements: {
      [FLAG]: { state: "enforced", value: true, updatedAt: NOW },
    },
  });
  const licToken = async (licenseId: string) => {
    const r = await mintRegistryToken(
      env,
      db,
      {
        product: OWNER,
        label: "l",
        binding: "license",
        licenseId,
        createdBy: "admin:test",
      },
      NOW,
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    return bearer(r.token);
  };
  const owner = await mintRegistryToken(
    env,
    db,
    { product: OWNER, label: "o", binding: "owner", createdBy: "admin:test" },
    NOW,
  );
  if (!owner.ok) throw new Error(JSON.stringify(owner));
  const ci = await issueStaticCiToken(env, db, {
    product: OWNER,
    scopes: ["release:publish"],
    expiresAt: NOW + 86_400,
    label: "ci",
    createdBy: "admin:test",
    now: NOW,
  });
  const person = async (email: string, licenseId: string | null) => {
    const account = await getOrCreateAccountByEmail(db, email, NOW);
    if (licenseId)
      await linkLicense(db, account.id, OWNER, licenseId, "admin", NOW);
    const t = await mintAccountToken(
      env,
      db,
      {
        accountId: account.id,
        label: "p",
        scope: "packages:read",
        createdBy: `portal:${account.id}`,
      },
      NOW,
    );
    if (!t.ok) throw new Error(JSON.stringify(t));
    return bearer(t.token);
  };
  principals = [
    { name: "anonymous", credential: null },
    { name: "garbage", credential: bearer("pkeyr_nope") },
    { name: "owner", credential: bearer(owner.token) },
    { name: "ci", credential: bearer(ci.token) },
    { name: "license+flag", credential: await licToken(holder.licenseId) },
    { name: "license-noflag", credential: await licToken(plain.licenseId) },
    {
      name: "license-expired+flag",
      credential: await licToken(expired.licenseId),
    },
    {
      name: "person+flag",
      credential: await person("a@example.com", holder.licenseId),
    },
    {
      name: "person-noflag",
      credential: await person("b@example.com", plain.licenseId),
    },
    {
      name: "person-nolicence",
      credential: await person("c@example.com", null),
    },
  ];
});

afterEach(() => {
  vi.useRealTimers();
});

const FEED_MODES = ["public", "authenticated", "licensed", "entitled"] as const;
const OWN_ROWS: [
  string,
  { mode: string; entitlement: string | null } | null,
][] = [
  ["no own row", null],
  ["own public", { mode: "public", entitlement: null }],
  ["own authenticated", { mode: "authenticated", entitlement: null }],
  ["own licensed+flag", { mode: "licensed", entitlement: FLAG }],
  ["own entitled+flag", { mode: "entitled", entitlement: FLAG }],
  ["own entitled no flag", { mode: "entitled", entitlement: null }],
];
const APP_ROWS: [string, { mode: string; entitlement: null } | null][] = [
  ["no app row", null],
  ["app public", { mode: "public", entitlement: null }],
  ["app licensed", { mode: "licensed", entitlement: null }],
  ["app entitled", { mode: "entitled", entitlement: null }],
];

describe("equivalence: no principal gains or loses a read (criterion 2)", () => {
  let cells = 0;
  for (const feed of FEED_MODES)
    for (const [ownLabel, own] of OWN_ROWS)
      for (const [appLabel, app] of APP_ROWS)
        it(`feed ${feed} / ${ownLabel} / ${appLabel}`, async () => {
          await setFeed(feed);
          await setAccessRow(PKG_ID, own);
          await setAccessRow("app", app);
          const before = await answers();
          expect(before).toHaveLength(principals.length * 2);
          const { applied } = await runJob();
          const after = await answers();
          expect(after).toEqual(before);
          // A fresh dry run now has nothing to do.
          expect(
            (await dryRun(ctx(NOW + 2), feedAccessCustomersJob, ACTOR)).changes,
          ).toBe(0);
          const row = await db.first<{ access_mode: string }>(
            "SELECT access_mode FROM dist_registry_feeds WHERE product = ?",
            OWNER,
          );
          expect(row?.access_mode).toBe(
            feed === "authenticated" || feed === "entitled" ? "licensed" : feed,
          );
          if (feed === "public" || feed === "licensed")
            expect(applied.noop || applied.run.changes === 0).toBe(true);
          cells += principals.length * 2;
        });

  it("covered the whole matrix", () => {
    // 4 feed modes x 6 own rows x 4 app rows x 10 principals x 2 reads.
    expect(FEED_MODES.length * OWN_ROWS.length * APP_ROWS.length).toBe(96);
    expect(cells).toBe(96 * 10 * 2);
  });

  it("is not vacuous: the entitled feed really did refuse and admit differently by principal", async () => {
    await setFeed("entitled");
    await setAccessRow(PKG_ID, { mode: "entitled", entitlement: FLAG });
    await setAccessRow("app", { mode: "licensed", entitlement: null });
    const before = await answers();
    await runJob();
    expect(await answers()).toEqual(before);
    const by = (n: string, r: string) =>
      before.find((a) => a.startsWith(`${n}|${r}|`))!;
    expect(by("anonymous", PKG_ID)).toContain('"ok":false');
    expect(by("license+flag", PKG_ID)).toContain('"ok":true');
    expect(by("license-noflag", PKG_ID)).toContain("forbidden");
    expect(by("license-noflag", "list")).toContain('"ok":true');
    expect(by("owner", PKG_ID)).toContain('"ok":true');
  });
});

describe("what the job writes", () => {
  it("claims one own entitled row per package of an entitled feed, keeping a null flag null", async () => {
    await seedPackage("npm.two");
    await setFeed("entitled");
    await setAccessRow("app", { mode: "public", entitlement: null });
    await setAccessRow("npm.two", {
      mode: "licensed",
      entitlement: FLAG,
      source: "manifest",
    });
    await runJob();
    const rows = await db.all<Record<string, unknown>>(
      "SELECT deliverable_id, mode, entitlement, source, modified_at FROM dist_access WHERE product = ? ORDER BY deliverable_id",
      OWNER,
    );
    expect(rows).toEqual([
      {
        deliverable_id: "app",
        mode: "public",
        entitlement: null,
        source: "manifest",
        modified_at: NOW - 100,
      },
      {
        deliverable_id: "npm.sdk",
        mode: "entitled",
        entitlement: null,
        source: "admin",
        modified_at: NOW + 1,
      },
      {
        deliverable_id: "npm.two",
        mode: "entitled",
        entitlement: FLAG,
        source: "admin",
        modified_at: NOW - 100,
      },
    ]);
    const ledger = await db.all<Record<string, unknown>>(
      "SELECT deliverable_id, from_feed_mode, had_row, prior_mode, prior_entitlement, prior_source FROM dist_registry_access_moves ORDER BY deliverable_id",
    );
    expect(ledger).toEqual([
      {
        deliverable_id: "",
        from_feed_mode: "entitled",
        had_row: 1,
        prior_mode: null,
        prior_entitlement: null,
        prior_source: null,
      },
      {
        deliverable_id: "npm.sdk",
        from_feed_mode: "entitled",
        had_row: 0,
        prior_mode: null,
        prior_entitlement: null,
        prior_source: null,
      },
      {
        deliverable_id: "npm.two",
        from_feed_mode: "entitled",
        had_row: 1,
        prior_mode: "licensed",
        prior_entitlement: FLAG,
        prior_source: "manifest",
      },
    ]);
  });

  it("touches only the ledger, dist_access and the feed's access_mode", async () => {
    await setFeed("entitled");
    await setAccessRow("app", { mode: "licensed", entitlement: null });
    const snap = async () => ({
      owners: await db.all("SELECT * FROM dist_registry_owners"),
      policy: await db.all("SELECT * FROM dist_registry_policy"),
      feedCols: await db.all(
        "SELECT product, ecosystem, enabled, namespace_json, max_package_bytes, ext_json, version, updated_at, updated_by FROM dist_registry_feeds",
      ),
      packages: await db.all("SELECT * FROM release_deliverables"),
      licenses: await db.all("SELECT * FROM licenses"),
    });
    const before = await snap();
    await runJob();
    expect(await snap()).toEqual(before);
  });

  it("leaves a disabled feed's strictness too, and a feed of a product with Release off", async () => {
    await db.run(
      "UPDATE products SET services_json = ? WHERE slug = ?",
      serializeServices({ services: { ...ON, release: { enabled: false } } }),
      OWNER,
    );
    await setFeed("entitled");
    await db.run(
      "UPDATE dist_registry_feeds SET enabled = 0 WHERE product = ?",
      OWNER,
    );
    await runJob();
    const row = await db.first<{ access_mode: string }>(
      "SELECT access_mode FROM dist_registry_feeds",
    );
    expect(row?.access_mode).toBe("licensed");
    expect(
      (
        await db.first<{ mode: string }>(
          "SELECT mode FROM dist_access WHERE deliverable_id = ?",
          PKG_ID,
        )
      )?.mode,
    ).toBe("entitled");
  });

  it("refuses to guess when no Release catalog is mounted", async () => {
    await setFeed("entitled");
    const mounted = bound();
    bindServiceRegistry(new Map());
    try {
      await expect(runJob()).rejects.toThrow();
    } finally {
      bindServiceRegistry(mounted);
    }
    expect(
      (
        await db.first<{ access_mode: string }>(
          "SELECT access_mode FROM dist_registry_feeds",
        )
      )?.access_mode,
    ).toBe("entitled");
  });

  it("is a job the registry knows", () => {
    expect(migrationJobs().map((j) => j.id)).toContain(
      "distribution.feed-access-customers",
    );
    expect(SERVICES.get("distribution")?.contributes?.migrations).toContain(
      feedAccessCustomersJob,
    );
  });
});

describe("the dry run report", () => {
  it("lists the formerly entitled feeds, the open-access flip and the Maven stored false", async () => {
    await setFeed("entitled");
    await setFeed(
      "authenticated",
      "maven",
      JSON.stringify({ yankHidesFromIndex: false }),
    );
    await setAccessRow("app", { mode: "public", entitlement: null });
    const report = await dryRun(ctx(), feedAccessCustomersJob, ACTOR);
    expect(report.units.map((u) => u.unit)).toEqual([OWNER]);
    expect(report.units[0]!.detail).toEqual({
      feeds: [
        {
          ecosystem: "maven",
          from: "authenticated",
          to: "licensed",
          enabled: true,
          packages: [],
        },
        {
          ecosystem: "npm",
          from: "entitled",
          to: "licensed",
          enabled: true,
          packages: [
            {
              deliverableId: PKG_ID,
              action: "insert",
              priorMode: null,
              priorSource: null,
            },
          ],
        },
      ],
      formerlyEntitled: ["npm"],
      openAccessTurnsFalse: true,
      mavenYankHidesFalse: ["maven"],
    });
    expect(report.changes).toBe(3);
    // A dry run writes nothing.
    expect(await db.all("SELECT 1 FROM dist_registry_access_moves")).toEqual(
      [],
    );
    expect(
      await db.all(
        "SELECT 1 FROM dist_access WHERE deliverable_id = ?",
        PKG_ID,
      ),
    ).toEqual([]);
  });

  it("reports a Maven stored false even on a feed that is already Customers (zero changes)", async () => {
    await setFeed(
      "licensed",
      "maven",
      JSON.stringify({ yankHidesFromIndex: false }),
    );
    const report = await dryRun(ctx(), feedAccessCustomersJob, ACTOR);
    expect(report.changes).toBe(0);
    expect(report.units[0]).toMatchObject({
      unit: OWNER,
      detail: { mavenYankHidesFalse: ["maven"] },
    });
  });
});

describe("a package declared after the move lands at Customers (decision F4)", () => {
  it("admits a usable licence to the new package, as the Customers default does", async () => {
    await setFeed("entitled");
    await setAccessRow("app", { mode: "public", entitlement: null });
    await runJob();
    await seedPackage("npm.new");
    const after = await answers("npm", "npm.new");
    expect(
      after.find((a) => a.startsWith("license-noflag|npm.new|")),
    ).toContain('"ok":true');
    expect(after.find((a) => a.startsWith("anonymous|npm.new|"))).toContain(
      '"ok":false',
    );
  });
});

describe("runner behaviour", () => {
  it("apply, kill after the write, resume is a no-op", async () => {
    await setFeed("entitled");
    await setAccessRow("app", { mode: "licensed", entitlement: null });
    let killOnce = true;
    const killed: MigrationJob = {
      ...feedAccessCustomersJob,
      apply: async (c, u) => {
        const n = await feedAccessCustomersJob.apply(c, u);
        if (killOnce) {
          killOnce = false;
          throw new Error("killed after the write");
        }
        return n;
      },
    };
    const report = await dryRun(ctx(), killed, ACTOR);
    const first = await apply(ctx(NOW + 1), killed, ACTOR, report.id);
    expect(first.ok && first.run.status).toBe("failed");
    const ledgerAfterKill = await db.all(
      "SELECT * FROM dist_registry_access_moves ORDER BY deliverable_id",
    );
    const rowsAfterKill = await db.all(
      "SELECT * FROM dist_access ORDER BY deliverable_id",
    );
    const feedsAfterKill = await db.all("SELECT * FROM dist_registry_feeds");

    const resumed = await apply(ctx(NOW + 2), killed, ACTOR, report.id);
    expect(resumed.ok && resumed.run.status).toBe("applied");
    // The resumed unit wrote nothing: every row is as the killed call left it.
    expect(
      await db.all(
        "SELECT * FROM dist_registry_access_moves ORDER BY deliverable_id",
      ),
    ).toEqual(ledgerAfterKill);
    expect(
      await db.all("SELECT * FROM dist_access ORDER BY deliverable_id"),
    ).toEqual(rowsAfterKill);
    expect(await db.all("SELECT * FROM dist_registry_feeds")).toEqual(
      feedsAfterKill,
    );
    expect((await dryRun(ctx(NOW + 3), killed, ACTOR)).changes).toBe(0);
  });

  it("a second apply of a finished report is a no-op", async () => {
    await setFeed("entitled");
    const { report } = await runJob();
    const again = await apply(
      ctx(NOW + 5),
      feedAccessCustomersJob,
      ACTOR,
      report.id,
    );
    expect(again.ok && again.noop).toBe(true);
  });

  it("down restores every access and feed row byte for byte", async () => {
    await seedPackage("npm.two");
    await seedPackage("mvn.one", "maven");
    await setFeed("entitled");
    await setFeed("authenticated", "maven");
    await setAccessRow("app", {
      mode: "licensed",
      entitlement: null,
      source: "admin",
    });
    await setAccessRow("npm.two", {
      mode: "public",
      entitlement: FLAG,
      source: "manifest",
    });
    const snap = async () => ({
      access: await db.all("SELECT * FROM dist_access ORDER BY deliverable_id"),
      feeds: await db.all(
        "SELECT * FROM dist_registry_feeds ORDER BY ecosystem",
      ),
    });
    const before = await snap();
    const { applied } = await runJob();
    const during = await snap();
    expect(during).not.toEqual(before);
    const d = await down(
      ctx(NOW + 9),
      feedAccessCustomersJob,
      ACTOR,
      applied.run.id,
    );
    expect(d.ok && d.run.status).toBe("reverted");
    expect(await snap()).toEqual(before);
    expect(await db.all("SELECT * FROM dist_registry_access_moves")).toEqual(
      [],
    );
  });

  it("down leaves a row an operator changed since the apply", async () => {
    await setFeed("entitled");
    const { applied } = await runJob();
    await setFeed("public");
    await db.run(
      "UPDATE dist_access SET entitlement = ? WHERE product = ? AND deliverable_id = ?",
      FLAG,
      OWNER,
      PKG_ID,
    );
    await down(ctx(NOW + 9), feedAccessCustomersJob, ACTOR, applied.run.id);
    expect(
      (
        await db.first<{ access_mode: string }>(
          "SELECT access_mode FROM dist_registry_feeds",
        )
      )?.access_mode,
    ).toBe("public");
    expect(
      (
        await db.first<{ entitlement: string }>(
          "SELECT entitlement FROM dist_access WHERE deliverable_id = ?",
          PKG_ID,
        )
      )?.entitlement,
    ).toBe(FLAG);
  });
});
