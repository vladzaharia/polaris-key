/// <reference types="@cloudflare/workers-types" />

/**
 * A-32.3: the CI readiness read (`GET …/release/ci-readiness`, FLOWS W9). What stands between a
 * linked repository and "a `v*` tag publishes": the App on the repository, a valid `.pkey/`, the
 * workflow file, the `release` environment, the `v*` tag ruleset, the trusted publisher, and the
 * `distribution:pr` scope when a Homebrew or Scoop outlet is declared.
 *
 * Reads only. Every check is `ok`, `missing`, or `unknown`: a read the installation was never
 * granted, or one GitHub would not answer, is `unknown` and names the permission to grant. The
 * reads use read-narrowed installation tokens; nothing here goes through the write client.
 * Never throws for a GitHub failure: the answer says what it could not see.
 */

import {
  ACTION_REF_PLACEHOLDER,
  renderCiWorkflow,
} from "@polaris-key/manifest";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { deployIdentity } from "../../core/ops/deployIdentity.js";
import { getPublisherPolicy } from "../../core/publisher.js";
import { getReleaseConfig } from "./config.js";
import { fetchRepoFile } from "./github.js";
import {
  GITHUB_API,
  discoverInstallation,
  getInstallationToken,
  githubHeaders,
  mintInstallationToken,
  type FetchImpl,
} from "./githubApp.js";
import {
  capabilitiesFrom,
  installationPermissions,
  type WriteCapabilities,
} from "./github/write.js";
import { readLinkedManifest } from "./resync.js";

export type ReadinessState = "ok" | "missing" | "unknown";

export interface ReadinessCheck {
  id: string;
  state: ReadinessState;
  /** The App permission a read needed and the installation lacks (`unknown` only). */
  permission?: string;
  /** A name or a reason, never content: the publisher's workflow and environment, a refusal. */
  detail?: string;
}

export interface CiReadiness {
  /** `owner/repo`, `null` while the product has no linked repository. */
  repository: string | null;
  capabilities: WriteCapabilities;
  /** The environment the checks read: the manifest's trusted publisher names it, else `release`. */
  environmentName: string;
  checks: ReadinessCheck[];
  /** `.github/workflows/release.yml` as Polaris Key would write it, pinned to this Worker's commit. */
  workflowPreview: string | null;
}

/** The CI scope a tap or bucket pull request needs (A-32.7 adds it to the scope vocabulary). */
const PR_SCOPE = "distribution:pr";
const DEFAULT_WORKFLOW = ".github/workflows/release.yml";
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
/** Not `.` or `..`: those would turn the environment read into another path. */
const ENV_NAME = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
/** The environment's `detail` while it exists but does not yet limit deploys to `v*` tags. */
export const ENV_NO_TAG_POLICY = "no v* tag policy";
export const ENV_NOT_TAG_LIMITED =
  "deployments are not limited to selected tags";

/** The tag ruleset reads: GitHub lists a repository's rulesets without their conditions. */
const MAX_RULESETS = 10;

const NO_CAPABILITIES: WriteCapabilities = {
  pullRequest: false,
  workflow: false,
  environment: false,
  ruleset: false,
};

const ALL_CHECKS = [
  "app",
  "release-manifest",
  "workflow",
  "environment",
  "ruleset",
  "publisher",
] as const;

const unknowns = (ids: readonly string[]): ReadinessCheck[] =>
  ids.map((id) => ({ id, state: "unknown" }));

