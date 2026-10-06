/**
 * Pack-set resolution (P4-12, CONTENT §6.3, README §3.4): for every (channel, app deliverable,
 * live contentApi level, platform, engine, variant), the newest release of each `compatible` and
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
 * Levels are the live releases' contentApi values; platforms their builds' platforms; engines the
 * `requires.engine` those builds declare (`""` for a build that declares none, which constrains
 * nothing: the server cannot know it, and the device's `selectVariant` still matches its own
 * engine). Each (level, platform, engine) is resolved on its own, so during an engine bump the
 * players of the older engine keep their set and the newer engine gets its own (CONTENT §6.8 row
 * 7). The `packChannels` mapping of a (channel, level) is its newest live release's: an app
 * publish refuses one that differs (`content.ts`).
 *
 * ── VARIANTS, PROJECTED PER GROUP ───────────────────────────────────────────────────────────
 *
 * A pack's choice depends only on ITS OWN variant axes, and on the packs its dependencies and
 * conflicts tie it to. So the resolvable packs are partitioned into GROUPS: packs with the same
 * axis names, merged with every pack a `requires.packs` or `conflicts` entry links them to, until
 * the groups' axis-name sets are distinct. A group is resolved per combination of ITS axes' values
 * (its variant key, `""` for a group without axes) and stored as its own row: a device's set is
 * the union of one row per group, the row whose variant key is its own variant projected onto that
 * group's axes. The rows grow as the SUM over groups, not the product over every pack's axes.
 *
 * The semantics are PER COMPONENT (the lead's decision on review, and the reference for P4-13):
 * within a row, the packs are split into components — packs some candidate's `requires.packs` or
 * `conflicts` entry links — and each component is solved on its own. A pack is left out only when
 * its OWN component cannot keep it; a conflict elsewhere never costs it its place. That is
 * strictly better than one whole-assignment search, which could drop a satisfiable pack because
 * an unrelated pair conflicts. Groups are unions of components, so per group equals per
 * component.
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
 *   engine         no release's variant for this selector runs on the selector's engine
 *                  (`requires.engine` absent, or equal to it);
 *   variant        no release carries this selector's variant of the pack;
 *   content-floor  no release is at or above the pack's floor on its channel, the level-free
 *                  `min_supported` and the floor for this level (`release_pack_floors`) both.
 *
 * Stage outputs are memoised (they depend on the pack, its routed channel, the level, the engine
 * and its variant key, never on the platform), and the solver's memo is keyed on the ids of the
 * stage outputs it was given.
 *
 * ── THE SOLVER AND ITS BUDGET ───────────────────────────────────────────────────────────────
 *
 * Dependency pruning to a fixpoint, then greedy highest-first per pack, packs in id order, with
 * backtracking when a choice breaks a `requires.packs` range (the target must be in the set, at a
 * version its range holds under the target's scheme) or a `conflicts` entry (either direction).
 * When no assignment keeps every pack, the search is repeated leaving out at most one pack, then
 * two, …; those left out are marked `dependency` or `conflict`, and the set is still stored with
 * its `unsatisfied` marker, so a floor with no backport blocks a content line (P4-13 turns it
 * into `blocked(content-floor)`) instead of being refused.
 *
 * ONE work budget, `MAX_RESOLUTION_WORK`, is shared by the whole resolution (never per problem):
 * grouping reads every declared constraint, a stage pays per candidate and per constraint it
 * builds, pruning pays per dependency probe and twice per range check, the component split pays
 * per constraint, and a solver try pays one plus one per chosen pack and per dependency. Past it,
 * or past `MAX_SELECTORS` rows, resolution FAILS (`PackResolutionError`) rather than guess. The
 * budget is sized so that the adversarial cases measured on Node 22 (64 packs × 200 releases with
 * 63 dependencies each, exhaustive searches over dependency chains, 64-entry conflict lists, three
 * coupled 16-value axes, 500 live app releases × 4,000 rows) spend it, or finish, in 15–60 ms with
 * under 25 MB of heap (`test/packResolve.test.ts` "bounds").
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

/** The work units one whole resolution may spend (see the header): about 150 ms worst case. */
export const MAX_RESOLUTION_WORK = 1_000_000;
/** The most rows (sets) one product resolves in all its channels. */
export const MAX_SELECTORS = 4096;

