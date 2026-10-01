/**
 * P5-03 — the Google Play poller on the connector cron, against the fake Google: the throwaway
 * edit (insert → tracks.list → delete), the mapping into availability, connector objects and
 * mirrored outlet rollouts, an internal track whose id comes only from tracks.list, an edit
 * invalidated mid-poll, 429 backoff, and the credential reached only through P5-01.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listOutletCredentials } from "../src/core/outletCredentials.js";
import { CONNECTOR_POLL_CRON, handleScheduled } from "../src/scheduled.js";
import { pollConnectors } from "../src/services/distribution/connectors/index.js";
import { loadProductPublic } from "../src/core/products.js";
import { buildHooks } from "../src/core/hooks.js";
import { SERVICES } from "../src/mount.js";
import { applyRollout } from "../src/services/distribution/rollouts.js";
import {
  audits,
  availability,
  playWorld,
  poll,
  rollouts,
  trackObjects,
  withFetch,
  NOW,
  PLAY_PACKAGE,
  SLUG,
  type PlayWorld,
} from "./playWorld.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Poll one product through `pollConnectors` with injected fetch and sleep. */
async function pollDirect(w: PlayWorld, now = NOW) {
  const product = (await loadProductPublic(w.db, SLUG))!;
  const hooks = buildHooks(SERVICES, product.services, {
    env: w.env,
    db: w.db,
    product,
    now,
  });
  const outcomes = await pollConnectors({
    env: w.env,
    db: w.db,
    product,
    hooks,
    now,
    fetchImpl: w.fetchImpl,
    sleep: async (ms) => {
      w.sleeps.push(ms);
    },
  });
  return outcomes.find((o) => o.connector === "play")!;
}

const publisherCalls = (w: PlayWorld) =>
  w.fake.requests
    .filter((r) => r.host === "androidpublisher.googleapis.com")
    .map((r) => `${r.method} ${r.path.replace(/edits\/\d+/, "edits/<id>")}`);

