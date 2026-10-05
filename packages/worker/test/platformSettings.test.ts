// A-13: the platform settings store (`src/core/platformSettings.ts`), its admin API
// (`src/admin/handlers/platformSettings.ts`) and the four settings' readers.

import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/types.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import {
  invalidatePlatformSettings,
  LAZY_DELTA_MAX_BYTES_CEILING,
  PLATFORM_SETTINGS,
  platformSetting,
  platformSettingDef,
  platformSettings,
  refreshPlatformSettings,
  resolveSetting,
  isHardOffVar,
  settingConfirmLevel,
  unrecognisedCeilingVars,
  validateSettingValue,
  type PlatformSettingDef,
} from "../src/core/platformSettings.js";
import { lazyDeltasOn } from "../src/core/deltaDemand.js";
import { effectiveBlobGcSettings } from "../src/core/blobGc.js";
import { listPlatformAudit } from "../src/repo.js";
import { makeTestDb } from "./helpers.js";
import { PLATFORM_INVENTORY } from "../src/platformInventory.generated.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";

const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";

function adminEnv(extra: Record<string, unknown> = {}): Env {
  return Object.assign(makeEnv(new KvMock(), []), {
    ADMIN_SESSION_SECRET: ADMIN_SECRET,
    PLATFORM_ADMIN_GROUP: PLATFORM_GROUP,
    ...extra,
  }) as Env;
}

function def(key: string): PlatformSettingDef {
  return platformSettingDef(key)!;
}

