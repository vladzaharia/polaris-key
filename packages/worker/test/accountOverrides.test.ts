/**
 * U-03: the account override layer and the licence-override migration (notes/S-17 §5.12, §5.5;
 * plans/U-01.md §6.3; decisions 3, 4, 20 and 21).
 *
 * The eight tests §5.12 lists, each under its own name below:
 *
 *   1. a licence-key device on an owned licence (one licence of the product) receives the owner's
 *      migrated override: the same signed config content as before, apart from timestamps;
 *   2. an owner of two licences with different values: both licences' devices receive the most
 *      recently updated value, keys on one licence survive, the report lists the collapse;
 *   3. a signed-in device on a licence another account owns receives its own account's layer;
 *   4. a device on a floating licence receives no account layer; its licence's overrides are in
 *      the report with an audit row;
 *   5. secret values never appear in the report;
 *   6. PUT /licenses/<id>/overrides refuses config and secrets after the run and accepts
 *      entitlements, on owned and floating licences (decision 20);
 *   7. an account merge copies and reports colliding account overrides (§5.5);
 *   8. the signed corpus is unchanged: asserted by `pnpm gen corpus --check` (the gate), since
 *      no signed shape, claim or fixture changes here; the config document's shape is checked in
 *      test 1.
 *
 * And around them: the notice cannot start before I-07 and I-11 are flagged live; the run waits
 * for the notice window and needs a step-up; the console editor; ETags follow the layer; the OIDC
 * provisioning writer's secrets move with the run; the nightly inventory, report purge and column
 * emptying.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { verifyJws } from "@polaris-key/jws";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { ManagedEntry } from "@polaris-key/protocol";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  TEST_KID,
  TEST_PUB,
} from "./seed.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { getLicense, getDevice, setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { setDeviceSubject, subjectFor } from "../src/core/accountSubjects.js";
import {
  applyProvisionedAccountSecrets,
  getAccountOverrides,
  overrideSubject,
  parseAccountOverridePayload,
  putAccountOverrides,
} from "../src/core/accountOverrides.js";
import {
  OVERRIDE_MIGRATION_NOTICE_DAYS,
  OVERRIDE_MIGRATION_REPORT_DAYS,
  dryRunOverrideMigration,
  listOverrideMigrationReport,
  overrideMigrationNightly,
  overrideMigrationReportCsv,
  productOverrideInventory,
  readOverrideMigrationState,
  runOverrideMigration,
  setOverrideMigrationPrerequisite,
  startOverrideMigrationNotice,
} from "../src/core/overrideMigration.js";
import { resolveMergedPayload } from "../src/core/payload.js";
import { sealManagedValue } from "../src/admin/lib/managedSecrets.js";
import { handleActivate } from "../src/services/license/activation.js";
import { handleConfigDocument } from "../src/services/config/document.js";
import { signIn } from "../src/services/identity/accounts/signIn.js";
import { mergeAccounts } from "../src/services/identity/accounts/merge.js";
import {
  attachLicense,
  detachLicense,
} from "../src/services/identity/accounts/claim.js";
import { handleAdmin } from "../src/admin/index.js";
import { deleteProduct } from "../src/admin/repo.js";
import { dryRunOnCopy } from "../scripts/override-migration-dry-run.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";

const SLUG = "djdl";
const PLATFORM_GROUP = "platform-admins";
const DAY = 86_400;
/** A time past the notice window of a notice started at NOW. */
const RUN_AT = NOW + (OVERRIDE_MIGRATION_NOTICE_DAYS + 1) * DAY;

const CATALOG = {
  schemaVersion: 1,
  entries: [
    {
      key: "theme",
      kind: "config",
      category: "UI",
      label: "Theme",
      description: "The colour theme.",
      schema: { type: "string" },
      default: "system",
    },
    {
      key: "volume",
      kind: "config",
      category: "Audio",
      label: "Volume",
      description: "The master volume.",
      schema: { type: "number" },
    },
    {
      key: "lang",
      kind: "config",
      category: "UI",
      label: "Language",
      description: "The interface language.",
      schema: { type: "string" },
    },
    {
      key: "cfg.password",
      kind: "config",
      secret: true,
      category: "Secrets",
      label: "Password",
      description: "A config key the catalog flags secret.",
      schema: { type: "string" },
    },
    {
      key: "api.token",
      kind: "secret",
      secret: true,
      category: "Secrets",
      label: "API token",
      description: "A managed secret.",
      schema: { type: "string" },
    },
    {
      key: "pro",
      kind: "flag",
      category: "Plans",
      label: "Pro",
      description: "The pro features.",
      schema: { type: "boolean" },
    },
  ],
};

interface World {
  db: Db;
  env: Env;
  product: Product;
  call: (
    method: string,
    path: string,
    body?: unknown,
    opts?: { now?: number; authAt?: number; db?: Db },
  ) => Promise<Response>;
}