/**
 * Work counters, a test hook (like the Godot SDK's `PKeyPck.scan_probes`): the raw operations the
 * resolver performs, counted at the work sites themselves and independently of `spend`, so the
 * "bounds" and "cost" tests in `test/packResolve.test.ts` bound the work done rather than the
 * wall-clock time (which a loaded machine inflates). Work that escapes the budget (pruning once
 * cost 17.5 s outside it) still shows here. `steps` is every loop iteration at a work site (one
 * per constraint read, release scanned, candidate built or examined, range check, solver try and
 * row); `rangeChecks` the range answers asked for (memo hits included); `tries` the solver's
 * candidate tries; `levelRuns` the `computeLevels` runs; `pruneProbes` the pruning pass's
 * "does some candidate of T hold R" questions. A test diffs them around a call. Plain
 * increments: they never change what a resolution returns.
 */
export const resolveWork = {
  steps: 0,
  rangeChecks: 0,
  tries: 0,
  levelRuns: 0,
  pruneProbes: 0,
};

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

/** Resolution could not finish inside its bounds: a publish refuses, a trigger fails closed. */
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
  /** The engine of the live builds this row serves; `""` for builds that declare none. */
  engine: string;
  /** The variant key over this row's group's axes (`""` for a group without axes). */
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
  /** The group this row resolves (its first pack id); a device's set is one row per group. */
  group: string;
  /** The chosen releases, by pack id. */
  entries: SetEntry[];
  /** Packs no release satisfies at this selector, by pack id. */
  unsatisfied: Unsatisfied[];
  /** The app releases this set serves (live on the channel, at this level, with a build on this
   *  platform and engine), newest first. */
  appReleases: string[];
}

export interface Resolution {
  /** Live app releases per channel, newest first. */
  live: Map<string, LiveRelease[]>;
  sets: ResolvedSet[];
}

// ── Ranges ───────────────────────────────────────────────────────────────────────────────────

/** `versionInRange` answers, memoised: the solver asks the same few questions very often. */
const rangeMemo = new Map<string, boolean>();
const RANGE_MEMO_MAX = 50_000;

/** `versionInRange`, memoised (bounded; a full memo starts over). */
function inRange(
  scheme: VersionScheme,
  version: string,
  range: string,
): boolean {
  resolveWork.steps++;
  resolveWork.rangeChecks++;
  const key = `${scheme}\u0000${version}\u0000${range}`;
  const hit = rangeMemo.get(key);
  if (hit !== undefined) return hit;
  const v = versionInRange(scheme, version, range);
  if (rangeMemo.size >= RANGE_MEMO_MAX) rangeMemo.clear();
  rangeMemo.set(key, v);
  return v;
}

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
export function levelInRange(
  range: string | undefined,
  level: number,
): boolean {
  resolveWork.steps++;
  resolveWork.rangeChecks++;
  const cmp = parseRange(range, CONTENT_API_RANGE_PATTERN);
  return cmp !== null && contentApiInRange(cmp, level);
}

/**
 * Does a pack variant run on a selector's engine? Yes when the selector's engine is `""` (builds
 * that declare none constrain nothing: the server cannot know their engine), when the variant
 * declares no `requires.engine`, or when the two are equal. The `engine` stage's rule, exported so
 * the console's compatibility matrix (P4-15) applies the same one.
 */
export function variantRunsOn(
  v: Pick<PackVariantFacts, "engine">,
  engine: string,
): boolean {
  return engine === "" || v.engine === null || v.engine === engine;
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
  /** `v.conflicts` as a set: a try checks it against every chosen pack. */
  conflicts: ReadonlySet<string>;
  /** `v.packs` as entries (each try walks them). */
  deps: readonly (readonly [string, string])[];
}

/** A variant's constraints in the shapes the solver walks, built once per variant. */
const derived = new WeakMap<
  PackVariantFacts,
  {
    conflicts: ReadonlySet<string>;
    deps: readonly (readonly [string, string])[];
  }
>();

/** A candidate of `pack`: `rel` at its variant `v`. */
function cand(pack: string, rel: PackReleaseFacts, v: PackVariantFacts): Cand {
  let d = derived.get(v);
  if (!d) {
    d = {
      conflicts: new Set(v.conflicts),
      deps: Object.entries(v.packs ?? {}),
    };
    derived.set(v, d);
  }
  return { pack, rel, v, conflicts: d.conflicts, deps: d.deps };
}

