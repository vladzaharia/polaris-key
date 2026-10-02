/**
 * P5-03 — the Google Play controls through the real admin API, against the fake Google. Each
 * control is one edit (insert → tracks.get → tracks.patch → commit with
 * changesInReviewBehavior=ERROR_IF_IN_REVIEW), one audit row, then a re-read through a fresh
 * edit. Priority is refused once a release has started rolling out; halting a completed release
 * asks for confirmation; Google's refusals are relayed as `store_refused` without a body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admin,
  audits,
  availability,
  playWorld,
  poll,
  rollouts,
  NOW,
  SLUG,
  type PlayWorld,
} from "./playWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const CONTROL = "/distribution/connectors/play";

function editCalls(w: PlayWorld, from = 0): string[] {
  return w.fake.requests
    .slice(from)
    .filter((r) => r.host === "androidpublisher.googleapis.com")
    .map(
      (r) =>
        `${r.method} ${r.path.replace(/edits\/\d+/, "edits/<id>")}${
          r.query.changesInReviewBehavior
            ? `?changesInReviewBehavior=${r.query.changesInReviewBehavior}`
            : ""
        }`,
    );
}

const ONE_EDIT_CONTROL = [
  "POST edits",
  "GET edits/<id>/tracks/production",
  "PATCH edits/<id>/tracks/production",
  "POST edits/<id>:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW",
  // the re-read
  "POST edits",
  "GET edits/<id>/tracks",
  "DELETE edits/<id>",
];

async function controlAudits(w: PlayWorld) {
  return (await audits(w.db)).filter((a) =>
    a.action.startsWith("distribution.play."),
  );
}

function patchBody(w: PlayWorld) {
  return w.fake.requests.find((r) => r.method === "PATCH")!.body as {
    track: string;
    releases: Array<Record<string, unknown>>;
  };
}

describe("rollout controls", () => {
  it("rollout/fraction sends the documented PATCH and commit, audits once and re-reads", async () => {
    const w = await playWorld();
    await poll(w);
    const from = w.fake.requests.length;
    const res = await admin(w, "POST", `${CONTROL}/rollout/fraction`, {
      track: "production",
      versionCode: "111",
      userFraction: 0.2,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(editCalls(w, from)).toEqual(ONE_EDIT_CONTROL);
    expect(patchBody(w)).toEqual({
      track: "production",
      releases: [
        {
          name: "1.1.0",
          versionCodes: ["110", "111"],
          status: "inProgress",
          userFraction: 0.2,
          inAppUpdatePriority: 2,
          releaseNotes: [
            { language: "en-US", text: "Faster startup, fewer crashes." },
          ],
        },
        {
          name: "1.0.0",
          versionCodes: ["100"],
          status: "completed",
          releaseNotes: [{ language: "en-US", text: "First release." }],
        },
      ],
    });
    expect(await controlAudits(w)).toEqual([
      {
        action: "distribution.play.fraction",
        actor_sub: "u1",
        target_id: "production:110,111",
        summary:
          "Set the fraction of the Google Play release 1.1.0 (versionCodes 110, 111) on track production to 20.00%",
      },
    ]);
    // The re-read is what the mirror shows.
    expect(body.rollouts).toEqual([
      expect.objectContaining({
        channel: "stable",
        rolloutBp: 2000,
        state: "active",
        mirrored: true,
      }),
    ]);
    expect(w.fake.openEdits()).toEqual([]);
  });

  it("halt, resume and complete each send their PATCH, audit once and re-read", async () => {
    const w = await playWorld();
    await poll(w);

    let res = await admin(w, "POST", `${CONTROL}/rollout/halt`, {
      track: "production",
      versionCode: 110,
    });
    expect(res.status).toBe(200);
    expect(patchBody(w).releases[0]).toMatchObject({
      status: "halted",
      userFraction: 0.05,
    });
    expect(
      (await rollouts(w.db)).find((r) => r.channel === "stable"),
    ).toMatchObject({
      state: "halted",
      rollout_bp: 500,
    });
    expect(
      (await availability(w.db)).find((r) => r.build_id === "android-arm64")!
        .state,
    ).toBe("live"); // still live on the beta track, which completed it

    w.fake.requests.length = 0;
    res = await admin(w, "POST", `${CONTROL}/rollout/resume`, {
      track: "production",
      releaseId: "v1.1.0",
    });
    expect(res.status).toBe(200);
    expect(editCalls(w)).toEqual(ONE_EDIT_CONTROL);
    expect(patchBody(w).releases[0]).toMatchObject({
      status: "inProgress",
      userFraction: 0.05,
    });
    expect(
      (await rollouts(w.db)).find((r) => r.channel === "stable"),
    ).toMatchObject({
      state: "active",
    });

    w.fake.requests.length = 0;
    res = await admin(w, "POST", `${CONTROL}/rollout/complete`, {
      track: "production",
      versionCode: "111",
    });
    expect(res.status).toBe(200);
    const completed = patchBody(w).releases;
    // The completed release replaces the previous one; the fraction goes.
    expect(completed).toEqual([
      {
        name: "1.1.0",
        versionCodes: ["110", "111"],
        status: "completed",
        inAppUpdatePriority: 2,
        releaseNotes: [
          { language: "en-US", text: "Faster startup, fewer crashes." },
        ],
      },
    ]);
    expect(
      (await rollouts(w.db)).find((r) => r.channel === "stable"),
    ).toMatchObject({
      state: "complete",
      rollout_bp: 10000,
    });
    expect(
      (await availability(w.db)).find((r) => r.build_id === "android")!.state,
    ).toBe("removed");
    expect((await controlAudits(w)).map((a) => a.action)).toEqual([
      "distribution.play.halt",
      "distribution.play.resume",
      "distribution.play.complete",
    ]);
  });

  it("halting a completed release asks for confirmation, then rolls back", async () => {
    const w = await playWorld();
    await poll(w);
    w.fake.requests.length = 0;
    const refused = await admin(w, "POST", `${CONTROL}/rollout/halt`, {
      track: "production",
      versionCode: "100",
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: "bad_request", reason: "confirmation_required" },
    });
    // The edit was opened to read the track and deleted; nothing was patched or committed.
    expect(editCalls(w)).toEqual([
      "POST edits",
      "GET edits/<id>/tracks/production",
      "DELETE edits/<id>",
    ]);
    expect(await controlAudits(w)).toEqual([]);

    const ok = await admin(w, "POST", `${CONTROL}/rollout/halt`, {
      track: "production",
      versionCode: "100",
      confirmRollback: true,
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as Record<string, unknown>).toMatchObject({
      rollback: true,
    });
    const [audit] = await controlAudits(w);
    expect(audit!.summary).toContain(
      "Play rolls the track back to the previously completed release",
    );
  });

  it("refuses an invalid transition before sending anything but the read", async () => {
    const w = await playWorld();
    const res = await admin(w, "POST", `${CONTROL}/rollout/resume`, {
      track: "production",
      versionCode: "111",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { reason: "invalid_transition" },
    });
    expect(w.fake.requests.some((r) => r.method === "PATCH")).toBe(false);
    expect(w.fake.openEdits()).toEqual([]);
  });

  it("relays a commit Google refuses (in review) as store_refused and deletes the edit", async () => {
    const w = await playWorld();
    w.fake.inReview = true;
    const res = await admin(w, "POST", `${CONTROL}/rollout/fraction`, {
      track: "production",
      versionCode: "111",
      userFraction: 0.1,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: {
        reason: "store_refused",
        message: "Google Play POST edits.commit: HTTP 400",
      },
    });
    expect(editCalls(w).at(-1)).toBe("DELETE edits/<id>");
    expect(w.fake.openEdits()).toEqual([]);
    expect(await controlAudits(w)).toEqual([]);
    expect(w.fake.track("production")[0]).toMatchObject({ userFraction: 0.05 });
  });

  it("validates the body", async () => {
    const w = await playWorld();
    for (const body of [
      { versionCode: "111", userFraction: 0.1 },
      { track: "production", userFraction: 0.1 },
      {
        track: "production",
        versionCode: "111",
        releaseId: "v1.1.0",
        userFraction: 0.1,
      },
      { track: "production", versionCode: "111", userFraction: 1 },
      { track: "production", versionCode: "111", userFraction: 0 },
      { track: "../edits", versionCode: "111", userFraction: 0.1 },
    ]) {
      const res = await admin(w, "POST", `${CONTROL}/rollout/fraction`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(w.fake.requests).toEqual([]);
  });

  it("answers not_configured without a credential", async () => {
    const w = await playWorld({ credential: false });
    const res = await admin(w, "POST", `${CONTROL}/rollout/halt`, {
      track: "production",
      versionCode: "111",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { reason: "not_configured" },
    });
  });
});

describe("in-app update priority", () => {
  const draftTrack = (w: PlayWorld, extra: Record<string, unknown> = {}) =>
    w.fake.setTrack("production", [
      {
        name: "1.1.0",
        versionCodes: ["110", "111"],
        status: "draft",
        ...extra,
      },
      { name: "1.0.0", versionCodes: ["100"], status: "completed" },
    ]);

  it("is refused on a release already rolling out", async () => {
    const w = await playWorld();
    const res = await admin(w, "POST", `${CONTROL}/priority`, {
      track: "production",
      versionCode: "111",
      priority: 5,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { reason: "priority_locked" },
    });
    expect(w.fake.requests.some((r) => r.method === "PATCH")).toBe(false);
    expect(await controlAudits(w)).toEqual([]);
  });

  it("is set on a draft, with one PATCH, one commit and one audit row", async () => {
    const w = await playWorld();
    draftTrack(w);
    const res = await admin(w, "POST", `${CONTROL}/priority`, {
      track: "production",
      versionCode: "111",
      priority: 3,
    });
    expect(res.status).toBe(200);
    expect(patchBody(w).releases[0]).toEqual({
      name: "1.1.0",
      versionCodes: ["110", "111"],
      status: "draft",
      inAppUpdatePriority: 3,
    });
    expect(w.fake.track("production")[0]).toMatchObject({
      inAppUpdatePriority: 3,
    });
    expect((await controlAudits(w)).map((a) => a.action)).toEqual([
      "distribution.play.priority",
    ]);
  });

  it("starting a draft's rollout applies the policy: critical → 5", async () => {
    const w = await playWorld();
    draftTrack(w);
    await w.db.run(
      `INSERT INTO release_channel_policy
         (product, deliverable_id, channel, critical, created_at, modified_at)
       VALUES (?, 'app', 'stable', 1, ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    const res = await admin(w, "POST", `${CONTROL}/rollout/fraction`, {
      track: "production",
      versionCode: "111",
      userFraction: 0.05,
    });
    expect(res.status).toBe(200);
    expect(patchBody(w).releases[0]).toMatchObject({
      status: "inProgress",
      userFraction: 0.05,
      inAppUpdatePriority: 5,
    });
    expect((await controlAudits(w))[0]!.summary).toContain(
      "with inAppUpdatePriority 5 (critical)",
    );
  });

  it("a raised floor → 4; otherwise the operator's default; an explicit priority is kept", async () => {
    const w = await playWorld();
    draftTrack(w);
    // The track serves 1.0.0; the stable floor is 1.1.0 → the floor was raised past it.
    await w.db.run(
      `INSERT INTO release_channel_policy
         (product, deliverable_id, channel, min_supported, created_at, modified_at)
       VALUES (?, 'app', 'stable', '1.1.0', ?, ?)`,
      SLUG,
      NOW,
      NOW,
    );
    await admin(w, "POST", `${CONTROL}/rollout/fraction`, {
      track: "production",
      versionCode: "111",
      userFraction: 0.05,
    });
    expect(patchBody(w).releases[0]).toMatchObject({ inAppUpdatePriority: 4 });

    const w2 = await playWorld();
    draftTrack(w2);
    const saved = await admin(w2, "POST", `${CONTROL}/settings`, {
      priority: { default: 1 },
    });
    expect(saved.status).toBe(200);
    await admin(w2, "POST", `${CONTROL}/rollout/fraction`, {
      track: "production",
      versionCode: "111",
      userFraction: 0.05,
    });
    expect(patchBody(w2).releases[0]).toMatchObject({ inAppUpdatePriority: 1 });

    const w3 = await playWorld();
    draftTrack(w3, { inAppUpdatePriority: 2 });
    await admin(w3, "POST", `${CONTROL}/rollout/fraction`, {
      track: "production",
      versionCode: "111",
      userFraction: 0.05,
    });
    expect(patchBody(w3).releases[0]).toMatchObject({ inAppUpdatePriority: 2 });
  }, 20_000);
});

describe("settings and status", () => {
  it("settings are validated, stored, audited, and off by default", async () => {
    const w = await playWorld();
    let res = await admin(w, "GET", `${CONTROL}`);
    let status = (await res.json()) as {
      configured: boolean;
      settings: { vitals: { enabled: boolean }; priority: { default: number } };
      setup: { packageName: string; credential: string };
    };
    expect(status.configured).toBe(true);
    expect(status.setup).toMatchObject({
      packageName: "gg.acme.djdl",
      credential: "play",
    });
    expect(status.settings.vitals.enabled).toBe(false);
    expect(status.settings.priority.default).toBe(0);
    // No value of the credential anywhere in the page.
    expect(JSON.stringify(status)).not.toMatch(
      /PRIVATE KEY|client_email|iam\.gserviceaccount/,
    );

    for (const bad of [
      { vitals: { enabled: "yes" } },
      { vitals: { crashRateThreshold: 2 } },
      { vitals: { windowHours: 0 } },
      { priority: { default: 6 } },
      { autoComplete: true },
    ]) {
      res = await admin(w, "POST", `${CONTROL}/settings`, bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    res = await admin(w, "POST", `${CONTROL}/settings`, {
      vitals: { enabled: true, minDistinctUsers: 500 },
    });
    expect(res.status).toBe(200);
    res = await admin(w, "GET", `${CONTROL}`);
    status = (await res.json()) as typeof status;
    expect(status.settings.vitals).toMatchObject({
      enabled: true,
      minDistinctUsers: 500,
      crashRateThreshold: 0.02,
    });
    expect((await controlAudits(w)).map((a) => a.action)).toEqual([
      "distribution.play.settings",
    ]);
    expect(w.fake.requests).toEqual([]);
  }, 20_000);

  it("the connector page lists tracks, the unmapped ones (the internal track among them) and the controls", async () => {
    const w = await playWorld();
    await poll(w);
    const res = await admin(w, "GET", `/distribution/connectors`);
    const { connectors } = (await res.json()) as {
      connectors: Array<Record<string, unknown>>;
    };
    const play = connectors.find((c) => c.kind === "play")!;
    expect(play).toMatchObject({
      label: "Google Play",
      outletKinds: ["play", "play-testing"],
      configured: true,
      unmapped: ["alpha", "qa"],
      controls: [
        "rollout/fraction",
        "rollout/halt",
        "rollout/resume",
        "rollout/complete",
        "priority",
        "settings",
      ],
    });
    expect((play.setup as { missingTracks: string[] }).missingTracks).toEqual(
      [],
    );
    expect((play.tracks as unknown[]).length).toBe(4);
  });
});
