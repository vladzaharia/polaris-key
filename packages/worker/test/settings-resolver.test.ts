/**
 * The settings resolver (ST-04, notes/S-18 §4.4): property tests over every source and both
 * policy clamp directions, A-13 parity for A-13's keys, and the loaders over a real database.
 *
 * The properties run over a seeded generator (no dependency): each case draws which layers are
 * present, whether each holds a value of the entry or not, and the values themselves, and checks
 * the invariant the chain promises. A failure prints the seed and the case.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import { SETTINGS } from "../src/mount.js";
import { setting } from "../src/core/settings/define.js";
import type { SettingDef } from "../src/core/settings/types.js";
import {
  clampToBound,
  isHardOffDeploy,
  outOfBounds,
  resolvePlatformSetting,
  resolvePlatformValue,
  resolveProductSetting,
  resolveProductSettings,
  resolveProductValue,
  type EntityLayer,
  type ProductLayers,
  type ResolvedSetting,
} from "../src/core/settings/resolve.js";
import {
  invalidatePlatformSettings,
  PLATFORM_SETTINGS,
  resolveSetting as resolveA13,
  TOMBSTONE_JSON,
  type StoredSetting,
} from "../src/core/platformSettings.js";
import { PLATFORM_SLICE } from "../src/core/settings/platform.js";

// ── A seeded generator ───────────────────────────────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    bool: (p = 0.5) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}
type Rng = ReturnType<typeof rng>;

const CASES = 400;

/** A synthetic integer product entry (1–100), optionally a `policy` with a bound. */
function intDef(over: Partial<SettingDef> = {}): SettingDef {
  return setting({
    key: "license.test.limit",
    scope: "product",
    service: "license",
    area: "license.policy",
    label: "Test limit",
    description: "A synthetic entry for the resolver's property tests.",
    docs: "/docs/",
    value: { kind: "integer", unit: "count", min: 1, max: 100 },
    defaultValue: 10,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.limit" },
    confirm: { up: "L1", down: "L0" },
    storage: { kind: "scalar" },
    readers: ["test"],
    ...over,
  });
}

/** The platform twin of `intDef` (a default products inherit, or a bound). */
function platformTwin(over: Partial<SettingDef> = {}): SettingDef {
  return setting({
    key: "license.test.limit",
    scope: "platform",
    service: "platform",
    area: "product-defaults",
    label: "Test limit",
    description: "The platform twin.",
    docs: "/docs/",
    value: { kind: "integer", unit: "count", min: 1, max: 100 },
    defaultValue: 10,
    merge: "cascade",
    varName: "TEST_LIMIT",
    precedence: "runtime",
    ownership: "operator",
    confirm: { up: "L1", down: "L1" },
    storage: { kind: "scalar" },
    readers: ["test"],
    ...over,
  });
}

/** A value of the entry, or (sometimes) not one: out of range, wrong type. */
function maybeValue(r: Rng, valid: boolean): unknown {
  if (valid) return r.int(1, 100);
  return r.pick([0, 101, -5, 3.5, "7", null, true, { n: 1 }]);
}

// ── Every source ─────────────────────────────────────────────────────────────────────────────

