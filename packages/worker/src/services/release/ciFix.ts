/// <reference types="@cloudflare/workers-types" />

/**
 * A-32.6: fix what the CI readiness read found missing (`POST …/release/ci-readiness/fix`,
 * FLOWS W9; plan D-G8): the `release` environment, deployment-limited to `v*` tags, and the
 * tag ruleset on `refs/tags/v*` (creation, deletion, update and non-fast-forward blocked, active,
 * bypass for repository admins: only an admin creates a release tag).
 *
 * Readiness decides. A check is written only when `ciReadiness` says `missing` and the
 * installation's capabilities allow it; `ok` is left alone, `unknown` is not touched. Every write
 * goes through `githubWrite` (the closed table, a narrowed token per call). Re-running is
 * harmless: a ruleset of ours that exists is updated in place, never duplicated.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { getPublisherPolicy } from "../../core/publisher.js";
import {
  ENV_NOT_TAG_LIMITED,
  ENV_NO_TAG_POLICY,
  ciReadiness,
} from "./ciReadiness.js";
import { getReleaseConfig } from "./config.js";
import { discoverInstallation, type FetchImpl } from "./githubApp.js";
import type { Verified } from "./github/allow.js";
import { githubWrite, type WriteResult } from "./github/write.js";

export const FIX_CHECKS = ["environment", "ruleset"] as const;
export type FixCheck = (typeof FIX_CHECKS)[number];

/** The permission both fixes need, in the `<name>: <level>` form the refusals use. */
export const ADMIN_PERMISSION = "administration: write";

export const RULESET_NAME = "Polaris Key release tags";

/** `created` and `updated` wrote; `ok` was already there; `skipped` was not touched. */
export type FixState = "created" | "updated" | "ok" | "skipped";

export interface FixOutcome {
  id: FixCheck;
  state: FixState;
  /** A reason, never content. */
  detail?: string;
}

export type FixResult =
  | { ok: true; repository: string; results: FixOutcome[] }
  | {
      ok: false;
      status: 409 | 502;
      reason: "app_not_installed" | "app_permission" | "github";
      /** `<name>: <level>`, with `app_permission` only. */
      permission?: string;
      /** What was written before the refusal. */
      results: FixOutcome[];
    };

/** The rules the ruleset carries (D-G8). */
const RULE_TYPES = [
  "creation",
  "deletion",
  "update",
  "non_fast_forward",
] as const;
/** GitHub's built-in repository-admin role. */
const ADMIN_ROLE = { actor_id: 5, actor_type: "RepositoryRole" } as const;

/** The ruleset body (D-G8); `allow.ts` refuses any other shape. */
export const releaseRuleset = () => ({
  target: "tag",
  name: RULESET_NAME,
  rules: RULE_TYPES.map((type) => ({ type })),
  enforcement: "active",
  bypass_actors: [{ ...ADMIN_ROLE, bypass_mode: "always" }],
  conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
});

type Send = (
  action: string,
  method: string,
  path: string,
  body?: unknown,
  verified?: Verified,
) => Promise<WriteResult>;

class Refused extends Error {
  constructor(
    readonly reason: "app_permission" | "github",
    readonly status: 409 | 502,
    /** What was written before this refusal, when the step was half done. */
    readonly partial?: FixOutcome,
  ) {
    super(reason);
  }
}

/** 403 is the permission; any other non-2xx is GitHub's. */
function expectOk(res: WriteResult, also: number[] = []): void {
  if (res.ok || also.includes(res.status)) return;
  if (res.status === 403) throw new Refused("app_permission", 409);
  throw new Refused("github", 502);
}

/**
 * Create the environment and its `v*` tag policy. `exists` is true when readiness found the
 * environment already there (a half-applied fix): the PUT is then not sent, because an update
 * that omits an environment's reviewers and wait timer may reset them.
 */
async function fixEnvironment(
  send: Send,
  exists: boolean,
): Promise<FixOutcome> {
  if (!exists)
    expectOk(
      await send("env.release", "PUT", "/environments/release", {
        deployment_branch_policy: {
          protected_branches: false,
          custom_branch_policies: true,
        },
      }),
    );
  const policy = await send(
    "env.release",
    "POST",
    "/environments/release/deployment-branch-policies",
    { name: "v*", type: "tag" },
  );
  // GitHub's documented answer for a policy that is already there is 303 (the request is sent
  // with redirects off); any other failure, 422 included, is a failure.
  try {
    expectOk(policy, [303]);
  } catch (e) {
    if (e instanceof Refused && !exists)
      throw new Refused(e.reason, e.status, {
        id: "environment",
        state: "created",
        detail: "environment created, tag policy not added",
      });
    throw e;
  }
  return { id: "environment", state: "created" };
}

