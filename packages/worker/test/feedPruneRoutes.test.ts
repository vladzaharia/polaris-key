/**
 * Feed retention through the real dispatcher: the submit route's stable publish prunes the
 * package's builds of main below it once the product opted in (a beta publish does not; a tenant
 * product is off by default), a pruned version is never republished, the CI backfill route
 * (`release:yank`, dry run by default, this product's tokens only) and the admin Feeds routes
 * (the retention setting and the backfill, platform admins only, and the platform scope before
 * and after the bootstrap).
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, TEST_KEK, seedProduct } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import {
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";

installDigestStream();

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });
const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};

let db: Db;
let env: Env;
let r2: R2Mock;
let publishToken: string;
let yankToken: string;

function declaration() {
  const res = parseManifest({
    product: JSON.stringify({ slug: SLUG, name: "djdl" }),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify({
      release: {
        provider: { type: "github", owner: "acme", repo: "djdl" },
        deliverables: {
          "npm.sdk": {
            kind: "package",
            ecosystem: "npm",
            name: "@acme/sdk",
            artifacts: { tarball: { match: "acme-sdk-*.tgz" } },
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db, {
    manual_channels_json: JSON.stringify([
      { name: "main", regex: "v?[0-9]+\\.[0-9]+\\.[0-9]+-main\\.[0-9]+" },
    ]),
  });
  const rel = declaration();
  await db.batch(
    manifestDeliverableStatements(
      SLUG,
      rel.app,
      NOW,
      rel.packDeliverables,
      rel.packageDeliverables,
    ),
  );
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json,
       max_package_bytes, ext_json, updated_at)
     VALUES (?, 'npm', 1, ?, 52428800, '{}', ?)`,
    SLUG,
    JSON.stringify({ scope: "@acme" }),
    NOW,
  );
  const issue = async (scopes: string[]) =>
    (
      await issueStaticCiToken(env, db, {
        product: SLUG,
        scopes,
        expiresAt: NOW + 3600,
        label: null,
        createdBy: "u1",
        now: NOW,
      })
    ).token;
  publishToken = await issue(["release:publish"]);
  yankToken = await issue(["release:yank"]);
});

afterEach(() => {
  vi.useRealTimers();
});

function post(path: string, body: unknown, token = publishToken) {
  return call(env, db, noFetch, `${CONSOLE}/${SLUG}/release/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

/** uploads → stage → submit one npm version on `channel`. */
async function publish(version: string, channel: string) {
  const bytes = new TextEncoder().encode(`tarball of @acme/sdk ${version}`);
  const s = sha(bytes);
  const up = await post("publish/uploads", {
    objects: [{ sha256: s, size: bytes.length }],
  });
  expect(up.status).toBe(200);
  const u = (await up.json()) as { ticket: string; prefix: string };
  r2.seed(`${u.prefix}${s}`, bytes, { withSha256: true });
  const res = await post("publish/submit", {
    ticket: u.ticket,
    descriptor: {
      descriptorVersion: 1,
      product: SLUG,
      deliverable: "npm.sdk",
      kind: "package",
      version,
      channel,
      package: {
        ecosystem: "npm",
        name: "@acme/sdk",
        files: [
          {
            name: `acme-sdk-${version}.tgz`,
            role: "payload",
            type: "npm-tarball",
            sha256: s,
            size: bytes.length,
            locations: [{ provider: "r2", key: `blobs/sha256/${s}` }],
          },
        ],
        metadata: { name: "@acme/sdk", version, dependencies: {} },
      },
    },
  });
  return { res, body: (await res.json()) as Record<string, any> };
}

const versions = async () =>
  (
    await db.all<{ version: string }>(
      "SELECT version FROM release_packages WHERE product = ? ORDER BY version",
      SLUG,
    )
  ).map((r) => r.version);

async function admin(
  method: string,
  path: string,
  body?: unknown,
  groups = ["platform-admins"],
) {
  const { token: t, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  const full = `/api${path}`;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${t}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    full,
    { now: NOW },
  );
}

const retention = `/products/${SLUG}/distribution/feeds/retention`;

