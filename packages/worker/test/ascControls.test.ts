/**
 * P5-02 — App Store Connect controls through the real admin API: each sends exactly the
 * documented request to the fake server, writes ONE audit row with the session's subject, and
 * re-reads state afterwards. Plus the console reads and the generated webhook secret.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASC_WEBHOOK_EVENT_TYPES } from "../src/services/distribution/connectors/asc/map.js";
import { listOutletCredentials } from "../src/core/outletCredentials.js";
import { webhookFixture } from "./ascFake.js";
import {
  admin,
  ascWorld,
  audits,
  deliver,
  rollouts,
  withFetch,
  NOW,
  SLUG,
  type AscWorld,
} from "./ascWorld.js";
import { runConnectorPolls } from "../src/scheduled.js";
import { upsertObject } from "../src/services/distribution/connectors/state.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** The audit rows a control wrote (the credential opens are P5-01's and counted apart). */
async function controlAudits(w: AscWorld) {
  return (await audits(w.db)).filter((a) =>
    a.action.startsWith("distribution.asc."),
  );
}

async function seeded(): Promise<AscWorld> {
  const w = await ascWorld();
  await withFetch(w, () => runConnectorPolls(w.env, w.db, NOW));
  w.fake.requests.length = 0;
  return w;
}

describe("phased release controls", () => {
  for (const [verb, state] of [
    ["pause", "PAUSED"],
    ["resume", "ACTIVE"],
    ["complete", "COMPLETE"],
  ] as const) {
    it(`${verb}: PATCH phasedReleaseState ${state}, one audit row, then a re-read`, async () => {
      const w = await ascWorld();
      w.fake.set("appStoreVersions", "asv-110", {
        appVersionState: "READY_FOR_DISTRIBUTION",
      });
      w.fake.set("appStoreVersionPhasedReleases", "phr-110", {
        phasedReleaseState: verb === "resume" ? "PAUSED" : "ACTIVE",
        currentDayNumber: 2,
      });
      await withFetch(w, () => runConnectorPolls(w.env, w.db, NOW));
      w.fake.requests.length = 0;

      const res = await admin(
        w,
        "POST",
        `/distribution/connectors/asc/phased-release/${verb}`,
        {
          releaseId: "v1.1.0",
        },
      );
      expect(res.status).toBe(200);
      expect(w.fake.writes()).toEqual([
        {
          method: "PATCH",
          path: "/v1/appStoreVersionPhasedReleases/phr-110",
          query: {},
          body: {
            data: {
              type: "appStoreVersionPhasedReleases",
              id: "phr-110",
              attributes: { phasedReleaseState: state },
            },
          },
          authorization: expect.stringMatching(/^Bearer /),
        },
      ]);
      // Re-read after the write.
      const last = w.fake.requests.at(-1)!;
      expect(`${last.method} ${last.path}`).toBe(
        "GET /v1/appStoreVersions/asv-110",
      );
      const rows = await controlAudits(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: `distribution.asc.phased_release.${verb}`,
        actor_sub: "u1",
        target_id: "phr-110",
      });
      const body = (await res.json()) as {
        rollout: { state: string; rolloutBp: number };
      };
      const expected = {
        pause: "paused",
        resume: "active",
        complete: "complete",
      }[verb];
      expect(body.rollout.state).toBe(expected);
      expect((await rollouts(w.db))[0]!.state).toBe(expected);
      if (verb === "complete") expect(body.rollout.rolloutBp).toBe(10000);
    });
  }

  it("refuses a release no App Store version is linked to", async () => {
    const w = await seeded();
    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/asc/phased-release/pause",
      {
        releaseId: "v9.9.9",
      },
    );
    expect(res.status).toBe(404);
    expect(w.fake.writes()).toEqual([]);
    expect(await controlAudits(w)).toEqual([]);
  });

  it("refuses a version without a phased release", async () => {
    const w = await seeded();
    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/asc/phased-release/pause",
      {
        releaseId: "v1.0.0",
      },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "no_phased_release",
    );
    expect(w.fake.writes()).toEqual([]);
  });

  it("relays Apple's refusal as store_refused without auditing a change", async () => {
    const w = await seeded();
    w.fake.fail429(5);
    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/asc/phased-release/pause",
      {
        releaseId: "v1.1.0",
      },
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "store_refused",
    );
    expect(await controlAudits(w)).toEqual([]);
  });
});