async function world(
  opts: { identity?: boolean; products?: string[] } = {},
): Promise<World> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), []);
  env.EMAIL = { send: async () => {} } as unknown as Env["EMAIL"];
  env.PORTAL_EMAIL_FROM = "noreply@key.plrs.im";
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  for (const slug of opts.products ?? [SLUG]) {
    await seedProduct(db, slug, { catalog: CATALOG });
    await setServices(
      db,
      slug,
      serializeServices({
        services: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: opts.identity ?? true },
          sync: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
  }
  const product = (await loadProduct(env, db, SLUG))!;
  const call: World["call"] = async (method, path, body, o = {}) => {
    const now = o.now ?? NOW;
    const { token, session } = await issueSession(
      env,
      {
        sub: "op-1",
        name: "Ada Operator",
        email: "ops@studio.example",
        groups: [PLATFORM_GROUP],
        authTime: o.authAt ?? now,
        stepUp: true,
      },
      now,
    );
    const headers: Record<string, string> = {
      cookie: `${ADMIN_COOKIE}=${token}`,
    };
    if (method !== "GET") headers[CSRF_HEADER] = session.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const full = `/api${path}`;
    return handleAdmin(
      new Request(`https://key.plrs.im/manage${full}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as unknown as Request,
      env,
      o.db ?? db,
      full.split("?")[0]!,
      { now },
    );
  };
  return { db, env, product, call };
}

async function account(
  db: Db,
  email: string,
): Promise<{ id: string; subject: string }> {
  const r = await signIn(
    db,
    { issuerKey: "email", subject: email, kind: "email" },
    NOW,
    { product: { slug: SLUG } },
  );
  if (r.status !== "signed_in") throw new Error(r.status);
  return { id: r.account.id, subject: r.subject! };
}

const entry = (value: unknown, updatedAt = NOW, state = "enforced") =>
  ({ state, value, updatedAt }) as ManagedEntry;

/** A licence with overrides, an owner (account id) or none, and its email. */
async function licence(
  w: World,
  id: string,
  opts: {
    config?: Record<string, ManagedEntry>;
    secrets?: Record<string, ManagedEntry>;
    entitlements?: Record<string, ManagedEntry>;
    owner?: string | null;
    email?: string | null;
    product?: string;
  } = {},
): Promise<string> {
  const product = opts.product ?? SLUG;
  const { key } = await seedLicenseWithKey(w.db, product, {
    id,
    config: opts.config,
    secrets: opts.secrets,
    entitlements: opts.entitlements,
  });
  await w.db.run(
    "UPDATE licenses SET account_id = ?, email = ? WHERE product = ? AND id = ?",
    opts.owner ?? null,
    opts.email === undefined ? "buyer@example.com" : opts.email,
    product,
    id,
  );
  return key;
}

/** Licence-key activation through the real route; answers the device token. */
async function activate(
  w: World,
  key: string,
  deviceId: string,
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
  return ((await res.json()) as { token: string }).token;
}

/** The signed config document a device receives, its content without the per-request
 *  timestamps, and its ETag. */
async function configDoc(
  w: World,
  token: string,
  now = NOW,
): Promise<{ doc: ConfigDoc; content: string; etag: string | null }> {
  const res = await handleConfigDocument(
    mkReq("GET", {
      authorization: `Bearer ${token}`,
      "x-pkey-version": "1.2.3",
    }),
    w.env,
    w.db,
    w.product,
    now,
  );
  expect(res.status).toBe(200);
  const etag = res.headers.get("etag");
  const verified = await verifyJws<ConfigDoc>(await res.text(), {
    [TEST_KID]: TEST_PUB,
  });
  const doc = verified!.payload;
  const { issuedAt: _i, expiresAt: _e, graceUntil: _g, ...content } = doc;
  void _i;
  void _e;
  void _g;
  return { doc, content: JSON.stringify(content), etag };
}

const ACTOR = {
  sub: "op-1",
  name: "Ada Operator",
  email: "ops@studio.example",
};

/** Flag both prerequisites, start the notice at NOW and run to completion at RUN_AT. */
async function migrate(w: World): Promise<void> {
  await setOverrideMigrationPrerequisite(w.db, "loginCard", true, ACTOR, NOW);
  await setOverrideMigrationPrerequisite(w.db, "library", true, ACTOR, NOW);
  const notice = await startOverrideMigrationNotice(w.db, ACTOR, NOW);
  expect(notice.ok).toBe(true);
  for (let i = 0; i < 10; i++) {
    const r = await runOverrideMigration(w.env, w.db, ACTOR, RUN_AT);
    if (!r.ok) throw new Error(r.reason);
    if (r.progress.done) return;
  }
  throw new Error("the run did not complete");
}

/**
 * A Db that runs `race` once, just before the first write whose SQL matches `match` (a concurrent
 * writer landing between a read and the write that depends on it).
 */
function racing(inner: Db, match: RegExp, race: () => Promise<void>): Db {
  let fired = false;
  const before = async (sqls: string[]): Promise<void> => {
    if (fired || !sqls.some((q) => match.test(q))) return;
    fired = true;
    await race();
  };
  return {
    all: (sql, ...p) => inner.all(sql, ...p),
    first: (sql, ...p) => inner.first(sql, ...p),
    run: async (sql, ...p) => {
      await before([sql]);
      return inner.run(sql, ...p);
    },
    runChanges: async (sql, ...p) => {
      await before([sql]);
      return inner.runChanges(sql, ...p);
    },
    batch: async (stmts) => {
      await before(stmts.map((x) => x.sql));
      return inner.batch(stmts);
    },
    batchChanges: async (stmts) => {
      await before(stmts.map((x) => x.sql));
      return inner.batchChanges!(stmts);
    },
  };
}

// ── The eight tests (S-17 §5.12) ──────────────────────────────────────────────────────────────

describe("U-03 §5.12: the account override layer and the migration", () => {
  it("1. a licence-key device on an owned licence keeps the same signed config content through the migration (Identity off)", async () => {
    // The owner line works with the product's Identity toggle off (owner, 2026-10-04).
    const w = await world({ identity: false });
    const ada = await signIn(
      w.db,
      { issuerKey: "email", subject: "ada@example.com", kind: "email" },
      NOW,
    );
    if (ada.status !== "signed_in") throw new Error(ada.status);
    const sealedToken = await sealManagedValue(
      w.env,
      SLUG,
      "api.token",
      "tok-ada-SECRET",
    );
    const key = await licence(w, "lic-ada", {
      owner: ada.account.id,
      config: { theme: entry("dark", NOW - 50), volume: entry(7, NOW - 40) },
      secrets: { "api.token": entry(sealedToken, NOW - 30, "hidden") },
      entitlements: { pro: entry(true) },
    });
    const token = await activate(w, key, "dev-key");
    // Both documents are minted at the same instant: a catalog default's `updatedAt` is the
    // request time (`catalogDefaultPayload`), so documents minted at different times differ there.
    const before = await configDoc(w, token, RUN_AT);
    expect(before.doc.config.theme?.value).toBe("dark");
    expect(before.doc.secrets["api.token"]?.value).toBe("tok-ada-SECRET");

    await migrate(w);

    // The owner had never contacted the product: the run created the subject and wrote the row.
    const subject = await subjectFor(w.db, ada.account.id, SLUG, NOW);
    const row = await getAccountOverrides(w.db, SLUG, subject);
    expect(row?.updated_by).toBe("migration");
    // Copied sealed, never re-sealed: the same envelope.
    expect(
      parseAccountOverridePayload(row!.payload_json).secrets["api.token"]
        ?.value,
    ).toBe(sealedToken);
    const after = await configDoc(w, token, RUN_AT);
    // The owner's secrets no longer reach a key-only device; config is unchanged.
    expect(after.doc.config).toEqual(before.doc.config);
    expect(after.doc.secrets).toEqual({});
    // And the device's licence no longer delivers config or secrets itself (step 5).
    const lic = (await getLicense(w.db, SLUG, "lic-ada"))!;
    expect(
      (
        await resolveMergedPayload(w.db, SLUG, lic, null, RUN_AT, {
          entitlementsOnly: false,
        })
      ).payload.config.theme?.value,
    ).toBe("dark"); // through the owner line
    await putAccountOverrides(
      w.db,
      SLUG,
      subject,
      { config: {}, secrets: {} },
      "op-1",
      RUN_AT,
    );
    const emptied = await configDoc(w, token, RUN_AT);
    expect(emptied.doc.config.theme?.value).toBe("system");
    expect(emptied.doc.secrets["api.token"]).toBeUndefined();
  });

  it("2. an owner of two licences: both receive the most recently updated value, single keys survive, the report lists the collapse", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const keyA = await licence(w, "lic-a", {
      owner: ada.id,
      config: { theme: entry("dark", NOW - 100), volume: entry(3, NOW - 100) },
    });
    const keyB = await licence(w, "lic-b", {
      owner: ada.id,
      config: { theme: entry("light", NOW - 10), lang: entry("fr", NOW - 10) },
    });
    const tA = await activate(w, keyA, "dev-a");
    const tB = await activate(w, keyB, "dev-b");
    expect((await configDoc(w, tA)).doc.config.theme?.value).toBe("dark");

    await migrate(w);

    for (const t of [tA, tB]) {
      const { doc } = await configDoc(w, t, RUN_AT);
      expect(doc.config.theme?.value).toBe("light");
      expect(doc.config.volume?.value).toBe(3);
      expect(doc.config.lang?.value).toBe("fr");
    }
    const report = await listOverrideMigrationReport(w.db, RUN_AT);
    const a = report.find((r) => r.licenseId === "lic-a")!;
    const b = report.find((r) => r.licenseId === "lic-b")!;
    expect(a.outcome).toBe("collapsed");
    expect(a.subject).toBe(ada.subject);
    expect(a.values.collapsed).toEqual([
      {
        bucket: "config",
        key: "theme",
        keptFrom: "lic-b",
        kept: "light",
        lost: "dark",
      },
    ]);
    expect(b.outcome).toBe("moved");
    expect(b.values.collapsed).toBeUndefined();
    // No account id anywhere in the report.
    expect(JSON.stringify(report)).not.toContain(ada.id);
  });

  it("3. a signed-in device on a licence another account owns receives its own account's layer", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const bo = await account(w.db, "bo@example.com");
    const key = await licence(w, "lic-ada", {
      owner: ada.id,
      config: { theme: entry("dark") },
    });
    const tKey = await activate(w, key, "dev-key");
    const tBo = await activate(w, key, "dev-bo");
    expect(
      await setDeviceSubject(w.env, w.db, SLUG, "dev-bo", bo.subject),
    ).toBe(true);
    await putAccountOverrides(
      w.db,
      SLUG,
      bo.subject,
      { config: { theme: entry("blue"), lang: entry("de") }, secrets: {} },
      "op-1",
      NOW,
    );
    await migrate(w);
    const boDoc = (await configDoc(w, tBo, RUN_AT)).doc;
    expect(boDoc.config.theme?.value).toBe("blue");
    expect(boDoc.config.lang?.value).toBe("de");
    // The key-entry device on the same licence gets the owner's (migrated) layer.
    const keyDoc = (await configDoc(w, tKey, RUN_AT)).doc;
    expect(keyDoc.config.theme?.value).toBe("dark");
    expect(keyDoc.config.lang).toBeUndefined();
  });

  it("4. a device on a floating licence receives no account layer; its overrides are in the report with an audit row", async () => {
    const w = await world();
    const bo = await account(w.db, "bo@example.com");
    const key = await licence(w, "lic-float", {
      owner: null,
      email: null,
      config: { theme: entry("dark"), volume: entry(9) },
    });
    const token = await activate(w, key, "dev-1");
    // Even a binding on the device gives a floating licence no account layer (S-24).
    await setDeviceSubject(w.env, w.db, SLUG, "dev-1", bo.subject);
    await putAccountOverrides(
      w.db,
      SLUG,
      bo.subject,
      { config: { theme: entry("blue") }, secrets: {} },
      "op-1",
      NOW,
    );
    expect((await configDoc(w, token)).doc.config.theme?.value).toBe("dark");

    await migrate(w);

    const doc = (await configDoc(w, token, RUN_AT)).doc;
    expect(doc.config.theme?.value).toBe("system");
    expect(doc.config.volume).toBeUndefined();
    const device = (await getDevice(w.db, SLUG, "dev-1"))!;
    const lic = (await getLicense(w.db, SLUG, "lic-float"))!;
    expect(await overrideSubject(w.db, SLUG, lic, device)).toBeNull();
    const [row] = await listOverrideMigrationReport(w.db, RUN_AT);
    expect(row).toMatchObject({
      licenseId: "lic-float",
      outcome: "dropped",
      subject: null,
      buyerEmail: null,
      keys: { config: ["theme", "volume"], secrets: [] },
      values: { config: { theme: "dark", volume: 9 } },
    });
    const audit = await w.db.all<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM audit WHERE product = ? AND action LIKE 'license.overrides.%'",
      SLUG,
    );
    expect(audit).toEqual([
      { action: "license.overrides.dropped", target_id: "lic-float" },
    ]);
  });

  it("5. secret values never appear in the report, the CSV, the dry run or the inventory", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const sealedA = await sealManagedValue(
      w.env,
      SLUG,
      "api.token",
      "tok-SEALED-1",
    );
    const sealedPw = await sealManagedValue(
      w.env,
      SLUG,
      "cfg.password",
      "pw-SEALED-2",
    );
    await licence(w, "lic-owned", {
      owner: ada.id,
      config: { "cfg.password": entry(sealedPw), theme: entry("dark") },
      secrets: { "api.token": entry(sealedA, NOW - 5) },
    });
    // A second licence of the same owner, with a different secret: a collapse of secrets.
    await licence(w, "lic-owned-2", {
      owner: ada.id,
      secrets: { "api.token": entry("tok-PLAIN-3", NOW - 50) },
    });
    // A legacy plaintext secret and a plaintext secret-flagged config value, on a floating licence.
    await licence(w, "lic-float", {
      owner: null,
      email: "buyer@example.com",
      config: { "cfg.password": entry("pw-PLAIN-4"), volume: entry(4) },
      secrets: { "api.token": entry("tok-PLAIN-5") },
    });
    const secrets = [
      "tok-SEALED-1",
      "pw-SEALED-2",
      "tok-PLAIN-3",
      "pw-PLAIN-4",
      "tok-PLAIN-5",
      sealedA,
      sealedPw,
    ];
    const dry = JSON.stringify(await dryRunOverrideMigration(w.db, NOW));
    // The console's inventory before the run: the nightly snapshot and one product's licence list.
    await overrideMigrationNightly(w.db, NOW);
    const snapshot = await readOverrideMigrationState(w.db);
    expect(snapshot.inventory?.totals).toEqual({
      licences: 3,
      owned: 2,
      dropped: 1,
    });
    const listed = await productOverrideInventory(w.db, SLUG);
    expect(listed.licences.map((l) => [l.licenseId, l.secretKeys])).toEqual([
      ["lic-float", ["api.token"]],
      ["lic-owned", ["api.token"]],
      ["lic-owned-2", ["api.token"]],
    ]);
    const inventory = JSON.stringify(snapshot) + JSON.stringify(listed);
    await migrate(w);
    const rows = await listOverrideMigrationReport(w.db, RUN_AT);
    const stored = JSON.stringify(
      await w.db.all("SELECT * FROM override_migration_report"),
    );
    const csv = overrideMigrationReportCsv(rows);
    const audit = JSON.stringify(await w.db.all("SELECT * FROM audit"));
    for (const out of [dry, stored, csv, inventory, audit])
      for (const s of secrets) expect(out).not.toContain(s);
    // Names are listed, non-secret values are kept.
    const owned2 = rows.find((r) => r.licenseId === "lic-owned-2")!;
    expect(owned2.outcome).toBe("collapsed");
    expect(owned2.values.collapsed).toEqual([
      { bucket: "secrets", key: "api.token", keptFrom: "lic-owned" },
    ]);
    const floating = rows.find((r) => r.licenseId === "lic-float")!;
    expect(floating.keys).toEqual({
      config: ["cfg.password", "volume"],
      secrets: ["api.token"],
    });
    expect(floating.values).toEqual({ config: { volume: 4 } });
    // The run sealed nothing in plaintext onto the account row.
    const row = await getAccountOverrides(w.db, SLUG, ada.subject);
    expect(row!.payload_json).not.toContain("tok-");
    expect(row!.payload_json).not.toContain("pw-");
  });

  it("6. PUT /licenses/<id>/overrides refuses config and secrets after the run and accepts entitlements, owned and floating (decision 20)", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    await licence(w, "lic-owned", { owner: ada.id });
    await licence(w, "lic-float", { owner: null, email: null });
    const put = (id: string, updates: unknown[], now = NOW) =>
      w.call(
        "PUT",
        `/products/${SLUG}/license/licenses/${id}/overrides`,
        { updates },
        { now },
      );
    // Before the run: still the licence's (the expand phase).
    expect(
      (await put("lic-owned", [{ key: "theme", value: "dark" }])).status,
    ).toBe(200);
    await migrate(w);
    for (const id of ["lic-owned", "lic-float"]) {
      for (const update of [
        { key: "theme", value: "dark" },
        { key: "api.token", value: "tok-x" },
      ]) {
        const res = await put(id, [update], RUN_AT);
        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          code: string;
          message: string;
          fields: string[];
          accountOverrides: { subject: string | null; route: string | null };
        };
        expect(body.code).toBe("bad_request");
        expect(body.fields).toEqual([update.key]);
        if (id === "lic-owned") {
          expect(body.accountOverrides.subject).toBe(ada.subject);
          expect(body.message).toContain(
            `/manage/api/products/${SLUG}/users/${ada.subject}/overrides`,
          );
        } else {
          expect(body.accountOverrides).toEqual({ subject: null, route: null });
          expect(body.message).toContain("needs an account");
        }
      }
      const ok = await put(id, [{ key: "pro", value: true }], RUN_AT);
      expect(ok.status).toBe(200);
      const lic = (await getLicense(w.db, SLUG, id))!;
      expect(JSON.parse(lic.overrides_json!).entitlements.pro.value).toBe(true);
    }
    // The licence page says where they went.
    const detail = (await (
      await w.call(
        "GET",
        `/products/${SLUG}/license/licenses/lic-float`,
        undefined,
        { now: RUN_AT },
      )
    ).json()) as { configOverrides: Record<string, unknown> };
    expect(detail.configOverrides).toMatchObject({
      phase: "moved",
      owned: false,
      ownerSubject: null,
      signUpUrl: `https://key.plrs.im/activate?product=${SLUG}`,
    });
  });

  it("7. an account merge copies the absorbed account's overrides and reports the collisions (§5.5)", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const bo = await account(w.db, "bo@example.com");
    const sealedBo = await sealManagedValue(w.env, SLUG, "api.token", "tok-bo");
    await putAccountOverrides(
      w.db,
      SLUG,
      ada.subject,
      { config: { theme: entry("dark"), volume: entry(3) }, secrets: {} },
      "op-1",
      NOW,
    );
    await putAccountOverrides(
      w.db,
      SLUG,
      bo.subject,
      {
        config: { theme: entry("light"), volume: entry(3), lang: entry("fr") },
        secrets: { "api.token": entry(sealedBo, NOW, "hidden") },
      },
      "op-1",
      NOW,
    );
    const merged = await mergeAccounts(
      { db: w.db, env: w.env, now: NOW, origin: "https://key.plrs.im" },
      {
        survivor: { accountId: ada.id, authenticatedAt: NOW },
        absorbed: { accountId: bo.id, authenticatedAt: NOW },
      },
    );
    expect(merged.ok).toBe(true);
    const survivor = parseAccountOverridePayload(
      (await getAccountOverrides(w.db, SLUG, ada.subject))!.payload_json,
    );
    expect(survivor.config.theme?.value).toBe("dark"); // the survivor's value wins
    expect(survivor.config.lang?.value).toBe("fr"); // copied
    expect(survivor.config.volume?.value).toBe(3); // equal: not a collision
    expect(survivor.secrets["api.token"]?.value).toBe(sealedBo); // copied sealed
    expect(await getAccountOverrides(w.db, SLUG, bo.subject)).toBeNull();
    const audit = await w.db.all<{
      action: string;
      target_id: string;
      summary: string;
    }>(
      "SELECT action, target_id, summary FROM audit WHERE product = ? AND action = 'user.overrides.merge'",
      SLUG,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target_id).toBe(ada.subject);
    expect(audit[0]!.summary).toContain('theme (kept "dark", dropped "light")');
    expect(audit[0]!.summary).not.toContain("volume");
    expect(audit[0]!.summary).not.toContain("tok-bo");
    // A bo-bound device now resolves to the survivor's layer (the alias, D21).
    const key = await licence(w, "lic-bo", { owner: ada.id });
    await activate(w, key, "dev-bo");
    await w.db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = 'dev-bo'",
      bo.subject,
      SLUG,
    );
    const device = (await getDevice(w.db, SLUG, "dev-bo"))!;
    const lic = (await getLicense(w.db, SLUG, "lic-bo"))!;
    expect(await overrideSubject(w.db, SLUG, lic, device)).toBe(ada.subject);
    // Idempotent: a retried hook finds no absorbed row and changes nothing.
    const { accountOverrideStore } =
      await import("../src/services/config/accountOverrideStore.js");
    await accountOverrideStore.merge(
      { db: w.db, env: w.env, now: NOW },
      { product: SLUG, from: bo.subject, to: ada.subject },
    );
    expect(
      parseAccountOverridePayload(
        (await getAccountOverrides(w.db, SLUG, ada.subject))!.payload_json,
      ),
    ).toEqual(survivor);
  });
});

