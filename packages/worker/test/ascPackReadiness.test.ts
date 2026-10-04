/**
 * P5-08 — App Store Connect asset-pack states feed P4-14's readiness. `djdl.foes` is required at
 * contentApi 4 and bound to `apple-ba` on the App Store outlet, so app 1.4.0 needs asset pack
 * `djdl-foes-c4` (`<pack>-c<contentApi>`, dots as hyphens). `pkey transport apple-ba upload`
 * reports the pack release with the asset-pack version it uploaded; a signed
 * `BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED` webhook then resolves to that release
 * and writes its state: `READY_FOR_DISTRIBUTION` makes the app release ready, `REJECTED` leaves it
 * blocked. An identifier that maps to another pack is never resolved. The asset-pack listing
 * shows a level that is no longer live as a retire candidate, with Apple's quotas.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { reportDistribution } from "@polaris-key/cli";
import { dispatch } from "../src/dispatch.js";
import { readinessReader } from "../src/services/distribution/readiness.js";
import { DERIVED_TRANSPORTS } from "../src/services/distribution/availability.js";
import {
  SUPPORTED_TRANSPORTS,
  transportSupported,
} from "../src/services/distribution/outlets.js";
import { appContent, CONSOLE, FOES, packWorld, SLUG } from "./packWorld.js";
import type { PackWorld, Published } from "./packWorld.js";
import { AscFake, APPLE_ID, webhookFixture } from "./ascFake.js";
import { ascP8, putCredential, sign, WEBHOOK_SECRET } from "./ascWorld.js";

afterEach(() => vi.useRealTimers());

const HOOK = `${CONSOLE}/${SLUG}/distribution/hooks/asc`;

interface World {
  w: PackWorld;
  fake: AscFake;
  foes: Published;
  app: string;
}

async function world(identifier = "djdl-foes-c4"): Promise<World> {
  const w = await packWorld();
  await w.addOutlet("app-store", "app-store", {
    appleId: APPLE_ID,
    bundleId: "gg.acme.djdl",
  });
  await w.addOutlet("testflight", "testflight", {
    appleId: APPLE_ID,
    bundleId: "gg.acme.djdl",
  });
  await w.setTransport(FOES, "app-store", "apple-ba");
  await w.setTransport(FOES, "testflight", "apple-ba");
  await putCredential(
    w,
    "asc",
    "asc-api-key",
    {
      keyId: "ABC123DEFG",
      issuerId: "69a6de7f-0000-47e3-e053-5b8c7c11a4d1",
      p8: ascP8(),
    },
    APPLE_ID,
  );
  await putCredential(w, "asc-webhook", "asc-webhook-secret", {
    secret: WEBHOOK_SECRET,
  });
  const fake = new AscFake();
  fake.set("backgroundAssets", "ba-levels", {
    assetPackIdentifier: identifier,
  });
  const foes = await w.publishPack(FOES, "1.0.0");
  const app = await w.submitApp("1.4.0", 14, appContent());
  expect(app.status, JSON.stringify(app.body)).toBe(200);
  const row = await w.db.first<{ release_id: string }>(
    "SELECT release_id FROM release_metadata WHERE product = ? AND deliverable_id = 'app'",
    SLUG,
  );
  return { w, fake, foes, app: row!.release_id };
}

function cli(w: PackWorld) {
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => dispatch(new Request(input, init), w.env, w.db)) as typeof fetch;
  return {
    product: SLUG,
    baseUrl: CONSOLE,
    env: { PKEY_CI_TOKEN: w.token },
    stdout: { write: () => true },
    stderr: { write: () => true },
    fetchImpl,
    sleep: async () => {},
  };
}

/** What `pkey transport apple-ba upload` reports after committing asset-pack version bav-1. */
async function uploadReport(
  w: PackWorld,
  foes: Published,
  outlet: string,
  state: string,
  identifier = "djdl-foes-c4",
) {
  return reportDistribution({
    ...cli(w),
    type: "availability",
    outlet,
    version: foes.version,
    deliverable: FOES,
    state,
    platformRef: JSON.stringify({
      assetPackIdentifier: identifier,
      ascBackgroundAssetId: "ba-levels",
      ascBackgroundAssetVersionId: "bav-1",
      ascVersion: 1,
      contentApi: 4,
    }),
  });
}

