/**
 * P4-12 — the pure pack-set resolver (`services/release/packs/resolve.ts`), table-driven over
 * CONTENT §6.8's Diceroll scenarios: two live contentApi levels, a backport floor, a standalone
 * pack in every level, an engine bump, `includes` fallback, ties by `seq`, yanks, holds,
 * `packChannels` routing, the solver's dependencies and conflicts, the bounds, and one
 * `packSetId` for one input. A last case resolves a realistic product (20 packs × 200 releases ×
 * 3 levels × 6 platforms) inside a CPU budget.
 */

import { describe, expect, it } from "vitest";
import { packChannelFor, parseRange } from "@polaris-key/manifest";
import { packSetId } from "@polaris-key/client-core/packs";
import {
  MAX_RESOLUTION_WORK,
  MAX_SELECTORS,
  PackResolutionError,
  PackResolver,
  levelInRange,
  versionInRange,
  type AppReleaseFacts,
  type PackInput,
  type PackReleaseFacts,
  type ResolutionInput,
  type ResolvedSet,
} from "../src/services/release/packs/resolve.js";
import { setReport, withSetIds } from "../src/services/release/packs/sets.js";
import type { Candidate, PolicyView } from "../src/services/release/resolve.js";

const hex = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8);
};

interface AppSpec {
  version: string;
  seq: number;
  contentApi: number | null;
  channel?: string;
  platforms?: string[];
  engine?: string | null;
  packChannels?: Record<string, string> | null;
  holds?: { pack: string; releaseId: string }[];
}

interface RelSpec {
  version: string;
  seq: number;
  channel?: string | null;
  contentApi?: string;
  engine?: string;
  variants?: string[];
  packs?: Record<string, string>;
  conflicts?: string[];
}

interface PackSpec {
  id: string;
  binding?: "pinned" | "compatible" | "standalone";
  required?: boolean;
  axes?: Record<string, string[]>;
  releases: RelSpec[];
  policies?: Record<string, PolicyView>;
  minSupported?: Record<string, string>;
  floors?: Record<string, Record<number, string>>;
}

function appInput(
  apps: AppSpec[],
  opts: {
    floors?: Record<string, string>;
    policies?: Record<string, PolicyView>;
  } = {},
): ResolutionInput["app"] {
  const releases = new Map<string, AppReleaseFacts>();
  const candidates: Candidate[] = apps.map((a) => {
    const id = `app@${a.version}`;
    const platforms = a.platforms ?? ["ios"];
    releases.set(id, {
      contentApi: a.contentApi,
      builds: platforms.map((p) => ({ platform: p, engine: a.engine ?? null })),
      packChannels: a.packChannels ?? null,
      holds: a.holds ?? [],
    });
    return {
      releaseId: id,
      version: a.version,
      seq: a.seq,
      channel: a.channel ?? "stable",
      prerelease: false,
      tag: null,
      builds: platforms.map((p) => ({ buildId: p, platform: p, arch: "any" })),
    };
  });
  return {
    scheme: "semver",
    candidates,
    policies: new Map(Object.entries(opts.policies ?? {})),
    minSupported: new Map(Object.entries(opts.floors ?? {})),
    manual: [],
    stableTagPattern: null,
    ignoreTags: new Set(),
    releases,
  };
}

function packInput(p: PackSpec): PackInput {
  const releases = new Map<string, PackReleaseFacts>();
  const candidates: Candidate[] = p.releases.map((r) => {
    const id = `${p.id}@${r.version}`;
    releases.set(id, {
      releaseId: id,
      version: r.version,
      seq: r.seq,
      recordSha256: hex(id),
      variants: (r.variants ?? [""]).map((vk) => ({
        variantKey: vk,
        engine: r.engine ?? null,
        contentApi: r.contentApi ? { app: r.contentApi } : null,
        packs: r.packs ?? null,
        conflicts: r.conflicts ?? [],
      })),
    });
    return {
      releaseId: id,
      version: r.version,
      seq: r.seq,
      channel: r.channel ?? null,
      prerelease: false,
      tag: null,
      builds: [],
    };
  });
  return {
    id: p.id,
    binding: p.binding ?? "compatible",
    required: p.required ?? false,
    scheme: "semver",
    axes: p.axes ?? {},
    candidates,
    policies: new Map(Object.entries(p.policies ?? {})),
    minSupported: new Map(Object.entries(p.minSupported ?? {})),
    floors: new Map(
      Object.entries(p.floors ?? {}).map(([c, byLevel]) => [
        c,
        new Map(Object.entries(byLevel).map(([l, v]) => [Number(l), v])),
      ]),
    ),
    releases,
  };
}

function resolve(
  apps: AppSpec[],
  packs: PackSpec[],
  opts: {
    channels?: string[];
    yanked?: string[];
    appFloors?: Record<string, string>;
    appPolicies?: Record<string, PolicyView>;
  } = {},
) {
  const input: ResolutionInput = {
    app: appInput(apps, { floors: opts.appFloors, policies: opts.appPolicies }),
    packs: packs.map(packInput),
    channels: opts.channels ?? ["stable"],
    yanked: new Set(opts.yanked ?? []),
  };
  const resolver = new PackResolver(input);
  return { resolver, ...resolver.resolve() };
}

