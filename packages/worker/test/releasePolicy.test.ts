/**
 * P2-05 — channel policy operations (`services/release/policy.ts`) through both of their
 * front doors: the CI routes (`pkeyci_` token with `release:promote` / `release:yank`) and the
 * console's admin API. And the effect on every surface: after a yank, `/update/version`, the
 * appcast and `/release/dl/latest/…` stop offering the release; after a pin, all three and
 * `/release/builds/stable/…` serve the pinned release.
 *
 * The `pkeyci_` credential store is P2-02's; until it lands `lookupCiToken` knows no token, so
 * this suite mocks that one seam (`core/ciTokens.ts`) and nothing else.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(
  () =>
    new Map<
      string,
      { product: string; subject: string; scopes: readonly string[] }
    >(),
);
vi.mock("../src/core/ciTokens.js", () => ({
  lookupCiToken: async (_env: unknown, _db: unknown, token: string) =>
    tokens.get(token) ?? null,
}));

import { makeTestDb } from "./helpers.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import {
  getChannelPolicy,
  setChannelPolicy,
} from "../src/services/release/model.js";
import { syncReleaseStore } from "../src/services/release/sync.js";
import {
  admin,
  ASSET_BYTES,
  auditRows,
  call,
  CONSOLE,
  envFor,
  github,
  RELEASES,
  seedReleaseProduct,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";

const PROMOTER = "pkeyci_promoter";
const YANKER = "pkeyci_yanker";
const PUBLISHER = "pkeyci_publisher";
const OTHER_PRODUCT = "pkeyci_other";

beforeEach(() => {
  tokens.clear();
  tokens.set(PROMOTER, {
    product: SLUG,
    subject: "repo:acme/djdl:environment:release",
    scopes: ["release:publish", "release:promote"],
  });
  tokens.set(YANKER, {
    product: SLUG,
    subject: "static:tok_1",
    scopes: ["release:yank"],
  });
  tokens.set(PUBLISHER, {
    product: SLUG,
    subject: "static:tok_2",
    scopes: ["release:publish"],
  });
  tokens.set(OTHER_PRODUCT, {
    product: "other",
    subject: "static:tok_3",
    scopes: ["release:promote", "release:yank"],
  });
});

async function setup(): Promise<{
  env: Env;
  db: Db;
  gh: ReturnType<typeof github>;
}> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const env = envFor();
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  return { env, db, gh };
}

function ci(
  env: Env,
  db: Db,
  gh: ReturnType<typeof github>,
  path: string,
  token: string | null,
  body: unknown,
): Promise<Response> {
  return call(env, db, gh.fetchImpl, `${CONSOLE}/${SLUG}/release${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** What every surface serves for the stable channel right now. */
async function surfaces(
  env: Env,
  db: Db,
  gh: ReturnType<typeof github>,
): Promise<{
  version: string | null;
  appcast: string;
  dl: Uint8Array | number;
  build: Uint8Array | number;
}> {
  const v = await call(
    env,
    db,
    gh.fetchImpl,
    `${CONSOLE}/${SLUG}/update/version`,
  );
  const a = await call(
    env,
    db,
    gh.fetchImpl,
    `${CONSOLE}/${SLUG}/update/appcast.xml?arch=arm64`,
  );
  const d = await call(
    env,
    db,
    gh.fetchImpl,
    `${CONSOLE}/${SLUG}/release/dl/latest/djdl-arm64`,
  );
  const b = await call(
    env,
    db,
    gh.fetchImpl,
    `${CONSOLE}/${SLUG}/release/builds/stable/cli-arm64`,
  );
  return {
    version:
      v.status === 200
        ? ((await v.json()) as { version: string }).version
        : null,
    appcast: await a.text(),
    dl: d.status === 200 ? new Uint8Array(await d.arrayBuffer()) : d.status,
    build: b.status === 200 ? new Uint8Array(await b.arrayBuffer()) : b.status,
  };
}