// ── The notice, the run and the dry run ───────────────────────────────────────────────────────

describe("U-03: the migration's guards", () => {
  it("the notice cannot start before the login card (I-07) and the Library (I-11) are flagged live", async () => {
    const w = await world();
    const refused = await startOverrideMigrationNotice(w.db, ACTOR, NOW);
    expect(refused).toEqual({
      ok: false,
      reason: "prerequisites_missing",
      missing: ["loginCard", "library"],
    });
    await setOverrideMigrationPrerequisite(w.db, "loginCard", true, ACTOR, NOW);
    expect(await startOverrideMigrationNotice(w.db, ACTOR, NOW)).toEqual({
      ok: false,
      reason: "prerequisites_missing",
      missing: ["library"],
    });
    // Through the route too.
    const res = await w.call("POST", "/platform/override-migration/notice");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "prerequisites_missing",
    );
    const flagged = await w.call(
      "PUT",
      "/platform/override-migration/prerequisites",
      {
        library: true,
      },
    );
    expect(flagged.status).toBe(200);
    const started = await w.call("POST", "/platform/override-migration/notice");
    expect(started.status).toBe(200);
    const { state } = (await started.json()) as {
      state: { phase: string; notice: { runNotBefore: number } };
    };
    expect(state.phase).toBe("notice");
    expect(state.notice.runNotBefore).toBe(
      NOW + OVERRIDE_MIGRATION_NOTICE_DAYS * DAY,
    );
    // A prerequisite cannot be unflagged under a running notice.
    const unflag = await w.call(
      "PUT",
      "/platform/override-migration/prerequisites",
      {
        loginCard: false,
      },
    );
    expect(unflag.status).toBe(409);
    const activity = await w.db.all<{ action: string }>(
      "SELECT action FROM platform_audit ORDER BY at, id",
    );
    expect(activity.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "overrideMigration.prerequisites",
        "overrideMigration.notice",
      ]),
    );
  });

  it("the run waits for the notice window, needs a step-up, freezes then retires, and resumes", async () => {
    const w = await world({ products: [SLUG, "zeta"] });
    const ada = await account(w.db, "ada@example.com");
    await licence(w, "lic-1", {
      owner: ada.id,
      config: { theme: entry("dark") },
    });
    await licence(w, "lic-z", {
      product: "zeta",
      owner: null,
      email: null,
      config: { volume: entry(1) },
    });
    const run = (now: number, authAt = now) =>
      w.call("POST", "/platform/override-migration/run", undefined, {
        now,
        authAt,
      });
    expect((await run(NOW)).status).toBe(409); // no notice
    await setOverrideMigrationPrerequisite(w.db, "loginCard", true, ACTOR, NOW);
    await setOverrideMigrationPrerequisite(w.db, "library", true, ACTOR, NOW);
    await startOverrideMigrationNotice(w.db, ACTOR, NOW);
    const early = await run(NOW + DAY);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { code: string }).code).toBe(
      "notice_window",
    );
    // A stale sign-in is refused before anything is written.
    const stale = await run(RUN_AT, RUN_AT - 3600);
    expect(stale.status).toBe(403);
    expect((await readOverrideMigrationState(w.db)).runId).toBeNull();

    // One product per call: after the first, licence config is frozen but not yet retired.
    const first = await runOverrideMigration(w.env, w.db, ACTOR, RUN_AT, {
      maxProducts: 1,
    });
    expect(first.ok && first.progress.done).toBe(false);
    let state = await readOverrideMigrationState(w.db);
    expect(state.runStartedAt).toBe(RUN_AT);
    expect(state.runCompletedAt).toBeNull();
    expect(state.productsDone).toEqual([SLUG]);
    const lic = (await getLicense(w.db, SLUG, "lic-1"))!;
    // Not retired yet: the licence layer is still read (below the account's, same value).
    expect(
      (await resolveMergedPayload(w.db, SLUG, lic, null, RUN_AT)).payload.config
        .theme?.value,
    ).toBe("dark");

    const second = await run(RUN_AT);
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      progress: { done: boolean; written: Record<string, number> };
    };
    expect(body.progress.done).toBe(true);
    expect(body.progress.written).toEqual({
      moved: 0,
      collapsed: 0,
      dropped: 1,
    });
    state = await readOverrideMigrationState(w.db);
    expect(state.runCompletedAt).toBe(RUN_AT);
    expect((await run(RUN_AT)).status).toBe(409); // run_completed
    // A rerun of the first product's work writes nothing twice.
    expect(
      (
        await w.db.all(
          "SELECT * FROM override_migration_report WHERE product = ?",
          SLUG,
        )
      ).length,
    ).toBe(1);
    const report = await w.call(
      "GET",
      "/platform/override-migration/report?format=csv&product=zeta",
      undefined,
      { now: RUN_AT },
    );
    expect(report.headers.get("content-type")).toContain("text/csv");
    expect(report.headers.get("content-disposition")).toContain("attachment");
    const csv = await report.text();
    expect(csv.split("\n")[1]).toContain("zeta,lic-z,dropped");
  });

  it("dry run on a production-shaped copy: the inventory and report, nothing written, no secret", async () => {
    // Three products, every licence shape production holds: owned (one and several licences),
    // floating, waiting on its email, entitlements only, empty buckets, a malformed column,
    // sealed and legacy plaintext secrets, a secret-flagged config key, an owner who never
    // contacted the product, an owner whose account row already has a value.
    const w = await world({ products: [SLUG, "beta", "gamma"] });
    const ada = await account(w.db, "ada@example.com");
    const bo = await account(w.db, "bo@example.com");
    const cy = await signIn(
      w.db,
      { issuerKey: "email", subject: "cy@example.com", kind: "email" },
      NOW,
    );
    if (cy.status !== "signed_in") throw new Error(cy.status);
    const sealed = await sealManagedValue(
      w.env,
      SLUG,
      "api.token",
      "tok-PROD-SEALED",
    );
    await putAccountOverrides(
      w.db,
      SLUG,
      bo.subject,
      { config: { theme: entry("solar") }, secrets: {} },
      "op-1",
      NOW,
    );
    await licence(w, "a-1", {
      owner: ada.id,
      config: { theme: entry("dark", NOW - 9) },
      secrets: { "api.token": entry(sealed, NOW - 9) },
    });
    await licence(w, "a-2", {
      owner: ada.id,
      config: { theme: entry("light", NOW - 1), lang: entry("fr") },
    });
    await licence(w, "b-1", {
      owner: bo.id,
      config: { theme: entry("night") },
    });
    await licence(w, "c-1", {
      owner: cy.account.id,
      config: { volume: entry(2) },
    });
    await licence(w, "f-1", {
      owner: null,
      email: null,
      config: { "cfg.password": entry("pw-PROD-PLAIN") },
      secrets: { "api.token": entry("tok-PROD-PLAIN") },
    });
    await licence(w, "w-1", {
      owner: null,
      email: "waiting@example.com",
      config: { volume: entry(5) },
    });
    await licence(w, "e-1", {
      owner: ada.id,
      entitlements: { pro: entry(true) },
    });
    await licence(w, "x-1", { owner: ada.id });
    await licence(w, "beta-1", {
      product: "beta",
      owner: null,
      email: null,
      config: { theme: entry("dark") },
    });
    await licence(w, "beta-2", {
      product: "beta",
      owner: bo.id,
      secrets: { "api.token": entry("tok-BETA") },
    });
    await w.db.run(
      "UPDATE licenses SET overrides_json = '{not json' WHERE product = 'beta' AND id = 'beta-2'",
    );
    await licence(w, "gamma-1", {
      product: "gamma",
      owner: null,
      email: null,
      entitlements: { pro: entry(true) },
    });
    const counts = async () =>
      JSON.stringify(
        await Promise.all(
          [
            "account_overrides",
            "override_migration_report",
            "account_product_subjects",
            "audit",
            "licenses",
          ].map((t) => w.db.all(`SELECT * FROM ${t} ORDER BY 1, 2`)),
        ),
      );
    const before = await counts();

    const dry = await dryRunOverrideMigration(w.db, NOW);

    expect(await counts()).toBe(before); // nothing written, not even cy's subject
    expect(dry.inventory.products).toEqual([
      {
        product: "beta",
        licences: 1,
        owned: 0,
        dropped: 1,
        collapsingAccounts: 0,
      },
      {
        product: SLUG,
        licences: 6,
        owned: 4,
        dropped: 2,
        collapsingAccounts: 1,
      },
    ]);
    expect(dry.inventory.totals).toEqual({ licences: 7, owned: 4, dropped: 3 });
    const byId = new Map(dry.report.map((r) => [r.licenseId, r]));
    expect(byId.get("a-1")).toMatchObject({
      outcome: "collapsed",
      subject: ada.subject,
      values: {
        collapsed: [
          {
            bucket: "config",
            key: "theme",
            keptFrom: "a-2",
            kept: "light",
            lost: "dark",
          },
        ],
      },
    });
    expect(byId.get("a-2")?.outcome).toBe("moved");
    // An existing account value wins over the licence's (devices already received it).
    expect(byId.get("b-1")).toMatchObject({
      outcome: "collapsed",
      values: {
        collapsed: [
          { key: "theme", keptFrom: "account", kept: "solar", lost: "night" },
        ],
      },
    });
    expect(byId.get("c-1")).toMatchObject({
      outcome: "moved",
      subject: null,
      subjectCreatedAtRun: true,
    });
    expect(byId.get("f-1")).toMatchObject({
      outcome: "dropped",
      keys: { config: ["cfg.password"], secrets: ["api.token"] },
      values: {},
    });
    expect(byId.get("w-1")).toMatchObject({
      outcome: "dropped",
      buyerEmail: "waiting@example.com",
    });
    for (const id of ["e-1", "x-1", "beta-2", "gamma-1"])
      expect(byId.has(id)).toBe(false);
    const text = JSON.stringify(dry);
    for (const s of [
      "tok-PROD-SEALED",
      "pw-PROD-PLAIN",
      "tok-PROD-PLAIN",
      "tok-BETA",
      sealed,
    ])
      expect(text).not.toContain(s);
    for (const id of [ada.id, bo.id, cy.account.id])
      expect(text).not.toContain(id);

    // The run writes exactly the report the dry run promised (cy's subject now exists).
    await migrate(w);
    const cySubject = await subjectFor(w.db, cy.account.id, SLUG, NOW);
    const written = await listOverrideMigrationReport(w.db, RUN_AT);
    expect(
      written.map((r) => [r.licenseId, r.outcome, r.subject, r.keys, r.values]),
    ).toEqual(
      dry.report.map((r) => [
        r.licenseId,
        r.outcome,
        r.licenseId === "c-1" ? cySubject : r.subject,
        r.keys,
        r.values,
      ]),
    );
    // The offline tool over a copy of the database (RUNBOOK step 2): the same answer, nothing
    // written, and a copy that predates the U-03 tables works too.
    const raw = (w.db as unknown as { db: { serialize(): Buffer } }).db;
    const copy = new Database(raw.serialize());
    copy.exec(
      "DROP TABLE account_overrides; DROP TABLE override_migration_report; DROP TABLE override_migration;",
    );
    const offline = await dryRunOnCopy({
      sqliteBytes: copy.serialize(),
      now: NOW,
    });
    copy.close();
    expect(offline.changes).toBe(0);
    // Before the run (the copy was taken after it, with the account rows dropped), so compare
    // with a fresh dry run's shape: every licence is reported, with no secret anywhere.
    expect(offline.dryRun.inventory.totals).toEqual({
      licences: 7,
      owned: 4,
      dropped: 3,
    });
    for (const s of [
      "tok-PROD-SEALED",
      "pw-PROD-PLAIN",
      "tok-PROD-PLAIN",
      "tok-BETA",
      sealed,
    ])
      expect(offline.csv + JSON.stringify(offline.dryRun)).not.toContain(s);
    // Through the route: the same dry run (platform admins only).
    const viaRoute = await w.call(
      "POST",
      "/platform/override-migration/dry-run",
      { product: "beta" },
    );
    expect(viaRoute.status).toBe(200);
  });
});