/** A GET with a read token; the parsed JSON on 2xx, else the status. */
async function getJson(
  fetchImpl: FetchImpl,
  token: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(`${GITHUB_API}${path}`, {
    headers: githubHeaders(`token ${token}`),
    redirect: "manual",
  });
  let body: unknown = null;
  if (res.ok) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Is there an active tag ruleset over `refs/tags/v*`? `null` when GitHub would not say. */
async function tagRuleset(
  fetchImpl: FetchImpl,
  token: string,
  root: string,
): Promise<boolean | null> {
  const list = await getJson(fetchImpl, token, `${root}/rulesets`);
  if (list.status === 404 || list.status === 403 || !Array.isArray(list.body))
    return null;
  const tags = list.body
    .filter(
      (r): r is { id: number } =>
        isObject(r) && r.target === "tag" && typeof r.id === "number",
    )
    .slice(0, MAX_RULESETS);
  for (const { id } of tags) {
    const one = await getJson(fetchImpl, token, `${root}/rulesets/${id}`);
    if (!isObject(one.body) || one.body.enforcement !== "active") continue;
    const cond = isObject(one.body.conditions) ? one.body.conditions : {};
    const refs = isObject(cond.ref_name) ? cond.ref_name.include : null;
    if (
      Array.isArray(refs) &&
      refs.some((r) => r === "refs/tags/v*" || r === "~ALL")
    )
      return true;
  }
  return false;
}

export async function ciReadiness(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<CiReadiness> {
  const cfg = await getReleaseConfig(db, slug);
  const owner = cfg?.gh_owner ?? null;
  const repo = cfg?.gh_repo ?? null;
  const releaseKeysDeclared = Boolean(
    cfg?.release_keys_json && cfg.release_keys_json !== "[]",
  );
  const preview = (
    manifest?: { releaseKeys: boolean; packs: string[] } | null,
  ): string | null => {
    try {
      return renderCiWorkflow({
        product: slug,
        channel: "stable",
        actionRef: deployIdentity(env).gitSha ?? ACTION_REF_PLACEHOLDER,
        releaseKeys: manifest ? manifest.releaseKeys : releaseKeysDeclared,
        packs: (manifest?.packs ?? []).map((id) => ({
          id,
          dir: `packs/${id}`,
        })),
      });
    } catch {
      return null;
    }
  };
  const notInstalled = (repository: string | null): CiReadiness => ({
    repository,
    capabilities: NO_CAPABILITIES,
    environmentName: "release",
    checks: [{ id: "app", state: "missing" }, ...unknowns(ALL_CHECKS.slice(1))],
    workflowPreview: preview(),
  });
  if (!owner || !repo) return notInstalled(null);
  const repository = `${owner}/${repo}`;
  const root = `/repos/${owner}/${repo}`;
  const unseen = (app: ReadinessState): CiReadiness => ({
    repository,
    capabilities: NO_CAPABILITIES,
    environmentName: "release",
    checks: [{ id: "app", state: app }, ...unknowns(ALL_CHECKS.slice(1))],
    workflowPreview: preview(),
  });

  // The App: installed on this repository, and what it was granted.
  let installId: number;
  let permissions: Record<string, string> | null;
  try {
    installId =
      cfg?.gh_installation_id ??
      (await discoverInstallation(env, owner, repo, now, fetchImpl));
    permissions = await installationPermissions(env, installId, now, fetchImpl);
  } catch (err) {
    const gone =
      err instanceof Error &&
      /not installed on this repository/.test(err.message);
    return gone ? notInstalled(repository) : unseen("unknown");
  }
  if (!permissions) return notInstalled(repository);
  const capabilities = capabilitiesFrom(permissions);

  let token: string;
  try {
    token = await getInstallationToken(
      env,
      { owner, repo },
      installId,
      now,
      fetchImpl,
    );
  } catch {
    return { ...unseen("ok"), capabilities };
  }

  const checks: ReadinessCheck[] = [{ id: "app", state: "ok" }];

  // `.pkey/`: read and validated at the default branch's head.
  const read = await readLinkedManifest(env, db, slug, now, fetchImpl);
  const manifest = read.ok ? read.manifest : null;
  checks.push(
    read.ok
      ? { id: "release-manifest", state: "ok" }
      : {
          id: "release-manifest",
          state: read.check === "app" ? "unknown" : "missing",
          detail: read.error,
        },
  );

  const tp = manifest?.release?.trustedPublisher ?? null;
  const workflowPath =
    tp && WORKFLOW_PATH.test(tp.workflow) ? tp.workflow : DEFAULT_WORKFLOW;
  const envName =
    tp && ENV_NAME.test(tp.environment) ? tp.environment : "release";

  try {
    const text = await fetchRepoFile(
      token,
      owner,
      repo,
      workflowPath,
      fetchImpl,
      read.ok ? read.commit : undefined,
    );
    checks.push({ id: "workflow", state: text === null ? "missing" : "ok" });
  } catch {
    checks.push({ id: "workflow", state: "unknown" });
  }

  // The `release` environment is read with Actions: read, which the install may not have.
  if (permissions.actions !== "read" && permissions.actions !== "write") {
    checks.push({
      id: "environment",
      state: "unknown",
      permission: "actions: read",
    });
  } else {
    try {
      const envToken = await mintInstallationToken(
        env,
        installId,
        {
          repositories: [repo],
          permissions: { actions: "read", metadata: "read" },
        },
        now,
        fetchImpl,
      );
      const envRoot = `${root}/environments/${envName}`;
      const res = await getJson(fetchImpl, envToken, envRoot);
      if (res.status === 404)
        checks.push({ id: "environment", state: "missing" });
      else if (res.status !== 200)
        checks.push({ id: "environment", state: "unknown" });
      else {
        // It exists. Ready means deploys are limited to selected policies AND a `v*` tag policy
        // is among them: an environment a half-applied fix left behind is offered again.
        const limit = isObject(res.body)
          ? res.body.deployment_branch_policy
          : null;
        if (!isObject(limit) || limit.custom_branch_policies !== true)
          checks.push({
            id: "environment",
            state: "missing",
            detail: ENV_NOT_TAG_LIMITED,
          });
        else {
          const pol = await getJson(
            fetchImpl,
            envToken,
            `${envRoot}/deployment-branch-policies`,
          );
          const list =
            isObject(pol.body) && Array.isArray(pol.body.branch_policies)
              ? pol.body.branch_policies
              : null;
          checks.push(
            pol.status !== 200 || list === null
              ? { id: "environment", state: "unknown" }
              : list.some(
                    (p) => isObject(p) && p.name === "v*" && p.type === "tag",
                  )
                ? { id: "environment", state: "ok" }
                : {
                    id: "environment",
                    state: "missing",
                    detail: ENV_NO_TAG_POLICY,
                  },
          );
        }
      }
    } catch {
      checks.push({ id: "environment", state: "unknown" });
    }
  }

  try {
    const found = await tagRuleset(fetchImpl, token, root);
    checks.push({
      id: "ruleset",
      state: found === null ? "unknown" : found ? "ok" : "missing",
    });
  } catch {
    checks.push({ id: "ruleset", state: "unknown" });
  }

  const policy = await getPublisherPolicy(db, slug);
  checks.push(
    policy
      ? {
          id: "publisher",
          state: "ok",
          detail: `${policy.workflow} · ${policy.environment}`,
        }
      : { id: "publisher", state: "missing" },
  );

  const tapOutlet = manifest?.distribution?.outlets.some((o) =>
    [
      "homebrewCask",
      "homebrewFormula",
      "homebrewTap",
      "scoop",
      "scoopBucket",
    ].some((k) => (o.identity as Record<string, unknown>)[k] !== undefined),
  );
  if (tapOutlet)
    checks.push({
      id: "distribution-pr",
      state: policy?.scopes.includes(PR_SCOPE) ? "ok" : "missing",
    });

  return {
    repository,
    capabilities,
    environmentName: envName,
    checks,
    workflowPreview: preview(
      manifest
        ? {
            releaseKeys: (manifest.release?.releaseKeys.length ?? 0) > 0,
            packs: (manifest.release?.packDeliverables ?? []).map((p) => p.id),
          }
        : null,
    ),
  };
}
