/**
 * U-27.6: the P0-49 job `core.provisioned-secrets-to-account`. Built on the migration runner and
 * the real document builders: after apply every delivered config document is value-equal, a second
 * dry run reports no changes, `down` restores the stored state, and a sign-in between the plan
 * and the apply skips that move. No value reaches a report or the ledger.
 */
import { describe, expect, it } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { ManagedEntry } from "@polaris-key/protocol";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  TEST_KID,
  TEST_PUB,
} from "../seed.js";
import type { Env } from "../../src/platform/env.js";
import type { Db } from "../../src/db/types.js";
import { setServices } from "../../src/core/products/store.js";
import { serializeServices } from "../../src/core/services.js";
import { loadProduct, type Product } from "../../src/core/products.js";
import { subjectFor } from "../../src/core/accounts/accountSubjects.js";
import {
  getAccountOverrides,
  putAccountOverrides,
} from "../../src/core/accounts/accountOverrides.js";
import { sealManagedValue } from "../../src/core/managedSecrets.js";
import { handleActivate } from "../../src/services/license/activation.js";
import { handleConfigDocument } from "../../src/services/config/document.js";
import { signIn } from "../../src/services/identity/accounts/signIn.js";
import type { MigrationContext } from "../../src/core/migrate/job.js";
import { apply, down, dryRun } from "../../src/core/migrate/runner.js";
import { migrationJobs } from "../../src/core/contributions.js";
import {
  applyProductPlan,
  downProduct,
  planProduct,
  PROVISIONED_SECRETS_JOB_ID,
  provisionedSecretsToAccountJob as job,
} from "../../src/core/migrate/provisionedSecretsJob.js";
import {
  runSubjectDelete,
  runSubjectMerge,
} from "../../src/core/accounts/subjectHooks.js";
import { casLicenseOverrides } from "../../src/core/licensing/store.js";
import { productGrantErasureStatements } from "../../src/core/licensing/grants.js";
import { licenseGrantDeleteStatements } from "../../src/core/licensing/grants.js";
import "../../src/mount.js";

const SLUG = "djdl";
const KEY = "api.token";
const ACTOR = { sub: "op", name: "Op", email: null };

const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: KEY,
      kind: "secret",
      secret: true,
      category: "Secrets",
      label: "API token",
      description: "A managed secret.",
      schema: { type: "string" },
    },
    {
      key: "theme",
      kind: "config",
      category: "UI",
      label: "Theme",
      description: "The colour theme.",
      schema: { type: "string" },
      default: "system",
    },
  ],
};

interface World {
  db: Db;
  env: Env;
  product: Product;
  ctx: (at?: number) => MigrationContext;
}

async function world(): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  await seedProduct(db, SLUG, { catalog: CATALOG });
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
        sync: { enabled: false },
        commerce: { enabled: false },
        connect: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
  await db.run(
    "INSERT INTO provisioning_config (product, claim, entitlement_key, entitlement_value_json, secret_key, secret_url_template, allowed_hosts_json) VALUES (?,?,?,?,?,?,?)",
    SLUG,
    "vpnSub",
    null,
    null,
    KEY,
    "https://vpn.example.com/{claim}",
    JSON.stringify(["vpn.example.com"]),
  );
  const product = (await loadProduct(env, db, SLUG))!;
  return { db, env, product, ctx: (at = NOW) => ({ env, db, now: at }) };
}

