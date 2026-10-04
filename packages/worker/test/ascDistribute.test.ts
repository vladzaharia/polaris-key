/**
 * A-17d — the App Store Connect Distribute API through the real admin API, against the fake
 * server (`ascDistributeFake.ts`). Nothing here reaches Apple.
 *
 * Each write: the Idempotency-Key is required; the objects a request names are re-read and must be
 * the pinned app's before anything is sent (a request naming another app's object sends no write
 * at all); the documented request is sent once through the gated client; a repeat is answered from
 * the ledger (same key) or from Apple's natural key (new key) without a second write; one
 * `distribution.asc.<op>` audit row per write. Submit for review is TYPED: the app's name as Apple
 * reports it, compared server-side, before any write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConnectorPolls } from "../src/scheduled.js";
import { DistributeFake } from "./ascDistributeFake.js";
import {
  admin,
  ascWorld,
  audits,
  withFetch,
  APPLE_ID,
  NOW,
  type AscWorld,
} from "./ascWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const BASE = "/distribution/connectors/asc";
const OTHER_APP = "9999999999";

interface World extends AscWorld {
  fake: DistributeFake;
}

async function world(opts: { pin?: string | null } = {}): Promise<World> {
  const fake = new DistributeFake();
  const w = (await ascWorld({ ...opts, fake })) as World;
  await withFetch(w, () => runConnectorPolls(w.env, w.db, NOW));
  w.fake.requests.length = 0;
  return w;
}

let keyN = 0;
const newKey = () =>
  `00000000-0000-4000-8000-${String(++keyN).padStart(12, "0")}`;

async function post(
  w: World,
  path: string,
  body: Record<string, unknown>,
  key: string | null = newKey(),
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await admin(
    w,
    "POST",
    `${BASE}/${path}`,
    body,
    key === null ? {} : { "Idempotency-Key": key },
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function get(
  w: World,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await admin(w, "GET", `${BASE}/${path}`);
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

const writes = (w: World) =>
  w.fake
    .writes()
    .map((r) => ({ method: r.method, path: r.path, body: r.body }));

async function distAudits(w: World) {
  return (await audits(w.db)).filter((a) =>
    a.action.startsWith("distribution.asc."),
  );
}

/** A version of the pinned app in PREPARE_FOR_SUBMISSION, with the VALID build attached. */
function preparedVersion(w: World, opts: { build?: boolean } = {}): void {
  w.fake.put({
    type: "appStoreVersions",
    id: "asv-120",
    attributes: {
      platform: "IOS",
      versionString: "1.2.0",
      appStoreState: "PREPARE_FOR_SUBMISSION",
      appVersionState: "PREPARE_FOR_SUBMISSION",
      releaseType: "AFTER_APPROVAL",
      createdDate: "2026-10-01T10:00:00.000Z",
    },
    relationships: {
      app: { data: { type: "apps", id: APPLE_ID } },
      build: {
        data:
          opts.build === false ? null : { type: "builds", id: "bld-110-42" },
      },
      appStoreVersionPhasedRelease: { data: null },
    },
  });
}