async function call(
  env: Env,
  db: Db,
  path: string,
  opts: {
    method?: string;
    groups?: string[];
    body?: unknown;
    csrf?: boolean;
  } = {},
): Promise<{ status: number; body: Record<string, any>; text: string }> {
  const { token, session } = await issueSession(
    env,
    {
      sub: "admin-1",
      name: "Ada Admin",
      email: "admin@example.com",
      groups: opts.groups ?? [PLATFORM_GROUP],
    },
    NOW,
  );
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
  };
  if (method !== "GET" && opts.csrf !== false)
    headers[CSRF_HEADER] = session.csrf;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`https://key.plrs.im/manage${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }) as unknown as Request;
  const res = await handleAdmin(req, env, db, path.split("?")[0]!, {
    now: NOW,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: JSON.parse(text) as Record<string, any>,
    text,
  };
}

async function storeRow(db: Db, key: string, value: unknown, version = 1) {
  await db.run(
    "INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, 'seed')",
    key,
    JSON.stringify(value),
    version,
    NOW,
  );
}

/** A Db that counts the statements it was asked to run. */
function countingDb(inner: Db): { db: Db; count: () => number } {
  let n = 0;
  const db: Db = {
    all: (sql, ...p) => (n++, inner.all(sql, ...p)),
    first: (sql, ...p) => (n++, inner.first(sql, ...p)),
    run: (sql, ...p) => (n++, inner.run(sql, ...p)),
    runChanges: (sql, ...p) => (n++, inner.runChanges(sql, ...p)),
    batch: (s) => (n++, inner.batch(s)),
  };
  return { db, count: () => n };
}

// ── The registry ─────────────────────────────────────────────────────────────────────────────

describe("PLATFORM_SETTINGS", () => {
  it("declares exactly the four background-job settings", () => {
    expect(PLATFORM_SETTINGS.map((d) => d.key).sort()).toEqual([
      "BLOB_GC_GRACE_DAYS",
      "BLOB_GC_MODE",
      "LAZY_DELTAS",
      "LAZY_DELTA_MAX_BYTES",
    ]);
    // Kill switches are `ceiling`, tunables `runtime` (moving one is a THREAT-MODEL §9 trigger).
    expect(
      Object.fromEntries(PLATFORM_SETTINGS.map((d) => [d.key, d.precedence])),
    ).toEqual({
      LAZY_DELTAS: "ceiling",
      BLOB_GC_MODE: "ceiling",
      LAZY_DELTA_MAX_BYTES: "runtime",
      BLOB_GC_GRACE_DAYS: "runtime",
    });
  });

  it("never declares an origin, privilege root, IdP, gate, key, session, limit, retention or bucket (S-13 §8.2)", () => {
    // Deny by construction: any of these becoming runtime-editable would let a console session
    // widen what it can do or make itself permanent (THREAT-MODEL AT-2).
    const DENIED = [
      "BLOB_ORIGIN",
      "CONSOLE_ORIGIN",
      "PLATFORM_ADMIN_GROUP",
      "PLATFORM_OIDC_ISSUER",
      "PLATFORM_OIDC_CLIENT_ID",
      "PLATFORM_OIDC_CLIENT_SECRET",
      "ADMIN_OIDC_ISSUER",
      "ADMIN_OIDC_CLIENT_ID",
      "ADMIN_OIDC_CLIENT_SECRET",
      "OIDC_ISSUER_ALLOWLIST",
      "PLATFORM_KEK",
      "PLATFORM_KEK_KEYS",
      "PLATFORM_KEK_ACTIVE",
      "PLATFORM_KEK_ID",
      "KEY_HASH_PEPPER",
      "ADMIN_SESSION_SECRET",
      "PORTAL_SESSION_SECRET",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
      "R2_ACCOUNT_ID",
      "R2_PARENT_ACCESS_KEY_ID",
      "R2_PARENT_SECRET_ACCESS_KEY",
      "BLOBS_BUCKET_NAME",
      "PKEY_ENVIRONMENT",
      "PKEY_RELEASE_TAG",
      "PKEY_GIT_SHA",
      "CF_ANALYTICS_TOKEN",
      "ADMIN_SESSION_TTL_SECONDS",
      "AUDIT_RETENTION_SECONDS",
      "BLOB_LOCK_AGE_SECONDS",
    ];
    const DENIED_PATTERNS = [
      /ORIGIN/,
      /OIDC/,
      /KEK/,
      /SECRET/,
      /PEPPER/,
      /_KEY/,
      /TOKEN/,
      /ADMIN/,
      /GROUP/,
      /ALLOWLIST/,
      /SESSION/,
      /TTL/,
      /RATE|LIMIT/,
      /RETENTION/,
      /BUCKET/,
    ];
    for (const d of PLATFORM_SETTINGS) {
      for (const name of [d.key, d.varName]) {
        expect(DENIED).not.toContain(name);
        for (const p of DENIED_PATTERNS) expect(name).not.toMatch(p);
      }
    }
  });

  it("bounds the size cap at the measured 32 MiB ceiling: a runtime value may only lower it", () => {
    const cap = def("LAZY_DELTA_MAX_BYTES");
    expect(cap.kind === "integer" && cap.max).toBe(
      LAZY_DELTA_MAX_BYTES_CEILING,
    );
    expect(cap.defaultValue).toBe(LAZY_DELTA_MAX_BYTES_CEILING);
    expect(validateSettingValue(cap, 33_554_432)).toBe(33_554_432);
    expect(validateSettingValue(cap, 2_097_152)).toBe(2_097_152);
    expect(validateSettingValue(cap, 33_554_433)).toBeUndefined();
    expect(validateSettingValue(cap, 1_048_575)).toBeUndefined();
    expect(validateSettingValue(cap, "2097152")).toBeUndefined();
    expect(validateSettingValue(cap, 2_097_152.5)).toBeUndefined();
    const grace = def("BLOB_GC_GRACE_DAYS");
    expect(validateSettingValue(grace, 0)).toBeUndefined();
    expect(validateSettingValue(grace, 1)).toBe(1);
    expect(validateSettingValue(def("LAZY_DELTAS"), "yes")).toBeUndefined();
    expect(validateSettingValue(def("LAZY_DELTAS"), "on")).toBe("on");
  });

  it("assigns ADMIN.md §5.2 confirm levels per direction", () => {
    expect(settingConfirmLevel(def("LAZY_DELTAS"), "off", "on")).toBe("L1");
    expect(settingConfirmLevel(def("LAZY_DELTAS"), "on", "off")).toBe("L0");
    expect(settingConfirmLevel(def("BLOB_GC_MODE"), "off", "on")).toBe("L1");
    expect(settingConfirmLevel(def("BLOB_GC_GRACE_DAYS"), 30, 1)).toBe("L1");
    expect(settingConfirmLevel(def("BLOB_GC_GRACE_DAYS"), 1, 30)).toBe("L0");
    expect(
      settingConfirmLevel(def("LAZY_DELTA_MAX_BYTES"), 33_554_432, 2_097_152),
    ).toBe("L0");
    // None of the four is L2+: the `{ confirm }` echo is reserved for future settings.
    for (const d of PLATFORM_SETTINGS)
      expect(
        Object.values(d.confirm).every((l) => l === "L0" || l === "L1"),
      ).toBe(true);
  });
});

// ── Precedence ───────────────────────────────────────────────────────────────────────────────

describe("resolveSetting", () => {
  const row = (value: unknown) => ({
    value,
    version: 1,
    updatedAt: NOW,
    updatedBy: "admin-1",
  });

  it("runtime: a valid D1 value, then [vars], then the code default", () => {
    const d = def("BLOB_GC_GRACE_DAYS");
    expect(resolveSetting(d, "10", row(3), true)).toMatchObject({
      value: 3,
      source: "runtime",
    });
    expect(resolveSetting(d, "10", undefined, true)).toMatchObject({
      value: 10,
      source: "deploy",
    });
    expect(resolveSetting(d, undefined, undefined, true)).toMatchObject({
      value: 30,
      source: "default",
    });
  });

  it("runtime: a stored value outside the bounds is never applied", () => {
    const d = def("LAZY_DELTA_MAX_BYTES");
    const r = resolveSetting(d, "16777216", row(64 * 1024 * 1024), true);
    expect(r).toMatchObject({ value: 16_777_216, source: "deploy" });
    expect(r.stored?.valid).toBe(false);
    expect(resolveSetting(d, undefined, row("big"), true)).toMatchObject({
      value: LAZY_DELTA_MAX_BYTES_CEILING,
      source: "default",
    });
  });

  it("ceiling: [vars] = off is a hard off whatever D1 says", () => {
    const d = def("LAZY_DELTAS");
    expect(resolveSetting(d, "off", row("on"), true)).toMatchObject({
      value: "off",
      source: "deploy",
      forcedOff: true,
    });
    expect(resolveSetting(d, " OFF ", row("on"), true).forcedOff).toBe(true);
    expect(
      resolveSetting(def("BLOB_GC_MODE"), "off", row("on"), true),
    ).toMatchObject({ value: "off", forcedOff: true });
  });

  it("ceiling: otherwise D1 decides, and `runtime` with no row is the code default", () => {
    const d = def("LAZY_DELTAS");
    expect(resolveSetting(d, "runtime", row("on"), true)).toMatchObject({
      value: "on",
      source: "runtime",
    });
    expect(resolveSetting(d, "on", row("off"), true)).toMatchObject({
      value: "off",
      source: "runtime",
    });
    expect(resolveSetting(d, "runtime", undefined, true)).toMatchObject({
      value: "off",
      source: "default",
    });
    // A deploy-time `on` (a hand deploy, the test lanes) still means on when no row exists.
    expect(resolveSetting(d, "on", undefined, true)).toMatchObject({
      value: "on",
      source: "deploy",
    });
    expect(
      resolveSetting(def("BLOB_GC_MODE"), undefined, undefined, true),
    ).toMatchObject({ value: "on", source: "default" });
  });

  it("an unreadable store turns a kill switch off and leaves a tunable to [vars]", () => {
    expect(
      resolveSetting(def("BLOB_GC_MODE"), undefined, undefined, false),
    ).toMatchObject({ value: "off", source: "failsafe" });
    expect(
      resolveSetting(def("BLOB_GC_GRACE_DAYS"), "7", undefined, false),
    ).toMatchObject({ value: 7, source: "deploy" });
  });
});

describe("platformSetting / platformSettings", () => {
  it("answers a [vars] hard off without reading the database", async () => {
    const counted = countingDb(makeTestDb());
    expect(
      await platformSetting({ LAZY_DELTAS: "off" }, counted.db, "LAZY_DELTAS"),
    ).toBe("off");
    expect(counted.count()).toBe(0);
  });

  it("caches the table per isolate for 30 s; refresh and invalidate re-read it", async () => {
    const db = makeTestDb();
    const env = { LAZY_DELTAS: "runtime" };
    expect(await platformSetting(env, db, "LAZY_DELTAS")).toBe("off");
    await storeRow(db, "LAZY_DELTAS", "on");
    // Still the cached read.
    expect(await platformSetting(env, db, "LAZY_DELTAS")).toBe("off");
    await refreshPlatformSettings(env, db);
    expect(await platformSetting(env, db, "LAZY_DELTAS")).toBe("on");
    await db.run("UPDATE platform_settings SET value_json = '\"off\"'");
    invalidatePlatformSettings(env, db);
    expect(await platformSetting(env, db, "LAZY_DELTAS")).toBe("off");
  });

  it("ignores a row whose key is not in the registry", async () => {
    const db = makeTestDb();
    await storeRow(db, "PLATFORM_ADMIN_GROUP", "attackers");
    const all = await platformSettings({ PLATFORM_ADMIN_GROUP: "admins" }, db);
    expect(Object.keys(all).sort()).toEqual(
      PLATFORM_SETTINGS.map((d) => d.key).sort(),
    );
  });

  it("falls back fail-safe when the table is missing", async () => {
    const inner = makeTestDb();
    const broken: Db = {
      all: () => Promise.reject(new Error("no such table: platform_settings")),
      first: (sql, ...p) => inner.first(sql, ...p),
      run: (sql, ...p) => inner.run(sql, ...p),
      runChanges: (sql, ...p) => inner.runChanges(sql, ...p),
      batch: (st) => inner.batch(st),
    };
    const all = await platformSettings({}, broken);
    expect(all.BLOB_GC_MODE).toMatchObject({
      value: "off",
      source: "failsafe",
    });
    expect(all.LAZY_DELTAS.value).toBe("off");
    expect(all.BLOB_GC_GRACE_DAYS).toMatchObject({ value: 30 });
  });
});

describe("the four settings' readers", () => {
  it("lazyDeltasOn: a console `on` applies under `runtime`, never under a deploy-time `off`", async () => {
    const db = makeTestDb();
    await storeRow(db, "LAZY_DELTAS", "on");
    expect(await lazyDeltasOn({ LAZY_DELTAS: "runtime" }, db)).toBe(true);
    expect(await lazyDeltasOn({}, db)).toBe(true);
    expect(await lazyDeltasOn({ LAZY_DELTAS: "off" }, db)).toBe(false);
  });

  it("LAZY_DELTA_MAX_BYTES: a console value lowers the cap; [vars] stays the fallback", async () => {
    const db = makeTestDb();
    const env = { LAZY_DELTA_MAX_BYTES: "33554432" };
    expect(await platformSetting(env, db, "LAZY_DELTA_MAX_BYTES")).toBe(
      33_554_432,
    );
    await storeRow(db, "LAZY_DELTA_MAX_BYTES", 4_194_304);
    invalidatePlatformSettings(env, db);
    expect(await platformSetting(env, db, "LAZY_DELTA_MAX_BYTES")).toBe(
      4_194_304,
    );
  });

  it("effectiveBlobGcSettings: the collector's switch and grace come from the store", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    expect(await effectiveBlobGcSettings(env, db)).toEqual({
      enabled: true,
      graceSeconds: 30 * 86400,
    });
    await storeRow(db, "BLOB_GC_MODE", "off");
    await storeRow(db, "BLOB_GC_GRACE_DAYS", 2);
    invalidatePlatformSettings(env, db);
    expect(await effectiveBlobGcSettings(env, db)).toEqual({
      enabled: false,
      graceSeconds: 2 * 86400,
    });
    // A deploy-time off wins over a console on.
    await db.run(
      "UPDATE platform_settings SET value_json = '\"on\"' WHERE key = 'BLOB_GC_MODE'",
    );
    const forced = adminEnv({ BLOB_GC_MODE: "off" });
    expect((await effectiveBlobGcSettings(forced, db)).enabled).toBe(false);
  });
});

// ── The admin API ────────────────────────────────────────────────────────────────────────────

describe("GET /manage/api/platform/settings", () => {
  it("is platform-admin only", async () => {
    const res = await call(adminEnv(), makeTestDb(), "/api/platform/settings", {
      groups: ["product-admins"],
    });
    expect(res.status).toBe(403);
  });

  it("lists the editable four with source and version, and the read-only inventory", async () => {
    const db = makeTestDb();
    await storeRow(db, "BLOB_GC_GRACE_DAYS", 14, 3);
    const env = adminEnv({
      LAZY_DELTAS: "runtime",
      BLOB_ORIGIN: "https://dl.example",
      PLATFORM_OIDC_ISSUER: "https://id.example",
      OIDC_ISSUER_ALLOWLIST: "id.example, login.example",
    });
    const { status, body } = await call(env, db, "/api/platform/settings");
    expect(status).toBe(200);
    const byKey = Object.fromEntries(
      (body.settings as any[]).map((s) => [s.key, s]),
    );
    expect(byKey.BLOB_GC_GRACE_DAYS).toMatchObject({
      value: 14,
      source: "runtime",
      version: 3,
      min: 1,
      max: 365,
      stored: { value: 14, valid: true, updatedBy: "seed" },
    });
    expect(byKey.LAZY_DELTAS).toMatchObject({
      value: "off",
      source: "default",
      deployValue: "runtime",
      version: 0,
      precedence: "ceiling",
      scripts: ["main", "deltas"],
    });
    expect(body.storeAvailable).toBe(true);
    expect(body.propagationSeconds).toBe(30);
    const deploy = Object.fromEntries(
      (body.deployTime as any[]).map((v) => [v.name, v.value]),
    );
    expect(deploy.BLOB_ORIGIN).toBe("https://dl.example");
    expect(deploy.PLATFORM_ADMIN_GROUP).toBe(PLATFORM_GROUP);
    expect(deploy.OIDC_ISSUER_ALLOWLIST).toEqual([
      "id.example",
      "login.example",
    ]);
  });

  it("reports secrets as presence only, never a value", async () => {
    const env = adminEnv({
      KEY_HASH_PEPPER: "pepper-SENTINEL-1234567890",
      PLATFORM_OIDC_CLIENT_SECRET: "client-SENTINEL-abcdef",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----SENTINEL",
    });
    const { body, text } = await call(
      env,
      makeTestDb(),
      "/api/platform/settings",
    );
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain(ADMIN_SECRET);
    expect(text).not.toContain(env.PLATFORM_KEK as string);
    const secrets = Object.fromEntries(
      (body.secrets as any[]).map((s) => [s.name, s]),
    );
    expect(secrets.KEY_HASH_PEPPER).toEqual({
      name: "KEY_HASH_PEPPER",
      set: true,
    });
    expect(secrets.ADMIN_SESSION_SECRET.set).toBe(true);
    expect(secrets.GITHUB_WEBHOOK_SECRET.set).toBe(false);
    for (const s of body.secrets as any[])
      expect(Object.keys(s).sort()).toEqual(["name", "set"]);
  });

  it("ST-02: reports every inventory var and secret, and never a secret's value", async () => {
    const env = adminEnv({
      PKG_ORIGIN: "https://pkg.example",
      EMAIL_PRODUCT_DAILY_CAP: "250",
      PLATFORM_REPOSITORY: "owner/repo",
      REGISTRY_TOKEN_KEY: "registry-SENTINEL",
      PLATFORM_ASC_API_KEY: '{"p8":"SENTINEL"}',
    });
    const { body, text } = await call(
      env,
      makeTestDb(),
      "/api/platform/settings",
    );
    expect(text).not.toContain("SENTINEL");
    const reported = new Set([
      ...(body.deployTime as any[]).map((v) => v.name),
      ...(body.secrets as any[]).map((s) => s.name),
      ...(body.settings as any[]).map((s) => s.key),
    ]);
    for (const e of PLATFORM_INVENTORY)
      if (e.kind !== "binding") expect(reported.has(e.name), e.name).toBe(true);
    const secretNames = PLATFORM_INVENTORY.filter(
      (e) => e.kind === "secret",
    ).map((e) => e.name);
    expect((body.secrets as any[]).map((s) => s.name)).toEqual(secretNames);
    for (const v of body.deployTime as any[])
      expect(secretNames, v.name).not.toContain(v.name);
    const deploy = Object.fromEntries(
      (body.deployTime as any[]).map((v) => [v.name, v]),
    );
    expect(deploy.PKG_ORIGIN).toEqual({
      name: "PKG_ORIGIN",
      area: "delivery",
      value: "https://pkg.example",
    });
    expect(deploy.EMAIL_PRODUCT_DAILY_CAP.value).toBe("250");
    expect(deploy.PLATFORM_REPOSITORY.area).toBe("deployment");
    const secrets = Object.fromEntries(
      (body.secrets as any[]).map((s) => [s.name, s.set]),
    );
    expect(secrets.REGISTRY_TOKEN_KEY).toBe(true);
    expect(secrets.PLATFORM_ASC_API_KEY).toBe(true);
    expect(secrets.PLATFORM_STEAM_PUBLISHER_KEY).toBe(false);
  });

  it("warns while the console borrows the platform client, on a set PLATFORM_KEK_ID and on an unset PORTAL_SESSION_SECRET", async () => {
    const env = adminEnv({
      PLATFORM_OIDC_ISSUER: "https://id.example",
      PLATFORM_OIDC_CLIENT_ID: "platform-client",
      ADMIN_OIDC_ISSUER: "https://id.example",
      PLATFORM_KEK_ID: "default",
    });
    const { body } = await call(env, makeTestDb(), "/api/platform/settings");
    expect((body.warnings as any[]).map((w) => w.code).sort()).toEqual([
      "console_oidc_shared",
      "kek_id_set",
      "portal_session_secret_unset",
    ]);
    // I-03: a half-set admin trio is not a console client; the warning names what is missing.
    const shared = (body.warnings as any[]).find(
      (w) => w.code === "console_oidc_shared",
    );
    expect(shared.names).toEqual(["ADMIN_OIDC_CLIENT_ID"]);
    const deploy = Object.fromEntries(
      (body.deployTime as any[]).map((v) => [v.name, v]),
    );
    // Each trio reports its own value; nothing is attributed across names any more.
    expect(deploy.ADMIN_OIDC_ISSUER).toEqual({
      name: "ADMIN_OIDC_ISSUER",
      area: "identity",
      value: "https://id.example",
    });
    expect(deploy.ADMIN_OIDC_CLIENT_ID.value).toBeNull();
    expect(deploy.PLATFORM_OIDC_CLIENT_ID.value).toBe("platform-client");

    const clean = adminEnv({
      PLATFORM_OIDC_ISSUER: "https://id.example",
      PLATFORM_OIDC_CLIENT_ID: "platform-client",
      ADMIN_OIDC_ISSUER: "https://id.example",
      ADMIN_OIDC_CLIENT_ID: "console-client",
      PORTAL_SESSION_SECRET: "portal-secret",
    });
    const ok = await call(clean, makeTestDb(), "/api/platform/settings");
    expect(ok.body.warnings).toEqual([]);
  });
});

describe("PATCH / DELETE /manage/api/platform/settings/:key", () => {
  it("writes with expectedVersion, 409s on a stale version, and audits before and after", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    const path = "/api/platform/settings/BLOB_GC_GRACE_DAYS";
    const first = await call(env, db, path, {
      method: "PATCH",
      body: { value: 7, expectedVersion: 0 },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      value: 7,
      source: "runtime",
      version: 1,
      stored: { updatedBy: "admin-1" },
    });
    // The writer's isolate sees its own write at once.
    expect(await platformSetting(env, db, "BLOB_GC_GRACE_DAYS")).toBe(7);

    const stale = await call(env, db, path, {
      method: "PATCH",
      body: { value: 9, expectedVersion: 0 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      reason: "version_conflict",
      currentVersion: 1,
    });

    const second = await call(env, db, path, {
      method: "PATCH",
      body: { value: 9, expectedVersion: 1 },
    });
    expect(second.status).toBe(200);
    expect(second.body.version).toBe(2);

    const audit = await listPlatformAudit(db, { limit: 10 });
    expect(audit).toHaveLength(2);
    // Both rows carry the same `at`; tell them apart by the version they wrote.
    const byAfter = (v: number) =>
      audit.find((r) => JSON.parse(r.after_json!).version === v)!;
    const latest = byAfter(2);
    expect(latest).toMatchObject({
      action: "platform.setting.set",
      target_kind: "setting",
      target_id: "BLOB_GC_GRACE_DAYS",
      actor_sub: "admin-1",
      actor_email: "admin@example.com",
    });
    expect(JSON.parse(latest.before_json!)).toEqual({
      stored: 7,
      version: 1,
      effective: 7,
      source: "runtime",
    });
    expect(JSON.parse(latest.after_json!)).toEqual({
      stored: 9,
      version: 2,
      effective: 9,
      source: "runtime",
    });
    expect(JSON.parse(byAfter(1).before_json!)).toEqual({
      stored: null,
      version: 0,
      effective: 30,
      source: "default",
    });
  });

  it("422s a value outside the bounds: the size cap can only be lowered", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    const raise = await call(
      env,
      db,
      "/api/platform/settings/LAZY_DELTA_MAX_BYTES",
      {
        method: "PATCH",
        body: { value: LAZY_DELTA_MAX_BYTES_CEILING + 1, expectedVersion: 0 },
      },
    );
    expect(raise.status).toBe(422);
    expect(raise.body).toMatchObject({
      reason: "invalid_value",
      max: LAZY_DELTA_MAX_BYTES_CEILING,
    });
    const lower = await call(
      env,
      db,
      "/api/platform/settings/LAZY_DELTA_MAX_BYTES",
      {
        method: "PATCH",
        body: { value: 8_388_608, expectedVersion: 0 },
      },
    );
    expect(lower.status).toBe(200);
    expect(lower.body.value).toBe(8_388_608);
    const sw = await call(env, db, "/api/platform/settings/LAZY_DELTAS", {
      method: "PATCH",
      body: { value: true, expectedVersion: 0 },
    });
    expect(sw.status).toBe(422);
    expect(await listPlatformAudit(db, { limit: 10 })).toHaveLength(1);
  });

  it("stores a console `on` under a deploy-time `off` but it does not take effect", async () => {
    const db = makeTestDb();
    const env = adminEnv({ LAZY_DELTAS: "off" });
    const res = await call(env, db, "/api/platform/settings/LAZY_DELTAS", {
      method: "PATCH",
      body: { value: "on", expectedVersion: 0 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      value: "off",
      source: "deploy",
      forcedOff: true,
      stored: { value: "on", valid: true },
    });
    expect(await lazyDeltasOn(env, db)).toBe(false);
  });

  it("DELETE reverts to [vars] or the default, version-guarded and audited", async () => {
    const db = makeTestDb();
    const env = adminEnv({ BLOB_GC_GRACE_DAYS: "45" });
    const path = "/api/platform/settings/BLOB_GC_GRACE_DAYS";
    expect(
      (
        await call(env, db, path, {
          method: "DELETE",
          body: { expectedVersion: 0 },
        })
      ).status,
    ).toBe(404);
    await call(env, db, path, {
      method: "PATCH",
      body: { value: 3, expectedVersion: 0 },
    });
    const stale = await call(env, db, `${path}?expectedVersion=2`, {
      method: "DELETE",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.currentVersion).toBe(1);
    const ok = await call(env, db, `${path}?expectedVersion=1`, {
      method: "DELETE",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      value: 45,
      source: "deploy",
      stored: null,
      // A tombstone keeps the count going: the version is never reused.
      version: 2,
    });
    expect(await platformSetting(env, db, "BLOB_GC_GRACE_DAYS")).toBe(45);
    const latest = (await listPlatformAudit(db, { limit: 10 })).find(
      (r) => r.action === "platform.setting.revert",
    );
    expect(latest).toBeDefined();
    expect(JSON.parse(latest!.after_json!)).toMatchObject({
      stored: null,
      effective: 45,
      source: "deploy",
    });
  });

  it("refuses a key outside the registry, a missing version, a non-admin and a missing CSRF token", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    const unknown = await call(
      env,
      db,
      "/api/platform/settings/PLATFORM_ADMIN_GROUP",
      {
        method: "PATCH",
        body: { value: "attackers", expectedVersion: 0 },
      },
    );
    expect(unknown.status).toBe(404);
    const noVersion = await call(
      env,
      db,
      "/api/platform/settings/LAZY_DELTAS",
      {
        method: "PATCH",
        body: { value: "on" },
      },
    );
    expect(noVersion.status).toBe(400);
    expect(noVersion.body.reason).toBe("expected_version_required");
    const notAdmin = await call(env, db, "/api/platform/settings/LAZY_DELTAS", {
      method: "PATCH",
      body: { value: "on", expectedVersion: 0 },
      groups: ["product-admins"],
    });
    expect(notAdmin.status).toBe(403);
    const noCsrf = await call(env, db, "/api/platform/settings/LAZY_DELTAS", {
      method: "PATCH",
      body: { value: "on", expectedVersion: 0 },
      csrf: false,
    });
    expect(noCsrf.status).toBe(403);
    const wrongMethod = await call(env, db, "/api/platform/settings", {
      method: "POST",
      body: {},
    });
    expect(wrongMethod.status).toBe(405);
    expect(await db.all("SELECT key FROM platform_settings")).toEqual([]);
    expect(await listPlatformAudit(db, { limit: 10 })).toEqual([]);
  });
});

describe("A-13 hardening", () => {
  const row = (value: unknown) => ({
    value,
    version: 1,
    updatedAt: NOW,
    updatedBy: "admin-1",
  });

  it("ceiling: an unrecognised [vars] value is a hard off; `runtime`, `on` and unset are not", () => {
    const d = def("LAZY_DELTAS");
    for (const raw of ["false", "0", "disabled", "of", "no"]) {
      expect(isHardOffVar(d, raw)).toBe(true);
      expect(resolveSetting(d, raw, row("on"), true)).toMatchObject({
        value: "off",
        source: "deploy",
        forcedOff: true,
      });
    }
    for (const raw of ["runtime", " Runtime ", "on", undefined])
      expect(isHardOffVar(d, raw)).toBe(false);
    // A tunable is never hard-off by its var.
    expect(isHardOffVar(def("BLOB_GC_GRACE_DAYS"), "false")).toBe(false);
    expect(unrecognisedCeilingVars({ LAZY_DELTAS: "false" })).toEqual([
      "LAZY_DELTAS",
    ]);
    expect(
      unrecognisedCeilingVars({ LAZY_DELTAS: "off", BLOB_GC_MODE: "runtime" }),
    ).toEqual([]);
  });

  it("the inventory warns on an unrecognised kill-switch value and the setting stays off", async () => {
    const db = makeTestDb();
    const env = adminEnv({ BLOB_GC_MODE: "disabled" });
    await storeRow(db, "BLOB_GC_MODE", "on");
    const res = await call(env, db, "/api/platform/settings");
    const w = (res.body.warnings as { code: string; names: string[] }[]).find(
      (x) => x.code === "ceiling_value_unrecognised",
    );
    expect(w?.names).toEqual(["BLOB_GC_MODE"]);
    expect(
      (res.body.settings as { key: string; value: unknown }[]).find(
        (x) => x.key === "BLOB_GC_MODE",
      )?.value,
    ).toBe("off");
  });

  it("a stale expectedVersion from before a DELETE cannot pass (the version is never reused)", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    const path = "/api/platform/settings/BLOB_GC_GRACE_DAYS";
    await call(env, db, path, {
      method: "PATCH",
      body: { value: 3, expectedVersion: 0 },
    });
    await call(env, db, `${path}?expectedVersion=1`, { method: "DELETE" });
    // The tombstone is at version 2; a client still holding 1 (or 0) is refused.
    for (const stale of [0, 1]) {
      const r = await call(env, db, path, {
        method: "PATCH",
        body: { value: 9, expectedVersion: stale },
      });
      expect(r.status).toBe(409);
      expect(r.body.currentVersion).toBe(2);
    }
    // A reverted tombstone cannot be reverted again, and a fresh write carries the tombstone's version.
    expect(
      (await call(env, db, `${path}?expectedVersion=2`, { method: "DELETE" }))
        .status,
    ).toBe(404);
    const ok = await call(env, db, path, {
      method: "PATCH",
      body: { value: 9, expectedVersion: 2 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(3);
    expect(await platformSetting(env, db, "BLOB_GC_GRACE_DAYS")).toBe(9);
  });

  it("a tombstone is not applied and is listed with its version", async () => {
    const db = makeTestDb();
    const env = adminEnv({ BLOB_GC_GRACE_DAYS: "45" });
    await db.run(
      "INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by) VALUES ('BLOB_GC_GRACE_DAYS', 'null', 4, ?, 'seed')",
      NOW,
    );
    const r = (await platformSettings(env, db, { fresh: true }))
      .BLOB_GC_GRACE_DAYS;
    expect(r).toMatchObject({
      value: 45,
      source: "deploy",
      stored: null,
      version: 4,
    });
  });

  it("a write whose version moved before the read answers 409 and records no audit row", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    await storeRow(db, "BLOB_GC_GRACE_DAYS", 5, 3);
    const r = await call(env, db, "/api/platform/settings/BLOB_GC_GRACE_DAYS", {
      method: "PATCH",
      body: { value: 7, expectedVersion: 2 },
    });
    expect(r.status).toBe(409);
    expect(r.body.currentVersion).toBe(3);
    expect(await listPlatformAudit(db, { limit: 10 })).toHaveLength(0);
  });

  it("the setting and its audit row commit together: a failing audit insert rolls the write back", async () => {
    const db = makeTestDb();
    const env = adminEnv();
    await db.run("DROP TABLE platform_audit");
    await expect(
      call(env, db, "/api/platform/settings/BLOB_GC_GRACE_DAYS", {
        method: "PATCH",
        body: { value: 7, expectedVersion: 0 },
      }),
    ).rejects.toThrow();
    expect(
      await db.first(
        "SELECT 1 FROM platform_settings WHERE key = 'BLOB_GC_GRACE_DAYS'",
      ),
    ).toBeNull();
  });

  it("settingConfirmLevel and the confirm_required branch honour L2 and L3 on a synthetic definition", () => {
    const sw = {
      ...def("LAZY_DELTAS"),
      confirm: { on: "L3", off: "L2" },
    } as PlatformSettingDef;
    expect(settingConfirmLevel(sw, "off", "on")).toBe("L3");
    expect(settingConfirmLevel(sw, "on", "off")).toBe("L2");
    expect(settingConfirmLevel(sw, "on", "on")).toBe("L0");
    const int = {
      ...def("BLOB_GC_GRACE_DAYS"),
      confirm: { raise: "L2", lower: "L3" },
    } as PlatformSettingDef;
    expect(settingConfirmLevel(int, 10, 20)).toBe("L2");
    expect(settingConfirmLevel(int, 20, 10)).toBe("L3");
  });

  it("an L2 definition 400s confirm_required until the key is typed", async () => {
    // The handler resolves the entry through the registry's own object: swap its confirm levels
    // in place for the duration of the test.
    const real = platformSettingDef("BLOB_GC_GRACE_DAYS") as {
      confirm: { raise: string; lower: string };
    };
    const original = real.confirm;
    real.confirm = { raise: "L2", lower: "L3" };
    try {
      const db = makeTestDb();
      const env = adminEnv();
      const path = "/api/platform/settings/BLOB_GC_GRACE_DAYS";
      const refused = await call(env, db, path, {
        method: "PATCH",
        body: { value: 60, expectedVersion: 0 },
      });
      expect(refused.status).toBe(400);
      expect(refused.body.reason ?? refused.body.details?.reason).toBe(
        "confirm_required",
      );
      const ok = await call(env, db, path, {
        method: "PATCH",
        body: { value: 60, expectedVersion: 0, confirm: "BLOB_GC_GRACE_DAYS" },
      });
      expect(ok.status).toBe(200);
    } finally {
      real.confirm = original;
    }
  });
});
