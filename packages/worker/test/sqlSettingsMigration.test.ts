/**
 * ST-11: the SQL-only settings (lazy-delta per product, the sign-in mail cap, the operator update
 * policy) are copied ONCE into `product_settings` rows by migration 0124. This rehearses the copy
 * on a scratch database holding the old shapes: every value reads back identically through the
 * resolver and the readers, one `origin = 'system'` audit row is written per moved value, and a
 * replay changes nothing (it does not clobber an operator's later edit).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, makeEnv, seedProduct } from "./seed.js";
import { KvMock } from "./kvMock.js";
import type { Db } from "../src/db/types.js";
import { writeSetting } from "../src/core/settings/write.js";
import { ROOT_PRINCIPAL } from "./rbacFixtures.js";
import { SETTINGS } from "../src/mount.js";
import { resolveProductSettings } from "../src/core/settings/resolve.js";
import {
  lazyDeltaProducts,
  lazyDeltaSettings,
} from "../src/core/assets/deltaDemand.js";
import { productDailyEmailCap } from "../src/core/notify/emailDelivery.js";
import {
  getReleaseConfig,
  operatorPolicy,
} from "../src/services/release/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(HERE, "..", "migrations", "0124_sql_settings_to_registry.sql"),
  "utf8",
)
  .split("\n")
  .filter((l) => !l.startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

async function migrate(db: Db): Promise<void> {
  for (const stmt of MIGRATION) await db.run(stmt);
}

async function world(): Promise<Db> {
  const db = makeTestDb();
  for (const p of ["alpha", "beta", "gamma"]) await seedProduct(db, p);
  await db.run(
    `INSERT INTO lazy_delta_settings (product, enabled, hot_devices, daily_cap, updated_at)
     VALUES ('alpha', 1, 7, 3, 111), ('beta', 0, NULL, NULL, 222)`,
  );
  await db.run(
    `INSERT INTO email_product_caps (product, daily_cap, modified_at)
     VALUES ('alpha', 40, 333), ('beta', 5000000, 444)`,
  );
  for (const [p, json] of [
    [
      "alpha",
      '{"requireSparkleSignature":false,"minimumSystemVersion":"13.0"}',
    ],
    ["beta", null],
    ["gamma", "{not json"],
  ] as const)
    await db.run(
      "INSERT INTO release_config (product, gh_owner, gh_repo, summary_marker, operator_policy_json) VALUES (?, 'o', 'r', 'pkey:summary', ?)",
      p,
      json,
    );
  return db;
}

describe("migration 0124 (SQL-only settings into the registry)", () => {
  it("every moved value reads back identically through the resolver and the readers", async () => {
    const db = await world();
    await migrate(db);
    const env = makeEnv(new KvMock(), ["alpha"]);
    const ctx = { env, db, registry: SETTINGS };
    const alpha = Object.fromEntries(
      (await resolveProductSettings(ctx, "alpha")).map((r) => [r.key, r]),
    );
    expect(alpha["deltas.lazy.enabled"]!.value).toBe("on");
    expect(alpha["deltas.lazy.hotDevices"]!.value).toBe(7);
    expect(alpha["deltas.lazy.dailyCap"]!.value).toBe(3);
    expect(alpha["email.dailyCap"]!.value).toBe(40);
    expect(alpha["update.operatorPolicy"]!.value).toEqual({
      requireSparkleSignature: false,
      minimumSystemVersion: "13.0",
    });
    expect(await lazyDeltaSettings(db, "alpha")).toEqual({
      enabled: true,
      hotDevices: 7,
      dailyCap: 3,
    });
    expect(await lazyDeltaProducts({ LAZY_DELTAS: "on" }, db)).toEqual([
      "alpha",
    ]);
    expect(await productDailyEmailCap(env, db, "alpha")).toBe(40);
    expect(operatorPolicy((await getReleaseConfig(db, "alpha"))!)).toEqual({
      requireSparkleSignature: false,
      minimumSystemVersion: "13.0",
    });

    // beta: an explicit off, no overrides; a cap over the new maximum is clamped to it.
    expect(await lazyDeltaSettings(db, "beta")).toEqual({
      enabled: false,
      hotDevices: 25,
      dailyCap: 20,
    });
    expect(await productDailyEmailCap(env, db, "beta")).toBe(1_000_000);
    // gamma: nothing stored; an unreadable policy is not copied (the fail-safe defaults).
    expect(await productDailyEmailCap(env, db, "gamma")).toBe(500);
    expect(operatorPolicy((await getReleaseConfig(db, "gamma"))!)).toEqual({
      requireSparkleSignature: true,
    });
  });

  it("writes one system audit row per moved value", async () => {
    const db = await world();
    await migrate(db);
    const rows = await db.all<{
      product: string;
      setting_key: string;
      origin: string;
      actor_sub: string;
    }>(
      "SELECT product, setting_key, origin, actor_sub FROM audit WHERE id LIKE 'st11:%' ORDER BY product, setting_key",
    );
    expect(rows.map((r) => `${r.product} ${r.setting_key}`)).toEqual([
      "alpha deltas.lazy.dailyCap",
      "alpha deltas.lazy.enabled",
      "alpha deltas.lazy.hotDevices",
      "alpha email.dailyCap",
      "alpha update.operatorPolicy",
      "beta deltas.lazy.enabled",
      "beta email.dailyCap",
    ]);
    for (const r of rows) {
      expect(r.origin).toBe("system");
      expect(r.actor_sub).toBe("system");
    }
  });

  it("is replayable and never clobbers a later edit", async () => {
    const db = await world();
    await migrate(db);
    await db.run(
      "UPDATE product_settings SET value_json = '99', version = 2, updated_by = 'op' WHERE product = 'alpha' AND key = 'email.dailyCap'",
    );
    const count = async () =>
      (await db.first<{ n: number }>(
        "SELECT (SELECT COUNT(*) FROM product_settings) + (SELECT COUNT(*) FROM audit) AS n",
      ))!.n;
    const before = await count();
    await migrate(db);
    expect(await count()).toBe(before);
    expect(
      await productDailyEmailCap(makeEnv(new KvMock(), ["alpha"]), db, "alpha"),
    ).toBe(99);
  });

  it("the registry writes what the readers read (no SQL needed)", async () => {
    const db = makeTestDb();
    await seedProduct(db, "alpha");
    const env = makeEnv(new KvMock(), ["alpha"]);
    const ctx = { env, db, registry: SETTINGS };
    const opts = {
      actor: { sub: "admin-1", name: "Ops", email: null },
      origin: "console" as const,
      principal: ROOT_PRINCIPAL,
      now: NOW,
      strict: false,
    };
    for (const [key, value] of [
      ["deltas.lazy.enabled", "on"],
      ["deltas.lazy.hotDevices", 4],
      ["deltas.lazy.dailyCap", 9],
      ["email.dailyCap", 12],
    ] as const) {
      const out = await writeSetting(
        ctx,
        { key, value },
        { ...opts, product: "alpha" },
      );
      expect(out.ok, key).toBe(true);
    }
    expect(await lazyDeltaSettings(db, "alpha")).toEqual({
      enabled: true,
      hotDevices: 4,
      dailyCap: 9,
    });
    expect(await productDailyEmailCap(env, db, "alpha")).toBe(12);

    // The platform default reaches a product with no cap of its own.
    await seedProduct(db, "beta");
    expect(await productDailyEmailCap(env, db, "beta")).toBe(500);
    const out = await writeSetting(
      ctx,
      { key: "email.dailyCapDefault", value: 250 },
      opts,
    );
    expect(out.ok).toBe(true);
    expect(await productDailyEmailCap(env, db, "beta")).toBe(250);
    expect(await productDailyEmailCap(env, db, "alpha")).toBe(12);
  });
});
