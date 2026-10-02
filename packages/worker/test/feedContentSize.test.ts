/**
 * P4-13 — the feed's content members under the 65,536-byte payload cap (plans/P4-13.md §6.3,
 * decision 13). `documentFor` signs the channel-wide document while it fits, else the platform's,
 * and then sheds content in a fixed order (packSets, packFloors, unreferenced revocations, every
 * revocation), auditing each step; content alone never makes a feed uncomposable.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { feedContent } from "@polaris-key/client-core/feed";
import { packSetId } from "@polaris-key/client-core/packs";
import type {
  FeedPackFloor,
  FeedPackSets,
  FeedRevocation,
  FeedTarget,
} from "@polaris-key/protocol/update";
import {
  documentFor,
  feedSelfCheck,
  MAX_FEED_PAYLOAD_BYTES,
} from "../src/services/update/feedDoc.js";
import type { ComposedFeed } from "../src/services/update/compose.js";

const PLATFORMS = ["macos", "windows", "linux", "android", "ios", "web"];
const hex = (s: string): string => createHash("sha256").update(s).digest("hex");
const bytes = (v: unknown): number =>
  new TextEncoder().encode(JSON.stringify(v)).byteLength;

/** P3-03's largest app target: five outlets with store listings. */
function target(platform: string, extraOutlets = 0): FeedTarget {
  const outlets: FeedTarget["outlets"] = {
    direct: {
      kind: "direct",
      live: { version: "1.5.0", seq: 15 },
      halted: false,
    },
    steam: {
      kind: "steam",
      live: { version: "1.5.0", seq: 15 },
      halted: false,
    },
    "app-store": {
      kind: "app-store",
      live: { version: "1.4.0", seq: 14 },
      halted: false,
      listingUrl: "https://apps.apple.com/app/id1234567890",
    },
    play: {
      kind: "play",
      live: { version: "1.4.0", seq: 14 },
      halted: false,
      rollout: { bp: 2500, salt: "00112233445566778899aabbccddeeff" },
      listingUrl: "https://play.google.com/store/apps/details?id=im.plrs.djdl",
    },
    "ms-store": {
      kind: "ms-store",
      live: { version: "1.4.0", seq: 14 },
      halted: false,
      listingUrl: "https://apps.microsoft.com/detail/9nblggh4r315",
    },
  };
  for (let i = 0; i < extraOutlets; i++)
    outlets[`direct-mirror-${i}`] = {
      kind: "direct",
      live: { version: "1.5.0", seq: 15 },
      halted: false,
    };
  return {
    platform,
    release: { sha256: hex(`app:${platform}`), seq: 15, version: "1.5.0" },
    floor: null,
    critical: false,
    outlets,
  };
}

/** A 64-byte pack id. */
const packId = (i: number, long: boolean): string => {
  const base = `pk${String(i).padStart(3, "0")}`;
  return long ? `${base}.${"a".repeat(64 - base.length - 1)}` : base;
};

interface Shape {
  packs: number;
  longIds: boolean;
  levels: number;
  platforms: string[];
  engines: string[];
  /** Axis groups × values per axis (0: no axes). */
  groups: number;
  values: number;
  floors: number;
  revocations: number;
  extraOutlets?: number;
}

