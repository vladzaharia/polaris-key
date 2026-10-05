/**
 * P2b-04 — byte delivery moved into Distribution, and one delivery-access answer.
 *
 *   1. Every alias answers byte-identically to its canonical `/distribution/…` route, on both
 *      hosts: the installer, the legacy download, and P2-05's builds, files and blobs.
 *   2. With Distribution off, every byte route and alias is not served: the console answers the
 *      registry's not-found body, the bytes host its flat `{"error":"not_found"}`, each
 *      indistinguishable from an absent route (P2-01's pattern).
 *   3. An operator setting `entitled` in `dist_access` makes the appcast, the download and the
 *      portal's download mint all refuse a caller without the channel entitlement — with
 *      `release_config.artifacts_access` left at `public`, which nothing reads any more.
 *   4. `dist_access` itself: inheritance, the manifest ingest and its ownership, the admin
 *      endpoints, `deliveryUrl`, the portal's bytes-origin redirect, and the 0038 backfill.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import {
  blobKey,
  putVerified,
  recordObject,
  recordRef,
} from "../src/core/blobs.js";
import { buildHooks } from "../src/core/hooks.js";
import { manifestIngestFor } from "../src/core/registry.js";
import { loadProduct } from "../src/core/products.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { SERVICES } from "../src/mount.js";
import { handleActivate } from "../src/services/license/activation.js";
import {
  accessIngestStatements,
  accessModeOf,
} from "../src/services/distribution/access.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import {
  PORTAL_COOKIE,
  PORTAL_CSRF_HEADER,
  issuePortalSession,
} from "../src/services/identity/portal/session.js";
import { handlePortalApi, handlePortalDownload } from "./portalHarness.js";
import {
  stmtSetArtifactModel,
  stmtUpsertBuild,
} from "../src/services/release/model.js";
import {
  ASSET_BYTES,
  BYTES,
  CONSOLE,
  bytesOf,
  call,
  envFor,
  github,
  release,
  RELEASES,
  seedReleaseProduct,
  sha256Hex,
  SLUG,
  syncAndDescribe,
} from "./releaseRoutesFixture.js";
import { mkReq, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOB = bytesOf(4096, 21);
const BLOB_HEX = sha256Hex(BLOB);

interface World {
  env: Env;
  db: Db;
  r2: R2Mock;
  gh: ReturnType<typeof github>;
}

async function setup(): Promise<World> {
  const db = makeTestDb();
  await seedReleaseProduct(db);
  const r2 = new R2Mock();
  const env = envFor({ blobOrigin: BYTES });
  env.BLOBS = asR2(r2);
  env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
  const gh = github({ releases: RELEASES });
  await syncAndDescribe(env, db, gh.fetchImpl);
  return { env, db, r2, gh };
}

async function storeBlob(w: World): Promise<void> {
  const key = blobKey(BLOB_HEX);
  const put = await putVerified(asR2(w.r2), key, BLOB, {
    sha256: BLOB_HEX,
    size: BLOB.length,
  });
  if (!put.ok && put.reason !== "exists") throw new Error(put.reason);
  await recordObject(
    w.db,
    {
      storageKey: key,
      sha256: BLOB_HEX,
      size: BLOB.length,
      kind: "blob",
      gated: false,
    },
    NOW,
  );
  await recordRef(
    w.db,
    { product: SLUG, storageKey: key, refKind: "artifact", refId: "x" },
    NOW,
  );
}

const get = (w: World, url: string, init: RequestInit = {}) =>
  call(w.env, w.db, w.gh.fetchImpl, url, init);

async function snapshot(res: Response) {
  return {
    status: res.status,
    headers: [...res.headers.entries()].sort(),
    body: Buffer.from(await res.arrayBuffer()).toString("base64"),
  };
}

async function admin(
  w: World,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${SLUG}/distribution${path}`;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    w.env,
    w.db,
    full,
    { now: NOW },
  );
}

async function services(
  w: World,
  on: { release: boolean; distribution: boolean },
): Promise<void> {
  await setServices(
    w.db,
    SLUG,
    serializeServices({
      services: {
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: on.release },
        distribution: { enabled: on.distribution },
        update: { enabled: on.distribution },
        identity: { enabled: false },
      },
    }),
    "manifest",
    NOW,
  );
}

const HEX = "a".repeat(64);
/** Every byte route, canonical then alias, under one host. */
function bytePaths(host: string): Array<[string, string]> {
  const p = `${host}/${SLUG}`;
  const rows: Array<[string, string]> = [
    [
      `${p}/distribution/builds/stable/cli-arm64`,
      `${p}/release/builds/stable/cli-arm64`,
    ],
    [
      `${p}/distribution/files/v1.1.0/djdl-arm64`,
      `${p}/release/files/v1.1.0/djdl-arm64`,
    ],
    [
      `${p}/distribution/blobs/sha256/${BLOB_HEX}`,
      `${p}/release/blobs/sha256/${BLOB_HEX}`,
    ],
  ];
  if (host === CONSOLE)
    rows.push(
      [`${p}/distribution/install.sh`, `${p}/release/install.sh`],
      [`${p}/distribution/install.sh`, `${p}/install.sh`],
      [
        `${p}/distribution/dl/latest/djdl-arm64`,
        `${p}/release/dl/latest/djdl-arm64`,
      ],
      [
        `${p}/distribution/dl/1.1.0/djdl-arm64?checksum=sha256`,
        `${p}/release/dl/1.1.0/djdl-arm64?checksum=sha256`,
      ],
    );
  return rows;
}

