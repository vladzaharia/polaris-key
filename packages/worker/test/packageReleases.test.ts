/**
 * F-03 — package releases through the real dispatcher (plans/F-01.md §3.2, §6.3, §6.7): the
 * submit route's package branch, the feed-level refusals, unique-forever versions, the npm and
 * Maven digests, the render queue, yank / unyank / deprecate and channel moves, the catalog hook,
 * and the packageFeeds toggle.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import {
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { releaseCatalog } from "../src/services/release/catalog.js";
import { digestStream } from "../src/services/release/packages/digests.js";
import { NO_HOOKS } from "./helpers.js";
import { getProduct } from "../src/repo.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";

/** The real admin API as a platform admin, at `/api<path>`. */
async function admin(
  _env: Env,
  _db: Db,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token: t, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
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

installDigestStream();

const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });

const RELEASE_DOC = {
  release: {
    provider: { type: "github", owner: "acme", repo: "djdl" },
    binaryName: "djdl",
    deliverables: {
      app: {
        kind: "app",
        versioning: { scheme: "semver" },
        artifacts: [
          {
            id: "web",
            platform: "web",
            arch: "wasm32",
            format: "zip",
            match: "djdl-*-web.zip",
          },
        ],
      },
      "npm.sdk": {
        kind: "package",
        ecosystem: "npm",
        name: "@acme/sdk",
        artifacts: { tarball: { match: "acme-sdk-*.tgz" } },
      },
      "maven.sdk": {
        kind: "package",
        ecosystem: "maven",
        name: "gg.acme:acme-sdk",
        artifacts: { jar: { match: "*.jar" } },
      },
      "swift.kit": {
        kind: "package",
        ecosystem: "swift",
        name: "acme.AcmeKit",
        artifacts: { archive: { match: "*.zip" } },
      },
    },
  },
};

