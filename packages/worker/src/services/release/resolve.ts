/// <reference types="@cloudflare/workers-types" />

/**
 * Per-platform release resolution over the release model v2 (P2-05, README §3.4).
 *
 * "Which release of deliverable D does channel C serve on platform P / arch A?" — answered from
 * the truth store (`release_metadata`, `release_builds`, `release_yanks`,
 * `release_channel_policy`), not from GitHub's list order. The legacy GitHub-resolved routes
 * (`/release/dl`, the appcast, `/update/version`) keep their own resolver in `gateway.ts` and
 * apply the same yanks and pins through `legacyPolicyFor` below, so a yank or a pin means one
 * thing everywhere.
 *
 * ── THE RULES (every deliverable) ───────────────────────────────────────────────────────────
 *
 *   1. Candidates are the deliverable's releases that are MEMBERS of the channel or of any
 *      channel it includes (beta ⊇ stable unless the policy says otherwise), plus the
 *      channel's pointer. Membership is `release_metadata.channel` when set, else GitHub's
 *      prerelease flag (prerelease → beta, otherwise stable) and the manual-channel regexes.
 *   2. Yanked releases are removed — except a PINNED pointer: "yanked releases resolve only by
 *      explicit pin". A version selector (`/…/1.2.3/…`) is explicit too.
 *   3. Order by the deliverable's version scheme (`semver` | `semver+build` | `4part`), ties by
 *      `seq`. For the app, a tag in `ignoreTags` is never a candidate, and a tag outside
 *      `stableTagPattern` is a candidate only through a manual channel's own regex.
 *   4. A pinned channel serves only releases at or below its pointer; an unpinned one the
 *      newest candidate.
 *   5. Per platform: only releases with a build for the requested platform (or build id) and
 *      a matching arch survive — `universal` and `any` match every arch — so a release missing
 *      the iOS build does not blank iOS: iOS falls back to the newest release that has one.
 *
 * Floors (`min_supported`) and `critical` are stored and returned, never enforced here: nothing
 * device-facing enforces them until the signed feed (P3-03).
 *
 * The core (`resolveCandidates`) is PURE — rows in, a decision out — and is table-tested on
 * fixtures (`test/resolve.test.ts`). `resolveBuild` is the D1 shell around it.
 */

import {
  APP_DELIVERABLE_ID,
  BUILT_IN_CHANNELS,
  compileManualChannelRegex,
  DEFAULT_STABLE_TAG_PATTERN,
} from "@polaris-key/manifest";
import { CHANNEL_ALIASES, CHANNEL_NAME_PATTERN } from "@polaris-key/protocol";
import type { Db } from "../../core/platform.js";
import {
  compareVersions as compareVersionsV4,
  parseVersion,
} from "@polaris-key/client-core/version";
import {
  parseIgnoreTags,
  parseManualChannels,
  type ManualChannel,
} from "./channels.js";
import { getReleaseConfig, type ReleaseConfigRow } from "./config.js";
import type {
  ReleaseBuildRow,
  ReleaseChannelPolicyRow,
  ReleaseDeliverableRow,
} from "./model.js";
import type { ReleaseMetadataRow } from "./store.js";

// ── Channel names ────────────────────────────────────────────────────────────────────────────

/** The channel-name shape (WIRE-CONTRACT-V3 §5.1 rule 1, `CHANNEL_NAME_PATTERN`). */
const CHANNEL_NAME_RE = new RegExp(CHANNEL_NAME_PATTERN);

/**
 * The canonical name a channel route segment or selector stands for, or null when it is not a
 * channel name at all. `staging` resolves to `beta` UNLESS the product declares a manual
 * channel named `staging` (P0-04 plan §10): a declared name always wins over the alias. A
 * canonical name is what policy rows and operations store; `staging` itself is never stored.
 */
