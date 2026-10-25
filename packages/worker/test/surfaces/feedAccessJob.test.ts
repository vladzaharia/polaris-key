/**
 * F-34.4: the P0-49 job `distribution.feed-access-customers`. A feed at Authenticated or Entitled
 * becomes Customers (`licensed`) and NO principal gains (or loses) a read: `authorizeFeedRead`
 * answers identically before and after the apply for every principal, list and per-deliverable
 * read, feed mode, own-row state and app-row state. Then the runner's properties: a fresh dry run
 * after the apply reports 0 changes, an apply killed after its write resumes as a no-op, and
 * `down` restores every row exactly. The ladder itself is not edited and not asserted here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "../seed.js";
import {
  authorizeFeedRead,
  forgetLicenceHolds,
  type FeedCredential,
} from "../../src/services/distribution/registry/authorize.js";
import { forgetRegistrySettings } from "../../src/services/distribution/registry/settings.js";
import {
  forgetRegistryTokens,
  mintRegistryToken,
} from "../../src/core/registry/registryTokens.js";
import { issueStaticCiToken } from "../../src/core/publisher.js";
import { mintAccountToken } from "../../src/core/accounts/personalTokens.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../../src/services/identity/portal/repo.js";
import {
  serializeServices,
  type ServicesMap,
} from "../../src/core/services.js";
import { setServices } from "../../src/core/products/store.js";
import {
  bindServiceRegistry,
  bound,
  migrationJobs,
} from "../../src/core/contributions.js";
import { apply, down, dryRun } from "../../src/core/migrate/runner.js";
import type {
  MigrationContext,
  MigrationJob,
} from "../../src/core/migrate/job.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { SERVICES } from "../../src/mount.js";
import {
  feedAccessCustomersJob,
  PHASE_GAP_SECONDS,
} from "../../src/services/distribution/feedAccessJob.js";

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

/**
 * Apply as an operator does: the first call writes the package rows and stops with a retryable
 * failure while an entitled feed waits out the cache window; the same report, a window later,
 * finishes it.
 */
async function runJob(job: MigrationJob = feedAccessCustomersJob) {
  const report = await dryRun(ctx(), job, ACTOR);
  let applied = await apply(ctx(NOW + 1), job, ACTOR, report.id);
  if (applied.ok && applied.run.status === "failed")
    applied = await apply(
      ctx(NOW + 1 + PHASE_GAP_SECONDS),
      job,
      ACTOR,
      report.id,
    );
  if (!applied.ok) throw new Error(JSON.stringify(applied));
  return { report, applied };
}

/** Down the same way: the feeds first, the package rows a window later. */
async function runDown(applyId: string, at = NOW + 9) {
  let d = await down(ctx(at), feedAccessCustomersJob, ACTOR, applyId);
  if (d.ok && d.run.status === "failed")
    d = await down(
      ctx(at + PHASE_GAP_SECONDS),
      feedAccessCustomersJob,
      ACTOR,
      applyId,
    );
  return d;
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
    {
      product: OWNER,
      label: "o",
      binding: "owner",
      // F-33b.3: an owner-wide READ token is retired; an owner-bound credential is a publish one.
      scopes: ["publish"],
      ecosystems: ["npm"],
      createdBy: "admin:test",
    },
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
      apply: async (c, u, r) => {
        const n = await feedAccessCustomersJob.apply(c, u, r);
        if (killOnce) {
          killOnce = false;
          throw new Error("killed after the write");
        }
        return n;
      },
    };
    const report = await dryRun(ctx(), killed, ACTOR);
    // The first call waits out the cache window; the second finishes the unit and is killed
    // just after its write.
    const waited = await apply(ctx(NOW + 1), killed, ACTOR, report.id);
    expect(waited.ok && waited.run.units[0]?.error).toBe(
      "registry_cache_window",
    );
    const T = NOW + 1 + PHASE_GAP_SECONDS;
    const first = await apply(ctx(T), killed, ACTOR, report.id);
    expect(first.ok && first.run.status).toBe("failed");
    const ledgerAfterKill = await db.all(
      "SELECT * FROM dist_registry_access_moves ORDER BY deliverable_id",
    );
    const rowsAfterKill = await db.all(
      "SELECT * FROM dist_access ORDER BY deliverable_id",
    );
    const feedsAfterKill = await db.all("SELECT * FROM dist_registry_feeds");

    const resumed = await apply(ctx(T + 1), killed, ACTOR, report.id);
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
    expect((await dryRun(ctx(T + 2), killed, ACTOR)).changes).toBe(0);
    // The resumed unit still answers its ledger, so `down` can undo it.
    expect(resumed.ok && resumed.run.units[0]?.changes).toBeGreaterThan(0);
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
    const d = await runDown(applied.run.id);
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
    await runDown(applied.run.id);
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

