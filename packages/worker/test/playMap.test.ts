/**
 * P5-03 — the Google Play vocabulary (pure): parsing tracks.list, the status and fraction
 * mapping, the priority policy, control planning, and the client's fixed hosts and paths.
 */

import { describe, expect, it } from "vitest";
import {
  parseTrackList,
  planControl,
  policyPriority,
  releaseBp,
  rolloutReleaseOf,
  statusToAvailability,
  statusToRolloutState,
  userFractionToBp,
  type PlayRelease,
} from "../src/services/distribution/connectors/play/map.js";
import {
  ANDROID_PUBLISHER_ORIGIN,
  GoogleApiClient,
  PLAY_REPORTING_ORIGIN,
  PlayError,
} from "../src/services/distribution/connectors/play/client.js";
import {
  normalizePlaySettings,
  patchPlaySettings,
  DEFAULT_PLAY_SETTINGS,
} from "../src/services/distribution/connectors/play/policy.js";
import { playFixtures } from "./playWorld.js";

const rel = (o: Record<string, unknown>): PlayRelease =>
  parseTrackList({ tracks: [{ track: "t", releases: [o] }] })[0]!.releases[0]!;

describe("mapping", () => {
  it("maps all four status values onto rollout states and availability", () => {
    expect(
      (["inProgress", "halted", "completed", "draft"] as const).map((s) => [
        s,
        statusToRolloutState(s),
        statusToAvailability(s),
      ]),
    ).toEqual([
      ["inProgress", "active", "live"],
      ["halted", "halted", "approved"],
      ["completed", "complete", "live"],
      ["draft", null, "pending"],
    ]);
    // An unknown status is never served.
    expect(
      rel({ versionCodes: ["1"], status: "statusUnspecified" }).status,
    ).toBeNull();
    expect(statusToRolloutState(null)).toBeNull();
    expect(statusToAvailability(null)).toBeNull();
  });

  it("userFraction 0.05 → 500 bp; completed → 10000; a halted completed release → 10000", () => {
    expect(userFractionToBp(0.05)).toBe(500);
    expect(userFractionToBp(0.3333)).toBe(3333);
    expect(
      releaseBp(
        rel({ versionCodes: ["1"], status: "inProgress", userFraction: 0.05 }),
      ),
    ).toBe(500);
    expect(releaseBp(rel({ versionCodes: ["1"], status: "completed" }))).toBe(
      10000,
    );
    expect(releaseBp(rel({ versionCodes: ["1"], status: "halted" }))).toBe(
      10000,
    );
  });

  it("parses the recorded tracks.list, version codes as strings in Play's order", () => {
    const tracks = parseTrackList(
      playFixtures().publisher["edits.tracks.list"],
    );
    expect(tracks.map((t) => t.track)).toEqual([
      "production",
      "beta",
      "alpha",
      "qa",
    ]);
    const production = tracks[0]!;
    expect(production.releases[0]).toMatchObject({
      name: "1.1.0",
      versionCodes: ["110", "111"],
      status: "inProgress",
      userFraction: 0.05,
      inAppUpdatePriority: 2,
    });
    expect(rolloutReleaseOf(production)!.name).toBe("1.1.0");
    expect(rolloutReleaseOf(tracks[1]!)!.status).toBe("completed");
    expect(rolloutReleaseOf(tracks[2]!)).toBeNull();
    // Garbage is dropped, not trusted.
    expect(
      parseTrackList({
        tracks: [
          {
            track: "x",
            releases: [
              { versionCodes: ["0", "-1", "abc", 7], userFraction: 2 },
            ],
          },
          { releases: [] },
          "nope",
        ],
      }),
    ).toEqual([
      {
        track: "x",
        releases: [
          {
            name: null,
            versionCodes: ["7"],
            status: null,
            userFraction: null,
            inAppUpdatePriority: null,
            raw: { versionCodes: ["0", "-1", "abc", 7], userFraction: 2 },
          },
        ],
      },
    ]);
  });
});

