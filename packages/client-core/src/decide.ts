// The update decision — plans/P3-01.md §2.8 and §2.9 (WIRE-CONTRACT-V4 §11, informative).
//
// A pure, SYNCHRONOUS `decideUpdate` over the verified feed and record, the installed build, the
// outlet and the host's methods, with the pieces every SDK builds its inputs from: the rollout
// bucket, the effective capabilities and the outlet resolution. `update-matrix.json` pins every
// function here, row for row, in every SDK.
//
// `rolloutBucket` is the one async function: WebCrypto digests are async, so the bucket is
// computed first and passed in as an input. Other languages hash synchronously; the matrix pins
// the bucket separately, so every SDK agrees on both halves.
//
// Nothing here does I/O or throws. Every lookup into a feed object reads own properties only.

import {
  BINARY_UPDATES_ORDER,
  OUTLET_CAPABILITY_DEFAULTS,
  OUTLET_ID_PATTERN,
  OUTLET_KINDS,
  OUTLET_SUBKINDS,
  OUTLET_UNKNOWN,
  PLATFORM_NARROWING,
  SUBKIND_NARROWING,
  type CapabilityNarrowing,
  type OutletCapabilities,
  type OutletConfidence,
  type OutletKind,
  type OutletSubkind,
} from "@polaris-key/protocol/distribution";
import {
  ROLLOUT_BUCKETS,
  type BinaryMethod,
  type ContentBlock,
  type DecisionRelease,
  type FeedOutletEntry,
  type FeedPackSets,
  type FeedTarget,
  type PackTarget,
  type ReleasePin,
  type UpdateContentInput,
  type UpdateDecision,
  type UpdateDecisionInput,
  type UpdateNoneReason,
  type UpdateOutlet,
} from "@polaris-key/protocol/update";
import type { ContentHold } from "@polaris-key/protocol/packs";
import type { ReleaseRecordBuild } from "@polaris-key/protocol/release";
import { CLOCK_SKEW_SECONDS } from "./claims.js";
import { feedContent } from "./feed.js";
import { holdsOf } from "./packs/claims.js";
import { compareBytes } from "./packs/variant.js";
import type { BootDecision } from "./stages.js";
import { compareVersions, parseVersion } from "./version.js";