describe("a stable publish prunes the builds of main (feed retention)", () => {
  it("once opted in: beta prunes nothing; stable prunes the builds of main at or below it; newer ones stay; a pruned version is never republished", async () => {
    const on = await admin("PUT", retention, {
      expectedVersion: 0,
      prunePrereleases: true,
    });
    expect(on.status, await on.clone().text()).toBe(200);
    expect(await on.json()).toMatchObject({
      prunePrereleases: true,
      version: 1,
    });
    for (const [v, c] of [
      ["1.0.0", "stable"],
      ["1.1.0-main.1", "main"],
      ["1.1.0-main.2", "main"],
      ["1.1.0-rc.1", "beta"],
    ] as const)
      expect((await publish(v, c)).res.status, v).toBe(200);
    expect(await versions()).toHaveLength(4);
    expect((await publish("1.1.1-main.1", "main")).res.status).toBe(200);
    expect(await versions()).toHaveLength(5);

    const stable = await publish("1.1.0", "stable");
    expect(stable.res.status, JSON.stringify(stable.body)).toBe(200);
    expect(stable.body).toMatchObject({ outcome: "created" });
    expect(await versions()).toEqual([
      "1.0.0",
      "1.1.0",
      "1.1.0-rc.1",
      "1.1.1-main.1",
    ]);
    expect(
      await db.all(
        "SELECT actor_sub, target_id, parent_id FROM audit WHERE product = ? AND action = 'package.version.prune' ORDER BY target_id",
        SLUG,
      ),
    ).toEqual([
      {
        actor_sub: "system:feed-retention",
        target_id: "npm:@acme/sdk@1.1.0-main.1",
        parent_id: "npm.sdk@1.1.0",
      },
      {
        actor_sub: "system:feed-retention",
        target_id: "npm:@acme/sdk@1.1.0-main.2",
        parent_id: "npm.sdk@1.1.0",
      },
    ]);

    // Unique forever: the tombstone refuses the version.
    const again = await publish("1.1.0-main.1", "main");
    expect(again.res.status).toBe(409);
    expect(again.body).toMatchObject({ reason: "package-version-taken" });
    expect(again.body.message).toContain("pruned");
  });

  it("is off by default for a tenant product, which keeps its builds of main until it opts in", async () => {
    const get = await admin("GET", retention);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      product: SLUG,
      prunePrereleases: false,
      locked: false,
      version: 0,
      updatedAt: null,
      updatedBy: null,
    });
    expect((await publish("1.1.0-main.1", "main")).res.status).toBe(200);
    expect((await publish("1.1.0", "stable")).res.status).toBe(200);
    expect(await versions()).toEqual(["1.1.0", "1.1.0-main.1"]);
    expect(
      await db.first(
        "SELECT COUNT(*) AS n FROM audit WHERE product = ? AND action = 'package.version.prune'",
        SLUG,
      ),
    ).toEqual({ n: 0 });

    // The backfill is an explicit act: it runs whatever the setting says.
    const dry = await admin(
      "POST",
      `/products/${SLUG}/distribution/feeds/prune`,
      {},
    );
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({
      dryRun: true,
      prunePrereleases: false,
      totals: { versions: 1 },
    });
    expect(await versions()).toHaveLength(2);
    const applied = await admin(
      "POST",
      `/products/${SLUG}/distribution/feeds/prune`,
      { apply: true },
    );
    expect(await applied.json()).toMatchObject({
      dryRun: false,
      totals: { versions: 1, failed: 0 },
    });
    expect(await versions()).toEqual(["1.1.0"]);
    expect(
      await db.first(
        "SELECT actor_sub, parent_id FROM audit WHERE product = ? AND action = 'package.version.prune'",
        SLUG,
      ),
    ).toEqual({ actor_sub: "admin:u1", parent_id: "npm.sdk@1.1.0" });

    // Opting in, then a stale write refused.
    const put = await admin("PUT", retention, {
      expectedVersion: 0,
      prunePrereleases: true,
    });
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await put.json()).toMatchObject({
      prunePrereleases: true,
      version: 1,
      locked: false,
    });
    expect(
      (
        await admin("PUT", retention, {
          expectedVersion: 0,
          prunePrereleases: false,
        })
      ).status,
    ).toBe(409);
    expect(
      await db.first(
        "SELECT summary FROM audit WHERE product = ? AND action = 'feed.retention.update'",
        SLUG,
      ),
    ).toEqual({
      summary:
        "Turned on pruning of the builds of main once a version is released",
    });
  });
});