describe("priority policy", () => {
  it("critical → 5, a raised floor → 4, otherwise the default", () => {
    const base = {
      minSupported: null,
      servedVersion: "1.0.0",
      defaultPriority: 1,
    };
    expect(policyPriority({ ...base, critical: true })).toEqual({
      priority: 5,
      reason: "critical",
    });
    expect(
      policyPriority({ ...base, critical: false, minSupported: "1.1.0" }),
    ).toEqual({ priority: 4, reason: "floor" });
    expect(
      policyPriority({ ...base, critical: false, minSupported: "1.0.0" }),
    ).toEqual({ priority: 1, reason: "default" });
    expect(
      policyPriority({ ...base, critical: false, defaultPriority: 0 }),
    ).toEqual({ priority: 0, reason: "default" });
  });
});

describe("control planning", () => {
  const releases = [
    rel({
      name: "b",
      versionCodes: ["2"],
      status: "inProgress",
      userFraction: 0.1,
      releaseNotes: [{ language: "en-US", text: "x" }],
    }),
    rel({ name: "a", versionCodes: ["1"], status: "completed" }),
  ];

  it("keeps every field but the ones it changes", () => {
    const plan = planControl({
      verb: "fraction",
      releases,
      target: 0,
      userFraction: 0.5,
    });
    expect(plan).toMatchObject({ ok: true, to: "inProgress" });
    expect(plan.ok && plan.releases).toEqual([
      {
        name: "b",
        versionCodes: ["2"],
        status: "inProgress",
        userFraction: 0.5,
        releaseNotes: [{ language: "en-US", text: "x" }],
      },
      { name: "a", versionCodes: ["1"], status: "completed" },
    ]);
  });

  it("complete drops the previously completed release; resume of a fractionless halt completes", () => {
    const done = planControl({ verb: "complete", releases, target: 0 });
    expect(done.ok && done.releases).toEqual([
      {
        name: "b",
        versionCodes: ["2"],
        status: "completed",
        releaseNotes: [{ language: "en-US", text: "x" }],
      },
    ]);
    const halted = [
      rel({ versionCodes: ["2"], status: "halted" }),
      releases[1]!,
    ];
    const resumed = planControl({
      verb: "resume",
      releases: halted,
      target: 0,
    });
    expect(resumed).toMatchObject({ ok: true, to: "completed" });
    expect(resumed.ok && resumed.releases).toHaveLength(1);
  });

  it("refuses what Play would refuse or what needs a decision", () => {
    expect(
      planControl({ verb: "priority", releases, target: 0, priority: 5 }),
    ).toMatchObject({
      ok: false,
      reason: "priority_locked",
    });
    expect(planControl({ verb: "halt", releases, target: 1 })).toMatchObject({
      ok: false,
      reason: "confirmation_required",
    });
    expect(
      planControl({ verb: "halt", releases, target: 1, confirmRollback: true }),
    ).toMatchObject({
      ok: true,
      rollback: true,
    });
    expect(
      planControl({ verb: "fraction", releases, target: 0, userFraction: 1 }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_body",
    });
    expect(
      planControl({ verb: "complete", releases, target: 1 }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_transition",
    });
    const halted = [
      rel({ versionCodes: ["2"], status: "halted", userFraction: 0.1 }),
    ];
    expect(
      planControl({
        verb: "fraction",
        releases: halted,
        target: 0,
        userFraction: 0.2,
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid_transition",
    });
    expect(
      planControl({ verb: "resume", releases: halted, target: 0 }),
    ).toMatchObject({
      ok: true,
      to: "inProgress",
    });
  });

  it("starting a draft sets the priority only when the draft has none", () => {
    const draft = [rel({ versionCodes: ["3"], status: "draft" })];
    const started = planControl({
      verb: "fraction",
      releases: draft,
      target: 0,
      userFraction: 0.05,
      priority: 4,
    });
    expect(started).toMatchObject({ ok: true, prioritySet: 4 });
    expect(started.ok && started.releases[0]).toEqual({
      versionCodes: ["3"],
      status: "inProgress",
      userFraction: 0.05,
      inAppUpdatePriority: 4,
    });
    const set = [
      rel({ versionCodes: ["3"], status: "draft", inAppUpdatePriority: 1 }),
    ];
    expect(
      planControl({
        verb: "fraction",
        releases: set,
        target: 0,
        userFraction: 0.05,
        priority: 4,
      }),
    ).toMatchObject({ ok: true, prioritySet: null });
  });
});

describe("the client", () => {
  const client = (origin = ANDROID_PUBLISHER_ORIGIN, pkg = "gg.acme.djdl") =>
    new GoogleApiClient({
      origin: origin as typeof ANDROID_PUBLISHER_ORIGIN,
      packageName: pkg,
      token: async () => "t",
      fetchImpl: async () => new Response("{}"),
    });

  it("builds paths below one app on one of two fixed hosts", () => {
    expect(
      client().url(["edits", "1", "tracks", "wear:beta test"]).toString(),
    ).toBe(
      "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/gg.acme.djdl/edits/1/tracks/wear%3Abeta%20test",
    );
    expect(
      client()
        .url(
          ["edits", "1"],
          { changesInReviewBehavior: "ERROR_IF_IN_REVIEW" },
          "commit",
        )
        .toString(),
    ).toBe(
      "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/gg.acme.djdl/edits/1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW",
    );
    expect(
      client(PLAY_REPORTING_ORIGIN)
        .url(["crashRateMetricSet"], undefined, "query")
        .toString(),
    ).toBe(
      "https://playdeveloperreporting.googleapis.com/v1beta1/apps/gg.acme.djdl/crashRateMetricSet:query",
    );
    // A segment cannot climb out or become a custom method; a hostile package or host is refused.
    expect(() => client().url(["edits", ".."])).toThrow();
    expect(client().url(["edits", "x:commit"]).pathname).toMatch(
      /edits\/x%3Acommit$/,
    );
    expect(() => client(ANDROID_PUBLISHER_ORIGIN, "gg.acme/../x")).toThrow();
    expect(() => client("https://evil.example.com")).toThrow();
  });

  it("errors carry a status line only", async () => {
    const c = new GoogleApiClient({
      origin: ANDROID_PUBLISHER_ORIGIN,
      packageName: "gg.acme.djdl",
      token: async () => "t",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "secret detail" } }), {
          status: 403,
        }),
    });
    const e = await c
      .request("GET", ["edits"], "edits.list")
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PlayError);
    expect((e as Error).message).toBe("Google Play GET edits.list: HTTP 403");
    // No token: a 401 without a request.
    let sent = 0;
    const none = new GoogleApiClient({
      origin: ANDROID_PUBLISHER_ORIGIN,
      packageName: "gg.acme.djdl",
      token: async () => null,
      fetchImpl: async () => {
        sent++;
        return new Response("{}");
      },
    });
    await expect(none.request("GET", ["edits"], "x")).rejects.toThrow(
      "HTTP 401",
    );
    expect(sent).toBe(0);
  });
});

describe("settings", () => {
  it("normalise to safe defaults and refuse unknown or out-of-range fields", () => {
    expect(normalizePlaySettings(null)).toEqual(DEFAULT_PLAY_SETTINGS);
    expect(
      normalizePlaySettings({
        vitals: { enabled: "true", crashRateThreshold: 7 },
        priority: { default: 9 },
      }),
    ).toEqual(DEFAULT_PLAY_SETTINGS);
    expect(
      patchPlaySettings(DEFAULT_PLAY_SETTINGS, { vitals: { metric: "all" } }),
    ).toMatchObject({
      ok: true,
      settings: { vitals: { metric: "all", enabled: false } },
    });
    expect(
      patchPlaySettings(DEFAULT_PLAY_SETTINGS, { vitals: { treshold: 1 } }),
    ).toMatchObject({
      ok: false,
      field: "vitals.treshold",
    });
  });
});
