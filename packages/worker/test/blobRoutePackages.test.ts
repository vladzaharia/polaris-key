/**
 * SEC-DST-1/2/12/14 — the blob route (`GET /<p>/distribution/blobs/sha256/<hex>`) never serves a
 * package version's file. The package feeds serve those under `stricter(feed access_mode,
 * dist_access)`; before the `package-file` ref kind, the route read the file's `artifact` ref as
 * an app artifact under the app's (usually `public`) mode, so the sha256 in a lockfile, a PyPI
 * fragment or an OCI digest was a bearer capability.
 *
 * The package bytes are really in the store (`packageFixture` writes them, SEC-DST-14): the
 * route's 404 here is the access decision, not a missing object.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDigestStream } from "./r2Mock.js";
import { NOW } from "./seed.js";
import { call, CONSOLE, SLUG } from "./releaseRoutesFixture.js";
import { feedWorld, noFetch, publish, type FeedWorld } from "./feedWorld.js";
import {
  addPackageRelease,
  PACKAGE_ID,
  PACKAGE_VERSION,
} from "./packageFixture.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  PACKAGE_FILE_REF,
  PUBLIC_BLOB_CACHE,
  blobKey,
  recordObject,
  recordRef,
  stmtDropRefs,
} from "../src/core/blobs.js";
import { reconcilePackageFileRefs } from "../src/services/release/packages/refReconcile.js";
import { publicKeyIsPublic } from "../src/services/distribution/blobAccess.js";
import { releaseCatalog } from "../src/services/release/catalog.js";
import { loadProductPublic } from "../src/core/products.js";
import { NO_HOOKS } from "./helpers.js";

installDigestStream();

describe("the blob route and package files (SEC-DST-1)", () => {
  let w: FeedWorld;
  let pkg: { releaseId: string; sha256: string };
  let appSha: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
    w = await feedWorld();
    await publish(w, "1.3.0");
    pkg = await addPackageRelease(w.db, w.env, SLUG, NOW);
    appSha = createHash("sha256").update("web 1.3.0").digest("hex");
  });
  afterEach(() => vi.useRealTimers());

  const blob = (sha: string, host = CONSOLE) =>
    call(
      w.env,
      w.db,
      noFetch,
      `${host}/${SLUG}/distribution/blobs/sha256/${sha}`,
    );

  it("the package's bytes are in the store (the fixture is not vacuous, SEC-DST-14)", async () => {
    const head = await w.env.BLOBS!.head(blobKey(pkg.sha256));
    expect(head).not.toBeNull();
    expect(
      await w.db.first(
        "SELECT ref_kind FROM blob_refs WHERE storage_key = ?",
        blobKey(pkg.sha256),
      ),
    ).toEqual({ ref_kind: PACKAGE_FILE_REF });
  });

  it("a private package file by sha256, anonymous, is denied (app public, package entitled)", async () => {
    await w.db.run(
      `INSERT OR REPLACE INTO dist_access (product, deliverable_id, mode, source, modified_at)
       VALUES (?, 'app', 'public', 'manifest', ?), (?, ?, 'entitled', 'manifest', ?)`,
      SLUG,
      NOW,
      SLUG,
      PACKAGE_ID,
      NOW,
    );
    const res = await blob(pkg.sha256);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(pkg.sha256);
  });

  it("a package file is denied even when its own mode is public (the feed serves it, this route never)", async () => {
    await w.db.run(
      `INSERT OR REPLACE INTO dist_access (product, deliverable_id, mode, source, modified_at)
       VALUES (?, ?, 'public', 'manifest', ?)`,
      SLUG,
      PACKAGE_ID,
      NOW,
    );
    expect((await blob(pkg.sha256)).status).toBe(404);
  });

  it("stays denied after the release is yanked", async () => {
    await w.db.run(
      "INSERT INTO release_yanks (product, release_id, reason, at, by) VALUES (?, ?, 'bad', ?, 'u1')",
      SLUG,
      pkg.releaseId,
      NOW,
    );
    expect((await blob(pkg.sha256)).status).toBe(404);
  });

  it("stays denied after the release is removed (rows deleted, refs dropped or not)", async () => {
    await w.db.run("DELETE FROM release_packages WHERE product = ?", SLUG);
    await w.db.run(
      "DELETE FROM release_artifacts WHERE product = ? AND release_id = ?",
      SLUG,
      pkg.releaseId,
    );
    await w.db.run(
      "DELETE FROM release_metadata WHERE product = ? AND release_id = ?",
      SLUG,
      pkg.releaseId,
    );
    expect((await blob(pkg.sha256)).status).toBe(404);
    const drop = stmtDropRefs(SLUG, PACKAGE_FILE_REF, [
      `${pkg.releaseId}/file:pkgtest-sdk-${PACKAGE_VERSION}.tgz`,
    ]);
    await w.db.run(drop.sql, ...drop.params);
    expect((await blob(pkg.sha256)).status).toBe(404);
  });

  it("on the bytes host too, and HEAD", async () => {
    expect((await blob(pkg.sha256, "https://dl.example.test")).status).toBe(
      404,
    );
    const head = await call(
      w.env,
      w.db,
      noFetch,
      `${CONSOLE}/${SLUG}/distribution/blobs/sha256/${pkg.sha256}`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(404);
  });

  it("every ecosystem's file is held by the same ref kind: denied for each", async () => {
    // The kind is written by the one package ingest, whatever the ecosystem; hold a distinct
    // object per ecosystem the way it does and ask the route.
    for (const eco of [
      "npm",
      "pypi",
      "swift",
      "maven",
      "godot",
      "oci",
      "cargo",
      "go",
    ]) {
      const bytes = new TextEncoder().encode(`eco ${eco}`);
      const hex = createHash("sha256").update(bytes).digest("hex");
      await w.env.BLOBS!.put(blobKey(hex), bytes, { sha256: hex });
      await recordObject(
        w.db,
        {
          storageKey: blobKey(hex),
          sha256: hex,
          size: bytes.length,
          kind: "blob",
          gated: false,
        },
        NOW,
      );
      await recordRef(
        w.db,
        {
          product: SLUG,
          storageKey: blobKey(hex),
          refKind: PACKAGE_FILE_REF,
          refId: `${eco}.pkg@1.0.0/file:x-${eco}`,
        },
        NOW,
      );
      expect((await blob(hex)).status, eco).toBe(404);
    }
  });

  it("the F-Droid relay never treats a package file as public (SEC-DST-2)", async () => {
    const product = (await loadProductPublic(w.db, SLUG))!;
    const catalog = releaseCatalog({
      db: w.db,
      env: w.env,
      product,
      now: NOW,
      hooks: NO_HOOKS,
    });
    expect(await publicKeyIsPublic(w.db, SLUG, catalog, pkg.sha256)).toBe(
      false,
    );
    expect(await publicKeyIsPublic(w.db, SLUG, catalog, appSha)).toBe(true);
  });

  it("a public release artifact is still served, with a bounded cache", async () => {
    const res = await blob(appSha);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_BLOB_CACHE);
    expect(res.headers.get("cache-control")).not.toContain("immutable");
    await res.body?.cancel();
  });

  it("an app artifact whose deliverable turns entitled is no longer served anonymously, and its public answer was never cached a year", async () => {
    await w.db.run(
      `INSERT OR REPLACE INTO dist_access (product, deliverable_id, mode, source, modified_at)
       VALUES (?, 'app', 'entitled', 'manifest', ?)`,
      SLUG,
      NOW,
    );
    const res = await blob(appSha);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).not.toContain("public");
  });

  it("migration 0107 re-kinds an old package `artifact` ref and leaves an app artifact's alone", async () => {
    await w.db.run(
      "UPDATE blob_refs SET ref_kind = 'artifact' WHERE ref_kind = ?",
      PACKAGE_FILE_REF,
    );
    // Old world: the package file is served by hash.
    expect((await blob(pkg.sha256)).status).toBe(200);
    const sql = readFileSync(
      new URL("../migrations/0107_package_file_ref_kind.sql", import.meta.url),
      "utf8",
    );
    await w.db.run(sql);
    expect((await blob(pkg.sha256)).status).toBe(404);
    const kinds = await w.db.all<{ ref_kind: string }>(
      "SELECT DISTINCT ref_kind FROM blob_refs WHERE storage_key = ?",
      blobKey(appSha),
    );
    expect(kinds).toEqual([{ ref_kind: "artifact" }]);
  });

  it("the deploy window heals: old-Worker writes after the migration are re-kinded or dropped, app artifacts untouched", async () => {
    const appBefore = await w.db.all(
      "SELECT ref_kind, ref_id FROM blob_refs WHERE storage_key = ?",
      blobKey(appSha),
    );
    // The old Worker publishes a second package version after the migration: `artifact` ref.
    const v2 = await addPackageRelease(w.db, w.env, SLUG, NOW, "99.9.8");
    await w.db.run(
      "UPDATE blob_refs SET ref_kind = 'artifact' WHERE storage_key = ?",
      blobKey(v2.sha256),
    );
    // The old prune of the first version: its rows go, the (re-kinded) ref is not matched.
    await w.db.run(
      "UPDATE blob_refs SET ref_kind = 'artifact' WHERE storage_key = ?",
      blobKey(pkg.sha256),
    );
    await w.db.run(
      "DELETE FROM release_artifacts WHERE product = ? AND release_id = ?",
      SLUG,
      pkg.releaseId,
    );
    // A stale twin: both kinds exist for one ref id.
    await recordRef(
      w.db,
      {
        product: SLUG,
        storageKey: blobKey(v2.sha256),
        refKind: PACKAGE_FILE_REF,
        refId: `${v2.releaseId}/file:pkgtest-sdk-99.9.8.tgz`,
      },
      NOW,
    );
    expect((await blob(v2.sha256)).status).toBe(200); // the window's exposure
    expect((await blob(pkg.sha256)).status).toBe(200);

    expect(await reconcilePackageFileRefs(w.db)).toBe(2);
    expect((await blob(v2.sha256)).status).toBe(404);
    expect((await blob(pkg.sha256)).status).toBe(404);
    expect(
      await w.db.all(
        "SELECT ref_kind, ref_id FROM blob_refs WHERE storage_key = ?",
        blobKey(appSha),
      ),
    ).toEqual(appBefore);
    expect((await blob(appSha)).status).toBe(200);
    // Idempotent.
    expect(await reconcilePackageFileRefs(w.db)).toBe(0);
  });
});