async function fixRuleset(send: Send): Promise<FixOutcome> {
  const list = await send("ruleset.tags", "GET", "/rulesets");
  expectOk(list);
  const mine = Array.isArray(list.body)
    ? (list.body as Array<{ id?: unknown; name?: unknown; target?: unknown }>)
        .filter(
          (r) =>
            r.name === RULESET_NAME &&
            r.target === "tag" &&
            typeof r.id === "number",
        )
        .map((r) => r.id as number)[0]
    : undefined;
  if (mine !== undefined) {
    expectOk(
      await send("ruleset.tags", "PUT", `/rulesets/${mine}`, releaseRuleset(), {
        ruleset: mine,
      }),
    );
    return { id: "ruleset", state: "updated" };
  }
  expectOk(await send("ruleset.tags", "POST", "/rulesets", releaseRuleset()));
  return { id: "ruleset", state: "created" };
}

export async function fixCiReadiness(
  env: Env,
  db: Db,
  slug: string,
  checks: readonly FixCheck[],
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<FixResult> {
  const readiness = await ciReadiness(env, db, slug, now, fetchImpl);
  const state = (id: string) =>
    readiness.checks.find((c) => c.id === id)?.state;
  if (!readiness.repository || state("app") !== "ok")
    return {
      ok: false,
      status: 409,
      reason: "app_not_installed",
      results: [],
    };

  // The allow-list writes the environment named `release` only; a manifest or a publisher that
  // names another one is not ours to create, and `release` is not the one being checked.
  const policy = await getPublisherPolicy(db, slug);
  const foreignEnv =
    readiness.environmentName !== "release" ||
    (policy !== null && policy.environment !== "release");
  // An environment that exists but is not limited to selected tags would need a PUT, which may
  // reset its reviewers: left to the person.
  const envCheck = readiness.checks.find((c) => c.id === "environment");
  const envPresetUnsafe = envCheck?.detail === ENV_NOT_TAG_LIMITED;
  const envExists = envCheck?.detail === ENV_NO_TAG_POLICY;

  const todo = checks.filter(
    (id) =>
      state(id) === "missing" &&
      !(id === "environment" && (foreignEnv || envPresetUnsafe)),
  );
  // Refuse before the first write when any of them lacks the grant.
  if (todo.some((id) => !readiness.capabilities[id]))
    return {
      ok: false,
      status: 409,
      reason: "app_permission",
      permission: ADMIN_PERMISSION,
      results: [],
    };

  const results: FixOutcome[] = [];
  for (const id of checks) {
    if (!todo.includes(id)) {
      const s = state(id);
      results.push(
        s === "ok"
          ? { id, state: "ok" }
          : {
              id,
              state: "skipped",
              detail:
                id === "environment" && foreignEnv && s === "missing"
                  ? "the manifest or publisher names another environment"
                  : id === "environment" && envPresetUnsafe && s === "missing"
                    ? "the environment exists; limit its deployments to the v* tag yourself"
                    : "readiness could not tell",
            },
      );
    }
  }

  if (todo.length === 0)
    return { ok: true, repository: readiness.repository, results };

  const [owner, repo] = readiness.repository.split("/") as [string, string];
  const cfg = await getReleaseConfig(db, slug);
  try {
    const installId =
      cfg?.gh_installation_id ??
      (await discoverInstallation(env, owner, repo, now, fetchImpl));
    const send: Send = (action, method, path, body, verified) =>
      githubWrite(
        env,
        installId,
        { owner, repo, ...(verified ? { verified } : {}) },
        action,
        {
          method,
          path: `/repos/${owner}/${repo}${path}`,
          ...(body === undefined ? {} : { body }),
        },
        now,
        fetchImpl,
      );
    for (const id of todo)
      results.push(
        id === "environment"
          ? await fixEnvironment(send, envExists)
          : await fixRuleset(send),
      );
  } catch (e) {
    const done = [
      ...results,
      ...(e instanceof Refused && e.partial ? [e.partial] : []),
    ].sort(order);
    if (e instanceof Refused)
      return {
        ok: false,
        status: e.status,
        reason: e.reason,
        ...(e.reason === "app_permission"
          ? { permission: ADMIN_PERMISSION }
          : {}),
        results: done,
      };
    // The token mint answers 422 when the App was never granted the permission.
    const denied =
      e instanceof Error &&
      /installation token failed: (403|422)/.test(e.message);
    return {
      ok: false,
      status: denied ? 409 : 502,
      reason: denied ? "app_permission" : "github",
      ...(denied ? { permission: ADMIN_PERMISSION } : {}),
      results: done,
    };
  }
  return {
    ok: true,
    repository: readiness.repository,
    results: results.sort(order),
  };
}

const order = (a: FixOutcome, b: FixOutcome): number =>
  FIX_CHECKS.indexOf(a.id) - FIX_CHECKS.indexOf(b.id);