/** pack → version of a set. */
const members = (s: ResolvedSet) =>
  Object.fromEntries(s.entries.map((e) => [e.pack, e.version]));
const unsat = (s: ResolvedSet) =>
  Object.fromEntries(s.unsatisfied.map((u) => [u.pack, u.reason]));
const at = (
  sets: ResolvedSet[],
  sel: Partial<
    Pick<
      ResolvedSet,
      "channel" | "contentApi" | "platform" | "engine" | "variant"
    >
  >,
) =>
  sets.filter(
    (s) =>
      (sel.channel === undefined || s.channel === sel.channel) &&
      (sel.engine === undefined || s.engine === sel.engine) &&
      (sel.contentApi === undefined || s.contentApi === sel.contentApi) &&
      (sel.platform === undefined || s.platform === sel.platform) &&
      (sel.variant === undefined || s.variant === sel.variant),
  );
const one = (
  sets: ResolvedSet[],
  sel: Parameters<typeof at>[1],
): ResolvedSet => {
  const found = at(sets, sel);
  expect(found, JSON.stringify(sel)).toHaveLength(1);
  return found[0]!;
};

// Diceroll, CONTENT §6.8: App Store serves 1.4 (contentApi 3), direct and Play serve 1.5 (4).
const APP_14: AppSpec = { version: "1.4.0", seq: 14, contentApi: 3 };
const APP_15: AppSpec = { version: "1.5.0", seq: 15, contentApi: 4 };
const FOES: PackSpec = {
  id: "diceroll.foes",
  releases: [
    { version: "1.3.3", seq: 1, contentApi: ">=3 <4" },
    { version: "2.0.0", seq: 2, contentApi: ">=4 <5" },
    { version: "2.0.1", seq: 3, contentApi: ">=4 <5" },
  ],
};

describe("ranges and routing helpers", () => {
  it("contentApi ranges hold integers by every comparator", () => {
    expect(levelInRange(">=3 <5", 3)).toBe(true);
    expect(levelInRange(">=3 <5", 5)).toBe(false);
    expect(levelInRange("4", 4)).toBe(true);
    expect(levelInRange(">3", 3)).toBe(false);
    expect(levelInRange("<=2", 2)).toBe(true);
    expect(levelInRange(undefined, 3)).toBe(false);
    expect(levelInRange("^3", 3)).toBe(false);
    expect(parseRange(">=3 <5", /^.*$/)).toEqual([
      { op: ">=", value: "3" },
      { op: "<", value: "5" },
    ]);
  });

  it("pack version ranges compare under the target's scheme", () => {
    expect(versionInRange("semver", "1.2.3", ">=1.2.0 <2.0.0")).toBe(true);
    expect(versionInRange("semver", "2.0.0", ">=1.2.0 <2.0.0")).toBe(false);
    expect(versionInRange("semver", "2.0.0-rc.1", "<2.0.0")).toBe(true);
    expect(versionInRange("semver", "1.0.0", "=1.0.0")).toBe(true);
    expect(versionInRange("semver", "1.0.0", "1.0.1")).toBe(false);
  });

  it("packChannels: an exact id wins, then the longest whole-segment prefix", () => {
    const map = {
      "diceroll.events.*": "events",
      "diceroll.*": "content",
      "diceroll.events.special": "special",
    };
    expect(packChannelFor(map, "diceroll.events.halloween")).toBe("events");
    expect(packChannelFor(map, "diceroll.events.special")).toBe("special");
    expect(packChannelFor(map, "diceroll.foes")).toBe("content");
    expect(packChannelFor(map, "dicerollx.foes")).toBe(null);
    expect(
      packChannelFor({ "diceroll.events.*": "e" }, "diceroll.eventsx"),
    ).toBe(null);
    expect(packChannelFor(null, "diceroll.foes")).toBe(null);
  });
});