export function canonicalChannel(
  raw: string,
  manual: readonly ManualChannel[] = [],
): string | null {
  if (!CHANNEL_NAME_RE.test(raw)) return null;
  if (manual.some((c) => c.name === raw)) return raw;
  // `Object.hasOwn`, not a bare index: `constructor` is a well-formed channel name (P0-04).
  return Object.hasOwn(CHANNEL_ALIASES, raw)
    ? CHANNEL_ALIASES[raw as keyof typeof CHANNEL_ALIASES]
    : raw;
}

/** A selector is a VERSION when it starts with a digit and has a dot (`1.2.3`, `1.2.3.4`). */
export function isVersionSelector(selector: string): boolean {
  return /^\d+\.\d/.test(selector);
}

// ── Version schemes ──────────────────────────────────────────────────────────────────────────

export const VERSION_SCHEMES = ["semver", "semver+build", "4part"] as const;
export type VersionScheme = (typeof VERSION_SCHEMES)[number];

/**
 * Does `v` parse in `scheme`? A version that does not cannot be ordered against the rest.
 * client-core's `parseVersion` (P3-02): SemVer 2.0's own grammar for `semver` and
 * `semver+build`, P2-04's four-part grammar for `4part` — the parser every v4 SDK runs, so the
 * Worker and the clients agree on what a version is (P3-03).
 */
export function parsesInScheme(scheme: VersionScheme, v: string): boolean {
  return parseVersion(scheme, v) !== null;
}

/**
 * Precedence in `scheme`: > 0 when `a` is newer. client-core's `compareVersions` (P3-03: one
 * ordering, the clients'), with an unparseable pair comparing equal so `seq` decides — callers
 * compare only versions that parse (`parsesInScheme`).
 *
 *   semver        SemVer 2.0 §11 precedence (build metadata ignored);
 *   semver+build  semver, then digit-only `+N` build metadata (`1.2.3+45` > `1.2.3+9`);
 *   4part         `a.b.c.d`, numerically on digit strings (no precision limit).
 */
export function compareVersions(
  scheme: VersionScheme,
  a: string,
  b: string,
): number {
  return compareVersionsV4(scheme, a, b) ?? 0;
}

/**
 * The scheme a deliverable declares (`def_json` is P2-04's `ManifestAppDeliverable`, so the
 * scheme is `versioning.scheme`), default `semver`. P2-05 read a top-level `versionScheme`
 * member no writer ever set, so every product resolved as `semver` until P3-03.
 */
export function versionSchemeOf(
  deliverable: Pick<ReleaseDeliverableRow, "def_json"> | null,
): VersionScheme {
  if (!deliverable?.def_json) return "semver";
  try {
    const def = JSON.parse(deliverable.def_json) as {
      versioning?: { scheme?: unknown } | null;
    };
    const scheme = def?.versioning?.scheme;
    return (VERSION_SCHEMES as readonly unknown[]).includes(scheme)
      ? (scheme as VersionScheme)
      : "semver";
  } catch {
    return "semver";
  }
}

// ── The pure core ────────────────────────────────────────────────────────────────────────────

/** One build of a candidate release, as resolution sees it. */
export interface CandidateBuild {
  buildId: string;
  /** `null` = platform-independent (a pack variant): matches every platform. */
  platform: string | null;
  arch: string;
}

/** One release of the deliverable, as resolution sees it. */
export interface Candidate {
  releaseId: string;
  version: string;
  seq: number | null;
  /** `release_metadata.channel` (already canonical), or null to derive from GitHub. */
  channel: string | null;
  /** GitHub's prerelease flag (from the sync's `metadata_json`). */
  prerelease: boolean;
  /** The GitHub tag this release was published as, or null for a tagless descriptor release. */
  tag: string | null;
  builds: CandidateBuild[];
}

/** A channel's policy, as resolution sees it. */
export interface PolicyView {
  pointer: string | null;
  pinned: boolean;
  /** Channels this one includes; null = the default (`beta` includes `stable`). */
  includes: string[] | null;
}

/** What the request asks for. */
export type Selector =
  | { type: "channel"; channel: string }
  | { type: "version"; version: string };

/** The per-platform filter. All optional; an omitted one does not filter. */
export interface Target {
  platform?: string;
  arch?: string;
  buildId?: string;
}