describe("release a held version", () => {
  it("POST /v1/appStoreVersionReleaseRequests, one audit row, then a re-read", async () => {
    const w = await seeded();
    const res = await admin(w, "POST", "/distribution/connectors/asc/release", {
      releaseId: "v1.1.0",
    });
    expect(res.status).toBe(200);
    expect(
      w.fake
        .writes()
        .map((r) => ({ method: r.method, path: r.path, body: r.body })),
    ).toEqual([
      {
        method: "POST",
        path: "/v1/appStoreVersionReleaseRequests",
        body: {
          data: {
            type: "appStoreVersionReleaseRequests",
            relationships: {
              appStoreVersion: {
                data: { type: "appStoreVersions", id: "asv-110" },
              },
            },
          },
        },
      },
    ]);
    expect(
      `${w.fake.requests.at(-1)!.method} ${w.fake.requests.at(-1)!.path}`,
    ).toBe("GET /v1/appStoreVersions/asv-110");
    expect(await res.json()).toEqual({
      ok: true,
      versionId: "asv-110",
      ascState: "READY_FOR_DISTRIBUTION",
    });
    const rows = await controlAudits(w);
    expect(rows.map((r) => [r.action, r.actor_sub, r.target_id])).toEqual([
      ["distribution.asc.release", "u1", "asv-110"],
    ]);
    const avail = await w.db.first<{ state: string }>(
      "SELECT state FROM dist_availability WHERE outlet_id = 'app-store' AND release_id = 'v1.1.0'",
    );
    expect(avail?.state).toBe("live");
  });

  it("refuses a version that is not held, sending Apple no write", async () => {
    const w = await seeded();
    const res = await admin(w, "POST", "/distribution/connectors/asc/release", {
      releaseId: "v1.0.0",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("not_held");
    expect(w.fake.writes()).toEqual([]);
  });
});

describe("TestFlight public link", () => {
  it("PATCH /v1/betaGroups/{id} publicLinkEnabled, one audit row, then a re-read", async () => {
    const w = await seeded();
    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/asc/testflight/public-link",
      {
        betaGroupId: "bg-public",
        enabled: true,
      },
    );
    expect(res.status).toBe(200);
    expect(
      w.fake
        .writes()
        .map((r) => ({ method: r.method, path: r.path, body: r.body })),
    ).toEqual([
      {
        method: "PATCH",
        path: "/v1/betaGroups/bg-public",
        body: {
          data: {
            type: "betaGroups",
            id: "bg-public",
            attributes: { publicLinkEnabled: true },
          },
        },
      },
    ]);
    expect(
      `${w.fake.requests.at(-1)!.method} ${w.fake.requests.at(-1)!.path}`,
    ).toBe("GET /v1/betaGroups/bg-public");
    expect(await res.json()).toEqual({
      ok: true,
      betaGroupId: "bg-public",
      publicLinkEnabled: true,
      publicLink: "https://testflight.apple.com/join/AbCdEf12",
    });
    expect((await controlAudits(w)).map((r) => r.action)).toEqual([
      "distribution.asc.testflight.public_link",
    ]);
  });

  it("refuses another app's beta group", async () => {
    const w = await seeded();
    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/asc/testflight/public-link",
      {
        betaGroupId: "bg-other-app",
        enabled: true,
      },
    );
    expect(res.status).toBe(404);
    expect(w.fake.writes()).toEqual([]);
    expect(await controlAudits(w)).toEqual([]);
  });

  it("validates its body", async () => {
    const w = await seeded();
    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/asc/testflight/public-link",
      {
        betaGroupId: "bg-public",
      },
    );
    expect(res.status).toBe(422);
  });
});