describe("live levels and the Diceroll scenarios (CONTENT §6.8)", () => {
  it("row 1: live levels {3, 4} resolve foes 1.x for contentApi 3 and 2.x for contentApi 4", () => {
    const { sets, live } = resolve([APP_14, APP_15], [FOES]);
    expect(live.get("stable")!.map((r) => [r.releaseId, r.contentApi])).toEqual(
      [
        ["app@1.5.0", 4],
        ["app@1.4.0", 3],
      ],
    );
    expect(sets).toHaveLength(2);
    expect(members(one(sets, { contentApi: 3 }))).toEqual({
      "diceroll.foes": "1.3.3",
    });
    expect(members(one(sets, { contentApi: 4 }))).toEqual({
      "diceroll.foes": "2.0.1",
    });
    expect(one(sets, { contentApi: 3 }).appReleases).toEqual(["app@1.4.0"]);
  });

  it("the channel floor decides what is live, never store availability", () => {
    const { sets, live } = resolve([APP_14, APP_15], [FOES], {
      appFloors: { stable: "1.5.0" },
    });
    expect(live.get("stable")!.map((r) => r.contentApi)).toEqual([4]);
    expect(sets.map((s) => s.contentApi)).toEqual([4]);
  });

  it("row 3: a floor ≥ 1.3.4 for contentApi 3 blocks the line until the backport, then selects it", () => {
    const floored: PackSpec = {
      ...FOES,
      floors: { stable: { 3: "1.3.4" } },
    };
    let { sets } = resolve([APP_14, APP_15], [floored]);
    expect(unsat(one(sets, { contentApi: 3 }))).toEqual({
      "diceroll.foes": "content-floor",
    });
    expect(one(sets, { contentApi: 3 }).unsatisfied[0]!.detail).toContain(
      "1.3.4 for contentApi 3",
    );
    // The floor is per line: contentApi 4 is untouched.
    expect(members(one(sets, { contentApi: 4 }))).toEqual({
      "diceroll.foes": "2.0.1",
    });
    ({ sets } = resolve(
      [APP_14, APP_15],
      [
        {
          ...floored,
          releases: [
            ...FOES.releases,
            { version: "1.3.4", seq: 4, contentApi: ">=3 <4" },
          ],
        },
      ],
    ));
    expect(members(one(sets, { contentApi: 3 }))).toEqual({
      "diceroll.foes": "1.3.4",
    });
    expect(one(sets, { contentApi: 3 }).unsatisfied).toEqual([]);
  });

  it("row 5: a standalone l10n.table pack is in every level's set, whatever its contentApi", () => {
    const l10n: PackSpec = {
      id: "diceroll.l10n",
      binding: "standalone",
      releases: [{ version: "2.0.1", seq: 1 }],
    };
    const { sets } = resolve([APP_14, APP_15], [FOES, l10n]);
    for (const level of [3, 4])
      expect(members(one(sets, { contentApi: level }))["diceroll.l10n"]).toBe(
        "2.0.1",
      );
  });

  it("row 7: during an engine bump each engine keeps its own set; the new one resolves once its releases exist", () => {
    // 1.5 (engine 4.7) is still live beside 1.6 (engine 4.8), at the same contentApi.
    const app15: AppSpec = { ...APP_15, engine: "godot-4.7" };
    const app16: AppSpec = {
      version: "1.6.0",
      seq: 16,
      contentApi: 4,
      engine: "godot-4.8",
    };
    const core: PackSpec = {
      id: "diceroll.core3d",
      required: true,
      releases: [
        { version: "2.0.0", seq: 1, contentApi: ">=4", engine: "godot-4.7" },
      ],
    };
    let { sets } = resolve([app15, app16], [core]);
    expect(unsat(one(sets, { engine: "godot-4.8" }))).toEqual({
      "diceroll.core3d": "engine",
    });
    expect(one(sets, { engine: "godot-4.8" }).appReleases).toEqual([
      "app@1.6.0",
    ]);
    expect(members(one(sets, { engine: "godot-4.7" }))).toEqual({
      "diceroll.core3d": "2.0.0",
    });
    ({ sets } = resolve(
      [app15, app16],
      [
        {
          ...core,
          releases: [
            ...core.releases,
            {
              version: "2.1.0",
              seq: 2,
              contentApi: ">=4",
              engine: "godot-4.8",
            },
          ],
        },
      ],
    ));
    expect(members(one(sets, { engine: "godot-4.8" }))).toEqual({
      "diceroll.core3d": "2.1.0",
    });
    // The 1.5 players on 4.7 keep their 4.7 release.
    expect(members(one(sets, { engine: "godot-4.7" }))).toEqual({
      "diceroll.core3d": "2.0.0",
    });
    expect(one(sets, { engine: "godot-4.7" }).appReleases).toEqual([
      "app@1.5.0",
    ]);
  });

  it('a build that declares no engine constrains nothing (engine "")', () => {
    const { sets } = resolve(
      [APP_15],
      [
        {
          id: "diceroll.core3d",
          releases: [
            {
              version: "2.1.0",
              seq: 2,
              contentApi: ">=4",
              engine: "godot-4.8",
            },
          ],
        },
      ],
    );
    expect(one(sets, { engine: "" }).entries.map((e) => e.version)).toEqual([
      "2.1.0",
    ]);
  });

  it("a release for another engine is passed over for an older one that runs", () => {
    const { sets } = resolve(
      [{ ...APP_15, engine: "godot-4.7" }],
      [
        {
          id: "diceroll.core3d",
          releases: [
            {
              version: "2.0.0",
              seq: 1,
              contentApi: ">=4",
              engine: "godot-4.7",
            },
            {
              version: "2.1.0",
              seq: 2,
              contentApi: ">=4",
              engine: "godot-4.8",
            },
          ],
        },
      ],
    );
    expect(members(sets[0]!)).toEqual({ "diceroll.core3d": "2.0.0" });
  });

  it("row 4: packChannels routes diceroll.events.* to the events channel from every app channel", () => {
    const mapping = { "diceroll.events.*": "events" };
    const halloween: PackSpec = {
      id: "diceroll.events.halloween",
      releases: [
        { version: "1.0.0", seq: 1, channel: "events", contentApi: ">=3" },
        { version: "1.1.0", seq: 2, channel: "stable", contentApi: ">=3" },
      ],
    };
    const { sets } = resolve(
      [
        { ...APP_14, packChannels: mapping },
        { ...APP_15, packChannels: mapping },
        {
          version: "1.6.0-beta.1",
          seq: 16,
          contentApi: 4,
          channel: "beta",
          packChannels: mapping,
        },
      ],
      [halloween],
      { channels: ["stable", "beta"] },
    );
    // The events release, never the stable one, on every channel and level.
    for (const s of sets)
      expect(members(s)).toEqual({ "diceroll.events.halloween": "1.0.0" });
    expect(at(sets, { channel: "beta" }).length).toBeGreaterThan(0);
  });
});