/** Deliver a signed webhook through the real dispatcher, App Store Connect answered by the fake. */
async function deliver(w: PackWorld, fake: AscFake, body: string) {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) =>
    fake.fetchImpl(
      String(input instanceof Request ? input.url : input),
      init,
    )) as typeof fetch;
  try {
    return await dispatch(
      new Request(HOOK, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-apple-signature": sign(body),
        },
        body,
      }),
      w.env,
      w.db,
    );
  } finally {
    globalThis.fetch = saved;
  }
}

async function readiness(w: PackWorld, appId: string) {
  const r = await readinessReader({
    db: w.db,
    product: SLUG,
    hooks: await w.hooks(),
  }).forRelease(appId);
  return r!.find((o) => o.outletId === "app-store")!;
}

async function snapshot(w: PackWorld, appId: string) {
  return w.db.first<{ state: string }>(
    "SELECT state FROM dist_readiness WHERE product = ? AND app_release_id = ? AND outlet_id = 'app-store'",
    SLUG,
    appId,
  );
}

const APP_STORE_EVENT =
  "BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED";

describe("asc → readiness (P5-08)", () => {
  it("READY_FOR_DISTRIBUTION of djdl-foes-c4 makes the app release that needs level 4 ready", async () => {
    const { w, fake, foes, app } = await world();
    const before = await readiness(w, app);
    expect(before.state).toBe("blocked");
    expect(before.blockers[0]).toMatchObject({
      reason: "awaiting-approval",
      assetPack: "djdl-foes-c4",
    });
    // The upload's reports: processing on TestFlight, pending on the App Store.
    expect((await uploadReport(w, foes, "testflight", "processing")).ok).toBe(
      true,
    );
    expect((await uploadReport(w, foes, "app-store", "pending")).ok).toBe(true);
    expect((await readiness(w, app)).state).toBe("blocked");

    fake.set("backgroundAssetVersionAppStoreReleases", "bavas-1", {
      state: "READY_FOR_DISTRIBUTION",
    });
    const res = await deliver(w, fake, webhookFixture(APP_STORE_EVENT));
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const obj = await w.db.first<{ release_id: string | null; state: string }>(
      "SELECT release_id, state FROM dist_connector_objects WHERE product = ? AND object_type = 'backgroundAssetVersionAppStoreReleases'",
      SLUG,
    );
    expect(obj).toEqual({ release_id: foes.releaseId, state: "live" });
    const avail = await w.db.first<{
      state: string;
      transport: string;
      source: string;
      platform_ref_json: string;
    }>(
      "SELECT state, transport, source, platform_ref_json FROM dist_availability WHERE product = ? AND release_id = ? AND outlet_id = 'app-store'",
      SLUG,
      foes.releaseId,
    );
    expect(avail).toMatchObject({ state: "live", transport: "apple-ba" });
    expect(JSON.parse(avail!.platform_ref_json)).toMatchObject({
      assetPackIdentifier: "djdl-foes-c4",
      ascBackgroundAssetVersionId: "bav-1",
    });
    expect(await readiness(w, app)).toMatchObject({
      state: "ready",
      blockers: [],
    });
    expect(await snapshot(w, app)).toEqual({ state: "ready" });
  });

  it("REJECTED leaves the app release blocked", async () => {
    const { w, fake, foes, app } = await world();
    await uploadReport(w, foes, "app-store", "pending");
    fake.set("backgroundAssetVersionAppStoreReleases", "bavas-1", {
      state: "REJECTED",
    });
    const res = await deliver(w, fake, webhookFixture(APP_STORE_EVENT));
    expect(res.status).toBeLessThan(300);
    const avail = await w.db.first<{ state: string }>(
      "SELECT state FROM dist_availability WHERE product = ? AND release_id = ? AND outlet_id = 'app-store'",
      SLUG,
      foes.releaseId,
    );
    expect(avail).toEqual({ state: "rejected" });
    const r = await readiness(w, app);
    expect(r.state).toBe("blocked");
    expect(r.blockers[0]).toMatchObject({ assetPack: "djdl-foes-c4" });
    expect((await snapshot(w, app))?.state).toBe("blocked");
  });

  it("an event that arrives before the upload report is linked by the report", async () => {
    const { w, fake, foes, app } = await world();
    fake.set("backgroundAssetVersionAppStoreReleases", "bavas-1", {
      state: "READY_FOR_DISTRIBUTION",
    });
    await deliver(w, fake, webhookFixture(APP_STORE_EVENT));
    const unlinked = await w.db.first<{ release_id: string | null }>(
      "SELECT release_id FROM dist_connector_objects WHERE product = ? AND object_type = 'backgroundAssetVersionAppStoreReleases'",
      SLUG,
    );
    expect(unlinked).toEqual({ release_id: null });
    await uploadReport(w, foes, "testflight", "processing");
    const linked = await w.db.first<{ release_id: string | null }>(
      "SELECT release_id FROM dist_connector_objects WHERE product = ? AND object_type = 'backgroundAssetVersionAppStoreReleases'",
      SLUG,
    );
    expect(linked).toEqual({ release_id: foes.releaseId });
    // The next read of the object writes it (a later event here; the poller's reconcile too).
    await deliver(
      w,
      fake,
      webhookFixture(APP_STORE_EVENT).replace("000000000009", "000000000010"),
    );
    expect((await readiness(w, app)).state).toBe("ready");
  });

  it("keeps one row per asset pack: a level-3 reconcile never overwrites level 4 on the same outlet", async () => {
    const { w, fake, foes, app } = await world();
    // The same pack release is also live as level 3's asset pack (another ASC resource).
    fake.put({
      type: "backgroundAssets",
      id: "ba-c3",
      attributes: { assetPackIdentifier: "djdl-foes-c3", archived: false },
      relationships: { app: { data: { type: "apps", id: APPLE_ID } } },
    });
    fake.put({
      type: "backgroundAssetVersions",
      id: "bav-c3",
      attributes: { version: "5", state: "COMPLETE", platforms: ["IOS"] },
      relationships: {
        backgroundAsset: { data: { type: "backgroundAssets", id: "ba-c3" } },
      },
    });
    fake.put({
      type: "backgroundAssetVersionAppStoreReleases",
      id: "bavas-c3",
      attributes: { state: "READY_FOR_DISTRIBUTION" },
      relationships: {
        backgroundAssetVersion: {
          data: { type: "backgroundAssetVersions", id: "bav-c3" },
        },
      },
    });
    const c3Report = (state: string) =>
      reportDistribution({
        ...cli(w),
        type: "availability",
        outlet: "app-store",
        version: foes.version,
        deliverable: FOES,
        state,
        platformRef: JSON.stringify({
          assetPackIdentifier: "djdl-foes-c3",
          ascBackgroundAssetId: "ba-c3",
          ascBackgroundAssetVersionId: "bav-c3",
          ascVersion: 5,
          contentApi: 3,
        }),
      });
    // c3 approved, c4 pending: two rows on app-store, and level 4 is still blocked.
    expect((await c3Report("approved")).ok).toBe(true);
    expect((await uploadReport(w, foes, "app-store", "pending")).ok).toBe(true);
    const rows = async () =>
      w.db.all<{ build_id: string; state: string }>(
        "SELECT build_id, state FROM dist_availability WHERE product = ? AND release_id = ? AND outlet_id = 'app-store' ORDER BY build_id",
        SLUG,
        foes.releaseId,
      );
    expect(await rows()).toEqual([
      { build_id: "djdl-foes-c3", state: "approved" },
      { build_id: "djdl-foes-c4", state: "pending" },
    ]);
    expect((await readiness(w, app)).state).toBe("blocked");

    // c4 reaches READY_FOR_DISTRIBUTION: ready.
    fake.set("backgroundAssetVersionAppStoreReleases", "bavas-1", {
      state: "READY_FOR_DISTRIBUTION",
    });
    await deliver(w, fake, webhookFixture(APP_STORE_EVENT));
    expect((await readiness(w, app)).state).toBe("ready");

    // A reconcile of level 3's asset pack writes only its own row; level 4 stays ready.
    const c3Event = webhookFixture(APP_STORE_EVENT)
      .replace("000000000009", "000000000031")
      .replaceAll("bavas-1", "bavas-c3");
    const res = await deliver(w, fake, c3Event);
    expect(res.status).toBeLessThan(300);
    expect(await rows()).toEqual([
      { build_id: "djdl-foes-c3", state: "live" },
      { build_id: "djdl-foes-c4", state: "live" },
    ]);
    expect((await readiness(w, app)).state).toBe("ready");
    expect(await snapshot(w, app)).toEqual({ state: "ready" });
  });

  it("never resolves an asset pack whose identifier maps to another pack", async () => {
    // The report names djdl.foes's release, but ASC's asset pack is foes-c4 (the old leaf
    // convention, or another pack's): the base does not match, so nothing is linked.
    const { w, fake, foes, app } = await world("foes-c4");
    await uploadReport(w, foes, "app-store", "pending", "foes-c4");
    fake.set("backgroundAssetVersionAppStoreReleases", "bavas-1", {
      state: "READY_FOR_DISTRIBUTION",
    });
    await deliver(w, fake, webhookFixture(APP_STORE_EVENT));
    const obj = await w.db.first<{ release_id: string | null }>(
      "SELECT release_id FROM dist_connector_objects WHERE product = ? AND object_type = 'backgroundAssetVersionAppStoreReleases'",
      SLUG,
    );
    expect(obj).toEqual({ release_id: null });
    expect((await readiness(w, app)).state).toBe("blocked");
  });
});

