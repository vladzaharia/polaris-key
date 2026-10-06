/**
 * The licensing settings home (LX-06; S-19 §7.13, plans/LX-01.md §3.2, S-18 §4.5 model C).
 *
 * `licensing.*` and `identity.oidc.syncTierOnSignIn` are row-backed claimable `product_settings`
 * rows. Pinned here, every case through the real paths (`linkRepo` from a stubbed GitHub, the
 * console API, `resyncRepo`):
 *
 *   - the manifest seeds them on link and resync, and an undeclared setting has its default
 *     (with `entitlementModel`'s derived default: legacy before the cut-over, combined after);
 *   - a console edit claims the setting and survives a resync that changes the manifest value;
 *     Revert restores the last applied manifest's value at once;
 *   - dropping a setting from the manifest clears its manifest row, never a claim;
 *   - the API refuses what the registry refuses: an out-of-spec value, `onRefresh`, a critical
 *     write without a reason, a stale `expectedVersion`, the pending billing-retry grace, a key it
 *     does not serve, and any write on the manifest-authoritative system product.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { linkRepo } from "../src/services/release/linkRepo.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { planRepoManifest } from "../src/services/release/linkExisting.js";
import { parseManifest } from "../src/services/release/manifest.js";
import { manifestIngestFor } from "../src/core/registry.js";
import { SERVICES, SETTINGS } from "../src/mount.js";
import {
  COMBINED_ENTITLEMENT_MODEL_SINCE,
  readLicensingSettings,
} from "../src/services/license/licensingSettings.js";
import { readSyncTierOnSignIn } from "../src/services/identity/settings.js";
import { getProduct } from "../src/repo.js";
import { revertRowSetting, writeRowSetting } from "../src/core/rowSettings.js";
import type { Db, DbParam } from "../src/db/types.js";
import { withDefaultHead } from "./githubHead.js";

const SLUG = "acme";
const PLATFORM_GROUP = "platform-admins";

type Licensing = Record<string, unknown>;
interface Decl {
  licensing?: Licensing;
  syncTier?: string;
}

function files(d: Decl = {}): Record<string, string> {
  return {
    ".pkey/schema.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    ".pkey/product.json": JSON.stringify({
      product: { slug: SLUG, name: "Acme", adminGroup: "acme-admins" },
      modules: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        identity: { enabled: true },
      },
      licensing: {
        defaultDeviceLimit: 3,
        tiers: [{ id: "standard", label: "Standard" }],
        ...(d.licensing ?? {}),
      },
      oidc: {
        provider: "platform",
        ...(d.syncTier ? { syncTierOnSignIn: d.syncTier } : {}),
      },
    }),
    ".pkey/release.json": JSON.stringify({
      release: {
        provider: { type: "github", owner: "acme-org", repo: "acme-app" },
        binaryName: "acme",
      },
    }),
  };
}

function github(d: Decl = {}): FetchImpl {
  const docs = files(d);
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(docs))
        if (url.includes(`/contents/${path}`))
          return new Response(
            JSON.stringify({
              content: Buffer.from(body, "utf8").toString("base64"),
              encoding: "base64",
            }),
            { status: 200 },
          );
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/releases?per_page"))
      return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

async function linked(d: Decl = {}, at = NOW) {
  const db = makeTestDb();
  const env = envFor();
  const res = await linkRepo(
    env,
    db,
    "acme-org/acme-app",
    at,
    github(d),
    manifestIngestFor(SERVICES),
  );
  expect(res.ok).toBe(true);
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    at,
  );
  return {
    db,
    env,
    at,
    cookie: `${ADMIN_COOKIE}=${token}`,
    csrf: session.csrf,
  };
}
type Ctx = Awaited<ReturnType<typeof linked>>;

async function call(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { cookie: ctx.cookie };
  if (method !== "GET") headers[CSRF_HEADER] = ctx.csrf;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  // The router hands the handler the path without its query, as the real request carries it.
  const [pathname, query] = path.split("?");
  const full = `/api/products/${SLUG}/settings/${pathname}`;
  const req = new Request(
    `https://key.plrs.im/manage${full}${query ? `?${query}` : ""}`,
    init,
  );
  const res = await handleAdmin(req, ctx.env, ctx.db, full, {
    now: ctx.at + 1,
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function resync(ctx: Ctx, d: Decl = {}, offset = 60) {
  const res = await resyncRepo(
    ctx.env,
    ctx.db,
    SLUG,
    ctx.at + offset,
    github(d),
    manifestIngestFor(SERVICES),
  );
  if (!res.ok) throw new Error(`resync refused: ${res.error}`);
  return res;
}

async function settings(ctx: Ctx) {
  const product = (await getProduct(ctx.db, SLUG))!;
  return readLicensingSettings(ctx.db, product);
}

async function syncTier(ctx: Ctx) {
  return readSyncTierOnSignIn(ctx.db, (await getProduct(ctx.db, SLUG))!);
}

const rows = (ctx: Ctx) =>
  ctx.db.all<{ key: string; value_json: string; source: string }>(
    "SELECT key, value_json, source FROM product_settings WHERE product = ? ORDER BY key",
    SLUG,
  );

const audits = (ctx: Ctx, action: string) =>
  ctx.db.all<{ target_id: string; summary: string; actor_sub: string }>(
    "SELECT target_id, summary, actor_sub FROM audit WHERE product = ? AND action = ? ORDER BY at, id",
    SLUG,
    action,
  );

// Products in these tests are registered after the cut-over unless a case says otherwise.
const AFTER = COMBINED_ENTITLEMENT_MODEL_SINCE + 3600;

const ACTOR = { sub: "u2", name: "Bea", email: null };

/**
 * `db`, with every batch held until `n` reads of one setting row have happened: two concurrent
 * writers then both read the same version before either writes, the race the version guard and
 * the `changes()`-guarded audit row exist for.
 */
