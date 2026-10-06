/**
 * `writeSetting()` (ST-04, notes/S-18 §4.6): the one write path. Pinned here:
 *
 *   - a write stores the value (a `product_settings` row, a typed column through its adapter, a
 *     platform row), claims a claimable key on a repo-linked product, and writes ONE audit row
 *     per key in the same batch with `before_json`, `after_json`, `origin`, `reason` and
 *     `setting_key`;
 *   - every refusal (unknown, pending, manifest-only, manifest-authoritative, invalid, out of
 *     bounds, strict mode's version / reason / typed confirmation) writes nothing;
 *   - a stale `expectedVersion` writes nothing at all, audit included, and several keys apply
 *     together or not at all;
 *   - a reset drops the row (a platform reset leaves A-13's tombstone, so versions only grow) and
 *     a platform write drops the 30-second cache.
 *
 * The row-backed cases use a test registry with live scalar entries (every real one is still
 * pending its reader), built with the same `buildSettingsRegistry` the composition root uses.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import { SETTINGS } from "../src/mount.js";
import { buildSettingsRegistry } from "../src/core/settings/registry.js";
import { setting } from "../src/core/settings/define.js";
import {
  confirmLevelFor,
  writeSetting,
  writeSettings,
  type SettingWrite,
  type WriteOptions,
} from "../src/core/settings/write.js";
import {
  resolvePlatformSetting,
  resolveProductSetting,
} from "../src/core/settings/resolve.js";

const ACTOR = { sub: "u1", name: "Una", email: "una@example.test" };

/** A registry with live row-backed entries in License's namespace, and a platform bound. */
const TEST_REGISTRY = buildSettingsRegistry(
  [
    {
      slug: "license",
      settings: {
        namespaces: ["license"],
        entries: [
          setting({
            key: "license.test.limit",
            scope: "product",
            service: "license",
            area: "license.policy",
            label: "Test limit",
            description:
              "A row-backed, claimable test entry bounded by the platform.",
            docs: "/docs/",
            value: { kind: "integer", unit: "count", min: 1, max: 100 },
            defaultValue: 10,
            merge: "policy",
            policyBound: "max",
            widensWhen: "higher",
            ownership: "claimable",
            manifest: { path: "product:licensing.limit" },
            confirm: { up: "L2", down: "L0" },
            storage: { kind: "scalar" },
            readers: ["test"],
          }),
          setting({
            key: "license.test.mode",
            scope: "product",
            service: "license",
            area: "license.policy",
            label: "Test mode",
            description: "A row-backed, operator-only, critical test entry.",
            docs: "/docs/",
            value: { kind: "enum", values: ["a", "b"] },
            defaultValue: "a",
            merge: "cascade",
            ownership: "operator",
            critical: true,
            confirm: { change: "L1" },
            storage: { kind: "scalar" },
            readers: ["test"],
          }),
          setting({
            key: "license.test.later",
            scope: "product",
            service: "license",
            area: "license.policy",
            label: "Later",
            description: "Registered ahead of its reader.",
            docs: "/docs/",
            value: { kind: "boolean" },
            defaultValue: false,
            merge: "cascade",
            ownership: "operator",
            confirm: { on: "L0", off: "L0" },
            storage: { kind: "scalar" },
            pending: { wp: "ZZ-1" },
          }),
        ],
      },
    },
  ],
  {
    platform: [
      setting({
        key: "license.test.limit",
        scope: "platform",
        service: "platform",
        area: "product-defaults",
        label: "Test limit ceiling",
        description: "The bound.",
        docs: "/docs/",
        value: { kind: "integer", unit: "count", min: 1, max: 100 },
        defaultValue: 100,
        merge: "policy",
        policyBound: "max",
        widensWhen: "higher",
        productLink: { default: false, bound: true },
        ownership: "operator",
        confirm: { up: "L1", down: "L1" },
        storage: { kind: "scalar" },
        readers: ["test"],
      }),
    ],
  },
);