export {
  OUTLET_CAPABILITY_DEFAULTS,
  PLATFORM_NARROWING,
  SUBKIND_NARROWING,
} from "@polaris-key/protocol/distribution";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function has(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

// ── The rollout bucket (§2.8 "Bucket") ───────────────────────────────────────────────────────

/**
 * `u32_be(SHA-256(UTF-8(salt) ‖ UTF-8(installId))[0..4]) mod 10000`: the feed's 32-character hex
 * salt hashed as text, then the SDK's device id (the value it sends as `X-PKey-Device`), with no
 * separator; the first four digest bytes read big-endian as an UNSIGNED integer. The device is
 * inside a rollout iff the bucket is below `bp` (`update-matrix.json#/bucketVectors`).
 */
export async function rolloutBucket(
  salt: string,
  installId: string,
): Promise<number> {
  const bytes = new TextEncoder().encode(salt + installId);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return new DataView(digest).getUint32(0, false) % ROLLOUT_BUCKETS;
}

// ── Capabilities (§2.9 "Narrowing") ──────────────────────────────────────────────────────────

const CAPABILITY_BOOLEANS = [
  "codeUpdates",
  "dataUpdates",
  "channelSwitch",
  "downloadedScripts",
] as const;

/** Apply one narrowing: booleans AND, `binaryUpdates` the narrower of `none` < `store` < `self`,
 *  `commerce` only ever to `none`. A value outside its vocabulary is ignored; nothing widens. */
function narrow(caps: OutletCapabilities, n: unknown): OutletCapabilities {
  if (!isObject(n)) return caps;
  const out: OutletCapabilities = { ...caps };
  for (const key of CAPABILITY_BOOLEANS)
    if (has(n, key) && typeof n[key] === "boolean")
      out[key] = out[key] && (n[key] as boolean);
  if (has(n, "binaryUpdates")) {
    const order = BINARY_UPDATES_ORDER as readonly unknown[];
    const k = order.indexOf(n.binaryUpdates);
    if (k !== -1 && k < order.indexOf(out.binaryUpdates))
      out.binaryUpdates = BINARY_UPDATES_ORDER[k]!;
  }
  if (has(n, "commerce") && n.commerce === "none") out.commerce = "none";
  return out;
}

export interface EffectiveCapabilitiesOptions {
  /** The installed platform: `PLATFORM_NARROWING[platform][kind]` applies first. */
  platform: string;
  /** How a `direct` install was put on the device (`SUBKIND_NARROWING`). */
  subkind?: string | null;
  /** The feed entry's `capabilities`, which can narrow but never widen. */
  server?: CapabilityNarrowing | Record<string, unknown> | null;
}

/**
 * The capabilities of an install: the compiled defaults for its outlet kind (`unknown` for a
 * kind outside the 17), narrowed by the platform, then the subkind, then the feed entry. The
 * defaults are the ceiling (`update-matrix.json#/capabilityCases`).
 */
export function effectiveCapabilities(
  kind: string,
  opts: EffectiveCapabilitiesOptions,
): OutletCapabilities {
  const table = OUTLET_CAPABILITY_DEFAULTS as Readonly<
    Record<string, OutletCapabilities>
  >;
  let caps: OutletCapabilities = {
    ...(has(table, kind) ? table[kind]! : table[OUTLET_UNKNOWN]!),
  };
  const byPlatform = has(PLATFORM_NARROWING, opts.platform)
    ? PLATFORM_NARROWING[opts.platform]!
    : undefined;
  if (byPlatform && has(byPlatform, kind))
    caps = narrow(caps, byPlatform[kind]);
  const subkind = opts.subkind;
  if (typeof subkind === "string" && has(SUBKIND_NARROWING, subkind))
    caps = narrow(caps, SUBKIND_NARROWING[subkind as OutletSubkind]);
  caps = narrow(caps, opts.server);
  return caps;
}

// ── The decision's outlet (§2.8 "The outlet") ────────────────────────────────────────────────

/** A host's outlet option: a bare kind (`"steam"` reads as `{id: "steam", kind: "steam"}`), or
 *  the product's outlet id with its kind. */
export type HostOutlet =
  | OutletKind
  | { id: string; kind: OutletKind; subkind?: OutletSubkind | null };

/** The build stamp's outlet fields (P1-11; the v4 fields of plans/P3-01.md §8). `outletIds`
 *  are the product's outlet identities, which outlet detection (`detectOutlet`) compares launcher
 *  signals against; `resolveUpdateOutlet` does not read them. */
export interface OutletStamp {
  outlet?: string;
  outletKind?: string;
  outletSubkind?: string;
  outletIds?: Record<string, string>;
}

/** A detection result (P3-11's `detectOutlet`). */
export interface DetectedOutlet {
  kind: OutletKind | typeof OUTLET_UNKNOWN;
  confidence: OutletConfidence | null;
  source: string | null;
  subkind: OutletSubkind | null;
}

/** What `resolveUpdateOutlet` answers: the decision's `outlet` and `subkind`. */
export interface ResolvedOutlet extends UpdateOutlet {
  subkind: OutletSubkind | null;
}

const isKind = (v: unknown): v is OutletKind =>
  typeof v === "string" && (OUTLET_KINDS as readonly string[]).includes(v);
const isSubkind = (v: unknown): v is OutletSubkind =>
  typeof v === "string" && (OUTLET_SUBKINDS as readonly string[]).includes(v);

/** True when `host` is a valid host outlet option. An SDK raises `invalid-options` at
 *  construction (Godot: `configure()`) for any other value. */
export function isValidHostOutlet(host: unknown): host is HostOutlet {
  if (typeof host === "string") return isKind(host);
  if (!isObject(host)) return false;
  if (!isKind(host.kind)) return false;
  if (typeof host.id !== "string" || !OUTLET_ID_PATTERN.test(host.id))
    return false;
  if (
    has(host, "subkind") &&
    host.subkind !== null &&
    host.subkind !== undefined
  )
    return isSubkind(host.subkind);
  return true;
}

/**
 * The decision's outlet, in §2.8's order: a host value wins; else the stamp's kind (its
 * `outletKind`, or its `outlet` when it has none; a kind outside the 17 is no kind), moved by a
 * detection result when there is one; else `{id: null, kind: "unknown", subkind: null}`
 * (`update-matrix.json#/outletCases`). Null when `host` is present but invalid: the SDK raises
 * `invalid-options` for it. Never throws.
 */
export function resolveUpdateOutlet(opts: {
  host?: unknown;
  stamp?: OutletStamp | null;
  detected?: DetectedOutlet | null;
}): ResolvedOutlet | null {
  const host = opts.host;
  if (host !== undefined && host !== null) {
    if (!isValidHostOutlet(host)) return null;
    if (typeof host === "string")
      return { id: host, kind: host, subkind: null };
    return { id: host.id, kind: host.kind, subkind: host.subkind ?? null };
  }
  const stamp: Record<string, unknown> = isObject(opts.stamp) ? opts.stamp : {};
  const rawKind = has(stamp, "outletKind") ? stamp.outletKind : stamp.outlet;
  const kind = isKind(rawKind) ? rawKind : null;
  const id =
    typeof stamp.outlet === "string" && OUTLET_ID_PATTERN.test(stamp.outlet)
      ? stamp.outlet
      : null;
  const subkind = isSubkind(stamp.outletSubkind) ? stamp.outletSubkind : null;
  const detected = opts.detected;
  if (isObject(detected)) {
    const dk = detected.kind;
    const ds = detected.subkind ?? null;
    return dk === kind
      ? { id, kind: dk, subkind: ds }
      : { id: null, kind: dk, subkind: ds };
  }
  if (kind !== null) return { id, kind, subkind };
  return { id: null, kind: OUTLET_UNKNOWN, subkind: null };
}

// ── The decision (§2.8 "Algorithm") ──────────────────────────────────────────────────────────

/** The feed's target for `platform`, if there is one. */
export function feedTarget(
  targets: readonly FeedTarget[],
  platform: string,
): FeedTarget | null {
  for (const t of targets) if (t.platform === platform) return t;
  return null;
}

/**
 * The install's entry in a target (§2.8 step 3): `outlets[outlet.id]` when that entry's kind is
 * the outlet's kind; otherwise the ONE entry of that kind, if exactly one has it; otherwise none.
 * `unknown` never has an entry. A host computes the rollout bucket from this entry's salt.
 */
export function outletEntry(
  target: FeedTarget | null,
  outlet: UpdateOutlet,
): FeedOutletEntry | null {
  if (!target || outlet.kind === OUTLET_UNKNOWN) return null;
  const outlets = target.outlets as Record<string, FeedOutletEntry>;
  if (outlet.id !== null && has(outlets, outlet.id)) {
    const byId = outlets[outlet.id]!;
    if (byId.kind === outlet.kind) return byId;
  }
  const ofKind = Object.values(outlets).filter((e) => e.kind === outlet.kind);
  return ofKind.length === 1 ? ofKind[0]! : null;
}

const ARCH_RANK = (b: ReleaseRecordBuild, arch: string): number =>
  b.arch === arch ? 0 : b.arch === "universal" ? 1 : 2;

/** The device's own arch before `universal`, `universal` before `any`; ties by build id in
 *  ascending order. Build ids are ASCII (`BUILD_ID_PATTERN`), so code-unit order is byte order. */
function pickBuild(
  builds: readonly ReleaseRecordBuild[],
  arch: string,
): ReleaseRecordBuild | null {
  let best: ReleaseRecordBuild | null = null;
  for (const b of builds) {
    if (best === null) {
      best = b;
      continue;
    }
    const r = ARCH_RANK(b, arch) - ARCH_RANK(best, arch);
    if (r < 0 || (r === 0 && b.id < best.id)) best = b;
  }
  return best;
}

/** The key of the install's entry in a target (`outletEntry`'s rule), or null. */
function outletEntryId(
  target: FeedTarget | null,
  outlet: UpdateOutlet,
): string | null {
  if (!target || outlet.kind === OUTLET_UNKNOWN) return null;
  const outlets = target.outlets as Record<string, FeedOutletEntry>;
  if (outlet.id !== null && has(outlets, outlet.id)) {
    if (outlets[outlet.id]!.kind === outlet.kind) return outlet.id;
  }
  const ofKind = Object.keys(outlets).filter(
    (k) => outlets[k]!.kind === outlet.kind,
  );
  return ofKind.length === 1 ? ofKind[0]! : null;
}

/**
 * The update decision (plans/P3-01.md §2.8, extended by plans/P4-13.md §2.6 when `content` is
 * given): P3-01's eleven rules give the app answer; with `content`, the pack composition, the
 * content blocks and `prestage` refine it in §2.6's order. Synchronous and total; each answer has
 * exactly the members the output tables list, so decisions compare by value.
 * `update-matrix.json#/rows` and `#/contentRows` pin every rule.
 */
export function decideUpdate(input: UpdateDecisionInput): UpdateDecision {
  const app = decideApp(input);
  const content = input.content;
  if (content === undefined || content === null) return app;
  return decideContent(input, content, app);
}

/** P3-01's decision, unchanged (plans/P3-01.md §2.8). */
function decideApp(input: UpdateDecisionInput): UpdateDecision {
  const feed = input.feed;
  const scheme = feed.app.versionScheme;
  const cmp = (a: string, b: string): number | null =>
    compareVersions(scheme, a, b);
  const staged = input.staged ?? null;
  const discard = (action: UpdateDecision["action"]): boolean =>
    staged !== null && action !== "code-ready";
  const none = (reason: UpdateNoneReason): UpdateDecision => ({
    action: "none",
    reason,
    behind: reason === "behind",
    discardStaged: discard("none"),
  });
  const blocked = (): UpdateDecision => ({
    action: "blocked",
    reason: "app-floor",
    discardStaged: discard("blocked"),
  });

  // 1. Stale: freeze, and keep what is staged.
  if (input.now >= feed.expiresAt + CLOCK_SKEW_SECONDS)
    return {
      action: "none",
      reason: "stale",
      behind: false,
      discardStaged: false,
    };

  // 2. Unknown version.
  const run = input.installed.version;
  const bin = input.installed.binaryVersion ?? run;
  if (parseVersion(scheme, run) === null || parseVersion(scheme, bin) === null)
    return none("unknown-version");

  // 3. Setup.
  const target = feedTarget(feed.app.targets, input.installed.platform);
  const entry = outletEntry(target, input.outlet);
  const caps = effectiveCapabilities(input.outlet.kind, {
    platform: input.installed.platform,
    subkind: input.subkind,
    server: entry?.capabilities ?? null,
  });
  const floorCmp =
    target && target.floor !== null ? cmp(bin, target.floor.minVersion) : null;
  const belowFloor = floorCmp !== null && floorCmp < 0;

  // 4. The offer.
  let offer: { version: string; seq: number; sha256?: string } | null = null;
  if (entry && target) {
    if (caps.binaryUpdates === "self") {
      offer =
        entry.live !== null &&
        entry.live.seq === target.release.seq &&
        input.record !== null
          ? target.release
          : null;
    } else offer = entry.live;
  }
  if (!offer || !entry || !target)
    return belowFloor ? blocked() : none("not-available");

  // 5. Behind: no downgrade, and the floor is suppressed.
  const runCmp = cmp(offer.version, run);
  if (runCmp !== null && runCmp < 0) return none("behind");

  // 6. Up to date.
  const binCmp = cmp(offer.version, bin);
  const newerRun = runCmp !== null && runCmp > 0;
  const newerBin = binCmp !== null && binCmp > 0;
  if (!newerRun && !(belowFloor && newerBin))
    return belowFloor ? blocked() : none("up-to-date");

  // 7. Halted.
  if (entry.halted) return belowFloor ? blocked() : none("halted");

  // 8. Rollout: a critical release and a below-floor device bypass it; a null bucket is out.
  if (entry.rollout !== undefined && !belowFloor && !target.critical) {
    const bucket = input.bucket;
    if (!(bucket !== null && bucket < entry.rollout.bp))
      return none("out-of-bucket");
  }

  const critical = target.critical;
  const short: DecisionRelease = { version: offer.version, seq: offer.seq };

  // 9. Platform.
  if (caps.binaryUpdates === "none")
    return {
      action: "platform",
      release: short,
      mandatory: belowFloor,
      critical,
      discardStaged: discard("platform"),
    };

  // 10. Store.
  if (caps.binaryUpdates === "store")
    return {
      action: "store",
      release: short,
      listingUrl: entry.listingUrl ?? null,
      mandatory: belowFloor,
      critical,
      discardStaged: discard("store"),
    };

  // 11. Self-updating outlets. The offer is the pin here, so it carries its sha256.
  const full: DecisionRelease = {
    version: offer.version,
    seq: offer.seq,
    sha256: offer.sha256!,
  };
  const notSkipped = offer.version !== input.skipVersion;

  // a. code-ready.
  if (
    !belowFloor &&
    newerRun &&
    caps.codeUpdates &&
    staged !== null &&
    staged.channel === feed.channel &&
    staged.version === offer.version &&
    notSkipped
  )
    return {
      action: "code-ready",
      release: full,
      critical,
      discardStaged: false,
    };

  const builds = (input.record?.builds ?? []).filter((b) =>
    eligible(b, input.installed.platform, input.installed.arch, scheme),
  );
  const engine = input.installed.engine;
  const codePacks = builds.filter((b) => {
    if (b.format !== "pck") return false;
    const req: Record<string, unknown> = isObject(b.requires) ? b.requires : {};
    if (typeof req.engine !== "string" || engine === null) return false;
    if (req.engine !== engine) return false;
    if (!has(req, "minBinary")) return true;
    const c = cmp(bin, req.minBinary as string);
    return c !== null && c >= 0;
  });
  const format = input.installed.format;
  const binaries = builds.filter(
    (b) => b.format !== "pck" && (format === null || b.format === format),
  );
  const methods: readonly BinaryMethod[] = input.methods;
  const binary = (
    method: BinaryMethod,
    build: ReleaseRecordBuild,
  ): UpdateDecision => ({
    action: "binary",
    method,
    release: full,
    build: build.id,
    mandatory: belowFloor,
    critical,
    prestage: [],
    discardStaged: discard("binary"),
  });

  // b. sidecar-pck.
  if (
    !belowFloor &&
    newerRun &&
    caps.codeUpdates &&
    methods.includes("sidecar-pck") &&
    notSkipped &&
    codePacks.length > 0
  )
    return binary("sidecar-pck", pickBuild(codePacks, input.installed.arch)!);

  // c. native, then download.
  const pick = pickBuild(binaries, input.installed.arch);
  if (newerBin && pick) {
    if (methods.includes("native")) return binary("native", pick);
    if (methods.includes("download")) return binary("download", pick);
  }

  // d. Otherwise.
  if (belowFloor) return blocked();
  if (!notSkipped) return none("skipped");
  if (!pick) return none("no-build");
  return none("no-method");
}

/** §2.8 "Eligible builds": exactly one `payload` artifact, the installed platform, and the
 *  device's arch, `universal` or `any`. A `requires.engine` that is not a string, or a
 *  `requires.minBinary` that does not parse under the feed's scheme, is never eligible. */
function eligible(
  b: ReleaseRecordBuild,
  platform: string,
  arch: string,
  scheme: string,
): boolean {
  if (!Array.isArray(b.artifacts)) return false;
  let payloads = 0;
  for (const a of b.artifacts) if (a.role === "payload") payloads++;
  if (payloads !== 1) return false;
  if (b.platform !== platform) return false;
  if (b.arch !== arch && b.arch !== "universal" && b.arch !== "any")
    return false;
  const req = b.requires;
  if (isObject(req)) {
    if (has(req, "engine") && typeof req.engine !== "string") return false;
    if (
      has(req, "minBinary") &&
      (typeof req.minBinary !== "string" ||
        parseVersion(scheme, req.minBinary) === null)
    )
      return false;
  }
  return true;
}

/**
 * The stage machine's `decide.done` for a decision (plans/P3-01.md §2.8 "bootDecision", amended
 * by plans/P4-13.md §2.6 and decision 4). Floors never stop play; a CI-signed revocation of a
 * REQUIRED pack can:
 *
 * - `blocked {revoked-content}`, or any answer with `contentBlock: "revoked-content"`, gives
 *   `required`: the boot stops at a confirmed `blocked {update-required}` (a revoked required
 *   pack cannot be mounted, so continuing would end in an error and a rollback loop);
 * - `packs` gives `none` (the boot's fetch applies it);
 * - `blocked {content-floor}`, and any answer with `contentBlock: "content-floor"`, give
 *   `optional`;
 * - otherwise P3-01's rule: `none`, and a `platform` answer that is not mandatory, give `none`;
 *   every other answer gives `optional`, a prompt over a game that keeps running.
 */
export function bootDecision(decision: UpdateDecision): BootDecision {
  if (
    (decision.action === "blocked" && decision.reason === "revoked-content") ||
    contentBlockOf(decision) === "revoked-content"
  )
    return "required";
  if (decision.action === "packs") return "none";
  if (decision.action === "none") return "none";
  if (decision.action === "platform" && !decision.mandatory) return "none";
  return "optional";
}

/** The answer's `contentBlock`, when it has one. */
function contentBlockOf(decision: UpdateDecision): ContentBlock | undefined {
  return "contentBlock" in decision ? decision.contentBlock : undefined;
}

/** True when the host must render `decision` as a prompt the player cannot dismiss: a
 *  mandatory `binary`, `store` or `platform` answer, and every `blocked` answer (§2.8). */
export function isUndismissable(decision: UpdateDecision): boolean {
  if (decision.action === "blocked") return true;
  if (
    decision.action === "binary" ||
    decision.action === "store" ||
    decision.action === "platform"
  )
    return decision.mandatory;
  return false;
}

// ── P4-13: the content decision (plans/P4-13.md §2.6) ────────────────────────────────────────

/** Lexicographic comparison of two equal-length index tuples. */
function tupleCmp(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * Row selection (plans/P4-13.md §2.6 steps 1–4): the candidate rows of `packSets` at
 * (`contentApi`, `platform`) whose `engine` equals `engine` exactly (no fallback to `""`), grouped
 * by their sorted axis names; in each group the row `selectVariant`'s rule picks (every axis in
 * `axes`, the lowest tuple of preference indexes over axis names in byte order). Returns the feed
 * target per pack: the record hash the selected rows' sets name, with a pack named by two selected
 * rows left out. Never throws.
 */
export function selectPackRows(
  packSets: FeedPackSets,
  sel: {
    contentApi: number;
    platform: string;
    engine: string;
    axes: Readonly<Record<string, readonly string[]>>;
  },
): Map<string, string> {
  const groups = new Map<string, { set: string; key: number[] }>();
  for (const row of packSets.rows) {
    if (
      row.contentApi !== sel.contentApi ||
      row.platform !== sel.platform ||
      row.engine !== sel.engine
    )
      continue;
    const names = Object.keys(row.variant).sort(compareBytes);
    const key: number[] = [];
    let eligible = true;
    for (const axis of names) {
      const list = has(sel.axes, axis) ? sel.axes[axis] : undefined;
      const k = Array.isArray(list) ? list.indexOf(row.variant[axis]!) : -1;
      if (k < 0) {
        eligible = false;
        break;
      }
      key.push(k);
    }
    if (!eligible) continue;
    const group = JSON.stringify(names);
    const best = groups.get(group);
    if (best === undefined || tupleCmp(key, best.key) < 0)
      groups.set(group, { set: row.set, key });
  }
  const targets = new Map<string, string>();
  const twice = new Set<string>();
  for (const { set } of groups.values()) {
    const members = has(packSets.sets, set) ? packSets.sets[set]! : [];
    for (const h of members) {
      if (!has(packSets.releases, h)) continue;
      const pack = packSets.releases[h]!.pack;
      if (targets.has(pack)) twice.add(pack);
      targets.set(pack, h);
    }
  }
  for (const pack of twice) targets.delete(pack);
  return targets;
}

interface Composition {
  install: PackTarget[];
  revoke: string[];
  set: { pack: string; sha256: string }[];
  /** A required pack is revoked without a fix. */
  revokedRequired: boolean;
  /** Some pack is below its floor. */
  floor: boolean;
}

interface ContentEnv {
  content: UpdateContentInput;
  /** The parsed `packSets`, or null (absent, unusable, or treated as absent). */
  packSets: FeedPackSets | null;
  floors: {
    pack: string;
    contentApi: number;
    minVersion: string;
    versionScheme: string;
  }[];
  /** The outlet's narrowing and gates. */
  pinned: ReadonlySet<string>;
  gates: Readonly<
    Record<
      string,
      {
        halted: boolean;
        rollout?: { bp: number; salt: string };
        fallback: string | null;
      }
    >
  >;
  dataUpdates: boolean;
  platform: string;
  engine: string;
}

const pinFrom = (sets: FeedPackSets, h: string): ReleasePin => {
  const r = sets.releases[h]!;
  return { sha256: h, seq: r.seq, version: r.version };
};

/** The feed targets at one level, after the outlet's narrowing and gates (§2.6 step 5). */
function feedTargets(
  env: ContentEnv,
  contentApi: number,
  engine: string,
): Map<string, ReleasePin> {
  const out = new Map<string, ReleasePin>();
  const sets = env.packSets;
  if (sets === null) return out;
  const targets = selectPackRows(sets, {
    contentApi,
    platform: env.platform,
    engine,
    axes: env.content.axes,
  });
  for (const [pack, h0] of targets) {
    if (env.pinned.has(pack)) continue;
    let h: string | null = h0;
    if (has(env.gates, h0)) {
      const gate = env.gates[h0]!;
      let out_ = gate.halted;
      if (!out_ && gate.rollout !== undefined) {
        const buckets = env.content.buckets;
        const b = has(buckets, gate.rollout.salt)
          ? buckets[gate.rollout.salt]
          : null;
        out_ = !(typeof b === "number" && b < gate.rollout.bp);
      }
      if (out_) h = gate.fallback;
    }
    if (h !== null && has(sets.releases, h)) out.set(pack, pinFrom(sets, h));
  }
  return out;
}

/** The pack composition (§2.6 "Composition, per pack p"). */
function compose(env: ContentEnv): Composition {
  const { content } = env;
  const stamp = content.stamp;
  const L = stamp.contentApi;
  const revoked = new Map<string, (typeof content.revocations)[number]>();
  for (const r of content.revocations) revoked.set(r.target, r);
  const isRevoked = (x: ReleasePin | null | undefined): boolean =>
    x != null && revoked.has(x.sha256);

  const pins = new Map<string, ReleasePin>();
  for (const p of stamp.pins) pins.set(p.pack, p.release);
  const holds = new Map<string, ReleasePin>();
  const holdList: ContentHold[] | null = stamp.holds;
  for (const h of holdList ?? []) holds.set(h.pack, h.release);
  const required = new Set<string>();
  const essential = new Set<string>();
  for (const e of stamp.expects) {
    if (e.required) required.add(e.pack);
    if (e.delivery === "essential") essential.add(e.pack);
  }
  const active = content.active;
  const activeOf = (p: string): ReleasePin | undefined =>
    has(active, p) ? active[p] : undefined;
  const targets = feedTargets(env, L, env.engine);

  const known = new Set<string>([
    ...pins.keys(),
    ...holds.keys(),
    ...stamp.expects.map((e) => e.pack),
    ...Object.keys(active),
    ...targets.keys(),
  ]);

  const out: Composition = {
    install: [],
    revoke: [],
    set: [],
    revokedRequired: false,
    floor: false,
  };
  for (const p of [...known].sort(compareBytes)) {
    const narrowed = env.pinned.has(p);
    const rep = (x: ReleasePin | null | undefined): ReleasePin | null => {
      if (x == null) return null;
      if (!isRevoked(x)) return x;
      const r = revoked.get(x.sha256)!;
      if (
        r.replacementUsable &&
        r.replacement !== null &&
        !isRevoked(r.replacement) &&
        env.dataUpdates &&
        !narrowed
      )
        return r.replacement;
      return null;
    };
    let base: ReleasePin | null;
    if (pins.has(p)) base = pins.get(p)!;
    else if (holds.has(p)) base = holds.get(p)!;
    else if (
      narrowed ||
      holdList === null ||
      !env.dataUpdates ||
      env.packSets === null
    )
      base = null;
    else base = targets.get(p) ?? null;

    const act = activeOf(p);
    let cand = rep(base);
    if (cand === null && isRevoked(act)) cand = rep(act);

    const wanted = act !== undefined || required.has(p) || essential.has(p);
    const install =
      cand !== null &&
      cand.sha256 !== act?.sha256 &&
      wanted &&
      (pins.has(p) ||
        holds.has(p) ||
        act === undefined ||
        isRevoked(act) ||
        cand.seq > act.seq);
    if (install) out.install.push({ pack: p, release: cand! });
    const eff: ReleasePin | null = install
      ? cand
      : act !== undefined && !isRevoked(act)
        ? act
        : cand;
    if (eff !== null) out.set.push({ pack: p, sha256: eff.sha256 });

    const noFix =
      cand === null &&
      (isRevoked(act) || (isRevoked(base) && act === undefined));
    if (noFix && required.has(p)) out.revokedRequired = true;
    if (noFix && !required.has(p) && act !== undefined) out.revoke.push(p);

    if (!noFix && (act !== undefined || required.has(p))) {
      const f = env.floors.find((x) => x.pack === p && x.contentApi === L);
      if (f !== undefined) {
        const c =
          eff === null
            ? null
            : compareVersions(f.versionScheme, eff.version, f.minVersion);
        if (c === null || c < 0) out.floor = true;
      }
    }
  }
  return out;
}

/** §2.6 "Prestage": the new level's required and essential packs, minus the build's embeds. */
function prestageOf(
  env: ContentEnv,
  input: UpdateDecisionInput,
  buildId: string,
): PackTarget[] {
  const record = input.record;
  const rc = record?.content;
  if (!record || !isObject(rc)) return [];
  const L2 = rc.contentApi;
  if (L2 === env.content.stamp.contentApi) return [];
  const build = (record.builds ?? []).find((b) => b.id === buildId);
  const embeds = new Set<string>(
    Array.isArray(build?.embeds) ? build!.embeds : [],
  );
  const req = build && isObject(build.requires) ? build.requires : {};
  const engine = typeof req.engine === "string" ? req.engine : env.engine;
  const revoked = new Map<string, (typeof env.content.revocations)[number]>();
  for (const r of env.content.revocations) revoked.set(r.target, r);
  const isRevoked = (x: ReleasePin | null | undefined): boolean =>
    x != null && revoked.has(x.sha256);

  const pins = new Map<string, ReleasePin>();
  for (const p of rc.pins ?? []) pins.set(p.pack, p.release);
  const recordHolds = holdsOf(rc);
  const holds = new Map<string, ReleasePin>();
  for (const h of recordHolds ?? []) holds.set(h.pack, h.release);
  const targets =
    recordHolds === null || !env.dataUpdates
      ? new Map<string, ReleasePin>()
      : feedTargets(env, L2, engine);
  const active = env.content.active;

  const out: PackTarget[] = [];
  for (const e of rc.expects ?? []) {
    const p = e.pack;
    if (!(e.required || e.delivery === "essential") || embeds.has(p)) continue;
    const narrowed = env.pinned.has(p);
    const rep = (x: ReleasePin | null | undefined): ReleasePin | null => {
      if (x == null) return null;
      if (!isRevoked(x)) return x;
      const r = revoked.get(x.sha256)!;
      if (
        r.replacementUsable &&
        r.replacement !== null &&
        !isRevoked(r.replacement) &&
        env.dataUpdates &&
        !narrowed
      )
        return r.replacement;
      return null;
    };
    const release = rep(pins.get(p) ?? holds.get(p) ?? targets.get(p) ?? null);
    if (release === null) continue;
    const act = has(active, p) ? active[p] : undefined;
    if (act !== undefined && act.sha256 === release.sha256) continue;
    out.push({ pack: p, release });
  }
  return out.sort((a, b) => compareBytes(a.pack, b.pack));
}

/** §2.6 "Order": the content refinement of P3-01's answer `app`. */
function decideContent(
  input: UpdateDecisionInput,
  content: UpdateContentInput,
  app: UpdateDecision,
): UpdateDecision {
  const feed = input.feed;
  const target = feedTarget(feed.app.targets, input.installed.platform);
  const entry = outletEntry(target, input.outlet);
  const entryId = outletEntryId(target, input.outlet);
  const caps = effectiveCapabilities(input.outlet.kind, {
    platform: input.installed.platform,
    subkind: input.subkind,
    server: entry?.capabilities ?? null,
  });
  const fc = feedContent(feed);
  const outlet =
    fc.packSets !== null &&
    fc.packSets.outlets !== undefined &&
    entryId !== null &&
    has(fc.packSets.outlets, entryId)
      ? fc.packSets.outlets[entryId]!
      : null;
  const env = (packSets: FeedPackSets | null): ContentEnv => ({
    content,
    packSets,
    floors: fc.packFloors ?? [],
    pinned: new Set(packSets !== null ? (outlet?.pinned ?? []) : []),
    gates: packSets !== null ? (outlet?.gates ?? {}) : {},
    dataUpdates: caps.dataUpdates,
    platform: input.installed.platform,
    engine: input.installed.engine ?? "",
  });
  const discard = input.staged !== null && input.staged !== undefined;

  // 1. Stale or unknown version: only revoked required content can change the answer.
  if (
    app.action === "none" &&
    (app.reason === "stale" || app.reason === "unknown-version")
  ) {
    const c = compose(env(null));
    if (c.revokedRequired)
      return {
        action: "blocked",
        reason: "revoked-content",
        discardStaged: discard,
      };
    return app;
  }

  const full = env(fc.packSets);
  const c = compose(full);
  const block: ContentBlock | null = c.revokedRequired
    ? "revoked-content"
    : c.floor
      ? "content-floor"
      : null;

  // 2. The app floor.
  if (app.action === "blocked")
    return block === null ? app : { ...app, contentBlock: block };

  // 3. Offers.
  if (
    app.action === "binary" ||
    app.action === "store" ||
    app.action === "platform"
  ) {
    const withPrestage =
      app.action === "binary"
        ? { ...app, prestage: prestageOf(full, input, app.build) }
        : app;
    if (block !== null)
      return {
        ...withPrestage,
        mandatory: true,
        contentBlock: block,
      } as UpdateDecision;
    if (app.mandatory || app.action === "binary") return withPrestage;
  }

  // 4. A content block.
  if (block !== null)
    return { action: "blocked", reason: block, discardStaged: discard };

  // 5. code-ready.
  if (app.action === "code-ready") return app;

  // 6. packs.
  if (caps.dataUpdates && (c.install.length > 0 || c.revoke.length > 0))
    return {
      action: "packs",
      install: c.install,
      revoke: c.revoke,
      set: c.set,
      discardStaged: discard,
    };

  // 7. Otherwise P3-01's answer.
  return app;
}
