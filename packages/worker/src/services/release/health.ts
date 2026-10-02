/// <reference types="@cloudflare/workers-types" />

import type { Db, Env } from "../../core/platform.js";
import type {
  ManifestAppDeliverable,
  ManifestArtifactEntry,
} from "@polaris-key/manifest";
import {
  archOf,
  findBinaryAsset,
  matchAsset,
  normalizeArch,
  sigAssetName,
  type Arch,
} from "./assets.js";
import {
  classifyByMap,
  hasArtifactMap,
  type MapClassification,
} from "./artifactMap.js";
import {
  classifyChannel,
  parseManualChannels,
  resolutionPolicy,
  resolveChannel,
} from "./channels.js";
import {
  getReleaseConfig,
  operatorPolicy,
  requiresDmg,
  shipsDmgs,
  type ReleaseConfigRow,
  type ResolvedConfig,
} from "./config.js";
import { resolveMovingSelector, type MovingResolution } from "./gateway.js";
import { legacyPolicyFor } from "./resolve.js";
import { readAppDeliverable } from "./descriptor.js";
import {
  NotFoundError,
  UpstreamRateLimitedError,
  type ReleaseAsset,
} from "./github.js";
import { type FetchImpl, getInstallationToken } from "./githubApp.js";
import {
  artifactKind,
  artifactPlatform,
  isBelowFloor,
  listChannelFloors,
} from "./store.js";

export type ReleaseHealthStatus =
  | "healthy"
  | "needs-setup"
  | "not-configured"
  | "error";

export type ReleaseHealthCheckStatus = "ok" | "missing" | "warning" | "error";

export interface ReleaseHealthCheck {
  id: string;
  label: string;
  status: ReleaseHealthCheckStatus;
  message?: string;
  missing?: string[];
  /** Files the check is about: what the latest release carries (`release-artifacts`), the file
   *  a declared entry matched, or an ambiguous entry's candidates. Platform/arch/format only
   *  where the map declares them or the name yields them. */
  files?: ReleaseHealthFile[];
}

export interface ReleaseHealthFile {
  name: string;
  platform?: string;
  arch?: string;
  format?: string;
}

export interface ReleaseHealth {
  status: ReleaseHealthStatus;
  healthy: boolean;
  missing: string[];
  checks: ReleaseHealthCheck[];
  release?: {
    tag: string;
    name: string | null;
    prerelease: boolean;
    assetCount: number;
    htmlUrl: string;
  };
}

function check(
  id: string,
  label: string,
  status: ReleaseHealthCheckStatus,
  message?: string,
  missing?: string[],
): ReleaseHealthCheck {
  return {
    id,
    label,
    status,
    ...(message ? { message } : {}),
    ...(missing && missing.length ? { missing } : {}),
  };
}

function summarize(checks: ReleaseHealthCheck[]): ReleaseHealthStatus {
  if (checks.some((c) => c.status === "error")) return "error";
  if (checks.some((c) => c.status === "missing")) return "needs-setup";
  return "healthy";
}

/**
 * What the health check expects of a release. `requireDmg`/`requireCli`/`architectures` are
 * MANIFEST-owned and come from `artifact_policy_json`; `requireSparkleSignature` is
 * OPERATOR-owned and comes from `operator_policy_json` (P0-01) through the same reader the feed
 * uses.
 *
 * An artifact is required only when the policy says so EXPLICITLY (`requireDmg: true`,
 * `requireCli: true`) — the same reading the manifest normaliser gives the fields. No policy,
 * or an unreadable one, requires nothing: health lists what a release carries instead of
 * assuming a macOS/CLI shape. (The Sparkle checks keep their own, fail-closed gating through
 * `requiresDmg`/`shipsDmgs`.)
 */
function artifactPolicy(cfg: ReleaseConfigRow): {
  requireDmg: boolean;
  requireCli: boolean;
  architectures: string[];
  requireSparkleSignature: boolean;
} {
  const { requireSparkleSignature } = operatorPolicy(cfg);
  const none = {
    requireDmg: false,
    requireCli: false,
    architectures: [],
    requireSparkleSignature,
  };
  const raw = cfg.artifact_policy_json;
  if (!raw) return none;
  try {
    const parsed = JSON.parse(raw) as {
      requireDmg?: unknown;
      requireCli?: unknown;
      architectures?: unknown;
    };
    if (!parsed || typeof parsed !== "object") return none;
    return {
      requireDmg: parsed.requireDmg === true,
      requireCli: parsed.requireCli === true,
      architectures: Array.isArray(parsed.architectures)
        ? [
            ...new Set(
              parsed.architectures.filter(
                (a): a is string => typeof a === "string" && a.length > 0,
              ),
            ),
          ]
        : [],
      requireSparkleSignature,
    };
  } catch {
    return none;
  }
}