async function world(opts: { linked?: boolean; system?: boolean } = {}) {
  const db = makeTestDb();
  await seedProduct(db, "acme");
  if (opts.linked)
    await db.run(
      "UPDATE products SET release_source = 'github' WHERE slug = 'acme'",
    );
  if (opts.system)
    await db.run("UPDATE products SET system = 1 WHERE slug = 'acme'");
  const env: Record<string, unknown> = {};
  return {
    db,
    env,
    ctx: { env, db, registry: TEST_REGISTRY },
    real: { env, db, registry: SETTINGS },
  };
}

const opts = (over: Partial<WriteOptions> = {}): WriteOptions => ({
  actor: ACTOR,
  origin: "console",
  now: NOW,
  product: "acme",
  ...over,
});

const rows = (db: Db) =>
  db.all<{
    key: string;
    value_json: string | null;
    source: string;
    version: number;
    reason: string | null;
  }>(
    "SELECT key, value_json, source, version, reason FROM product_settings WHERE product = 'acme' ORDER BY key",
  );

const audits = (db: Db) =>
  db.all<{
    action: string;
    setting_key: string | null;
    origin: string | null;
    reason: string | null;
    before_json: string | null;
    after_json: string | null;
    actor_sub: string | null;
    summary: string | null;
  }>(
    "SELECT action, setting_key, origin, reason, before_json, after_json, actor_sub, summary FROM audit WHERE product = 'acme' ORDER BY at, id",
  );