export interface ResolveInput {
  deliverable: string;
  scheme: VersionScheme;
  selector: Selector;
  releases: readonly Candidate[];
  yanked: ReadonlySet<string>;
  /** Policy rows of THIS deliverable, by canonical channel. */
  policies: ReadonlyMap<string, PolicyView>;
  manualChannels: readonly ManualChannel[];
  /** The app's tag filter (`stableTagPattern`, `ignoreTags`); ignored for a pack. */
  stableTagPattern?: string | null;
  ignoreTags?: ReadonlySet<string>;
  target?: Target;
}

export interface Resolved {
  release: Candidate;
  /** The build that matched the target, when the target named one (else the first build). */
  build: CandidateBuild | null;
  /** How it was chosen. */
  via: "newest" | "pinned" | "version";
}

/**
 * The default `includes`: dev ⊇ beta ⊇ stable (README §3.4); every other channel includes
 * nothing. A declared `includes` (even `[]`) wins over this.
 */
export function defaultIncludes(channel: string): string[] {
  if (channel === "dev") return ["beta"];
  return channel === "beta" ? ["stable"] : [];
}

/** The channel and everything it includes, transitively (cycles are harmless). */
export function channelClosure(
  channel: string,
  policies: ReadonlyMap<string, PolicyView>,
): Set<string> {
  const out = new Set<string>();
  const queue = [channel];
  while (queue.length > 0) {
    const c = queue.shift() as string;
    if (out.has(c)) continue;
    out.add(c);
    const inc = policies.get(c)?.includes ?? defaultIncludes(c);
    queue.push(...inc);
  }
  return out;
}

/** True when the build serves the target. */
export function buildMatches(b: CandidateBuild, t: Target): boolean {
  if (t.buildId !== undefined && b.buildId !== t.buildId) return false;
  if (
    t.platform !== undefined &&
    b.platform !== null &&
    b.platform !== t.platform
  )
    return false;
  if (
    t.arch !== undefined &&
    t.arch !== "any" &&
    b.arch !== t.arch &&
    b.arch !== "universal" &&
    b.arch !== "any"
  )
    return false;
  return true;
}

function hasTarget(t: Target | undefined): t is Target {
  return (
    !!t &&
    (t.platform !== undefined ||
      t.arch !== undefined ||
      t.buildId !== undefined)
  );
}

/** The build of `c` the target asks for: the first match (by build id), or null. */
function targetBuild(
  c: Candidate,
  t: Target | undefined,
): CandidateBuild | null {
  const sorted = [...c.builds].sort((a, b) =>
    a.buildId < b.buildId ? -1 : a.buildId > b.buildId ? 1 : 0,
  );
  if (!hasTarget(t)) return sorted[0] ?? null;
  return sorted.find((b) => buildMatches(b, t)) ?? null;
}

/**
 * Resolve one selector over one deliverable's releases. Pure: every input is a row the caller
 * read. Returns null when nothing qualifies (the route answers not-found).
 */
export function resolveCandidates(input: ResolveInput): Resolved | null {
  const { scheme, selector, target } = input;
  const servesTarget = (c: Candidate) =>
    !hasTarget(target) || targetBuild(c, target) !== null;

  // Order: the scheme when every release in play parses, else `seq` (publication order) alone,
  // so the order is total whatever mix of tags a channel holds (the `newestOf` rule, P0-02).
  const order = (set: readonly Candidate[]) => orderOver(scheme, set);
  const newest = (set: readonly Candidate[]): Candidate | null => {
    if (set.length === 0) return null;
    const cmp = order(set);
    let best = set[0] as Candidate;
    for (const c of set.slice(1)) if (cmp(c, best) > 0) best = c;
    return best;
  };

  // A version selector is explicit: a yanked release still resolves (rule 2).
  if (selector.type === "version") {
    const want = selector.version.replace(/^v/, "");
    const exact = input.releases.filter(
      (r) => r.version === want && servesTarget(r),
    );
    // Two tags may strip to one version (`v1.2.0`, `1.2.0`); the later publication wins.
    const pick = [...exact].sort((a, b) => (b.seq ?? -1) - (a.seq ?? -1))[0];
    return pick
      ? { release: pick, build: targetBuild(pick, target), via: "version" }
      : null;
  }

  const { candidates, pinned } = channelMembers(input, selector.channel);
  const pick = newest(candidates.filter(servesTarget));
  if (!pick) return null;
  return {
    release: pick,
    build: targetBuild(pick, target),
    via: pinned ? "pinned" : "newest",
  };
}