describe("channel rules: includes, seq ties and yanks", () => {
  it("includes: beta falls back to stable's pack releases, and prefers a newer beta one", () => {
    const apps: AppSpec[] = [
      APP_15,
      { version: "1.6.0-beta.1", seq: 16, contentApi: 4, channel: "beta" },
    ];
    let { sets } = resolve(apps, [FOES], { channels: ["stable", "beta"] });
    expect(members(one(sets, { channel: "beta" }))).toEqual({
      "diceroll.foes": "2.0.1",
    });
    ({ sets } = resolve(
      apps,
      [
        {
          ...FOES,
          releases: [
            ...FOES.releases,
            {
              version: "2.1.0-beta.1",
              seq: 9,
              channel: "beta",
              contentApi: ">=4",
            },
          ],
        },
      ],
      { channels: ["stable", "beta"] },
    ));
    expect(members(one(sets, { channel: "beta" }))).toEqual({
      "diceroll.foes": "2.1.0-beta.1",
    });
    expect(members(one(sets, { channel: "stable" }))).toEqual({
      "diceroll.foes": "2.0.1",
    });
  });

  it("ties by seq: versions equal in precedence resolve to the later publication", () => {
    const { sets } = resolve(
      [APP_15],
      [
        {
          id: "diceroll.foes",
          releases: [
            { version: "2.0.0+b", seq: 7, contentApi: "4" },
            { version: "2.0.0+a", seq: 8, contentApi: "4" },
          ],
        },
      ],
    );
    expect(members(sets[0]!)).toEqual({ "diceroll.foes": "2.0.0+a" });
  });

  it("a yanked release is excluded, unless the channel pins it explicitly", () => {
    let { sets } = resolve([APP_15], [FOES], {
      yanked: ["diceroll.foes@2.0.1"],
    });
    expect(members(sets[0]!)).toEqual({ "diceroll.foes": "2.0.0" });
    ({ sets } = resolve(
      [APP_15],
      [
        {
          ...FOES,
          policies: {
            stable: {
              pointer: "diceroll.foes@2.0.1",
              pinned: true,
              includes: null,
            },
          },
        },
      ],
      { yanked: ["diceroll.foes@2.0.1"] },
    ));
    expect(members(sets[0]!)).toEqual({ "diceroll.foes": "2.0.1" });
  });

  it("a yanked app release is not live; neither is one without a contentApi", () => {
    const { live } = resolve(
      [APP_14, APP_15, { version: "1.3.0", seq: 13, contentApi: null }],
      [FOES],
      { yanked: ["app@1.4.0"] },
    );
    expect(live.get("stable")!.map((r) => r.releaseId)).toEqual(["app@1.5.0"]);
  });

  it("pinned packs never enter a set", () => {
    const { sets } = resolve(
      [APP_15],
      [
        FOES,
        {
          id: "diceroll.ui",
          binding: "pinned",
          releases: [{ version: "1.0.0", seq: 1 }],
        },
      ],
    );
    expect(Object.keys(members(sets[0]!))).toEqual(["diceroll.foes"]);
  });
});