// ---------------------------------------------------------------------------------------------
// The security fix round (REV-F34-4): the cache window (B1), down never widening (B2), the batch
// re-checking a "keep" row (B3), and the apply naming a feed the report did not list.
// ---------------------------------------------------------------------------------------------

const GAP = PHASE_GAP_SECONDS;
const admitted = (a: string): boolean => a.includes('"ok":true');
const named = (all: string[], who: string, id: string | null): string =>
  all.find((a) => a.startsWith(`${who}|${id ?? "list"}|`)) ?? "";

/** A read with the isolate's settings caches left warm (the production shape). */
async function warmRead(who: string, tSec: number, id: string | null) {
  const credential = principals.find((p) => p.name === who)?.credential ?? null;
  return authorizeFeedRead(
    { db, env, services: ON, nowMs: (NOW + tSec) * 1000 },
    credential,
    OWNER,
    "npm",
    id,
  );
}

/** No principal admitted after that was not admitted before: the one claim of `down`. */
function notWider(before: string[], after: string[]): void {
  expect(after.length).toBe(before.length);
  after.forEach((a, i) => {
    if (admitted(a)) expect(before[i]).toSatisfy(admitted);
  });
}

const feedMode = async (eco = "npm") =>
  (
    await db.first<{ access_mode: string }>(
      "SELECT access_mode FROM dist_registry_feeds WHERE ecosystem = ?",
      eco,
    )
  )?.access_mode;
const ownRow = (id = PKG_ID) =>
  db.first<{ mode: string; source: string }>(
    "SELECT mode, source FROM dist_access WHERE deliverable_id = ?",
    id,
  );

