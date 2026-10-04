/**
 * F-03 — a package release never reaches a device-facing surface (plans/F-01.md §2, §6.3).
 *
 * Each world publishes ordinary app releases, then a package version (`npm.sdk@99.9.9`, newer
 * than every app version, so "the newest" would pick it) through the real package ingest. Then
 * every surface a device, an updater or a storefront reads is asked, one test each: the signed
 * channel feed, the update decision, the latest release, the Sparkle appcast, the
 * records route, the byte routes, the download page and the storefront feeds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDigestStream } from "./r2Mock.js";
import { NOW } from "./seed.js";
import { call, CONSOLE, SLUG } from "./releaseRoutesFixture.js";
import {
  feedWorld,
  getFeed,
  noFetch,
  publish,
  type FeedWorld,
} from "./feedWorld.js";
import * as download from "./downloadWorld.js";
import {
  addPackageRelease,
  PACKAGE_ID,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "./packageFixture.js";
import { simulate, SimulateNotFound } from "../src/services/update/simulate.js";
import { getProduct } from "../src/repo.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { NO_HOOKS } from "./helpers.js";

installDigestStream();

/** No trace of the package: its id, its name or its version. */
function expectNoPackage(text: string): void {
  expect(text).not.toContain(PACKAGE_ID);
  expect(text).not.toContain(PACKAGE_NAME);
  expect(text).not.toContain(PACKAGE_VERSION);
}

describe("updater and record surfaces never show a package (F-03)", () => {
  let w: FeedWorld;
  let pkg: { releaseId: string; sha256: string };
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
    w = await feedWorld();
    await publish(w, "1.3.0");
    pkg = await addPackageRelease(w.db, w.env, SLUG, NOW);
  });
  afterEach(() => vi.useRealTimers());

  const get = (path: string) =>
    call(w.env, w.db, noFetch, `${CONSOLE}/${SLUG}${path}`);

  it("the signed channel feed lists the app release and never the package", async () => {
    const { res, payload } = await getFeed(w, "stable");
    expect(res.status).toBe(200);
    const text = JSON.stringify(payload);
    expect(text).toContain("1.3.0");
    expectNoPackage(text);
  });

  it("the update decision (the simulator) refuses a package release and never answers one", async () => {
    const product = (await getProduct(w.db, SLUG))!;
    const ctx = { db: w.db, hooks: NO_HOOKS, now: NOW, product };
    await expect(
      simulate(ctx, {
        appRelease: pkg.releaseId,
        platform: "macos",
        outlet: null,
        axes: {},
        channel: "stable",
        device: null,
        methods: [],
        packSetId: null,
      }),
    ).rejects.toBeInstanceOf(SimulateNotFound);
    const ok = await simulate(ctx, {
      appRelease: "app@1.3.0",
      platform: "macos",
      outlet: null,
      axes: {},
      channel: "stable",
      device: null,
      methods: [],
      packSetId: null,
    });
    expectNoPackage(JSON.stringify(ok));
  });

  it("the latest release (a moving build selector) is the app's, never the package", async () => {
    // `builds/latest/<buildId>` resolves the newest release through Release's resolution: the
    // app's 1.3.0, although the package's 99.9.9 is newer and on the same channel.
    const latest = await get("/distribution/builds/latest/web");
    expect(latest.status).toBeLessThan(500);
    const where = `${latest.headers.get("location") ?? ""} ${latest.headers.get("content-disposition") ?? ""} ${await latest.text()}`;
    expectNoPackage(where);
    expect(latest.status).toBe(200);
    expect(latest.headers.get("content-disposition")).toContain(
      "djdl-1.3.0-web.zip",
    );
  });

  it("the Sparkle appcast never lists the package", async () => {
    for (const path of ["/update/appcast.xml", "/update/stable/appcast.xml"]) {
      const res = await get(path);
      expect(res.status).toBeLessThan(500);
      expectNoPackage(await res.text());
    }
  });

  it("the records route answers not-found for a package: none is stored, and a forged row is never served", async () => {
    expect(
      await w.db.all(
        "SELECT 1 FROM release_records WHERE product = ? AND release_id = ?",
        SLUG,
        pkg.releaseId,
      ),
    ).toEqual([]);
    const forged = "f".repeat(64);
    await w.db.run(
      `INSERT INTO release_records (product, deliverable_id, release_id, seq, kind, record_sha256,
         kid, jws, ingested_at)
       VALUES (?, ?, ?, 1, 'package', ?, 'k', 'a.b.c', ?)`,
      SLUG,
      PACKAGE_ID,
      pkg.releaseId,
      forged,
      NOW,
    );
    expect((await get(`/release/records/${forged}`)).status).toBe(404);
    expect((await get(`/release/records/${pkg.sha256}`)).status).toBe(404);
  });

  it("the byte routes never serve a package's file, by release or by digest", async () => {
    const file = await get(
      `/distribution/files/${encodeURIComponent(pkg.releaseId)}/pkgtest-sdk-${PACKAGE_VERSION}.tgz`,
    );
    expect(file.status).toBe(404);
    const blob = await get(`/distribution/blobs/sha256/${pkg.sha256}`);
    expect(blob.status).toBe(404);
  });
});

describe("the download page and the storefront feeds never show a package (F-03)", () => {
  let w: Awaited<ReturnType<typeof download.setup>>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
    w = await download.setup();
    await addPackageRelease(w.db, w.env, download.SLUG, NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("the download page (its model and its HTML) shows the app's newest release, never the package", async () => {
    const model = await download.model(w);
    const text = JSON.stringify(model);
    expect(text).toContain("1.2.0");
    expectNoPackage(text);
    const html = await download.onConsole(
      w,
      `/${download.SLUG}/distribution/download`,
    );
    expectNoPackage(await html.text());
  });

  it("the storefront feeds (AltStore, Obtainium, Scoop, Flathub) never list the package", async () => {
    for (const path of [
      "altstore/stable/source.json",
      "altstore-pal/stable/source.json",
      "obtainium/stable.json",
      "scoop/stable.json",
      "flathub/stable.json",
    ]) {
      const res = await download.onConsole(
        w,
        `/${download.SLUG}/distribution/${path}`,
      );
      expect(res.status, path).toBeLessThan(500);
      expectNoPackage(await res.text());
    }
  });

  async function distAdmin(path: string): Promise<Response> {
    const { token, session } = await issueSession(
      w.env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const full = `/api/products/${download.SLUG}/distribution${path}`;
    return handleAdmin(
      new Request(`${CONSOLE}/manage${full}`, {
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
        },
      }),
      w.env,
      w.db,
      full.split("?")[0]!,
      { now: NOW },
    );
  }

  it("Distribution's matrix, readiness, rollouts and availability never take a package", async () => {
    const matrix = await distAdmin("/matrix");
    expect(matrix.status).toBe(200);
    expectNoPackage(await matrix.text());
    const asPackage = await distAdmin(`/matrix?deliverable=${PACKAGE_ID}`);
    expect(asPackage.status).toBeGreaterThanOrEqual(400);
    const readiness = await distAdmin("/readiness");
    expectNoPackage(await readiness.text());
    const rollouts = await distAdmin("/rollouts");
    expectNoPackage(await rollouts.text());
    const availability = await distAdmin(
      `/availability?release=${encodeURIComponent(`${PACKAGE_ID}@${PACKAGE_VERSION}`)}`,
    );
    expect(availability.status).toBeGreaterThanOrEqual(400);
  });
});
