/**
 * P3-03 — the signed channel feed (`GET /<p>/update/<channel>/feed.jws?platform=`) and the
 * record route (`GET /<p>/release/records/<sha256>`) through the real dispatcher, over releases
 * published with CI-signed records through the real submit route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import { feedClaims } from "@polaris-key/client-core/feed";
import { MAX_WIRE_INTEGER } from "@polaris-key/protocol/core";
import { installDigestStream } from "./r2Mock.js";
import { NOW, TEST_KID, TEST_PUB } from "./seed.js";
import { call, CONSOLE, SLUG } from "./releaseRoutesFixture.js";
import {
  feedWorld,
  getFeed,
  markLive,
  noFetch,
  publish,
  setRollout,
  sha,
  type FeedWorld,
} from "./feedWorld.js";
import { stmtSetChannelPolicy } from "../src/services/release/model.js";
import { RESIGN_AFTER_SECONDS } from "../src/services/update/feedDoc.js";
import { composeChannelFeed } from "../src/services/update/compose.js";
import { getReleaseConfig } from "../src/services/release/config.js";

installDigestStream();

const TRUST = { [TEST_KID]: TEST_PUB };

let w: FeedWorld;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  w = await feedWorld();
});
afterEach(() => vi.useRealTimers());

function tick(seconds: number): void {
  w.now += seconds;
  vi.setSystemTime(w.now * 1000);
}

async function setPolicy(
  channel: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const s = stmtSetChannelPolicy(
    { product: SLUG, deliverableId: "app", channel },
    patch as never,
    { source: "admin", by: "u1", now: w.now },
  );
  await w.db.run(s.sql, ...s.params);
}

function target(payload: Record<string, any>, platform: string) {
  return payload.app.targets.find((t: any) => t.platform === platform);
}

describe("GET /update/<channel>/feed.jws", () => {
  it("serves a pkey-feed+jws that verifies against the product's keys, with exactly the plan's fields", async () => {
    const p = await publish(w, "1.3.0");
    const { res, jws, payload } = await getFeed(w, "stable");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jose");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, no-transform",
    );
    const v = await verifyJws(jws, TRUST, { typ: "pkey-feed+jws" });
    expect(v).not.toBeNull();
    expect(
      feedClaims(v!.payload, {
        expectedAud: SLUG,
        channel: "stable",
        platform: "macos",
        nonWire: v!.nonWireIntegers,
      }),
    ).toBeNull();
    expect(Object.keys(payload!)).toEqual([
      "schemaVersion",
      "iss",
      "aud",
      "channel",
      "selector",
      "seq",
      "issuedAt",
      "expiresAt",
      "app",
    ]);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      iss: "key.plrs.im",
      aud: SLUG,
      channel: "stable",
      selector: {},
      seq: 1,
      issuedAt: NOW,
      expiresAt: NOW + 900,
      app: { deliverable: "app", versionScheme: "semver" },
    });
    // Targets in RELEASE_PLATFORMS order, each pinning the CI-signed record.
    expect(payload!.app.targets.map((t: any) => t.platform)).toEqual([
      "macos",
      "ios",
      "web",
    ]);
    const mac = target(payload!, "macos");
    expect(mac).toEqual({
      platform: "macos",
      release: { sha256: p.recordSha, seq: 1, version: "1.3.0" },
      floor: null,
      critical: false,
      outlets: {
        // Self-hosted: derived live. App Store and TestFlight serve macOS too, with nothing live.
        "app-store": {
          kind: "app-store",
          live: null,
          halted: false,
          listingUrl: "https://apps.apple.com/app/id1234567890",
        },
        direct: {
          kind: "direct",
          live: { version: "1.3.0", seq: 1 },
          halted: false,
        },
        testflight: {
          kind: "testflight",
          live: null,
          halted: false,
          listingUrl: "https://testflight.apple.com/join/AbCdEf12",
        },
      },
    });
    // Web: only the `web` outlet serves it.
    expect(Object.keys(target(payload!, "web").outlets)).toEqual(["web"]);
  });

  it("signs the canonical channel: `latest` is `stable`, `staging` is `beta`", async () => {
    await publish(w, "1.3.0");
    const latest = await getFeed(w, "latest");
    expect(latest.payload!.channel).toBe("stable");
    const stable = await getFeed(w, "stable");
    // One channel, one seq and one stored document.
    expect(stable.jws).toBe(latest.jws);
    const staging = await getFeed(w, "staging");
    expect(staging.payload!.channel).toBe("beta");
    // A manual channel signs under its own name.
    expect((await getFeed(w, "qa")).payload!.channel).toBe("qa");
  });

  it("an unknown channel, and a missing or unknown platform, are the plain 404", async () => {
    await publish(w, "1.3.0");
    expect((await getFeed(w, "nightly")).res.status).toBe(404);
    expect((await getFeed(w, "stable", "playstation")).res.status).toBe(404);
    const res = await call(
      w.env,
      w.db,
      noFetch,
      `${CONSOLE}/${SLUG}/update/stable/feed.jws`,
    );
    expect(res.status).toBe(404);
  });

  it("two requests with no change return the same seq (and, within 450 s, the same bytes)", async () => {
    await publish(w, "1.3.0");
    const a = await getFeed(w, "stable");
    tick(10);
    const b = await getFeed(w, "stable");
    expect(b.jws).toBe(a.jws);
    tick(RESIGN_AFTER_SECONDS);
    const c = await getFeed(w, "stable");
    expect(c.jws).not.toBe(a.jws);
    expect(c.payload!.seq).toBe(a.payload!.seq);
    expect(c.payload!.issuedAt).toBe(w.now);
  });

  it("a pointer move, a floor change, a rollout change and a halt each raise seq by one", async () => {
    const r1 = await publish(w, "1.3.0");
    const r2 = await publish(w, "1.4.0");
    let seq = (await getFeed(w, "stable")).payload!.seq;
    expect(
      target((await getFeed(w, "stable")).payload!, "macos").release.version,
    ).toBe("1.4.0");

    // Pointer: pin the channel to 1.3.0.
    await setPolicy("stable", { pointerReleaseId: r1.releaseId, pinned: true });
    let f = (await getFeed(w, "stable")).payload!;
    expect(f.seq).toBe(++seq);
    expect(target(f, "macos").release.version).toBe("1.3.0");
    await setPolicy("stable", { pointerReleaseId: null, pinned: false });
    f = (await getFeed(w, "stable")).payload!;
    expect(f.seq).toBe(++seq);

    // Floor.
    await setPolicy("stable", { minSupported: "1.3.0" });
    f = (await getFeed(w, "stable")).payload!;
    expect(f.seq).toBe(++seq);
    expect(target(f, "macos").floor).toEqual({ minVersion: "1.3.0" });

    // Rollout on the direct outlet for the target release.
    await setRollout(w, {
      outlet: "direct",
      channel: "stable",
      releaseId: r2.releaseId,
      bp: 2500,
    });
    f = (await getFeed(w, "stable")).payload!;
    expect(f.seq).toBe(++seq);
    await setRollout(w, {
      outlet: "direct",
      channel: "stable",
      releaseId: r2.releaseId,
      bp: 5000,
    });
    f = (await getFeed(w, "stable")).payload!;
    expect(f.seq).toBe(++seq);

    // Halt.
    await setRollout(w, {
      outlet: "direct",
      channel: "stable",
      releaseId: r2.releaseId,
      bp: 5000,
      state: "halted",
    });
    f = (await getFeed(w, "stable")).payload!;
    expect(f.seq).toBe(++seq);
    // And nothing else moves it.
    expect((await getFeed(w, "stable")).payload!.seq).toBe(seq);
  });

  it("a halted outlet, a partial rollout and an outlet still serving an older release", async () => {
    const r1 = await publish(w, "1.3.0");
    const r2 = await publish(w, "1.4.0");
    // App Store: 1.3.0 is live on iOS, 1.4.0 is not yet.
    await markLive(w, r1.releaseId, "app-store", "ios");
    // TestFlight: 1.4.0 is live and halted.
    await markLive(w, r2.releaseId, "testflight");
    await setRollout(w, {
      outlet: "testflight",
      channel: "stable",
      releaseId: r2.releaseId,
      bp: 10000,
      state: "halted",
    });
    // Direct: a partial, client-evaluated rollout of 1.4.0.
    await setRollout(w, {
      outlet: "direct",
      channel: "stable",
      releaseId: r2.releaseId,
      bp: 2500,
      salt: "ffeeddccbbaa99887766554433221100",
    });
    // A mirrored (store-owned) rollout is never client-evaluated.
    await setRollout(w, {
      outlet: "app-store",
      channel: "stable",
      releaseId: r2.releaseId,
      bp: 1000,
      mirrored: true,
    });
    const f = (await getFeed(w, "stable", "ios")).payload!;
    const ios = target(f, "ios");
    expect(ios.release.version).toBe("1.4.0");
    expect(ios.outlets["app-store"]).toEqual({
      kind: "app-store",
      live: { version: "1.3.0", seq: r1.seq },
      halted: false,
      listingUrl: "https://apps.apple.com/app/id1234567890",
    });
    expect(ios.outlets.testflight).toMatchObject({
      live: { version: "1.4.0", seq: r2.seq },
      halted: true,
    });
    expect(ios.outlets.testflight.rollout).toBeUndefined();
    // The store-only iOS build has no bytes, so the direct outlet has nothing live on iOS.
    expect(ios.outlets.direct).toEqual({
      kind: "direct",
      live: null,
      halted: false,
      rollout: { bp: 2500, salt: "ffeeddccbbaa99887766554433221100" },
    });
    const mac = target(f, "macos");
    expect(mac.outlets.direct.live).toEqual({ version: "1.4.0", seq: r2.seq });
    expect(mac.outlets.direct.rollout).toEqual({
      bp: 2500,
      salt: "ffeeddccbbaa99887766554433221100",
    });
  });

  it("a rollout of another release than the target is not the target's", async () => {
    const r1 = await publish(w, "1.3.0");
    await publish(w, "1.4.0");
    await setRollout(w, {
      outlet: "direct",
      channel: "stable",
      releaseId: r1.releaseId,
      bp: 10,
      state: "halted",
    });
    const mac = target((await getFeed(w, "stable")).payload!, "macos");
    expect(mac.outlets.direct.halted).toBe(false);
    expect(mac.outlets.direct.rollout).toBeUndefined();
  });

  it("critical applies to the pointer release only; the record's minSupportedSeq floors its own targets, clipped", async () => {
    const r1 = await publish(w, "1.3.0");
    await publish(w, "1.4.0", { platforms: ["web", "ios"] }); // no macOS build
    const r3 = await publish(w, "1.5.0", { minSupportedSeq: 2 });
    await setPolicy("stable", {
      pointerReleaseId: r3.releaseId,
      critical: true,
    });
    const f = (await getFeed(w, "stable")).payload!;
    // macOS: the smallest seq from 2 to 3 with a macOS build is 1.5.0 itself.
    expect(target(f, "macos")).toMatchObject({
      critical: true,
      floor: { minVersion: "1.5.0" },
    });
    // iOS: 1.4.0 (seq 2) has an iOS build.
    expect(target(f, "ios").floor).toEqual({ minVersion: "1.4.0" });
    // A policy floor above the pin is clipped to it.
    await setPolicy("stable", { minSupported: "9.0.0" });
    const g = (await getFeed(w, "stable")).payload!;
    expect(target(g, "ios").floor).toEqual({ minVersion: "1.5.0" });
    expect(r1.seq).toBe(1);
  });

  it("a release with no record is no target; a product with no releaseKeys has an empty feed", async () => {
    await publish(w, "1.3.0", { record: false });
    const f = (await getFeed(w, "stable")).payload!;
    expect(f.app.targets).toEqual([]);
  });

  it("without the delivery hook every target's outlets are empty: fail closed", async () => {
    await publish(w, "1.3.0");
    // Update requires Distribution, so the route is unreachable with it off; the composer itself
    // still answers with no per-outlet state when the hook is null.
    const cfg = await getReleaseConfig(w.db, SLUG);
    const composed = await composeChannelFeed(
      {
        db: w.db,
        product: SLUG,
        cfg: cfg!,
        hooks: {
          releaseCatalog: () => null,
          delivery: () => null,
          outletCapabilities: async () => null,
          licenseProvenance: () => null,
        },
      },
      "stable",
    );
    expect(composed!.targets.map((t) => t.outlets)).toEqual([{}, {}, {}]);
  });

  it("splits into per-platform documents past 64 KiB, and refuses (500 feed_not_composable) a platform document that still does not fit", async () => {
    await publish(w, "1.3.0");
    const insert = async (prefix: string, n: number, kind: string) => {
      for (let i = 0; i < n; i++)
        await w.db.run(
          `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
           VALUES (?, ?, ?, '{}', ?, ?)`,
          SLUG,
          `${prefix}-${String(i).padStart(4, "0")}`,
          kind,
          NOW,
          NOW,
        );
    };
    // ~60 bytes per entry: 1300 extra macOS outlets overflow the channel-wide document, while
    // the web document stays small.
    await insert("mac-mirror", 1300, "steam");
    const web = await getFeed(w, "stable", "web");
    expect(web.res.status).toBe(200);
    expect(web.payload!.selector).toEqual({ platform: "web" });
    expect(web.payload!.app.targets.map((t: any) => t.platform)).toEqual([
      "web",
    ]);
    const mac = await getFeed(w, "stable", "macos");
    expect(mac.res.status).toBe(500);
    expect(JSON.parse(mac.jws)).toEqual({
      error: { code: "feed_not_composable" },
    });
  });

  it("under `entitled`, the canonical channel's grant is checked before anything is served", async () => {
    await publish(w, "1.3.0");
    await w.db.run(
      "UPDATE release_config SET metadata_access = 'entitled' WHERE product = ?",
      SLUG,
    );
    const res = await getFeed(w, "latest");
    expect(res.res.status).toBe(401);
    expect(JSON.parse(res.jws)).toEqual({ error: { code: "unauthorized" } });
  });

  it("a channel that offers nothing and has no row is signed at seq 1 and stores nothing", async () => {
    const rows = async () => ({
      state: (
        await w.db.all(
          "SELECT channel FROM update_feed_state WHERE product = ?",
          SLUG,
        )
      ).length,
      docs: (
        await w.db.all(
          "SELECT channel FROM update_feed_docs WHERE product = ?",
          SLUG,
        )
      ).length,
    });
    // A product with no app release yet.
    const none = await getFeed(w, "stable");
    expect(none.res.status).toBe(200);
    expect(none.payload!.seq).toBe(1);
    expect(none.payload!.app.targets).toEqual([]);
    const v = await verifyJws(none.jws, TRUST, { typ: "pkey-feed+jws" });
    expect(v).not.toBeNull();
    expect(
      feedClaims(v!.payload, {
        expectedAud: SLUG,
        channel: "stable",
        platform: "macos",
        nonWire: v!.nonWireIntegers,
      }),
    ).toBeNull();
    expect(await rows()).toEqual({ state: 0, docs: 0 });

    // Unused `pr-<n>` spellings and an unused manual channel, with releases on stable.
    await publish(w, "1.3.0");
    for (const ch of ["pr-1", "pr-01", "pr-0000001", "pr-9999999", "qa"]) {
      const f = await getFeed(w, ch);
      expect(f.res.status).toBe(200);
      expect(f.payload!.seq).toBe(1);
      expect(f.payload!.app.targets).toEqual([]);
    }
    expect(await rows()).toEqual({ state: 0, docs: 0 });

    // A channel with content gets its row and stored document as before.
    await getFeed(w, "stable");
    expect(await rows()).toEqual({ state: 1, docs: 1 });
  });

  it("the seq ceiling flag: a channel with no row starts at MAX_WIRE_INTEGER", async () => {
    await publish(w, "1.3.0");
    await w.db.run(
      "INSERT INTO update_feed_ceiling (product, set_at) VALUES (?, ?)",
      SLUG,
      NOW,
    );
    const f = (await getFeed(w, "qa")).payload!;
    expect(f.seq).toBe(MAX_WIRE_INTEGER);
    // The channel's first real content: its new row starts at the ceiling.
    tick(5);
    await publish(w, "1.4.0", { channel: "qa" });
    const g = (await getFeed(w, "qa")).payload!;
    expect(g.seq).toBe(MAX_WIRE_INTEGER);
    expect(g.issuedAt).toBeGreaterThan(f.issuedAt);
    expect(target(g, "ios").release.version).toBe("1.4.0");
    // A change of content at the ceiling re-signs at the ceiling with a newer issuedAt.
    tick(5);
    await publish(w, "1.5.0", { channel: "qa" });
    const h = (await getFeed(w, "qa")).payload!;
    expect(h.seq).toBe(MAX_WIRE_INTEGER);
    expect(h.issuedAt).toBeGreaterThan(g.issuedAt);
    expect(target(h, "ios").release.version).toBe("1.5.0");
    // The Worker has no log sink: the re-signing at the ceiling is in the audit trail.
    const audit = await w.db.all<{ target_id: string }>(
      "SELECT target_id FROM audit WHERE product = ? AND action = 'update.feed.ceiling'",
      SLUG,
    );
    expect(audit).toEqual([{ target_id: "qa" }]);
  });
});

describe("GET /release/records/<sha256>", () => {
  it("returns the stored bytes, whose SHA-256 is the path, as application/jose with immutable caching", async () => {
    const p = await publish(w, "1.3.0");
    const res = await call(
      w.env,
      w.db,
      noFetch,
      `${CONSOLE}/${SLUG}/release/records/${p.recordSha}`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(sha(body)).toBe(p.recordSha);
    expect(res.headers.get("content-type")).toBe("application/jose");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    expect(res.headers.get("etag")).toBe(`"${p.recordSha}"`);
    const again = await call(
      w.env,
      w.db,
      noFetch,
      `${CONSOLE}/${SLUG}/release/records/${p.recordSha}`,
      { headers: { "if-none-match": `"${p.recordSha}"` } },
    );
    expect(again.status).toBe(304);
    const head = await call(
      w.env,
      w.db,
      noFetch,
      `${CONSOLE}/${SLUG}/release/records/${p.recordSha}`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("an unknown hash is the plain 404, and so is a malformed one", async () => {
    await publish(w, "1.3.0");
    for (const h of ["a".repeat(64), "A".repeat(64), "abc"]) {
      const res = await call(
        w.env,
        w.db,
        noFetch,
        `${CONSOLE}/${SLUG}/release/records/${h}`,
      );
      expect(res.status).toBe(404);
    }
  });

  it("the metadata access mode applies, before an unknown hash is told apart", async () => {
    const p = await publish(w, "1.3.0");
    await w.db.run(
      "UPDATE release_config SET metadata_access = 'authenticated' WHERE product = ?",
      SLUG,
    );
    for (const h of [p.recordSha, "a".repeat(64)]) {
      const res = await call(
        w.env,
        w.db,
        noFetch,
        `${CONSOLE}/${SLUG}/release/records/${h}`,
      );
      expect(res.status).toBe(401);
    }
  });
});