describe("register the webhook", () => {
  it("a generated secret is stored, never returned, and is what Apple is given", async () => {
    const w = await ascWorld({ secret: false });
    const put = await admin(w, "PUT", "/outlet-credentials/asc-webhook", {
      kind: "asc-webhook-secret",
      generate: true,
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true, id: "asc-webhook" });

    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/asc/webhook",
      {},
    );
    expect(res.status).toBe(200);
    const writes = w.fake.writes();
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/webhooks",
      "POST /v1/webhookPings",
    ]);
    const created = writes[0]!.body as {
      data: {
        type: string;
        attributes: {
          enabled: boolean;
          eventTypes: string[];
          secret: string;
          url: string;
        };
        relationships: unknown;
      };
    };
    expect(created.data.type).toBe("webhooks");
    expect(created.data.attributes.enabled).toBe(true);
    expect(created.data.attributes.eventTypes).toEqual([
      ...ASC_WEBHOOK_EVENT_TYPES,
    ]);
    expect(created.data.attributes.url).toBe(
      `https://key.example.test/${SLUG}/distribution/hooks/asc`,
    );
    expect(created.data.attributes.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.data.relationships).toEqual({
      app: { data: { type: "apps", id: "1234567890" } },
    });
    expect(writes[1]!.body).toEqual({
      data: {
        type: "webhookPings",
        relationships: { webhook: { data: { type: "webhooks", id: "wh-1" } } },
      },
    });
    expect(
      `${w.fake.requests.at(-1)!.method} ${w.fake.requests.at(-1)!.path}`,
    ).toBe("GET /v1/webhooks/wh-1");
    expect(
      (await controlAudits(w)).map((r) => [r.action, r.target_id]),
    ).toEqual([["distribution.asc.webhook.register", "wh-1"]]);
    // The response carries no secret.
    expect(JSON.stringify(await res.json())).not.toContain(
      created.data.attributes.secret,
    );

    // …and a delivery signed with the secret Apple was given verifies.
    const { createHmac } = await import("node:crypto");
    const body = webhookFixture("PING");
    const sig = `hmacsha256=${createHmac("sha256", created.data.attributes.secret).update(body).digest("hex")}`;
    const hook = await deliver(w, body, sig);
    expect(hook.status).toBe(200);
  });

  it("refuses without a stored secret, telling the operator how to make one", async () => {
    const w = await ascWorld({ secret: false });
    const res = await admin(
      w,
      "POST",
      "/distribution/connectors/asc/webhook",
      {},
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "no_webhook_secret",
    );
    expect(w.fake.requests).toEqual([]);
  });

  it("generate is only for an asc-webhook-secret, and not with a value", async () => {
    const w = await ascWorld();
    expect(
      (
        await admin(w, "PUT", "/outlet-credentials/x", {
          kind: "asc-api-key",
          generate: true,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin(w, "PUT", "/outlet-credentials/x", {
          kind: "asc-webhook-secret",
          generate: true,
          value: { secret: "s" },
        })
      ).status,
    ).toBe(422);
    expect(
      (await listOutletCredentials(w.db, SLUG)).map((c) => c.id),
    ).not.toContain("x");
  });
});