describe("the chain (every source)", () => {
  it("answers the highest layer that holds a value of the entry, and lists every layer in order", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed);
      const def = intDef({ inherits: "platform" });
      const twin = platformTwin({ productLink: { default: true, bound: false } });
      // Which layers are present, and whether each holds a valid value.
      const deploy = r.bool() ? { valid: r.bool(0.7) } : null;
      const platform = r.bool() ? { valid: r.bool(0.7) } : null;
      const product = r.bool()
        ? { valid: r.bool(0.7), source: r.pick(["manifest", "console"] as const) }
        : null;
      const entities = Array.from({ length: r.int(0, 2) }, (_, i) => ({
        valid: r.bool(0.7),
        entity: (i === 0 ? "tier" : "license") as EntityLayer["entity"],
      }));

      const deployRaw = deploy
        ? deploy.valid
          ? String(r.int(1, 100))
          : r.pick(["abc", "0", "1000", ""])
        : undefined;
      const platformValue = platform ? maybeValue(r, platform.valid) : undefined;
      const inherit = resolvePlatformValue(twin, {
        deploy: deployRaw,
        row: platform ? { value: platformValue, version: 3 } : null,
        version: platform ? 3 : 0,
      });
      const layers: ProductLayers = {
        inherit,
        stored: product
          ? {
              value: maybeValue(r, product.valid),
              source: product.source,
              from: "product_settings",
            }
          : undefined,
        entities: entities.map((e, i) => ({
          entity: e.entity,
          id: `e${i}`,
          value: maybeValue(r, e.valid),
          source: "console" as const,
        })),
      };
      const res = resolveProductValue(def, layers);
      const why = `seed ${seed}: ${JSON.stringify({ deploy, platform, product, entities, deployRaw, platformValue, layers: { stored: layers.stored, entities: layers.entities } })}`;

      // The expected winner: the last valid layer, in precedence order.
      const expected: { source: string; value: unknown }[] = [
        { source: "default", value: 10 },
      ];
      if (deploy?.valid) expected.push({ source: "deploy", value: Number(deployRaw) });
      if (platform?.valid) expected.push({ source: "platform", value: platformValue });
      if (product?.valid)
        expected.push({ source: product.source, value: layers.stored!.value });
      layers.entities!.forEach((e, i) => {
        if (entities[i]!.valid) expected.push({ source: "console", value: e.value });
      });
      const top = expected.at(-1)!;
      expect(res.value, why).toEqual(top.value);
      expect(res.source, why).toBe(top.source);

      // The chain lists every layer present, lowest first; refused ones are marked, never applied.
      const order = ["default", "deploy", "platform", "manifest", "console"];
      const sources = res.chain.map((s) => s.source);
      const ranks = sources.map((s) => order.indexOf(s));
      expect([...ranks].sort((a, b) => a - b), why).toEqual(ranks);
      expect(res.chain.length, why).toBe(
        1 + (deploy ? 1 : 0) + (platform ? 1 : 0) + (product ? 1 : 0) + entities.length,
      );
      for (const step of res.chain)
        expect(Boolean(step.ignored), `${why} ${step.from}`).toBe(
          !(
            step.source === "default" ||
            (typeof step.value === "number" &&
              Number.isInteger(step.value) &&
              step.value >= 1 &&
              step.value <= 100)
          ),
        );
      expect(res.lockedBy, why).toBeUndefined();
    }
  });

  it("does not inherit a platform value unless the entry says `inherits`", () => {
    const twin = platformTwin({ productLink: { default: true, bound: false } });
    const inherit = resolvePlatformValue(twin, { row: { value: 42, version: 1 } });
    expect(resolveProductValue(intDef(), { inherit }).value).toBe(10);
    expect(
      resolveProductValue(intDef({ inherits: "platform" }), { inherit }),
    ).toMatchObject({ value: 42, source: "platform" });
  });

  it("allows null only for an entry that allows unset", () => {
    const stored = { value: null, source: "console" as const, from: "x" };
    expect(resolveProductValue(intDef(), { stored })).toMatchObject({
      value: 10,
      source: "default",
    });
    expect(
      resolveProductValue(intDef({ allowUnset: true }), { stored }),
    ).toMatchObject({ value: null, source: "console" });
  });

  it("reports drift on a console claim that differs from the last applied manifest", () => {
    const stored = { value: 7, source: "console" as const, from: "x" };
    expect(
      resolveProductValue(intDef(), { stored, manifestValue: 5 }).drift,
    ).toEqual({ manifest: 5, console: 7 });
    expect(
      resolveProductValue(intDef(), { stored, manifestValue: 7 }).drift,
    ).toBeUndefined();
    expect(
      resolveProductValue(intDef(), {
        stored: { ...stored, source: "manifest" },
        manifestValue: 5,
      }).drift,
    ).toBeUndefined();
    expect(
      resolveProductValue(intDef({ ownership: "operator", manifest: undefined }), {
        stored,
        manifestValue: 5,
      }).drift,
    ).toBeUndefined();
  });
});