describe("B1: the feed and its packages never change in one cache window", () => {
  it("apply: rows first, the feed only a window later; a warm cache never admits a licence without the flag", async () => {
    await setFeed("entitled");
    await setAccessRow("app", { mode: "public", entitlement: null });
    // Warm this isolate's caches the way traffic does: the feed row, the package's mode.
    expect((await warmRead("license-noflag", 0, null)).ok).toBe(true);
    expect((await warmRead("license-noflag", 10, PKG_ID)).ok).toBe(false);
    const report = await dryRun(ctx(NOW + 14), feedAccessCustomersJob, ACTOR);
    const T = NOW + 15;
    const first = await apply(ctx(T), feedAccessCustomersJob, ACTOR, report.id);
    expect(first.ok && first.run.units[0]?.error).toBe("registry_cache_window");
    // Phase A: the package row is there, the feed has not moved.
    expect(await ownRow()).toEqual({ mode: "entitled", source: "admin" });
    expect(await feedMode()).toBe("entitled");
    // Every call inside the window waits and changes nothing, however often it is retried.
    for (const at of [T + 1, T + 10, T + GAP - 1]) {
      const r = await apply(ctx(at), feedAccessCustomersJob, ACTOR, report.id);
      expect(r.ok && r.run.units[0]?.error).toBe("registry_cache_window");
      expect(await feedMode()).toBe("entitled");
    }
    // At no sampled moment is the licence without the flag let in, caches warm throughout.
    for (const t of [16, 31, 41, 50])
      expect((await warmRead("license-noflag", t, PKG_ID)).ok).toBe(false);
    const done = await apply(
      ctx(T + GAP),
      feedAccessCustomersJob,
      ACTOR,
      report.id,
    );
    expect(done.ok && done.run.status).toBe("applied");
    expect(await feedMode()).toBe("licensed");
    for (const t of [T + GAP - NOW + 1, T + GAP - NOW + 40]) {
      expect((await warmRead("license-noflag", t, PKG_ID)).ok).toBe(false);
    }
  });

  it("apply: the feed update is refused inside the window even if the unit is applied again at once", async () => {
    await setFeed("entitled");
    const report = await dryRun(ctx(), feedAccessCustomersJob, ACTOR);
    await apply(ctx(NOW + 1), feedAccessCustomersJob, ACTOR, report.id);
    // Straight to the statements: the guard, not the caller's clock, is what holds the feed.
    await db.run(
      "UPDATE dist_registry_access_moves SET moved_at = ? WHERE deliverable_id <> ''",
      NOW + 1,
    );
    const again = await apply(
      ctx(NOW + GAP),
      feedAccessCustomersJob,
      ACTOR,
      report.id,
    );
    expect(again.ok && again.run.units[0]?.error).toBe("registry_cache_window");
    expect(await feedMode()).toBe("entitled");
  });

  it("authenticated -> licensed is one row and needs no window", async () => {
    await setFeed("authenticated");
    const report = await dryRun(ctx(), feedAccessCustomersJob, ACTOR);
    const r = await apply(
      ctx(NOW + 1),
      feedAccessCustomersJob,
      ACTOR,
      report.id,
    );
    expect(r.ok && r.run.status).toBe("applied");
    expect(await feedMode()).toBe("licensed");
  });

  it("down: the feed first, the package rows a window later, never the other way", async () => {
    await setFeed("entitled");
    await setAccessRow("app", { mode: "public", entitlement: null });
    const before = await answers();
    const { applied } = await runJob();
    expect(applied.ok && applied.run.id).toBeTruthy();
    const applyId = applied.ok ? applied.run.id : "";
    const T = NOW + 200;
    const first = await down(ctx(T), feedAccessCustomersJob, ACTOR, applyId);
    expect(first.ok && first.run.units[0]?.error).toBe("registry_cache_window");
    // Phase 1 done: the feed is back to entitled; the rows are still in place.
    expect(await feedMode()).toBe("entitled");
    expect(await ownRow()).toEqual({ mode: "entitled", source: "admin" });
    expect((await warmRead("license-noflag", T - NOW, PKG_ID)).ok).toBe(false);
    for (const at of [T + 1, T + GAP - 1]) {
      const r = await down(ctx(at), feedAccessCustomersJob, ACTOR, applyId);
      expect(r.ok && r.run.units[0]?.error).toBe("registry_cache_window");
      expect(await ownRow()).toEqual({ mode: "entitled", source: "admin" });
    }
    const done = await down(
      ctx(T + GAP),
      feedAccessCustomersJob,
      ACTOR,
      applyId,
    );
    expect(done.ok && done.run.status).toBe("reverted");
    expect(await ownRow()).toBeNull();
    expect(await answers()).toEqual(before);
    expect(await db.all("SELECT * FROM dist_registry_access_moves")).toEqual(
      [],
    );
  });
});

describe("B2: down never leaves access wider than before the apply", () => {
  it("P2: the operator set Public after the apply; down leaves the package rows (narrower) and says so", async () => {
    await setFeed("entitled");
    await setAccessRow("app", { mode: "public", entitlement: null });
    const preApply = await answers();
    const { applied } = await runJob();
    if (!applied.ok) throw new Error("apply");
    await setFeed("public"); // the operator's later choice
    const preDown = await answers();
    const d = await runDown(applied.run.id);
    expect(d.ok && d.run.status).toBe("reverted");
    const postDown = await answers();
    // The operator's Public is theirs; what down must not add is anything beyond it.
    notWider(preDown, postDown);
    expect(named(preApply, "anonymous", PKG_ID)).not.toSatisfy(admitted);
    expect(named(postDown, "anonymous", PKG_ID)).not.toSatisfy(admitted);
    expect(await feedMode()).toBe("public");
    expect(await ownRow()).toEqual({ mode: "entitled", source: "admin" });
    const detail = d.ok
      ? (d.run.units[0]?.detail as Record<string, unknown>)
      : {};
    expect(detail.rowsKept).toEqual(["npm"]);
    expect(String(detail.note)).toMatch(/narrower/);
  });

  it("P3: apply, the operator re-entitles, apply again, then down: no principal gains over the state before the second apply", async () => {
    await setFeed("authenticated");
    await setAccessRow("app", { mode: "licensed", entitlement: null });
    const r1 = await dryRun(ctx(), feedAccessCustomersJob, ACTOR);
    const a1 = await apply(ctx(NOW + 1), feedAccessCustomersJob, ACTOR, r1.id);
    if (!a1.ok) throw new Error("a1");
    await setFeed("entitled"); // the operator, before F-34.5 closes the option
    const preApply2 = await answers();
    const r2 = await dryRun(ctx(NOW + 2), feedAccessCustomersJob, ACTOR);
    let a2 = await apply(ctx(NOW + 3), feedAccessCustomersJob, ACTOR, r2.id);
    if (a2.ok && a2.run.status === "failed")
      a2 = await apply(
        ctx(NOW + 3 + GAP),
        feedAccessCustomersJob,
        ACTOR,
        r2.id,
      );
    if (!a2.ok) throw new Error("a2");
    expect(a2.run.status).toBe("applied");
    const d = await runDown(a2.run.id, NOW + 500);
    expect(d.ok && d.run.status).toBe("reverted");
    const postDown = await answers();
    notWider(preApply2, postDown);
    expect(named(postDown, "license-noflag", PKG_ID)).not.toSatisfy(admitted);
    expect(named(postDown, "person-noflag", PKG_ID)).not.toSatisfy(admitted);
  });
});