function afterReads(db: Db, n: number): Db {
  let reads = 0;
  let release!: () => void;
  const ready = new Promise<void>((r) => (release = r));
  return {
    all: (sql, ...p) => db.all(sql, ...p),
    first: async <T>(sql: string, ...p: DbParam[]) => {
      const row = await db.first<T>(sql, ...p);
      if (/FROM product_settings WHERE product = \? AND key = \?/.test(sql))
        if (++reads === n) release();
      return row;
    },
    run: (sql, ...p) => db.run(sql, ...p),
    runChanges: (sql, ...p) => db.runChanges(sql, ...p),
    batch: async (stmts) => {
      await ready;
      return db.batch(stmts);
    },
    batchChanges: async (stmts) => {
      await ready;
      return db.batchChanges!(stmts);
    },
  };
}

describe("the manifest seeds the licensing settings (link and resync)", () => {
  it("declared settings become manifest rows; undeclared ones keep their defaults", async () => {
    const ctx = await linked(
      {
        licensing: { entitlementHolder: "owner", refundGraceHours: 24 },
        syncTier: "upgradeOnly",
      },
      AFTER,
    );
    expect(await rows(ctx)).toEqual([
      {
        key: "identity.oidc.syncTierOnSignIn",
        value_json: '"upgradeOnly"',
        source: "manifest",
      },
      {
        key: "licensing.entitlementHolder",
        value_json: '"owner"',
        source: "manifest",
      },
      {
        key: "licensing.refundGraceHours",
        value_json: "24",
        source: "manifest",
      },
    ]);
    expect(await settings(ctx)).toEqual({
      entitlementModel: "combined",
      entitlementHolder: "owner",
      clampGraceToExpiry: true,
      anchorPolicy: "rank-first",
      reanchor: "onActivation",
      refundGraceHours: 24,
      dunningGraceDays: 0,
    });
    expect(await syncTier(ctx)).toBe("upgradeOnly");
    expect((await audits(ctx, "setting.resync")).map((a) => a.summary)).toEqual(
      expect.arrayContaining([
        'licensing.entitlementHolder set from the manifest: unset → "owner"',
      ]),
    );
  });

  it("entitlementModel defaults to legacy for a product registered before the cut-over", async () => {
    const before = await linked({}, COMBINED_ENTITLEMENT_MODEL_SINCE - 86400);
    expect((await settings(before)).entitlementModel).toBe("legacy");
    const after = await linked({}, AFTER);
    expect((await settings(after)).entitlementModel).toBe("combined");
    // A manifest value overrides the derived default either way.
    const declared = await linked(
      { licensing: { entitlementModel: "combined" } },
      COMBINED_ENTITLEMENT_MODEL_SINCE - 86400,
    );
    expect((await settings(declared)).entitlementModel).toBe("combined");
  });

  it("a resync applies a changed value and clears a dropped one (omit-clears), with audit rows", async () => {
    const ctx = await linked(
      { licensing: { anchorPolicy: "oldest", clampGraceToExpiry: false } },
      AFTER,
    );
    await resync(ctx, { licensing: { anchorPolicy: "most-free-seats" } });
    const s = await settings(ctx);
    expect(s.anchorPolicy).toBe("most-free-seats");
    expect(s.clampGraceToExpiry).toBe(true);
    expect((await rows(ctx)).map((r) => r.key)).toEqual([
      "licensing.anchorPolicy",
    ]);
    const summaries = (await audits(ctx, "setting.resync")).map(
      (a) => a.summary,
    );
    expect(summaries).toContain(
      'licensing.anchorPolicy set from the manifest: "oldest" → "most-free-seats"',
    );
    expect(summaries).toContain(
      "licensing.clampGraceToExpiry cleared from the manifest: false → default",
    );
  });

  it("an unchanged resync writes no audit row for the settings", async () => {
    const ctx = await linked({ licensing: { reanchor: "never" } }, AFTER);
    const settingRows = async () =>
      (await audits(ctx, "setting.resync")).filter((a) =>
        a.target_id.startsWith("licensing."),
      ).length;
    const before = await settingRows();
    expect(before).toBe(1);
    await resync(ctx, { licensing: { reanchor: "never" } });
    expect(await settingRows()).toBe(before);
  });
});

