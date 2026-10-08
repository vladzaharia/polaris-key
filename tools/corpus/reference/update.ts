// Reference: the update decision (plans/P3-01.md §2.8).
//
// The generator's independent reference implementation, restated from the spec rather than
// taken from client-core or an SDK: the family modules recompute every verdict through it.

import { createHash } from "node:crypto";
import { CLOCK_SKEW } from "../common.js";
import { hasOwn, isObj } from "./claims.js";
import {
  REF_OUTLET_ID_RE,
  REF_OUTLET_KINDS,
  REF_SUBKINDS,
  refEffectiveCapabilities,
} from "./outlet.js";
import { refCompareVersions, refParseVersion } from "./versions.js";

// ── The update decision (plans/P3-01.md §2.8), the generator's reference ─────────────────────

export interface RefInput {
  now: number;
  feed: Record<string, any>;
  record: Record<string, any> | null;
  installed: {
    version: string;
    binaryVersion: string;
    buildNumber: string | null;
    platform: string;
    arch: string;
    format: string | null;
    engine: string | null;
  };
  outlet: { id: string | null; kind: string };
  subkind: string | null;
  staged: { version: string; channel: string } | null;
  skipVersion: string | null;
  bucket: number | null;
  methods: string[];
}

/** One build's eligibility for self-installation (§2.8 "Eligible builds"). A build whose
 *  `requires.engine` is not a string, or whose `requires.minBinary` does not parse, is never
 *  eligible. */
function refEligible(
  b: Record<string, any>,
  inp: RefInput,
  scheme: string,
): boolean {
  const payloads = (b.artifacts as Record<string, unknown>[]).filter(
    (a) => a.role === "payload",
  );
  if (payloads.length !== 1) return false;
  if (b.platform !== inp.installed.platform) return false;
  if (
    b.arch !== inp.installed.arch &&
    b.arch !== "universal" &&
    b.arch !== "any"
  )
    return false;
  const req = b.requires;
  if (isObj(req)) {
    if (hasOwn(req, "engine") && typeof req.engine !== "string") return false;
    if (
      hasOwn(req, "minBinary") &&
      refParseVersion(scheme, req.minBinary) === null
    )
      return false;
  }
  return true;
}

const ARCH_RANK = (b: Record<string, any>, arch: string): number =>
  b.arch === arch ? 0 : b.arch === "universal" ? 1 : 2;