describe("CI routes: authentication and scope", () => {
  it("refuses a missing token, an unknown token and another product's token with 401", async () => {
    const { env, db, gh } = await setup();
    for (const token of [null, "ghs_not_ci", "pkeyci_unknown", OTHER_PRODUCT]) {
      const res = await ci(env, db, gh, "/channels/stable/promote", token, {
        releaseId: "v1.0.0",
      });
      expect(res.status, String(token)).toBe(401);
      const body = (await res.json()) as { error: string; reason: string };
      expect(body.error).toBe("unauthorized");
      expect(["ci_token_required", "invalid_ci_token"]).toContain(body.reason);
    }
    expect(await auditRows(db)).toEqual([]);
  });

  it("refuses a token without release:promote or release:yank with forbidden and a reason", async () => {
    const { env, db, gh } = await setup();
    const promote = await ci(env, db, gh, "/channels/stable/pin", PUBLISHER, {
      releaseId: "v1.0.0",
    });
    expect(promote.status).toBe(403);
    expect(await promote.json()).toMatchObject({
      error: "forbidden",
      reason: "missing_scope",
      scope: "release:promote",
    });
    const yank = await ci(env, db, gh, "/releases/v1.1.0/yank", PROMOTER, {
      reason: "bad build",
    });
    expect(yank.status).toBe(403);
    expect(await yank.json()).toMatchObject({
      error: "forbidden",
      reason: "missing_scope",
      scope: "release:yank",
    });
    // Nothing changed and nothing was audited.
    expect(
      await getChannelPolicy(db, {
        product: SLUG,
        deliverableId: "app",
        channel: "stable",
      }),
    ).toBeNull();
    expect(await auditRows(db)).toEqual([]);
  });

  it("only POST reaches a CI route", async () => {
    const { env, db, gh } = await setup();
    const res = await call(
      env,
      db,
      gh.fetchImpl,
      `${CONSOLE}/${SLUG}/release/channels/stable/promote`,
      { headers: { authorization: `Bearer ${PROMOTER}` } },
    );
    expect(res.status).toBe(404);
  });
});

describe("CI routes: operations", () => {
  it("promote, pin and unpin write the policy as an operator and audit ci:<subject>", async () => {
    const { env, db, gh } = await setup();
    const key = { product: SLUG, deliverableId: "app", channel: "beta" };

    // `staging` is the legacy spelling of `beta`: stored canonical, never as `staging`.
    const promoted = await ci(
      env,
      db,
      gh,
      "/channels/staging/promote",
      PROMOTER,
      {
        releaseId: "v1.0.0",
      },
    );
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({
      ok: true,
      policy: {
        channel: "beta",
        pointer: "v1.0.0",
        pinned: false,
        source: "admin",
        modifiedBy: "ci:repo:acme/djdl:environment:release",
      },
    });
    expect(
      await db.first(
        "SELECT 1 AS one FROM release_channel_policy WHERE channel = 'staging'",
      ),
    ).toBeNull();

    const pinned = await ci(env, db, gh, "/channels/beta/pin", PROMOTER, {
      releaseId: "v1.1.0",
    });
    expect(pinned.status).toBe(200);
    expect(await getChannelPolicy(db, key)).toMatchObject({
      pointer_release_id: "v1.1.0",
      pinned: 1,
      source: "admin",
    });
    const unpinned = await ci(
      env,
      db,
      gh,
      "/channels/beta/unpin",
      PROMOTER,
      {},
    );
    expect(unpinned.status).toBe(200);
    expect(await getChannelPolicy(db, key)).toMatchObject({
      pointer_release_id: "v1.1.0",
      pinned: 0,
    });

    expect(await auditRows(db)).toEqual([
      {
        action: "release.channel.promote",
        actor_sub: "ci:repo:acme/djdl:environment:release",
        target_id: "app/beta",
      },
      {
        action: "release.channel.pin",
        actor_sub: "ci:repo:acme/djdl:environment:release",
        target_id: "app/beta",
      },
      {
        action: "release.channel.unpin",
        actor_sub: "ci:repo:acme/djdl:environment:release",
        target_id: "app/beta",
      },
    ]);
  });

  it("refuses unknown channels, deliverables and releases, and a promote of a yanked release", async () => {
    const { env, db, gh } = await setup();
    const cases: Array<[string, unknown, number, string]> = [
      [
        "/channels/nightly/promote",
        { releaseId: "v1.0.0" },
        404,
        "unknown_channel",
      ],
      [
        "/channels/STABLE/promote",
        { releaseId: "v1.0.0" },
        404,
        "unknown_channel",
      ],
      [
        "/channels/stable/promote",
        { releaseId: "v1.0.0", deliverable: "nope" },
        404,
        "unknown_deliverable",
      ],
      [
        "/channels/stable/promote",
        { releaseId: "v9.9.9" },
        404,
        "unknown_release",
      ],
      ["/channels/stable/promote", {}, 422, "bad_release"],
    ];
    for (const [path, body, status, reason] of cases) {
      const res = await ci(env, db, gh, path, PROMOTER, body);
      expect(res.status, path).toBe(status);
      expect(((await res.json()) as { reason: string }).reason, path).toBe(
        reason,
      );
    }
    expect(
      (await ci(env, db, gh, "/releases/v1.1.0/yank", YANKER, { reason: "" }))
        .status,
    ).toBe(422);
    expect(
      (
        await ci(env, db, gh, "/releases/v1.1.0/yank", YANKER, {
          reason: "corrupt DMG",
        })
      ).status,
    ).toBe(200);
    const promoteYanked = await ci(
      env,
      db,
      gh,
      "/channels/stable/promote",
      PROMOTER,
      {
        releaseId: "v1.1.0",
      },
    );
    expect(promoteYanked.status).toBe(409);
    expect(((await promoteYanked.json()) as { reason: string }).reason).toBe(
      "release_yanked",
    );
    // …but it may still be pinned: yanked releases resolve only by explicit pin.
    expect(
      (
        await ci(env, db, gh, "/channels/stable/pin", PROMOTER, {
          releaseId: "v1.1.0",
        })
      ).status,
    ).toBe(200);
  });
});

