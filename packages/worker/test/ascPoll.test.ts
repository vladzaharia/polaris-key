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
        },
      }),
      "manifest",
      NOW,
    );
    const report = await poll(w);
    expect(w.fake.requests).toEqual([]);
    expect(report.results[SLUG]).toEqual({});
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
    expect(report.counts[`poll:${SLUG}`]).toBe(1);
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