describe("selectors: platforms and variants", () => {
  it("one set per platform of the live builds and per variant of the packs' axes", () => {
    const core: PackSpec = {
      id: "diceroll.core3d",
      axes: { texture: ["astc", "s3tc"] },
      releases: [
        {
          version: "1.0.0",
          seq: 1,
          contentApi: ">=4",
          variants: ["texture=astc", "texture=s3tc"],
        },
        // The newest release lacks astc: astc devices stay on 1.0.0.
        {
          version: "1.1.0",
          seq: 2,
          contentApi: ">=4",
          variants: ["texture=s3tc"],
        },
      ],
    };
    const { sets } = resolve(
      [{ ...APP_15, platforms: ["ios", "macos"] }],
      [core],
    );
    expect(
      sets.map((s) => [s.platform, s.variant, members(s)["diceroll.core3d"]]),
    ).toEqual([
      ["ios", "texture=astc", "1.0.0"],
      ["ios", "texture=s3tc", "1.1.0"],
      ["macos", "texture=astc", "1.0.0"],
      ["macos", "texture=s3tc", "1.1.0"],
    ]);
  });

  it("a variant no release carries is unsatisfied with reason variant", () => {
    const { sets } = resolve(
      [APP_15],
      [
        {
          id: "diceroll.core3d",
          axes: { texture: ["astc", "s3tc"] },
          releases: [
            {
              version: "1.0.0",
              seq: 1,
              contentApi: ">=4",
              variants: ["texture=s3tc"],
            },
          ],
        },
      ],
    );
    expect(unsat(one(sets, { variant: "texture=astc" }))).toEqual({
      "diceroll.core3d": "variant",
    });
  });
});

describe("the solver: dependencies, conflicts, holds and bounds", () => {
  const LORE = (versions: string[]): PackSpec => ({
    id: "diceroll.lore",
    binding: "standalone",
    releases: versions.map((v, i) => ({ version: v, seq: i + 1 })),
  });

  it("backtracks to an older dependency the dependant's range holds", () => {
    const { sets } = resolve(
      [APP_15],
      [
        {
          id: "diceroll.foes",
          releases: [
            {
              version: "2.0.0",
              seq: 1,
              contentApi: "4",
              packs: { "diceroll.lore": "<2.0.0" },
            },
          ],
        },
        LORE(["1.0.0", "1.5.0", "2.0.0"]),
      ],
    );
    expect(members(sets[0]!)).toEqual({
      "diceroll.foes": "2.0.0",
      "diceroll.lore": "1.5.0",
    });
  });

  it("a dependant whose range no release holds is unsatisfied (dependency); the rest resolve", () => {
    const { sets } = resolve(
      [APP_15],
      [
        {
          id: "diceroll.foes",
          releases: [
            {
              version: "2.0.0",
              seq: 1,
              contentApi: "4",
              packs: { "diceroll.lore": ">=3.0.0" },
            },
          ],
        },
        LORE(["1.0.0", "2.0.0"]),
      ],
    );
    expect(members(sets[0]!)).toEqual({ "diceroll.lore": "2.0.0" });
    expect(unsat(sets[0]!)).toEqual({ "diceroll.foes": "dependency" });
  });

  it("a conflict picks the older release that does not conflict, else marks the pack", () => {
    const audio: PackSpec = {
      id: "diceroll.audio",
      releases: [
        { version: "1.0.0", seq: 1, contentApi: "4" },
        {
          version: "1.1.0",
          seq: 2,
          contentApi: "4",
          conflicts: ["diceroll.foes"],
        },
      ],
    };
    let { sets } = resolve([APP_15], [audio, FOES]);
    expect(members(sets[0]!)).toEqual({
      "diceroll.audio": "1.0.0",
      "diceroll.foes": "2.0.1",
    });
    ({ sets } = resolve(
      [APP_15],
      [{ ...audio, releases: [audio.releases[1]!] }, FOES],
    ));
    expect(members(sets[0]!)).toEqual({ "diceroll.audio": "1.1.0" });
    expect(unsat(sets[0]!)).toEqual({ "diceroll.foes": "conflict" });
  });

  it("a hold whose substitution breaks a dependency is a violation; a compatible one is not", () => {
    const apps: AppSpec[] = [
      {
        ...APP_15,
        holds: [{ pack: "diceroll.lore", releaseId: "diceroll.lore@1.0.0" }],
      },
    ];
    const packs: PackSpec[] = [
      {
        id: "diceroll.foes",
        releases: [
          {
            version: "2.0.0",
            seq: 1,
            contentApi: "4",
            packs: { "diceroll.lore": ">=1.5.0" },
          },
        ],
      },
      LORE(["1.0.0", "1.5.0"]),
    ];
    const { resolver, sets } = resolve(apps, packs);
    expect(members(sets[0]!)).toEqual({
      "diceroll.foes": "2.0.0",
      "diceroll.lore": "1.5.0",
    });
    expect(
      resolver.heldSetViolation(sets[0]!, [
        { pack: "diceroll.lore", releaseId: "diceroll.lore@1.0.0" },
      ]),
    ).toContain("requires diceroll.lore >=1.5.0");
    expect(
      resolver.heldSetViolation(sets[0]!, [
        { pack: "diceroll.lore", releaseId: "diceroll.lore@1.5.0" },
      ]),
    ).toBe(null);
  });

  it("fails with a clear error when the search bound is hit", () => {
    // 12 packs of 4 releases chained by dependencies (one component); the last requires the
    // OLDEST release of the first, so a search that tries the newest first walks 4^10
    // assignments of the packs between before it may revisit the first.
    const packs: PackSpec[] = [];
    for (let i = 0; i < 12; i++)
      packs.push({
        id: `p.p${String(i).padStart(2, "0")}`,
        binding: "standalone",
        releases: [1, 2, 3, 4].map((n) => ({
          version: `${n}.0.0`,
          seq: n,
          packs: {
            ...(i > 0
              ? { [`p.p${String(i - 1).padStart(2, "0")}`]: ">=1.0.0" }
              : {}),
            ...(i === 11 ? { "p.p00": "=1.0.0" } : {}),
          },
        })),
      });
    expect(() => resolve([APP_15], packs)).toThrow(PackResolutionError);
    expect(() => resolve([APP_15], packs)).toThrow(String(MAX_RESOLUTION_WORK));
  });
});