describe("U-03: the run's writes under concurrency", () => {
  it("N1: an account row edited between the plan and the write is re-planned on top of the edit", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    await putAccountOverrides(
      w.db,
      SLUG,
      ada.subject,
      { config: { lang: entry("de") }, secrets: {} },
      "op-1",
      NOW,
    );
    await licence(w, "lic-1", {
      owner: ada.id,
      config: { theme: entry("dark"), volume: entry(3) },
    });
    await setOverrideMigrationPrerequisite(w.db, "loginCard", true, ACTOR, NOW);
    await setOverrideMigrationPrerequisite(w.db, "library", true, ACTOR, NOW);
    await startOverrideMigrationNotice(w.db, ACTOR, NOW);
    // An operator saves Ada's overrides just before the run's write lands.
    const db = racing(w.db, /account_overrides/, () =>
      putAccountOverrides(
        w.db,
        SLUG,
        ada.subject,
        { config: { lang: entry("de"), theme: entry("blue") }, secrets: {} },
        "op-2",
        NOW,
      ),
    );
    const r = await runOverrideMigration(w.env, db, ACTOR, RUN_AT);
    expect(r.ok && r.progress).toMatchObject({
      done: true,
      conflicts: 0,
      written: { moved: 0, collapsed: 1, dropped: 0 },
    });
    // Nothing of the edit is lost: the operator's theme wins, the licence's volume moved.
    const row = parseAccountOverridePayload(
      (await getAccountOverrides(w.db, SLUG, ada.subject))!.payload_json,
    );
    expect(row.config.theme?.value).toBe("blue");
    expect(row.config.lang?.value).toBe("de");
    expect(row.config.volume?.value).toBe(3);
    const [report] = await listOverrideMigrationReport(w.db, RUN_AT);
    expect(report).toMatchObject({
      licenseId: "lic-1",
      outcome: "collapsed",
      values: {
        collapsed: [
          {
            bucket: "config",
            key: "theme",
            keptFrom: "account",
            kept: "blue",
            lost: "dark",
          },
        ],
      },
    });
    // The failed first attempt left no report or audit row behind.
    expect(
      (
        await w.db.all(
          "SELECT * FROM audit WHERE product = ? AND action LIKE 'license.overrides.%'",
          SLUG,
        )
      ).length,
    ).toBe(1);
  });

  it("N2: a second call while another holds the lease is refused and leaves that lease alone; a lost lease stops the call", async () => {
    const w = await world({ products: [SLUG, "zeta"] });
    const ada = await account(w.db, "ada@example.com");
    await licence(w, "lic-1", {
      owner: ada.id,
      config: { theme: entry("dark") },
    });
    await licence(w, "lic-z", {
      product: "zeta",
      owner: null,
      email: null,
      config: { volume: entry(1) },
    });
    await setOverrideMigrationPrerequisite(w.db, "loginCard", true, ACTOR, NOW);
    await setOverrideMigrationPrerequisite(w.db, "library", true, ACTOR, NOW);
    await startOverrideMigrationNotice(w.db, ACTOR, NOW);
    const clock = () => RUN_AT;
    const lease = () =>
      w.db.first<{
        run_lease_until: number | null;
        run_lease_holder: string | null;
      }>(
        "SELECT run_lease_until, run_lease_holder FROM override_migration WHERE id = 'platform'",
      );
    // Another request holds the lease.
    await runOverrideMigration(w.env, w.db, ACTOR, RUN_AT, {
      maxProducts: 1,
      clock,
    });
    await w.db.run(
      "UPDATE override_migration SET run_lease_until = ?, run_lease_holder = 'other' WHERE id = 'platform'",
      RUN_AT + 60,
    );
    expect(
      await runOverrideMigration(w.env, w.db, ACTOR, RUN_AT, { clock }),
    ).toEqual({
      ok: false,
      reason: "run_in_progress",
    });
    expect(await lease()).toEqual({
      run_lease_until: RUN_AT + 60,
      run_lease_holder: "other",
    });

    // Its lease expires; this call takes it over, then loses it to a third request mid-run: it
    // stops before the next product and never clears the new holder's lease.
    await w.db.run(
      "UPDATE override_migration SET run_lease_until = ?, products_done_json = '[]' WHERE id = 'platform'",
      RUN_AT - 1,
    );
    await w.db.run("DELETE FROM override_migration_report");
    const db = racing(w.db, /override_migration_report/, () =>
      w.db.run(
        "UPDATE override_migration SET run_lease_until = ?, run_lease_holder = 'third' WHERE id = 'platform'",
        RUN_AT + 60,
      ),
    );
    const r = await runOverrideMigration(w.env, db, ACTOR, RUN_AT, { clock });
    expect(r.ok && r.progress.productsDone).toEqual([SLUG]);
    expect(r.ok && r.progress.done).toBe(false);
    expect(await lease()).toEqual({
      run_lease_until: RUN_AT + 60,
      run_lease_holder: "third",
    });
  });

  it("N4: a run that starts between the licence PUT's freeze check and its write makes the write refuse", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    await licence(w, "lic-1", {
      owner: ada.id,
      config: { theme: entry("dark") },
    });
    await setOverrideMigrationPrerequisite(w.db, "loginCard", true, ACTOR, NOW);
    await setOverrideMigrationPrerequisite(w.db, "library", true, ACTOR, NOW);
    await startOverrideMigrationNotice(w.db, ACTOR, NOW);
    const before = (await getLicense(w.db, SLUG, "lic-1"))!.overrides_json;
    const db = racing(w.db, /UPDATE licenses SET overrides_json/, async () => {
      await w.db.run(
        "UPDATE override_migration SET run_id = 'ovm_x', run_started_at = ? WHERE id = 'platform'",
        RUN_AT,
      );
    });
    const res = await w.call(
      "PUT",
      `/products/${SLUG}/license/licenses/lic-1/overrides`,
      { updates: [{ key: "theme", value: "light" }] },
      { now: RUN_AT, db },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual([
      "theme",
    ]);
    expect((await getLicense(w.db, SLUG, "lic-1"))!.overrides_json).toBe(
      before,
    );
  });
});

