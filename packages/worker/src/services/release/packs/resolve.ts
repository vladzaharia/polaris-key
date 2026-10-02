/**
 * Pack-set resolution (P4-12, CONTENT §6.3, README §3.4): for every (channel, app deliverable,
 * live contentApi level, platform, variant), the newest release of each `compatible` and
 * `standalone` pack that satisfies every requirement, dependency, conflict and floor. PURE: rows
 * in, sets out; `sets.ts` is the D1 shell and the tests drive this module with fixtures.
 *
 * ── LIVE APP RELEASES (step 1) ──────────────────────────────────────────────────────────────
 *
 * Every app release the channel may serve (Release's channel rules: members of the channel and
 * of every channel it `includes`, yanks removed except a pinned pointer, at or below a pinned
 * pointer; `resolve.ts` `channelCandidates`) that carries a contentApi and is at or above the
 * channel's floor (`release_channel_policy.min_supported`). The floor decides, never store
 * availability: release never reads distribution.
 *
 * ── SELECTORS ───────────────────────────────────────────────────────────────────────────────
 *
 * Levels are the live releases' contentApi values; platforms their builds' platforms; the engines
 * of a (level, platform) are every `requires.engine` those builds declare (a build that declares
 * none adds no constraint: the server cannot know it, and the device's `selectVariant` still
 * matches its own engine). Variant keys are every combination of the resolvable packs' declared axes (client-core's
 * `variantKey`, `""` when no pack declares one). The `packChannels` mapping of a (channel, level)
 * is its newest live release's: an app publish refuses one that differs (`content.ts`).
 *
 * ── ONE PACK AT ONE SELECTOR (step 3) ──────────────────────────────────────────────────────
 *
 * The pack's channel is the app channel, or the one `packChannels` routes it to. Its candidates
 * are the releases that channel may serve, newest first by the pack's version scheme, ties by
 * `seq` (the same channel rules, so `includes` falls back beta → stable and a yanked release
 * resolves only as a pinned pointer). Then, in order, each stage keeps what passes and names the
 * reason when nothing does:
 *
 *   no-release     the channel serves no release of the pack;
 *   content-api    (compatible only) no release's `requires.contentApi.app` range holds the level;
 *   engine         no release's variant for this selector runs on the engines the live builds
 *                  declare (`requires.engine` absent, or equal to every one of them). Two engines
 *                  at one level and platform share no `godot.pck` release, so an engine bump
 *                  either bumps contentApi or waits for the older release to fall below the floor;
 *   variant        no release carries this selector's variant of the pack;
 *   content-floor  no release is at or above the pack's floor on its channel, the level-free
 *                  `min_supported` and the floor for this level (`release_pack_floors`) both.
 *
 * ── THE SOLVER ──────────────────────────────────────────────────────────────────────────────
 *
 * Greedy highest-first per pack, packs in id order, with backtracking when a choice breaks a
 * `requires.packs` range (the target must be in the set, at a version its range holds under the
 * target's scheme) or a `conflicts` entry (either direction). At most `MAX_SOLVER_STEPS`
 * candidate tries per distinct problem; past that resolution FAILS (`PackResolutionError`) rather
 * than guess. When no assignment includes every pack, a deterministic greedy pass keeps what it
 * can and marks the rest `dependency` or `conflict`: a set is still stored, with its
 * `unsatisfied` marker, so a floor with no backport blocks a content line (P4-13 turns it into
 * `blocked(content-floor)`) instead of being refused.
 */

import {
  APP_DELIVERABLE_ID,
  CONTENT_API_RANGE_PATTERN,
  PACK_VERSION_RANGE_PATTERN,
  contentApiInRange,
  packChannelFor,
  parseRange,
  type PackBinding,
} from "@polaris-key/manifest";
import { variantKey } from "@polaris-key/client-core/packs";
import type { ManualChannel } from "../channels.js";
import {
  channelCandidates,
  compareVersions,
  parsesInScheme,
  type Candidate,
  type PolicyView,
  type VersionScheme,
} from "../resolve.js";