// ── 1. Aliases are byte-identical ─────────────────────────────────────────────────────────────

describe("the canonical /distribution/… routes and their aliases answer the same", () => {
  for (const host of [CONSOLE, BYTES]) {
    it(`byte for byte, header for header, on the ${host === CONSOLE ? "console" : "bytes"} host`, async () => {
      const w = await setup();
      await storeBlob(w);
      for (const [canonical, alias] of bytePaths(host)) {
        const a = await snapshot(await get(w, canonical));
        const b = await snapshot(await get(w, alias));
        expect(b, `${alias} vs ${canonical}`).toEqual(a);
        // The canonical answer is a real one, not two matching refusals (the fixture publishes
        // no `.sha256` sidecar, so the checksum pair is two identical 404s by design).
        if (!canonical.includes("checksum"))
          expect(a.status, canonical).toBeLessThan(400);
      }
    });
  }

  it("a Range request is identical too", async () => {
    const w = await setup();
    const init = { headers: { range: "bytes=10-99" } };
    const a = await snapshot(
      await get(
        w,
        `${BYTES}/${SLUG}/distribution/builds/stable/cli-arm64`,
        init,
      ),
    );
    const b = await snapshot(
      await get(w, `${BYTES}/${SLUG}/release/builds/stable/cli-arm64`, init),
    );
    expect(a.status).toBe(206);
    expect(b).toEqual(a);
  });
});

// ── 2. Distribution off ───────────────────────────────────────────────────────────────────────

describe("with Distribution disabled, no byte route or alias is served", () => {
  it("console: the registry not-found body, identical to an absent route", async () => {
    const w = await setup();
    await storeBlob(w);
    await services(w, { release: true, distribution: false });
    const absent = await snapshot(
      await get(w, `${CONSOLE}/${SLUG}/distribution/no-such-route`),
    );
    expect(absent.status).toBe(404);
    expect(JSON.parse(Buffer.from(absent.body, "base64").toString())).toEqual({
      error: { code: "not_found" },
    });
    for (const pair of bytePaths(CONSOLE)) {
      for (const url of pair) {
        expect(await snapshot(await get(w, url)), url).toEqual(absent);
      }
    }
  });

  it("bytes host: the flat {error: not_found}, identical to an absent route", async () => {
    const w = await setup();
    await storeBlob(w);
    await services(w, { release: true, distribution: false });
    const absent = await snapshot(
      await get(w, `${BYTES}/${SLUG}/no/such/route/here`),
    );
    expect(absent.status).toBe(404);
    expect(JSON.parse(Buffer.from(absent.body, "base64").toString())).toEqual({
      error: "not_found",
    });
    for (const pair of bytePaths(BYTES)) {
      for (const url of pair) {
        expect(await snapshot(await get(w, url)), url).toEqual(absent);
      }
    }
  });

  it("and with it back on, they serve again (the switch, not the data, decided)", async () => {
    const w = await setup();
    await services(w, { release: true, distribution: false });
    await services(w, { release: true, distribution: true });
    const res = await get(
      w,
      `${BYTES}/${SLUG}/release/builds/stable/cli-arm64`,
    );
    expect(res.status).toBe(200);
  });
});