describe("asset packs and retire candidates (P5-08)", () => {
  it("lists a level that is no longer live as a candidate, with the quotas", async () => {
    const { w, fake, foes } = await world();
    // An older level's asset pack CI reported earlier (no app release is live at level 3).
    await reportDistribution({
      ...cli(w),
      type: "availability",
      outlet: "testflight",
      version: foes.version,
      deliverable: FOES,
      state: "live",
      platformRef: JSON.stringify({
        assetPackIdentifier: "djdl-foes-c3",
        ascBackgroundAssetId: "ba-old",
        ascBackgroundAssetVersionId: "bav-old",
        ascVersion: 7,
        contentApi: 3,
      }),
    });
    await uploadReport(w, foes, "app-store", "pending");
    fake.set("backgroundAssetVersionAppStoreReleases", "bavas-1", {
      state: "READY_FOR_DISTRIBUTION",
    });
    await deliver(w, fake, webhookFixture(APP_STORE_EVENT));

    const res = await w.admin("GET", "/distribution/asset-packs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.liveLevels).toEqual([4]);
    expect(body.quota).toEqual({
      packs: 2,
      maxPacks: 200,
      bytes: null,
      maxBytes: 200_000_000_000,
    });
    const byId = Object.fromEntries(
      (body.assetPacks as Record<string, any>[]).map((a) => [
        a.assetPackIdentifier,
        a,
      ]),
    );
    expect(byId["djdl-foes-c3"]).toMatchObject({
      level: 3,
      packId: FOES,
      ascBackgroundAssetId: "ba-old",
      live: false,
      retireCandidate: true,
      newestVersion: { ascBackgroundAssetVersionId: "bav-old", version: 7 },
    });
    expect(byId["djdl-foes-c4"]).toMatchObject({
      level: 4,
      packId: FOES,
      ascBackgroundAssetId: "ba-levels",
      live: true,
      retireCandidate: false,
      newestVersion: {
        ascBackgroundAssetVersionId: "bav-1",
        releaseId: foes.releaseId,
        states: {
          backgroundAssetVersionAppStoreReleases: "READY_FOR_DISTRIBUTION",
          "availability:app-store": "live",
        },
      },
    });
  });
});

describe("which transports Polaris Key acts on (P5-08)", () => {
  it("lists the store transports as supported, derives availability only for its own", async () => {
    expect([...SUPPORTED_TRANSPORTS].sort()).toEqual(
      [
        "apple-ba",
        "embedded",
        "pkey-cdn",
        "play-pad",
        "steam-depot",
        "web",
      ].sort(),
    );
    expect(
      DERIVED_TRANSPORTS.every((t) => SUPPORTED_TRANSPORTS.includes(t)),
    ).toBe(true);
    for (const t of ["apple-ba", "play-pad", "steam-depot"]) {
      expect(transportSupported(t)).toBe(true);
      expect(DERIVED_TRANSPORTS).not.toContain(t);
    }
    // No work package implements these yet: stored and listed, unsupported.
    for (const t of ["msix-optional", "flatpak-ext", "made-up"])
      expect(transportSupported(t)).toBe(false);

    // The console's outlet listing marks djdl.foes's apple-ba binding supported, and no
    // availability is derived for it: only reports (CI, the connector) say where it stands.
    const { w, foes } = await world();
    const res = await w.admin("GET", "/distribution/outlets");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outlets: Array<{
        outletId: string;
        transports: Array<{
          deliverableId: string;
          transport: string;
          supported: boolean;
        }>;
      }>;
    };
    const store = body.outlets.find((o) => o.outletId === "app-store")!;
    expect(store.transports.find((t) => t.deliverableId === FOES)).toEqual({
      deliverableId: FOES,
      transport: "apple-ba",
      supported: true,
    });
    expect(
      await w.db.first(
        "SELECT 1 FROM dist_availability WHERE product = ? AND release_id = ?",
        SLUG,
        foes.releaseId,
      ),
    ).toBeNull();
  });
});