async function account(
  db: Db,
  email: string,
): Promise<{ id: string; subject: string }> {
  const r = await signIn(
    db,
    { issuerKey: "email", subject: email, kind: "email" },
    NOW,
    { unfenced: true, product: { slug: SLUG } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  return { id: r.account.id, subject: r.subject! };
}

const entry = (value: unknown, updatedAt = NOW - 100, state = "default") =>
  ({ state, value, updatedAt }) as ManagedEntry;

/** A licence holding `secrets`, owned by `owner` (or floating when null). */
async function licence(
  w: World,
  id: string,
  opts: {
    owner: string | null;
    secrets: Record<string, unknown>;
    email?: string | null;
  },
): Promise<string> {
  const { key } = await seedLicenseWithKey(w.db, SLUG, {
    id,
    secrets: opts.secrets as Record<string, ManagedEntry>,
  });
  await w.db.run(
    "UPDATE licenses SET account_id = ?, email = ? WHERE product = ? AND id = ?",
    opts.owner,
    opts.email === undefined ? "buyer@example.com" : opts.email,
    SLUG,
    id,
  );
  return key;
}

/** Licence-key activation through the real route; `asSubject` binds the device to the owner. */
async function device(
  w: World,
  key: string,
  deviceId: string,
  asSubject?: string,
): Promise<string> {
  const res = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": deviceId,
    }),
    w.env,
    w.db,
    w.product,
    NOW,
  );
  expect(res.status).toBe(200);
  if (asSubject)
    await w.db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = ?",
      asSubject,
      SLUG,
      deviceId,
    );
  return ((await res.json()) as { token: string }).token;
}

/** The signed config document a device receives, minus its per-request timestamps. */
async function docOf(
  w: World,
  token: string,
): Promise<{
  content: Omit<ConfigDoc, "issuedAt" | "expiresAt" | "graceUntil">;
  secrets: ConfigDoc["secrets"];
}> {
  const res = await handleConfigDocument(
    mkReq("GET", {
      authorization: `Bearer ${token}`,
      "x-pkey-version": "1.2.3",
    }),
    w.env,
    w.db,
    w.product,
    NOW,
  );
  expect(res.status).toBe(200);
  const verified = await verifyJws<ConfigDoc>(await res.text(), {
    [TEST_KID]: TEST_PUB,
  });
  const {
    issuedAt: _i,
    expiresAt: _e,
    graceUntil: _g,
    ...content
  } = verified!.payload;
  void _i;
  void _e;
  void _g;
  return {
    content,
    secrets: verified!.payload.secrets,
  };
}

/** Everything the job may touch, as stored. */
async function dump(db: Db): Promise<unknown> {
  return {
    licenses: await db.all(
      "SELECT id, overrides_json, modified_at, modified_by FROM licenses ORDER BY id",
    ),
    account: await db.all(
      "SELECT subject, payload_json FROM account_overrides ORDER BY subject",
    ),
    ledger: await db.all(
      "SELECT * FROM provisioned_secret_moves ORDER BY license_id, key",
    ),
  };
}

async function ledger(db: Db) {
  return db.all<{
    license_id: string;
    key: string;
    subject: string;
    entry_sha256: string;
    added_to_account: number;
    shadowed: number;
  }>("SELECT * FROM provisioned_secret_moves ORDER BY license_id, key");
}

/** Ada owns two licences with the same sealed secret and a device signed in as her on each. */
async function ada(w: World) {
  const a = await account(w.db, "ada@example.com");
  const sealed = await sealManagedValue(w.env, SLUG, KEY, "tok-ada");
  const e = entry(sealed);
  // The operator's keys around it fix the position the entry goes back to.
  const secrets = {
    "op.first": entry("x", NOW - 5, "enforced"),
    [KEY]: e,
    "op.last": entry("y", NOW - 5, "enforced"),
  };
  const k1 = await licence(w, "L-1", { owner: a.id, secrets });
  const k2 = await licence(w, "L-2", { owner: a.id, secrets: { [KEY]: e } });
  const t1 = await device(w, k1, "dev-1", a.subject);
  const t2 = await device(w, k2, "dev-2", a.subject);
  return { a, e, sealed, t1, t2 };
}