// ── The policy clamp ─────────────────────────────────────────────────────────────────────────

describe("the policy clamp (direction)", () => {
  const bounded = (bound: "max" | "min" | "lock", allowUnset = false) =>
    intDef({
      merge: "policy",
      policyBound: bound,
      widensWhen: bound === "max" ? "higher" : bound === "min" ? "lower" : "any",
      allowUnset,
    });
  const boundOf = (value: number | null) =>
    resolvePlatformValue(
      platformTwin({
        merge: "policy",
        policyBound: "max",
        widensWhen: "higher",
        productLink: { default: false, bound: true },
        allowUnset: true,
      }),
      { row: value === undefined ? null : { value, version: 1 } },
    );

  it("max: never above the bound, never lowered below the value, clamped exactly when above", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed);
      const def = bounded("max", true);
      const v = r.bool(0.15) ? null : r.int(1, 100);
      const b = r.int(1, 100);
      const res = resolveProductValue(def, {
        stored: { value: v, source: "console", from: "x" },
        bound: boundOf(b),
      });
      const why = `seed ${seed}: v=${v} bound=${b}`;
      const expected = v === null ? b : Math.min(v, b);
      expect(res.value, why).toBe(expected);
      expect(res.value as number, why).toBeLessThanOrEqual(b);
      if (v !== null) expect(res.value as number, why).toBeLessThanOrEqual(v);
      expect(res.lockedBy, why).toBe("platform");
      expect(Boolean(res.clamped), why).toBe(v === null || v > b);
      if (res.clamped)
        expect(res.clamped, why).toEqual({ requested: v, bound: b, by: "platform" });
      // The write path refuses exactly the values the read path clamps.
      expect(Boolean(outOfBounds(def, v, { bound: boundOf(b) })), why).toBe(
        Boolean(res.clamped),
      );
    }
  });

  it("min: never below the bound, never raised above the value's side, clamped exactly when below", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed);
      const def = bounded("min");
      const v = r.int(1, 100);
      const b = r.int(1, 100);
      const res = resolveProductValue(def, {
        stored: { value: v, source: "console", from: "x" },
        bound: boundOf(b),
      });
      const why = `seed ${seed}: v=${v} bound=${b}`;
      expect(res.value, why).toBe(Math.max(v, b));
      expect(res.value as number, why).toBeGreaterThanOrEqual(b);
      expect(res.value as number, why).toBeGreaterThanOrEqual(v);
      expect(Boolean(res.clamped), why).toBe(v < b);
    }
  });

  it("lock: replaces the value only while the platform enforces it", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed);
      const def = bounded("lock");
      const v = r.int(1, 100);
      const b = r.int(1, 100);
      const enforced = r.bool();
      const res = resolveProductValue(def, {
        stored: { value: v, source: "console", from: "x" },
        bound: boundOf(b),
        enforced,
      });
      const why = `seed ${seed}: v=${v} bound=${b} enforced=${enforced}`;
      expect(res.value, why).toBe(enforced ? b : v);
      expect(res.lockedBy, why).toBe(enforced ? "platform" : undefined);
    }
  });

  it("applies no clamp without a bound, to a cascade entry, or under an unset bound", () => {
    const stored = { value: 90, source: "console" as const, from: "x" };
    expect(resolveProductValue(bounded("max"), { stored }).value).toBe(90);
    expect(resolveProductValue(intDef(), { stored, bound: boundOf(5) }).value).toBe(90);
    expect(clampToBound(bounded("max"), 90, { bound: boundOf(null) })).toBeUndefined();
  });
});

// ── A-13 parity ──────────────────────────────────────────────────────────────────────────────