describe("U-03: product deletion", () => {
  it("removes the product's account overrides and migration report, and only the product's", async () => {
    const w = await world({ products: [SLUG, "beta"] });
    const ada = await account(w.db, "ada@example.com");
    const adaBeta = await subjectFor(w.db, ada.id, "beta", NOW);
    for (const [product, subject] of [
      [SLUG, ada.subject],
      ["beta", adaBeta],
    ] as const) {
      await putAccountOverrides(
        w.db,
        product,
        subject,
        { config: { theme: entry("dark") }, secrets: {} },
        "op-1",
        NOW,
      );
      await w.db.run(
        `INSERT INTO override_migration_report
           (product, run_id, license_id, outcome, subject, buyer_email, keys_json, values_json, created_at, expires_at)
         VALUES (?, 'ovm_1', 'lic-1', 'dropped', NULL, 'buyer@example.com', '{"config":["theme"],"secrets":[]}', '{}', ?, ?)`,
        product,
        NOW,
        NOW + 90 * DAY,
      );
    }
    await deleteProduct(w.db, SLUG, NOW);
    const left = async (table: string) =>
      (
        await w.db.all<{ product: string }>(
          `SELECT product FROM ${table} ORDER BY product`,
        )
      ).map((r) => r.product);
    expect(await left("account_overrides")).toEqual(["beta"]);
    expect(await left("override_migration_report")).toEqual(["beta"]);
  });
});

