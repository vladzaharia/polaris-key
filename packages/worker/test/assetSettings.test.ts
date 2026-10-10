/**
 * HA-10 — the hosted-asset settings in S-18's registry (notes/S-20 §6.10, owner decisions 6 and
 * 9): `assets.hosting.enabled` (the platform kill switch), `assets.releases.mirror`,
 * `assets.quota.mediaBytes` and `assets.quota.releaseBytes`; how each resolves; and the console's
 * usage read and settings writes (`GET …/assets/usage`, `PATCH|DELETE …/assets/settings/<key>`).
 *
 * The enforcement is pinned where it happens: the media quota in `hostedAssets.test.ts`, the
 * switches and the release-file quota in `releaseMirror.test.ts`, and the rollback of every
 * HA-07 surface in `portalHostedArt.test.ts`, `storefrontFeeds.test.ts` and
 * `downloadPageIcon.test.ts`, each switching the real setting.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { NOW } from "./seed.js";
import {
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import { setAssetHosting, setProductAssetSetting } from "./hostedFixture.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { SETTINGS } from "../src/mount.js";
import { deniedCategories, checkRegistry } from "../src/core/settings/rules.js";
import {
  ASSET_MEDIA_QUOTA_DEFAULT,
  ASSET_RELEASE_QUOTA_DEFAULT,
} from "../src/core/settings/platform.js";
import {
  assetHostingEnabled,
  ASSET_HOSTING_KEY,
} from "../src/core/assets/assetHosting.js";
import {
  ASSET_PRODUCT_KEYS,
  assetSettingsRegistry,
  inheritedValue,
  productAssetSettings,
} from "../src/core/assets/assetSettings.js";
import { writeSetting } from "../src/core/settings/write.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import type { AssetUsageDto } from "../src/console/handlers/hostedAssets.js";
import { ROOT_PRINCIPAL } from "./rbacFixtures.js";

let db: SqliteDb;
let env: Env;

beforeEach(async () => {
  db = makeTestDb();
  env = envFor();
  await seedReleaseProduct(db);
});

describe("the registry entries", () => {
  it("registers S-20 §6.10's four settings with its scopes and defaults", () => {
    const hosting = SETTINGS.get("assets.hosting.enabled", "platform")!;
    expect(hosting).toMatchObject({
      scope: "platform",
      value: { kind: "switch" },
      defaultValue: "on",
      ownership: "operator",
      precedence: "runtime",
      varName: "ASSET_HOSTING",
      storage: { kind: "scalar", storedAs: "ASSET_HOSTING" },
      since: "HA-10",
    });
    expect(hosting.productLink).toBeUndefined(); // platform-only
    expect(hosting.securityWidening).toBeUndefined();
    // An aliased platform entry: the console's Platform → Settings switches it.
    expect(hosting).toMatchObject({
      area: "delivery",
      defaultValue: "on",
      precedence: "runtime",
    });
    expect(SETTINGS.canonicalKey("ASSET_HOSTING")).toBe(ASSET_HOSTING_KEY);

    const mirror = SETTINGS.get("assets.releases.mirror", "product")!;
    expect(mirror).toMatchObject({
      service: "core",
      value: { kind: "switch" },
      defaultValue: "on",
      ownership: "operator",
      storage: { kind: "scalar" },
    });
    // Operator-owned: the manifest's author does not pay for the storage.
    expect(mirror.manifest).toBeUndefined();
    expect(SETTINGS.get("assets.releases.mirror", "platform")).toBeUndefined();

    for (const [key, def] of [
      ["assets.quota.mediaBytes", ASSET_MEDIA_QUOTA_DEFAULT],
      ["assets.quota.releaseBytes", ASSET_RELEASE_QUOTA_DEFAULT],
    ] as const) {
      const product = SETTINGS.get(key, "product")!;
      const platform = SETTINGS.get(key, "platform")!;
      expect(product).toMatchObject({
        service: "core",
        value: { kind: "integer", unit: "bytes", min: 0 },
        defaultValue: def,
        inherits: "platform",
        ownership: "operator",
      });
      expect(platform).toMatchObject({
        defaultValue: def,
        productLink: { default: true, bound: false },
      });
      expect(product.manifest).toBeUndefined();
    }
    expect(ASSET_MEDIA_QUOTA_DEFAULT).toBe(512 * 1024 * 1024);
    expect(ASSET_RELEASE_QUOTA_DEFAULT).toBe(100 * 1024 * 1024 * 1024);

    // Core owns the namespace, so Core's own registry view holds every key the composition
    // root does, identically.
    expect(
      SETTINGS.slices.find((s) => s.owner === "core")!.namespaces,
    ).toContain("assets");
    const core = assetSettingsRegistry();
    for (const e of SETTINGS.entries.filter((e) => e.key.startsWith("assets.")))
      expect(core.get(e.key, e.scope)).toEqual(e);
    expect(checkRegistry(SETTINGS)).toEqual([]);
  });

  it("the deny-list accepts the kill switch: it is a rollback, not a security gate", () => {
    for (const name of ["assets.hosting.enabled", "ASSET_HOSTING"])
      expect(deniedCategories(name), name).toEqual([]);
  });
});

describe("assets.hosting.enabled", () => {
  it("is on by default: today's behaviour", async () => {
    expect(await assetHostingEnabled(env, db)).toBe(true);
  });

  it("a console value wins over [vars], and [vars] over the default (runtime)", async () => {
    env.ASSET_HOSTING = "off";
    expect(await assetHostingEnabled(env, db)).toBe(false);
    await setAssetHosting(env, db, "on");
    expect(await assetHostingEnabled(env, db)).toBe(true);
    env.ASSET_HOSTING = "on";
    await setAssetHosting(env, db, "off");
    expect(await assetHostingEnabled(env, db)).toBe(false);
    expect(
      await db.first(
        "SELECT value_json FROM platform_settings WHERE key = 'ASSET_HOSTING'",
      ),
    ).toEqual({ value_json: '"off"' });
    expect(
      await db.first(
        "SELECT action, setting_key FROM platform_audit ORDER BY rowid DESC LIMIT 1",
      ),
    ).toEqual({
      action: "platform.setting.set",
      setting_key: "assets.hosting.enabled",
    });
  });

  it("an unreadable store is not an off: an outage never forces the rollback", async () => {
    const broken = {
      ...db,
      all: async () => {
        throw new Error("D1 down");
      },
    } as unknown as Db;
    expect(await assetHostingEnabled({}, broken)).toBe(true);
    expect(await assetHostingEnabled({ ASSET_HOSTING: "off" }, broken)).toBe(
      false,
    );
  });
});

describe("a product's settings", () => {
  it("default to on and S-20's quotas, and inherit the platform's quota live", async () => {
    let s = (await productAssetSettings(env, db, SLUG))!;
    expect(s).toMatchObject({
      releaseMirror: true,
      mediaQuota: ASSET_MEDIA_QUOTA_DEFAULT,
      releaseQuota: ASSET_RELEASE_QUOTA_DEFAULT,
    });
    expect(s.resolved["assets.quota.mediaBytes"].source).toBe("default");

    // A platform default reaches every product that sets none of its own.
    const out = await writeSetting(
      { env, db, registry: SETTINGS },
      { key: "assets.quota.mediaBytes", value: 1_000_000 },
      {
        actor: { sub: "admin-1", name: "Ops", email: null },
        origin: "console",
        principal: ROOT_PRINCIPAL,
        now: NOW,
        strict: false,
      },
    );
    expect(out.ok).toBe(true);
    s = (await productAssetSettings(env, db, SLUG))!;
    expect(s.mediaQuota).toBe(1_000_000);
    expect(s.resolved["assets.quota.mediaBytes"].source).toBe("platform");

    // The product's own value wins; Reset returns it to the platform's.
    await setProductAssetSetting(env, db, SLUG, "assets.quota.mediaBytes", 5);
    s = (await productAssetSettings(env, db, SLUG))!;
    expect(s.mediaQuota).toBe(5);
    expect(s.resolved["assets.quota.mediaBytes"].source).toBe("console");
    expect(inheritedValue(s.resolved["assets.quota.mediaBytes"])).toBe(
      1_000_000,
    );
    await setProductAssetSetting(
      env,
      db,
      SLUG,
      "assets.quota.mediaBytes",
      null,
    );
    expect((await productAssetSettings(env, db, SLUG))!.mediaQuota).toBe(
      1_000_000,
    );

    await setProductAssetSetting(
      env,
      db,
      SLUG,
      "assets.releases.mirror",
      "off",
    );
    expect((await productAssetSettings(env, db, SLUG))!.releaseMirror).toBe(
      false,
    );
    expect(await productAssetSettings(env, db, "nobody")).toBeNull();
  });

  it("refuses a value outside the spec", async () => {
    await expect(
      setProductAssetSetting(env, db, SLUG, "assets.quota.mediaBytes", -1),
    ).rejects.toThrow(/not a valid value/);
    await expect(
      setProductAssetSetting(env, db, SLUG, "assets.releases.mirror", true),
    ).rejects.toThrow(/not a valid value/);
  });
});

describe("the console: usage and the settings writes", () => {
  async function admin() {
    const { token, session } = await issueSession(
      env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    return (method: string, rest: string, body?: unknown) => {
      const path = `/api/products/${SLUG}/assets/${rest}`;
      return handleAdmin(
        new Request(`${CONSOLE}/manage${path}`, {
          method,
          headers: {
            cookie: `${ADMIN_COOKIE}=${token}`,
            [CSRF_HEADER]: session.csrf,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
        db,
        path,
        { now: NOW + 5 },
      );
    };
  }

  it("GET …/usage answers the bytes held against each quota, the switch and the settings", async () => {
    await db.run(
      `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
       VALUES ('blobs/sha256/${"a".repeat(64)}', '${"a".repeat(64)}', 700, 'blob', 0, ?, ?),
              ('blobs/sha256/${"b".repeat(64)}', '${"b".repeat(64)}', 9000, 'blob', 0, ?, ?)`,
      NOW,
      NOW,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at) VALUES
         (?, 'blobs/sha256/${"a".repeat(64)}', 'hosted-asset', 'presentation.icon@', ?),
         (?, 'blobs/sha256/${"a".repeat(64)}', 'hosted-asset', 'listing.icon@', ?),
         (?, 'blobs/sha256/${"b".repeat(64)}', 'hosted-asset', 'release-file:${"b".repeat(64)}@', ?),
         (?, 'blobs/sha256/${"b".repeat(64)}', 'release-artifact', 'v1/1', ?)`,
      SLUG,
      NOW,
      SLUG,
      NOW,
      SLUG,
      NOW,
      SLUG,
      NOW,
    );
    await setProductAssetSetting(
      env,
      db,
      SLUG,
      "assets.quota.releaseBytes",
      9000,
    );
    const call = await admin();
    const res = await call("GET", "usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AssetUsageDto;
    expect(body.hosting).toBe(true);
    expect(body.media).toEqual({
      bytes: 700,
      files: 1,
      quota: ASSET_MEDIA_QUOTA_DEFAULT,
      full: false,
    });
    expect(body.release).toEqual({
      bytes: 9000,
      files: 1,
      quota: 9000,
      full: true,
    });
    expect(body.settings.map((s) => s.key)).toEqual([...ASSET_PRODUCT_KEYS]);
    expect(
      body.settings.find((s) => s.key === "assets.quota.releaseBytes"),
    ).toMatchObject({
      value: 9000,
      source: "console",
      own: true,
      inherited: ASSET_RELEASE_QUOTA_DEFAULT,
      version: 1,
    });
    expect(
      body.settings.find((s) => s.key === "assets.releases.mirror"),
    ).toMatchObject({ value: "on", source: "default", own: false, version: 0 });

    await setAssetHosting(env, db, "off");
    expect(
      ((await (await call("GET", "usage")).json()) as AssetUsageDto).hosting,
    ).toBe(false);
  });

  it("PATCH and DELETE …/settings/<key> write through writeSetting(), versioned and audited", async () => {
    const call = await admin();
    // The version is required (strict), and must be the one read.
    expect(
      (await call("PATCH", "settings/assets.releases.mirror", { value: "off" }))
        .status,
    ).toBe(400);
    let res = await call("PATCH", "settings/assets.releases.mirror", {
      value: "off",
      expectedVersion: 0,
      reason: "GitHub serves this product's files",
    });
    expect(res.status).toBe(200);
    let body = (await res.json()) as AssetUsageDto;
    expect(
      body.settings.find((s) => s.key === "assets.releases.mirror"),
    ).toMatchObject({ value: "off", own: true, version: 1 });
    expect(
      await db.first(
        "SELECT action, setting_key, origin, reason, actor_sub FROM audit WHERE product = ? AND setting_key = 'assets.releases.mirror'",
        SLUG,
      ),
    ).toEqual({
      action: "setting.update",
      setting_key: "assets.releases.mirror",
      origin: "console",
      reason: "GitHub serves this product's files",
      actor_sub: "u1",
    });
    // A stale version writes nothing.
    res = await call("PATCH", "settings/assets.releases.mirror", {
      value: "on",
      expectedVersion: 0,
    });
    expect(res.status).toBe(409);
    // Values outside the spec and keys that are not these three are refused.
    expect(
      (
        await call("PATCH", "settings/assets.quota.mediaBytes", {
          value: "lots",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("PATCH", "settings/core.name", {
          value: "x",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("PATCH", "settings/assets.hosting.enabled", {
          value: "off",
          expectedVersion: 0,
        })
      ).status,
    ).toBe(404);
    // DELETE drops the product's own value: it follows the default (on) again.
    res = await call("DELETE", "settings/assets.releases.mirror", {
      expectedVersion: 1,
    });
    expect(res.status).toBe(200);
    body = (await res.json()) as AssetUsageDto;
    expect(
      body.settings.find((s) => s.key === "assets.releases.mirror"),
    ).toMatchObject({ value: "on", own: false, version: 0 });
    expect((await call("GET", "settings/assets.releases.mirror")).status).toBe(
      405,
    );
  });

  it("…/usage takes no further path segment", async () => {
    const call = await admin();
    expect((await call("GET", "usage/extra")).status).toBe(404);
  });
});