describe("A-17d: every Distribute write needs an Idempotency-Key", () => {
  it("refuses without one, before any request to Apple", async () => {
    const w = await world();
    const r = await post(
      w,
      "distribute/version",
      { platform: "IOS", versionString: "1.2.0" },
      null,
    );
    expect(r.status).toBe(422);
    expect(r.json.reason).toBe("idempotency_key_required");
    expect(w.fake.requests).toEqual([]);
  });

  it("refuses on an unpinned key, before any request to Apple", async () => {
    const w = await world({ pin: null });
    const r = await post(w, "distribute/version", {
      platform: "IOS",
      versionString: "1.2.0",
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("credential_pin_missing");
    expect(w.fake.requests).toEqual([]);
  });

  it("answers a reused key with a different body 409 idempotency_conflict, sending nothing", async () => {
    const w = await world();
    const key = newKey();
    const first = await post(
      w,
      "distribute/beta-localization",
      { buildId: "bld-110-42", locale: "en-US", whatsNew: "Bug fixes" },
      key,
    );
    expect(first.status).toBe(200);
    w.fake.requests.length = 0;
    const second = await post(
      w,
      "distribute/beta-localization",
      { buildId: "bld-110-42", locale: "en-US", whatsNew: "Other notes" },
      key,
    );
    expect(second.status).toBe(409);
    expect(second.json.reason).toBe("idempotency_conflict");
    expect(writes(w)).toEqual([]);
  });
});

describe("builds and export compliance", () => {
  it("lists the app's unexpired builds with the upload's state, warnings and the linked release", async () => {
    const w = await world();
    w.fake.put({
      ...w.fake.get("buildUploads", "bup-110-42"),
      attributes: {
        cfBundleShortVersionString: "1.1.0",
        cfBundleVersion: "42",
        platform: "IOS",
        uploadedDate: "2026-09-19T08:55:00.000Z",
        state: {
          state: "COMPLETE",
          warnings: [{ code: "90725", description: "SDK version warning" }],
          errors: [],
        },
      },
    });
    w.fake.put({
      ...w.fake.get("builds", "bld-110-42"),
      relationships: {
        ...w.fake.get("builds", "bld-110-42").relationships,
        buildUpload: { data: { type: "buildUploads", id: "bup-110-42" } },
      },
    });
    const r = await get(w, "distribute/builds");
    expect(r.status).toBe(200);
    const req = w.fake.requests.find((q) => q.path === "/v1/builds")!;
    expect(req.query).toMatchObject({
      "filter[app]": APPLE_ID,
      "filter[expired]": "false",
      sort: "-uploadedDate",
    });
    const list = r.json.builds as Record<string, unknown>[];
    expect(list.map((b) => b.id)).toEqual(["bld-110-42", "bld-100-30"]);
    expect(list[0]).toMatchObject({
      buildNumber: "42",
      version: "1.1.0",
      platform: "IOS",
      processingState: "VALID",
      usesNonExemptEncryption: false,
      exportComplianceNeeded: false,
      upload: {
        state: "COMPLETE",
        warnings: [{ code: "90725", description: "SDK version warning" }],
        errors: [],
      },
    });
    expect(writes(w)).toEqual([]);
  });

  it("PATCHes usesNonExemptEncryption once; the same key replays and a new key finds it done", async () => {
    const w = await world();
    w.fake.set("builds", "bld-110-42", { usesNonExemptEncryption: null });
    const key = newKey();
    const body = { buildId: "bld-110-42", usesNonExemptEncryption: false };
    const r = await post(w, "distribute/export-compliance", body, key);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ outcome: "written", buildId: "bld-110-42" });
    expect(writes(w)).toEqual([
      {
        method: "PATCH",
        path: "/v1/builds/bld-110-42",
        body: {
          data: {
            type: "builds",
            id: "bld-110-42",
            attributes: { usesNonExemptEncryption: false },
          },
        },
      },
    ]);
    expect((await distAudits(w)).map((a) => [a.action, a.target_id])).toEqual([
      ["distribution.asc.build.export_compliance", "bld-110-42"],
    ]);
    w.fake.requests.length = 0;
    expect(
      (await post(w, "distribute/export-compliance", body, key)).json.outcome,
    ).toBe("replayed");
    expect(
      (await post(w, "distribute/export-compliance", body)).json.outcome,
    ).toBe("existing");
    expect(writes(w)).toEqual([]);
    expect(await distAudits(w)).toHaveLength(1);
    // The ledger keeps Apple's before and after, projected.
    const row = await w.db.first<{
      before_json: string;
      after_json: string;
      state: string;
    }>(
      "SELECT before_json, after_json, state FROM asc_operations WHERE op = 'build.export_compliance' AND state = 'done' ORDER BY created_at LIMIT 1",
    );
    expect(
      JSON.parse(row!.before_json).attributes.usesNonExemptEncryption,
    ).toBeNull();
    expect(JSON.parse(row!.after_json).attributes.usesNonExemptEncryption).toBe(
      false,
    );
  });

  it("refuses to change an answered build", async () => {
    const w = await world();
    const r = await post(w, "distribute/export-compliance", {
      buildId: "bld-110-42",
      usesNonExemptEncryption: true,
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("already_answered");
    expect(writes(w)).toEqual([]);
  });

  it("refuses another app's build, sending no write", async () => {
    const w = await world();
    w.fake.put({
      type: "builds",
      id: "bld-other",
      attributes: {
        version: "1",
        processingState: "VALID",
        usesNonExemptEncryption: null,
      },
      relationships: { app: { data: { type: "apps", id: OTHER_APP } } },
    });
    for (const [path, body] of [
      [
        "distribute/export-compliance",
        { buildId: "bld-other", usesNonExemptEncryption: false },
      ],
      [
        "distribute/beta-localization",
        { buildId: "bld-other", locale: "en-US", whatsNew: "x" },
      ],
      ["distribute/testflight/beta-review", { buildId: "bld-other" }],
      [
        "distribute/testflight/groups",
        { buildId: "bld-other", betaGroupIds: ["bg-public"] },
      ],
    ] as const) {
      const r = await post(w, path, body);
      expect(r.status, path).toBe(404);
      expect(r.json.reason, path).toBe("unknown_build");
    }
    expect(writes(w)).toEqual([]);
    expect(await distAudits(w)).toEqual([]);
  });
});

describe("TestFlight", () => {
  it("creates What to Test, then PATCHes it when the notes change", async () => {
    const w = await world();
    const a = await post(w, "distribute/beta-localization", {
      buildId: "bld-110-42",
      locale: "en-US",
      whatsNew: "Try the new level",
    });
    expect(a.status).toBe(200);
    const b = await post(w, "distribute/beta-localization", {
      buildId: "bld-110-42",
      locale: "en-US",
      whatsNew: "Try the new boss",
    });
    expect(b.status).toBe(200);
    const id = a.json.betaBuildLocalizationId as string;
    expect(writes(w)).toEqual([
      {
        method: "POST",
        path: "/v1/betaBuildLocalizations",
        body: {
          data: {
            type: "betaBuildLocalizations",
            attributes: { locale: "en-US", whatsNew: "Try the new level" },
            relationships: {
              build: { data: { type: "builds", id: "bld-110-42" } },
            },
          },
        },
      },
      {
        method: "PATCH",
        path: `/v1/betaBuildLocalizations/${id}`,
        body: {
          data: {
            type: "betaBuildLocalizations",
            id,
            attributes: { whatsNew: "Try the new boss" },
          },
        },
      },
    ]);
  });

  it("adds a build to each group once, proving every group before sending anything", async () => {
    const w = await world();
    w.fake.put({
      type: "betaGroups",
      id: "bg-internal",
      attributes: { name: "Team", isInternalGroup: true },
      relationships: { app: { data: { type: "apps", id: APPLE_ID } } },
    });
    const refused = await post(w, "distribute/testflight/groups", {
      buildId: "bld-110-42",
      betaGroupIds: ["bg-internal", "bg-other-app"],
    });
    expect(refused.status).toBe(404);
    expect(refused.json.reason).toBe("unknown_beta_group");
    expect(writes(w)).toEqual([]);

    const r = await post(w, "distribute/testflight/groups", {
      buildId: "bld-110-42",
      betaGroupIds: ["bg-internal", "bg-public"],
    });
    expect(r.status).toBe(200);
    expect(r.json.groups).toEqual([
      expect.objectContaining({
        betaGroupId: "bg-internal",
        isInternalGroup: true,
        needsBetaReview: false,
        outcome: "written",
      }),
      expect.objectContaining({
        betaGroupId: "bg-public",
        isInternalGroup: false,
        needsBetaReview: true,
        outcome: "written",
      }),
    ]);
    expect(writes(w)).toEqual(
      ["bg-internal", "bg-public"].map((g) => ({
        method: "POST",
        path: `/v1/betaGroups/${g}/relationships/builds`,
        body: { data: [{ type: "builds", id: "bld-110-42" }] },
      })),
    );
    w.fake.requests.length = 0;
    const again = await post(w, "distribute/testflight/groups", {
      buildId: "bld-110-42",
      betaGroupIds: ["bg-internal", "bg-public"],
    });
    expect(
      (again.json.groups as { outcome: string }[]).map((g) => g.outcome),
    ).toEqual(["existing", "existing"]);
    expect(writes(w)).toEqual([]);
    expect((await distAudits(w)).map((a) => a.action)).toEqual([
      "distribution.asc.testflight.build_to_group",
      "distribution.asc.testflight.build_to_group",
    ]);
  });

  it("refuses a build that is still processing", async () => {
    const w = await world();
    w.fake.set("builds", "bld-110-42", { processingState: "PROCESSING" });
    const r = await post(w, "distribute/testflight/groups", {
      buildId: "bld-110-42",
      betaGroupIds: ["bg-public"],
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("build_not_ready");
    expect(writes(w)).toEqual([]);
  });

  it("submits for beta review once", async () => {
    const w = await world();
    const r = await post(w, "distribute/testflight/beta-review", {
      buildId: "bld-110-42",
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      outcome: "written",
      betaReviewState: "WAITING_FOR_REVIEW",
    });
    expect(writes(w)).toEqual([
      {
        method: "POST",
        path: "/v1/betaAppReviewSubmissions",
        body: {
          data: {
            type: "betaAppReviewSubmissions",
            relationships: {
              build: { data: { type: "builds", id: "bld-110-42" } },
            },
          },
        },
      },
    ]);
    const again = await post(w, "distribute/testflight/beta-review", {
      buildId: "bld-110-42",
    });
    expect(again.json.outcome).toBe("existing");
    expect(writes(w)).toHaveLength(1);
  });

  it("lists the app's beta groups", async () => {
    const w = await world();
    const r = await get(w, "distribute/beta-groups");
    expect(r.status).toBe(200);
    expect(r.json.betaGroups).toEqual([
      {
        id: "bg-public",
        name: "Public testers",
        isInternalGroup: false,
        hasAccessToAllBuilds: false,
        publicLinkEnabled: false,
      },
    ]);
  });
});

describe("the App Store version", () => {
  it("creates a version for the pinned app, then reuses it", async () => {
    const w = await world();
    const r = await post(w, "distribute/version", {
      platform: "IOS",
      versionString: "1.2.0",
    });
    expect(r.status).toBe(200);
    expect(r.json.outcome).toBe("written");
    expect(writes(w)).toEqual([
      {
        method: "POST",
        path: "/v1/appStoreVersions",
        body: {
          data: {
            type: "appStoreVersions",
            attributes: { platform: "IOS", versionString: "1.2.0" },
            relationships: { app: { data: { type: "apps", id: APPLE_ID } } },
          },
        },
      },
    ]);
    const again = await post(w, "distribute/version", {
      platform: "IOS",
      versionString: "1.2.0",
    });
    expect(again.json).toMatchObject({
      outcome: "existing",
      versionId: r.json.versionId,
    });
    expect(writes(w)).toHaveLength(1);
    expect((await distAudits(w)).map((a) => a.action)).toEqual([
      "distribution.asc.version.create",
    ]);
  });

  it("never reuses a shipped version", async () => {
    const w = await world();
    const r = await post(w, "distribute/version", {
      platform: "IOS",
      versionString: "1.1.0",
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("version_not_editable");
    expect(writes(w)).toEqual([]);
  });

  it("relays Apple's unresolved conflict with its code, never its text", async () => {
    const w = await world();
    w.fake.failOnce("POST", "/v1/appStoreVersions", 409);
    const r = await post(w, "distribute/version", {
      platform: "IOS",
      versionString: "1.3.0",
    });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({
      reason: "store_refused",
      appleCode: "ENTITY_ERROR.ATTRIBUTE.INVALID",
    });
    expect(JSON.stringify(r.json)).not.toContain("free text");
    const row = await w.db.first<{
      state: string;
      apple_status: number;
      apple_code: string;
    }>(
      "SELECT state, apple_status, apple_code FROM asc_operations WHERE op = 'version.create'",
    );
    expect(row).toEqual({
      state: "failed",
      apple_status: 409,
      apple_code: "ENTITY_ERROR.ATTRIBUTE.INVALID",
    });
  });

  it("resumes an ambiguous create by reading first: the version Apple made is reused", async () => {
    const w = await world();
    const key = newKey();
    w.fake.failOnce("POST", "/v1/appStoreVersions", 500, { applied: true });
    const first = await post(
      w,
      "distribute/version",
      { platform: "IOS", versionString: "1.4.0" },
      key,
    );
    expect(first.status).toBe(502);
    const second = await post(
      w,
      "distribute/version",
      { platform: "IOS", versionString: "1.4.0" },
      key,
    );
    expect(second.status).toBe(200);
    expect(second.json.outcome).toBe("existing");
    expect(
      writes(w).filter((q) => q.path === "/v1/appStoreVersions"),
    ).toHaveLength(1);
    expect(
      w.fake
        .all("appStoreVersions")
        .filter((v) => v.attributes?.versionString === "1.4.0"),
    ).toHaveLength(1);
  });

  it("attaches a build, refusing another app's build or a shipped version", async () => {
    const w = await world();
    preparedVersion(w, { build: false });
    const shipped = await post(w, "distribute/version/build", {
      versionId: "asv-110",
      buildId: "bld-110-42",
    });
    expect(shipped.status).toBe(409);
    expect(shipped.json.reason).toBe("version_not_editable");
    const r = await post(w, "distribute/version/build", {
      versionId: "asv-120",
      buildId: "bld-110-42",
    });
    expect(r.status).toBe(200);
    expect(writes(w)).toEqual([
      {
        method: "PATCH",
        path: "/v1/appStoreVersions/asv-120/relationships/build",
        body: { data: { type: "builds", id: "bld-110-42" } },
      },
    ]);
    const again = await post(w, "distribute/version/build", {
      versionId: "asv-120",
      buildId: "bld-110-42",
    });
    expect(again.json.outcome).toBe("existing");
    expect(writes(w)).toHaveLength(1);
  });

  it("sets the release type; a scheduled release needs a future date, rounded to the hour", async () => {
    const w = await world();
    preparedVersion(w);
    const missing = await post(w, "distribute/version/release-type", {
      versionId: "asv-120",
      releaseType: "SCHEDULED",
    });
    expect(missing.status).toBe(422);
    const when = new Date((NOW + 86_400) * 1000 + 61_000).toISOString();
    const r = await post(w, "distribute/version/release-type", {
      versionId: "asv-120",
      releaseType: "SCHEDULED",
      earliestReleaseDate: when,
    });
    expect(r.status).toBe(200);
    const rounded = new Date(
      Math.ceil(Date.parse(when) / 3_600_000) * 3_600_000,
    ).toISOString();
    const manual = await post(w, "distribute/version/release-type", {
      versionId: "asv-120",
      releaseType: "MANUAL",
    });
    expect(manual.status).toBe(200);
    expect(
      writes(w).map(
        (q) => (q.body as { data: { attributes: unknown } }).data.attributes,
      ),
    ).toEqual([
      { releaseType: "SCHEDULED", earliestReleaseDate: rounded },
      { releaseType: "MANUAL" },
    ]);
  });

  it("creates a phased release once", async () => {
    const w = await world();
    preparedVersion(w);
    const r = await post(w, "distribute/version/phased-release", {
      versionId: "asv-120",
    });
    expect(r.status).toBe(200);
    expect(writes(w)).toEqual([
      {
        method: "POST",
        path: "/v1/appStoreVersionPhasedReleases",
        body: {
          data: {
            type: "appStoreVersionPhasedReleases",
            attributes: { phasedReleaseState: "INACTIVE" },
            relationships: {
              appStoreVersion: {
                data: { type: "appStoreVersions", id: "asv-120" },
              },
            },
          },
        },
      },
    ]);
    const again = await post(w, "distribute/version/phased-release", {
      versionId: "asv-120",
    });
    expect(again.json).toMatchObject({
      outcome: "existing",
      phasedReleaseId: r.json.phasedReleaseId,
    });
    expect(writes(w)).toHaveLength(1);
  });

  it("writes What's New per locale: a create, then a PATCH of only the changed field", async () => {
    const w = await world();
    preparedVersion(w);
    const a = await post(w, "distribute/version-localization", {
      versionId: "asv-120",
      locale: "en-US",
      whatsNew: "New levels",
    });
    expect(a.status).toBe(200);
    const b = await post(w, "distribute/version-localization", {
      versionId: "asv-120",
      locale: "en-US",
      promotionalText: "Now with bosses",
    });
    expect(b.status).toBe(200);
    expect(
      writes(w).map((q) => [
        q.method,
        (q.body as { data: { attributes: unknown } }).data.attributes,
      ]),
    ).toEqual([
      ["POST", { locale: "en-US", whatsNew: "New levels" }],
      ["PATCH", { promotionalText: "Now with bosses" }],
    ]);
    const tooLong = await post(w, "distribute/version-localization", {
      versionId: "asv-120",
      locale: "en-US",
      promotionalText: "x".repeat(171),
    });
    expect(tooLong.status).toBe(422);
  });

  it("lists versions and the live review submissions", async () => {
    const w = await world();
    preparedVersion(w);
    const r = await get(w, "distribute/versions");
    expect(r.status).toBe(200);
    expect(
      (r.json.versions as { id: string; editable: boolean }[]).map((v) => [
        v.id,
        v.editable,
      ]),
    ).toEqual([
      ["asv-120", true],
      ["asv-110", false],
      ["asv-100", false],
    ]);
    expect(r.json.submissions).toEqual([]);
  });
});

describe("submit for review (typed)", () => {
  it("refuses without confirm or with another name, sending no write", async () => {
    const w = await world();
    preparedVersion(w);
    const none = await post(w, "distribute/submit", { versionId: "asv-120" });
    expect(none.status).toBe(422);
    expect(none.json.reason).toBe("confirmation_required");
    expect(w.fake.requests).toEqual([]);
    const wrong = await post(w, "distribute/submit", {
      versionId: "asv-120",
      confirm: "DJDL",
    });
    expect(wrong.status).toBe(422);
    expect(wrong.json.reason).toBe("confirmation_mismatch");
    expect(writes(w)).toEqual([]);
    expect(await distAudits(w)).toEqual([]);
  });

  it("opens a submission, adds the version, submits it; a replay sends nothing", async () => {
    const w = await world();
    preparedVersion(w);
    const key = newKey();
    const r = await post(
      w,
      "distribute/submit",
      { versionId: "asv-120", confirm: "djdl" },
      key,
    );
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      versionId: "asv-120",
      state: "WAITING_FOR_REVIEW",
    });
    const sid = r.json.submissionId as string;
    expect(writes(w)).toEqual([
      {
        method: "POST",
        path: "/v1/reviewSubmissions",
        body: {
          data: {
            type: "reviewSubmissions",
            attributes: { platform: "IOS" },
            relationships: { app: { data: { type: "apps", id: APPLE_ID } } },
          },
        },
      },
      {
        method: "POST",
        path: "/v1/reviewSubmissionItems",
        body: {
          data: {
            type: "reviewSubmissionItems",
            relationships: {
              reviewSubmission: {
                data: { type: "reviewSubmissions", id: sid },
              },
              appStoreVersion: {
                data: { type: "appStoreVersions", id: "asv-120" },
              },
            },
          },
        },
      },
      {
        method: "PATCH",
        path: `/v1/reviewSubmissions/${sid}`,
        body: {
          data: {
            type: "reviewSubmissions",
            id: sid,
            attributes: { submitted: true },
          },
        },
      },
    ]);
    expect((await distAudits(w)).map((a) => a.action)).toEqual([
      "distribution.asc.review_submission.open",
      "distribution.asc.review_submission.item",
      "distribution.asc.review_submission.submit",
    ]);
    w.fake.requests.length = 0;
    // The version is WAITING_FOR_REVIEW now: a second submit is refused before any step.
    const again = await post(
      w,
      "distribute/submit",
      { versionId: "asv-120", confirm: "djdl" },
      key,
    );
    expect(again.status).toBe(409);
    expect(again.json.reason).toBe("version_not_editable");
    expect(writes(w)).toEqual([]);
  });

  it("reuses the open submission and resumes after Apple fails the submit", async () => {
    const w = await world();
    preparedVersion(w);
    w.fake.put({
      type: "reviewSubmissions",
      id: "rvs-open",
      attributes: { platform: "IOS", state: "READY_FOR_REVIEW" },
      relationships: { app: { data: { type: "apps", id: APPLE_ID } } },
    });
    const key = newKey();
    w.fake.failOnce("PATCH", "/v1/reviewSubmissions/rvs-open", 500);
    const first = await post(
      w,
      "distribute/submit",
      { versionId: "asv-120", confirm: "djdl" },
      key,
    );
    expect(first.status).toBe(502);
    const second = await post(
      w,
      "distribute/submit",
      { versionId: "asv-120", confirm: "djdl" },
      key,
    );
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({
      submissionId: "rvs-open",
      state: "WAITING_FOR_REVIEW",
      steps: {
        open: { outcome: "replayed" },
        item: { outcome: "replayed" },
        submit: { outcome: "written" },
      },
    });
    expect(writes(w).map((q) => `${q.method} ${q.path}`)).toEqual([
      "POST /v1/reviewSubmissionItems",
      "PATCH /v1/reviewSubmissions/rvs-open",
      "PATCH /v1/reviewSubmissions/rvs-open",
    ]);
  });

  it("refuses a version without a build", async () => {
    const w = await world();
    preparedVersion(w, { build: false });
    const r = await post(w, "distribute/submit", {
      versionId: "asv-120",
      confirm: "djdl",
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("no_build");
    expect(writes(w)).toEqual([]);
  });

  it("cancels a waiting submission of this app only", async () => {
    const w = await world();
    w.fake.put({
      type: "reviewSubmissions",
      id: "rvs-wait",
      attributes: { platform: "IOS", state: "WAITING_FOR_REVIEW" },
      relationships: { app: { data: { type: "apps", id: APPLE_ID } } },
    });
    w.fake.put({
      type: "reviewSubmissions",
      id: "rvs-foreign",
      attributes: { platform: "IOS", state: "WAITING_FOR_REVIEW" },
      relationships: { app: { data: { type: "apps", id: OTHER_APP } } },
    });
    const foreign = await post(w, "distribute/submission/cancel", {
      submissionId: "rvs-foreign",
    });
    expect(foreign.status).toBe(404);
    expect(foreign.json.reason).toBe("unknown_submission");
    const done = await post(w, "distribute/submission/cancel", {
      submissionId: "rvs-110",
    });
    expect(done.status).toBe(409);
    expect(done.json.reason).toBe("not_cancelable");
    expect(writes(w)).toEqual([]);
    const r = await post(w, "distribute/submission/cancel", {
      submissionId: "rvs-wait",
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ outcome: "written", state: "CANCELING" });
    expect(writes(w)).toEqual([
      {
        method: "PATCH",
        path: "/v1/reviewSubmissions/rvs-wait",
        body: {
          data: {
            type: "reviewSubmissions",
            id: "rvs-wait",
            attributes: { canceled: true },
          },
        },
      },
    ]);
    const again = await post(w, "distribute/submission/cancel", {
      submissionId: "rvs-wait",
    });
    expect(again.json.outcome).toBe("existing");
    expect(writes(w)).toHaveLength(1);
  });
});

describe("preflight", () => {
  it("reports what the API exposes, never a contact value or password", async () => {
    const w = await world();
    preparedVersion(w);
    const v = w.fake.get("appStoreVersions", "asv-120");
    v.relationships = {
      ...v.relationships,
      appStoreVersionLocalizations: {
        data: [
          { type: "appStoreVersionLocalizations", id: "loc-en" },
          { type: "appStoreVersionLocalizations", id: "loc-fr" },
        ],
      },
      appStoreReviewDetail: {
        data: { type: "appStoreReviewDetails", id: "ard-1" },
      },
    };
    for (const [id, locale] of [
      ["loc-en", "en-US"],
      ["loc-fr", "fr-FR"],
    ])
      w.fake.put({
        type: "appStoreVersionLocalizations",
        id: id!,
        attributes: { locale },
        relationships: {
          appStoreVersion: {
            data: { type: "appStoreVersions", id: "asv-120" },
          },
        },
      });
    w.fake.put({
      type: "appScreenshotSets",
      id: "ss-en",
      attributes: { screenshotDisplayType: "APP_IPHONE_67" },
      relationships: {
        appStoreVersionLocalization: {
          data: { type: "appStoreVersionLocalizations", id: "loc-en" },
        },
      },
    });
    w.fake.put({
      type: "appStoreReviewDetails",
      id: "ard-1",
      attributes: {
        contactFirstName: "Ada",
        contactLastName: "Lovelace",
        contactEmail: "ada@example.invalid",
        contactPhone: "+1 555 0100",
        demoAccountRequired: true,
        demoAccountName: "demo",
        demoAccountPassword: "hunter2-never-relayed",
      },
    });
    w.fake.put({
      type: "appInfos",
      id: "ai-1",
      attributes: { state: "PREPARE_FOR_SUBMISSION" },
      relationships: {
        app: { data: { type: "apps", id: APPLE_ID } },
        ageRatingDeclaration: {
          data: { type: "ageRatingDeclarations", id: "ar-1" },
        },
      },
    });
    w.fake.put({
      type: "ageRatingDeclarations",
      id: "ar-1",
      attributes: {
        gambling: false,
        violenceCartoonOrFantasy: "NONE",
        lootBox: null,
        kidsAgeBand: null,
      },
    });
    const app = w.fake.get("apps", APPLE_ID);
    app.relationships = {
      ...app.relationships,
      appPriceSchedule: { data: { type: "appPriceSchedules", id: APPLE_ID } },
    };
    w.fake.put({ type: "appPriceSchedules", id: APPLE_ID, attributes: {} });

    const r = await get(w, "distribute/preflight?versionId=asv-120");
    expect(r.status).toBe(200);
    const checks = Object.fromEntries(
      (r.json.checks as { id: string }[]).map((c) => [c.id, c]),
    );
    expect(checks.build).toMatchObject({ ok: true });
    expect(checks.exportCompliance).toMatchObject({ ok: true });
    expect(checks.screenshots).toMatchObject({ ok: false, missing: ["fr-FR"] });
    expect(checks.ageRating).toMatchObject({ ok: false, missing: ["lootBox"] });
    expect(checks.reviewContact).toMatchObject({ ok: true });
    expect(checks.price).toMatchObject({ ok: true });
    expect(checks.availability).toMatchObject({ ok: false });
    expect(checks.appPrivacy).toMatchObject({ ok: null });
    expect(r.json.ready).toBe(false);
    const text = JSON.stringify(r.json);
    for (const secret of [
      "ada@example.invalid",
      "555 0100",
      "hunter2",
      "Lovelace",
    ])
      expect(text).not.toContain(secret);
    expect(writes(w)).toEqual([]);
  });

  it("refuses another app's version", async () => {
    const w = await world();
    w.fake.put({
      type: "appStoreVersions",
      id: "asv-foreign",
      attributes: {
        platform: "IOS",
        versionString: "9.0",
        appVersionState: "PREPARE_FOR_SUBMISSION",
      },
      relationships: { app: { data: { type: "apps", id: OTHER_APP } } },
    });
    const r = await get(w, "distribute/preflight?versionId=asv-foreign");
    expect(r.status).toBe(404);
    expect(r.json.reason).toBe("unknown_version");
  });
});

describe("the connector lists the Distribute surface", () => {
  it("status names the controls and reads; a GET on a write path is 405", async () => {
    const w = await world();
    const res = await admin(w, "GET", BASE);
    const body = (await res.json()) as { controls: string[]; reads: string[] };
    expect(body.controls).toEqual(
      expect.arrayContaining(["release", "distribute/submit"]),
    );
    expect(body.reads).toEqual([
      "distribute/builds",
      "distribute/beta-groups",
      "distribute/versions",
      "distribute/preflight",
      // A-17e's IAP reads share the connector's read table.
      "iap/products",
      "iap/price-points",
      "distribute/submission-items",
    ]);
    expect((await admin(w, "GET", `${BASE}/distribute/submit`)).status).toBe(
      405,
    );
    expect(
      (await admin(w, "POST", `${BASE}/distribute/builds`, {})).status,
    ).toBe(405);
  });
});