describe("core.provisioned-secrets-to-account", () => {
  it("is registered as a Core job and lists the products that declare a secret", async () => {
    const w = await world();
    expect(migrationJobs().map((j) => j.id)).toContain(
      PROVISIONED_SECRETS_JOB_ID,
    );
    expect(await job.units(w.ctx())).toEqual([SLUG]);
  });

  it("a dry run writes nothing but its report, and the report holds counts, no value", async () => {
    const w = await world();
    const { sealed } = await ada(w);
    const before = await dump(w.db);
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(report.changes).toBe(2);
    expect(await dump(w.db)).toEqual(before);
    const text = JSON.stringify(report);
    expect(text).not.toContain(sealed as string);
    expect(text).not.toContain("tok-ada");
    expect(report.units[0]!.detail).toMatchObject({
      moves: 2,
      addToAccount: 1,
      conflicts: 0,
    });
  });

  it("apply keeps every delivered document value-equal; a second dry run shows 0; down restores", async () => {
    const w = await world();
    const { a, e, sealed, t1, t2 } = await ada(w);
    // Another licence of the same product whose owner has no devices: nothing to compare.
    const before = await dump(w.db);
    const d1 = await docOf(w, t1);
    const d2 = await docOf(w, t2);
    expect(d1.secrets[KEY]?.value).toBe("tok-ada");

    const report = await dryRun(w.ctx(), job, ACTOR);
    const applied = await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    expect(applied.ok && applied.run.status).toBe("applied");
    expect(applied.ok && applied.run.changes).toBe(2);

    // The owner's row holds the entry exactly as it was stored; the columns lack the key.
    const row = await getAccountOverrides(w.db, SLUG, a.subject);
    expect(JSON.parse(row!.payload_json)).toEqual({
      config: {},
      secrets: { [KEY]: e },
    });
    expect(row!.updated_by).toBe("migration");
    const cols = await w.db.all<{
      overrides_json: string;
      modified_at: number;
      modified_by: string | null;
    }>(
      "SELECT overrides_json, modified_at, modified_by FROM licenses ORDER BY id",
    );
    for (const c of cols) {
      expect(JSON.parse(c.overrides_json).secrets).not.toHaveProperty(KEY);
      expect(c.modified_at).toBe(NOW);
      expect(c.modified_by).toBeNull();
    }
    expect(JSON.parse(cols[0]!.overrides_json).secrets).toHaveProperty(
      "op.first",
    );

    // Value-equal documents (toEqual ignores key order), for the owned licence and its sibling.
    expect(await docOf(w, t1)).toEqual(d1);
    expect(await docOf(w, t2)).toEqual(d2);

    // The ledger: ids and a hash, never a value.
    const rows = await ledger(w.db);
    expect(rows.map((r) => [r.license_id, r.key, r.added_to_account])).toEqual([
      ["L-1", KEY, 1],
      ["L-2", KEY, 0],
    ]);
    const dumpText = JSON.stringify(rows);
    expect(dumpText).not.toContain(sealed as string);
    expect(rows[0]!.entry_sha256).toMatch(/^[0-9a-f]{64}$/);

    // A re-apply of the finished report does nothing; a second dry run has no changes.
    const again = await apply(w.ctx(NOW + 2), job, ACTOR, report.id);
    expect(again.ok && again.run.remaining).toBe(0);
    const second = await dryRun(w.ctx(NOW + 3), job, ACTOR);
    expect(second.changes).toBe(0);
    expect(second.units[0]!.detail).toMatchObject({ moves: 0, conflicts: 0 });

    // Down: exactly the stored state before the job, ledger empty.
    const undone = await down(
      w.ctx(NOW + 4),
      job,
      ACTOR,
      applied.ok ? applied.run.id : "",
    );
    expect(undone.ok && undone.run.status).toBe("reverted");
    const after = (await dump(w.db)) as {
      licenses: unknown;
      account: unknown;
      ledger: unknown[];
    };
    expect(after).toEqual(before);
    expect(await docOf(w, t1)).toEqual(d1);
    expect(await docOf(w, t2)).toEqual(d2);
  });

  it("skips a move when a sign-in changes the account row or the column after the plan", async () => {
    const w = await world();
    const { a, t1 } = await ada(w);
    const plan = await planProduct(w.ctx(), SLUG);
    expect(plan.moves).toHaveLength(2);
    // The owner signs in between the plan and the apply: a fresh provisioned entry lands on the row.
    const fresh = entry(
      await sealManagedValue(w.env, SLUG, KEY, "tok-new"),
      NOW,
    );
    await putAccountOverrides(
      w.db,
      SLUG,
      a.subject,
      { config: {}, secrets: { [KEY]: fresh } },
      "signin",
      NOW,
    );
    const before = await dump(w.db);
    const result = await applyProductPlan(w.ctx(), SLUG, plan);
    expect(result).toEqual({ removed: 0, added: 0, skipped: 2 });
    expect(await dump(w.db)).toEqual(before);
    expect((await docOf(w, t1)).secrets[KEY]?.value).toBe("tok-new");

    // A column rewritten after the plan is skipped too (the licence-side sign-in).
    const w2 = await world();
    await ada(w2);
    const plan2 = await planProduct(w2.ctx(), SLUG);
    const stored = JSON.parse(
      (await w2.db.first<{ overrides_json: string }>(
        "SELECT overrides_json FROM licenses WHERE id = 'L-1'",
      ))!.overrides_json,
    );
    stored.secrets[KEY].value = "rotated";
    await w2.db.run(
      "UPDATE licenses SET overrides_json = ? WHERE id = 'L-1'",
      JSON.stringify(stored),
    );
    const r2 = await applyProductPlan(w2.ctx(), SLUG, plan2);
    // L-1 held the move that adds to the row; its sibling has nothing to follow.
    expect(r2).toEqual({ removed: 0, added: 0, skipped: 2 });
  });

  it("the licence write is guarded on the column and on the account row", async () => {
    const w = await world();
    const { a } = await ada(w);
    const col = (await w.db.first<{ overrides_json: string }>(
      "SELECT overrides_json FROM licenses WHERE id = 'L-2'",
    ))!.overrides_json;
    const next = JSON.stringify({ config: {}, secrets: {}, entitlements: {} });
    // The account row is absent: a guard that expects it present refuses.
    expect(
      await casLicenseOverrides(w.db, SLUG, "L-2", col, next, {
        subject: a.subject,
        payloadJson: "{}",
      }),
    ).toBe(false);
    // The column moved on: refuses.
    expect(await casLicenseOverrides(w.db, SLUG, "L-2", col + " ", next)).toBe(
      false,
    );
    // Both as expected: writes, and modified_at stays.
    expect(
      await casLicenseOverrides(w.db, SLUG, "L-2", col, next, {
        subject: a.subject,
        payloadJson: null,
      }),
    ).toBe(true);
    expect(
      (await w.db.first<{ modified_at: number }>(
        "SELECT modified_at FROM licenses WHERE id = 'L-2'",
      ))!.modified_at,
    ).toBe(NOW);
  });

  it("skips and reports conflicts, other-subject devices and unowned licences", async () => {
    const w = await world();
    const a = await account(w.db, "ada@example.com");
    const e1 = entry(await sealManagedValue(w.env, SLUG, KEY, "tok-1"));
    const e2 = entry(await sealManagedValue(w.env, SLUG, KEY, "tok-2"));
    await licence(w, "L-1", { owner: a.id, secrets: { [KEY]: e1 } });
    await licence(w, "L-2", { owner: a.id, secrets: { [KEY]: e2 } });
    await licence(w, "F-1", {
      owner: null,
      email: null,
      secrets: { [KEY]: e1 },
    });
    const before = await dump(w.db);
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(report.changes).toBe(0);
    expect(report.units[0]!.detail).toMatchObject({
      moves: 0,
      conflicts: 1,
      unowned: 1,
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain("tok-");
    expect((await apply(w.ctx(NOW + 1), job, ACTOR, report.id)).ok).toBe(true);
    expect(await dump(w.db)).toEqual(before);
  });

  it("leaves a later edit of the account entry in place on down", async () => {
    const w = await world();
    const { a } = await ada(w);
    const report = await dryRun(w.ctx(), job, ACTOR);
    const applied = await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    const edited = entry(
      await sealManagedValue(w.env, SLUG, KEY, "tok-edited"),
      NOW + 5,
      "enforced",
    );
    await putAccountOverrides(
      w.db,
      SLUG,
      a.subject,
      { config: {}, secrets: { [KEY]: edited } },
      "op-1",
      NOW + 5,
    );
    const undone = await down(
      w.ctx(NOW + 6),
      job,
      ACTOR,
      applied.ok ? applied.run.id : "",
    );
    expect(undone.ok).toBe(true);
    const row = await getAccountOverrides(w.db, SLUG, a.subject);
    expect(JSON.parse(row!.payload_json).secrets[KEY]).toEqual(edited);
    const cols = await w.db.all<{ overrides_json: string }>(
      "SELECT overrides_json FROM licenses ORDER BY id",
    );
    for (const c of cols)
      expect(JSON.parse(c.overrides_json).secrets).not.toHaveProperty(KEY);
    expect(await ledger(w.db)).toEqual([]);
  });

  it("a shadowed copy is removed from the column only, recorded as unrestorable", async () => {
    const w = await world();
    const a = await account(w.db, "ada@example.com");
    const subject = await subjectFor(w.db, a.id, SLUG, NOW);
    const onRow = entry(
      await sealManagedValue(w.env, SLUG, KEY, "tok-row"),
      NOW,
      "enforced",
    );
    const copy = entry(await sealManagedValue(w.env, SLUG, KEY, "tok-old"));
    await putAccountOverrides(
      w.db,
      SLUG,
      subject,
      { config: {}, secrets: { [KEY]: onRow } },
      "op-1",
      NOW,
    );
    const key = await licence(w, "L-1", {
      owner: a.id,
      secrets: { [KEY]: copy },
    });
    const t = await device(w, key, "dev-1", subject);
    const d = await docOf(w, t);
    const report = await dryRun(w.ctx(), job, ACTOR);
    expect(report.changes).toBe(1);
    const applied = await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    expect(await docOf(w, t)).toEqual(d);
    expect((await ledger(w.db))[0]).toMatchObject({
      shadowed: 1,
      added_to_account: 0,
    });
    const row = await getAccountOverrides(w.db, SLUG, subject);
    expect(JSON.parse(row!.payload_json).secrets[KEY]).toEqual(onRow);
    await down(w.ctx(NOW + 2), job, ACTOR, applied.ok ? applied.run.id : "");
    expect(await ledger(w.db)).toEqual([]);
    expect(await docOf(w, t)).toEqual(d);
  });

  /** A Db whose matching statements fail (`runChanges` answers 0) or throw, to force a CAS loss
   *  or a killed run at an exact write. */
  function faulty(db: Db, rule: (sql: string) => "lose" | "throw" | null): Db {
    return new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop) as unknown;
        if (prop !== "runChanges" || typeof v !== "function")
          return typeof v === "function" ? v.bind(target) : v;
        return async (sql: string, ...params: unknown[]) => {
          const act = rule(sql);
          if (act === "throw") throw new Error("killed");
          if (act === "lose") return 0;
          return (v as (...a: unknown[]) => Promise<number>).call(
            target,
            sql,
            ...params,
          );
        };
      },
    });
  }

  const columnKeys = async (db: Db, id: string): Promise<string[]> =>
    Object.keys(
      JSON.parse(
        (await db.first<{ overrides_json: string }>(
          "SELECT overrides_json FROM licenses WHERE id = ?",
          id,
        ))!.overrides_json,
      ).secrets,
    );

  it("B1: down after a second apply that removed a sibling's copy as shadowed restores both licences", async () => {
    const w = await world();
    const a = await account(w.db, "ada@example.com");
    const e = entry(await sealManagedValue(w.env, SLUG, KEY, "tok-ada"));
    const k1 = await licence(w, "L-1", { owner: a.id, secrets: { [KEY]: e } });
    const k2 = await licence(w, "L-2", { owner: a.id, secrets: { [KEY]: e } });
    const t1 = await device(w, k1, "dev-1", a.subject);
    const t2 = await device(w, k2, "dev-2", a.subject);
    await device(w, k2, "dev-3"); // a licence-key device: L-2 is skipped by the first apply
    const before = await dump(w.db);
    const d1 = await docOf(w, t1);
    const d2 = await docOf(w, t2);

    const rA = await dryRun(w.ctx(), job, ACTOR);
    const aA = await apply(w.ctx(NOW + 1), job, ACTOR, rA.id);
    expect(await columnKeys(w.db, "L-1")).not.toContain(KEY);
    expect(await columnKeys(w.db, "L-2")).toContain(KEY);
    // The licence-key device goes; the second apply removes L-2's copy as shadowed.
    await w.db.run(
      "UPDATE devices SET status = 'deauthorized' WHERE product = ? AND device_id = 'dev-3'",
      SLUG,
    );
    const rB = await dryRun(w.ctx(NOW + 2), job, ACTOR);
    await apply(w.ctx(NOW + 3), job, ACTOR, rB.id);
    expect(await columnKeys(w.db, "L-2")).not.toContain(KEY);
    expect((await ledger(w.db)).map((r) => [r.license_id, r.shadowed])).toEqual(
      [
        ["L-1", 0],
        ["L-2", 1],
      ],
    );
    expect(await planProduct(w.ctx(NOW + 3), SLUG)).toMatchObject({
      moves: [],
      shadowed: [],
    }); // the next dry run moves nothing

    const undone = await down(
      w.ctx(NOW + 4),
      job,
      ACTOR,
      aA.ok ? aA.run.id : "",
    );
    expect(undone.ok).toBe(true);
    expect(await columnKeys(w.db, "L-1")).toContain(KEY);
    expect(await columnKeys(w.db, "L-2")).toContain(KEY);
    const row = await getAccountOverrides(w.db, SLUG, a.subject);
    expect(row).toBeNull(); // the entry left once every licence had its copy back
    expect(await ledger(w.db)).toEqual([]);
    expect(await docOf(w, t1)).toEqual(d1);
    expect(await docOf(w, t2)).toEqual(d2);
    void before;
  });

  it("N3: down restores a licence only while its owner is still the ledger's subject; the entry stays", async () => {
    const w = await world();
    const { a } = await ada(w);
    const bob = await account(w.db, "bob@example.com");
    const report = await dryRun(w.ctx(), job, ACTOR);
    await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    // L-2 is handed over to Bob after the apply.
    await w.db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = 'L-2'",
      bob.id,
      SLUG,
    );
    await downProduct(w.ctx(NOW + 2), SLUG);
    expect(await columnKeys(w.db, "L-1")).toContain(KEY);
    expect(await columnKeys(w.db, "L-2")).not.toContain(KEY);
    const row = await getAccountOverrides(w.db, SLUG, a.subject);
    expect(JSON.parse(row!.payload_json).secrets).toHaveProperty(KEY);
    expect(await ledger(w.db)).toEqual([]);
  });

  it("N4: an account CAS that runs out is a counted retry; the added row stays and a later down removes the entry", async () => {
    const w = await world();
    const { a } = await ada(w);
    const report = await dryRun(w.ctx(), job, ACTOR);
    await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
    const broken = faulty(w.db, (sql) =>
      /account_overrides/.test(sql) && /^(UPDATE|DELETE)/.test(sql.trim())
        ? "lose"
        : null,
    );
    await expect(
      downProduct({ env: w.env, db: broken, now: NOW + 2 }, SLUG),
    ).rejects.toThrow("provisioned_secret_moves_down_retry:1");
    // Licences are back; the entry and its `added` row are not gone.
    expect(await columnKeys(w.db, "L-1")).toContain(KEY);
    expect(await columnKeys(w.db, "L-2")).toContain(KEY);
    expect(
      JSON.parse(
        (await getAccountOverrides(w.db, SLUG, a.subject))!.payload_json,
      ).secrets,
    ).toHaveProperty(KEY);
    expect(
      (await ledger(w.db)).map((r) => [r.license_id, r.added_to_account]),
    ).toEqual([["L-1", 1]]);
    // The retry finishes.
    await downProduct(w.ctx(NOW + 3), SLUG);
    expect(await getAccountOverrides(w.db, SLUG, a.subject)).toBeNull();
    expect(await ledger(w.db)).toEqual([]);
  });

  it("N5: an account CAS that loses leaves no added = 1 ledger row", async () => {
    const w = await world();
    await ada(w);
    const plan = await planProduct(w.ctx(), SLUG);
    const broken = faulty(w.db, (sql) =>
      /INTO account_overrides/.test(sql) ? "lose" : null,
    );
    const r = await applyProductPlan(
      { env: w.env, db: broken, now: NOW + 1 },
      SLUG,
      plan,
    );
    expect(r).toMatchObject({ added: 0, removed: 0 });
    expect(await ledger(w.db)).toEqual([]);
  });

  it("N10: a killed apply resumes without doubling or losing anything, and down restores the start", async () => {
    const w = await world();
    const { a, t1, t2 } = await ada(w);
    const before = await dump(w.db);
    const d1 = await docOf(w, t1);
    const d2 = await docOf(w, t2);
    const plan = await planProduct(w.ctx(), SLUG);
    // Dies at the first licence write, after the ledger row and the account write.
    const killer = faulty(w.db, (sql) =>
      /^UPDATE licenses SET overrides_json/.test(sql.trim()) ? "throw" : null,
    );
    await expect(
      applyProductPlan({ env: w.env, db: killer, now: NOW + 1 }, SLUG, plan),
    ).rejects.toThrow("killed");
    expect(await ledger(w.db)).toHaveLength(1);
    expect(await columnKeys(w.db, "L-1")).toContain(KEY);
    // Re-run: nothing doubled, nothing lost, documents unchanged.
    const report = await dryRun(w.ctx(NOW + 2), job, ACTOR);
    await apply(w.ctx(NOW + 3), job, ACTOR, report.id);
    expect(await columnKeys(w.db, "L-1")).not.toContain(KEY);
    expect(await columnKeys(w.db, "L-2")).not.toContain(KEY);
    expect(await docOf(w, t1)).toEqual(d1);
    expect(await docOf(w, t2)).toEqual(d2);
    expect((await ledger(w.db)).map((r) => r.license_id)).toEqual([
      "L-1",
      "L-2",
    ]);
    expect(await planProduct(w.ctx(NOW + 4), SLUG)).toMatchObject({
      moves: [],
      shadowed: [],
    });
    await downProduct(w.ctx(NOW + 5), SLUG);
    expect(await dump(w.db)).toEqual(before);
    expect(await docOf(w, t1)).toEqual(d1);
    expect(a.subject).toBeTruthy();
  });

  it("N11: the ledger only accepts 0 or 1 in its flag columns", async () => {
    const w = await world();
    for (const col of ["added_to_account", "shadowed"])
      await expect(
        w.db.run(
          `INSERT INTO provisioned_secret_moves
             (product, license_id, key, subject, entry_sha256, added_to_account, shadowed, position, run_id, at)
           VALUES ('djdl', 'L', 'k', 's', 'h', ${col === "added_to_account" ? 2 : 0}, ${col === "shadowed" ? 2 : 0}, 0, 'r', 1)`,
        ),
      ).rejects.toThrow();
  });

  describe("erasure: the ledger holds a subject", () => {
    async function applied() {
      const w = await world();
      const { a } = await ada(w);
      const report = await dryRun(w.ctx(), job, ACTOR);
      await apply(w.ctx(NOW + 1), job, ACTOR, report.id);
      return { w, a };
    }

    it("the subject store deletes, re-keys and exports it without a value", async () => {
      const { w, a } = await applied();
      const ctx = { db: w.db, env: w.env, now: NOW };
      await runSubjectMerge(ctx, {
        product: SLUG,
        from: a.subject,
        to: "ps_new",
      });
      expect((await ledger(w.db)).every((r) => r.subject === "ps_new")).toBe(
        true,
      );
      await runSubjectDelete(ctx, { product: SLUG, subject: "ps_new" });
      expect(await ledger(w.db)).toEqual([]);
    });

    it("licence deletion and product deletion remove its rows", async () => {
      const { w } = await applied();
      await w.db.batch(
        licenseGrantDeleteStatements({ product: SLUG, licenseId: "L-1" }),
      );
      expect((await ledger(w.db)).map((r) => r.license_id)).toEqual(["L-2"]);
      await w.db.batch(productGrantErasureStatements(SLUG));
      expect(await ledger(w.db)).toEqual([]);
    });
  });
});