type Stage =
  | { ok: true; id: number; cands: Cand[] }
  | { ok: false; id: number; reason: UnsatisfiedReason; detail: string };

/** One group of resolvable packs (see the header). */
interface Group {
  id: string;
  packs: PackInput[];
  /** axis → every value any member declares. */
  axes: Map<string, string[]>;
  /** Every combination of `axes`, as variant keys. */
  variants: string[];
}

/** The projection of a variant assignment onto one pack's declared axes. */
function packVariantKey(
  pack: PackInput,
  assignment: Readonly<Record<string, string>>,
): string {
  const sub: Record<string, string> = {};
  for (const axis of Object.keys(pack.axes))
    if (assignment[axis] !== undefined) sub[axis] = assignment[axis]!;
  return variantKey(sub);
}

/** Every combination of `axes` (axis → values) as variant keys, in key order; stops at `cap`. */
function variantKeysOf(
  axes: ReadonlyMap<string, readonly string[]>,
  cap: number,
): string[] | null {
  let out: Record<string, string>[] = [{}];
  for (const axis of [...axes.keys()].sort()) {
    const next: Record<string, string>[] = [];
    for (const a of out)
      for (const value of axes.get(axis)!) {
        next.push({ ...a, [axis]: value });
        if (next.length > cap) return null;
      }
    out = next;
  }
  return out.map((a) => variantKey(a)).sort();
}