/** Candidate tries one distinct solver problem may spend before resolution fails. */
export const MAX_SOLVER_STEPS = 20000;
/** The most selectors (sets) one product resolves in all its channels. */
export const MAX_SELECTORS = 4096;

export const UNSATISFIED_REASONS = [
  "no-release",
  "content-api",
  "engine",
  "variant",
  "content-floor",
  "dependency",
  "conflict",
] as const;
export type UnsatisfiedReason = (typeof UNSATISFIED_REASONS)[number];

/** Resolution could not finish inside its bounds: a publish refuses, the caller reports it. */
export class PackResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackResolutionError";
  }
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────

/** One variant of a pack release, from its signed record (`release_builds`). */
export interface PackVariantFacts {
  variantKey: string;
  engine: string | null;
  /** `requires.contentApi`: app deliverable id → range. */
  contentApi: Record<string, string> | null;
  /** `requires.packs`: pack id → version range. */
  packs: Record<string, string> | null;
  conflicts: string[];
}

export interface PackReleaseFacts {
  releaseId: string;
  version: string;
  seq: number;
  /** The pack record's hash: the set member's identity (`packSetId`). */
  recordSha256: string;
  variants: PackVariantFacts[];
}

export interface PackInput {
  id: string;
  binding: PackBinding;
  required: boolean;
  scheme: VersionScheme;
  /** Declared variant axes → values (`.pkey/release`). */
  axes: Readonly<Record<string, readonly string[]>>;
  /** Every release of the pack, as channel resolution sees it. */
  candidates: Candidate[];
  /** The pack's channel policy rows, by channel. */
  policies: ReadonlyMap<string, PolicyView>;
  /** The level-free floor per channel (`release_channel_policy.min_supported`). */
  minSupported: ReadonlyMap<string, string | null>;
  /** Floors per channel per contentApi level (`release_pack_floors`). */
  floors: ReadonlyMap<string, ReadonlyMap<number, string>>;
  /** Facts of every release that has a stored record, by release id. */
  releases: ReadonlyMap<string, PackReleaseFacts>;
}

export interface AppReleaseFacts {
  contentApi: number | null;
  builds: { platform: string | null; engine: string | null }[];
  packChannels: Record<string, string> | null;
  /** The pack releases this app release holds (`release_holds`). */
  holds: { pack: string; releaseId: string }[];
}

export interface AppInput {
  scheme: VersionScheme;
  candidates: Candidate[];
  policies: ReadonlyMap<string, PolicyView>;
  /** The app's floor per channel (`release_channel_policy.min_supported`). */
  minSupported: ReadonlyMap<string, string | null>;
  manual: readonly ManualChannel[];
  stableTagPattern: string | null;
  ignoreTags: ReadonlySet<string>;
  releases: ReadonlyMap<string, AppReleaseFacts>;
}

export interface ResolutionInput {
  app: AppInput;
  /** Every declared pack; only `compatible` and `standalone` ones enter a set. */
  packs: PackInput[];
  /** The app channels to resolve. */
  channels: readonly string[];
  yanked: ReadonlySet<string>;
}

// ── Outputs ──────────────────────────────────────────────────────────────────────────────────

export interface LiveRelease {
  releaseId: string;
  version: string;
  seq: number | null;
  contentApi: number;
}

export interface Selector {
  channel: string;
  appDeliverable: string;
  contentApi: number;
  platform: string;
  /** The variant key over every resolvable pack's axes (`""` for none). */
  variant: string;
}

export interface SetEntry {
  pack: string;
  releaseId: string;
  version: string;
  seq: number;
  recordSha256: string;
}

export interface Unsatisfied {
  pack: string;
  reason: UnsatisfiedReason;
  detail: string;
}

export interface ResolvedSet extends Selector {
  /** The chosen releases, by pack id. */
  entries: SetEntry[];
  /** Packs no release satisfies at this selector, by pack id. */
  unsatisfied: Unsatisfied[];
  /** The app releases this set serves (live on the channel, at this level, with a build on this
   *  platform), newest first. */
  appReleases: string[];
}