describe("groups: variants projected per pack (review fix 1b)", () => {
  const axisPack = (id: string, axis: string, values: string[]): PackSpec => ({
    id,
    binding: "standalone",
    axes: { [axis]: values },
    releases: [
      { version: "1.0.0", seq: 1, variants: values.map((v) => `${axis}=${v}`) },
    ],
  });

  it("packs on different axes add rows instead of multiplying them", () => {
    const { sets, resolver } = resolve(
      [APP_15],
      [
        FOES,
        axisPack("diceroll.core3d", "texture", ["astc", "etc2", "s3tc"]),
        axisPack("diceroll.l10n", "locale", ["de", "en", "fr"]),
      ],
    );
    // One row for the axis-free group, 3 texture rows, 3 locale rows: 7, not 1 × 3 × 3.
    // Groups in id order: core3d (texture), foes (no axes), l10n (locale).
    expect(sets.map((s) => s.variant)).toEqual([
      "texture=astc",
      "texture=etc2",
      "texture=s3tc",
      "",
      "locale=de",
      "locale=en",
      "locale=fr",
    ]);
    expect(resolver.groups.map((g) => g.id)).toEqual(
      ["diceroll.core3d", "diceroll.foes", "diceroll.l10n"].sort(),
    );
    // A device on astc + fr takes one row per group.
    expect(
      one(sets, { variant: "texture=astc" }).entries.map((e) => e.pack),
    ).toEqual(["diceroll.core3d"]);
  });

  it("a dependency across axes merges the two packs into one group over both axes", () => {
    const tex = axisPack("diceroll.core3d", "texture", ["astc", "s3tc"]);
    const loc: PackSpec = {
      ...axisPack("diceroll.l10n", "locale", ["en", "fr"]),
      releases: [
        {
          version: "1.0.0",
          seq: 1,
          variants: ["locale=en", "locale=fr"],
          packs: { "diceroll.core3d": ">=1.0.0" },
        },
      ],
    };
    const { sets } = resolve([APP_15], [tex, loc]);
    expect(sets.map((s) => s.variant)).toEqual([
      "locale=en;texture=astc",
      "locale=en;texture=s3tc",
      "locale=fr;texture=astc",
      "locale=fr;texture=s3tc",
    ]);
    for (const s of sets) expect(s.entries).toHaveLength(2);
  });
});