describe("yanks and pins reach every surface", () => {
  it("after a yank, version, appcast and dl stop offering the release; after a pin all four serve it", async () => {
    const { env, db, gh } = await setup();
    const before = await surfaces(env, db, gh);
    expect(before.version).toBe("1.1.0");
    expect(before.appcast).toContain("1.1.0");
    expect(before.dl).toEqual(ASSET_BYTES[201]);
    expect(before.build).toEqual(ASSET_BYTES[201]);

    const yanked = await ci(env, db, gh, "/releases/v1.1.0/yank", YANKER, {
      reason: "crashes on launch",
    });
    expect(yanked.status).toBe(200);
    const after = await surfaces(env, db, gh);
    expect(after.version).toBe("1.0.0");
    expect(after.appcast).not.toContain("1.1.0");
    expect(after.appcast).toContain("1.0.0");
    expect(after.dl).toEqual(ASSET_BYTES[101]);
    expect(after.build).toEqual(ASSET_BYTES[101]);

    // An explicit pin of the yanked release: every surface follows it.
    const pinned = await admin(env, db, "PUT", "/channels/stable", {
      pointer: "v1.1.0",
      pinned: true,
    });
    expect(pinned.status).toBe(200);
    const pinnedNow = await surfaces(env, db, gh);
    expect(pinnedNow.version).toBe("1.1.0");
    expect(pinnedNow.appcast).toContain("1.1.0");
    expect(pinnedNow.dl).toEqual(ASSET_BYTES[201]);
    expect(pinnedNow.build).toEqual(ASSET_BYTES[201]);

    // A pin to the OLDER release holds the channel back on every surface too.
    await admin(env, db, "PUT", "/channels/stable", { pointer: "v1.0.0" });
    const held = await surfaces(env, db, gh);
    expect(held.version).toBe("1.0.0");
    expect(held.dl).toEqual(ASSET_BYTES[101]);
    expect(held.build).toEqual(ASSET_BYTES[101]);

    // Unyank + unpin: back to the newest.
    expect(
      (await admin(env, db, "DELETE", "/releases/v1.1.0/yank")).status,
    ).toBe(200);
    expect(
      (await admin(env, db, "PUT", "/channels/stable", { pinned: false }))
        .status,
    ).toBe(200);
    expect((await surfaces(env, db, gh)).version).toBe("1.1.0");
  });

  it("a yanked floor release does not 404 the channel: the yank is a deliberate withdrawal", async () => {
    const { env, db, gh } = await setup();
    // The sync above floored stable at 1.1.0 (R6-10). Yanking 1.1.0 must fall back, not 404.
    expect(
      await db.first(
        "SELECT version FROM release_channel_floors WHERE product = ?",
        SLUG,
      ),
    ).toEqual({ version: "1.1.0" });
    await admin(env, db, "POST", "/releases/v1.1.0/yank", { reason: "bad" });
    expect((await surfaces(env, db, gh)).version).toBe("1.0.0");
  });
});