describe("the console reads", () => {
  it("lists connectors with setup ids only, objects (unresolved flagged) and events", async () => {
    const w = await seeded();
    await deliver(w, webhookFixture("BACKGROUND_ASSET_VERSION_STATE_UPDATED"));
    const res = await admin(w, "GET", "/distribution/connectors");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connectors: Array<{
        kind: string;
        configured: boolean;
        setup: Record<string, unknown>;
        objects: Array<{ type: string; unresolved: boolean }>;
        unresolved: number;
        events: Array<{ type: string; outcome: string }>;
        controls: string[];
      }>;
    };
    const asc = body.connectors.find((c) => c.kind === "asc")!;
    expect(asc.configured).toBe(true);
    expect(asc.setup).toEqual({
      appleId: "1234567890",
      bundleId: "gg.acme.djdl",
      appStoreOutlet: "app-store",
      testflightOutlet: "testflight",
      apiKeyCredential: "asc",
      webhookSecretCredential: "asc-webhook",
    });
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(body)).not.toContain("whsec");
    expect(
      asc.objects.find((o) => o.type === "backgroundAssetVersions")?.unresolved,
    ).toBe(true);
    expect(asc.unresolved).toBeGreaterThanOrEqual(1);
    expect(asc.events[0]).toMatchObject({
      type: "BACKGROUND_ASSET_VERSION_STATE_UPDATED",
      outcome: "unresolved",
    });
    expect(asc.controls).toContain("webhook");

    expect((await admin(w, "GET", "/distribution/connectors/asc")).status).toBe(
      200,
    );
    expect(
      (await admin(w, "GET", "/distribution/connectors/nope")).status,
    ).toBe(404);
    expect(
      (await admin(w, "POST", "/distribution/connectors/asc/nope", {})).status,
    ).toBe(404);
  });

  it("a control on a product that is not set up answers not_configured", async () => {
    const w = await ascWorld({ apiKey: false });
    const res = await admin(w, "POST", "/distribution/connectors/asc/release", {
      releaseId: "v1.1.0",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "not_configured",
    );
  });
});

describe("version controls prove the version is this app's before writing", () => {
  const CONTROLS = [
    "release",
    "phased-release/pause",
    "phased-release/resume",
    "phased-release/complete",
  ];

  /** A stored appStoreVersions row linked to v1.1.0, held, with a phased release. */
  async function seedVersionRow(
    w: AscWorld,
    id: string,
    ascAppId: string,
  ): Promise<void> {
    await upsertObject({ db: w.db, product: SLUG, now: NOW }, "asc", {
      type: "appStoreVersions",
      id,
      outletId: "app-store",
      releaseId: "v1.1.0",
      buildId: "",
      storeState: "PENDING_DEVELOPER_RELEASE",
      state: "approved",
      ref: { ascAppId, ascVersionId: id, ascPhasedReleaseId: `phr-${id}` },
      detail: { versionString: "1.1.0", platform: "IOS" },
      terminal: false,
    });
  }

  for (const control of CONTROLS) {
    it(`${control}: a row stored for another app is never acted on`, async () => {
      // The outlet's appleId was corrected after the old app's versions were stored.
      const w = await ascWorld();
      await seedVersionRow(w, "asv-old-app", "9999999999");
      const res = await admin(
        w,
        "POST",
        `/distribution/connectors/asc/${control}`,
        { releaseId: "v1.1.0" },
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { reason: string }).reason).toBe(
        "unknown_version",
      );
      expect(w.fake.writes()).toEqual([]);
      expect(await controlAudits(w)).toEqual([]);
    });

    it(`${control}: a row Apple says is another app's version is refused before any write`, async () => {
      const w = await ascWorld();
      // The stored row claims this app; Apple's re-read says otherwise.
      w.fake.put({
        type: "appStoreVersions",
        id: "asv-foreign",
        attributes: {
          platform: "IOS",
          versionString: "1.1.0",
          appVersionState: "PENDING_DEVELOPER_RELEASE",
        },
        relationships: {
          app: { data: { type: "apps", id: "9999999999" } },
          appStoreVersionPhasedRelease: {
            data: { type: "appStoreVersionPhasedReleases", id: "phr-110" },
          },
        },
      });
      await seedVersionRow(w, "asv-foreign", "1234567890");
      const res = await admin(
        w,
        "POST",
        `/distribution/connectors/asc/${control}`,
        { releaseId: "v1.1.0" },
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { reason: string }).reason).toBe(
        "unknown_version",
      );
      expect(w.fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /v1/appStoreVersions/asv-foreign",
      ]);
      expect(w.fake.requests[0]!.query.include).toContain("app");
      expect(w.fake.writes()).toEqual([]);
      expect(await controlAudits(w)).toEqual([]);
    });
  }
});