// ── 3. One access answer ──────────────────────────────────────────────────────────────────────

async function stableOnlyToken(w: World): Promise<string> {
  const { key } = await seedLicenseWithKey(w.db, SLUG);
  const product = (await loadProduct(w.env, w.db, SLUG))!;
  const res = await handleActivate(
    mkReq("POST", { authorization: `Bearer ${key}`, "x-pkey-device": "dev-1" }),
    w.env,
    w.db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

describe("an operator's `entitled` in dist_access gates every surface the same way", () => {
  async function entitled(w: World): Promise<void> {
    const res = await admin(w, "PUT", "/access", { mode: "entitled" });
    expect(res.status).toBe(200);
    // Release's old column still says public; nothing reads it.
    expect(
      (
        await w.db.first<{ artifacts_access: string }>(
          "SELECT artifacts_access FROM release_config WHERE product = ?",
          SLUG,
        )
      )?.artifacts_access,
    ).toBe("public");
  }

  it("the appcast refuses a stable-only licence the beta feed", async () => {
    const w = await setup();
    const token = await stableOnlyToken(w);
    const auth = { headers: { authorization: `Bearer ${token}` } };
    for (const path of ["/update/beta/appcast.xml", "/beta/appcast.xml"]) {
      const before = await get(w, `${CONSOLE}/${SLUG}${path}`, auth);
      expect([401, 403], path).not.toContain(before.status);
    }
    await entitled(w);
    for (const path of ["/update/beta/appcast.xml", "/beta/appcast.xml"]) {
      const res = await get(w, `${CONSOLE}/${SLUG}${path}`, auth);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({
        error: { code: "channel_not_allowed" },
      });
    }
    // No token at all is the v3 401.
    const anonymous = await get(w, `${CONSOLE}/${SLUG}/update/appcast.xml`);
    expect(anonymous.status).toBe(401);
  });

  it("the download refuses it the beta binary and build, on both spellings and both hosts", async () => {
    const w = await setup();
    const token = await stableOnlyToken(w);
    await entitled(w);
    const auth = { headers: { authorization: `Bearer ${token}` } };
    for (const url of [
      `${CONSOLE}/${SLUG}/distribution/dl/beta/djdl-arm64`,
      `${CONSOLE}/${SLUG}/release/dl/beta/djdl-arm64`,
      `${CONSOLE}/${SLUG}/distribution/builds/beta/cli-arm64`,
      `${BYTES}/${SLUG}/release/builds/beta/cli-arm64`,
    ]) {
      const res = await get(w, url, auth);
      expect(res.status, url).toBe(403);
      expect(await res.json(), url).toEqual({
        error: { code: "channel_not_allowed" },
      });
    }
    // The stable channel, which every grant holds, still downloads.
    const stable = await get(
      w,
      `${BYTES}/${SLUG}/distribution/builds/stable/cli-arm64`,
      auth,
    );
    expect(stable.status).toBe(200);
    expect(stable.headers.get("cache-control")).toBe(
      "private, no-store, no-transform",
    );
  });

  it("the portal's download mint refuses a licence without the release's channel", async () => {
    const w = await setup();
    // v1.1.0 was published to the beta channel.
    await w.db.run(
      "UPDATE release_metadata SET channel = 'beta' WHERE product = ? AND release_id = 'v1.1.0'",
      SLUG,
    );
    const { licenseId } = await seedLicenseWithKey(w.db, SLUG);
    const account = await getOrCreateAccountByEmail(
      w.db,
      "ada@example.com",
      NOW,
    );
    await linkLicense(w.db, account.id, SLUG, licenseId, "license-key", NOW);
    const { token, session } = await issuePortalSession(
      w.env,
      {
        accountId: account.id,
        email: account.primary_email,
        name: account.display_name,
      },
      NOW,
    );
    const artifact = await w.db.first<{ artifact_id: string }>(
      "SELECT artifact_id FROM release_artifacts WHERE product = ? AND release_id = 'v1.1.0' AND name = 'djdl-arm64'",
      SLUG,
    );
    const path = `/api/releases/${SLUG}/v1.1.0/artifacts/${artifact!.artifact_id}/token`;
    const mint = () =>
      handlePortalApi(
        new Request(`${CONSOLE}${path}`, {
          method: "POST",
          headers: {
            cookie: `${PORTAL_COOKIE}=${token}`,
            [PORTAL_CSRF_HEADER]: session.csrf,
          },
        }),
        w.env,
        w.db,
        path,
        NOW,
      );

    expect((await mint()).status).toBe(201);
    await entitled(w);
    const refused = await mint();
    expect(refused.status).toBe(403);

    // Granting the licence the beta channel lets the same account mint again.
    await w.db.run(
      "UPDATE licenses SET channels_json = ? WHERE product = ? AND id = ?",
      JSON.stringify(["beta"]),
      SLUG,
      licenseId,
    );
    expect((await mint()).status).toBe(201);
  });
});

// ── 3b. Turning Distribution on never opens downloads ──────────────────────────────────────────

/** The services PATCH the console sends: Distribution (and Update) switched on live, no ingest. */
async function enableDistributionInConsole(
  w: World,
  alsoRelease = false,
): Promise<void> {
  const { token, session } = await issueSession(
    w.env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const path = `/api/products/${SLUG}/services`;
  const res = await handleAdmin(
    new Request(`${CONSOLE}/manage${path}`, {
      method: "PATCH",
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        services: {
          ...(alsoRelease ? { release: { enabled: true } } : {}),
          distribution: { enabled: true },
          update: { enabled: true },
        },
      }),
    }),
    w.env,
    w.db,
    path,
    { now: NOW },
  );
  expect(res.status).toBe(200);
}

/** A parsed manifest whose `.pkey/release` says `access.artifacts: <mode>`. */
function manifestWithArtifacts(mode: string) {
  const p = parseManifest({
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    product: JSON.stringify({ slug: SLUG, name: "D" }),
    release: JSON.stringify({
      release: {
        ghOwner: "acme",
        ghRepo: "djdl",
        access: { metadata: "public", artifacts: mode },
      },
    }),
  });
  if (!p.ok) throw new Error(JSON.stringify(p));
  return p.manifest;
}

/** Run Core's ingest pipeline exactly as a link or resync does, with Distribution OFF. */
async function ingestWithDistributionOff(w: World, mode: string) {
  const out = manifestIngestFor(SERVICES)(
    manifestWithArtifacts(mode),
    SLUG,
    {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
    },
    NOW,
  );
  for (const st of out.statements) await w.db.run(st.sql, ...st.params);
}

/** A parsed manifest with no `.pkey/release` at all: the repo dropped its release block. */
function manifestWithoutRelease() {
  const p = parseManifest({
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    product: JSON.stringify({ slug: SLUG, name: "D" }),
  });
  if (!p.ok) throw new Error(JSON.stringify(p));
  expect(p.manifest.release).toBeFalsy();
  return p.manifest;
}

/** Run Core's ingest pipeline for `manifest` with the given services on. */
async function ingestManifest(
  w: World,
  manifest: ReturnType<typeof manifestWithoutRelease>,
  on: { release: boolean; distribution: boolean },
) {
  const out = manifestIngestFor(SERVICES)(
    manifest,
    SLUG,
    {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: on.release },
      distribution: { enabled: on.distribution },
      update: { enabled: on.distribution },
      identity: { enabled: false },
    },
    NOW,
  );
  for (const st of out.statements) await w.db.run(st.sql, ...st.params);
}