/** The scheme order over `set` (see `resolveCandidates`): > 0 when `a` is newer. */
function orderOver(
  scheme: VersionScheme,
  set: readonly Candidate[],
): (a: Candidate, b: Candidate) => number {
  const allParse = set.every((c) => parsesInScheme(scheme, c.version));
  return (a: Candidate, b: Candidate): number => {
    const v = allParse ? compareVersions(scheme, a.version, b.version) : 0;
    return v !== 0 ? v : (a.seq ?? -1) - (b.seq ?? -1);
  };
}

/**
 * Rules 1–4 for one channel, with no per-platform filter: the releases the channel may serve
 * (members of its closure plus its pointer, yanks removed except a pinned pointer, at or below a
 * pinned pointer), unordered, and whether the channel is pinned.
 */
function channelMembers(
  input: Omit<ResolveInput, "selector" | "target">,
  channel: string,
): { candidates: Candidate[]; pinned: boolean } {
  const { scheme } = input;
  const byId = new Map(input.releases.map((r) => [r.releaseId, r]));
  const closure = channelClosure(channel, input.policies);
  const isApp = input.deliverable === APP_DELIVERABLE_ID;
  const stableRe =
    (input.stableTagPattern
      ? compileManualChannelRegex(input.stableTagPattern)
      : null) ?? compileManualChannelRegex(DEFAULT_STABLE_TAG_PATTERN);
  const manualRes = input.manualChannels
    .map((m) => ({ name: m.name, re: compileManualChannelRegex(m.regex) }))
    .filter((m): m is { name: string; re: RegExp } => m.re !== null);

  /** Is `r` a candidate of the channel closure, through which kind of membership? */
  const isMember = (r: Candidate): boolean => {
    if (isApp && r.tag !== null && input.ignoreTags?.has(r.tag)) return false;
    if (r.channel !== null) {
      if (!closure.has(r.channel)) return false;
    } else {
      const builtin = r.prerelease ? "beta" : "stable";
      const viaBuiltin = closure.has(builtin);
      const viaManual =
        r.tag !== null &&
        manualRes.some(
          (m) => closure.has(m.name) && m.re.test(r.tag as string),
        );
      if (!viaBuiltin && !viaManual) return false;
      // The tag filter (rule 3) guards the built-in channels; a manual channel keeps its own
      // regex. A tagless release (descriptor, `<deliverable>@<version>`) has no tag to filter.
      if (
        !viaManual &&
        isApp &&
        r.tag !== null &&
        stableRe &&
        !stableRe.test(r.tag)
      )
        return false;
    }
    return true;
  };

  const policy = input.policies.get(channel);
  const pointer = policy?.pointer ? (byId.get(policy.pointer) ?? null) : null;
  const pinned = !!policy?.pinned && pointer !== null;

  let candidates = input.releases.filter(isMember);
  if (pointer && !candidates.includes(pointer)) candidates.push(pointer);
  candidates = candidates.filter(
    (c) => !input.yanked.has(c.releaseId) || (pinned && c === pointer),
  );

  if (pinned && pointer) {
    // Rule 4: at or below the pointer — in the same order the channel uses.
    const cmp = orderOver(scheme, [...candidates, pointer]);
    candidates = candidates.filter((c) => cmp(c, pointer) <= 0);
  }

  return { candidates, pinned };
}

/**
 * Every release one channel may serve, NEWEST FIRST in the channel's own order (P2b-05's
 * storefront feeds list the history, not just the head). Rules 1–4 of `resolveCandidates`, no
 * per-platform filter: a feed filters by its own outlet's build afterwards.
 */