describe("a console edit survives a resync, and Revert restores the manifest value (S-18 §4.5)", () => {
  it("licensing.anchorPolicy: claim, resync, revert", async () => {
    const ctx = await linked({ licensing: { anchorPolicy: "oldest" } }, AFTER);
    const read = await call(ctx, "GET", "effective?area=license.licensing");
    expect(read.status).toBe(200);
    const anchor = (read.json.settings as Record<string, unknown>[]).find(
      (s) => s.key === "licensing.anchorPolicy",
    )!;
    expect(anchor).toMatchObject({
      value: "oldest",
      source: "manifest",
      manifestValue: "oldest",
      version: 1,
    });

    const edit = await call(ctx, "PATCH", "licensing.anchorPolicy", {
      value: "most-free-seats",
      expectedVersion: 1,
    });
    expect(edit.status).toBe(200);
    expect(edit.json).toMatchObject({
      ok: true,
      claimed: true,
      setting: { value: "most-free-seats", source: "console", version: 2 },
    });

    // The manifest changes the value: the claim wins, and the resync says so.
    const res = await resync(ctx, {
      licensing: { anchorPolicy: "rank-first" },
    });
    expect(res.claimed).toContain("licensing.anchorPolicy");
    expect((await settings(ctx)).anchorPolicy).toBe("most-free-seats");

    // Revert restores the last applied manifest's value at once, not at the next push.
    const revert = await call(ctx, "DELETE", "licensing.anchorPolicy", {
      expectedVersion: 2,
    });
    expect(revert.status).toBe(200);
    expect(revert.json).toMatchObject({
      ok: true,
      applied: true,
      setting: { value: "rank-first", source: "manifest" },
    });
    expect((await settings(ctx)).anchorPolicy).toBe("rank-first");
    // And it follows the manifest again.
    await resync(ctx, { licensing: { anchorPolicy: "oldest" } }, 120);
    expect((await settings(ctx)).anchorPolicy).toBe("oldest");

    const claim = await audits(ctx, "setting.claim");
    expect(claim.map((a) => [a.target_id, a.actor_sub])).toEqual([
      ["licensing.anchorPolicy", "u1"],
    ]);
    expect((await audits(ctx, "setting.revert"))[0]!.summary).toBe(
      'Reverted licensing.anchorPolicy to the manifest: "most-free-seats" → "rank-first"',
    );
  });

  it("a claim survives a resync that drops the key; Revert of an undeclared key restores the default", async () => {
    const ctx = await linked({ licensing: { refundGraceHours: 12 } }, AFTER);
    expect(
      (
        await call(ctx, "PATCH", "licensing.refundGraceHours", {
          value: 72,
          expectedVersion: 1,
        })
      ).status,
    ).toBe(200);
    await resync(ctx, {});
    expect((await settings(ctx)).refundGraceHours).toBe(72);
    const revert = await call(ctx, "DELETE", "licensing.refundGraceHours", {
      expectedVersion: 2,
    });
    expect(revert.json).toMatchObject({
      applied: true,
      setting: { value: 0, source: "default", version: 0 },
    });
    expect(await rows(ctx)).toEqual([]);
  });

  it("identity.oidc.syncTierOnSignIn goes through the same path", async () => {
    const ctx = await linked({ syncTier: "off" }, AFTER);
    expect(
      (
        await call(ctx, "PATCH", "identity.oidc.syncTierOnSignIn", {
          value: "upgradeOnly",
          expectedVersion: 1,
          reason: "IdP groups now carry the tier",
        })
      ).status,
    ).toBe(200);
    await resync(ctx, { syncTier: "off" });
    expect(await syncTier(ctx)).toBe("upgradeOnly");
    await call(ctx, "DELETE", "identity.oidc.syncTierOnSignIn", {
      expectedVersion: 2,
    });
    expect(await syncTier(ctx)).toBe("off");
  });

  it("the resync dry run lists the claim under skipClaimed", async () => {
    const ctx = await linked({}, AFTER);
    await call(ctx, "PATCH", "licensing.reanchor", {
      value: "never",
      expectedVersion: 0,
    });
    const docs = files({ licensing: { reanchor: "onActivation" } });
    const parsed = parseManifest({
      schema: docs[".pkey/schema.json"]!,
      product: docs[".pkey/product.json"]!,
      release: docs[".pkey/release.json"]!,
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const plan = await planRepoManifest(
      ctx.db,
      SLUG,
      parsed.manifest,
      ctx.at + 2,
    );
    expect(plan.skipClaimed).toContainEqual({
      area: "settings",
      summary: "licensing.reanchor stays as set in the console",
    });
  });
});

describe("the settings API refuses what the registry refuses", () => {
  it("out-of-spec values, onRefresh, and a missing value", async () => {
    const ctx = await linked({}, AFTER);
    for (const [key, value] of [
      ["licensing.refundGraceHours", 169],
      ["licensing.refundGraceHours", 1.5],
      ["licensing.anchorPolicy", "newest"],
      ["licensing.reanchor", "onRefresh"],
      ["licensing.clampGraceToExpiry", "yes"],
    ] as const) {
      const res = await call(ctx, "PATCH", key, {
        value,
        expectedVersion: 0,
        reason: "test",
      });
      expect(res.status, `${key} = ${JSON.stringify(value)}`).toBe(422);
      expect(res.json.reason).toBe("invalid_value");
    }
    expect(
      (await call(ctx, "PATCH", "licensing.anchorPolicy", {})).json.reason,
    ).toBe("invalid_value");
  });

  it("a critical setting needs a reason, which is stored and audited", async () => {
    const ctx = await linked({}, AFTER);
    const bare = await call(ctx, "PATCH", "licensing.entitlementHolder", {
      value: "owner",
      expectedVersion: 0,
    });
    expect(bare.status).toBe(422);
    expect(bare.json.reason).toBe("reason_required");
    const ok = await call(ctx, "PATCH", "licensing.entitlementHolder", {
      value: "owner",
      expectedVersion: 0,
      reason: "shared studio keys",
    });
    expect(ok.status).toBe(200);
    expect(ok.json.setting).toMatchObject({ reason: "shared studio keys" });
    expect((await audits(ctx, "setting.claim"))[0]!.summary).toContain(
      "(reason: shared studio keys)",
    );
  });

  it("a stale expectedVersion is a 409 carrying the current value", async () => {
    const ctx = await linked({ licensing: { reanchor: "never" } }, AFTER);
    const res = await call(ctx, "PATCH", "licensing.reanchor", {
      value: "onActivation",
      expectedVersion: 0,
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({
      reason: "version_conflict",
      current: { value: "never", version: 1 },
    });
  });

  it("expectedVersion is required on a save and on a revert", async () => {
    const ctx = await linked({ licensing: { reanchor: "never" } }, AFTER);
    const save = await call(ctx, "PATCH", "licensing.reanchor", {
      value: "onActivation",
    });
    expect(save.status).toBe(422);
    expect(save.json).toMatchObject({
      reason: "invalid_expected_version",
      fields: ["expectedVersion"],
    });
    const revert = await call(ctx, "DELETE", "licensing.reanchor", {});
    expect(revert.status).toBe(422);
    expect(revert.json.reason).toBe("invalid_expected_version");
    // Nothing was written.
    expect((await settings(ctx)).reanchor).toBe("never");
    expect(await audits(ctx, "setting.claim")).toEqual([]);
  });

  it("two concurrent saves at the same version: one wins, the loser writes no audit row", async () => {
    const ctx = await linked({ licensing: { anchorPolicy: "oldest" } }, AFTER);
    const product = (await getProduct(ctx.db, SLUG))!;
    const def = SETTINGS.get("licensing.anchorPolicy", "product")!;
    // Both read version 1 before either batch runs.
    const db = afterReads(ctx.db, 2);
    const [a, b] = await Promise.all([
      writeRowSetting(
        db,
        product,
        def,
        { value: "rank-first", expectedVersion: 1 },
        ACTOR,
        AFTER + 5,
      ),
      writeRowSetting(
        db,
        product,
        def,
        { value: "most-free-seats", expectedVersion: 1 },
        ACTOR,
        AFTER + 5,
      ),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const loser = (a.ok ? b : a) as { status: number; reason: string };
    expect(loser).toMatchObject({ status: 409, reason: "version_conflict" });
    expect(await audits(ctx, "setting.claim")).toHaveLength(1);
    expect((await settings(ctx)).anchorPolicy).toBe(
      a.ok ? "rank-first" : "most-free-seats",
    );
  });

  it("two concurrent reverts: one wins, the loser writes no audit row", async () => {
    const ctx = await linked({ licensing: { anchorPolicy: "oldest" } }, AFTER);
    await call(ctx, "PATCH", "licensing.anchorPolicy", {
      value: "most-free-seats",
      expectedVersion: 1,
    });
    const product = (await getProduct(ctx.db, SLUG))!;
    const def = SETTINGS.get("licensing.anchorPolicy", "product")!;
    const db = afterReads(ctx.db, 2);
    const [a, b] = await Promise.all([
      revertRowSetting(
        db,
        product,
        def,
        { expectedVersion: 2 },
        ACTOR,
        AFTER + 5,
      ),
      revertRowSetting(
        db,
        product,
        def,
        { expectedVersion: 2 },
        ACTOR,
        AFTER + 5,
      ),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(a.ok ? b : a).toMatchObject({
      status: 409,
      reason: "version_conflict",
    });
    expect(await audits(ctx, "setting.revert")).toHaveLength(1);
    expect(await rows(ctx)).toEqual([
      {
        key: "licensing.anchorPolicy",
        value_json: '"oldest"',
        source: "manifest",
      },
    ]);
  });

  it("the pending billing-retry grace and keys this API does not serve", async () => {
    const ctx = await linked({ licensing: { dunningGraceDays: 5 } }, AFTER);
    // Stored from the manifest, but hidden until LX-23.
    expect((await settings(ctx)).dunningGraceDays).toBe(5);
    const read = await call(ctx, "GET", "effective");
    expect(
      (read.json.settings as { key: string }[]).map((s) => s.key),
    ).not.toContain("licensing.dunningGraceDays");
    const write = await call(ctx, "PATCH", "licensing.dunningGraceDays", {
      value: 3,
      expectedVersion: 1,
    });
    expect(write.status).toBe(409);
    expect(write.json.reason).toBe("setting_pending");
    for (const key of ["license.defaults.deviceLimit", "nope.missing"]) {
      const res = await call(ctx, "PATCH", key, {
        value: 1,
        expectedVersion: 0,
      });
      expect(res.status, key).toBe(404);
      expect(res.json.reason).toBe("unknown_setting");
    }
  });

  it("Revert without a claim is a 409", async () => {
    const ctx = await linked({ licensing: { reanchor: "never" } }, AFTER);
    const res = await call(ctx, "DELETE", "licensing.reanchor", {
      expectedVersion: 1,
    });
    expect(res.status).toBe(409);
    expect(res.json.reason).toBe("not_claimed");
  });

  it("the system product is manifest-authoritative", async () => {
    const ctx = await linked({}, AFTER);
    await ctx.db.run("UPDATE products SET system = 1 WHERE slug = ?", SLUG);
    const res = await call(ctx, "PATCH", "licensing.reanchor", {
      value: "never",
      expectedVersion: 0,
    });
    expect(res.status).toBe(409);
    expect(res.json.reason).toBe("system_product");
  });

  it("every live row-backed entry is one the API serves", () => {
    const served = SETTINGS.entries
      .filter(
        (d) =>
          d.scope === "product" &&
          d.storage.kind === "scalar" &&
          d.ownership === "claimable" &&
          !d.pending,
      )
      .map((d) => d.key)
      .sort();
    expect(served).toEqual([
      "identity.oidc.syncTierOnSignIn",
      "licensing.anchorPolicy",
      "licensing.clampGraceToExpiry",
      "licensing.entitlementHolder",
      "licensing.entitlementModel",
      "licensing.reanchor",
      "licensing.refundGraceHours",
    ]);
  });
});
