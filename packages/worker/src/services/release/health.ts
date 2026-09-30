/// <reference types="@cloudflare/workers-types" />

import type { Db, Env } from "../../core/platform.js";
import { findBinaryAsset, matchAsset, sigAssetName } from "./assets.js";
import {
  classifyChannel,
  parseManualChannels,
  resolutionPolicy,
  resolveChannel,
} from "./channels.js";
import {
  getReleaseConfig,
  operatorPolicy,
  type ReleaseConfigRow,
  type ResolvedConfig,
} from "./config.js";
import { resolveMovingSelector, type MovingResolution } from "./gateway.js";
import { NotFoundError } from "./github.js";
import { type FetchImpl, getInstallationToken } from "./githubApp.js";
import { isBelowFloor, listChannelFloors } from "./store.js";

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
 * What the health check expects of a release. `requireDmg`/`requireCli` are MANIFEST-owned and
 * come from `artifact_policy_json`; `requireSparkleSignature` is OPERATOR-owned and comes from
 * `operator_policy_json` (P0-01) through the same reader the feed uses. Unreadable JSON falls
 * back to the fail-safe defaults: a DMG and a signature required, no CLI.
 */
function artifactPolicy(cfg: ReleaseConfigRow): {
  requireDmg: boolean;
  requireCli: boolean;
  requireSparkleSignature: boolean;
} {
  const { requireSparkleSignature } = operatorPolicy(cfg);
  const raw = cfg.artifact_policy_json;
  if (!raw) {
    return { requireDmg: true, requireCli: false, requireSparkleSignature };
  }
  try {
    const parsed = JSON.parse(raw) as {
      requireDmg?: unknown;
      requireCli?: unknown;
    };
    return {
      requireDmg: parsed.requireDmg !== false,
      requireCli: parsed.requireCli === true,
      requireSparkleSignature,
    };
  } catch {
    return { requireDmg: true, requireCli: false, requireSparkleSignature };
  }
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

  checks.push(
    check(
      "sparkle-key",
      "Sparkle public key",
      cfg.sparkle_ed25519_pub ? "ok" : "warning",
      cfg.sparkle_ed25519_pub
        ? "Sparkle appcasts will fail closed when a signature is missing."
        : "No Sparkle public key is configured; appcasts may render unsigned.",
    ),
  );

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

  const binaryName = cfg.binary_name ?? product;
  const policy = artifactPolicy(cfg);
  const armDmg = matchAsset(latest.assets, {
    arch: "arm64",
    ext: "dmg",
    binaryName,
  });
  checks.push(
    check(
      "dmg-arm64",
      "macOS arm64 DMG",
      armDmg ? "ok" : "missing",
      armDmg
        ? `Found ${armDmg.name}.`
        : "The appcast and DMG endpoint need an arm64 DMG asset.",
      armDmg ? [] : ["arm64 DMG asset"],
    ),
  );

  const x64Dmg = matchAsset(latest.assets, {
    arch: "x86_64",
    ext: "dmg",
    binaryName,
  });
  checks.push(
    check(
      "dmg-x86_64",
      "macOS x86_64 DMG",
      x64Dmg ? "ok" : policy.requireDmg ? "missing" : "warning",
      x64Dmg
        ? `Found ${x64Dmg.name}.`
        : "No x86_64 DMG asset was found; Intel macOS downloads will 404.",
    ),
  );

  if (!cfg.sparkle_ed25519_pub && policy.requireSparkleSignature) {
    checks.push(
      check(
        "sparkle-signature",
        "Sparkle signature",
        "missing",
        "Artifact policy requires signed Sparkle appcasts, but no public key is configured.",
        ["Sparkle public key"],
      ),
    );
  } else if (cfg.sparkle_ed25519_pub && armDmg) {
    const sigName = sigAssetName(armDmg.name);
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

  const armCli = findBinaryAsset(latest.assets, binaryName, "arm64");
  const x64Cli = findBinaryAsset(latest.assets, binaryName, "x86_64");
  checks.push(
    check(
      "cli-arm64",
      "CLI arm64 asset",
      armCli ? "ok" : policy.requireCli ? "missing" : "warning",
      armCli
        ? `Found ${armCli.name}.`
        : "No arm64 CLI asset was found; CLI installers may be unavailable.",
    ),
  );
  checks.push(
    check(
      "cli-x86_64",
      "CLI x86_64 asset",
      x64Cli ? "ok" : policy.requireCli ? "missing" : "warning",
      x64Cli
        ? `Found ${x64Cli.name}.`
        : "No x86_64 CLI asset was found; CLI installers may be unavailable.",
    ),
  );

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
    const res = await resolveMovingSelector(
      env,
      db,
      cfg,
      token,
      sel,
      now,
      fetchImpl,
    );
    if (res.regressed) out.push(regressedCheck(res, floor.channel));
  }
  return out;
}