describe("bounds (review fix 1)", () => {
  /** A coupled group over three 16-value axes: 4,096 rows per (channel, level, platform). */
  const coupled = (): PackSpec[] => {
    const values = Array.from(
      { length: 16 },
      (_, i) => `v${String(i).padStart(2, "0")}`,
    );
    return (["locale", "quality", "texture"] as const).map((axis, i) => ({
      id: `game.${axis}`,
      binding: "standalone" as const,
      axes: { [axis]: values },
      releases: [1, 2, 3].map((n) => ({
        version: `${n}.0.0`,
        seq: n,
        variants: values.map((v) => `${axis}=${v}`),
        ...(i > 0 ? { packs: { "game.locale": ">=1.0.0" } } : {}),
      })),
    }));
  };

  it("MAX_SELECTORS distinct problems at the bound finish within the budget", () => {
    const t0 = performance.now();
    const { sets } = resolve([APP_15], coupled());
    expect(sets).toHaveLength(MAX_SELECTORS);
    expect(sets.every((s) => s.entries.length === 3)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("one more selector than the bound refuses cleanly, inside the budget's time", () => {
    const t0 = performance.now();
    expect(() =>
      resolve([APP_15], coupled(), { channels: ["stable", "beta"] }),
    ).toThrow(PackResolutionError);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("an adversarial search spends the whole-resolution budget, then refuses, in bounded time and memory", () => {
    // 64 packs of 200 releases chained by dependencies: the last requires the oldest release of
    // the first, so a newest-first search walks a huge space; the shared budget stops it.
    const packs: PackSpec[] = Array.from({ length: 64 }, (_, i) => ({
      id: `p.p${String(i).padStart(2, "0")}`,
      binding: "standalone" as const,
      releases: Array.from({ length: 200 }, (_, n) => ({
        version: `1.${Math.floor(n / 50)}.${n % 50}`,
        seq: n + 1,
        packs: {
          ...(i > 0
            ? { [`p.p${String(i - 1).padStart(2, "0")}`]: ">=1.0.0" }
            : {}),
          ...(i === 63 ? { "p.p00": "=1.0.0" } : {}),
        },
      })),
    }));
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    expect(() =>
      resolve([{ ...APP_15, platforms: ["ios", "macos", "web"] }], packs),
    ).toThrow(String(MAX_RESOLUTION_WORK));
    // The budget is sized for about 150 ms on Node 22; CI machines get headroom.
    expect(performance.now() - t0).toBeLessThan(1500);
    // An isolate has 128 MB; resolution must stay far below it.
    expect((process.memoryUsage().heapUsed - heap0) / 1048576).toBeLessThan(64);
  });
});

describe("bounds, round 2", () => {
  it("dependency pruning is charged: 64 packs × 200 releases × 63 dependencies refuse cleanly in time", () => {
    // Every pack requires the OLDEST release of every other: pruning examines whole domains.
    const id = (i: number) => `p.p${String(i).padStart(2, "0")}`;
    const packs: PackSpec[] = Array.from({ length: 64 }, (_, i) => ({
      id: id(i),
      binding: "standalone" as const,
      releases: Array.from({ length: 200 }, (_, n) => ({
        version: `1.${Math.floor(n / 50)}.${n % 50}`,
        seq: n + 1,
        packs: Object.fromEntries(
          Array.from({ length: 63 }, (_, k) => [
            id((i + k + 1) % 64),
            "<=1.0.0",
          ]),
        ),
      })),
    }));
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    expect(() => resolve([APP_15], packs)).toThrow(String(MAX_RESOLUTION_WORK));
    // About 35 ms on Node 22 (it was 17.5 s with pruning outside the budget).
    expect(performance.now() - t0).toBeLessThan(1500);
    expect((process.memoryUsage().heapUsed - heap0) / 1048576).toBeLessThan(64);
  });

  it("the live levels are computed once per channel, not per row: 500 app releases × 4,000 rows", () => {
    const values = Array.from({ length: 10 }, (_, i) => `v${i}`);
    const keys: string[] = [];
    for (const a of values)
      for (const b of values)
        for (const c of values)
          keys.push(`locale=${a};quality=${b};texture=${c}`);
    const apps: AppSpec[] = Array.from({ length: 500 }, (_, n) => ({
      version: `1.0.${n}`,
      seq: n + 1,
      contentApi: 3,
      platforms: ["android", "ios", "macos", "web"],
    }));
    const t0 = performance.now();
    const { sets, resolver } = resolve(apps, [
      {
        id: "x.x",
        binding: "standalone",
        axes: { locale: values, quality: values, texture: values },
        releases: [{ version: "1.0.0", seq: 1, variants: keys }],
      },
    ]);
    expect(sets).toHaveLength(4000);
    // The publish check asks every row for its mapping: memoised, so this is free.
    for (const s of sets) resolver.levelMapping(s.channel, s.contentApi);
    // About 20 ms on Node 22 (3.3 s when it was recomputed per row).
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("bounds, round 3", () => {
  it("25 fully conflicting pairs of 200-release packs resolve within the budget", () => {
    // Every release of a.N conflicts with b.N, and every release of b.N with a.N: once one is
    // chosen, no release of the other is tried (|A| + |B| tries, not |A| × |B|).
    const packs: PackSpec[] = [];
    for (let i = 0; i < 25; i++) {
      const n = String(i).padStart(2, "0");
      for (const [me, other] of [
        [`a.p${n}`, `b.p${n}`],
        [`b.p${n}`, `a.p${n}`],
      ] as const)
        packs.push({
          id: me,
          binding: "standalone",
          releases: Array.from({ length: 200 }, (_, r) => ({
            version: `1.${Math.floor(r / 50)}.${r % 50}`,
            seq: r + 1,
            conflicts: [other],
          })),
        });
    }
    const t0 = performance.now();
    const { sets } = resolve([APP_15], packs);
    expect(performance.now() - t0).toBeLessThan(1500);
    // Each pair keeps the earlier pack (newest release) and leaves the other out.
    expect(sets[0]!.entries).toHaveLength(25);
    expect(
      sets[0]!.entries.every(
        (e) => e.pack.startsWith("a.") && e.version === "1.3.49",
      ),
    ).toBe(true);
    expect(sets[0]!.unsatisfied.every((u) => u.reason === "conflict")).toBe(
      true,
    );
  });
});

describe("per-component semantics (round 2, lead decision)", () => {
  type Rel = {
    v: string;
    packs?: Record<string, string>;
    conflicts?: string[];
  };
  const pk = (
    id: string,
    rels: Rel[],
    axes: Record<string, string[]> = {},
  ): PackSpec => ({
    id,
    binding: "standalone",
    axes,
    releases: rels.map((r, n) => ({
      version: r.v,
      seq: n + 1,
      ...(Object.keys(axes).length
        ? {
            variants: Object.entries(axes).flatMap(([a, vs]) =>
              vs.map((x) => `${a}=${x}`),
            ),
          }
        : {}),
      ...(r.packs ? { packs: r.packs } : {}),
      ...(r.conflicts ? { conflicts: r.conflicts } : {}),
    })),
  });

  it("couple2: a conflict between a1 and a2 never costs b2 its place (one group, two components)", () => {
    const { sets } = resolve(
      [APP_15],
      [
        pk("a.a1", [{ v: "1.0.0", conflicts: ["a.a2"] }]),
        pk("a.a2", [{ v: "1.0.0" }]),
        pk("b.b1", [{ v: "2.0.0", conflicts: ["b.b2"] }, { v: "1.0.0" }]),
        pk("b.b2", [{ v: "1.0.0" }]),
      ],
    );
    expect(members(sets[0]!)).toEqual({
      "a.a1": "1.0.0",
      "b.b1": "1.0.0",
      "b.b2": "1.0.0",
    });
    expect(unsat(sets[0]!)).toEqual({ "a.a2": "conflict" });
  });

  it("couple: tied into one component, the fewest packs are left out (b2 stays)", () => {
    for (const tie of [false, true]) {
      const { sets } = resolve(
        [APP_15],
        [
          pk("a.a1", [{ v: "1.0.0", conflicts: ["a.a2"] }], { locale: ["en"] }),
          pk("a.a2", [{ v: "1.0.0" }], { locale: ["en"] }),
          pk("b.b1", [{ v: "2.0.0", conflicts: ["b.b2"] }, { v: "1.0.0" }]),
          pk("b.b2", [
            { v: "1.0.0", ...(tie ? { packs: { "a.a1": ">=0.0.0" } } : {}) },
          ]),
        ],
      );
      const all = Object.assign({}, ...sets.map(members));
      expect(all, `tie ${tie}`).toEqual({
        "a.a1": "1.0.0",
        "b.b1": "1.0.0",
        "b.b2": "1.0.0",
      });
      expect(Object.assign({}, ...sets.map(unsat))).toEqual({
        "a.a2": "conflict",
      });
    }
  });
});

describe("packSetId", () => {
  it("the same input gives the same packSetId, shared by identical sets of different selectors", async () => {
    const run = async () =>
      withSetIds(
        resolve([{ ...APP_15, platforms: ["ios", "macos", "web"] }], [FOES])
          .sets,
      );
    const a = await run();
    const b = await run();
    expect(a.map((s) => s.packSetId)).toEqual(b.map((s) => s.packSetId));
    expect(new Set(a.map((s) => s.packSetId)).size).toBe(1);
    expect(a[0]!.packSetId).toBe(
      await packSetId([
        { packId: "diceroll.foes", releaseSha256: hex("diceroll.foes@2.0.1") },
      ]),
    );
    const report = setReport([], a);
    expect(report.sets).toHaveLength(1);
    expect(report.sets[0]!.selectors.map((s) => s.platform)).toEqual([
      "ios",
      "macos",
      "web",
    ]);
    expect(report.changed).toHaveLength(3);
    expect(setReport(a, b).changed).toEqual([]);
  });
});

describe("cost", () => {
  it("20 packs × 200 releases × 3 levels × 6 platforms resolves inside the CPU budget", () => {
    const platforms = ["android", "ios", "linux", "macos", "web", "windows"];
    const apps: AppSpec[] = [3, 4, 5].map((level, i) => ({
      version: `1.${level}.0`,
      seq: 10 + i,
      contentApi: level,
      platforms,
    }));
    const packs: PackSpec[] = [];
    for (let p = 0; p < 20; p++)
      packs.push({
        id: `game.pack${String(p).padStart(2, "0")}`,
        binding: p % 5 === 0 ? "standalone" : "compatible",
        axes: p % 4 === 0 ? { texture: ["astc", "etc2", "s3tc"] } : {},
        releases: Array.from({ length: 200 }, (_, r) => ({
          version: `${Math.floor(r / 50) + 1}.${r % 50}.0`,
          seq: r + 1,
          ...(p % 5 === 0 ? {} : { contentApi: `>=${3 + Math.floor(r / 70)}` }),
          variants:
            p % 4 === 0
              ? ["texture=astc", "texture=etc2", "texture=s3tc"]
              : [""],
          ...(p > 0 && p % 3 === 0
            ? {
                packs: {
                  [`game.pack${String(p - 1).padStart(2, "0")}`]: ">=1.0.0",
                },
              }
            : {}),
        })),
      });
    const t0 = performance.now();
    const { sets } = resolve(apps, packs, { channels: ["stable", "beta"] });
    const ms = performance.now() - t0;
    // 2 channels × 3 levels × 6 platforms × (the axis-free group + 3 texture rows).
    expect(sets).toHaveLength(144);
    expect(sets.every((s) => s.unsatisfied.length === 0)).toBe(true);
    // Workers allow 30 s of CPU on the paid plan; resolution must stay far inside one request.
    expect(ms).toBeLessThan(2000);
  });
});