describe("the poll", () => {
  it("reads one throwaway edit — insert, tracks.list, delete — and leaves none open", async () => {
    const w = await playWorld();
    const report = await poll(w);
    expect(report.failures).toEqual({});
    expect(publisherCalls(w)).toEqual([
      "POST edits",
      "GET edits/<id>/tracks",
      "DELETE edits/<id>",
    ]);
    expect(w.fake.openEdits()).toEqual([]);
    // Every request carried a publisher-scoped token minted from the service account.
    expect(w.fake.tokenRequests).toEqual([
      {
        iss: "pkey-release@acme-djdl.iam.gserviceaccount.com",
        scope: "https://www.googleapis.com/auth/androidpublisher",
      },
    ]);
    expect(w.fake.foreignHost).toEqual([]);
    expect(
      w.fake.requests.every((r) =>
        r.authorization?.startsWith("Bearer ya29.test-"),
      ),
    ).toBe(true);
  });

  it("maps every track release onto availability by version code = build number (android)", async () => {
    const w = await playWorld();
    await poll(w);
    const rows = await availability(w.db);
    expect(
      rows.map((r) => [
        r.outlet_id,
        r.release_id,
        r.build_id,
        r.state,
        r.source,
      ]),
    ).toEqual([
      ["play", "v1.0.0", "android", "live", "play"],
      ["play", "v1.1.0", "android-arm64", "live", "play"],
      ["play", "v1.1.0", "android-armv7", "live", "play"],
    ]);
    const arm64 = rows.find((r) => r.build_id === "android-arm64")!;
    expect(JSON.parse(arm64.platform_ref_json!)).toEqual({
      packageName: PLAY_PACKAGE,
      versionCode: "111",
      track: "production",
    });
    expect(JSON.parse(arm64.detail_json!)).toMatchObject({
      track: "production",
      playStatus: "inProgress",
      userFraction: 0.05,
      inAppUpdatePriority: 2,
      versionCodes: ["110", "111"],
    });
  });

  it("mirrors each mapped track as an outlet rollout: userFraction 0.05 → 500 bp, completed → 10000", async () => {
    const w = await playWorld();
    await poll(w);
    expect(await rollouts(w.db)).toEqual([
      {
        release_id: "v1.1.0",
        outlet_id: "play",
        channel: "beta",
        rollout_bp: 10000,
        state: "complete",
        mirrored: 1,
        source: "play",
      },
      {
        release_id: "v1.1.0",
        outlet_id: "play",
        channel: "stable",
        rollout_bp: 500,
        state: "active",
        mirrored: 1,
        source: "play",
      },
    ]);
  });

  it("a track release naming two version codes makes both builds available and one rollout", async () => {
    const w = await playWorld();
    await poll(w);
    const production = (await trackObjects(w.db)).find(
      (t) => t.object_id === "production",
    )!;
    expect(production.release_id).toBe("v1.1.0");
    const detail = JSON.parse(production.detail_json) as {
      releases: Array<{ versionCodes: string[]; builds: unknown[] }>;
    };
    expect(detail.releases[0]).toMatchObject({
      versionCodes: ["110", "111"],
      releaseId: "v1.1.0",
      builds: [
        { releaseId: "v1.1.0", buildId: "android-armv7" },
        { releaseId: "v1.1.0", buildId: "android-arm64" },
      ],
    });
    const v110 = (await availability(w.db)).filter(
      (r) => r.release_id === "v1.1.0",
    );
    expect(v110.map((r) => r.build_id).sort()).toEqual([
      "android-arm64",
      "android-armv7",
    ]);
    expect(
      (await rollouts(w.db)).filter((r) => r.channel === "stable"),
    ).toHaveLength(1);
  });

  it("maps all four status values", async () => {
    const w = await playWorld();
    w.fake.setTrack("production", [
      {
        name: "1.1.0",
        versionCodes: ["111"],
        status: "halted",
        userFraction: 0.2,
      },
      { name: "1.0.0", versionCodes: ["100"], status: "completed" },
    ]);
    w.fake.setTrack("beta", [
      { name: "1.1.0", versionCodes: ["110"], status: "draft" },
    ]);
    await poll(w);
    const rows = await availability(w.db);
    expect(rows.map((r) => [r.build_id, r.state])).toEqual([
      ["android", "live"], // completed
      ["android-arm64", "approved"], // halted: not served to anyone new
      ["android-armv7", "pending"], // draft: not served
    ]);
    // halted → halted at its fraction; the draft-only beta track mirrors nothing.
    expect(await rollouts(w.db)).toEqual([
      expect.objectContaining({
        channel: "stable",
        release_id: "v1.1.0",
        state: "halted",
        rollout_bp: 2000,
      }),
    ]);
    // inProgress → active
    w.fake.setTrack("production", [
      {
        name: "1.1.0",
        versionCodes: ["111"],
        status: "inProgress",
        userFraction: 0.5,
      },
      { name: "1.0.0", versionCodes: ["100"], status: "completed" },
    ]);
    await poll(w, NOW + 900);
    expect((await rollouts(w.db))[0]).toMatchObject({
      state: "active",
      rollout_bp: 5000,
    });
    // completed → complete, and the old completed release leaves the track: removed.
    w.fake.setTrack("production", [
      { name: "1.1.0", versionCodes: ["111"], status: "completed" },
    ]);
    await poll(w, NOW + 1800);
    expect((await rollouts(w.db))[0]).toMatchObject({
      state: "complete",
      rollout_bp: 10000,
    });
    expect(
      (await availability(w.db)).map((r) => [r.build_id, r.state]),
    ).toEqual([
      ["android", "removed"],
      ["android-arm64", "live"],
      ["android-armv7", "pending"],
    ]);
  });

  it("an internal track id read from tracks.list is stored and shown but writes nothing until an outlet maps it", async () => {
    const w = await playWorld();
    await poll(w);
    const qa = (await trackObjects(w.db)).find((t) => t.object_id === "qa")!;
    expect(qa).toMatchObject({ outlet_id: null, release_id: null });
    expect(JSON.parse(qa.detail_json)).toMatchObject({ mapped: false });
    expect((await availability(w.db)).some((r) => r.outlet_id !== "play")).toBe(
      false,
    );

    // A play-testing outlet maps the internal channel to whatever id Play listed ("qa" here,
    // "internal" elsewhere): nothing in the connector names either.
    const w2 = await playWorld({
      extraOutlets: [
        {
          id: "play-internal",
          kind: "play-testing",
          identity: { packageName: PLAY_PACKAGE, tracks: { internal: "qa" } },
        },
      ],
    });
    await poll(w2);
    const internal = (await availability(w2.db)).filter(
      (r) => r.outlet_id === "play-internal",
    );
    expect(internal.map((r) => [r.release_id, r.build_id, r.state])).toEqual([
      ["v1.1.0", "android-arm64", "live"],
    ]);
    // 1.2.0-rc.1 (version code 120) is a draft no build claims: shown, unresolved.
    const qa2 = (await trackObjects(w2.db)).find((t) => t.object_id === "qa")!;
    expect(qa2.outlet_id).toBe("play-internal");
    expect(
      (await rollouts(w2.db)).find((r) => r.outlet_id === "play-internal"),
    ).toMatchObject({ channel: "internal", state: "complete" });
  });

  it("an edit invalidated mid-poll writes nothing; the next tick retries and writes", async () => {
    const w = await playWorld();
    w.fake.invalidateOnNextList();
    const outcome = await pollDirect(w);
    expect(outcome.error).toBe("Google Play GET edits.tracks.list: HTTP 400");
    expect(publisherCalls(w)).toEqual([
      "POST edits",
      "GET edits/<id>/tracks",
      "DELETE edits/<id>",
    ]);
    expect(await availability(w.db)).toEqual([]);
    expect(await rollouts(w.db)).toEqual([]);
    expect(await trackObjects(w.db)).toEqual([]);
    expect(
      (await audits(w.db)).filter((a) => a.action.startsWith("distribution.")),
    ).toEqual([]);
    // The failure is the credential's health line (status only).
    const [cred] = await listOutletCredentials(w.db, SLUG);
    expect(cred!.lastError).toBe("Google Play GET edits.tracks.list: HTTP 400");

    const next = await pollDirect(w, NOW + 900);
    expect(next.error).toBeUndefined();
    expect((await availability(w.db)).length).toBe(3);
    expect((await rollouts(w.db)).length).toBe(2);
    const [after] = await listOutletCredentials(w.db, SLUG);
    expect(after!.lastError).toBeNull();
    expect(after!.lastOkAt).toBe(NOW + 900);
  });

  it("backs off on 429 (Retry-After) and succeeds; exhausted retries write nothing", async () => {
    const w = await playWorld();
    w.fake.fail429(2);
    const outcome = await pollDirect(w);
    expect(outcome.error).toBeUndefined();
    expect(w.sleeps).toEqual([0, 0]); // Retry-After: 0, twice
    expect(publisherCalls(w)).toEqual([
      "POST edits",
      "POST edits",
      "POST edits",
      "GET edits/<id>/tracks",
      "DELETE edits/<id>",
    ]);
    expect((await availability(w.db)).length).toBe(3);

    const w2 = await playWorld();
    w2.fake.fail429(3);
    const failed = await pollDirect(w2);
    expect(failed.error).toBe("Google Play POST edits.insert: HTTP 429");
    expect(await availability(w2.db)).toEqual([]);
    expect(await rollouts(w2.db)).toEqual([]);
  });

  it("a second tick over unchanged state writes no audit row and leaves the rows as they were", async () => {
    const w = await playWorld();
    await poll(w);
    const before = (await audits(w.db)).length;
    await poll(w, NOW + 900);
    const added = (await audits(w.db)).slice(before);
    // Only the cache-hit-free path: no credential open (token cached), no state change audits.
    expect(added.filter((a) => a.action !== "outlet_credential.use")).toEqual(
      [],
    );
    expect(added).toEqual([]);
  });

  it("reaches the credential only through P5-01: one audited open, then the sealed token cache", async () => {
    const w = await playWorld();
    await poll(w);
    await poll(w, NOW + 900);
    const opens = (await audits(w.db)).filter(
      (a) => a.action === "outlet_credential.use",
    );
    expect(opens).toEqual([
      {
        action: "outlet_credential.use",
        actor_sub: "system:distribution",
        target_id: "play",
        summary: "play:poll: opened",
      },
    ]);
    expect(w.fake.tokenRequests).toHaveLength(1);
  });

  it("no Play connector file opens a sealed value or names the credential table itself", () => {
    const dir = join(
      dirname(fileURLToPath(import.meta.url)),
      "../src/services/distribution/connectors/play",
    );
    for (const name of readdirSync(dir)) {
      // Code only: a doc comment may name the table it explains.
      const src = readFileSync(join(dir, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src, name).not.toMatch(/keyvault|\bopen\s*\(|\bseal\s*\(/);
      expect(src, name).not.toMatch(/\boutlet_credentials\b/);
      expect(src, name).not.toMatch(/readSealedToken|writeSealedToken/);
    }
    // The one way in: googleAccessToken (core/outletTokens.ts), which opens through
    // openOutletCredential on a cache miss.
    expect(readFileSync(join(dir, "run.ts"), "utf8")).toMatch(
      /import \{ googleAccessToken \} from "..\/..\/..\/..\/core\/outletTokens.js"/,
    );
  });

  it("a mirrored Play rollout refuses direct edits (change it through the connector)", async () => {
    const w = await playWorld();
    await poll(w);
    const product = (await loadProductPublic(w.db, SLUG))!;
    const hooks = buildHooks(SERVICES, product.services, {
      env: w.env,
      db: w.db,
      product,
      now: NOW,
    });
    const r = await applyRollout(
      { db: w.db, product: SLUG, hooks, now: NOW },
      "halt",
      { outlet: "play", channel: "stable" },
      {
        kind: "admin",
        session: { sub: "u1", name: "Ada", email: null } as never,
      },
    );
    expect(r).toMatchObject({ ok: false, reason: "rollout_mirrored" });
  });
});

describe("setup", () => {
  it("skips a product with no Play outlet or no credential before any call", async () => {
    for (const w of [
      await playWorld({ outlets: false }),
      await playWorld({ credential: false }),
    ]) {
      const outcome = await pollDirect(w);
      expect(outcome).toEqual({
        connector: "play",
        skipped: "not-configured",
        calls: 0,
        applied: 0,
      });
      expect(w.fake.requests).toEqual([]);
      expect(w.fake.tokenRequests).toEqual([]);
    }
  });

  it("an outlet naming another package is not this connector's", async () => {
    const w = await playWorld({
      extraOutlets: [
        {
          id: "play-other",
          kind: "play-testing",
          identity: { packageName: "gg.other.app", tracks: { internal: "qa" } },
        },
      ],
    });
    await poll(w);
    expect(w.fake.requests.every((r) => !r.path.includes("gg.other.app"))).toBe(
      true,
    );
    expect(
      (await availability(w.db)).some((r) => r.outlet_id === "play-other"),
    ).toBe(false);
  });
});

describe("the connector cron", () => {
  it("handleScheduled on CONNECTOR_POLL_CRON runs the Play poll", async () => {
    const w = await playWorld();
    await withFetch(w, () => handleScheduled(w.env, w.db, CONNECTOR_POLL_CRON));
    expect(publisherCalls(w)[0]).toBe("POST edits");
    expect((await availability(w.db)).length).toBe(3);
  });

  it("a failed Play read fails the invocation with a status line", async () => {
    const w = await playWorld();
    w.fake.invalidateOnNextList();
    await expect(
      withFetch(w, () => handleScheduled(w.env, w.db, CONNECTOR_POLL_CRON)),
    ).rejects.toThrow(/play: Google Play GET edits\.tracks\.list: HTTP 400/);
  });
});