async function composed(s: Shape): Promise<ComposedFeed> {
  const releases: FeedPackSets["releases"] = {};
  const sets: FeedPackSets["sets"] = {};
  const rows: FeedPackSets["rows"] = [];
  const perGroup = Math.max(1, Math.ceil(s.packs / Math.max(1, s.groups)));
  for (let level = 3; level < 3 + s.levels; level++)
    for (const engine of s.engines)
      for (let g = 0; g < Math.max(1, s.groups); g++)
        for (let v = 0; v < Math.max(1, s.values); v++) {
          const members: { pack: string; sha: string }[] = [];
          for (let k = 0; k < perGroup; k++) {
            const i = g * perGroup + k;
            if (i >= s.packs) break;
            const pack = packId(i, s.longIds);
            // One record per pack release holds every variant: the release depends on the level
            // (and the engine its variants run on), never on the variant value.
            const sha = hex(`${pack}:${level}:${engine}`);
            releases[sha] = { pack, version: `${level}.0.0`, seq: level * 10 };
            members.push({ pack, sha });
          }
          members.sort((a, b) => (a.pack < b.pack ? -1 : 1));
          const id = (await packSetId(
            members.map((m) => ({ packId: m.pack, releaseSha256: m.sha })),
          ))!;
          sets[id] = members.map((m) => m.sha);
          for (const platform of s.platforms)
            rows.push({
              contentApi: level,
              platform,
              engine,
              variant: s.groups > 0 ? { [`ax${g}`]: `v${v}` } : {},
              set: id,
            });
        }
  const floors: FeedPackFloor[] = [];
  for (let i = 0; i < s.floors; i++)
    floors.push({
      pack: packId(i % s.packs, s.longIds),
      contentApi: 3 + Math.floor(i / s.packs),
      minVersion: "3.0.1",
      versionScheme: "semver",
    });
  const revocations: FeedRevocation[] = [];
  const referenced = new Set<string>();
  for (let i = 0; i < s.revocations; i++) {
    const record = hex(`rev:${i}`);
    referenced.add(record);
    revocations.push({
      record,
      pack: packId(i % s.packs, s.longIds),
      target: hex(`target:${i}`),
      version: "2.9.9",
      seq: 9,
    });
  }
  return {
    channel: "stable",
    versionScheme: "semver",
    targets: s.platforms.map((p) => target(p, s.extraOutlets ?? 0)),
    content: {
      packSets: rows.length > 0 ? { releases, sets, rows } : null,
      packFloors: floors.length > 0 ? floors : null,
      revocations: revocations.length > 0 ? revocations : null,
      referenced,
      audits: [],
    },
  };
}

const NOW = 1_700_000_000;

function sign(c: ComposedFeed, platform: string) {
  const out = documentFor("djdl", c, platform, 7, NOW);
  return {
    ...out,
    size: bytes(out.doc),
    ok: feedSelfCheck(out.doc, out.platform),
  };
}

