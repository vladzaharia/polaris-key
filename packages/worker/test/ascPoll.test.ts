/**
 * P5-02 — the App Store Connect poller on the connector cron: what no webhook covers (phased
 * release, review submissions, internal TestFlight) and reconciliation, against the fake ASC
 * server. Also the cron dispatch in `scheduled.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import { listOutletCredentials } from "../src/core/outletCredentials.js";
import {
  CONNECTOR_POLL_CRON,
  MAINTENANCE_CRON,
  handleScheduled,
  runConnectorPolls,
} from "../src/scheduled.js";
import {
  REDRIVE_GRACE_SECONDS,
  REDRIVE_WINDOW_SECONDS,
} from "../src/services/distribution/connectors/asc/poll.js";
import { webhookFixture } from "./ascFake.js";
import {
  ascWorld,
  audits,
  availability,
  deliver,
  rollouts,
  submissions,
  withFetch,
  NOW,
  SLUG,
  type AscWorld,
} from "./ascWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

async function eventOutcomes(w: AscWorld): Promise<string[]> {
  const rows = await w.db.all<{ outcome: string }>(
    "SELECT outcome FROM dist_connector_events ORDER BY received_at, event_id",
  );
  return rows.map((r) => r.outcome);
}

function objectState(w: AscWorld, id: string) {
  return w.db.first<{ store_state: string; terminal: number }>(
    "SELECT store_state, terminal FROM dist_connector_objects WHERE object_id = ?",
    id,
  );
}

const poll = (w: AscWorld) =>
  withFetch(w, () => runConnectorPolls(w.env, w.db, NOW));

describe("the poll", () => {
  it("reads versions, review submissions and builds, and writes what they say", async () => {
    const w = await ascWorld();
    const report = await poll(w);
    expect(report.failures).toEqual({});
    expect(w.fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/apps/1234567890/reviewSubmissions",
      "GET /v1/apps/1234567890/appStoreVersions",
      "GET /v1/builds",
    ]);
    expect(w.fake.requests[2]!.query).toMatchObject({
      "filter[app]": "1234567890",
      sort: "-uploadedDate",
    });
    const rows = await availability(w.db);
    expect(
      rows.map((r) => [r.outlet_id, r.release_id, r.build_id, r.state]),
    ).toEqual([
      ["app-store", "v1.0.0", "", "removed"],
      ["app-store", "v1.1.0", "", "approved"],
      ["testflight", "v1.0.0", "", "live"],
      ["testflight", "v1.1.0", "ios", "live"],
    ]);
    expect(rows.every((r) => r.source === "asc")).toBe(true);
    expect(await submissions(w.db)).toEqual([
      {
        release_id: "v1.1.0",
        outlet_id: "app-store",
        state: "pending-developer-release",
        source: "asc",
      },
    ]);
    // INACTIVE phased release: nothing mirrored.
    expect(await rollouts(w.db)).toEqual([]);
    // The credential's health columns record the run.
    const cred = (await listOutletCredentials(w.db, SLUG)).find(
      (c) => c.id === "asc",
    )!;
    expect(cred.lastOkAt).toBe(NOW);
    expect(cred.lastError).toBeNull();
  });

  it("a second tick over unchanged state writes no audit rows", async () => {
    const w = await ascWorld();
    await poll(w);
    const before = (await audits(w.db)).filter((a) =>
      a.action.startsWith("distribution."),
    );
    await poll(w);
    const after = (await audits(w.db)).filter((a) =>
      a.action.startsWith("distribution."),
    );
    expect(after).toEqual(before);
  });

  it("mirrors an ACTIVE phased release at Apple's day: day 3 → 500 bp", async () => {
    const w = await ascWorld();
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    w.fake.set("appStoreVersionPhasedReleases", "phr-110", {
      phasedReleaseState: "ACTIVE",
      currentDayNumber: 3,
    });
    await poll(w);
    const [r] = await rollouts(w.db);
    expect(r).toMatchObject({
      release_id: "v1.1.0",
      outlet_id: "app-store",
      rollout_bp: 500,
      state: "active",
      mirrored: 1,
      source: "asc",
    });
    const mirror = (await audits(w.db)).filter(
      (a) => a.action === "distribution.rollout.mirror",
    );
    expect(mirror).toHaveLength(1);
    expect(mirror[0]!.actor_sub).toBe("connector:asc");
  });

  it("PAUSED mirrors as paused, and COMPLETE as complete at 100 %", async () => {
    const w = await ascWorld();
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    w.fake.set("appStoreVersionPhasedReleases", "phr-110", {
      phasedReleaseState: "PAUSED",
      currentDayNumber: 4,
    });
    await poll(w);
    expect((await rollouts(w.db))[0]).toMatchObject({
      state: "paused",
      rollout_bp: 1000,
    });
    w.fake.set("appStoreVersionPhasedReleases", "phr-110", {
      phasedReleaseState: "COMPLETE",
      currentDayNumber: 4,
    });
    await poll(w);
    expect((await rollouts(w.db))[0]).toMatchObject({
      state: "complete",
      rollout_bp: 10000,
    });
  });

  it("the phased release of a replaced version never fights the current one's mirror", async () => {
    const w = await ascWorld();
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    w.fake.set("appStoreVersionPhasedReleases", "phr-110", {
      phasedReleaseState: "ACTIVE",
      currentDayNumber: 3,
    });
    // v1.0.0 phased too, and finished: it is listed after v1.1.0 (older createdDate).
    w.fake.put({
      type: "appStoreVersionPhasedReleases",
      id: "phr-100",
      attributes: { phasedReleaseState: "COMPLETE", currentDayNumber: 7 },
    });
    const v100 = w.fake.get("appStoreVersions", "asv-100");
    w.fake.put({
      ...v100,
      relationships: {
        ...v100.relationships,
        appStoreVersionPhasedRelease: {
          data: { type: "appStoreVersionPhasedReleases", id: "phr-100" },
        },
      },
    });
    const mirrorRows = async () =>
      (await audits(w.db)).filter(
        (a) => a.action === "distribution.rollout.mirror",
      );
    await poll(w);
    expect(await rollouts(w.db)).toEqual([
      expect.objectContaining({
        release_id: "v1.1.0",
        rollout_bp: 500,
        state: "active",
      }),
    ]);
    expect(await mirrorRows()).toHaveLength(1);
    await poll(w);
    await poll(w);
    expect((await rollouts(w.db))[0]).toMatchObject({
      release_id: "v1.1.0",
      rollout_bp: 500,
    });
    expect(await mirrorRows()).toHaveLength(1);
    // The control acts on v1.1.0's phased release and reports its mirror.
    const { admin } = await import("./ascWorld.js");
    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/asc/phased-release/pause",
      { releaseId: "v1.1.0" },
    );
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { rollout: { releaseId: string } | null }).rollout,
    ).toMatchObject({ releaseId: "v1.1.0" });
  });

  it("an older release's phased release does not take the mirror from a newer one", async () => {
    const w = await ascWorld();
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    w.fake.set("appStoreVersionPhasedReleases", "phr-110", {
      phasedReleaseState: "ACTIVE",
      currentDayNumber: 2,
    });
    // Not terminal (Apple has not said REPLACED yet), and COMPLETE.
    w.fake.put({
      type: "appStoreVersionPhasedReleases",
      id: "phr-100",
      attributes: { phasedReleaseState: "COMPLETE", currentDayNumber: 7 },
    });
    const v100 = w.fake.get("appStoreVersions", "asv-100");
    w.fake.put({
      ...v100,
      attributes: {
        ...v100.attributes,
        appVersionState: "READY_FOR_DISTRIBUTION",
        appStoreState: "READY_FOR_DISTRIBUTION",
      },
      relationships: {
        ...v100.relationships,
        appStoreVersionPhasedRelease: {
          data: { type: "appStoreVersionPhasedReleases", id: "phr-100" },
        },
      },
    });
    await poll(w);
    await poll(w);
    expect(await rollouts(w.db)).toEqual([
      expect.objectContaining({ release_id: "v1.1.0", rollout_bp: 200 }),
    ]);
    expect(
      (await audits(w.db)).filter(
        (a) => a.action === "distribution.rollout.mirror",
      ),
    ).toHaveLength(1);
  });

  it("the whole-release TestFlight row follows the newest of several unmatched builds", async () => {
    const w = await ascWorld();
    for (const [n, uploaded, expired, internal] of [
      ["40", "2026-09-21T09:00:00.000Z", true, "EXPIRED"],
      ["41", "2026-09-22T09:00:00.000Z", false, "IN_BETA_TESTING"],
    ] as const) {
      w.fake.put({
        type: "buildBetaDetails",
        id: `bbd-110-${n}`,
        attributes: {
          internalBuildState: internal,
          externalBuildState: expired ? "EXPIRED" : "READY_FOR_BETA_SUBMISSION",
        },
        relationships: {
          build: { data: { type: "builds", id: `bld-110-${n}` } },
        },
      });
      w.fake.put({
        type: "builds",
        id: `bld-110-${n}`,
        attributes: {
          version: n,
          uploadedDate: uploaded,
          expired,
          processingState: "VALID",
        },
        relationships: {
          app: { data: { type: "apps", id: "1234567890" } },
          preReleaseVersion: {
            data: { type: "preReleaseVersions", id: "prv-110" },
          },
          buildBetaDetail: {
            data: { type: "buildBetaDetails", id: `bbd-110-${n}` },
          },
        },
      });
    }
    await poll(w);
    const tf = async () =>
      (await availability(w.db))
        .filter(
          (r) => r.outlet_id === "testflight" && r.release_id === "v1.1.0",
        )
        .map((r) => [r.build_id, r.state]);
    expect(await tf()).toEqual([
      ["", "live"],
      ["ios", "live"],
    ]);
    const before = (await audits(w.db)).filter((a) =>
      a.action.startsWith("distribution."),
    );
    await poll(w);
    await poll(w);
    expect(await tf()).toEqual([
      ["", "live"],
      ["ios", "live"],
    ]);
    expect(
      (await audits(w.db)).filter((a) => a.action.startsWith("distribution.")),
    ).toEqual(before);
    // The older build is stored, but speaks for nothing.
    expect(
      await w.db.first(
        "SELECT release_id, build_id, state FROM dist_connector_objects WHERE object_id = 'bld-110-40'",
      ),
    ).toEqual({ release_id: "v1.1.0", build_id: "", state: "removed" });
  });

  it("a Universal Purchase app's macOS version of a release does not fight its iOS version", async () => {
    const w = await ascWorld();
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    // Listed FIRST (newer createdDate), waiting for review, same version string.
    w.fake.put({
      type: "appStoreVersions",
      id: "asv-110-mac",
      attributes: {
        platform: "MAC_OS",
        versionString: "1.1.0",
        appVersionState: "WAITING_FOR_REVIEW",
        appStoreState: "WAITING_FOR_REVIEW",
        releaseType: "MANUAL",
        createdDate: "2026-09-25T10:00:00.000Z",
      },
      relationships: {
        app: { data: { type: "apps", id: "1234567890" } },
        appStoreVersionPhasedRelease: { data: null },
        build: { data: null },
      },
    });
    const state = async () => ({
      avail: (await availability(w.db))
        .filter((r) => r.outlet_id === "app-store" && r.release_id === "v1.1.0")
        .map((r) => r.state),
      subs: (await submissions(w.db)).map((r) => r.state),
    });
    await poll(w);
    expect(await state()).toEqual({ avail: ["live"], subs: ["released"] });
    const before = (await audits(w.db)).filter((a) =>
      a.action.startsWith("distribution."),
    );
    await poll(w);
    expect(await state()).toEqual({ avail: ["live"], subs: ["released"] });
    expect(
      (await audits(w.db)).filter((a) => a.action.startsWith("distribution.")),
    ).toEqual(before);
    // Stored for the console, claiming no release.
    expect(
      await w.db.first<{ release_id: string | null; detail_json: string }>(
        "SELECT release_id, detail_json FROM dist_connector_objects WHERE object_id = 'asv-110-mac'",
      ),
    ).toMatchObject({ release_id: null });
  });

  it("a mirrored rollout refuses direct edits", async () => {
    const w = await ascWorld();
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    w.fake.set("appStoreVersionPhasedReleases", "phr-110", {
      phasedReleaseState: "ACTIVE",
      currentDayNumber: 1,
    });
    await poll(w);
    const { channel } = (await rollouts(w.db))[0]!;
    const { admin } = await import("./ascWorld.js");
    const res = await admin(
      w,
      "POST",
      `/distribution/rollouts/app-store/${channel}/pause`,
      {},
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "rollout_mirrored",
    );
  });

  it("an open review submission overrides the version's submission state (UNRESOLVED_ISSUES → rejected)", async () => {
    const w = await ascWorld();
    w.fake.set("appStoreVersions", "asv-110", { appVersionState: "IN_REVIEW" });
    w.fake.set("reviewSubmissions", "rvs-110", { state: "UNRESOLVED_ISSUES" });
    await poll(w);
    expect((await submissions(w.db))[0]).toMatchObject({ state: "rejected" });
    // …and does not flip back on the next tick.
    const n = (await audits(w.db)).length;
    await poll(w);
    expect((await audits(w.db)).length).toBe(n);
  });

  it("reconciles a Background Asset object a webhook reported", async () => {
    const w = await ascWorld();
    w.fake.set("backgroundAssetVersions", "bav-1", { state: "PROCESSING" });
    await deliver(w, webhookFixture("BACKGROUND_ASSET_VERSION_STATE_UPDATED"));
    w.fake.set("backgroundAssetVersions", "bav-1", { state: "FAILED" });
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests.map((r) => r.path)).toContain(
      "/v1/backgroundAssetVersions/bav-1",
    );
    const obj = await w.db.first<{
      store_state: string;
      state: string;
      terminal: number;
    }>(
      "SELECT store_state, state, terminal FROM dist_connector_objects WHERE object_id = 'bav-1'",
    );
    expect(obj).toEqual({
      store_state: "FAILED",
      state: "rejected",
      terminal: 1,
    });
    // Terminal: not re-read again.
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests.map((r) => r.path)).not.toContain(
      "/v1/backgroundAssetVersions/bav-1",
    );
  });

  it("retires a Background Asset object that is no longer provably this app's, writing nothing", async () => {
    const w = await ascWorld();
    w.fake.set("backgroundAssetVersions", "bav-1", { state: "PROCESSING" });
    await deliver(w, webhookFixture("BACKGROUND_ASSET_VERSION_STATE_UPDATED"));
    const asset = w.fake.get("backgroundAssets", "ba-levels");
    w.fake.put({
      ...asset,
      relationships: { app: { data: { type: "apps", id: "9999999999" } } },
    });
    w.fake.set("backgroundAssetVersions", "bav-1", { state: "COMPLETE" });
    await poll(w);
    const obj = await w.db.first<{ store_state: string; terminal: number }>(
      "SELECT store_state, terminal FROM dist_connector_objects WHERE object_id = 'bav-1'",
    );
    // Not updated from the foreign read, and no longer re-read.
    expect(obj).toEqual({ store_state: "PROCESSING", terminal: 1 });
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests.map((r) => r.path)).not.toContain(
      "/v1/backgroundAssetVersions/bav-1",
    );
  });

  it("re-drives a Background Asset delivery whose follow-up failed, so the object a delivery named first is not lost", async () => {
    const w = await ascWorld();
    w.fake.set("backgroundAssetVersions", "bav-1", { state: "PROCESSING" });
    w.fake.fail429(10);
    await deliver(w, webhookFixture("BACKGROUND_ASSET_VERSION_STATE_UPDATED"));
    w.fake.fail429(0);
    expect(await eventOutcomes(w)).toEqual(["failed"]);
    expect(await objectState(w, "bav-1")).toBeNull();
    w.fake.requests.length = 0;
    const report = await poll(w);
    expect(report.failures).toEqual({});
    // The instance is re-read through the same ownership chain the webhook uses.
    expect(w.fake.requests.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        "/v1/backgroundAssetVersions/bav-1",
        "/v1/backgroundAssets/ba-levels",
      ]),
    );
    expect(await objectState(w, "bav-1")).toEqual({
      store_state: "PROCESSING",
      terminal: 0,
    });
    // Stored, not yet claimed by a release (P5-08): the event settles as `unresolved`…
    expect(await eventOutcomes(w)).toEqual(["unresolved"]);
    // …and a later manual redelivery of the same id is a duplicate.
    const again = await deliver(
      w,
      webhookFixture("BACKGROUND_ASSET_VERSION_STATE_UPDATED"),
    );
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
  });

  it("re-drives a `received` event only once its follow-up has had time to finish, and only within 24 hours", async () => {
    const w = await ascWorld();
    w.fake.set("backgroundAssetVersions", "bav-1", { state: "PROCESSING" });
    await deliver(w, webhookFixture("BACKGROUND_ASSET_VERSION_STATE_UPDATED"));
    // A follow-up cut off before it recorded anything: the row still says `received`.
    await w.db.run("UPDATE dist_connector_events SET outcome = 'received'");
    await w.db.run("DELETE FROM dist_connector_objects");
    const at = (now: number) =>
      withFetch(w, () => runConnectorPolls(w.env, w.db, now));
    const bavReads = () =>
      w.fake.requests.filter(
        (r) => r.path === "/v1/backgroundAssetVersions/bav-1",
      ).length;

    w.fake.requests.length = 0;
    await at(NOW + REDRIVE_GRACE_SECONDS - 1);
    expect(bavReads()).toBe(0);
    expect(await eventOutcomes(w)).toEqual(["received"]);

    await at(NOW + REDRIVE_GRACE_SECONDS);
    expect(bavReads()).toBe(1);
    expect(await eventOutcomes(w)).toEqual(["unresolved"]);

    // Past the window: left for a manual redelivery.
    await w.db.run("UPDATE dist_connector_events SET outcome = 'failed'");
    await w.db.run("UPDATE dist_connector_objects SET terminal = 1");
    w.fake.requests.length = 0;
    await at(NOW + REDRIVE_WINDOW_SECONDS + 1);
    expect(bavReads()).toBe(0);
    expect(await eventOutcomes(w)).toEqual(["failed"]);
  });

  it("re-driving another app's Background Asset stores and writes nothing", async () => {
    const w = await ascWorld();
    w.fake.fail429(10);
    await deliver(w, webhookFixture("BACKGROUND_ASSET_VERSION_STATE_UPDATED"));
    w.fake.fail429(0);
    const asset = w.fake.get("backgroundAssets", "ba-levels");
    w.fake.put({
      ...asset,
      relationships: { app: { data: { type: "apps", id: "9999999999" } } },
    });
    const before = (await audits(w.db)).length;
    await poll(w);
    expect(await objectState(w, "bav-1")).toBeNull();
    expect(await eventOutcomes(w)).toEqual(["ignored"]);
    // The poll's own steps write the app's versions and builds; nothing from the asset.
    expect(
      (await audits(w.db))
        .slice(before)
        .some((a) => a.summary.includes("bav-1")),
    ).toBe(false);
  });

  it("a 429 backs off and the tick still completes", async () => {
    const w = await ascWorld();
    w.fake.fail429(1);
    const report = await poll(w);
    expect(report.failures).toEqual({});
    expect(w.fake.requests[0]!.path).toBe(w.fake.requests[1]!.path);
    expect((await availability(w.db)).length).toBe(4);
  });

  it("a store that keeps refusing fails that product's tick, records the status on the credential, and is thrown by the cron", async () => {
    const w = await ascWorld();
    w.fake.fail429(100);
    const report = await poll(w);
    expect(Object.keys(report.failures)).toEqual([`poll:${SLUG}:distribution`]);
    expect(report.failures[`poll:${SLUG}:distribution`]).toContain("HTTP 429");
    const cred = (await listOutletCredentials(w.db, SLUG)).find(
      (c) => c.id === "asc",
    )!;
    expect(cred.lastError).toContain("HTTP 429");
    await expect(
      withFetch(w, () => handleScheduled(w.env, w.db, CONNECTOR_POLL_CRON)),
    ).rejects.toThrow(/connector poll: 1 step\(s\) failed/);
  });

  it("slows down as the hourly remainder drops, from the last X-Rate-Limit seen", async () => {
    const w = await ascWorld();
    w.fake.rate = { limit: 3500, remaining: 400 }; // < 20 %
    await poll(w); // full: nothing known yet; learns the remainder
    w.fake.requests.length = 0;
    await poll(w);
    expect(w.fake.requests.map((r) => r.path)).toEqual([
      "/v1/apps/1234567890/appStoreVersions",
    ]);
    w.fake.rate = { limit: 3500, remaining: 100 }; // < 5 %
    await poll(w);
    w.fake.requests.length = 0;
    const report = await poll(w);
    expect(w.fake.requests).toEqual([]);
    expect(JSON.stringify(report.results)).toContain("rate-budget");
  });
});

describe("the poll skips a product that is not set up", () => {
  it("without an asc-api-key credential: no call, no open", async () => {
    const w = await ascWorld({ apiKey: false });
    const report = await poll(w);
    expect(report.failures).toEqual({});
    expect(w.fake.requests).toEqual([]);
    expect(JSON.stringify(report.results)).toContain("not-configured");
    expect(
      (await audits(w.db)).filter((a) => a.action === "outlet_credential.use"),
    ).toEqual([]);
  });

  it("with Distribution disabled: the service's hook never runs", async () => {
    const w = await ascWorld();
    await setServices(
      w.db,
      SLUG,
      serializeServices({
        services: {
          license: { enabled: true },
          config: { enabled: true },
          release: { enabled: true },
          distribution: { enabled: false },
          update: { enabled: false },
          identity: { enabled: false },
          sync: { enabled: false },
        },
      }),
      "manifest",
      NOW,
    );
    const report = await poll(w);
    expect(w.fake.requests).toEqual([]);
    // Distribution's poll never ran (F-22: only Release's native-upload sweep did).
    expect(report.results[SLUG]).not.toHaveProperty("distribution");
  });
});

describe("the cron dispatch", () => {
  it("wrangler.toml declares exactly the maintenance and connector crons", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const toml = readFileSync(join(here, "..", "wrangler.toml"), "utf8");
    const crons = /^\[triggers\]\s*\ncrons\s*=\s*(\[[^\]]*\])/m.exec(toml)?.[1];
    expect(JSON.parse(crons!)).toEqual([MAINTENANCE_CRON, CONNECTOR_POLL_CRON]);
  });

  it("the connector cron polls and does not run maintenance", async () => {
    const w = await ascWorld();
    const report = await withFetch(w, () =>
      handleScheduled(w.env, w.db, CONNECTOR_POLL_CRON),
    );
    expect(w.fake.requests.length).toBeGreaterThan(0);
    expect(report.counts.indexes).toBeUndefined();
    // Distribution's poll ran (the store requests above) and Release's native-upload sweep
    // (F-22) beside it: one result per service with a `scheduled` hook.
    expect(report.counts[`poll:${SLUG}`]).toBe(2);
  });

  it("the maintenance cron (and no cron at all) runs maintenance and polls nothing", async () => {
    const w = await ascWorld();
    for (const cron of [MAINTENANCE_CRON, undefined, "0 0 * * *"]) {
      const report = await withFetch(w, () =>
        handleScheduled(w.env, w.db, cron),
      );
      expect(report.counts.indexes, String(cron)).toBe(0);
    }
    expect(w.fake.requests).toEqual([]);
  });
});