function refPickBuild(
  builds: Record<string, any>[],
  arch: string,
): Record<string, any> | null {
  const sorted = [...builds].sort((x, y) => {
    const r = ARCH_RANK(x, arch) - ARCH_RANK(y, arch);
    if (r !== 0) return r;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
  return sorted[0] ?? null;
}

export function refDecideUpdate(inp: RefInput): Record<string, unknown> {
  const feed = inp.feed;
  const scheme = feed.app.versionScheme as string;
  const cmp = (a: string, b: string): number | null =>
    refCompareVersions(scheme, a, b);
  const discard = (action: string): boolean =>
    inp.staged !== null && action !== "code-ready";
  const none = (reason: string): Record<string, unknown> => ({
    action: "none",
    reason,
    behind: reason === "behind",
    discardStaged: discard("none"),
  });
  const blocked = (): Record<string, unknown> => ({
    action: "blocked",
    reason: "app-floor",
    discardStaged: discard("blocked"),
  });

  // 1. Stale.
  if (inp.now >= (feed.expiresAt as number) + CLOCK_SKEW)
    return {
      action: "none",
      reason: "stale",
      behind: false,
      discardStaged: false,
    };
  // 2. Unknown version.
  const run = inp.installed.version;
  const bin = inp.installed.binaryVersion ?? run;
  if (
    refParseVersion(scheme, run) === null ||
    refParseVersion(scheme, bin) === null
  )
    return none("unknown-version");
  // 3. Setup.
  const target = (feed.app.targets as Record<string, any>[]).find(
    (t) => t.platform === inp.installed.platform,
  );
  let entry: Record<string, any> | null = null;
  if (target && inp.outlet.kind !== "unknown") {
    const outlets = target.outlets as Record<string, Record<string, any>>;
    const byId = inp.outlet.id !== null ? outlets[inp.outlet.id] : undefined;
    if (byId && byId.kind === inp.outlet.kind) entry = byId;
    else {
      const ofKind = Object.values(outlets).filter(
        (e) => e.kind === inp.outlet.kind,
      );
      if (ofKind.length === 1) entry = ofKind[0]!;
    }
  }
  const caps = refEffectiveCapabilities(inp.outlet.kind, {
    platform: inp.installed.platform,
    subkind: inp.subkind,
    server: entry?.capabilities,
  });
  const belowFloor =
    !!target && target.floor !== null && cmp(bin, target.floor.minVersion)! < 0;
  // 4. The offer.
  let offer: Record<string, any> | null = null;
  if (entry) {
    if (caps.binaryUpdates === "self") {
      offer =
        entry.live !== null &&
        entry.live.seq === target!.release.seq &&
        inp.record !== null
          ? target!.release
          : null;
    } else offer = entry.live;
  }
  if (!offer) return belowFloor ? blocked() : none("not-available");
  // 5. Behind.
  if (cmp(offer.version, run)! < 0) return none("behind");
  // 6. Up to date.
  const newerRun = cmp(offer.version, run)! > 0;
  const newerBin = cmp(offer.version, bin)! > 0;
  if (!newerRun && !(belowFloor && newerBin))
    return belowFloor ? blocked() : none("up-to-date");
  // 7. Halted.
  if (entry!.halted) return belowFloor ? blocked() : none("halted");
  // 8. Rollout.
  if (hasOwn(entry!, "rollout") && !belowFloor && !target!.critical) {
    const bp = entry!.rollout.bp as number;
    if (!(inp.bucket !== null && inp.bucket < bp)) return none("out-of-bucket");
  }
  const short = { version: offer.version, seq: offer.seq };
  const critical = target!.critical as boolean;
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
      listingUrl: entry!.listingUrl ?? null,
      mandatory: belowFloor,
      critical,
      discardStaged: discard("store"),
    };
  // 11. Self-updating outlets.
  const full = { version: offer.version, seq: offer.seq, sha256: offer.sha256 };
  const notSkipped = offer.version !== inp.skipVersion;
  if (
    !belowFloor &&
    newerRun &&
    caps.codeUpdates &&
    inp.staged !== null &&
    inp.staged.channel === feed.channel &&
    inp.staged.version === offer.version &&
    notSkipped
  )
    return {
      action: "code-ready",
      release: full,
      critical,
      discardStaged: false,
    };
  const builds = ((inp.record?.builds ?? []) as Record<string, any>[]).filter(
    (b) => refEligible(b, inp, scheme),
  );
  const codePacks = builds.filter((b) => {
    if (b.format !== "pck") return false;
    const req = isObj(b.requires) ? b.requires : {};
    if (
      typeof req.engine !== "string" ||
      inp.installed.engine === null ||
      req.engine !== inp.installed.engine
    )
      return false;
    if (!hasOwn(req, "minBinary")) return true;
    const c = cmp(bin, req.minBinary as string);
    return c !== null && c >= 0;
  });
  const binaries = builds.filter(
    (b) =>
      b.format !== "pck" &&
      (inp.installed.format === null || b.format === inp.installed.format),
  );
  const binary = (
    method: string,
    build: Record<string, any>,
  ): Record<string, unknown> => ({
    action: "binary",
    method,
    release: full,
    build: build.id,
    mandatory: belowFloor,
    critical,
    prestage: [],
    discardStaged: discard("binary"),
  });
  if (
    !belowFloor &&
    newerRun &&
    caps.codeUpdates &&
    inp.methods.includes("sidecar-pck") &&
    notSkipped &&
    codePacks.length > 0
  )
    return binary("sidecar-pck", refPickBuild(codePacks, inp.installed.arch)!);
  const pick = refPickBuild(binaries, inp.installed.arch);
  for (const method of ["native", "download"])
    if (newerBin && inp.methods.includes(method) && pick)
      return binary(method, pick);
  if (belowFloor) return blocked();
  if (!notSkipped) return none("skipped");
  if (!pick) return none("no-build");
  return none("no-method");
}

/** §2.8 (P3-01): no v4 answer stops play. `refBootDecisionV2` adds plans/P4-13.md §2.6. */
export function refBootDecision(d: Record<string, unknown>): string {
  if (d.action === "none") return "none";
  if (d.action === "platform" && d.mandatory === false) return "none";
  return "optional";
}

export function refResolveUpdateOutlet(o: {
  host: unknown;
  stamp: Record<string, unknown> | null;
  detected: Record<string, unknown> | null;
}): { id: string | null; kind: string; subkind: string | null } {
  const kinds: readonly string[] = REF_OUTLET_KINDS;
  if (o.host !== null && o.host !== undefined) {
    if (typeof o.host === "string") {
      if (!kinds.includes(o.host)) throw new Error("invalid-options");
      return { id: o.host, kind: o.host, subkind: null };
    }
    const h = o.host as Record<string, unknown>;
    if (typeof h.kind !== "string" || !kinds.includes(h.kind))
      throw new Error("invalid-options");
    if (typeof h.id !== "string" || !REF_OUTLET_ID_RE.test(h.id))
      throw new Error("invalid-options");
    if (
      h.subkind !== undefined &&
      h.subkind !== null &&
      !REF_SUBKINDS.includes(h.subkind as string)
    )
      throw new Error("invalid-options");
    return {
      id: h.id,
      kind: h.kind,
      subkind: (h.subkind as string | undefined) ?? null,
    };
  }
  const s = o.stamp ?? {};
  const rawKind = hasOwn(s, "outletKind") ? s.outletKind : s.outlet;
  const kind =
    typeof rawKind === "string" && kinds.includes(rawKind) ? rawKind : null;
  const id =
    typeof s.outlet === "string" && REF_OUTLET_ID_RE.test(s.outlet)
      ? s.outlet
      : null;
  const sub =
    typeof s.outletSubkind === "string" &&
    REF_SUBKINDS.includes(s.outletSubkind)
      ? s.outletSubkind
      : null;
  if (o.detected) {
    const dk = o.detected.kind as string;
    const ds = (o.detected.subkind as string | null) ?? null;
    return dk === kind
      ? { id, kind: dk, subkind: ds }
      : { id: null, kind: dk, subkind: ds };
  }
  if (kind !== null) return { id, kind, subkind: sub };
  return { id: null, kind: "unknown", subkind: null };
}

export function refBucket(
  salt: string,
  installId: string,
): { sha256: string; first4: string; u32: number; bucket: number } {
  const digest = createHash("sha256")
    .update(Buffer.from(salt, "utf8"))
    .update(Buffer.from(installId, "utf8"))
    .digest();
  const u32 = digest.readUInt32BE(0);
  return {
    sha256: digest.toString("hex"),
    first4: digest.subarray(0, 4).toString("hex"),
    u32,
    bucket: u32 % 10000,
  };
}