// ── The layer itself ─────────────────────────────────────────────────────────────────────────

describe("U-03: the account override layer", () => {
  it("sits after the licence overrides and before the device's; the ETag follows it", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const key = await licence(w, "lic-1", {
      owner: ada.id,
      config: { theme: entry("dark"), volume: entry(1) },
    });
    const token = await activate(w, key, "dev-1");
    const first = await configDoc(w, token);
    // Expand phase: both layers are read, the account's above the licence's.
    await putAccountOverrides(
      w.db,
      SLUG,
      ada.subject,
      { config: { theme: entry("blue") }, secrets: {} },
      "op-1",
      NOW,
    );
    const second = await configDoc(w, token);
    expect(second.doc.config.theme?.value).toBe("blue");
    expect(second.doc.config.volume?.value).toBe(1);
    expect(second.etag).not.toBe(first.etag);
    // A device override still wins.
    await w.db.run(
      "UPDATE devices SET overrides_json = ? WHERE product = ? AND device_id = 'dev-1'",
      JSON.stringify({
        config: { theme: entry("green") },
        secrets: {},
        entitlements: {},
      }),
      SLUG,
    );
    expect((await configDoc(w, token)).doc.config.theme?.value).toBe("green");
    // Entitlement-only callers never read it, and their answer is unchanged.
    const lic = (await getLicense(w.db, SLUG, "lic-1"))!;
    const full = await resolveMergedPayload(w.db, SLUG, lic, null, NOW);
    const ents = await resolveMergedPayload(w.db, SLUG, lic, null, NOW, {
      entitlementsOnly: true,
    });
    expect(ents.payload.entitlements).toEqual(full.payload.entitlements);
  });

  it("applies outside the licence: a licence-less signed-in device gets its account's layer", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    await putAccountOverrides(
      w.db,
      SLUG,
      ada.subject,
      { config: { theme: entry("blue") }, secrets: {} },
      "op-1",
      NOW,
    );
    const device = {
      product: SLUG,
      status: "authorized",
      license_id: "",
      subject: ada.subject,
    };
    expect(await overrideSubject(w.db, SLUG, null, device)).toBe(ada.subject);
    const merged = await resolveMergedPayload(
      w.db,
      SLUG,
      null,
      device as never,
      NOW,
    );
    expect(merged.payload.config.theme?.value).toBe("blue");
    // A malformed or unknown binding gives no layer.
    expect(
      await overrideSubject(w.db, SLUG, null, { ...device, subject: "nope" }),
    ).toBeNull();
    expect(
      await overrideSubject(w.db, SLUG, null, { ...device, status: "revoked" }),
    ).toBeNull();
  });
});