describe("POST /<p>/release/packages/prune (CI backfill)", () => {
  beforeEach(async () => {
    // Retention is off by default, so the stable publish leaves the build of main listed.
    expect((await publish("1.0.0", "stable")).res.status).toBe(200);
    expect((await publish("1.1.0-main.1", "main")).res.status).toBe(200);
    expect((await publish("1.1.0", "stable")).res.status).toBe(200);
  });

  it("needs release:yank", async () => {
    const res = await post("packages/prune", {}, publishToken);
    expect(res.status).toBe(403);
  });

  it("refuses another product's release:yank token (401) and prunes nothing", async () => {
    await seedProduct(db, "other");
    const foreign = (
      await issueStaticCiToken(env, db, {
        product: "other",
        scopes: ["release:yank"],
        expiresAt: NOW + 3600,
        label: null,
        createdBy: "u1",
        now: NOW,
      })
    ).token;
    for (const body of [{}, { apply: true }])
      expect((await post("packages/prune", body, foreign)).status).toBe(401);
    expect(await versions()).toHaveLength(3);
  });

  it("dry-runs by default, applies with apply: true, and refuses a bad body", async () => {
    const dry = await post("packages/prune", {}, yankToken);
    expect(dry.status).toBe(200);
    const body = (await dry.json()) as Record<string, any>;
    expect(body).toMatchObject({
      ok: true,
      product: SLUG,
      dryRun: true,
      totals: { versions: 1, failed: 0 },
    });
    expect(body.packages[0]).toMatchObject({
      deliverableId: "npm.sdk",
      stable: "1.1.0",
      prune: [{ version: "1.1.0-main.1", files: 1 }],
    });
    expect(body.totals.bytes).toBeGreaterThan(0);
    expect(await versions()).toHaveLength(3);

    expect(
      (await post("packages/prune", { apply: "yes" }, yankToken)).status,
    ).toBe(400);
    expect(
      (await post("packages/prune", { deliverable: "nope" }, yankToken)).status,
    ).toBe(404);

    const applied = await post("packages/prune", { apply: true }, yankToken);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      dryRun: false,
      totals: { versions: 1 },
    });
    expect(await versions()).toEqual(["1.0.0", "1.1.0"]);
    const audit = await db.first<{ actor_sub: string }>(
      "SELECT actor_sub FROM audit WHERE product = ? AND action = 'package.version.prune'",
      SLUG,
    );
    expect(audit?.actor_sub).toMatch(/^ci:/);
  });
});

describe("the admin feed retention routes", () => {
  it("refuse a session that is not platform admin (403) on both prune routes and PUT /retention", async () => {
    expect((await publish("1.1.0-main.1", "main")).res.status).toBe(200);
    expect((await publish("1.1.0", "stable")).res.status).toBe(200);
    const staff = ["staff"];
    for (const [method, path, body] of [
      ["POST", `/products/${SLUG}/distribution/feeds/prune`, { apply: true }],
      ["POST", "/platform/feeds/prune", { apply: true }],
      ["PUT", retention, { expectedVersion: 0, prunePrereleases: true }],
      [
        "PUT",
        "/platform/feeds/retention",
        { expectedVersion: 0, prunePrereleases: false },
      ],
    ] as const)
      expect((await admin(method, path, body, staff)).status, path).toBe(403);
    expect(await versions()).toEqual(["1.1.0", "1.1.0-main.1"]);
    expect(
      await db.first(
        "SELECT COUNT(*) AS n FROM release_package_retention WHERE product = ?",
        SLUG,
      ),
    ).toEqual({ n: 0 });
  });

  it("POST /platform/feeds/prune: 404 before the bootstrap, a dry run after it, 422 for a non-boolean apply", async () => {
    env.PLATFORM_KEK = TEST_KEK;
    env.PKG_ORIGIN = "https://pkg.plrs.im";
    expect((await admin("POST", "/platform/feeds/prune", {})).status).toBe(404);
    expect((await admin("GET", "/platform/feeds/retention")).status).toBe(404);

    const boot = await admin("POST", "/platform/feeds/bootstrap");
    expect(boot.status, await boot.clone().text()).toBe(200);
    const dry = await admin("POST", "/platform/feeds/prune", {});
    expect(dry.status, await dry.clone().text()).toBe(200);
    expect(await dry.json()).toMatchObject({
      product: SYSTEM_PRODUCT_SLUG,
      dryRun: true,
      // The system product's retention is on and locked.
      prunePrereleases: true,
      totals: { versions: 0, failed: 0, skipped: 0 },
    });
    const bad = await admin("POST", "/platform/feeds/prune", { apply: "true" });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ fields: ["apply"] });

    // The system product's default: on, locked, and a write is refused.
    expect(
      await (await admin("GET", "/platform/feeds/retention")).json(),
    ).toMatchObject({
      product: SYSTEM_PRODUCT_SLUG,
      prunePrereleases: true,
      locked: true,
      version: 0,
    });
    const off = await admin("PUT", "/platform/feeds/retention", {
      expectedVersion: 0,
      prunePrereleases: false,
    });
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ reason: "retention_locked" });
  });
});