/** How many files the `release-artifacts` check lists before summarising the rest. */
const LISTED_FILES_CAP = 20;

function fileWord(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

/**
 * No declared artifact map: one informational check listing what the latest release carries.
 * Platform and arch are the truth store's own sniffing (`artifactPlatform`, `archOf`), shown
 * only where the name yields them. Never anything but `ok` — an absence here assumes nothing.
 */
function availableArtifactsCheck(
  tag: string,
  names: readonly string[],
): ReleaseHealthCheck {
  const sorted = [...names].sort();
  const files = sorted.slice(0, LISTED_FILES_CAP).map((name) => {
    const platform = artifactPlatform(artifactKind(name), name);
    const arch = archOf(name);
    return {
      name,
      ...(platform ? { platform } : {}),
      ...(arch ? { arch } : {}),
    };
  });
  const more = sorted.length - files.length;
  return {
    ...check(
      "release-artifacts",
      "Release artifacts",
      "ok",
      sorted.length === 0
        ? `${tag} carries no files.`
        : `${tag} carries ${fileWord(sorted.length)}` +
            (more > 0
              ? `; the first ${files.length} are listed, and ${more} more.`
              : "."),
    ),
    ...(files.length ? { files } : {}),
  };
}

function entryLabel(entry: ManifestArtifactEntry): string {
  return `${entry.id} (${entry.platform} ${entry.arch} ${entry.format})`;
}

/**
 * A declared artifact map is the expected set: one `artifact-<buildId>` check per entry, judged
 * by the SAME classification the truth store uses (`classifyByMap`). Exactly one match is `ok`;
 * none is `missing`; more than one is also `missing` — the map classifies none of them, so
 * nothing serves that build until the glob or the upload is fixed — and lists the candidates.
 */
function mapChecks(
  app: ManifestAppDeliverable,
  classified: MapClassification,
  names: readonly string[],
): ReleaseHealthCheck[] {
  const payloadOf = new Map<string, string>();
  for (const name of names) {
    const file = classified.files.get(name);
    if (file && file.role === "payload" && !payloadOf.has(file.buildId))
      payloadOf.set(file.buildId, name);
  }
  // A non-payload entry (an index, a delta) is matched under its own role; find it by build.
  const matchedOf = (entryId: string): string | undefined =>
    payloadOf.get(entryId) ??
    names.find((n) => classified.files.get(n)?.buildId === entryId);

  return app.artifacts.map((entry) => {
    const id = `artifact-${entry.id}`;
    const label = entryLabel(entry);
    const fileOf = (name: string) => ({
      name,
      platform: entry.platform,
      arch: entry.arch,
      format: entry.format,
    });
    const candidates = classified.ambiguous.get(entry.id);
    if (candidates && candidates.length > 1) {
      return {
        ...check(
          id,
          label,
          "missing",
          `${candidates.length} files match ${JSON.stringify(entry.match)}, so none is served; ` +
            "narrow the glob or remove the extra upload.",
          [
            `${entry.id}: one file matching ${entry.match} (found ${candidates.length})`,
          ],
        ),
        files: candidates.map(fileOf),
      };
    }
    const matched = classified.builds.some((b) => b.id === entry.id)
      ? matchedOf(entry.id)
      : undefined;
    if (matched) {
      return {
        ...check(id, label, "ok", `Found ${matched}.`),
        files: [fileOf(matched)],
      };
    }
    return check(
      id,
      label,
      "missing",
      `No file in the latest release matches ${JSON.stringify(entry.match)}.`,
      [`${entry.id}: file matching ${entry.match}`],
    );
  });
}

/** `universal` and `any` are satisfied by a file of either arch (or of none). */
function isAnyArch(arch: string): boolean {
  const lower = arch.toLowerCase();
  return lower === "universal" || lower === "any";
}

/**
 * Explicit requirements from the manifest's `artifactPolicy`. With `architectures` declared, one
 * check per architecture (`dmg-<arch>`, `cli-<arch>`); without, one check (`dmg`, `cli`) that any
 * matching file satisfies. A requirement the policy does not state produces no check at all.
 */
function policyChecks(
  cfg: ReleaseConfigRow,
  product: string,
  assets: ReleaseAsset[],
): ReleaseHealthCheck[] {
  const policy = artifactPolicy(cfg);
  const binaryName = cfg.binary_name ?? product;
  const out: ReleaseHealthCheck[] = [];
  const kinds: {
    required: boolean;
    id: "dmg" | "cli";
    label: string;
    noun: string;
    find: (arch: Arch) => ReleaseAsset | null;
  }[] = [
    {
      required: policy.requireDmg,
      id: "dmg",
      label: "macOS DMG",
      noun: "DMG asset",
      find: (arch) => matchAsset(assets, { arch, ext: "dmg", binaryName }),
    },
    {
      required: policy.requireCli,
      id: "cli",
      label: "CLI binary",
      noun: "CLI asset",
      find: (arch) => findBinaryAsset(assets, binaryName, arch),
    },
  ];
  for (const kind of kinds) {
    if (!kind.required) continue;
    const ofKind = assets.filter((a) => artifactKind(a.name) === kind.id);
    const why = "required by the manifest's artifactPolicy";
    if (policy.architectures.length === 0) {
      const found = ofKind[0];
      out.push(
        check(
          kind.id,
          kind.label,
          found ? "ok" : "missing",
          found
            ? `Found ${ofKind.map((a) => a.name).join(", ")}.`
            : `No ${kind.noun} was found (${why}).`,
          found ? [] : [kind.noun],
        ),
      );
      continue;
    }
    for (const raw of policy.architectures) {
      const canonical = normalizeArch(raw);
      const found = canonical
        ? kind.find(canonical)
        : isAnyArch(raw)
          ? (ofKind[0] ?? null)
          : (ofKind.find((a) =>
              a.name.toLowerCase().includes(raw.toLowerCase()),
            ) ?? null);
      const arch = canonical ?? raw;
      out.push(
        check(
          `${kind.id}-${arch}`,
          `${kind.label} (${arch})`,
          found ? "ok" : "missing",
          found
            ? `Found ${found.name}.`
            : `No ${arch} ${kind.noun} was found (${why}).`,
          found ? [] : [`${arch} ${kind.noun}`],
        ),
      );
    }
  }
  return out;
}

/**
 * The DMG whose `.sig` sidecar the Sparkle check looks for: the declared macOS `dmg` payload when
 * the map classifies one (arm64 first, then universal, then any), otherwise the arm64 DMG the
 * appcast route itself selects by name.
 */
function sparklePayload(
  cfg: ReleaseConfigRow,
  product: string,
  assets: ReleaseAsset[],
  classified: MapClassification | null,
): string | null {
  if (classified) {
    const dmgs = [...classified.files.entries()].filter(
      ([, f]) =>
        f.role === "payload" && f.platform === "macos" && f.format === "dmg",
    );
    const rank = (arch: string) =>
      arch === "arm64" ? 0 : arch === "universal" ? 1 : 2;
    dmgs.sort(
      ([a, fa], [b, fb]) => rank(fa.arch) - rank(fb.arch) || a.localeCompare(b),
    );
    if (dmgs[0]) return dmgs[0][0];
  }
  return (
    matchAsset(assets, {
      arch: "arm64",
      ext: "dmg",
      binaryName: cfg.binary_name ?? product,
    })?.name ?? null
  );
}

export async function checkReleaseHealth(
  env: Env,
  db: Db,
  product: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<ReleaseHealth> {
  const cfg = await getReleaseConfig(db, product);
  if (!cfg) {
    return {
      status: "not-configured",
      healthy: false,
      missing: ["release config"],
      checks: [
        check(
          "config",
          "Release config",
          "missing",
          "No release_config row is configured for this product.",
          ["release config"],
        ),
      ],
    };
  }

  const checks: ReleaseHealthCheck[] = [];
  const configMissing = [
    ...(cfg.gh_owner ? [] : ["GitHub owner"]),
    ...(cfg.gh_repo ? [] : ["GitHub repo"]),
    ...(cfg.gh_installation_id ? [] : ["GitHub installation"]),
    ...(cfg.binary_name ? [] : ["binary name"]),
  ];
  checks.push(
    check(
      "config",
      "Release config",
      configMissing.length ? "missing" : "ok",
      configMissing.length
        ? "The manifest has not provided every release field required by v1."
        : "GitHub release config is complete.",
      configMissing,
    ),
  );

  if (!cfg.gh_owner || !cfg.gh_repo || !cfg.gh_installation_id) {
    const status = summarize(checks);
    return {
      status,
      healthy: status === "healthy",
      missing: configMissing,
      checks,
    };
  }

  const sparkleKeyCheck = () =>
    check(
      "sparkle-key",
      "Sparkle public key",
      cfg.sparkle_ed25519_pub ? "ok" : "warning",
      cfg.sparkle_ed25519_pub
        ? "Sparkle appcasts will fail closed when a signature is missing."
        : "No Sparkle public key is configured; appcasts may render unsigned.",
    );
  // A product that requires no DMG only gets the Sparkle key check once its latest release
  // turns out to ship one (see `shipsDmgs` below). This is the fail-closed Sparkle gating — no
  // policy at all reads as "requires a DMG" here — and is deliberately NOT the artifact policy,
  // which requires only what it states.
  const policyRequiresDmg = requiresDmg(cfg.artifact_policy_json);
  if (policyRequiresDmg) checks.push(sparkleKeyCheck());

  // The SAME resolution the live routes run (P0-02): candidate filter, semver order, live page
  // cap, channel floor. Health used to take the first non-draft entry of a 25-release page,
  // which is how a rolling `channels` tag or a prerelease could read as "latest" here while the
  // appcast served something else.
  const resolved = cfg as ResolvedConfig;
  let stable: MovingResolution;
  let token: string;
  try {
    // Pass the structured {owner, repo} scope, NOT the product slug. A bare string is the
    // legacy shape: `normalizeScope` cannot recover repo coordinates from it, so it falls
    // back to a permission-minimised but **installation-wide** token. On an org-wide App
    // install that is a token valid for every repo in the org — exactly what R5-03 set out
    // to remove. The slug happening to equal the repo name is a coincidence, not a contract.
    token = await getInstallationToken(
      env,
      { owner: cfg.gh_owner, repo: cfg.gh_repo },
      cfg.gh_installation_id,
      now,
      fetchImpl,
    );
    stable = await resolveMovingSelector(
      env,
      db,
      resolved,
      token,
      { kind: "stable", raw: "stable" },
      now,
      fetchImpl,
      // The same yanks the live routes apply (P2-05), so health names what they serve.
      await legacyPolicyFor(db, product, "stable"),
    );
    const releases = stable.listed;
    checks.push(
      check(
        "github",
        "GitHub access",
        "ok",
        `Listed ${releases.length} release${releases.length === 1 ? "" : "s"}.`,
      ),
    );
  } catch (err) {
    checks.push(
      check(
        "github",
        "GitHub access",
        "error",
        err instanceof NotFoundError || err instanceof Error
          ? err.message
          : "GitHub release access failed.",
      ),
    );
    const status = summarize(checks);
    return {
      status,
      healthy: false,
      missing: configMissing,
      checks,
    };
  }

  // R6-10: every floored channel whose floor release has disappeared. Stable comes from the
  // resolution above; the other floored channels are checked over the pages already read, with
  // one tag lookup each only when they sit below their floor.
  checks.push(
    ...(await regressionChecks(
      env,
      db,
      resolved,
      token,
      stable,
      now,
      fetchImpl,
    )),
  );

  const latest = stable.release;
  if (!latest) {
    checks.push(
      check(
        "latest-release",
        "Latest release",
        "missing",
        stable.regressed
          ? "The stable channel resolves to nothing: its floor release is gone (see channel-regressed)."
          : "No published GitHub release matches the stable candidate filter.",
        ["published GitHub release"],
      ),
    );
    const status = summarize(checks);
    return {
      status,
      healthy: status === "healthy",
      missing: checks.flatMap((c) => c.missing ?? []),
      checks,
    };
  }

  checks.push(
    check(
      "latest-release",
      "Latest release",
      "ok",
      `Latest published release is ${latest.tag_name}.`,
    ),
  );

  const app = await readAppDeliverable(db, product);
  const map = hasArtifactMap(app) ? app : null;
  const names = latest.assets.map((a) => a.name);
  const classified = map ? classifyByMap(map, names) : null;

  // What the release carries. A declared artifact map is the expected set: one check per entry.
  // Without one, nothing is assumed — the files are listed, and only an explicit policy below
  // can make an absence matter.
  if (map && classified) {
    checks.push(...mapChecks(map, classified, names));
  } else {
    checks.push(availableArtifactsCheck(latest.tag_name, names));
  }
  checks.push(...policyChecks(cfg, product, latest.assets));

  // DMG and Sparkle checks apply only to products that ship DMGs: a Godot or Linux-only
  // product is not told forever that it "needs setup" for artifacts it never builds.
  const latestHasDmg = latest.assets.some((asset) =>
    asset.name.toLowerCase().endsWith(".dmg"),
  );
  if (shipsDmgs(cfg.artifact_policy_json, latestHasDmg)) {
    if (!policyRequiresDmg) checks.push(sparkleKeyCheck());
    if (
      !cfg.sparkle_ed25519_pub &&
      artifactPolicy(cfg).requireSparkleSignature
    ) {
      checks.push(
        check(
          "sparkle-signature",
          "Sparkle signature",
          "missing",
          "Artifact policy requires signed Sparkle appcasts, but no public key is configured.",
          ["Sparkle public key"],
        ),
      );
    } else if (cfg.sparkle_ed25519_pub) {
      const payload = sparklePayload(cfg, product, latest.assets, classified);
      if (payload) {
        const sigName = sigAssetName(payload);
        const sig = latest.assets.find((asset) => asset.name === sigName);
        checks.push(
          check(
            "sparkle-signature",
            "Sparkle signature",
            sig ? "ok" : "missing",
            sig
              ? `Found ${sig.name}.`
              : `Expected Sparkle signature sidecar ${sigName}.`,
            sig ? [] : [sigName],
          ),
        );
      }
    }
  }

  const status = summarize(checks);
  return {
    status,
    healthy: status === "healthy",
    missing: checks.flatMap((c) => c.missing ?? []),
    checks,
    release: {
      tag: latest.tag_name,
      name: latest.name,
      prerelease: latest.prerelease,
      assetCount: latest.assets.length,
      htmlUrl: latest.html_url,
    },
  };
}

/** A regression check for a floor that no longer holds, naming both sides. */
function regressedCheck(
  res: MovingResolution,
  channel: string,
): ReleaseHealthCheck {
  const floor = res.floor;
  const floorName = floor
    ? `${floor.version}${floor.release_id ? ` (${floor.release_id})` : ""}`
    : "?";
  const offered = res.offered ? res.offered.tag_name : "nothing";
  return check(
    channel === "stable" ? "channel-regressed" : `channel-regressed-${channel}`,
    `Channel floor (${channel})`,
    "error",
    `${channel} is floored at ${floorName}, but that release is gone and the release list now offers ${offered}. ` +
      `The channel answers 404 until the release is restored or an operator lowers or clears the floor ` +
      `(POST …/release/channels/${channel}/floor).`,
  );
}

async function regressionChecks(
  env: Env,
  db: Db,
  cfg: ResolvedConfig,
  token: string,
  stable: MovingResolution,
  now: number,
  fetchImpl: FetchImpl,
): Promise<ReleaseHealthCheck[]> {
  const out: ReleaseHealthCheck[] = [];
  if (stable.regressed) out.push(regressedCheck(stable, "stable"));
  const manual = parseManualChannels(cfg.manual_channels_json);
  const policy = resolutionPolicy(cfg);
  for (const floor of await listChannelFloors(db, cfg.product)) {
    if (floor.channel === "stable") continue;
    const sel = classifyChannel(floor.channel, manual);
    if (!sel) continue;
    // Cheap pre-check over the pages already read; only a channel that LOOKS regressed pays for
    // the full resolution (whose floor lookup is the one extra GitHub call).
    if (
      !isBelowFloor(
        resolveChannel(sel, stable.listed, undefined, policy),
        floor,
      )
    )
      continue;
    // These calls run after the guarded GitHub block above, so they need their own guard: a
    // quota refusal or an upstream failure here must degrade to a warning on this one channel,
    // never throw away the whole report (and the stable result an operator came here for).
    let res: MovingResolution;
    try {
      res = await resolveMovingSelector(
        env,
        db,
        cfg,
        token,
        sel,
        now,
        fetchImpl,
      );
    } catch (err) {
      if (
        !(err instanceof NotFoundError) &&
        !(err instanceof UpstreamRateLimitedError)
      )
        throw err;
      out.push(
        check(
          `channel-floor-unverified-${floor.channel}`,
          `Channel floor (${floor.channel})`,
          "warning",
          `${floor.channel} is floored at ${floor.version}, but the releases read so far do not reach it ` +
            `and the follow-up GitHub lookup failed (${err.message}), so whether the floor release still exists is unknown.`,
        ),
      );
      continue;
    }
    if (res.regressed) out.push(regressedCheck(res, floor.channel));
  }
  return out;
}