describe("A-13's keys resolve as A-13 resolves them", () => {
  const VARS = [
    undefined, "on", "off", " ON ", "runtime", "false", "0", "disabled", "abc", "",
    "1", "100", "1048576", "33554432", "40000000", "30", "1.5", "-3", "warn", "error", "WARN",
  ];
  const ROWS: (StoredSetting | undefined)[] = [
    undefined,
    { value: undefined, deleted: true, version: 4, updatedAt: NOW, updatedBy: "u" },
    { value: "on", version: 2, updatedAt: NOW, updatedBy: "u" },
    { value: "off", version: 2, updatedAt: NOW, updatedBy: "u" },
    { value: 2_000_000, version: 3, updatedAt: NOW, updatedBy: "u" },
    { value: 45, version: 3, updatedAt: NOW, updatedBy: "u" },
    { value: 9_999_999_999, version: 3, updatedAt: NOW, updatedBy: "u" },
    { value: "error", version: 1, updatedAt: NOW, updatedBy: "u" },
    { value: "nope", version: 1, updatedAt: NOW, updatedBy: "u" },
    { value: undefined, version: 1, updatedAt: NOW, updatedBy: "u" },
  ];
  const SOURCE = { runtime: "platform", deploy: "deploy", default: "default" } as const;

  it("value, source and the deploy-time hard off agree for every var, row and store state", () => {
    expect(PLATFORM_SETTINGS.length).toBeGreaterThan(0);
    for (const a13 of PLATFORM_SETTINGS) {
      const def = PLATFORM_SLICE.find((d) => d.key === a13.registryKey)!;
      for (const raw of VARS)
        for (const row of ROWS)
          for (const storeOk of [true, false]) {
            const old = resolveA13(a13, raw, row, storeOk);
            const now = resolvePlatformValue(def, {
              deploy: raw,
              row: row && !row.deleted ? { value: row.value, version: row.version } : null,
              storeOk,
              version: row?.version ?? 0,
            });
            const why = `${a13.key} var=${JSON.stringify(raw)} row=${JSON.stringify(row)} ok=${storeOk}`;
            expect(now.value, why).toEqual(old.value);
            expect(now.version, why).toBe(old.version);
            if (old.source === "failsafe") {
              expect(now.failsafe, why).toBe(true);
            } else {
              expect(now.source, why).toBe(SOURCE[old.source]);
              expect(now.failsafe, why).toBeUndefined();
            }
            expect(now.lockedBy === "deploy", why).toBe(old.forcedOff);
            expect(isHardOffDeploy(def, raw), why).toBe(old.forcedOff);
          }
    }
  });
});

// ── The loaders ──────────────────────────────────────────────────────────────────────────────