export interface Resolution {
  /** Live app releases per channel, newest first. */
  live: Map<string, LiveRelease[]>;
  sets: ResolvedSet[];
}

// ── Ranges ───────────────────────────────────────────────────────────────────────────────────

/** Does `version` (of a pack under `scheme`) satisfy the `requires.packs` range `range`? */
export function versionInRange(
  scheme: VersionScheme,
  version: string,
  range: string,
): boolean {
  const cmp = parseRange(range, PACK_VERSION_RANGE_PATTERN);
  if (!cmp || !parsesInScheme(scheme, version)) return false;
  return cmp.every((c) => {
    if (!parsesInScheme(scheme, c.value)) return false;
    const d = compareVersions(scheme, version, c.value);
    switch (c.op) {
      case ">=":
        return d >= 0;
      case "<=":
        return d <= 0;
      case ">":
        return d > 0;
      case "<":
        return d < 0;
      default:
        return d === 0;
    }
  });
}

/** Does a `requires.contentApi.app` range hold `level`? A missing or malformed range does not. */
export function levelInRange(range: string | undefined, level: number): boolean {
  const cmp = parseRange(range, CONTENT_API_RANGE_PATTERN);
  return cmp !== null && contentApiInRange(cmp, level);
}

/** Is `version` at or above `floor` under `scheme`? An unparseable version or floor is not. */
function atOrAbove(
  scheme: VersionScheme,
  version: string,
  floor: string,
): boolean {
  return (
    parsesInScheme(scheme, version) &&
    parsesInScheme(scheme, floor) &&
    compareVersions(scheme, version, floor) >= 0
  );
}

// ── The resolver ─────────────────────────────────────────────────────────────────────────────

interface Cand {
  pack: string;
  rel: PackReleaseFacts;
  v: PackVariantFacts;
}

type Stage =
  | { ok: true; cands: Cand[] }
  | { ok: false; reason: UnsatisfiedReason; detail: string };

/** The projection of a selector's variant assignment onto one pack's declared axes. */
function packVariantKey(
  pack: PackInput,
  assignment: Readonly<Record<string, string>>,
): string {
  const sub: Record<string, string> = {};
  for (const axis of Object.keys(pack.axes))
    if (assignment[axis] !== undefined) sub[axis] = assignment[axis]!;
  return variantKey(sub);
}