describe("admin routes", () => {
  it("GET channels returns the policy per deliverable with source and what it resolves to", async () => {
    const { env, db } = await setup();
    await admin(env, db, "PUT", "/channels/beta", {
      minSupported: "1.0.0",
      critical: true,
    });
    const res = await admin(env, db, "GET", "/channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deliverables: Array<{
        deliverable: string;
        channels: Array<Record<string, unknown>>;
      }>;
    };
    expect(body.deliverables).toHaveLength(1);
    const app = body.deliverables[0]!;
    expect(app.deliverable).toBe("app");
    expect(app.channels.find((c) => c.channel === "stable")).toMatchObject({
      source: "manifest",
      pointer: null,
      resolved: "v1.1.0",
    });
    expect(app.channels.find((c) => c.channel === "beta")).toMatchObject({
      source: "admin",
      minSupported: "1.0.0",
      critical: true,
      modifiedBy: "admin:u1",
      resolved: "v1.1.0",
    });
  });

  it("PUT validates its fields and refuses a pin without a pointer", async () => {
    const { env, db } = await setup();
    const cases: Array<[unknown, string]> = [
      [{ pinned: true }, "pin_without_pointer"],
      [{ minSupported: "one" }, "bad_min_supported"],
      [{ critical: "yes" }, "bad_critical"],
      [{ pointer: "v9.9.9" }, "unknown_release"],
      [{ floor: "1.0.0" }, "unknown_field"],
      [{}, "empty_update"],
    ];
    for (const [body, reason] of cases) {
      const res = await admin(env, db, "PUT", "/channels/stable", body);
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(
        ((await res.json()) as { reason: string }).reason,
        JSON.stringify(body),
      ).toBe(reason);
    }
    expect(
      (await admin(env, db, "PUT", "/channels/nightly", { critical: true }))
        .status,
    ).toBe(404);
  });

  it("every admin change writes an audit row with the session's subject", async () => {
    const { env, db } = await setup();
    await admin(env, db, "PUT", "/channels/stable", {
      pointer: "v1.0.0",
      pinned: true,
    });
    await admin(env, db, "POST", "/channels/stable/revert", {});
    await admin(env, db, "POST", "/releases/v1.1.0/yank", { reason: "bad" });
    await admin(env, db, "DELETE", "/releases/v1.1.0/yank");
    expect(await auditRows(db)).toEqual([
      {
        action: "release.channel.update",
        actor_sub: "u1",
        target_id: "app/stable",
      },
      {
        action: "release.channel.revert",
        actor_sub: "u1",
        target_id: "app/stable",
      },
      { action: "release.yank", actor_sub: "u1", target_id: "v1.1.0" },
      { action: "release.unyank", actor_sub: "u1", target_id: "v1.1.0" },
    ]);
    const yank = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM release_yanks WHERE product = ?",
      SLUG,
    );
    expect(yank?.n).toBe(0);
  });

  it("the releases read model carries builds, roles, hashes, locations and the yank", async () => {
    const { env, db } = await setup();
    await admin(env, db, "POST", "/releases/v1.0.0/yank", { reason: "old" });
    const res = await admin(env, db, "GET", "/releases");
    const body = (await res.json()) as {
      releases: Array<{
        releaseId: string;
        builds: unknown[];
        artifacts: Array<Record<string, unknown>>;
        yank: unknown;
      }>;
    };
    const v1 = body.releases.find((r) => r.releaseId === "v1.0.0")!;
    expect(v1.yank).toMatchObject({ reason: "old", by: "admin:u1" });
    expect(v1.builds).toEqual([
      {
        buildId: "cli-arm64",
        platform: "macos",
        arch: "arm64",
        format: "binary",
        buildNumber: null,
        minOs: null,
      },
    ]);
    expect(v1.artifacts.find((a) => a.artifactId === "101")).toMatchObject({
      buildId: "cli-arm64",
      role: "payload",
      locations: null,
    });
    expect(
      (v1.artifacts.find((a) => a.artifactId === "101")!.sha256 as string)
        .length,
    ).toBe(64);
    expect(
      body.releases.find((r) => r.releaseId === "v1.1.0")!.yank,
    ).toBeNull();
  });
});

describe("an operator change survives a resync", () => {
  it("neither a manifest policy write nor a truth-store sync undoes an admin or CI change", async () => {
    const { env, db, gh } = await setup();
    await ci(env, db, gh, "/channels/stable/pin", PROMOTER, {
      releaseId: "v1.0.0",
    });
    const key = { product: SLUG, deliverableId: "app", channel: "stable" };

    // A resync's manifest write is refused by the source guard…
    expect(
      await setChannelPolicy(
        db,
        key,
        { pointerReleaseId: null, pinned: false, includes: ["beta"] },
        { source: "manifest", by: "manifest", now: NOW + 1 },
      ),
    ).toBe(false);
    // …and the truth-store sync never touches the policy table.
    await syncReleaseStore(env, db, SLUG, NOW + 2, gh.fetchImpl);
    expect(await getChannelPolicy(db, key)).toMatchObject({
      pointer_release_id: "v1.0.0",
      pinned: 1,
      source: "admin",
      includes_json: null,
    });
    expect((await surfaces(env, db, gh)).version).toBe("1.0.0");
  });
});