describe("writeSetting: a product write", () => {
  it("stores a row-backed value, claims it on a linked product and audits before, after, origin, reason and key", async () => {
    const { db, ctx } = await world({ linked: true });
    const res = await writeSetting(
      ctx,
      {
        key: "license.test.limit",
        value: 25,
        expectedVersion: 0,
        reason: "launch",
      },
      // Raising the limit is L2: the typed confirmation is the key.
      opts({ confirm: "license.test.limit" }),
    );
    expect(res).toMatchObject({
      ok: true,
      written: [
        { key: "license.test.limit", op: "set", version: 1, claimed: true },
      ],
    });
    expect(await rows(db)).toEqual([
      {
        key: "license.test.limit",
        value_json: "25",
        source: "console",
        version: 1,
        reason: "launch",
      },
    ]);
    const [a] = await audits(db);
    expect(a).toMatchObject({
      action: "setting.update",
      setting_key: "license.test.limit",
      origin: "console",
      reason: "launch",
      actor_sub: "u1",
    });
    expect(JSON.parse(a!.before_json!)).toEqual({
      stored: null,
      version: 0,
      effective: 10,
      source: "default",
    });
    expect(JSON.parse(a!.after_json!)).toEqual({
      stored: 25,
      version: 1,
      effective: 25,
      source: "console",
    });
    expect(
      await resolveProductSetting(ctx, "acme", "license.test.limit"),
    ).toMatchObject({
      value: 25,
      source: "console",
      version: 1,
    });
  });

  it("refuses a stale expectedVersion and writes nothing, audit included", async () => {
    const { db, ctx } = await world();
    await writeSetting(
      ctx,
      { key: "license.test.mode", value: "b", expectedVersion: 0, reason: "r" },
      opts(),
    );
    const before = { rows: await rows(db), audits: await audits(db) };
    const res = await writeSetting(
      ctx,
      { key: "license.test.mode", value: "a", expectedVersion: 0, reason: "r" },
      opts(),
    );
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      reason: "version_conflict",
      key: "license.test.mode",
      details: { currentVersion: 1 },
    });
    expect({ rows: await rows(db), audits: await audits(db) }).toEqual(before);
  });

  it("applies several keys together or not at all", async () => {
    const { db, ctx } = await world();
    await writeSetting(
      ctx,
      { key: "license.test.mode", value: "b", expectedVersion: 0, reason: "r" },
      opts(),
    );
    const before = { rows: await rows(db), audits: await audits(db) };
    // One stale version refuses the whole batch.
    const res = await writeSettings(
      ctx,
      [
        { key: "license.test.limit", value: 5, expectedVersion: 0 },
        {
          key: "license.test.mode",
          value: "a",
          expectedVersion: 0,
          reason: "r",
        },
      ],
      opts({ strict: false }),
    );
    expect(res).toMatchObject({ ok: false, reason: "version_conflict" });
    expect({ rows: await rows(db), audits: await audits(db) }).toEqual(before);
    const ok = await writeSettings(
      ctx,
      [
        { key: "license.test.limit", value: 5, expectedVersion: 0 },
        {
          key: "license.test.mode",
          value: "a",
          expectedVersion: 1,
          reason: "r",
        },
      ],
      opts({ strict: false }),
    );
    expect(ok.ok).toBe(true);
    expect((await audits(db)).map((a) => a.setting_key).sort()).toEqual([
      "license.test.limit",
      "license.test.mode",
      "license.test.mode",
    ]);
  });

  it("refuses, writing nothing, every way the registry says no", async () => {
    const { db, ctx } = await world();
    const cases: [SettingWrite, Partial<WriteOptions>, string, number][] = [
      [{ key: "no.such.key", value: 1 }, {}, "unknown_setting", 404],
      [
        { key: "license.test.later", value: true, expectedVersion: 0 },
        {},
        "pending_setting",
        409,
      ],
      [
        { key: "license.test.limit", value: 0, expectedVersion: 0 },
        {},
        "invalid_value",
        422,
      ],
      [
        { key: "license.test.limit", value: "7", expectedVersion: 0 },
        {},
        "invalid_value",
        422,
      ],
      [
        { key: "license.test.limit", value: 5 },
        {},
        "expected_version_required",
        400,
      ],
      [
        { key: "license.test.mode", value: "b", expectedVersion: 0 },
        {},
        "reason_required",
        400,
      ],
      // Raising the limit is L2: the typed confirmation is the key itself.
      [
        { key: "license.test.limit", value: 50, expectedVersion: 0 },
        {},
        "confirm_required",
        400,
      ],
      [
        { key: "license.test.limit", value: 50, expectedVersion: 0 },
        { confirm: "wrong" },
        "confirm_required",
        400,
      ],
      [
        { key: "license.test.limit", value: 5 },
        { product: "nope" },
        "product_not_found",
        404,
      ],
      [
        { key: "license.test.limit", value: 5 },
        { origin: "telepathy" as never },
        "invalid_origin",
        400,
      ],
    ];
    for (const [w, o, reason, status] of cases)
      expect(
        await writeSetting(ctx, w, opts(o)),
        `${w.key} ${reason}`,
      ).toMatchObject({
        ok: false,
        reason,
        status,
      });
    expect(await rows(db)).toEqual([]);
    expect(await audits(db)).toEqual([]);
    // With the confirmation, the same write passes.
    expect(
      (
        await writeSetting(
          ctx,
          { key: "license.test.limit", value: 50, expectedVersion: 0 },
          opts({ confirm: "license.test.limit" }),
        )
      ).ok,
    ).toBe(true);
  });

  it("refuses a product value outside the platform bound (setting_out_of_bounds)", async () => {
    const { db, ctx } = await world();
    await db.run(
      "INSERT INTO platform_settings (key, value_json, version, updated_at, updated_by) VALUES ('license.test.limit', '30', 1, ?, 'u')",
      NOW,
    );
    expect(
      await writeSetting(
        ctx,
        { key: "license.test.limit", value: 31 },
        opts({ strict: false }),
      ),
    ).toMatchObject({
      ok: false,
      status: 422,
      reason: "setting_out_of_bounds",
      details: { bound: 30, boundedBy: "platform" },
    });
    expect(
      (
        await writeSetting(
          ctx,
          { key: "license.test.limit", value: 30 },
          opts({ strict: false }),
        )
      ).ok,
    ).toBe(true);
  });

  it("keeps a manifest-only field manifest-only, and the system product manifest-authoritative", async () => {
    const linked = await world({ linked: true });
    expect(
      await writeSetting(
        linked.real,
        { key: "core.adminGroup", value: "x" },
        opts({ strict: false }),
      ),
    ).toMatchObject({ ok: false, reason: "manifest_only", status: 409 });
    const system = await world({ system: true });
    expect(
      await writeSetting(
        system.ctx,
        { key: "license.test.limit", value: 5 },
        opts({ strict: false }),
      ),
    ).toMatchObject({ ok: false, reason: "manifest_authoritative" });
    // A manual product has no manifest: the field is the console's.
    const manual = await world();
    expect(
      (
        await writeSetting(
          manual.real,
          { key: "core.adminGroup", value: "ops" },
          opts({ strict: false }),
        )
      ).ok,
    ).toBe(true);
  });

  it("resets a row-backed key: the row goes and the value falls back", async () => {
    const { db, ctx } = await world({ linked: true });
    await writeSetting(
      ctx,
      { key: "license.test.limit", value: 5, expectedVersion: 0 },
      opts(),
    );
    const res = await writeSetting(
      ctx,
      { key: "license.test.limit", op: "reset", expectedVersion: 1 },
      // Back to the default (10) from 5 is a raise: L2 again.
      opts({ origin: "revert", confirm: "license.test.limit" }),
    );
    expect(res).toMatchObject({
      ok: true,
      written: [{ op: "reset", version: 0 }],
    });
    expect(await rows(db)).toEqual([]);
    // Both rows share one `at`; the reset is the row its origin names.
    const last = (await audits(db)).find((a) => a.origin === "revert")!;
    expect(last).toMatchObject({
      action: "setting.revert",
      origin: "revert",
      setting_key: "license.test.limit",
    });
    expect(JSON.parse(last.after_json!)).toMatchObject({
      effective: 10,
      source: "default",
    });
  });
});