/** Every anonymous download surface a licensed product must refuse. */
async function expectAnonymousRefused(w: World): Promise<void> {
  for (const url of [
    `${CONSOLE}/${SLUG}/release/dl/latest/djdl-arm64`,
    `${CONSOLE}/${SLUG}/distribution/dl/latest/djdl-arm64`,
    `${CONSOLE}/${SLUG}/distribution/builds/stable/cli-arm64`,
    `${BYTES}/${SLUG}/distribution/builds/stable/cli-arm64`,
    `${BYTES}/${SLUG}/release/builds/stable/cli-arm64`,
    `${BYTES}/${SLUG}/distribution/files/v1.1.0/djdl-arm64`,
    `${CONSOLE}/${SLUG}/update/appcast.xml`,
  ]) {
    const res = await get(w, url);
    expect(res.status, url).toBe(401);
  }
}

describe("turning Distribution on in the console never opens a licensed product's downloads", () => {
  it("a Release-only product's licensed manifest is in force the moment Distribution is enabled", async () => {
    // Linked after 0038 with Release on and Distribution off: the ingest still writes the
    // `app` row (`manifestIngestAlways`), so enabling Distribution live — which runs no
    // ingest — finds `licensed`, not a missing row.
    const w = await setup();
    await services(w, { release: true, distribution: false });
    await w.db.run("DELETE FROM dist_access WHERE product = ?", SLUG);
    await w.db.run(
      "UPDATE release_config SET artifacts_access = 'licensed' WHERE product = ?",
      SLUG,
    );
    await ingestWithDistributionOff(w, "licensed");
    expect(await accessModeOf(w.db, SLUG, "app")).toBe("licensed");
    await enableDistributionInConsole(w);
    await expectAnonymousRefused(w);
  });

  it("a mode tightened while Distribution was off is the one in force when it comes back", async () => {
    const w = await setup();
    expect(await accessModeOf(w.db, SLUG, "app")).toBe("public");
    await services(w, { release: true, distribution: false });
    await ingestWithDistributionOff(w, "licensed");
    await enableDistributionInConsole(w);
    await expectAnonymousRefused(w);
  });

  it("a product no ingest has written a row for reads fail-closed, never public", async () => {
    const w = await setup();
    await services(w, { release: true, distribution: false });
    await w.db.run("DELETE FROM dist_access WHERE product = ?", SLUG);
    await enableDistributionInConsole(w);
    expect(await accessModeOf(w.db, SLUG, "app")).toBe("entitled");
    await expectAnonymousRefused(w);
  });
});