describe("U-03: Remove from my library drops the account's layer for that licence (S-24 D19)", () => {
  it("a device bound to the removing account loses its layer for the licence; other accounts keep theirs; re-adding restores it", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const bo = await account(w.db, "bo@example.com");
    const key = await licence(w, "lic-ada", {
      owner: ada.id,
      email: "ada@example.com",
    });
    const tAda = await activate(w, key, "dev-ada");
    const tBo = await activate(w, key, "dev-bo");
    await setDeviceSubject(w.env, w.db, SLUG, "dev-ada", ada.subject);
    await setDeviceSubject(w.env, w.db, SLUG, "dev-bo", bo.subject);
    for (const [subject, theme] of [
      [ada.subject, "ada-blue"],
      [bo.subject, "bo-green"],
    ] as const)
      await putAccountOverrides(
        w.db,
        SLUG,
        subject,
        { config: { theme: entry(theme) }, secrets: {} },
        "op-1",
        NOW,
      );
    expect((await configDoc(w, tAda)).doc.config.theme?.value).toBe("ada-blue");

    const ctx = {
      db: w.db,
      env: w.env,
      now: NOW,
      origin: "https://key.plrs.im",
    };
    expect(
      (
        await detachLicense(ctx, {
          accountId: ada.id,
          product: SLUG,
          licenseId: "lic-ada",
        })
      ).ok,
    ).toBe(true);
    // The licence keeps its email (assigned, waiting), so it is not floating; but for Ada's
    // devices it is as if it were: no account layer from it, and no owner to fall back to.
    expect((await configDoc(w, tAda)).doc.config.theme?.value).toBe("system");
    expect((await configDoc(w, tBo)).doc.config.theme?.value).toBe("bo-green");

    // Adding it back with its key lifts the block.
    const back = await attachLicense(ctx, {
      accountId: ada.id,
      product: SLUG,
      licenseId: "lic-ada",
      via: "key",
    });
    expect(back.ok).toBe(true);
    expect((await configDoc(w, tAda)).doc.config.theme?.value).toBe("ada-blue");
  });
});

// ── The console editor ───────────────────────────────────────────────────────────────────────