export function channelCandidates(
  input: Omit<ResolveInput, "selector" | "target">,
  channel: string,
): Candidate[] {
  const { candidates } = channelMembers(input, channel);
  const cmp = orderOver(input.scheme, candidates);
  return [...candidates].sort(
    (a, b) =>
      cmp(b, a) ||
      (a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0),
  );
}

// ── The D1 shell ─────────────────────────────────────────────────────────────────────────────

export interface ResolveBuildOptions {
  /** Default `app`. */
  deliverable?: string;
  /** A channel name (`stable`, `beta`, `staging`, a manual channel, `latest`) or a version. */
  selector: string;
  platform?: string;
  arch?: string;
  buildId?: string;
}

export interface BuildResolution {
  release: ReleaseMetadataRow;
  build: ReleaseBuildRow | null;
  via: Resolved["via"];
  /** The canonical channel the selector named, or null for a version selector. */
  channel: string | null;
}

/** `metadata_json.prerelease`, as the GitHub sync records it. */
export function prereleaseOf(
  row: Pick<ReleaseMetadataRow, "metadata_json">,
): boolean {
  if (!row.metadata_json) return false;
  try {
    return (
      (JSON.parse(row.metadata_json) as { prerelease?: unknown }).prerelease ===
      true
    );
  } catch {
    return false;
  }
}

/** A release id that is a GitHub tag rather than the tagless `<deliverable>@<version>` form. */
export function tagOf(
  row: Pick<ReleaseMetadataRow, "release_id" | "deliverable_id">,
): string | null {
  return row.release_id.startsWith(`${row.deliverable_id}@`)
    ? null
    : row.release_id;
}

export function policyView(row: ReleaseChannelPolicyRow): PolicyView {
  let includes: string[] | null = null;
  if (row.includes_json) {
    try {
      const parsed: unknown = JSON.parse(row.includes_json);
      if (Array.isArray(parsed))
        includes = parsed.filter((c): c is string => typeof c === "string");
    } catch {
      includes = null;
    }
  }
  return {
    pointer: row.pointer_release_id,
    pinned: row.pinned === 1,
    includes,
  };
}

/**
 * Everything resolution reads for one deliverable, in four queries: the deliverable, its
 * releases, their builds, the product's yanks and the deliverable's channel policies. Read once
 * and resolved many times (`resolveInState`): the signed feed (P3-03) resolves one channel for
 * every platform from one read.
 */
export interface DeliverableState {
  deliverableId: string;
  deliverable: ReleaseDeliverableRow;
  scheme: VersionScheme;
  config: ReleaseConfigRow | null;
  manual: ManualChannel[];
  rows: ReleaseMetadataRow[];
  buildsByRelease: Map<string, ReleaseBuildRow[]>;
  yanked: Set<string>;
  /** Policy rows of THIS deliverable, by (canonical) channel. */
  policyRows: Map<string, ReleaseChannelPolicyRow>;
  candidates: Candidate[];
}