describe("dropping .pkey/release never loosens an existing delivery access", () => {
  it("operator-owned services stay on: a licensed product stays licensed after the push", async () => {
    // Services owned by the operator, so the push leaves Release and Distribution on and
    // release_config in place — the row must not fall back to the link-time `public`.
    const w = await setup();
    await ingestWithDistributionOff(w, "licensed");
    expect(await accessModeOf(w.db, SLUG, "app")).toBe("licensed");
    await ingestManifest(w, manifestWithoutRelease(), {
      release: true,
      distribution: true,
    });
    expect(
      await w.db.first(
        "SELECT mode, source FROM dist_access WHERE product = ? AND deliverable_id = 'app'",
        SLUG,
      ),
    ).toEqual({ mode: "licensed", source: "manifest" });
    await expectAnonymousRefused(w);
  });

  it("manifest-owned services: the push turns them off, the operator turns them back on, still licensed", async () => {
    const w = await setup();
    await ingestWithDistributionOff(w, "licensed");
    await services(w, { release: false, distribution: false });
    await ingestManifest(w, manifestWithoutRelease(), {
      release: false,
      distribution: false,
    });
    expect(await accessModeOf(w.db, SLUG, "app")).toBe("licensed");
    await enableDistributionInConsole(w, true);
    await expectAnonymousRefused(w);
  });
});

// ── 4. dist_access mechanics ──────────────────────────────────────────────────────────────────