describe("the loaders", () => {
  const ctx = (db: ReturnType<typeof makeTestDb>, env: Record<string, unknown> = {}) => ({
    env,
    db,
    registry: SETTINGS,
  });

  it("decodes column-backed keys from the product row, with manifest vs console sources", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    const manual = await resolveProductSettings(ctx(db), "acme", {
      keys: ["core.name", "license.defaults.deviceLimit", "core.services", "core.trustPolicy"],
    });
    const by = (key: string, rs: ResolvedSetting[]) => rs.find((r) => r.key === key)!;
    // A manual product's values are the console's; an operator key with nothing stored is default.
    expect(by("core.name", manual)).toMatchObject({ value: "acme", source: "console", version: 0 });
    expect(by("license.defaults.deviceLimit", manual)).toMatchObject({ value: 5, source: "console" });
    expect(by("core.trustPolicy", manual)).toMatchObject({ value: null, source: "default" });

    // Repo-linked: unclaimed fields follow the manifest; a claim row makes one the console's.
    await db.run("UPDATE products SET release_source = 'github' WHERE slug = 'acme'");
    await db.run(
      `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
       VALUES ('acme', 'core.name', NULL, 'console', 3, ?, 'u1')`,
      NOW,
    );
    // A legacy marker maps: services_source 'admin' is the console's.
    await db.run(
      `UPDATE products SET services_json = '{"license":{"enabled":true}}', services_source = 'admin'
        WHERE slug = 'acme'`,
    );
    const linked = await resolveProductSettings(ctx(db), "acme", {
      keys: ["core.name", "license.defaults.deviceLimit", "core.services"],
    });
    expect(by("core.name", linked)).toMatchObject({ source: "console", version: 3 });
    expect(by("license.defaults.deviceLimit", linked)).toMatchObject({ source: "manifest", version: 0 });
    expect(by("core.services", linked)).toMatchObject({
      source: "console",
      // Decoded through the router's own parser: a slug the row omits takes its default.
      value: expect.objectContaining({
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: false },
      }),
    });
    // An expired break-glass claim is no claim (ST-20's `expires_at`).
    await db.run("UPDATE product_settings SET expires_at = ? WHERE key = 'core.name'", NOW - 1);
    expect(
      (await resolveProductSetting(ctx(db), "acme", "core.name", { now: NOW }))!.source,
    ).toBe("manifest");
  });

  it("reads a row-backed key and clamps it by the platform bound (identity.keyEntry.limit)", async () => {
    const db = makeTestDb();
    await seedProduct(db, "acme");
    await db.run(
      `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
       VALUES ('acme', 'identity.keyEntry.limit', '50', 'console', 1, ?, 'u1')`,
      NOW,
    );
    const unbounded = await resolveProductSetting(ctx(db), "acme", "identity.keyEntry.limit");
    // The platform default bound is the code maximum (100), so 50 stands.
    expect(unbounded).toMatchObject({ value: 50, source: "console", lockedBy: "platform" });
    expect(unbounded!.clamped).toBeUndefined();
    await db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('identity.keyEntry.limit', '20', 1, ?, 'u1')`,
      NOW,
    );
    invalidatePlatformSettings({}, db);
    const clamped = await resolveProductSetting(ctx(db), "acme", "identity.keyEntry.limit");
    expect(clamped).toMatchObject({
      value: 20,
      source: "console",
      lockedBy: "platform",
      clamped: { requested: 50, bound: 20, by: "platform" },
    });
  });

  it("reads platform keys through A-13's 30-second cache, stored under their registry key", async () => {
    const db = makeTestDb();
    const env = {};
    expect(await resolvePlatformSetting(ctx(db, env), "storefront.polarisKey.enabled")).toMatchObject({
      value: "on",
      source: "default",
      version: 0,
    });
    await db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('storefront.polarisKey.enabled', '"off"', 2, ?, 'u1')`,
      NOW,
    );
    // Cached: the direct write is not seen until the copy is dropped or refreshed.
    expect((await resolvePlatformSetting(ctx(db, env), "storefront.polarisKey.enabled")).value).toBe("on");
    expect(
      (await resolvePlatformSetting(ctx(db, env), "storefront.polarisKey.enabled", { fresh: true })),
    ).toMatchObject({ value: "off", source: "platform", version: 2 });
    // An alias resolves to its entry, and a tombstone is no row (A-13's DELETE).
    await db.run(
      `INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by)
       VALUES ('LAZY_DELTAS', ?, 5, ?, 'u1')`,
      TOMBSTONE_JSON,
      NOW,
    );
    expect(
      await resolvePlatformSetting(ctx(db, { LAZY_DELTAS: "runtime" }), "LAZY_DELTAS", { fresh: true }),
    ).toMatchObject({ key: "deltas.lazy.mode", value: "off", source: "default", version: 5 });
  });

  it("answers nothing for a product that does not exist, and refuses an unknown key", async () => {
    const db = makeTestDb();
    expect(await resolveProductSettings(ctx(db), "nope")).toEqual([]);
    await seedProduct(db, "acme");
    await expect(
      resolveProductSetting(ctx(db), "acme", "no.such.key"),
    ).rejects.toThrow(/no product setting/);
  });
});