/** Every combination of `axes` (axis → values), as assignments, in variant-key order. */
function assignments(
  axes: ReadonlyMap<string, readonly string[]>,
): Record<string, string>[] {
  let out: Record<string, string>[] = [{}];
  for (const axis of [...axes.keys()].sort()) {
    const next: Record<string, string>[] = [];
    for (const a of out)
      for (const value of axes.get(axis)!) next.push({ ...a, [axis]: value });
    out = next;
  }
  return out.sort((a, b) => {
    const x = variantKey(a);
    const y = variantKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function parseAssignment(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (key === "")
    return out;
  for (const part of key.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

export class PackResolver {
  readonly input: ResolutionInput;
  /** Resolvable packs (`compatible`, `standalone`), by id. */
  readonly universe: PackInput[];
  private readonly packsById: Map<string, PackInput>;
  private readonly liveCache = new Map<string, LiveRelease[]>();
  private readonly channelCache = new Map<string, Candidate[]>();
  private readonly solveCache = new Map<
    string,
    { chosen: Cand[]; unsat: Unsatisfied[] }
  >();
  private readonly variantAxes: Map<string, string[]>;

  constructor(input: ResolutionInput) {
    this.input = input;
    this.packsById = new Map(input.packs.map((p) => [p.id, p]));
    this.universe = input.packs
      .filter((p) => p.binding === "compatible" || p.binding === "standalone")
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.variantAxes = new Map();
    for (const p of this.universe)
      for (const [axis, values] of Object.entries(p.axes)) {
        const set = new Set(this.variantAxes.get(axis) ?? []);
        for (const v of values) set.add(v);
        this.variantAxes.set(axis, [...set].sort());
      }
  }

  /** A declared pack, by id. */
  pack(id: string): PackInput | undefined {
    return this.packsById.get(id);
  }

  /** The variant keys every selector of a (level, platform) carries. */
  variantKeys(): string[] {
    return assignments(this.variantAxes).map((a) => variantKey(a));
  }

  /** The live app releases of `channel`, newest first. */
  live(channel: string): LiveRelease[] {
    const cached = this.liveCache.get(channel);
    if (cached) return cached;
    const { app, yanked } = this.input;
    const floor = app.minSupported.get(channel) ?? null;
    const out: LiveRelease[] = [];
    for (const c of channelCandidates(
      {
        deliverable: APP_DELIVERABLE_ID,
        scheme: app.scheme,
        releases: app.candidates,
        yanked,
        policies: app.policies,
        manualChannels: app.manual,
        stableTagPattern: app.stableTagPattern,
        ignoreTags: app.ignoreTags,
      },
      channel,
    )) {
      const facts = app.releases.get(c.releaseId);
      if (!facts || facts.contentApi === null) continue;
      if (floor !== null && !atOrAbove(app.scheme, c.version, floor)) continue;
      out.push({
        releaseId: c.releaseId,
        version: c.version,
        seq: c.seq,
        contentApi: facts.contentApi,
      });
    }
    this.liveCache.set(channel, out);
    return out;
  }

  /** The releases `channel` may serve of `pack`, newest first (Release's channel rules). */
  packChannelReleases(pack: PackInput, channel: string): Candidate[] {
    const key = `${pack.id}\u0000${channel}`;
    const cached = this.channelCache.get(key);
    if (cached) return cached;
    const out = channelCandidates(
      {
        deliverable: pack.id,
        scheme: pack.scheme,
        releases: pack.candidates,
        yanked: this.input.yanked,
        policies: pack.policies,
        manualChannels: [],
      },
      channel,
    );
    this.channelCache.set(key, out);
    return out;
  }

  /** The (level, platform) → engines map of `live` releases. */
  private levels(live: readonly LiveRelease[]): Map<
    number,
    {
      platforms: Map<string, Set<string | null>>;
      packChannels: Record<string, string> | null;
      releases: LiveRelease[];
    }
  > {
    const out = new Map<
      number,
      {
        platforms: Map<string, Set<string | null>>;
        packChannels: Record<string, string> | null;
        releases: LiveRelease[];
      }
    >();
    for (const r of live) {
      const facts = this.input.app.releases.get(r.releaseId)!;
      let level = out.get(r.contentApi);
      if (!level) {
        // `live` is newest first: the first release of a level names its mapping.
        level = {
          platforms: new Map(),
          packChannels: facts.packChannels,
          releases: [],
        };
        out.set(r.contentApi, level);
      }
      level.releases.push(r);
      for (const b of facts.builds) {
        if (b.platform === null) continue;
        const engines = level.platforms.get(b.platform) ?? new Set();
        engines.add(b.engine);
        level.platforms.set(b.platform, engines);
      }
    }
    return out;
  }

  /** The routed channel of `pack` for an app channel and its level's mapping. */
  routedChannel(
    pack: PackInput,
    channel: string,
    packChannels: Record<string, string> | null,
  ): string {
    return packChannelFor(packChannels, pack.id) ?? channel;
  }

  /** The stages for one pack at one selector (see the header). */
  stage(
    pack: PackInput,
    ctx: {
      channel: string;
      level: number;
      engines: ReadonlySet<string | null>;
      assignment: Readonly<Record<string, string>>;
      packChannels: Record<string, string> | null;
    },
  ): Stage {
    const pc = this.routedChannel(pack, ctx.channel, ctx.packChannels);
    const vk = packVariantKey(pack, ctx.assignment);
    const all: Cand[] = [];
    for (const c of this.packChannelReleases(pack, pc)) {
      const rel = pack.releases.get(c.releaseId);
      if (!rel) continue;
      const v =
        rel.variants.find((x) => x.variantKey === vk) ?? rel.variants[0];
      if (v) all.push({ pack: pack.id, rel, v });
    }
    if (all.length === 0)
      return {
        ok: false,
        reason: "no-release",
        detail: `channel ${pc} serves no release of ${pack.id}`,
      };
    let cands = all;
    if (pack.binding === "compatible") {
      cands = cands.filter((c) =>
        levelInRange(c.v.contentApi?.[APP_DELIVERABLE_ID], ctx.level),
      );
      if (cands.length === 0)
        return {
          ok: false,
          reason: "content-api",
          detail: `no release of ${pack.id} on ${pc} supports contentApi ${ctx.level}`,
        };
    }
    const engines = [...ctx.engines].filter((e): e is string => e !== null);
    const engineOk = (c: Cand) =>
      c.v.variantKey !== vk ||
      c.v.engine === null ||
      engines.every((e) => e === c.v.engine);
    const withEngine = cands.filter(engineOk);
    if (withEngine.length === 0)
      return {
        ok: false,
        reason: "engine",
        detail: `no release of ${pack.id} on ${pc} runs on ${engines.join(" and ")}`,
      };
    cands = withEngine.filter((c) => c.v.variantKey === vk);
    if (cands.length === 0)
      return {
        ok: false,
        reason: "variant",
        detail: `no release of ${pack.id} on ${pc} has variant ${vk || "default"}`,
      };
    const levelFree = pack.minSupported.get(pc) ?? null;
    const levelFloor = pack.floors.get(pc)?.get(ctx.level) ?? null;
    const floored = cands.filter(
      (c) =>
        (levelFree === null ||
          atOrAbove(pack.scheme, c.rel.version, levelFree)) &&
        (levelFloor === null ||
          atOrAbove(pack.scheme, c.rel.version, levelFloor)),
    );
    if (floored.length === 0)
      return {
        ok: false,
        reason: "content-floor",
        detail: `no release of ${pack.id} on ${pc} is at or above the floor${levelFloor !== null ? ` ${levelFloor} for contentApi ${ctx.level}` : ""}${levelFree !== null ? `${levelFloor !== null ? " and" : ""} ${levelFree}` : ""}`,
      };
    return { ok: true, cands: floored };
  }

  /** Is `c` consistent with `chosen`? Null when it is, else the broken constraint. */
  private conflictWith(
    c: Cand,
    chosen: ReadonlyMap<string, Cand>,
    present: ReadonlySet<string>,
  ): { reason: "dependency" | "conflict"; detail: string } | null {
    for (const [target, range] of Object.entries(c.v.packs ?? {})) {
      if (!present.has(target))
        return {
          reason: "dependency",
          detail: `${c.pack} ${c.rel.version} requires ${target} ${range}, which has no release in this set`,
        };
      const t = chosen.get(target);
      const scheme = this.packsById.get(target)?.scheme;
      if (t && (!scheme || !versionInRange(scheme, t.rel.version, range)))
        return {
          reason: "dependency",
          detail: `${c.pack} ${c.rel.version} requires ${target} ${range}; the set holds ${t.rel.version}`,
        };
    }
    const scheme = this.packsById.get(c.pack)!.scheme;
    for (const j of chosen.values()) {
      const range = j.v.packs?.[c.pack];
      if (range !== undefined && !versionInRange(scheme, c.rel.version, range))
        return {
          reason: "dependency",
          detail: `${j.pack} ${j.rel.version} requires ${c.pack} ${range}, not ${c.rel.version}`,
        };
      if (c.v.conflicts.includes(j.pack) || j.v.conflicts.includes(c.pack))
        return {
          reason: "conflict",
          detail: `${c.pack} ${c.rel.version} conflicts with ${j.pack} ${j.rel.version}`,
        };
    }
    return null;
  }

  /**
   * The solver over packs that passed their stages (see the header): dependency pruning to a
   * fixpoint, a strict search that keeps every pack, then, only when none exists, a search in which
   * a pack may be left out (tried after each of its releases), so earlier packs by id keep their
   * newest consistent release and the packs left out are marked.
   */
  private solve(order0: { id: string; cands: Cand[] }[]): {
    chosen: Cand[];
    unsat: Unsatisfied[];
  } {
    const key = JSON.stringify(
      order0.map((p) => [
        p.id,
        p.cands.map((c) => `${c.rel.releaseId}#${c.v.variantKey}`),
      ]),
    );
    const hit = this.solveCache.get(key);
    if (hit) return hit;
    const unsat = new Map<string, Unsatisfied>();

    // 1. Prune: a candidate whose dependency no candidate of its target satisfies goes; a pack
    //    left with none is unsatisfied, which may prune its dependants in turn.
    const domains = new Map(order0.map((p) => [p.id, [...p.cands]]));
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const [id, cands] of domains) {
        const kept = cands.filter((c) =>
          Object.entries(c.v.packs ?? {}).every(([target, range]) => {
            const scheme = this.packsById.get(target)?.scheme;
            return (
              scheme !== undefined &&
              (domains.get(target) ?? []).some((t) =>
                versionInRange(scheme, t.rel.version, range),
              )
            );
          }),
        );
        if (kept.length === cands.length) continue;
        pruned = true;
        if (kept.length > 0) {
          domains.set(id, kept);
          continue;
        }
        const c = cands[0]!;
        const [target, range] = Object.entries(c.v.packs ?? {}).find(
          ([t, r]) => {
            const scheme = this.packsById.get(t)?.scheme;
            return !(
              scheme !== undefined &&
              (domains.get(t) ?? []).some((x) =>
                versionInRange(scheme, x.rel.version, r),
              )
            );
          },
        )!;
        unsat.set(id, {
          pack: id,
          reason: "dependency",
          detail: `${id} ${c.rel.version} requires ${target} ${range}, which no release in this set satisfies`,
        });
        domains.delete(id);
      }
    }
    const order = order0
      .filter((p) => domains.has(p.id))
      .map((p) => ({ id: p.id, cands: domains.get(p.id)! }));

    // 2. Search, every pack kept; 3. if none exists, a pack may be left out.
    const chosen = new Map<string, Cand>();
    const omitted = new Set<string>();
    let steps = 0;
    const tick = () => {
      if (++steps > MAX_SOLVER_STEPS)
        throw new PackResolutionError(
          `pack-set resolution gave up after ${MAX_SOLVER_STEPS} candidate tries (${order.length} packs); narrow the packs' requires.packs and conflicts`,
        );
    };
    const presentNow = () =>
      new Set(order.map((p) => p.id).filter((id) => !omitted.has(id)));
    const dfs = (i: number, allowOmit: boolean): boolean => {
      if (i === order.length) return true;
      const p = order[i]!;
      const present = presentNow();
      for (const c of p.cands) {
        tick();
        if (this.conflictWith(c, chosen, present)) continue;
        chosen.set(p.id, c);
        if (dfs(i + 1, allowOmit)) return true;
        chosen.delete(p.id);
      }
      if (!allowOmit) return false;
      tick();
      // Leaving `p` out breaks every chosen pack that depends on it.
      for (const j of chosen.values()) if (j.v.packs?.[p.id] !== undefined) return false;
      omitted.add(p.id);
      if (dfs(i + 1, allowOmit)) return true;
      omitted.delete(p.id);
      return false;
    };
    if (!dfs(0, false)) {
      chosen.clear();
      omitted.clear();
      dfs(0, true);
    }
    for (const id of omitted) {
      const p = order.find((x) => x.id === id)!;
      const present = new Set([...chosen.keys(), id]);
      const why = this.conflictWith(p.cands[0]!, chosen, present);
      unsat.set(id, {
        pack: id,
        reason: why?.reason ?? "dependency",
        detail:
          why?.detail ??
          `${id} cannot share a set with the releases the other packs require`,
      });
    }
    const result = {
      chosen: order.flatMap((p) =>
        chosen.has(p.id) ? [chosen.get(p.id)!] : [],
      ),
      unsat: [...unsat.values()],
    };
    this.solveCache.set(key, result);
    return result;
  }

  /** One selector's set. */
  resolveSelector(ctx: {
    channel: string;
    level: number;
    platform: string;
    engines: ReadonlySet<string | null>;
    variant: string;
    packChannels: Record<string, string> | null;
    appReleases: string[];
  }): ResolvedSet {
    const assignment = parseAssignment(ctx.variant);
    const order: { id: string; cands: Cand[] }[] = [];
    const unsatisfied: Unsatisfied[] = [];
    for (const pack of this.universe) {
      const s = this.stage(pack, { ...ctx, assignment });
      if (s.ok) order.push({ id: pack.id, cands: s.cands });
      else
        unsatisfied.push({ pack: pack.id, reason: s.reason, detail: s.detail });
    }
    const solved = this.solve(order);
    return {
      channel: ctx.channel,
      appDeliverable: APP_DELIVERABLE_ID,
      contentApi: ctx.level,
      platform: ctx.platform,
      variant: ctx.variant,
      entries: solved.chosen.map((c) => ({
        pack: c.pack,
        releaseId: c.rel.releaseId,
        version: c.rel.version,
        seq: c.rel.seq,
        recordSha256: c.rel.recordSha256,
      })),
      unsatisfied: [...unsatisfied, ...solved.unsat].sort((a, b) =>
        a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : 0,
      ),
      appReleases: ctx.appReleases,
    };
  }

  /** Every selector of every channel, resolved. Throws `PackResolutionError` past the bounds. */
  resolve(): Resolution {
    const live = new Map<string, LiveRelease[]>();
    const sets: ResolvedSet[] = [];
    const variants = this.universe.length > 0 ? this.variantKeys() : [];
    for (const channel of [...this.input.channels].sort()) {
      const releases = this.live(channel);
      live.set(channel, releases);
      if (this.universe.length === 0) continue;
      const levels = this.levels(releases);
      for (const level of [...levels.keys()].sort((a, b) => a - b)) {
        const l = levels.get(level)!;
        for (const platform of [...l.platforms.keys()].sort()) {
          const appReleases = l.releases
            .filter((r) =>
              this.input.app.releases
                .get(r.releaseId)!
                .builds.some((b) => b.platform === platform),
            )
            .map((r) => r.releaseId);
          for (const variant of variants) {
            if (sets.length >= MAX_SELECTORS)
              throw new PackResolutionError(
                `pack-set resolution needs more than ${MAX_SELECTORS} selectors (channels × contentApi levels × platforms × variants); narrow the packs' variant axes or raise a channel floor`,
              );
            sets.push(
              this.resolveSelector({
                channel,
                level,
                platform,
                engines: l.platforms.get(platform)!,
                variant,
                packChannels: l.packChannels,
                appReleases,
              }),
            );
          }
        }
      }
    }
    return { live, sets };
  }

  /** The facts of a set member's variant at `variant` (the selector's key). */
  private memberCand(
    pack: string,
    releaseId: string,
    variant: string,
  ): Cand | null {
    const p = this.packsById.get(pack);
    const rel = p?.releases.get(releaseId);
    if (!p || !rel) return null;
    const vk = packVariantKey(p, parseAssignment(variant));
    const v = rel.variants.find((x) => x.variantKey === vk);
    return v ? { pack, rel, v } : null;
  }

  /**
   * The constraint `set` breaks once `holds` replace (or join) its members, or null. Devices apply
   * holds over the feed's set as they apply pins; every member must still find its dependencies
   * in range and share the set with nothing it conflicts with.
   */
  heldSetViolation(
    set: ResolvedSet,
    holds: readonly { pack: string; releaseId: string }[],
  ): string | null {
    if (holds.length === 0) return null;
    const members = new Map<string, Cand>();
    for (const e of set.entries) {
      const c = this.memberCand(e.pack, e.releaseId, set.variant);
      if (c) members.set(e.pack, c);
    }
    for (const h of holds) {
      const c = this.memberCand(h.pack, h.releaseId, set.variant);
      if (!c)
        return `${h.pack} is held at ${h.releaseId}, which has no variant ${set.variant || "default"}`;
      members.set(h.pack, c);
    }
    const present = new Set(members.keys());
    const seen = new Map<string, Cand>();
    for (const c of [...members.values()].sort((a, b) =>
      a.pack < b.pack ? -1 : 1,
    )) {
      const why = this.conflictWith(c, seen, present);
      if (why) return why.detail;
      seen.set(c.pack, c);
    }
    // Dependencies on members ordered after the dependant.
    for (const c of members.values())
      for (const [target, range] of Object.entries(c.v.packs ?? {})) {
        const t = members.get(target);
        const scheme = this.packsById.get(target)?.scheme;
        if (!t || !scheme || !versionInRange(scheme, t.rel.version, range))
          return `${c.pack} ${c.rel.version} requires ${target} ${range}${t ? `; the held set holds ${t.rel.version}` : ", which the held set lacks"}`;
      }
    return null;
  }

  /**
   * Why `releaseId` of `pack` fails a selector it is meant for, or null: the pack-publish check
   * (CONTENT §6.4). A release the selector's channel does not serve, outside its contentApi range,
   * for another engine or below a floor is simply not chosen (a release for a coming engine is
   * published before the app that runs it). One that lacks the selector's variant fails
   * (`variant`); one that passes its stages but is passed over for an OLDER release, or leaves the
   * pack unsatisfied, broke a dependency or a conflict, and fails with it.
   */
  publishViolation(
    set: ResolvedSet,
    pack: PackInput,
    releaseId: string,
    packChannels: Record<string, string> | null,
    engines: ReadonlySet<string | null>,
  ): { reason: "variant" | "dependency" | "conflict"; detail: string } | null {
    const pc = this.routedChannel(pack, set.channel, packChannels);
    const ranked = this.packChannelReleases(pack, pc);
    const rank = ranked.findIndex((c) => c.releaseId === releaseId);
    const rel = pack.releases.get(releaseId);
    if (rank < 0 || !rel) return null;
    const assignment = parseAssignment(set.variant);
    const vk = packVariantKey(pack, assignment);
    const v = rel.variants.find((x) => x.variantKey === vk);
    const anyV = v ?? rel.variants[0];
    if (
      pack.binding === "compatible" &&
      !levelInRange(anyV?.contentApi?.[APP_DELIVERABLE_ID], set.contentApi)
    )
      return null;
    if (!v)
      return {
        reason: "variant",
        detail: `${pack.id} ${rel.version} has no variant ${vk || "default"}`,
      };
    const s = this.stage(pack, {
      channel: set.channel,
      level: set.contentApi,
      engines,
      assignment,
      packChannels,
    });
    if (!s.ok || !s.cands.some((c) => c.rel.releaseId === releaseId))
      return null;
    const entry = set.entries.find((e) => e.pack === pack.id);
    if (entry) {
      const chosenRank = ranked.findIndex((c) => c.releaseId === entry.releaseId);
      if (chosenRank <= rank) return null;
    }
    const others = new Map<string, Cand>();
    for (const e of set.entries) {
      if (e.pack === pack.id) continue;
      const c = this.memberCand(e.pack, e.releaseId, set.variant);
      if (c) others.set(e.pack, c);
    }
    const present = new Set([...others.keys(), pack.id]);
    const why = this.conflictWith({ pack: pack.id, rel, v }, others, present);
    return (
      why ?? {
        reason: "dependency",
        detail: `${pack.id} ${rel.version} cannot join this set with the releases its dependants require`,
      }
    );
  }

  /** The (level, platform) engines and mapping of `channel`'s live releases at `level`. */
  selectorContext(
    channel: string,
    level: number,
    platform: string,
  ): {
    engines: ReadonlySet<string | null>;
    packChannels: Record<string, string> | null;
  } | null {
    const l = this.levels(this.live(channel)).get(level);
    const engines = l?.platforms.get(platform);
    return l && engines ? { engines, packChannels: l.packChannels } : null;
  }
}