export async function loadDeliverableState(
  db: Db,
  product: string,
  deliverableId: string,
  cfg?: ReleaseConfigRow | null,
): Promise<DeliverableState | null> {
  const deliverable = await db.first<ReleaseDeliverableRow>(
    "SELECT * FROM release_deliverables WHERE product = ? AND deliverable_id = ?",
    product,
    deliverableId,
  );
  if (!deliverable) return null;
  const config = cfg === undefined ? await getReleaseConfig(db, product) : cfg;
  const manual = parseManualChannels(config?.manual_channels_json);
  const rows = await db.all<ReleaseMetadataRow>(
    "SELECT * FROM release_metadata WHERE product = ? AND deliverable_id = ?",
    product,
    deliverableId,
  );
  const builds = await db.all<ReleaseBuildRow>(
    `SELECT b.* FROM release_builds b
       JOIN release_metadata m ON m.product = b.product AND m.release_id = b.release_id
      WHERE b.product = ? AND m.deliverable_id = ?`,
    product,
    deliverableId,
  );
  const yanks = await db.all<{ release_id: string }>(
    "SELECT release_id FROM release_yanks WHERE product = ?",
    product,
  );
  const policies = await db.all<ReleaseChannelPolicyRow>(
    "SELECT * FROM release_channel_policy WHERE product = ? AND deliverable_id = ?",
    product,
    deliverableId,
  );

  const buildsByRelease = new Map<string, ReleaseBuildRow[]>();
  for (const b of builds) {
    const list = buildsByRelease.get(b.release_id) ?? [];
    list.push(b);
    buildsByRelease.set(b.release_id, list);
  }
  const candidates: Candidate[] = rows.map((r) => ({
    releaseId: r.release_id,
    version: r.version,
    seq: r.seq,
    channel: r.channel ? canonicalChannel(r.channel, manual) : null,
    prerelease: prereleaseOf(r),
    tag: tagOf(r),
    builds: (buildsByRelease.get(r.release_id) ?? []).map((b) => ({
      buildId: b.build_id,
      platform: b.platform,
      arch: b.arch,
    })),
  }));
  return {
    deliverableId,
    deliverable,
    scheme: versionSchemeOf(deliverable),
    config,
    manual,
    rows,
    buildsByRelease,
    yanked: new Set(yanks.map((y) => y.release_id)),
    policyRows: new Map(policies.map((p) => [p.channel, p])),
    candidates,
  };
}

/** Resolve one selector against a loaded state (pure; see `resolveCandidates`). */
export function resolveInState(
  state: DeliverableState,
  opts: Omit<ResolveBuildOptions, "deliverable">,
): BuildResolution | null {
  let selector: Selector;
  let channel: string | null = null;
  if (isVersionSelector(opts.selector)) {
    selector = { type: "version", version: opts.selector };
  } else {
    channel = canonicalChannel(opts.selector, state.manual);
    if (!channel) return null;
    selector = { type: "channel", channel };
  }
  if (state.rows.length === 0) return null;
  const resolved = resolveCandidates({
    deliverable: state.deliverableId,
    scheme: state.scheme,
    selector,
    releases: state.candidates,
    yanked: state.yanked,
    policies: new Map(
      [...state.policyRows].map(([c, p]) => [c, policyView(p)]),
    ),
    manualChannels: state.manual,
    stableTagPattern: state.config?.stable_tag_pattern ?? null,
    ignoreTags: parseIgnoreTags(state.config?.ignore_tags_json),
    target: {
      ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
      ...(opts.arch !== undefined ? { arch: opts.arch } : {}),
      ...(opts.buildId !== undefined ? { buildId: opts.buildId } : {}),
    },
  });
  if (!resolved) return null;
  const release = state.rows.find(
    (r) => r.release_id === resolved.release.releaseId,
  ) as ReleaseMetadataRow;
  const build = resolved.build
    ? ((state.buildsByRelease.get(release.release_id) ?? []).find(
        (b) => b.build_id === resolved.build?.buildId,
      ) ?? null)
    : null;
  return { release, build, via: resolved.via, channel };
}

/**
 * Resolve a selector for one deliverable from the truth store. `cfg` is the product's release
 * configuration when the caller already holds it (its tag filter and manual channels); omitted,
 * it is read.
 */
export async function resolveBuild(
  db: Db,
  product: string,
  opts: ResolveBuildOptions,
  cfg?: ReleaseConfigRow | null,
): Promise<BuildResolution | null> {
  const state = await loadDeliverableState(
    db,
    product,
    opts.deliverable ?? APP_DELIVERABLE_ID,
    cfg,
  );
  if (!state) return null;
  // A selector that is neither a version nor a channel name resolves nothing (as before the
  // state split, which read nothing past the deliverable for it).
  return resolveInState(state, opts);
}

/**
 * The channels a product can serve: the built-ins, its manual rules, and any channel a release
 * of it was published to. The one definition of "a declared channel" — the policy routes
 * (`resolvePolicyChannel`), the admin view and the storefront feeds all ask this. Only an `app`
 * release declares a channel: a pack record's channel (P4-02) is learned from nothing, so a
 * pack can never widen the set the policy routes and feeds accept (P2b-05).
 */
