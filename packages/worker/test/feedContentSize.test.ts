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

  it("appTargetNearCap with a 64-entry delta menu (P4-29): the menu never adds a shed step at any padding", async () => {
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
    const recs = Object.keys(base.content.packSets!.releases);
    // Every entry on a record the target pins, so the menu has candidates even once packSets
    // (the other source of menu records) is shed.
    const menu: ComposedFeed["menu"] = {
      candidates: candidates(64, recs),
      pinnedBy: { android: recs },
    };
    const SHEDS = new Set([
      "update.feed.packs_omitted",
      "update.feed.floors_omitted",
      "update.feed.revocations_trimmed",
      "update.feed.revocations_omitted",
    ]);
    const MENU = new Set([
      "update.feed.deltas_trimmed",
      "update.feed.deltas_omitted",
    ]);
    // From the channel-wide document fitting to every content member shed (P4-13's fixture: an
    // app part padded with outlets toward 60,000 bytes), in steps.
    const seen = new Set<string>();
    for (let extra = 0; extra <= 760; extra += 40) {
      const k: ComposedFeed = { ...base, targets: [target("android", extra)] };
      const without = sign(k, "android");
      if (!without.ok) break;
      const withMenu = sign({ ...k, menu }, "android");
      expect(withMenu.ok, `extra=${extra}`).toBe(true);
      expect(withMenu.platform, `extra=${extra}`).toBe(without.platform);
      // The same shed steps, in the same order: the menu only ever trims or omits itself.
      expect(
        withMenu.audits.map((a) => a.action).filter((a) => !MENU.has(a)),
        `extra=${extra}`,
      ).toEqual(without.audits.map((a) => a.action));
      for (const key of ["packSets", "packFloors", "revocations"] as const)
        expect(withMenu.doc[key], `extra=${extra} ${key}`).toEqual(
          without.doc[key],
        );
      expect(withMenu.size).toBeLessThanOrEqual(MAX_FEED_PAYLOAD_BYTES);
      for (const a of without.audits)
        if (SHEDS.has(a.action)) seen.add(a.action);
    }
    // The sweep crossed every P4-13 step (so no step was left untested).
    expect([...seen].sort()).toEqual(
      [
        "update.feed.floors_omitted",
        "update.feed.packs_omitted",
        "update.feed.revocations_omitted",
      ].sort(),
    );
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

  it("stays inside the CPU budget at 64 packs × 3 levels × 6 platforms, with a 64-entry delta menu (P4-29)", async () => {
    const base = await composed({
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
    // P4-29: the full menu (MAX_FEED_DELTAS), every entry on a record each target pins, so the
    // bisection runs over all 64 on every per-platform document.
    const recs = Object.keys(base.content.packSets!.releases);
    const c: ComposedFeed = {
      ...base,
      menu: {
        candidates: candidates(64, recs),
        pinnedBy: Object.fromEntries(PLATFORMS.map((p) => [p, recs])),
      },
    };
    const t0 = performance.now();
    const docs = PLATFORMS.map((platform) => sign(c, platform));
    expect(performance.now() - t0).toBeLessThan(1000);
    for (const d of docs) {
      expect(d.ok).toBe(true);
      expect(Object.values(d.doc.deltas ?? {}).flat().length).toBe(64);
    }
  });

  it("P4-19: a delegation's revocation (always referenced) survives size step 3; only step 4 drops it", async () => {
    const base = await composed({
      packs: 64,
      longIds: true,
      levels: 1,
      platforms: ["android"],
      engines: [""],
      groups: 0,
      values: 0,
      floors: 0,
      revocations: 64,
    });
    // 63 unreferenced pack-record revocations and one delegation revocation, referenced.
    const delegation: FeedRevocation = {
      record: hex("rev:delegation"),
      pack: "pk000.events",
      target: hex("delegation"),
      version: "1",
      seq: 1,
      kind: "delegation",
    };
    const revocations = [...base.content.revocations!.slice(1), delegation];
    const c: ComposedFeed = {
      ...base,
      content: {
        ...base.content,
        packSets: null,
        revocations,
        referenced: new Set([delegation.record]),
      },
    };
    const kept = (n: number) =>
      documentFor(
        "djdl",
        { ...c, targets: [target("android", n)] },
        "android",
        7,
        NOW,
      ).doc.revocations as FeedRevocation[] | undefined;
    // Pad the app part until every revocation no longer fits (the first shed is step 3).
    let extra = 0;
    while (kept(extra)?.length === revocations.length) extra++;
    const d = sign({ ...c, targets: [target("android", extra)] }, "android");
    expect(d.ok).toBe(true);
    expect(d.doc.revocations).toEqual([delegation]);
    expect(d.audits.map((a) => a.action)).toContain(
      "update.feed.revocations_trimmed",
    );
    expect(feedContent(d.doc).revocations).toEqual([delegation]);
  });
});

// ── P4-29: the delta menu is added last and trimmed first (plans/P4-29.md §6.2) ──────────────

/** `n` ranked candidates over `records` (cycled), up to 4 per target. */
function candidates(
  n: number,
  records: readonly string[],
): NonNullable<ComposedFeed["menu"]>["candidates"] {
  return Array.from({ length: n }, (_, i) => ({
    recordSha256: records[i % records.length]!,
    deliverableId: "pk000",
    to: hex(`to:${Math.floor(i / 4)}`),
    entry: {
      from: hex(`from:${i}`),
      method: "zstd-patch-from",
      scope: "payload" as const,
      memBytes: 10_000_000 + i,
      artifact: { sha256: hex(`frame:${i}`), bytes: 300_000 + i },
    },
    devices: 1000 - i,
    createdAt: NOW,
  }));
}

describe("the delta menu under the payload cap (plans/P4-29.md §6.2)", () => {
  it("lists every candidate when it fits, keyed by target in rank order, readable by feedContent", async () => {
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
    const recs = Object.keys(c.content.packSets!.releases);
    const d = sign(
      { ...c, menu: { candidates: candidates(6, recs), pinnedBy: {} } },
      "android",
    );
    expect(d.ok).toBe(true);
    expect(d.platform).toBeNull();
    expect(Object.keys(d.doc.deltas!)).toEqual([hex("to:0"), hex("to:1")]);
    expect(d.doc.deltas![hex("to:0")]!.length).toBe(4);
    expect(feedContent(d.doc).deltas).toEqual(d.doc.deltas);
    expect(d.audits).toEqual([]);
  });

  it("lists only the records the document names: its packSets and its own target's pins", async () => {
    const c = await composed({
      packs: 4,
      longIds: false,
      levels: 1,
      platforms: ["android"],
      engines: [""],
      groups: 0,
      values: 0,
      floors: 0,
      revocations: 0,
    });
    const pinned = hex("pinned-record");
    const other = hex("ios-record");
    const cands = [
      ...candidates(1, [pinned]),
      ...candidates(2, [other]).slice(1),
    ];
    const d = sign(
      {
        ...c,
        menu: {
          candidates: cands,
          pinnedBy: { android: [pinned], ios: [other] },
        },
      },
      "android",
    );
    // The channel-wide document names every target's pins.
    expect(Object.values(d.doc.deltas!).flat().length).toBe(2);
    const narrow = documentFor(
      "djdl",
      {
        ...c,
        menu: { candidates: cands, pinnedBy: { android: [pinned] } },
      },
      "android",
      7,
      NOW,
    );
    expect(Object.values(narrow.doc.deltas!).flat().length).toBe(1);
  });

  it("the cap guard: a menu that makes the payload exactly 65,536 bytes is listed; one byte more trims it", async () => {
    const c = await composed({
      packs: 2,
      longIds: false,
      levels: 1,
      platforms: ["android"],
      engines: [""],
      groups: 0,
      values: 0,
      floors: 0,
      revocations: 0,
    });
    const recs = Object.keys(c.content.packSets!.releases);
    const withMenu = (pad: number): ComposedFeed => {
      const t = target("android", 0);
      (t.outlets["app-store"] as { listingUrl: string }).listingUrl =
        `https://apps.apple.com/app/${"a".repeat(pad)}`;
      return {
        ...c,
        targets: [t],
        menu: { candidates: candidates(1, recs), pinnedBy: {} },
      };
    };
    // Grow the app part until the menu's one entry lands on the cap exactly (listing URLs are
    // capped at 2,048 bytes, so mirrors make up the rest).
    const menuBytes = (k: ComposedFeed) => bytes(sign(k, "android").doc);
    let mirrors = 0;
    const sized = (pad: number): ComposedFeed => {
      const k = withMenu(pad);
      k.targets = [
        {
          ...k.targets[0]!,
          outlets: {
            ...target("android", mirrors).outlets,
            "app-store": k.targets[0]!.outlets["app-store"]!,
          },
        },
      ];
      return k;
    };
    // The fewest mirrors that bring the payload within 2,000 bytes of the cap (a bisection).
    const short = (m: number) => {
      mirrors = m;
      return menuBytes(sized(0)) + 2000 < MAX_FEED_PAYLOAD_BYTES;
    };
    let few = 0;
    let many = 1;
    while (short(many)) {
      few = many;
      many *= 2;
    }
    while (many - few > 1) {
      const mid = (few + many) >> 1;
      if (short(mid)) few = mid;
      else many = mid;
    }
    mirrors = short(0) ? many : 0;
    // The first pad at which the menu no longer fits under the cap (a bisection: the property
    // flips once, from listed-and-under to not).
    const fits = (pad: number) => {
      const d = sign(sized(pad), "android");
      return (
        bytes(d.doc) < MAX_FEED_PAYLOAD_BYTES && d.doc.deltas !== undefined
      );
    };
    let lo = 0;
    let hi = 2048 - "https://apps.apple.com/app/".length;
    expect(fits(lo)).toBe(true);
    expect(fits(hi)).toBe(false);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    const pad = hi;
    const exact = sign(sized(pad), "android");
    expect(exact.size).toBe(MAX_FEED_PAYLOAD_BYTES);
    expect(exact.doc.deltas).toBeDefined();
    expect(exact.ok).toBe(true);
    const over = sign(sized(pad + 1), "android");
    expect(over.doc.deltas).toBeUndefined();
    expect(over.size).toBeLessThanOrEqual(MAX_FEED_PAYLOAD_BYTES);
    expect(over.audits.map((a) => a.action)).toEqual([
      "update.feed.deltas_omitted",
    ]);
    expect(over.ok).toBe(true);
  });

  it("appTargetNearCap with a full menu: the menu is trimmed, never the document choice or a P4-13 member", async () => {
    const base = await composed({
      packs: 8,
      longIds: true,
      levels: 1,
      platforms: ["android"],
      engines: [""],
      groups: 0,
      values: 0,
      floors: 8,
      revocations: 8,
    });
    // An app part that leaves room for some, not all, of 64 entries (about 16 KB).
    let extra = 0;
    while (
      bytes(
        sign({ ...base, targets: [target("android", extra + 1)] }, "android")
          .doc,
      ) <= 56_000
    )
      extra++;
    const nearCap: ComposedFeed = {
      ...base,
      targets: [target("android", extra)],
    };
    const before = sign(nearCap, "android");
    const recs = Object.keys(base.content.packSets!.releases);
    const d = sign(
      {
        ...nearCap,
        menu: { candidates: candidates(64, recs), pinnedBy: {} },
      },
      "android",
    );
    expect(d.ok).toBe(true);
    expect(d.platform).toBe(before.platform);
    expect(d.doc.packSets).toEqual(before.doc.packSets);
    expect(d.doc.packFloors).toEqual(before.doc.packFloors);
    expect(d.doc.revocations).toEqual(before.doc.revocations);
    const listed = Object.values(d.doc.deltas!).flat();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(64);
    // The highest-ranked entries survive.
    expect(listed[0]!.artifact.sha256).toBe(hex("frame:0"));
    expect(d.audits.map((a) => a.action)).toEqual([
      ...before.audits.map((a) => a.action),
      "update.feed.deltas_trimmed",
    ]);
    expect(d.size).toBeLessThanOrEqual(MAX_FEED_PAYLOAD_BYTES);
  });
});