describe("writeSetting: column-backed keys", () => {
  it("writes the column through its adapter and claims it on a linked product", async () => {
    const { db, real } = await world({ linked: true });
    const res = await writeSetting(
      real,
      { key: "core.name", value: "Acme Two" },
      opts({ strict: false }),
    );
    expect(res).toMatchObject({
      ok: true,
      written: [{ claimed: true, version: 1 }],
    });
    expect(
      (await db.first<{ name: string }>(
        "SELECT name FROM products WHERE slug = 'acme'",
      ))!.name,
    ).toBe("Acme Two");
    expect(await rows(db)).toEqual([
      {
        key: "core.name",
        value_json: null,
        source: "console",
        version: 1,
        reason: null,
      },
    ]);
  });

  it("keeps no claim row for a claimable key on a manual product (a later link still applies the manifest)", async () => {
    const { db, real } = await world();
    const res = await writeSetting(
      real,
      { key: "core.name", value: "Mine" },
      opts({ strict: false }),
    );
    expect(res).toMatchObject({
      ok: true,
      written: [{ claimed: false, version: 0 }],
    });
    expect(await rows(db)).toEqual([]);
    expect((await audits(db))[0]).toMatchObject({
      setting_key: "core.name",
      action: "setting.update",
    });
  });

  it("claims and releases a key through its legacy marker", async () => {
    const { db, real } = await world({ linked: true });
    const services = JSON.parse(
      '{"license":{"enabled":true},"config":{"enabled":false},"release":{"enabled":false},"distribution":{"enabled":false},"update":{"enabled":false},"identity":{"enabled":false},"sync":{"enabled":false}}',
    ) as unknown;
    expect(
      (
        await writeSetting(
          real,
          { key: "core.services", value: services },
          opts({ strict: false }),
        )
      ).ok,
    ).toBe(true);
    const marker = () =>
      db.first<{
        services_source: string | null;
        services_json: string | null;
      }>(
        "SELECT services_source, services_json FROM products WHERE slug = 'acme'",
      );
    expect(await marker()).toMatchObject({ services_source: "admin" });
    expect(JSON.parse((await marker())!.services_json!)).toMatchObject({
      config: { enabled: false },
    });
    expect(
      (
        await writeSetting(
          real,
          { key: "core.services", op: "reset" },
          opts({ strict: false, origin: "revert" }),
        )
      ).ok,
    ).toBe(true);
    // Only the owner flips: the value stays until the next resync re-applies the manifest.
    expect(await marker()).toMatchObject({ services_source: "manifest" });
    expect(JSON.parse((await marker())!.services_json!)).toMatchObject({
      config: { enabled: false },
    });
    expect(await rows(db)).toEqual([]);
  });

  it("writes Release's columns through Release's adapter (contributed by its slice)", async () => {
    const { db, real } = await world();
    await db.run(
      `INSERT INTO release_config (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
         manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker)
       VALUES ('acme', 'o', 'r', 1, 'w', 'main', '[]', 'acme', NULL, NULL, 'm')`,
    );
    expect(
      (
        await writeSetting(
          real,
          { key: "update.metadataAccess", value: "licensed" },
          opts({ strict: false }),
        )
      ).ok,
    ).toBe(true);
    expect(
      await db.first(
        "SELECT metadata_access, access_source FROM release_config WHERE product = 'acme'",
      ),
    ).toEqual({ metadata_access: "licensed", access_source: "admin" });
  });
});

