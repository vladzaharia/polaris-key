/**
 * F-34.3: `distribution.packageFeeds`, the owner's off switch, as a registry setting (ST-05a). The
 * switch is written one way (the generic settings route and `PUT …/package-feeds` both end in
 * `writeSetting()`), reports who wrote it, rides the product summary, and fails closed: off, every
 * read the ladder answers is the not-found and the publish paths see `ownerEnabled: false`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, TEST_KEK, seedProduct } from "./seed.js";
import { CONSOLE, enableServices, envFor } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { authorizeFeedRead } from "../src/services/distribution/registry/authorize.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import {
  packageFeedOf,
  packageFeedsOf,
  stmtProvisionFeed,
  stmtProvisionOwner,
} from "../src/services/distribution/registryFeeds.js";
import type { ServicesMap } from "../src/core/services.js";

let db: Db;
let env: Env;
const OWNER = "acme";
const KEY = "distribution.packageFeeds";
const ON: ServicesMap = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: false },
  identity: { enabled: false },
  sync: { enabled: false },
  commerce: { enabled: false },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.PLATFORM_KEK = TEST_KEK;
  env.PKG_ORIGIN = "https://pkg.plrs.im";
  await seedProduct(db, OWNER);
  await enableServices(db, true, OWNER);
  forgetRegistrySettings();
});

async function admin(
  method: string,
  path: string,
  body?: unknown,
  groups = ["platform-admins"],
): Promise<{ status: number; json: Loose }> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  const full = `/api${path}`;
  const res = await handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    full.split("?")[0]!,
    { now: NOW },
  );
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const setting = `/products/${OWNER}/settings/${KEY}`;
const legacy = `/products/${OWNER}/distribution/package-feeds`;

async function declareNpm(): Promise<void> {
  await db.run(
    `INSERT INTO release_deliverables
       (product, deliverable_id, kind, def_source, created_at, modified_at, ecosystem, package_name)
     VALUES (?, 'npm.sdk', 'package', 'manifest', ?, ?, 'npm', '@acme/sdk')`,
    OWNER,
    NOW,
    NOW,
  );
}

const auditActions = async () =>
  (
    await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ? ORDER BY rowid",
      OWNER,
    )
  ).map((r) => r.action);

describe("the packageFeeds registry setting", () => {
  it("is served by the generic settings route: off by default, written through it, audited", async () => {
    const got = await admin("GET", setting);
    expect(got.status).toBe(200);
    expect(got.json.setting).toMatchObject({
      key: KEY,
      value: false,
      source: "default",
    });
    const on = await admin("PATCH", setting, {
      value: true,
      expectedVersion: 0,
    });
    expect(on.status).toBe(200);
    expect(await packageFeedsOf(db, OWNER)).toMatchObject({
      enabled: true,
      updatedBy: "u1",
    });
    // The render of every package feed rides the same batch.
    expect(
      await db.all(
        "SELECT deliverable_id, reason FROM registry_render_queue WHERE product = ?",
        OWNER,
      ),
    ).toEqual([{ deliverable_id: "*", reason: "package-feeds" }]);
    expect(await auditActions()).toContain("distribution.package_feeds.update");
    // A stale version is refused, and nothing changed.
    const stale = await admin("PATCH", setting, {
      value: false,
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect((await packageFeedsOf(db, OWNER)).enabled).toBe(true);
  });

  it("PUT …/package-feeds goes through the same write path and keeps its contract", async () => {
    const on = await admin("PUT", legacy, {
      enabled: true,
      expectedVersion: 0,
    });
    expect(on.status).toBe(200);
    expect(on.json.packageFeeds).toMatchObject({
      enabled: true,
      version: 1,
      updatedBy: "u1",
    });
    // The registry's own row exists too: one write path, one version history.
    const view = await admin("GET", setting);
    expect(view.json.setting).toMatchObject({ value: true, source: "console" });
    expect(
      (
        await db.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM product_settings WHERE product = ? AND key = ?",
          OWNER,
          KEY,
        )
      )?.n,
    ).toBe(1);
    const stale = await admin("PUT", legacy, {
      enabled: false,
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ reason: "version_conflict" });
    const off = await admin("PUT", legacy, {
      enabled: false,
      expectedVersion: 1,
    });
    expect(off.json.packageFeeds).toMatchObject({ enabled: false, version: 2 });
    expect(
      (await auditActions()).filter(
        (a) => a === "distribution.package_feeds.update",
      ),
    ).toHaveLength(2);
  });

  it("is operator-only: a non-admin can neither read nor flip it", async () => {
    expect((await admin("GET", setting, undefined, ["staff"])).status).toBe(
      403,
    );
    const put = await admin(
      "PUT",
      legacy,
      { enabled: true, expectedVersion: 0 },
      ["staff"],
    );
    expect(put.status).toBe(403);
    expect((await packageFeedsOf(db, OWNER)).enabled).toBe(false);
  });

  it("reads a manifest-provisioned owner row as source manifest", async () => {
    await db.batch([
      stmtProvisionOwner(OWNER, NOW),
      stmtProvisionFeed(OWNER, "npm", { scope: "@acme" }, NOW),
    ]);
    const got = await admin("GET", setting);
    expect(got.json.setting).toMatchObject({ value: true, source: "manifest" });
    expect((await packageFeedsOf(db, OWNER)).updatedBy).toBe("manifest");
  });
});

describe("the product summary", () => {
  it("carries packages: declared, feedsOn, and who turned the feeds off", async () => {
    let row = (await admin("GET", `/products/${OWNER}`)).json.product;
    expect(row.packages).toEqual({
      declared: 0,
      feedsOn: false,
      offBy: null,
      offAt: null,
    });
    await declareNpm();
    await admin("PUT", legacy, { enabled: true, expectedVersion: 0 });
    row = (await admin("GET", `/products/${OWNER}`)).json.product;
    expect(row.packages).toEqual({
      declared: 1,
      feedsOn: true,
      offBy: null,
      offAt: null,
    });
    await admin("PUT", legacy, { enabled: false, expectedVersion: 1 });
    row = (await admin("GET", `/products/${OWNER}`)).json.product;
    expect(row.packages).toEqual({
      declared: 1,
      feedsOn: false,
      offBy: "u1",
      offAt: NOW,
    });
    expect(row.packageFeeds).toBe(false);
  });
});

describe("the off state fails closed", () => {
  const read = () =>
    authorizeFeedRead({ db, services: ON }, null, OWNER, "npm", "npm.sdk");

  async function publicFeed(): Promise<void> {
    await db.run(
      `INSERT INTO dist_registry_feeds
         (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes,
          upstream, claims_json, ext_json, version, updated_at, updated_by)
       VALUES (?, 'npm', 1, 'public', '{"scope":"@acme"}', 1000, 'none', '[]', '{}', 1, ?, 'x')`,
      OWNER,
      NOW,
    );
    await db.run(
      `INSERT INTO dist_access (product, deliverable_id, mode, source, modified_at)
       VALUES (?, 'npm.sdk', 'public', 'manifest', ?)`,
      OWNER,
      NOW,
    );
    await db.run(
      "UPDATE dist_registry_policy SET enabled = 1 WHERE ecosystem = 'npm'",
    );
  }

  it("a feed with no owner row, and one whose owner is off, answer nothing", async () => {
    await publicFeed();
    expect(await read()).toEqual({ ok: false, challenge: "not-found" });
    expect((await packageFeedOf(db, OWNER, "npm"))?.ownerEnabled).toBe(false);
  });

  it("turning it off stops reads and publishes at once, and on serves them again", async () => {
    await publicFeed();
    await admin("PUT", legacy, { enabled: true, expectedVersion: 0 });
    forgetRegistrySettings();
    expect((await read()).ok).toBe(true);
    expect((await packageFeedOf(db, OWNER, "npm"))?.ownerEnabled).toBe(true);

    const off = await admin("PATCH", setting, {
      value: false,
      expectedVersion: 1,
      reason: "incident",
    });
    expect(off.status).toBe(200);
    // The write drops this isolate's cache; no 30-second window here.
    forgetRegistrySettings();
    expect(await read()).toEqual({ ok: false, challenge: "not-found" });
    // The publish paths (native, OCI) and the portal read this field.
    expect((await packageFeedOf(db, OWNER, "npm"))?.ownerEnabled).toBe(false);
    // Nothing was deleted.
    expect(
      (
        await db.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM dist_registry_feeds WHERE product = ?",
          OWNER,
        )
      )?.n,
    ).toBe(1);

    await admin("PATCH", setting, { value: true, expectedVersion: 2 });
    forgetRegistrySettings();
    expect((await read()).ok).toBe(true);
  });

  it("a manifest sync never turns it back on", async () => {
    await publicFeed();
    await admin("PUT", legacy, { enabled: true, expectedVersion: 0 });
    await admin("PUT", legacy, { enabled: false, expectedVersion: 1 });
    await db.batch([
      stmtProvisionOwner(OWNER, NOW + 5),
      stmtProvisionFeed(OWNER, "npm", { scope: "@acme" }, NOW + 5),
    ]);
    expect((await packageFeedsOf(db, OWNER)).enabled).toBe(false);
  });
});