function parseAssignment(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (key === "") return out;
  for (const part of key.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export class PackResolver {
  readonly input: ResolutionInput;
  /** Resolvable packs (`compatible`, `standalone`), by id. */
  readonly universe: PackInput[];
  /** The groups of `universe`, by first pack id. */
  readonly groups: Group[];
  private readonly groupOfPack = new Map<string, Group>();
  private readonly packsById: Map<string, PackInput>;
  private readonly liveCache = new Map<string, LiveRelease[]>();
  private readonly channelCache = new Map<string, Candidate[]>();
  private readonly stageCache = new Map<string, Stage>();
  private readonly solveCache = new Map<
    string,
    { chosen: Cand[]; unsat: Unsatisfied[] }
  >();
  /** Work units left for this resolver's lifetime (see the header). */
  private budget = MAX_RESOLUTION_WORK;

  constructor(input: ResolutionInput) {
    this.input = input;
    this.packsById = new Map(input.packs.map((p) => [p.id, p]));
    this.universe = input.packs
      .filter((p) => p.binding === "compatible" || p.binding === "standalone")
      .sort(byId);
    this.groups = this.partition();
    for (const g of this.groups)
      for (const p of g.packs) this.groupOfPack.set(p.id, g);
  }

  /** Spend `n` work units, or fail the resolution. */
  private spend(n: number): void {
    this.budget -= n;
    if (this.budget < 0)
      throw new PackResolutionError(
        `pack-set resolution spent its budget of ${MAX_RESOLUTION_WORK} candidate checks; narrow the packs' variant axes, requires.packs and conflicts, or raise a channel floor`,
      );
  }

  /** The groups (see the header): same axis names, merged across dependencies and conflicts. */
  private partition(): Group[] {
    const parent = new Map(this.universe.map((p) => [p.id, p.id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    const union = (a: string, b: string) => {
      const x = find(a);
      const y = find(b);
      if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
    };
    for (const p of this.universe) {
      const linked = new Set<string>();
      for (const rel of p.releases.values())
        for (const v of rel.variants) {
          // Every constraint a release declares is read once: charge it.
          this.spend(1 + v.conflicts.length);
          resolveWork.steps += 1 + v.conflicts.length;
          for (const t in v.packs ?? {}) {
            this.spend(1);
            resolveWork.steps++;
            linked.add(t);
          }
          for (const t of v.conflicts) linked.add(t);
        }
      for (const t of linked) if (parent.has(t)) union(p.id, t);
    }
    // Merge groups whose axis-name sets are equal, until they are all distinct.
    for (;;) {
      const axesOf = new Map<string, Set<string>>();
      for (const p of this.universe) {
        const root = find(p.id);
        const set = axesOf.get(root) ?? new Set<string>();
        for (const a of Object.keys(p.axes)) set.add(a);
        axesOf.set(root, set);
      }
      const byAxes = new Map<string, string>();
      let merged = false;
      for (const [root, set] of axesOf) {
        const key = [...set].sort().join(",");
        const other = byAxes.get(key);
        if (other === undefined) byAxes.set(key, root);
        else {
          union(other, root);
          merged = true;
        }
      }
      if (!merged) break;
    }
    const members = new Map<string, PackInput[]>();
    for (const p of this.universe) {
      const root = find(p.id);
      members.set(root, [...(members.get(root) ?? []), p]);
    }
    const groups: Group[] = [];
    for (const packs of members.values()) {
      const axes = new Map<string, string[]>();
      for (const p of packs)
        for (const [axis, values] of Object.entries(p.axes))
          axes.set(
            axis,
            [...new Set([...(axes.get(axis) ?? []), ...values])].sort(),
          );
      const variants = variantKeysOf(axes, MAX_SELECTORS);
      if (variants === null)
        throw new PackResolutionError(
          `the packs ${packs.map((p) => p.id).join(", ")} are tied together and need more than ${MAX_SELECTORS} variant combinations; narrow their variant axes`,
        );
      groups.push({ id: packs[0]!.id, packs, axes, variants });
    }
    return groups.sort(byId);
  }

  /** A declared pack, by id. */
  pack(id: string): PackInput | undefined {
    return this.packsById.get(id);
  }

  /** The id of the group `pack` is resolved in, or null for a pack that enters no set. */
  groupOf(pack: string): string | null {
    return this.groupOfPack.get(pack)?.id ?? null;
  }

  /** The live app releases of `channel`, newest first. */
  live(channel: string): LiveRelease[] {
    const cached = this.liveCache.get(channel);
    if (cached) return cached;
    const { app, yanked } = this.input;
    const floor = app.minSupported.get(channel) ?? null;
    // `channelCandidates` scans every app release once.
    resolveWork.steps += app.candidates.length;
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
    this.spend(out.length);
    resolveWork.steps += pack.candidates.length;
    this.channelCache.set(key, out);
    return out;
  }

  private readonly levelsCache = new Map<
    string,
    ReturnType<PackResolver["computeLevels"]>
  >();

  /** `computeLevels` of `channel`'s live releases, memoised per channel (and charged once). */
  private levels(channel: string): ReturnType<PackResolver["computeLevels"]> {
    resolveWork.steps++;
    const hit = this.levelsCache.get(channel);
    if (hit) return hit;
    const out = this.computeLevels(this.live(channel));
    this.levelsCache.set(channel, out);
    return out;
  }

  /** level → platform → engine (`""` for none) → the live releases there, newest first. */
  private computeLevels(live: readonly LiveRelease[]): Map<
    number,
    {
      platforms: Map<string, Map<string, string[]>>;
      packChannels: Record<string, string> | null;
    }
  > {
    const out = new Map<
      number,
      {
        platforms: Map<string, Map<string, string[]>>;
        packChannels: Record<string, string> | null;
      }
    >();
    resolveWork.levelRuns++;
    for (const r of live) {
      const facts = this.input.app.releases.get(r.releaseId)!;
      let level = out.get(r.contentApi);
      if (!level) {
        // `live` is newest first: the first release of a level names its mapping.
        level = { platforms: new Map(), packChannels: facts.packChannels };
        out.set(r.contentApi, level);
      }
      this.spend(1 + facts.builds.length);
      resolveWork.steps += 1 + facts.builds.length;
      // Each (platform, engine) once per release: a release with several builds there counts once.
      const seen = new Set<string>();
      for (const b of facts.builds) {
        if (b.platform === null) continue;
        const engine = b.engine ?? "";
        const key = `${b.platform}\u0000${engine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const engines = level.platforms.get(b.platform) ?? new Map();
        const list: string[] = engines.get(engine) ?? [];
        list.push(r.releaseId);
        engines.set(engine, list);
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

  /** The stages for one pack at one selector (see the header), memoised. */
  stage(
    pack: PackInput,
    ctx: {
      channel: string;
      level: number;
      engine: string;
      assignment: Readonly<Record<string, string>>;
      packChannels: Record<string, string> | null;
    },
  ): Stage {
    const pc = this.routedChannel(pack, ctx.channel, ctx.packChannels);
    const vk = packVariantKey(pack, ctx.assignment);
    const key = `${pack.id}\u0000${pc}\u0000${ctx.level}\u0000${ctx.engine}\u0000${vk}`;
    const hit = this.stageCache.get(key);
    if (hit) return hit;
    const out = this.computeStage(pack, pc, ctx.level, ctx.engine, vk);
    this.stageCache.set(key, out);
    return out;
  }

  private computeStage(
    pack: PackInput,
    pc: string,
    level: number,
    engine: string,
    vk: string,
  ): Stage {
    const id = this.stageCache.size;
    const ranked = this.packChannelReleases(pack, pc);
    this.spend(ranked.length);
    const all: Cand[] = [];
    for (const c of ranked) {
      resolveWork.steps++;
      const rel = pack.releases.get(c.releaseId);
      if (!rel) continue;
      const v =
        rel.variants.find((x) => x.variantKey === vk) ?? rel.variants[0];
      if (!v) continue;
      // Building a candidate's constraint shapes is part of the work: charge it (twice a try
      // per constraint, measured).
      if (!derived.has(v)) {
        let n = v.conflicts.length;
        for (const _ in v.packs ?? {}) n++;
        this.spend(2 * n);
        resolveWork.steps += n;
      }
      all.push(cand(pack.id, rel, v));
    }
    if (all.length === 0)
      return {
        ok: false,
        id,
        reason: "no-release",
        detail: `channel ${pc} serves no release of ${pack.id}`,
      };
    let cands = all;
    if (pack.binding === "compatible") {
      cands = cands.filter((c) =>
        levelInRange(c.v.contentApi?.[APP_DELIVERABLE_ID], level),
      );
      if (cands.length === 0)
        return {
          ok: false,
          id,
          reason: "content-api",
          detail: `no release of ${pack.id} on ${pc} supports contentApi ${level}`,
        };
    }
    const withEngine = cands.filter(
      (c) => c.v.variantKey !== vk || variantRunsOn(c.v, engine),
    );
    if (withEngine.length === 0)
      return {
        ok: false,
        id,
        reason: "engine",
        detail: `no release of ${pack.id} on ${pc} runs on ${engine}`,
      };
    cands = withEngine.filter((c) => c.v.variantKey === vk);
    if (cands.length === 0)
      return {
        ok: false,
        id,
        reason: "variant",
        detail: `no release of ${pack.id} on ${pc} has variant ${vk || "default"}`,
      };
    const levelFree = pack.minSupported.get(pc) ?? null;
    const levelFloor = pack.floors.get(pc)?.get(level) ?? null;
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
        id,
        reason: "content-floor",
        detail: `no release of ${pack.id} on ${pc} is at or above the floor${levelFloor !== null ? ` ${levelFloor} for contentApi ${level}` : ""}${levelFree !== null ? `${levelFloor !== null ? " and" : ""} ${levelFree}` : ""}`,
      };
    return { ok: true, id, cands: floored };
  }

  /** Is `c` consistent with `chosen`? Null when it is, else the broken constraint. */
  private conflictWith(
    c: Cand,
    chosen: ReadonlyMap<string, Cand>,
    present: ReadonlySet<string>,
  ): {
    reason: "dependency" | "conflict";
    detail: string;
    /** A CHOSEN pack conflicts with `c`'s whole pack: no release of it can join. */
    packWide?: true;
  } | null {
    for (const [target, range] of c.deps) {
      resolveWork.steps++;
      if (!present.has(target))
        return {
          reason: "dependency",
          detail: `${c.pack} ${c.rel.version} requires ${target} ${range}, which has no release in this set`,
        };
      const t = chosen.get(target);
      const scheme = this.packsById.get(target)?.scheme;
      if (t && (!scheme || !inRange(scheme, t.rel.version, range)))
        return {
          reason: "dependency",
          detail: `${c.pack} ${c.rel.version} requires ${target} ${range}; the set holds ${t.rel.version}`,
        };
    }
    const scheme = this.packsById.get(c.pack)!.scheme;
    for (const j of chosen.values()) {
      resolveWork.steps++;
      const range = j.v.packs?.[c.pack];
      if (range !== undefined && !inRange(scheme, c.rel.version, range))
        return {
          reason: "dependency",
          detail: `${j.pack} ${j.rel.version} requires ${c.pack} ${range}, not ${c.rel.version}`,
        };
      if (j.conflicts.has(c.pack))
        return {
          reason: "conflict",
          detail: `${j.pack} ${j.rel.version} conflicts with ${c.pack}`,
          packWide: true,
        };
      if (c.conflicts.has(j.pack))
        return {
          reason: "conflict",
          detail: `${c.pack} ${c.rel.version} conflicts with ${j.pack} ${j.rel.version}`,
        };
    }
    return null;
  }

  /**
   * The solver over packs that passed their stages (see the header). `key` is the stage outputs'
   * ids, which determine the problem exactly. The packs are split into COMPONENTS (packs a
   * `requires.packs` or `conflicts` entry of some candidate links), each solved on its own with its
   * own switch to "a pack may be left out": a pack is dropped only when its own component cannot
   * keep it.
   */
  private solve(
    key: string,
    order0: { id: string; cands: Cand[] }[],
  ): { chosen: Cand[]; unsat: Unsatisfied[] } {
    const hit = this.solveCache.get(key);
    if (hit) return hit;
    // A problem without a single dependency or conflict needs no search: newest of each.
    let constrained = false;
    for (const p of order0) {
      this.spend(p.cands.length);
      resolveWork.steps += p.cands.length;
      if (p.cands.some((c) => c.deps.length > 0 || c.conflicts.size > 0))
        constrained = true;
    }
    if (!constrained) {
      const result = { chosen: order0.map((p) => p.cands[0]!), unsat: [] };
      this.solveCache.set(key, result);
      return result;
    }
    const chosen: Cand[] = [];
    const unsat: Unsatisfied[] = [];
    for (const comp of this.components(order0)) {
      const r = this.solveComponent(comp);
      chosen.push(...r.chosen);
      unsat.push(...r.unsat);
    }
    const index = new Map(order0.map((p, i) => [p.id, i]));
    const result = {
      chosen: chosen.sort((a, b) => index.get(a.pack)! - index.get(b.pack)!),
      unsat,
    };
    this.solveCache.set(key, result);
    return result;
  }

  /** `order` split into edge-connected components, each in `order`'s order. */
  private components(
    order: { id: string; cands: Cand[] }[],
  ): { id: string; cands: Cand[] }[][] {
    const parent = new Map(order.map((p) => [p.id, p.id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    for (const p of order)
      for (const c of p.cands) {
        this.spend(1 + c.deps.length + c.conflicts.size);
        resolveWork.steps += 1 + c.deps.length + c.conflicts.size;
        for (const [t] of c.deps)
          if (parent.has(t)) parent.set(find(t), find(p.id));
        for (const t of c.conflicts)
          if (parent.has(t)) parent.set(find(t), find(p.id));
      }
    const out = new Map<string, { id: string; cands: Cand[] }[]>();
    for (const p of order) {
      const r = find(p.id);
      out.set(r, [...(out.get(r) ?? []), p]);
    }
    return [...out.values()];
  }

  /** One component: prune, a search keeping every pack, then (only if none) one leaving some out. */
  private solveComponent(order0: { id: string; cands: Cand[] }[]): {
    chosen: Cand[];
    unsat: Unsatisfied[];
  } {
    const unsat = new Map<string, Unsatisfied>();

    // 1. Prune: a candidate whose dependency no candidate of its target satisfies goes; a pack
    //    left with none is unsatisfied, which may prune its dependants in turn. "Does some
    //    candidate of T hold range R" is memoised until T's domain changes, and every target
    //    candidate a miss examines is charged.
    const domains = new Map(order0.map((p) => [p.id, [...p.cands]]));
    const support = new Map<string, Map<string, boolean>>();
    const supported = (target: string, range: string): boolean => {
      this.spend(1);
      resolveWork.steps++;
      resolveWork.pruneProbes++;
      const memo = support.get(target);
      const hit = memo?.get(range);
      if (hit !== undefined) return hit;
      const scheme = this.packsById.get(target)?.scheme;
      const domain = domains.get(target) ?? [];
      // A range check costs about twice a solver try (measured): charge it so.
      this.spend(2 * domain.length);
      const v =
        scheme !== undefined &&
        domain.some((t) => inRange(scheme, t.rel.version, range));
      if (memo) memo.set(range, v);
      else support.set(target, new Map([[range, v]]));
      return v;
    };
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const [id, cands] of domains) {
        resolveWork.steps += cands.length;
        const kept = cands.filter((c) =>
          c.deps.every(([t, r]) => supported(t, r)),
        );
        if (kept.length === cands.length) continue;
        pruned = true;
        support.delete(id);
        if (kept.length > 0) {
          domains.set(id, kept);
          continue;
        }
        const c = cands[0]!;
        const [target, range] = c.deps.find(([t, r]) => !supported(t, r))!;
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
    // 2. Search, every pack kept; 3. if none exists, leave out as FEW packs as possible: one,
    //    then two, … (the omission tried after each pack's releases), so newer releases of
    //    earlier packs never cost a later pack its place.
    const chosen = new Map<string, Cand>();
    const omitted = new Set<string>();
    // The packs not left out (undecided ones count: their constraints are checked when chosen).
    const present = new Set(order.map((p) => p.id));
    const dfs = (i: number, omits: number): boolean => {
      if (i === order.length) return true;
      const p = order[i]!;
      for (const c of p.cands) {
        // A try costs a check against every chosen pack and every dependency.
        this.spend(1 + chosen.size + c.deps.length);
        resolveWork.steps++;
        resolveWork.tries++;
        const why = this.conflictWith(c, chosen, present);
        // A conflict names a whole pack: once a chosen pack refuses `p`, no release of `p` can
        // join, so its remaining releases are not tried (|A| + |B| tries, not |A| × |B|).
        if (why?.packWide) break;
        if (why) continue;
        chosen.set(p.id, c);
        if (dfs(i + 1, omits)) return true;
        chosen.delete(p.id);
      }
      if (omits === 0) return false;
      this.spend(1);
      // Leaving `p` out breaks every chosen pack that depends on it.
      resolveWork.steps += 1 + chosen.size;
      for (const j of chosen.values())
        if (j.v.packs?.[p.id] !== undefined) return false;
      omitted.add(p.id);
      present.delete(p.id);
      if (dfs(i + 1, omits - 1)) return true;
      omitted.delete(p.id);
      present.add(p.id);
      return false;
    };
    for (let k = 0; k <= order.length; k++) {
      chosen.clear();
      omitted.clear();
      if (dfs(0, k)) break;
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
    return {
      chosen: order.flatMap((p) =>
        chosen.has(p.id) ? [chosen.get(p.id)!] : [],
      ),
      unsat: [...unsat.values()],
    };
  }

  /** One row: one group at one selector. */
  resolveSelector(ctx: {
    channel: string;
    level: number;
    platform: string;
    engine: string;
    group: Group;
    variant: string;
    packChannels: Record<string, string> | null;
    appReleases: string[];
  }): ResolvedSet {
    const assignment = parseAssignment(ctx.variant);
    const order: { id: string; cands: Cand[] }[] = [];
    const unsatisfied: Unsatisfied[] = [];
    const ids: number[] = [];
    // One step per row, and one per pack's (memoised) stage lookup.
    resolveWork.steps += 1 + ctx.group.packs.length;
    for (const pack of ctx.group.packs) {
      const s = this.stage(pack, { ...ctx, assignment });
      ids.push(s.id);
      if (s.ok) order.push({ id: pack.id, cands: s.cands });
      else
        unsatisfied.push({ pack: pack.id, reason: s.reason, detail: s.detail });
    }
    const solved = this.solve(ids.join(","), order);
    return {
      channel: ctx.channel,
      appDeliverable: APP_DELIVERABLE_ID,
      contentApi: ctx.level,
      platform: ctx.platform,
      engine: ctx.engine,
      variant: ctx.variant,
      group: ctx.group.id,
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

  /** Every row of every channel, resolved. Throws `PackResolutionError` past the bounds. */
  resolve(): Resolution {
    const live = new Map<string, LiveRelease[]>();
    const sets: ResolvedSet[] = [];
    for (const channel of [...this.input.channels].sort()) {
      const releases = this.live(channel);
      live.set(channel, releases);
      if (this.groups.length === 0) continue;
      const levels = this.levels(channel);
      for (const level of [...levels.keys()].sort((a, b) => a - b)) {
        const l = levels.get(level)!;
        for (const platform of [...l.platforms.keys()].sort()) {
          const engines = l.platforms.get(platform)!;
          for (const engine of [...engines.keys()].sort()) {
            const appReleases = engines.get(engine)!;
            for (const group of this.groups)
              for (const variant of group.variants) {
                if (sets.length >= MAX_SELECTORS)
                  throw new PackResolutionError(
                    `pack-set resolution needs more than ${MAX_SELECTORS} sets (channels × contentApi levels × platforms × engines × each group's variants); narrow the packs' variant axes or raise a channel floor`,
                  );
                sets.push(
                  this.resolveSelector({
                    channel,
                    level,
                    platform,
                    engine,
                    group,
                    variant,
                    packChannels: l.packChannels,
                    appReleases,
                  }),
                );
              }
          }
        }
      }
    }
    return { live, sets };
  }

  /** The facts of a set member's variant at `variant` (the row's key). */
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
    return v ? cand(pack, rel, v) : null;
  }

  /**
   * The constraint `set` breaks once `holds` replace (or join) its members, or null. Devices apply
   * holds over the feed's set as they apply pins; every member must still find its dependencies
   * in range and share the set with nothing it conflicts with. Only holds of the row's own group
   * apply (no constraint crosses a group).
   */
  heldSetViolation(
    set: Pick<ResolvedSet, "entries" | "variant" | "group">,
    holds: readonly { pack: string; releaseId: string }[],
  ): string | null {
    const mine = holds.filter((h) => this.groupOf(h.pack) === set.group);
    if (mine.length === 0) return null;
    const members = new Map<string, Cand>();
    for (const e of set.entries) {
      const c = this.memberCand(e.pack, e.releaseId, set.variant);
      if (c) members.set(e.pack, c);
    }
    for (const h of mine) {
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
    for (const c of members.values())
      for (const [target, range] of Object.entries(c.v.packs ?? {})) {
        const t = members.get(target);
        const scheme = this.packsById.get(target)?.scheme;
        if (!t || !scheme || !inRange(scheme, t.rel.version, range))
          return `${c.pack} ${c.rel.version} requires ${target} ${range}${t ? `; the held set holds ${t.rel.version}` : ", which the held set lacks"}`;
      }
    return null;
  }

  /**
   * Why `releaseId` of `pack` fails a row it is meant for, or null: the pack-publish check
   * (CONTENT §6.4). A release the row's channel does not serve, outside its contentApi range,
   * for another engine or below a floor is simply not chosen (a release for a coming engine is
   * published before the app that runs it). One that lacks the row's variant fails (`variant`);
   * one that passes its stages but is passed over for an OLDER release, or leaves the pack
   * unsatisfied, broke a dependency or a conflict, and fails with it.
   */
  publishViolation(
    set: ResolvedSet,
    pack: PackInput,
    releaseId: string,
    packChannels: Record<string, string> | null,
  ): { reason: "variant" | "dependency" | "conflict"; detail: string } | null {
    if (this.groupOf(pack.id) !== set.group) return null;
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
      engine: set.engine,
      assignment,
      packChannels,
    });
    if (!s.ok || !s.cands.some((c) => c.rel.releaseId === releaseId))
      return null;
    const entry = set.entries.find((e) => e.pack === pack.id);
    if (entry) {
      const chosenRank = ranked.findIndex(
        (c) => c.releaseId === entry.releaseId,
      );
      if (chosenRank <= rank) return null;
    }
    const others = new Map<string, Cand>();
    for (const e of set.entries) {
      if (e.pack === pack.id) continue;
      const c = this.memberCand(e.pack, e.releaseId, set.variant);
      if (c) others.set(e.pack, c);
    }
    const present = new Set([...others.keys(), pack.id]);
    const why = this.conflictWith(cand(pack.id, rel, v), others, present);
    return (
      why ?? {
        reason: "dependency",
        detail: `${pack.id} ${rel.version} cannot join this set with the releases its dependants require`,
      }
    );
  }

  /** The `packChannels` mapping of `channel`'s live releases at `level`, or null. */
  levelMapping(channel: string, level: number): Record<string, string> | null {
    return this.levels(channel).get(level)?.packChannels ?? null;
  }
}