describe("feed content under the payload cap (plans/P4-13.md §6.3)", () => {
  it("Diceroll (20 packs, 2 levels, 4 platforms): the channel-wide document carries every member", async () => {
    const c = await composed({
      packs: 20,
      longIds: false,
      levels: 2,
      platforms: ["android", "ios", "windows", "macos"],
      engines: ["godot-4.4"],
      groups: 1,
      values: 3,
      floors: 4,
      revocations: 5,
    });
    const d = sign(c, "android");
    expect(d.ok).toBe(true);
    expect(d.platform).toBeNull();
    expect(d.size).toBeLessThan(MAX_FEED_PAYLOAD_BYTES);
    const parsed = feedContent(d.doc);
    expect(parsed.packSets).not.toBeNull();
    expect(parsed.packFloors).toHaveLength(4);
    expect(parsed.revocations).toHaveLength(5);
    expect(d.audits).toEqual([]);
  });

  it("64 packs in 3 axis groups ×4, 2 levels: the per-platform document keeps packSets", async () => {
    const c = await composed({
      packs: 64,
      longIds: false,
      levels: 2,
      platforms: PLATFORMS,
      engines: ["godot-4.4"],
      groups: 3,
      values: 4,
      floors: 64,
      revocations: 64,
    });
    const d = sign(c, "android");
    expect(d.ok).toBe(true);
    expect(d.platform).toBe("android");
    const parsed = feedContent(d.doc);
    expect(parsed.packSets).not.toBeNull();
    expect(parsed.packSets!.rows.every((r) => r.platform === "android")).toBe(
      true,
    );
    expect(parsed.packFloors).toHaveLength(64);
    expect(parsed.revocations).toHaveLength(64);
  });

  it("the same with 3 levels, 2 engines and 6 platforms: packSets is omitted and audited", async () => {
    const c = await composed({
      packs: 64,
      longIds: true,
      levels: 3,
      platforms: PLATFORMS,
      engines: ["godot-4.4", "godot-4.5"],
      groups: 3,
      values: 4,
      floors: 64,
      revocations: 64,
    });
    const d = sign(c, "android");
    expect(d.ok).toBe(true);
    expect(d.doc.packSets).toBeUndefined();
    expect(d.audits.map((a) => a.action)).toContain(
      "update.feed.packs_omitted",
    );
    expect(d.doc.app.targets).toEqual(
      c.targets.filter((t) => t.platform === "android"),
    );
  });

  it("the legal worst case signs with the app part intact (64 packs × 64-byte ids × 3 levels, every floor, 64 revocations)", async () => {
    const c = await composed({
      packs: 64,
      longIds: true,
      levels: 3,
      platforms: PLATFORMS,
      engines: [""],
      groups: 0,
      values: 0,
      floors: 64 * 3,
      revocations: 64,
    });
    for (const platform of PLATFORMS) {
      const d = sign(c, platform);
      expect(d.ok, platform).toBe(true);
      expect(d.doc.app.targets).toEqual(
        c.targets.filter((t) => t.platform === platform),
      );
      // Whatever is carried is usable.
      const parsed = feedContent(d.doc);
      for (const key of ["packSets", "packFloors", "revocations"] as const)
        if (d.doc[key] !== undefined) expect(parsed[key], key).not.toBeNull();
    }
  });

  it("appTargetNearCap: an app part padded to 60,000 bytes sheds down to omitting revocations, audited, and signs", async () => {
    const base = await composed({
      packs: 64,
      longIds: true,
      levels: 3,
      platforms: ["android"],
      engines: [""],
      groups: 0,
      values: 0,
      floors: 64 * 3,
      revocations: 64,
    });
    // Pad the per-platform app part with outlets to 60,000 bytes.
    let extra = 0;
    const appOnly = (n: number) =>
      bytes(
        documentFor(
          "djdl",
          {
            ...base,
            targets: [target("android", n)],
            content: {
              ...base.content,
              packSets: null,
              packFloors: null,
              revocations: null,
            },
          },
          "android",
          7,
          NOW,
        ).doc,
      );
    while (appOnly(extra + 1) <= 60_000) extra++;
    const appTargetNearCap: ComposedFeed = {
      ...base,
      targets: [target("android", extra)],
    };
    expect(appOnly(extra)).toBeGreaterThan(59_000);
    const d = sign(appTargetNearCap, "android");
    expect(d.ok).toBe(true);
    expect(d.doc.revocations).toBeUndefined();
    expect(d.audits.map((a) => a.action)).toEqual([
      "update.feed.packs_omitted",
      "update.feed.floors_omitted",
      "update.feed.revocations_omitted",
    ]);
    expect(d.doc.app.targets).toEqual(appTargetNearCap.targets);
  });

  it("the cap guard trips at the limit: an app part over the cap alone is never signed", async () => {
    const c = await composed({
      packs: 4,
      longIds: false,
      levels: 1,
      platforms: ["android"],
      engines: [""],
      groups: 0,
      values: 0,
      floors: 4,
      revocations: 4,
    });
    const big: ComposedFeed = { ...c, targets: [target("android", 760)] };
    const d = sign(big, "android");
    expect(d.size).toBeGreaterThan(MAX_FEED_PAYLOAD_BYTES);
    // Every content member was shed first; the 500 is P3-03's, never content's.
    expect(
      d.doc.packSets ?? d.doc.packFloors ?? d.doc.revocations,
    ).toBeUndefined();
    expect(d.ok).toBe(false);
  });

  it("stays inside the CPU budget at 64 packs × 3 levels × 6 platforms", async () => {
    const c = await composed({
      packs: 64,
      longIds: true,
      levels: 3,
      platforms: PLATFORMS,
      engines: ["godot-4.4", "godot-4.5"],
      groups: 3,
      values: 4,
      floors: 64 * 3,
      revocations: 64,
    });
    const t0 = performance.now();
    for (const platform of PLATFORMS) sign(c, platform);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
