/**
 * P5-02 — the App Store Connect webhook (`POST /<p>/distribution/hooks/asc`) through the real
 * dispatcher, against recorded payloads (`test/fixtures/asc/webhooks/`) and the fake ASC server.
 *
 * Signature: valid, invalid, missing and wrong-prefix `x-apple-signature`; dedupe of a
 * redelivered `data.id`; each of the 12 event types mapped or explicitly stored; the
 * not-found shape when Distribution is off or no `asc-api-key` credential exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAudit, setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import { ASC_WEBHOOK_EVENT_TYPES } from "../src/services/distribution/connectors/asc/map.js";
import type { AscResource } from "../src/core/asc/client.js";
import { webhookFixture } from "./ascFake.js";
import {
  ascWorld,
  audits,
  availability,
  deliver,
  rollouts,
  sign,
  submissions,
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

const ASV_UPDATED = () =>
  webhookFixture("APP_STORE_VERSION_APP_VERSION_STATE_UPDATED");

async function events(w: AscWorld) {
  return w.db.all<{ event_id: string; event_type: string; outcome: string }>(
    "SELECT event_id, event_type, outcome FROM dist_connector_events WHERE product = ? ORDER BY rowid",
    SLUG,
  );
}

async function opens(w: AscWorld) {
  return (await listAudit(w.db, SLUG, {})).filter(
    (a) => a.action === "outlet_credential.use",
  );
}

describe("the signature", () => {
  it("accepts a valid hmacsha256 signature over the raw body", async () => {
    const w = await ascWorld();
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
      appStoreState: "READY_FOR_SALE",
    });
    const res = await deliver(w, ASV_UPDATED());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses an invalid signature (401) and writes nothing but the audited secret open", async () => {
    const w = await ascWorld();
    const body = ASV_UPDATED();
    const res = await deliver(w, body, sign(body, "not-the-secret"));
    expect(res.status).toBe(401);
    expect(await events(w)).toEqual([]);
    expect(w.fake.requests).toEqual([]);
    expect(await availability(w.db)).toEqual([]);
    // The open is audited (P5-01) — and only happened after the rate limiter admitted it.
    expect((await opens(w)).map((a) => a.summary)).toEqual([
      "asc:webhook: opened",
    ]);
  });

  it("refuses a body altered after signing", async () => {
    const w = await ascWorld();
    const body = ASV_UPDATED();
    const res = await deliver(
      w,
      body.replace("asv-110", "asv-100"),
      sign(body),
    );
    expect(res.status).toBe(401);
  });

  it("refuses a missing signature before opening the secret", async () => {
    const w = await ascWorld();
    const res = await deliver(w, ASV_UPDATED(), null);
    expect(res.status).toBe(401);
    expect(await opens(w)).toEqual([]);
    expect(await events(w)).toEqual([]);
  });

  it("refuses a wrong prefix (GitHub's sha256=, an uppercase scheme, a short MAC) before opening the secret", async () => {
    const w = await ascWorld();
    const body = ASV_UPDATED();
    const hex = sign(body).slice("hmacsha256=".length);
    for (const header of [
      `sha256=${hex}`,
      `HMACSHA256=${hex}`,
      `hmacsha1=${hex}`,
      `hmacsha256=${hex.slice(0, 40)}`,
      hex,
    ]) {
      const res = await deliver(w, body, header);
      expect(res.status, header).toBe(401);
    }
    expect(await opens(w)).toEqual([]);
  });

  it("refuses an oversized body with 413 before opening the secret", async () => {
    const w = await ascWorld();
    const body = JSON.stringify({
      data: { id: "x", pad: "a".repeat(70 * 1024) },
    });
    const res = await deliver(w, body);
    expect(res.status).toBe(413);
    expect(await opens(w)).toEqual([]);
  });
});

describe("dedupe", () => {
  it("a redelivered data.id changes nothing: no row, no audit, no API call", async () => {
    const w = await ascWorld();
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    expect((await deliver(w, ASV_UPDATED())).status).toBe(200);
    const auditBefore = await audits(w.db);
    const availBefore = await availability(w.db);
    const requestsBefore = w.fake.requests.length;
    // The store moves on; a redelivery of the OLD event must not re-read or re-write anything.
    w.fake.set("appStoreVersions", "asv-110", { appVersionState: "REJECTED" });

    const again = await deliver(w, ASV_UPDATED());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(w.fake.requests.length).toBe(requestsBefore);
    expect(await availability(w.db)).toEqual(availBefore);
    // The only new audit row is the secret open that authenticated the redelivery.
    const auditAfter = await audits(w.db);
    expect(auditAfter.slice(auditBefore.length).map((a) => a.action)).toEqual([
      "outlet_credential.use",
    ]);
    expect(await events(w)).toHaveLength(1);
  });

  it("dedupes from the events table when the KV marker has expired", async () => {
    const w = await ascWorld();
    await deliver(w, ASV_UPDATED());
    await w.env.HOT.delete(
      `p:${SLUG}:asc-delivery:5f1c1e3a-0001-4b8e-9d2a-000000000001`,
    );
    const n = w.fake.requests.length;
    const again = await deliver(w, ASV_UPDATED());
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(w.fake.requests.length).toBe(n);
  });

  it("lets a delivery whose processing failed be redelivered", async () => {
    const w = await ascWorld();
    w.fake.fail429(10);
    const first = await deliver(w, ASV_UPDATED());
    expect(first.status).toBe(200); // answered before (here: regardless of) the follow-up
    expect((await events(w))[0]!.outcome).toBe("failed");
    w.fake.fail429(0);
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    const retry = await deliver(w, ASV_UPDATED());
    expect(await retry.json()).toEqual({ ok: true });
    expect((await events(w))[0]!.outcome).toBe("applied");
  });
});

describe("the 12 event types", () => {
  it("knows exactly the 12 WebhookEventType values, each with a recorded fixture", () => {
    expect(ASC_WEBHOOK_EVENT_TYPES).toHaveLength(12);
    for (const t of ASC_WEBHOOK_EVENT_TYPES)
      expect(() => webhookFixture(t), t).not.toThrow();
  });

  it("maps or explicitly stores each one", async () => {
    const w = await ascWorld();
    const outcomes: Record<string, { status: number; outcome: string }> = {};
    for (const t of ASC_WEBHOOK_EVENT_TYPES) {
      const body = webhookFixture(t);
      const res = await deliver(w, body);
      const id = (JSON.parse(body) as { data: { id: string } }).data.id;
      const row = await w.db.first<{ outcome: string; event_type: string }>(
        "SELECT outcome, event_type FROM dist_connector_events WHERE event_id = ?",
        id,
      );
      expect(row?.event_type, t).toBe(t);
      outcomes[t] = { status: res.status, outcome: row!.outcome };
    }
    expect(outcomes).toEqual({
      APP_STORE_VERSION_APP_VERSION_STATE_UPDATED: {
        status: 200,
        outcome: "applied",
      },
      BUILD_UPLOAD_STATE_UPDATED: { status: 200, outcome: "applied" },
      BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED: {
        status: 200,
        outcome: "applied",
      },
      BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED: {
        status: 200,
        outcome: "stored",
      },
      BETA_FEEDBACK_CRASH_SUBMISSION_CREATED: {
        status: 200,
        outcome: "stored",
      },
      // No pack release claims the asset pack yet (P5-08): stored unresolved.
      BACKGROUND_ASSET_VERSION_STATE_UPDATED: {
        status: 200,
        outcome: "unresolved",
      },
      BACKGROUND_ASSET_VERSION_INTERNAL_BETA_RELEASE_CREATED: {
        status: 200,
        outcome: "unresolved",
      },
      BACKGROUND_ASSET_VERSION_EXTERNAL_BETA_RELEASE_STATE_UPDATED: {
        status: 200,
        outcome: "unresolved",
      },
      BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED: {
        status: 200,
        outcome: "unresolved",
      },
      ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED: {
        status: 200,
        outcome: "stored",
      },
      ALTERNATIVE_DISTRIBUTION_PACKAGE_AVAILABLE_UPDATED: {
        status: 200,
        outcome: "stored",
      },
      ALTERNATIVE_DISTRIBUTION_TERRITORY_AVAILABILITY_UPDATED: {
        status: 200,
        outcome: "stored",
      },
    });
    // Stored-only events made no API call: only the eight state events did.
    const gets = new Set(w.fake.requests.map((r) => r.path));
    expect(
      [...gets].some(
        (p) => p.includes("Feedback") || p.includes("alternative"),
      ),
    ).toBe(false);
  });

  it("answers 204 for an unknown event type and stores it as ignored", async () => {
    const w = await ascWorld();
    const body = JSON.stringify({
      data: {
        type: "somethingAppleAddsLater",
        id: "11111111-2222-3333-4444-555555555555",
        attributes: {},
      },
    });
    const res = await deliver(w, body);
    expect(res.status).toBe(204);
    expect(await events(w)).toEqual([
      {
        event_id: "11111111-2222-3333-4444-555555555555",
        event_type: "somethingAppleAddsLater",
        outcome: "ignored",
      },
    ]);
    expect(w.fake.requests).toEqual([]);
  });

  it("answers Apple's ping and stores it", async () => {
    const w = await ascWorld();
    const res = await deliver(w, webhookFixture("PING"));
    expect(res.status).toBe(200);
    expect((await events(w))[0]!.outcome).toBe("stored");
  });

  it("an app-version event writes availability and submission of the release from the API GET, not the payload", async () => {
    const w = await ascWorld();
    // The payload says READY_FOR_DISTRIBUTION; the API says the version is still held.
    await deliver(w, ASV_UPDATED());
    expect(w.fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/appStoreVersions/asv-110",
    ]);
    expect(w.fake.requests[0]!.query.include).toContain(
      "appStoreVersionPhasedRelease",
    );
    expect(w.fake.requests[0]!.authorization).toMatch(/^Bearer ey/);
    const [row] = (await availability(w.db)).filter(
      (r) => r.outlet_id === "app-store",
    );
    expect(row).toMatchObject({
      release_id: "v1.1.0",
      build_id: "",
      state: "approved",
      source: "asc",
    });
    expect(JSON.parse(row!.platform_ref_json!)).toMatchObject({
      ascAppId: "1234567890",
      ascVersionId: "asv-110",
      ascBuildId: "bld-110-42",
    });
    expect(JSON.parse(row!.detail_json!).ascState).toBe(
      "PENDING_DEVELOPER_RELEASE",
    );
    expect(await submissions(w.db)).toEqual([
      {
        release_id: "v1.1.0",
        outlet_id: "app-store",
        state: "pending-developer-release",
        source: "asc",
      },
    ]);
    // A connector write is audited as the connector.
    const writes = (await audits(w.db)).filter((a) =>
      a.action.startsWith("distribution."),
    );
    expect(writes.map((a) => a.actor_sub)).toEqual([
      "connector:asc",
      "connector:asc",
    ]);
  });

  it("a build event writes testflight availability of the release build with that build number", async () => {
    const w = await ascWorld();
    await deliver(
      w,
      webhookFixture("BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED"),
    );
    const [row] = (await availability(w.db)).filter(
      (r) => r.outlet_id === "testflight",
    );
    // internal IN_BETA_TESTING → testers can install: live.
    expect(row).toMatchObject({
      release_id: "v1.1.0",
      build_id: "ios",
      state: "live",
      source: "asc",
    });
    expect(JSON.parse(row!.detail_json!)).toMatchObject({
      internalBuildState: "IN_BETA_TESTING",
      externalBuildState: "BETA_APPROVED",
      buildNumber: "42",
    });
  });

  it("a Background Asset event is stored unresolved, with the asset pack's ids, and writes no availability", async () => {
    const w = await ascWorld();
    await deliver(w, webhookFixture("BACKGROUND_ASSET_VERSION_STATE_UPDATED"));
    expect(await availability(w.db)).toEqual([]);
    const obj = await w.db.first<{
      release_id: string | null;
      state: string;
      store_state: string;
      ref_json: string;
      outlet_id: string;
    }>(
      "SELECT release_id, state, store_state, ref_json, outlet_id FROM dist_connector_objects WHERE object_type = 'backgroundAssetVersions'",
    );
    expect(obj).toMatchObject({
      release_id: null,
      state: "approved",
      store_state: "COMPLETE",
      outlet_id: "testflight",
    });
    expect(JSON.parse(obj!.ref_json)).toMatchObject({
      ascBackgroundAssetId: "ba-levels",
      ascBackgroundAssetVersionId: "bav-1",
      assetPackIdentifier: "dice.levels",
    });
  });

  it("parses both instance shapes (data-wrapped and bare)", async () => {
    const w = await ascWorld();
    const wrapped = JSON.parse(
      webhookFixture(
        "BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED",
      ),
    ) as { data: { id: string; relationships: { instance: unknown } } };
    wrapped.data.id = "99999999-0000-0000-0000-000000000001";
    wrapped.data.relationships.instance = {
      data: { type: "backgroundAssetVersionAppStoreReleases", id: "bavas-1" },
    };
    await deliver(w, JSON.stringify(wrapped));
    // The instance first, then the chain that proves it is this app's: version → asset → app.
    expect(w.fake.requests.map((r) => [r.path, r.query.include])).toEqual([
      [
        "/v1/backgroundAssetVersionAppStoreReleases/bavas-1",
        "backgroundAssetVersion",
      ],
      ["/v1/backgroundAssetVersions/bav-1", "backgroundAsset"],
      ["/v1/backgroundAssets/ba-levels", "app"],
    ]);
  });

  it("never lets a payload aim the follow-up GET elsewhere: an instance of the wrong type is stored unresolved", async () => {
    const w = await ascWorld();
    const evil = JSON.parse(ASV_UPDATED()) as {
      data: {
        id: string;
        relationships: { instance: { data: { type: string; id: string } } };
      };
    };
    evil.data.id = "99999999-0000-0000-0000-000000000002";
    evil.data.relationships.instance.data = { type: "users", id: "u-1" };
    const res = await deliver(w, JSON.stringify(evil));
    expect(res.status).toBe(200);
    expect(w.fake.requests).toEqual([]);
    expect((await events(w))[0]!.outcome).toBe("unresolved");
    const traversal = JSON.parse(ASV_UPDATED()) as typeof evil;
    traversal.data.id = "99999999-0000-0000-0000-000000000003";
    traversal.data.relationships.instance.data = {
      type: "appStoreVersions",
      id: "../../users",
    };
    await deliver(w, JSON.stringify(traversal));
    expect(w.fake.requests).toEqual([]);
    expect(w.fake.foreignHost).toEqual([]);
  });

  it("an object of another app writes nothing", async () => {
    const w = await ascWorld();
    w.fake.put({
      ...w.fake.get("appStoreVersions", "asv-110"),
      relationships: {
        ...w.fake.get("appStoreVersions", "asv-110").relationships,
        app: { data: { type: "apps", id: "9999999999" } },
      },
    });
    await deliver(w, ASV_UPDATED());
    expect(await availability(w.db)).toEqual([]);
    expect((await events(w))[0]!.outcome).toBe("ignored");
  });

  it("the fake answers relationships as the API does: data only when included", async () => {
    const w = await ascWorld();
    const read = async (include?: string) =>
      (await (
        await w.fake.fetchImpl(
          `https://api.appstoreconnect.apple.com/v1/buildUploads/bup-110-42${include ? `?include=${include}` : ""}`,
        )
      ).json()) as {
        data: AscResource;
        included: AscResource[];
      };
    const bare = await read();
    expect(bare.data.relationships?.app?.data).toBeUndefined();
    expect(bare.data.relationships?.build?.data).toBeUndefined();
    const withBuild = await read("build");
    expect(withBuild.data.relationships?.app?.data).toBeUndefined();
    expect(withBuild.data.relationships?.build?.data).toEqual({
      type: "builds",
      id: "bld-110-42",
    });
    // An included resource carries no relationship data.
    expect(withBuild.included[0]!.relationships?.app?.data).toBeUndefined();
  });

  describe("ownership fails closed on every write path", () => {
    const OTHER_APP = { data: { type: "apps", id: "9999999999" } };

    async function objects(w: AscWorld) {
      return w.db.all<{ object_type: string; object_id: string }>(
        "SELECT object_type, object_id FROM dist_connector_objects WHERE product = ?",
        SLUG,
      );
    }

    function withApp(
      w: AscWorld,
      type: string,
      id: string,
      app: typeof OTHER_APP | null,
    ) {
      const r = w.fake.get(type, id);
      const { app: _drop, ...rest } = r.relationships ?? {};
      w.fake.put({
        ...r,
        relationships: app ? { ...rest, app } : rest,
      });
    }

    it("an own pre-COMPLETE build upload writes testflight processing", async () => {
      const w = await ascWorld();
      w.fake.set("buildUploads", "bup-110-42", { state: "PROCESSING" });
      await deliver(w, webhookFixture("BUILD_UPLOAD_STATE_UPDATED"));
      expect(w.fake.requests[0]!.query.include).toBe("app,build");
      expect(
        (await availability(w.db)).map((r) => [
          r.release_id,
          r.outlet_id,
          r.state,
        ]),
      ).toEqual([["v1.1.0", "testflight", "processing"]]);
    });

    for (const [label, app] of [
      ["another app's", OTHER_APP],
      ["an app-less", null],
    ] as const) {
      for (const state of [
        "AWAITING_UPLOAD",
        "PROCESSING",
        "FAILED",
        "COMPLETE",
      ]) {
        it(`${label} build upload (${state}) with this release's version stores and writes nothing`, async () => {
          const w = await ascWorld();
          w.fake.set("buildUploads", "bup-110-42", { state });
          withApp(w, "buildUploads", "bup-110-42", app);
          await deliver(w, webhookFixture("BUILD_UPLOAD_STATE_UPDATED"));
          expect(await availability(w.db)).toEqual([]);
          expect(await objects(w)).toEqual([]);
          expect((await events(w))[0]!.outcome).toBe("ignored");
          // Never followed into the build it names.
          expect(w.fake.requests.map((r) => r.path)).toEqual([
            "/v1/buildUploads/bup-110-42",
          ]);
        });
      }
    }

    it("another app's build reached through a beta detail writes nothing", async () => {
      const w = await ascWorld();
      withApp(w, "builds", "bld-110-42", OTHER_APP);
      await deliver(
        w,
        webhookFixture("BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED"),
      );
      expect(await availability(w.db)).toEqual([]);
      expect(await objects(w)).toEqual([]);
      expect((await events(w))[0]!.outcome).toBe("ignored");
    });

    const BA_EVENTS = [
      "BACKGROUND_ASSET_VERSION_STATE_UPDATED",
      "BACKGROUND_ASSET_VERSION_INTERNAL_BETA_RELEASE_CREATED",
      "BACKGROUND_ASSET_VERSION_EXTERNAL_BETA_RELEASE_STATE_UPDATED",
      "BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED",
    ] as const;

    for (const [label, app] of [
      ["another app's", OTHER_APP],
      ["an app-less", null],
    ] as const) {
      for (const event of BA_EVENTS) {
        it(`${event}: ${label} asset pack stores and writes nothing`, async () => {
          const w = await ascWorld();
          withApp(w, "backgroundAssets", "ba-levels", app);
          await deliver(w, webhookFixture(event));
          expect(await objects(w)).toEqual([]);
          expect(await availability(w.db)).toEqual([]);
          expect((await events(w))[0]!.outcome).toBe("ignored");
          // The ownership check was asked of the asset itself.
          expect(w.fake.requests.at(-1)).toMatchObject({
            path: "/v1/backgroundAssets/ba-levels",
            query: { include: "app" },
          });
        });
      }
    }

    it("a Background Asset release whose version names no asset stores nothing", async () => {
      const w = await ascWorld();
      w.fake.put({
        ...w.fake.get("backgroundAssetVersions", "bav-1"),
        relationships: {},
      });
      await deliver(
        w,
        webhookFixture(
          "BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED",
        ),
      );
      expect(await objects(w)).toEqual([]);
      expect((await events(w))[0]!.outcome).toBe("ignored");
    });
  });

  it("an app-version event mirrors an ACTIVE phased release", async () => {
    const w = await ascWorld();
    w.fake.set("appStoreVersions", "asv-110", {
      appVersionState: "READY_FOR_DISTRIBUTION",
    });
    w.fake.set("appStoreVersionPhasedReleases", "phr-110", {
      phasedReleaseState: "ACTIVE",
      currentDayNumber: 3,
    });
    await deliver(w, ASV_UPDATED());
    expect(await rollouts(w.db)).toEqual([
      {
        release_id: "v1.1.0",
        outlet_id: "app-store",
        channel: expect.any(String),
        rollout_bp: 500,
        state: "active",
        mirrored: 1,
        source: "asc",
      },
    ]);
  });
});

describe("not configured: the service not-found shape", () => {
  const NOT_FOUND = { error: { code: "not_found" } };

  it("with Distribution disabled", async () => {
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
    const res = await deliver(w, ASV_UPDATED());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(await opens(w)).toEqual([]);
  });

  it("without an asc-api-key credential", async () => {
    const w = await ascWorld({ apiKey: false });
    const res = await deliver(w, ASV_UPDATED());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(await opens(w)).toEqual([]);
  });

  it("without an asc-webhook-secret credential", async () => {
    const w = await ascWorld({ secret: false });
    const res = await deliver(w, ASV_UPDATED());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  it("without an app-store or testflight outlet", async () => {
    const w = await ascWorld({ outlets: false });
    const res = await deliver(w, ASV_UPDATED());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  it("is byte-identical to an unknown connector's answer", async () => {
    const w = await ascWorld({ apiKey: false });
    const a = await deliver(w, ASV_UPDATED());
    const { call, CONSOLE } = await import("./releaseRoutesFixture.js");
    const b = await call(
      w.env,
      w.db,
      w.fetchImpl,
      `${CONSOLE}/${SLUG}/distribution/hooks/nope`,
      {
        method: "POST",
        body: "{}",
      },
    );
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
  });
});

describe("rate limit", () => {
  it("refuses deliveries past the per-product budget with 429 before opening the secret", async () => {
    const w = await ascWorld();
    const body = JSON.stringify({ data: { type: "x", id: "rl" } });
    let limited = 0;
    for (let i = 0; i < 62; i++) {
      const res = await deliver(w, body, sign(body, "wrong"));
      if (res.status === 429) limited++;
    }
    expect(limited).toBe(2);
    const opened = (await audits(w.db)).filter(
      (a) => a.action === "outlet_credential.use",
    );
    expect(opened).toHaveLength(60);
  });
});