describe("U-03: GET and PUT users/<subject>/overrides", () => {
  it("edits config and secrets for one subject, seals secrets, refuses flags, audits key names only", async () => {
    const w = await world({ identity: false });
    const ada = await account(w.db, "ada@example.com");
    await licence(w, "lic-1", { owner: ada.id });
    const path = `/products/${SLUG}/users/${ada.subject}/overrides`;
    const empty = (await (await w.call("GET", path)).json()) as Record<
      string,
      unknown
    >;
    expect(empty).toMatchObject({
      subject: ada.subject,
      configOn: true,
      overrides: { config: {}, secrets: {} },
      updatedAt: null,
      licenseLayerRetired: false,
    });
    const flag = await w.call("PUT", path, {
      updates: [{ key: "pro", value: true }],
    });
    expect(flag.status).toBe(422);
    expect(((await flag.json()) as { fields: string[] }).fields[0]).toContain(
      "entitlement overrides stay on the license",
    );
    const bad = await w.call("PUT", path, {
      updates: [{ key: "volume", value: "loud" }],
    });
    expect(bad.status).toBe(422);
    const ok = await w.call("PUT", path, {
      updates: [
        { key: "theme", value: "dark", state: "enforced" },
        { key: "api.token", value: "tok-EDITOR" },
        { key: "cfg.password", value: "pw-EDITOR" },
      ],
    });
    expect(ok.status).toBe(200);
    const stored = (await getAccountOverrides(w.db, SLUG, ada.subject))!;
    expect(stored.updated_by).toBe("op-1");
    expect(stored.payload_json).not.toContain("tok-EDITOR");
    expect(stored.payload_json).not.toContain("pw-EDITOR");
    const got = await w.call("GET", path);
    const text = await got.text();
    expect(text).not.toContain("tok-EDITOR");
    expect(text).not.toContain("pw-EDITOR");
    expect(JSON.parse(text).overrides).toMatchObject({
      config: { theme: { value: "dark" }, "cfg.password": { value: "" } },
      secrets: { "api.token": { configured: true } },
    });
    const audit = await w.db.all<{ action: string; summary: string }>(
      "SELECT action, summary FROM audit WHERE product = ? AND action = 'user.overrides'",
      SLUG,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toContain("theme, api.token, cfg.password");
    expect(audit[0]!.summary).not.toContain("dark");
    // The key-entry device of Ada's licence does NOT receive her secrets.
    const key = await licence(w, "lic-2", { owner: ada.id });
    const token = await activate(w, key, "dev-1");
    const { doc } = await configDoc(w, token);
    expect(doc.secrets["api.token"]).toBeUndefined();
    expect(doc.config["cfg.password"]).toBeUndefined();
    // A device signed in as Ada gets them, opened.
    const key2 = await licence(w, "lic-3", { owner: ada.id });
    const token2 = await activate(w, key2, "dev-2");
    await w.db.run(
      "UPDATE devices SET subject = ? WHERE product = ? AND device_id = 'dev-2'",
      ada.subject,
      SLUG,
    );
    const signed = (await configDoc(w, token2)).doc;
    expect(signed.secrets["api.token"]?.value).toBe("tok-EDITOR");
    expect(signed.config["cfg.password"]?.value).toBe("pw-EDITOR");
    // Clearing every key removes the row.
    await w.call("PUT", path, {
      updates: [
        { key: "theme" },
        { key: "api.token" },
        { key: "cfg.password" },
      ],
    });
    expect(await getAccountOverrides(w.db, SLUG, ada.subject)).toBeNull();
    // An unknown subject is a 404, like every Users route.
    expect(
      (
        await w.call(
          "GET",
          `/products/${SLUG}/users/ps_AAAAAAAAAAAAAAAAAAAAAA/overrides`,
        )
      ).status,
    ).toBe(404);
  });
});

// ── The OIDC provisioning writer and the nightly job ─────────────────────────────────────────

describe("U-03: provisioned secrets and the nightly step", () => {
  it("applyProvisionedAccountSecrets rewrites only the declared keys, sealed, keeping an operator's", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    await putAccountOverrides(
      w.db,
      SLUG,
      ada.subject,
      {
        config: { theme: entry("dark") },
        secrets: { "api.token": entry("old") },
      },
      "op-1",
      NOW,
    );
    await applyProvisionedAccountSecrets(
      w.env,
      w.db,
      SLUG,
      ada.id,
      { "proxy.url": entry("https://proxy.example/u/ada", NOW, "hidden") },
      new Set(["proxy.url"]),
      NOW,
    );
    let row = parseAccountOverridePayload(
      (await getAccountOverrides(w.db, SLUG, ada.subject))!.payload_json,
    );
    expect(row.config.theme?.value).toBe("dark");
    expect(row.secrets["api.token"]?.value).toBe("old");
    expect(String(row.secrets["proxy.url"]?.value)).not.toContain(
      "proxy.example",
    );
    // The claim disappeared: the declared key goes, nothing else does.
    await applyProvisionedAccountSecrets(
      w.env,
      w.db,
      SLUG,
      ada.id,
      {},
      new Set(["proxy.url"]),
      NOW,
    );
    row = parseAccountOverridePayload(
      (await getAccountOverrides(w.db, SLUG, ada.subject))!.payload_json,
    );
    expect(Object.keys(row.secrets)).toEqual(["api.token"]);
  });

  it("provisioning writes only while the signing-in identity is linked to the owner account", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    const args = [
      w.env,
      w.db,
      SLUG,
      ada.id,
      { "proxy.url": entry("https://proxy.example/prev", NOW, "hidden") },
      new Set(["proxy.url"]),
      NOW,
    ] as const;
    // The previous owner's OIDC sub is not linked to the current owner: nothing is written.
    await applyProvisionedAccountSecrets(...args, "oidc-sub-previous-owner");
    expect(await getAccountOverrides(w.db, SLUG, ada.subject)).toBeNull();
    await w.db.run(
      `INSERT INTO account_links (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified, display_name, amr_json, created_at, last_used_at)
       VALUES ('lnk-oidc', ?, 'iss', '', 'oidc-sub-ada', 'oidc', NULL, 0, NULL, '[]', ?, ?)`,
      ada.id,
      NOW,
      NOW,
    );
    await applyProvisionedAccountSecrets(...args, "oidc-sub-ada");
    expect(await getAccountOverrides(w.db, SLUG, ada.subject)).not.toBeNull();
  });

  it("refreshes the inventory daily until the run, purges the report after 90 days, then empties the columns", async () => {
    const w = await world();
    const ada = await account(w.db, "ada@example.com");
    await licence(w, "lic-owned", {
      owner: ada.id,
      config: { theme: entry("dark") },
      entitlements: { pro: entry(true) },
    });
    await licence(w, "lic-float", {
      owner: null,
      email: null,
      config: { volume: entry(2) },
    });
    await overrideMigrationNightly(w.db, NOW);
    let state = await readOverrideMigrationState(w.db);
    expect(state.inventory?.totals).toEqual({
      licences: 2,
      owned: 1,
      dropped: 1,
    });
    // A customer attaches the floating licence: the count falls the next day.
    await w.db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = 'lic-float'",
      ada.id,
      SLUG,
    );
    await overrideMigrationNightly(w.db, NOW + DAY);
    state = await readOverrideMigrationState(w.db);
    expect(state.inventory?.totals).toEqual({
      licences: 2,
      owned: 2,
      dropped: 0,
    });
    await w.db.run(
      "UPDATE licenses SET account_id = NULL WHERE id = 'lic-float'",
    );

    await migrate(w);
    const afterWindow = RUN_AT + OVERRIDE_MIGRATION_REPORT_DAYS * DAY;
    expect((await listOverrideMigrationReport(w.db, RUN_AT)).length).toBe(2);
    await overrideMigrationNightly(w.db, afterWindow - 1);
    expect(
      (await w.db.all("SELECT * FROM override_migration_report")).length,
    ).toBe(2);
    const lic = (await getLicense(w.db, SLUG, "lic-owned"))!;
    expect(JSON.parse(lic.overrides_json!).config.theme).toBeDefined();
    await overrideMigrationNightly(w.db, afterWindow);
    expect(
      (await w.db.all("SELECT * FROM override_migration_report")).length,
    ).toBe(0);
    for (const id of ["lic-owned", "lic-float"]) {
      const l = (await getLicense(w.db, SLUG, id))!;
      const o = JSON.parse(l.overrides_json!);
      expect(o.config).toEqual({});
      expect(o.secrets).toEqual({});
      if (id === "lic-owned") expect(o.entitlements.pro.value).toBe(true);
    }
    expect((await readOverrideMigrationState(w.db)).columnsEmptiedAt).toBe(
      afterWindow,
    );
  });
});