describe("writeSetting: a platform write", () => {
  it("stores the row, audits it in platform_audit, drops the cache, and resets to a tombstone", async () => {
    const { db, env, real } = await world();
    // Warm the cache, then write: the writer reads its own change at once.
    expect(
      (await resolvePlatformSetting(real, "storefront.polarisKey.enabled"))
        .value,
    ).toBe("on");
    const res = await writeSetting(
      real,
      {
        key: "storefront.polarisKey.enabled",
        value: "off",
        expectedVersion: 0,
        reason: "incident",
      },
      {
        actor: ACTOR,
        origin: "console",
        now: NOW,
        confirm: "storefront.polarisKey.enabled",
      },
    );
    expect(res).toMatchObject({ ok: true, written: [{ version: 1 }] });
    expect(
      await resolvePlatformSetting(real, "storefront.polarisKey.enabled"),
    ).toMatchObject({
      value: "off",
      source: "platform",
      version: 1,
    });
    const audit = await db.first<Record<string, string | null>>(
      "SELECT action, setting_key, origin, reason, before_json, after_json FROM platform_audit",
    );
    expect(audit).toMatchObject({
      action: "platform.setting.set",
      setting_key: "storefront.polarisKey.enabled",
      origin: "console",
      reason: "incident",
    });
    expect(JSON.parse(audit!.after_json!)).toMatchObject({
      effective: "off",
      source: "platform",
    });

    const reset = await writeSetting(
      real,
      {
        key: "storefront.polarisKey.enabled",
        op: "reset",
        expectedVersion: 1,
        reason: "fixed",
      },
      {
        actor: ACTOR,
        origin: "console",
        now: NOW,
        confirm: "storefront.polarisKey.enabled",
      },
    );
    expect(reset).toMatchObject({ ok: true, written: [{ version: 2 }] });
    expect(
      await db.first(
        "SELECT value_json, version FROM platform_settings WHERE key = 'storefront.polarisKey.enabled'",
      ),
    ).toEqual({ value_json: "null", version: 2 });
    expect(
      (
        await resolvePlatformSetting(
          { ...real, env },
          "storefront.polarisKey.enabled",
        )
      ).value,
    ).toBe("on");
    // Nothing stored any more: a second reset has nothing to remove.
    expect(
      await writeSetting(
        real,
        { key: "storefront.polarisKey.enabled", op: "reset" },
        { actor: ACTOR, origin: "console", now: NOW, strict: false },
      ),
    ).toMatchObject({ ok: false, reason: "nothing_stored" });
  });
});

describe("confirmLevelFor", () => {
  it("reads the entry's confirm per direction", () => {
    const limit = TEST_REGISTRY.get("license.test.limit", "product")!;
    expect(confirmLevelFor(limit, 10, 10)).toBe("L0");
    expect(confirmLevelFor(limit, 10, 20)).toBe("L2");
    expect(confirmLevelFor(limit, 20, 10)).toBe("L0");
    const audience = SETTINGS.get("storefront.polarisKey.audience", "product")!;
    expect(confirmLevelFor(audience, "eligible", "everyone")).toBe("L2");
    expect(confirmLevelFor(audience, "everyone", "eligible")).toBe("L0");
    const enabled = SETTINGS.get("storefront.polarisKey.enabled", "platform")!;
    expect(confirmLevelFor(enabled, "on", "off")).toBe("L2");
  });
});
