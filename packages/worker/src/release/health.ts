/// <reference types="@cloudflare/workers-types" />

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { findBinaryAsset, matchAsset } from "./assets.js";
import { getReleaseConfig } from "./index.js";
import { type Release, listReleases, NotFoundError } from "./github.js";
import { type FetchImpl, getInstallationToken } from "./githubApp.js";
import { sigAssetName } from "./appcast.js";

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

function newestPublished(releases: Release[]): Release | null {
  return releases.find((r) => !r.draft) ?? null;
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

  let releases: Release[];
  try {
    const token = await getInstallationToken(
      env,
      product,
      cfg.gh_installation_id,
      now,
      fetchImpl,
    );
    releases = await listReleases(
      token,
      cfg.gh_owner,
      cfg.gh_repo,
      25,
      fetchImpl,
    );
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

  const latest = newestPublished(releases);
  if (!latest) {
    checks.push(
      check(
        "latest-release",
        "Latest release",
        "missing",
        "No published GitHub release is available.",
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
      x64Dmg ? "ok" : "warning",
      x64Dmg
        ? `Found ${x64Dmg.name}.`
        : "No x86_64 DMG asset was found; Intel macOS downloads will 404.",
    ),
  );

  if (cfg.sparkle_ed25519_pub && armDmg) {
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
      armCli ? "ok" : "warning",
      armCli
        ? `Found ${armCli.name}.`
        : "No arm64 CLI asset was found; CLI installers may be unavailable.",
    ),
  );
  checks.push(
    check(
      "cli-x86_64",
      "CLI x86_64 asset",
      x64Cli ? "ok" : "warning",
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