describe("dist_access", () => {
  it("a deliverable with no row inherits the app's; no app row reads fail-closed as entitled", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    // No row at all must never read as open.
    expect(await accessModeOf(db, SLUG, "app")).toBe("entitled");
    expect(await accessModeOf(db, SLUG, "foes")).toBe("entitled");
    await db.run(
      "INSERT INTO dist_access (product, deliverable_id, mode, source, modified_at) VALUES (?, 'app', 'licensed', 'manifest', 0)",
      SLUG,
    );
    expect(await accessModeOf(db, SLUG, "foes")).toBe("licensed");
    await db.run(
      "INSERT INTO dist_access (product, deliverable_id, mode, source, modified_at) VALUES (?, 'foes', 'public', 'admin', 0)",
      SLUG,
    );
    expect(await accessModeOf(db, SLUG, "foes")).toBe("public");
    expect(await accessModeOf(db, SLUG, "app")).toBe("licensed");
  });

  it("the manifest writes the app row unless an operator owns it", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    const parsed = (mode: string) =>
      parseManifest({
        schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
        product: JSON.stringify({ slug: SLUG, name: "D" }),
        release: JSON.stringify({
          release: {
            ghOwner: "acme",
            ghRepo: "djdl",
            access: { metadata: "public", artifacts: mode },
          },
        }),
      });
    const apply = async (mode: string, at: number) => {
      const p = parsed(mode);
      if (!p.ok) throw new Error(JSON.stringify(p));
      for (const s of accessIngestStatements(p.manifest, SLUG, at))
        await db.run(s.sql, ...s.params);
    };
    const row = () =>
      db.first<{ mode: string; source: string; modified_at: number }>(
        "SELECT mode, source, modified_at FROM dist_access WHERE product = ? AND deliverable_id = 'app'",
        SLUG,
      );
    await apply("licensed", 10);
    expect(await row()).toEqual({
      mode: "licensed",
      source: "manifest",
      modified_at: 10,
    });
    // Idempotent: the same manifest moves nothing.
    await apply("licensed", 20);
    expect((await row())!.modified_at).toBe(10);
    // An operator's claim survives the next push.
    await db.run(
      "UPDATE dist_access SET mode = 'entitled', source = 'admin' WHERE product = ?",
      SLUG,
    );
    await apply("public", 30);
    expect(await row()).toMatchObject({ mode: "entitled", source: "admin" });
  });

  it("a manifest with no release block seeds a missing app row as public and never rewrites one", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    const p = parseManifest({
      schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
      product: JSON.stringify({ slug: SLUG, name: "D" }),
    });
    if (!p.ok) throw new Error(JSON.stringify(p));
    expect(p.manifest.release).toBeFalsy();
    const apply = async (at: number) => {
      for (const s of accessIngestStatements(p.manifest, SLUG, at))
        await db.run(s.sql, ...s.params);
    };
    const row = () =>
      db.first<{ mode: string; source: string; modified_at: number }>(
        "SELECT mode, source, modified_at FROM dist_access WHERE product = ? AND deliverable_id = 'app'",
        SLUG,
      );
    // No row yet: the link-time default, the value release_config took.
    await apply(10);
    expect(await row()).toEqual({
      mode: "public",
      source: "manifest",
      modified_at: 10,
    });
    // A manifest-owned licensed row (an earlier push with a release block) is left alone.
    await db.run(
      "UPDATE dist_access SET mode = 'licensed', modified_at = 20 WHERE product = ?",
      SLUG,
    );
    await apply(30);
    expect(await row()).toEqual({
      mode: "licensed",
      source: "manifest",
      modified_at: 20,
    });
    // So is an operator's claim.
    await db.run(
      "UPDATE dist_access SET mode = 'entitled', source = 'admin' WHERE product = ?",
      SLUG,
    );
    await apply(40);
    expect(await row()).toMatchObject({ mode: "entitled", source: "admin" });
  });

  it("admin: GET shows the app mode, PUT validates and audits, revert only for the app", async () => {
    const w = await setup();
    const view = await admin(w, "GET", "/access");
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({
      modes: ["public", "authenticated", "licensed", "entitled"],
      app: { deliverableId: "app", mode: "public" },
    });
    for (const [body, field] of [
      [{ mode: "everyone" }, "mode"],
      [{ mode: "public", deliverable: 7 }, "deliverable"],
      [{ mode: "public", deliverable: "no-such-pack" }, "deliverable"],
      [{ mode: "public", entitlement: "has spaces" }, "entitlement"],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await admin(w, "PUT", "/access", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await res.json()).toMatchObject({ fields: [field] });
    }
    const put = await admin(w, "PUT", "/access", {
      mode: "licensed",
      entitlement: "supporter",
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      app: { mode: "licensed", source: "admin" },
      deliverables: [
        expect.objectContaining({
          deliverableId: "app",
          entitlement: "supporter",
        }),
      ],
    });
    const audit = await w.db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ? ORDER BY rowid",
      SLUG,
    );
    expect(audit.map((a) => a.action)).toContain("distribution.access.update");
    const reverted = await admin(w, "POST", "/access/revert", {});
    expect(await reverted.json()).toMatchObject({
      app: { mode: "licensed", source: "manifest" },
    });
  });

  it("deliveryUrl mints canonical bytes-host URLs, and refuses what is not ours to serve", async () => {
    const w = await setup();
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    const delivery = buildHooks(SERVICES, product.services, {
      env: w.env,
      db: w.db,
      product,
      now: NOW,
    }).delivery()!;
    expect(
      await delivery.deliveryUrl({ releaseId: "v1.1.0", name: "djdl-arm64" }),
    ).toBe(`${BYTES}/${SLUG}/distribution/files/v1.1.0/djdl-arm64`);
    expect(
      await delivery.deliveryUrl({ releaseId: "v1.1.0", buildId: "cli-arm64" }),
    ).toBe(`${BYTES}/${SLUG}/distribution/files/v1.1.0/djdl-arm64`);
    expect(
      await delivery.deliveryUrl({ releaseId: "v1.1.0", name: "nope" }),
    ).toBeNull();
    expect(
      await delivery.deliveryUrl({ releaseId: "v1.1.0", buildId: "nope" }),
    ).toBeNull();
    // An outlet that delivers the app by a store transport: not ours.
    await w.db.run(
      "INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at) VALUES (?, 'play', 'play', '{}', ?, ?)",
      SLUG,
      NOW,
      NOW,
    );
    await w.db.run(
      "INSERT INTO dist_transports (product, deliverable_id, outlet_id, transport) VALUES (?, 'app', 'play', 'embedded')",
      SLUG,
    );
    expect(
      await delivery.deliveryUrl({
        releaseId: "v1.1.0",
        name: "djdl-arm64",
        outlet: "play",
      }),
    ).toBeNull();
    // The minted URL answers.
    const res = await get(
      w,
      (await delivery.deliveryUrl({
        releaseId: "v1.1.0",
        buildId: "cli-arm64",
      }))!,
    );
    expect(res.status).toBe(200);
  });

  it("deliveryUrl never mints a build URL from a stored version a route would read as a selector", async () => {
    // A GitHub-synced release takes its version from its tag, so a rolling release tagged
    // `latest` is stored with the version `latest`. `builds/latest/<id>` would serve whatever the
    // stable channel points at NOW (v1.1.0), cached as moving — not this release. The build's
    // URL is its payload file's, pinned to the release by id (P2-05's fixedVersion rule).
    const db = makeTestDb();
    await seedReleaseProduct(db);
    const env = envFor({ blobOrigin: BYTES });
    env.BLOBS = asR2(new R2Mock());
    ASSET_BYTES[451] = bytesOf(4500, 45);
    const gh = github({
      releases: [
        release(
          "latest",
          [
            {
              id: 451,
              name: "djdl-arm64",
              size: ASSET_BYTES[451]!.length,
              content_type: "application/octet-stream",
              browser_download_url:
                "https://github.com/acme/djdl/releases/download/latest/djdl-arm64",
            },
          ],
          { prerelease: true },
        ),
        ...RELEASES,
      ],
    });
    await syncAndDescribe(env, db, gh.fetchImpl);
    const b = stmtUpsertBuild(
      {
        product: SLUG,
        releaseId: "latest",
        buildId: "cli-arm64",
        platform: "macos",
        arch: "arm64",
        format: "binary",
      },
      NOW,
    );
    await db.run(b.sql, ...b.params);
    const a = stmtSetArtifactModel({
      product: SLUG,
      releaseId: "latest",
      artifactId: "451",
      buildId: "cli-arm64",
      role: "payload",
      sha256: sha256Hex(ASSET_BYTES[451]!),
    });
    await db.run(a.sql, ...a.params);
    const stored = await db.first<{ version: string }>(
      "SELECT version FROM release_metadata WHERE product = ? AND release_id = 'latest'",
      SLUG,
    );
    expect(stored?.version).toBe("latest");

    const product = (await loadProduct(env, db, SLUG))!;
    const delivery = buildHooks(SERVICES, product.services, {
      env,
      db,
      product,
      now: NOW,
    }).delivery()!;
    const url = await delivery.deliveryUrl({
      releaseId: "latest",
      buildId: "cli-arm64",
    });
    expect(url).toBe(`${BYTES}/${SLUG}/distribution/files/latest/djdl-arm64`);
    expect(url).not.toContain("/builds/");
    // …and it serves THIS release's payload, not the stable channel's current one.
    const res = await call(env, db, gh.fetchImpl, url!);
    expect(res.status).toBe(200);
    expect(sha256Hex(new Uint8Array(await res.arrayBuffer()))).toBe(
      sha256Hex(ASSET_BYTES[451]!),
    );

    // A build with no payload has no immutable URL at all.
    const bare = stmtUpsertBuild(
      {
        product: SLUG,
        releaseId: "latest",
        buildId: "bare",
        platform: "macos",
        arch: "arm64",
        format: "binary",
      },
      NOW,
    );
    await db.run(bare.sql, ...bare.params);
    expect(
      await delivery.deliveryUrl({ releaseId: "latest", buildId: "bare" }),
    ).toBeNull();
  });

  it("the portal redirects a public artifact with no GitHub URL to the bytes host, never a gated one", async () => {
    const w = await setup();
    const { licenseId } = await seedLicenseWithKey(w.db, SLUG);
    const account = await getOrCreateAccountByEmail(
      w.db,
      "ada@example.com",
      NOW,
    );
    await linkLicense(w.db, account.id, SLUG, licenseId, "license-key", NOW);
    // An R2-held file: no GitHub storage URL to redirect to.
    await w.db.run(
      "UPDATE release_artifacts SET source_url = NULL WHERE product = ? AND release_id = 'v1.1.0' AND name = 'djdl-arm64'",
      SLUG,
    );
    const artifactId = (await w.db.first<{ artifact_id: string }>(
      "SELECT artifact_id FROM release_artifacts WHERE product = ? AND release_id = 'v1.1.0' AND name = 'djdl-arm64'",
      SLUG,
    ))!.artifact_id;
    const { token, session } = await issuePortalSession(
      w.env,
      {
        accountId: account.id,
        email: account.primary_email,
        name: account.display_name,
      },
      NOW,
    );
    const path = `/api/releases/${SLUG}/v1.1.0/artifacts/${artifactId}/token`;
    const mint = () =>
      handlePortalApi(
        new Request(`${CONSOLE}${path}`, {
          method: "POST",
          headers: {
            cookie: `${PORTAL_COOKIE}=${token}`,
            [PORTAL_CSRF_HEADER]: session.csrf,
          },
        }),
        w.env,
        w.db,
        path,
        NOW,
      );
    const minted = await mint();
    expect(minted.status).toBe(201);
    const { url } = (await minted.json()) as { url: string };
    const token1 = decodeURIComponent(url.replace("/download/", ""));
    const redirect = await handlePortalDownload(
      new Request(`${CONSOLE}${url}`),
      w.env,
      w.db,
      token1,
      NOW,
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(
      `${BYTES}/${SLUG}/distribution/files/v1.1.0/djdl-arm64`,
    );

    // A non-public deliverable is never sent to the bytes host: the browser has no device token.
    await admin(w, "PUT", "/access", { mode: "licensed" });
    expect((await mint()).status).toBe(404);
  });

  it("0038 backfills the app row from release_config, normalised, with its owner", async () => {
    const db = makeTestDb();
    for (const [slug, mode, source] of [
      ["p-public", "public", null],
      ["p-entitled", "entitled", "admin"],
      ["p-garbage", "everyone", "manifest"],
    ] as const) {
      await seedProduct(db, slug);
      await db.run(
        `INSERT INTO release_config (product, gh_owner, gh_repo, summary_marker, artifacts_access, access_source)
         VALUES (?, 'o', 'r', 'pkey:summary', ?, ?)`,
        slug,
        mode,
        source,
      );
    }
    // A row written since the migration first ran is never overwritten by a replay.
    await db.run(
      "INSERT INTO dist_access (product, deliverable_id, mode, source, modified_at) VALUES ('p-public', 'app', 'licensed', 'admin', 5)",
    );
    const sql = readFileSync(
      join(HERE, "..", "migrations", "0038_distribution_rollouts_access.sql"),
      "utf8",
    );
    for (const stmt of sql
      .split(/;\s*$/m)
      .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean))
      await db.run(stmt);
    const rows = await db.all<{
      product: string;
      mode: string;
      source: string;
    }>(
      "SELECT product, mode, source FROM dist_access WHERE product LIKE 'p-%' ORDER BY product",
    );
    expect(rows).toEqual([
      { product: "p-entitled", mode: "entitled", source: "admin" },
      { product: "p-garbage", mode: "public", source: "manifest" },
      { product: "p-public", mode: "licensed", source: "admin" },
    ]);
  });
});