export async function knownChannels(
  db: Db,
  product: string,
  cfg: Pick<ReleaseConfigRow, "manual_channels_json"> | null,
): Promise<string[]> {
  const manual = parseManualChannels(cfg?.manual_channels_json);
  const published = await db.all<{ channel: string }>(
    `SELECT DISTINCT channel FROM release_metadata
      WHERE product = ? AND deliverable_id = ? AND channel IS NOT NULL
      ORDER BY channel ASC`,
    product,
    APP_DELIVERABLE_ID,
  );
  const out = new Set<string>(BUILT_IN_CHANNELS);
  for (const m of manual) out.add(m.name);
  for (const p of published) {
    const c = canonicalChannel(p.channel, manual);
    if (c) out.add(c);
  }
  return [...out];
}

/**
 * The releases of `deliverable` that `channel` may serve, newest first (`channelCandidates`), as
 * release rows. Null when the deliverable does not exist or the channel is not one the product
 * declares (`knownChannels`): a well-formed but undeclared name (`nope`) is null, not an empty
 * list, so no feed, repository or cache entry can be minted for it. The channel is checked
 * before the deliverable's history is read, so an undeclared name costs two reads.
 */
export async function resolveChannelReleases(
  db: Db,
  product: string,
  deliverableId: string,
  rawChannel: string,
  cfg?: ReleaseConfigRow | null,
): Promise<{ channel: string; releases: ReleaseMetadataRow[] } | null> {
  if (isVersionSelector(rawChannel)) return null;
  const config = cfg === undefined ? await getReleaseConfig(db, product) : cfg;
  const channel = canonicalChannel(
    rawChannel,
    parseManualChannels(config?.manual_channels_json),
  );
  if (!channel) return null;
  if (!(await knownChannels(db, product, config)).includes(channel))
    return null;
  const state = await loadDeliverableState(db, product, deliverableId, config);
  if (!state) return null;
  const byId = new Map(state.rows.map((r) => [r.release_id, r]));
  const ordered = channelCandidates(
    {
      deliverable: state.deliverableId,
      scheme: state.scheme,
      releases: state.candidates,
      yanked: state.yanked,
      policies: new Map(
        [...state.policyRows].map(([c, p]) => [c, policyView(p)]),
      ),
      manualChannels: state.manual,
      stableTagPattern: config?.stable_tag_pattern ?? null,
      ignoreTags: parseIgnoreTags(config?.ignore_tags_json),
    },
    channel,
  );
  return {
    channel,
    releases: ordered.map((c) => byId.get(c.releaseId) as ReleaseMetadataRow),
  };
}

// ── The legacy routes' view of the same policy ───────────────────────────────────────────────

/**
 * What the GitHub-resolved legacy routes (`gateway.ts` `resolveSelector`) need from the policy
 * tables for the app deliverable on one channel: the yanked tags (never served on a moving
 * selector) and the channel's pointer, pinned or not. Two indexed reads.
 */
export interface LegacyPolicy {
  yanked: ReadonlySet<string>;
  pointer: string | null;
  pinned: boolean;
}

export async function legacyPolicyFor(
  db: Db,
  product: string,
  channel: string | null,
): Promise<LegacyPolicy> {
  const yanks = await db.all<{ release_id: string }>(
    "SELECT release_id FROM release_yanks WHERE product = ?",
    product,
  );
  const row = channel
    ? await db.first<ReleaseChannelPolicyRow>(
        `SELECT * FROM release_channel_policy
          WHERE product = ? AND deliverable_id = ? AND channel = ?`,
        product,
        APP_DELIVERABLE_ID,
        channel,
      )
    : null;
  return {
    yanked: new Set(yanks.map((y) => y.release_id)),
    pointer: row?.pointer_release_id ?? null,
    pinned: row?.pinned === 1 && !!row.pointer_release_id,
  };
}