function declaration() {
  const res = parseManifest({
    product: JSON.stringify({ slug: SLUG, name: "djdl" }),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify(RELEASE_DOC),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!;
}

let db: Db;
let env: Env;
let r2: R2Mock;
let token: string;

async function seedFeed(
  ecosystem: string,
  namespace: Record<string, unknown>,
  over: { max?: number; ext?: Record<string, unknown> } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json,
       max_package_bytes, ext_json, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
    SLUG,
    ecosystem,
    JSON.stringify(namespace),
    over.max ?? 52428800,
    JSON.stringify(over.ext ?? {}),
    NOW,
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.KEY_HASH_PEPPER = "pepper";
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  Object.assign(env, R2_ENV);
  await seedReleaseProduct(db);
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
  await seedFeed("npm", { scope: "@acme" });
  await seedFeed("maven", { groupPrefixes: ["gg.acme"] });
  await seedFeed("swift", { scope: "acme" });
  token = (
    await issueStaticCiToken(env, db, {
      product: SLUG,
      scopes: ["release:publish"],
      expiresAt: NOW + 3600,
      label: null,
      createdBy: "u1",
      now: NOW,
    })
  ).token;
});

afterEach(() => {
  vi.useRealTimers();
});

function post(path: string, body: unknown) {
  return call(env, db, noFetch, `${CONSOLE}/${SLUG}/release/publish/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

const TGZ = new TextEncoder().encode("npm tarball bytes for @acme/sdk 1.4.0");
const TGZ_SHA = sha(TGZ);

function npmDescriptor(
  version = "1.4.0",
  bytes = TGZ,
  over: Record<string, unknown> = {},
): Record<string, any> {
  const s = sha(bytes);
  return {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "npm.sdk",
    kind: "package",
    version,
    channel: "stable",
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
    ...over,
  };
}

/** uploads → stage the bytes → submit. */
async function publish(
  descriptor: Record<string, any>,
  files: Uint8Array[] = [TGZ],
  extra: Record<string, unknown> = {},
) {
  const up = await post("uploads", {
    objects: files.map((f) => ({ sha256: sha(f), size: f.length })),
  });
  expect(up.status).toBe(200);
  const u = (await up.json()) as { ticket: string; prefix: string };
  for (const f of files)
    r2.seed(`${u.prefix}${sha(f)}`, f, { withSha256: true });
  const res = await post("submit", { ticket: u.ticket, descriptor, ...extra });
  return { res, body: (await res.json()) as Record<string, any> };
}

const pkgRow = (version: string, ecosystem = "npm") =>
  db.first<Record<string, any>>(
    "SELECT * FROM release_packages WHERE product = ? AND ecosystem = ? AND version = ?",
    SLUG,
    ecosystem,
    version,
  );
const queue = () =>
  db.all<{ deliverable_id: string; reason: string; generation: number }>(
    "SELECT deliverable_id, reason, generation FROM registry_render_queue WHERE product = ? ORDER BY deliverable_id",
    SLUG,
  );

describe("publishing a package release (F-03)", () => {
  it("ingests the version: release row, payload artifacts, refs, release_packages with digests, a queued render", async () => {
    const { res, body } = await publish(npmDescriptor());
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      dryRun: false,
      releaseId: "npm.sdk@1.4.0",
      outcome: "created",
    });
    const rel = await db.first<Record<string, any>>(
      "SELECT deliverable_id, version, seq, channel FROM release_metadata WHERE product = ? AND release_id = ?",
      SLUG,
      "npm.sdk@1.4.0",
    );
    expect(rel).toEqual({
      deliverable_id: "npm.sdk",
      version: "1.4.0",
      seq: 1,
      channel: "stable",
    });
    const art = await db.all<Record<string, any>>(
      "SELECT name, role, build_id, sha256, storage_key FROM release_artifacts WHERE product = ? AND release_id = ?",
      SLUG,
      "npm.sdk@1.4.0",
    );
    expect(art).toEqual([
      {
        name: "acme-sdk-1.4.0.tgz",
        role: "payload",
        build_id: null,
        sha256: TGZ_SHA,
        storage_key: `blobs/sha256/${TGZ_SHA}`,
      },
    ]);
    expect(
      await db.all("SELECT ref_kind FROM blob_refs WHERE product = ?", SLUG),
    ).toEqual([{ ref_kind: "package-file" }]);
    const row = await pkgRow("1.4.0");
    expect(row).toMatchObject({
      name: "@acme/sdk",
      name_norm: "@acme/sdk",
      deliverable_id: "npm.sdk",
      release_id: "npm.sdk@1.4.0",
      state: "live",
    });
    const files = JSON.parse(row!.files_json);
    expect(files).toEqual([
      {
        name: "acme-sdk-1.4.0.tgz",
        type: "npm-tarball",
        sha256: TGZ_SHA,
        size: TGZ.length,
        sha512: createHash("sha512").update(TGZ).digest("hex"),
        sha1: createHash("sha1").update(TGZ).digest("hex"),
      },
    ]);
    expect(JSON.parse(row!.source_json)).toMatchObject({ kind: "static" });
    expect(await queue()).toEqual([
      { deliverable_id: "npm.sdk", reason: "publish", generation: 1 },
    ]);
    // No release record of any kind.
    expect(
      await db.all("SELECT 1 FROM release_records WHERE product = ?", SLUG),
    ).toEqual([]);
  });

  it("a dry run before the upload judges the descriptor and writes nothing", async () => {
    const up = await post("uploads", {
      objects: [{ sha256: TGZ_SHA, size: TGZ.length }],
    });
    const u = (await up.json()) as { ticket: string };
    const res = await post("submit", {
      ticket: u.ticket,
      descriptor: npmDescriptor(),
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      dryRun: true,
      releaseId: "npm.sdk@1.4.0",
      unverified: [`blobs/sha256/${TGZ_SHA}`],
    });
    expect(await pkgRow("1.4.0")).toBeNull();
    expect(await queue()).toEqual([]);
  });

  it("refuses a release record with a package descriptor: package-unsigned", async () => {
    const { res, body } = await publish(npmDescriptor(), [TGZ], {
      record: "eyJ.a.b",
    });
    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      error: "release_record_rejected",
      reason: "package-unsigned",
    });
    expect(await pkgRow("1.4.0")).toBeNull();
  });

  it("is idempotent for the same descriptor, and refuses another for a published version", async () => {
    expect((await publish(npmDescriptor())).res.status).toBe(200);
    const again = await publish(npmDescriptor());
    expect(again.res.status).toBe(200);
    expect(again.body.outcome).toBe("unchanged");
    const other = new TextEncoder().encode("different bytes, same version");
    const taken = await publish(npmDescriptor("1.4.0", other), [other]);
    expect(taken.res.status).toBe(409);
    expect(taken.body).toMatchObject({
      error: "release_exists",
      reason: "package-version-taken",
    });
  });

  it("refuses republishing a yanked version, even the identical descriptor (unique forever)", async () => {
    expect((await publish(npmDescriptor())).res.status).toBe(200);
    const y = await admin(
      env,
      db,
      "POST",
      `/products/${SLUG}/release/releases/${encodeURIComponent("npm.sdk@1.4.0")}/yank`,
      { reason: "broken build" },
    );
    expect(y.status).toBe(200);
    expect(await pkgRow("1.4.0")).toMatchObject({
      state: "yanked",
      state_message: "broken build",
    });
    expect(await queue()).toEqual([
      { deliverable_id: "npm.sdk", reason: "yank", generation: 2 },
    ]);
    const again = await publish(npmDescriptor());
    expect(again.res.status).toBe(409);
    expect(again.body.reason).toBe("package-version-taken");
    // Unyank returns it to live and queues another render.
    const u = await admin(
      env,
      db,
      "DELETE",
      `/products/${SLUG}/release/releases/${encodeURIComponent("npm.sdk@1.4.0")}/yank`,
    );
    expect(u.status).toBe(200);
    expect(await pkgRow("1.4.0")).toMatchObject({
      state: "live",
      state_message: null,
    });
    expect((await queue())[0]).toMatchObject({ reason: "unyank" });
  });

  it("deprecates and undeprecates a package version, and refuses an app release", async () => {
    expect((await publish(npmDescriptor())).res.status).toBe(200);
    const path = `/products/${SLUG}/release/releases/${encodeURIComponent("npm.sdk@1.4.0")}/deprecate`;
    const d = await admin(env, db, "POST", path, { message: "use 2.x" });
    expect(d.status).toBe(200);
    expect(await pkgRow("1.4.0")).toMatchObject({
      state: "deprecated",
      state_message: "use 2.x",
    });
    expect((await queue())[0]).toMatchObject({ reason: "deprecate" });
    const audit = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ? AND action LIKE 'release.package.%'",
      SLUG,
    );
    expect(audit).toEqual([{ action: "release.package.deprecate" }]);
    expect((await admin(env, db, "DELETE", path)).status).toBe(200);
    expect(await pkgRow("1.4.0")).toMatchObject({ state: "live" });
    expect((await admin(env, db, "DELETE", path)).status).toBe(404);
    const notPkg = await admin(
      env,
      db,
      "POST",
      `/products/${SLUG}/release/releases/v9.9.9/deprecate`,
      { message: "x" },
    );
    expect(notPkg.status).toBe(404);
  });

  it("an unyank restores an earlier deprecation instead of dropping it", async () => {
    expect((await publish(npmDescriptor())).res.status).toBe(200);
    const rel = encodeURIComponent("npm.sdk@1.4.0");
    const base = `/products/${SLUG}/release/releases/${rel}`;
    expect(
      (
        await admin(env, db, "POST", `${base}/deprecate`, {
          message: "use 2.x",
        })
      ).status,
    ).toBe(200);
    expect(
      (await admin(env, db, "POST", `${base}/yank`, { reason: "bad build" }))
        .status,
    ).toBe(200);
    expect(await pkgRow("1.4.0")).toMatchObject({
      state: "yanked",
      state_message: "bad build",
    });
    expect((await admin(env, db, "DELETE", `${base}/yank`)).status).toBe(200);
    expect(await pkgRow("1.4.0")).toMatchObject({
      state: "deprecated",
      state_message: "use 2.x",
    });
    // And it can still be undeprecated afterwards.
    expect((await admin(env, db, "DELETE", `${base}/deprecate`)).status).toBe(
      200,
    );
    expect(await pkgRow("1.4.0")).toMatchObject({
      state: "live",
      state_message: null,
    });
  });

  it("a channel move of a package queues its render", async () => {
    expect((await publish(npmDescriptor())).res.status).toBe(200);
    await db.run("DELETE FROM registry_render_queue");
    const res = await admin(
      env,
      db,
      "PUT",
      `/products/${SLUG}/release/channels/beta`,
      {
        deliverable: "npm.sdk",
        pointer: "npm.sdk@1.4.0",
      },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await queue()).toEqual([
      { deliverable_id: "npm.sdk", reason: "channel", generation: 1 },
    ]);
  });

  it("refuses a name outside the feed's namespace, and an ecosystem with no feed", async () => {
    await db.run(
      "UPDATE dist_registry_feeds SET namespace_json = ? WHERE product = ? AND ecosystem = 'npm'",
      JSON.stringify({ scope: "@other" }),
      SLUG,
    );
    const out = await publish(npmDescriptor());
    expect(out.res.status).toBe(400);
    expect(out.body).toMatchObject({
      error: "invalid_descriptor",
      reason: "package-namespace",
    });
    await db.run("DELETE FROM dist_registry_feeds WHERE product = ?", SLUG);
    const none = await publish(npmDescriptor());
    expect(none.body.reason).toBe("package-namespace");
  });

  it("refuses a release over the feed's ceiling, and never above the platform's", async () => {
    await db.run(
      "UPDATE dist_registry_feeds SET max_package_bytes = 10 WHERE product = ? AND ecosystem = 'npm'",
      SLUG,
    );
    expect((await publish(npmDescriptor())).body.reason).toBe(
      "package-too-large",
    );
    await db.run(
      "UPDATE dist_registry_feeds SET max_package_bytes = 999999999 WHERE product = ?",
      SLUG,
    );
    await db.run(
      "UPDATE dist_registry_policy SET max_package_bytes_ceiling = 5 WHERE ecosystem = 'npm'",
    );
    expect((await publish(npmDescriptor())).body.reason).toBe(
      "package-too-large",
    );
  });

  it("refuses a Maven snapshot", async () => {
    const jar = new TextEncoder().encode("jar bytes");
    const s = sha(jar);
    const out = await publish(
      {
        descriptorVersion: 1,
        product: SLUG,
        deliverable: "maven.sdk",
        kind: "package",
        version: "1.0.0-SNAPSHOT",
        package: {
          ecosystem: "maven",
          name: "gg.acme:acme-sdk",
          files: [
            {
              name: "acme-sdk-1.0.0-SNAPSHOT.jar",
              role: "payload",
              type: "maven-file",
              extension: "jar",
              sha256: s,
              size: jar.length,
              locations: [{ provider: "r2", key: `blobs/sha256/${s}` }],
            },
          ],
          metadata: { name: "gg.acme:acme-sdk", version: "1.0.0-SNAPSHOT" },
        },
      },
      [jar],
    );
    expect(out.res.status).toBe(400);
    expect(out.body.reason).toBe("maven-snapshot");
  });

  it("computes SHA-512, SHA-1 and MD5 for a Maven file", async () => {
    const jar = new TextEncoder().encode("jar bytes 1.0.0");
    const s = sha(jar);
    const out = await publish(
      {
        descriptorVersion: 1,
        product: SLUG,
        deliverable: "maven.sdk",
        kind: "package",
        version: "1.0.0",
        package: {
          ecosystem: "maven",
          name: "gg.acme:acme-sdk",
          files: [
            {
              name: "acme-sdk-1.0.0.jar",
              role: "payload",
              type: "maven-file",
              extension: "jar",
              sha256: s,
              size: jar.length,
              locations: [{ provider: "r2", key: `blobs/sha256/${s}` }],
            },
          ],
          metadata: {
            name: "gg.acme:acme-sdk",
            version: "1.0.0",
            groupId: "gg.acme",
            artifactId: "acme-sdk",
            packaging: "jar",
          },
        },
      },
      [jar],
    );
    expect(out.res.status, JSON.stringify(out.body)).toBe(200);
    const files = JSON.parse((await pkgRow("1.0.0", "maven"))!.files_json);
    expect(files[0]).toMatchObject({
      md5: createHash("md5").update(jar).digest("hex"),
      sha1: createHash("sha1").update(jar).digest("hex"),
      sha512: createHash("sha512").update(jar).digest("hex"),
    });
  });

  it("refuses an unsigned Swift release on a feed that requires signatures (the default)", async () => {
    const zip = new TextEncoder().encode("swift source archive");
    const s = sha(zip);
    const d = {
      descriptorVersion: 1,
      product: SLUG,
      deliverable: "swift.kit",
      kind: "package",
      version: "1.0.0",
      package: {
        ecosystem: "swift",
        name: "acme.AcmeKit",
        files: [
          {
            name: "AcmeKit-1.0.0.zip",
            role: "payload",
            type: "source-archive",
            sha256: s,
            size: zip.length,
            locations: [{ provider: "r2", key: `blobs/sha256/${s}` }],
          },
        ],
        metadata: { name: "acme.AcmeKit", version: "1.0.0" },
      },
    };
    const out = await publish(d, [zip]);
    expect(out.res.status).toBe(400);
    expect(out.body.reason).toBe("swift-unsigned");
    // A feed that opts out takes it.
    await db.run(
      "UPDATE dist_registry_feeds SET ext_json = ? WHERE product = ? AND ecosystem = 'swift'",
      JSON.stringify({ requireSigned: false }),
      SLUG,
    );
    expect((await publish(d, [zip])).res.status).toBe(200);
  });

  it("refuses a package while Distribution is off", async () => {
    const services = JSON.stringify({
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    });
    await db.run(
      "UPDATE products SET services_json = ? WHERE slug = ?",
      services,
      SLUG,
    );
    const out = await publish(npmDescriptor());
    expect(out.res.status).toBe(409);
    expect(out.body.reason).toBe("distribution_disabled");
  });
});

/**
 * The v0.8.22 incident: a `main` prerelease and a tag's stable release of one package publish
 * concurrently. Both tickets answered the same next `seq`; the prerelease's submit took it, and
 * the stable release's descriptor, pinned to that seq by the CLI, was refused
 * `seq_not_increasing`. A package's seq is publication order only (the feeds order versions by
 * the deliverable's scheme, and replay is refused by unique-forever versions), so the package
 * publish leaves `seq` to the server, which takes the next one atomically at insert.
 */
describe("package seq: concurrent main prereleases and tag releases", () => {
  const PRE = new TextEncoder().encode("npm tarball bytes, 1.5.0-main.9");
  const OLD = new TextEncoder().encode("npm tarball bytes, 1.3.0");

  async function ticketFor(version: string, bytes: Uint8Array) {
    const up = await post("uploads", {
      objects: [{ sha256: sha(bytes), size: bytes.length }],
      releases: [{ deliverable: "npm.sdk", version }],
    });
    expect(up.status).toBe(200);
    const u = (await up.json()) as {
      ticket: string;
      prefix: string;
      seqs: { seq: number }[];
    };
    r2.seed(`${u.prefix}${sha(bytes)}`, bytes, { withSha256: true });
    return u;
  }

  const submit = async (ticket: string, descriptor: Record<string, any>) => {
    const res = await post("submit", { ticket, descriptor });
    return { res, body: (await res.json()) as Record<string, any> };
  };

  const seqOf = async (releaseId: string) =>
    (
      await db.first<{ seq: number }>(
        "SELECT seq FROM release_metadata WHERE product = ? AND release_id = ?",
        SLUG,
        releaseId,
      )
    )?.seq;

  it("an older stable release published after a newer prerelease takes the next seq", async () => {
    // Both tickets are issued before either submit: each answers seq 1.
    const pre = await ticketFor("1.5.0-main.9", PRE);
    const stable = await ticketFor("1.4.0", TGZ);
    expect(pre.seqs[0]!.seq).toBe(1);
    expect(stable.seqs[0]!.seq).toBe(1);

    const p = await submit(
      pre.ticket,
      npmDescriptor("1.5.0-main.9", PRE, { channel: "beta" }),
    );
    expect(p.res.status, JSON.stringify(p.body)).toBe(200);

    // The stable release, with no seq, is created and takes the next one.
    const dry = await post("submit", {
      ticket: stable.ticket,
      descriptor: npmDescriptor(),
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ ok: true, outcome: "created" });
    const s = await submit(stable.ticket, npmDescriptor());
    expect(s.res.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ outcome: "created" });
    expect(await seqOf("npm.sdk@1.5.0-main.9")).toBe(1);
    expect(await seqOf("npm.sdk@1.4.0")).toBe(2);

    // Each channel heads where its versions say, whatever the publication order.
    const product = (await getProduct(db, SLUG))!;
    const catalog = releaseCatalog({
      db,
      env,
      product: product as never,
      now: NOW,
      hooks: NO_HOOKS,
    } as never);
    expect(await catalog.packageChannelHeads("npm.sdk")).toContainEqual({
      channel: "stable",
      releaseId: "npm.sdk@1.4.0",
      version: "1.4.0",
    });

    // A re-run of the stable publish is unchanged, keeping its seq.
    const again = await publish(npmDescriptor());
    expect(again.res.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: "unchanged" });
    expect(await seqOf("npm.sdk@1.4.0")).toBe(2);
  });

  it("still refuses an explicit seq that another publish took (the pre-fix descriptor)", async () => {
    const pre = await ticketFor("1.5.0-main.9", PRE);
    const stable = await ticketFor("1.4.0", TGZ);
    expect(
      (
        await submit(
          pre.ticket,
          npmDescriptor("1.5.0-main.9", PRE, {
            channel: "beta",
            seq: pre.seqs[0]!.seq,
          }),
        )
      ).res.status,
    ).toBe(200);
    const s = await submit(
      stable.ticket,
      npmDescriptor("1.4.0", TGZ, { seq: stable.seqs[0]!.seq }),
    );
    expect(s.res.status).toBe(409);
    expect(s.body).toMatchObject({ reason: "seq_not_increasing" });
    expect(await pkgRow("1.4.0")).toBeNull();
  });

  it("two stable releases out of order: the older one is new, so it publishes, and the newer still heads stable", async () => {
    expect((await publish(npmDescriptor())).res.status).toBe(200);
    const old = await publish(npmDescriptor("1.3.0", OLD), [OLD]);
    expect(old.res.status, JSON.stringify(old.body)).toBe(200);
    expect(await seqOf("npm.sdk@1.3.0")).toBe(2);
    const product = (await getProduct(db, SLUG))!;
    const catalog = releaseCatalog({
      db,
      env,
      product: product as never,
      now: NOW,
      hooks: NO_HOOKS,
    } as never);
    expect(await catalog.packageChannelHeads("npm.sdk")).toContainEqual({
      channel: "stable",
      releaseId: "npm.sdk@1.4.0",
      version: "1.4.0",
    });
    // Replay protection is the version: 1.4.0 with other bytes stays refused.
    const other = new TextEncoder().encode("other bytes for 1.4.0");
    const taken = await publish(npmDescriptor("1.4.0", other), [other]);
    expect(taken.res.status).toBe(409);
    expect(taken.body.reason).toBe("package-version-taken");
  });
});

describe("the releaseCatalog package readers (F-03)", () => {
  it("lists package deliverables and versions, and keeps packages out of the device-facing reads", async () => {
    expect((await publish(npmDescriptor())).res.status).toBe(200);
    const product = (await getProduct(db, SLUG))!;
    const catalog = releaseCatalog({
      db,
      env,
      product: product as never,
      now: NOW,
      hooks: NO_HOOKS,
    } as never);
    expect(await catalog.packageDeliverables()).toEqual([
      { id: "maven.sdk", ecosystem: "maven", name: "gg.acme:acme-sdk" },
      { id: "npm.sdk", ecosystem: "npm", name: "@acme/sdk" },
      { id: "swift.kit", ecosystem: "swift", name: "acme.AcmeKit" },
    ]);
    const versions = await catalog.packageVersions("npm.sdk");
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      releaseId: "npm.sdk@1.4.0",
      version: "1.4.0",
      seq: 1,
      channel: "stable",
      state: "live",
      metadata: { name: "@acme/sdk", version: "1.4.0" },
    });
    expect(versions[0]!.files[0]!.sha512).toMatch(/^[0-9a-f]{128}$/);
    // beta includes stable and dev includes beta (the built-in rule), so all three head at 1.4.0.
    expect(await catalog.packageChannelHeads("npm.sdk")).toEqual([
      { channel: "beta", releaseId: "npm.sdk@1.4.0", version: "1.4.0" },
      { channel: "dev", releaseId: "npm.sdk@1.4.0", version: "1.4.0" },
      { channel: "stable", releaseId: "npm.sdk@1.4.0", version: "1.4.0" },
    ]);
    expect(await catalog.packageChannelHeads("app")).toEqual([]);
    // Device-facing reads never see the package.
    expect((await catalog.deliverables()).map((d) => d.id)).toEqual(["app"]);
    expect(await catalog.release("npm.sdk@1.4.0")).toBeNull();
    const file = await catalog.resolve({
      kind: "file",
      releaseId: "npm.sdk@1.4.0",
      name: "acme-sdk-1.4.0.tgz",
    });
    expect(file).toMatchObject({ kind: "file", release: null, artifact: null });
    const blob = await catalog.resolve({ kind: "blob", sha256: TGZ_SHA });
    expect(blob).toEqual({ kind: "blob", releases: [] });
  });

  it("the console's deliverables view lists each package after the app and packs", async () => {
    expect((await publish(npmDescriptor())).res.status).toBe(200);
    const res = await admin(
      env,
      db,
      "GET",
      `/products/${SLUG}/release/deliverables`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deliverables: {
        id: string;
        kind: string;
        type: string | null;
        releaseCount: number;
        latest: { version: string } | null;
      }[];
    };
    expect(body.deliverables.map((d) => [d.id, d.kind])).toEqual([
      ["app", "app"],
      ["maven.sdk", "package"],
      ["npm.sdk", "package"],
      ["swift.kit", "package"],
    ]);
    expect(body.deliverables.find((d) => d.id === "npm.sdk")).toMatchObject({
      type: "npm",
      releaseCount: 1,
      latest: { version: "1.4.0" },
    });
  });

  it("digestStream hashes a stream once for every algorithm", async () => {
    const bytes = new TextEncoder().encode("abc");
    const out = await digestStream(new Blob([bytes]).stream(), ["sha1", "md5"]);
    expect(out).toEqual({
      sha1: "a9993e364706816aba3e25717850c26c9cd0d89d",
      md5: "900150983cd24fb0d6963f7d28e17f72",
    });
  });
});

describe("the packageFeeds toggle (F-03)", () => {
  const path = `/products/${SLUG}/distribution/package-feeds`;
  it("reads off at version 0, turns on with expectedVersion 0, refuses a stale version, audits", async () => {
    const get = await admin(env, db, "GET", path);
    expect(await get.json()).toMatchObject({
      packageFeeds: { enabled: false, version: 0 },
    });
    const on = await admin(env, db, "PUT", path, {
      enabled: true,
      expectedVersion: 0,
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      packageFeeds: { enabled: true, version: 1 },
    });
    expect(await queue()).toEqual([
      { deliverable_id: "*", reason: "package-feeds", generation: 1 },
    ]);
    const stale = await admin(env, db, "PUT", path, {
      enabled: false,
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);
    const off = await admin(env, db, "PUT", path, {
      enabled: false,
      expectedVersion: 1,
    });
    expect(await off.json()).toMatchObject({
      packageFeeds: { enabled: false, version: 2 },
    });
    expect(
      (
        await db.all<{ action: string }>(
          "SELECT action FROM audit WHERE product = ? AND action = 'distribution.package_feeds.update'",
          SLUG,
        )
      ).length,
    ).toBe(2);
    expect((await admin(env, db, "PUT", path, { enabled: "yes" })).status).toBe(
      422,
    );
  });
});
