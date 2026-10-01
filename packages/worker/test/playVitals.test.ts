/**
 * P5-03 — the opt-in vitals auto-halt from the Play Developer Reporting API, against the fake
 * Google. Off: no Reporting API call, no Reporting token. On: a rate over the threshold on enough
 * users halts once, through the one control path, and audits once — even while Play has not
 * propagated the halt yet — and a reading under the threshold or the sample halts nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fromDateTime,
  hourlyFreshness,
  releaseReading,
  tallyRows,
} from "../src/services/distribution/connectors/play/vitals.js";
import {
  admin,
  audits,
  playWorld,
  poll,
  rollouts,
  NOW,
  type PlayWorld,
} from "./playWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const CONTROL = "/distribution/connectors/play";

const reportingCalls = (w: PlayWorld) =>
  w.fake.requests
    .filter((r) => r.host === "playdeveloperreporting.googleapis.com")
    .map((r) => `${r.method} ${r.path}`);

async function haltAudits(w: PlayWorld) {
  return (await audits(w.db)).filter(
    (a) => a.action === "distribution.play.halt",
  );
}

async function enable(w: PlayWorld, vitals: Record<string, unknown> = {}) {
  const res = await admin(w, "POST", `${CONTROL}/settings`, {
    vitals: { enabled: true, ...vitals },
  });
  expect(res.status).toBe(200);
}

describe("vitals auto-halt", () => {
  it("off (the default): no Reporting API call and no Reporting token", async () => {
    const w = await playWorld();
    await poll(w);
    await poll(w, NOW + 900);
    expect(reportingCalls(w)).toEqual([]);
    expect(
      w.fake.tokenRequests.some((t) =>
        t.scope.includes("playdeveloperreporting"),
      ),
    ).toBe(false);
    expect(await haltAudits(w)).toEqual([]);
  });

  it("on: a rate over the threshold with enough sample halts once and audits once", async () => {
    const w = await playWorld();
    await enable(w);
    await poll(w);
    expect(reportingCalls(w)).toEqual([
      "GET crashRateMetricSet",
      "POST crashRateMetricSet:query",
      "GET anrRateMetricSet",
      "POST anrRateMetricSet:query",
    ]);
    // The documented query: HOURLY, sliced by versionCode, the user-perceived rate and the sample.
    const query = w.fake.requests.find(
      (r) => r.path === "crashRateMetricSet:query",
    )!.body as Record<string, unknown>;
    expect(query).toMatchObject({
      timelineSpec: {
        aggregationPeriod: "HOURLY",
        startTime: {
          year: 2026,
          month: 8,
          day: 26,
          hours: 21,
          timeZone: { id: "UTC" },
        },
        endTime: {
          year: 2026,
          month: 8,
          day: 27,
          hours: 21,
          timeZone: { id: "UTC" },
        },
      },
      dimensions: ["versionCode"],
      metrics: ["userPerceivedCrashRate", "distinctUsers"],
    });
    // The Reporting token is its own scope, minted under its own audited use.
    expect(w.fake.tokenRequests.map((t) => t.scope)).toEqual([
      "https://www.googleapis.com/auth/androidpublisher",
      "https://www.googleapis.com/auth/playdeveloperreporting",
    ]);
    expect(
      (await audits(w.db))
        .filter((a) => a.action === "outlet_credential.use")
        .map((a) => a.summary),
    ).toEqual(["play:poll: opened", "play:vitals: opened"]);

    // One halt: the production 1.1.0 release (codes 110 + 111: 2.89 % over 1600 user-hours).
    const halt = w.fake.requests.find((r) => r.method === "PATCH")!;
    expect(halt.path).toMatch(/^edits\/\d+\/tracks\/production$/);
    expect(
      (halt.body as { releases: Array<Record<string, unknown>> }).releases[0],
    ).toMatchObject({ versionCodes: ["110", "111"], status: "halted" });
    const audit = await haltAudits(w);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_sub: "connector:play-vitals",
      target_id: "production:110,111",
    });
    expect(audit[0]!.summary).toContain(
      "userPerceivedCrashRate 2.89% over 1600 user-hours > 2.00%",
    );
    expect(audit[0]!.summary).toContain("source: play-vitals");
    expect(
      (await rollouts(w.db)).find((r) => r.channel === "stable"),
    ).toMatchObject({ state: "halted" });

    // The next tick: halted already, nothing staged, no second halt or audit.
    await poll(w, NOW + 900);
    expect(w.fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(await haltAudits(w)).toHaveLength(1);
  });

  it("halts once even while Play has not propagated the halt (the re-read still says inProgress)", async () => {
    const w = await playWorld();
    await enable(w);
    w.fake.propagate = false;
    await poll(w);
    await poll(w, NOW + 900);
    await poll(w, NOW + 1800);
    expect(w.fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(await haltAudits(w)).toHaveLength(1);
    // The mirror shows what Play answers, not the request's intent.
    expect(
      (await rollouts(w.db)).find((r) => r.channel === "stable"),
    ).toMatchObject({ state: "active" });
  });

  it("under the threshold, or under the minimum sample, halts nothing", async () => {
    const w = await playWorld();
    await enable(w, { crashRateThreshold: 0.05 });
    await poll(w);
    expect(reportingCalls(w)).toHaveLength(4);
    expect(w.fake.requests.some((r) => r.method === "PATCH")).toBe(false);

    const w2 = await playWorld();
    await enable(w2, { minDistinctUsers: 5000 });
    await poll(w2);
    expect(w2.fake.requests.some((r) => r.method === "PATCH")).toBe(false);
    expect(await haltAudits(w2)).toEqual([]);
  });

  it("an ANR rate over its threshold trips on its own", async () => {
    const w = await playWorld();
    await enable(w, { crashRateThreshold: 0.5, anrRateThreshold: 0.001 });
    await poll(w);
    const [audit] = await haltAudits(w);
    expect(audit!.summary).toContain(
      "userPerceivedAnrRate 0.20% over 1500 user-hours > 0.10%",
    );
  });

  it("no staged rollout on a mapped track: no Reporting call at all", async () => {
    const w = await playWorld();
    await enable(w);
    w.fake.setTrack("production", [
      { name: "1.1.0", versionCodes: ["110", "111"], status: "completed" },
    ]);
    await poll(w);
    expect(reportingCalls(w)).toEqual([]);
  });

  it("a Reporting failure halts nothing and is the tick's error", async () => {
    const w = await playWorld();
    await enable(w);
    w.fake.reporting["crashRateMetricSet.get"] = {};
    await poll(w);
    // No hourly freshness for crashes: that set judges nothing; ANRs are under threshold.
    expect(w.fake.requests.some((r) => r.method === "PATCH")).toBe(false);
  });
});

describe("vitals helpers", () => {
  it("reads only UTC hourly freshness", () => {
    expect(
      fromDateTime({
        year: 2026,
        month: 8,
        day: 27,
        hours: 21,
        timeZone: { id: "UTC" },
      }),
    ).toBe(Date.UTC(2026, 7, 27, 21) / 1000);
    expect(
      fromDateTime({
        year: 2026,
        month: 8,
        day: 27,
        timeZone: { id: "America/Los_Angeles" },
      }),
    ).toBeNull();
    expect(
      hourlyFreshness({
        freshnessInfo: {
          freshnesses: [{ aggregationPeriod: "DAILY", latestEndTime: {} }],
        },
      }),
    ).toBeNull();
  });

  it("weights hourly rates by users across a release's version codes", () => {
    const tally = new Map();
    tallyRows(
      {
        rows: [
          {
            dimensions: [{ dimension: "versionCode", int64Value: "1" }],
            metrics: [
              { metric: "crashRate", decimalValue: { value: "0.1" } },
              { metric: "distinctUsers", decimalValue: { value: "100" } },
            ],
          },
          {
            dimensions: [{ dimension: "versionCode", int64Value: "2" }],
            metrics: [
              { metric: "crashRate", decimalValue: { value: "0" } },
              { metric: "distinctUsers", decimalValue: { value: "300" } },
            ],
          },
          {
            dimensions: [{ dimension: "versionCode", int64Value: "3" }],
            metrics: [
              { metric: "crashRate", decimalValue: { value: "0.9" } },
              { metric: "distinctUsers", decimalValue: { value: "300" } },
            ],
          },
        ],
      },
      "crashRate",
      new Set(["1", "2"]),
      tally,
    );
    expect(releaseReading(["1", "2"], tally)).toEqual({
      users: 400,
      rate: 0.025,
    });
    expect(releaseReading(["3"], tally)).toEqual({ users: 0, rate: null });
  });
});