describe("B3: a 'keep' row is re-checked when the batch runs", () => {
  it("P1: an operator lowers an already-entitled row between the plan and the batch: the feed does not move over it", async () => {
    await setFeed("entitled");
    await setAccessRow("app", { mode: "public", entitlement: null });
    await setAccessRow(PKG_ID, {
      mode: "entitled",
      entitlement: null,
      source: "admin",
    });
    const report = await dryRun(ctx(), feedAccessCustomersJob, ACTOR);
    const realBatch = db.batch.bind(db);
    let raced = false;
    db.batch = async (stmts) => {
      if (
        !raced &&
        JSON.stringify(stmts).includes("dist_registry_access_moves")
      ) {
        raced = true; // lands after the plan read, before the batch
        await db.run(
          "UPDATE dist_access SET mode = 'licensed', modified_at = ? WHERE product = ? AND deliverable_id = ?",
          NOW + 1,
          OWNER,
          PKG_ID,
        );
      }
      return realBatch(stmts);
    };
    const r = await apply(
      ctx(NOW + 1),
      feedAccessCustomersJob,
      ACTOR,
      report.id,
    );
    db.batch = realBatch;
    expect(r.ok && r.run.units[0]?.error).toBe("registry_cache_window");
    expect(raced).toBe(true);
    expect(await feedMode()).toBe("entitled");
    expect(named(await answers(), "license-noflag", PKG_ID)).not.toSatisfy(
      admitted,
    );
    // The next call sees the lowered row, raises it again, and a window later the feed moves.
    const resumed = await apply(
      ctx(NOW + 2),
      feedAccessCustomersJob,
      ACTOR,
      report.id,
    );
    expect(resumed.ok && resumed.run.units[0]?.error).toBe(
      "registry_cache_window",
    );
    expect(await ownRow()).toEqual({ mode: "entitled", source: "admin" });
    expect(await feedMode()).toBe("entitled");
    const done = await apply(
      ctx(NOW + 2 + GAP),
      feedAccessCustomersJob,
      ACTOR,
      report.id,
    );
    expect(done.ok && done.run.status).toBe("applied");
    expect(await feedMode()).toBe("licensed");
    expect(named(await answers(), "license-noflag", PKG_ID)).not.toSatisfy(
      admitted,
    );
  });
});

describe("the apply names feeds the dry run did not list", () => {
  it("a feed that became Authenticated after the report is moved and reported", async () => {
    await setFeed("authenticated");
    const report = await dryRun(ctx(), feedAccessCustomersJob, ACTOR);
    await seedPackage("mvn.one", "maven");
    await setFeed("authenticated", "maven"); // after the operator read the report
    const r = await apply(
      ctx(NOW + 1),
      feedAccessCustomersJob,
      ACTOR,
      report.id,
    );
    expect(r.ok && r.run.status).toBe("applied");
    const detail = r.ok
      ? (r.run.units[0]?.detail as Record<string, unknown>)
      : {};
    expect(detail.notInReport).toEqual(["maven (authenticated)"]);
    expect(detail.moved).toEqual([
      { ecosystem: "maven", from: "authenticated" },
      { ecosystem: "npm", from: "authenticated" },
    ]);
  });
});
