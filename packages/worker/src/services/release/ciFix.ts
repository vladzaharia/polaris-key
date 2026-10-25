/// <reference types="@cloudflare/workers-types" />

/**
 * A-32.6: fix what the CI readiness read found missing (`POST …/release/ci-readiness/fix`,
 * FLOWS W9; plan D-G8): the `release` environment, deployment-limited to `v*` tags, and the
 * tag ruleset on `refs/tags/v*` (deletion, update and non-fast-forward blocked, active, bypass
 * for repository admins).
 *
 * Readiness decides. A check is written only when `ciReadiness` says `missing` and the
 * installation's capabilities allow it; `ok` is left alone, `unknown` is not touched. Every write
 * goes through `githubWrite` (the closed table, a narrowed token per call). Re-running is
 * harmless: a ruleset of ours that exists is updated in place, never duplicated.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { getPublisherPolicy } from "../../core/publisher.js";
import { ciReadiness } from "./ciReadiness.js";
import { getReleaseConfig } from "./config.js";
import { discoverInstallation, type FetchImpl } from "./githubApp.js";
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
const RULE_TYPES = ["deletion", "update", "non_fast_forward"] as const;
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
) => Promise<WriteResult>;

class Refused extends Error {
  constructor(
    readonly reason: "app_permission" | "github",
    readonly status: 409 | 502,
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

async function fixEnvironment(send: Send): Promise<FixOutcome> {
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
  // A policy that is already there answers 409 or 422: the environment is as wanted.
  expectOk(policy, [409, 422]);
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
      await send("ruleset.tags", "PUT", `/rulesets/${mine}`, releaseRuleset()),
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

  // The allow-list writes the environment named `release` only; a publisher that names
  // another one is not ours to create.
  const policy = await getPublisherPolicy(db, slug);
  const foreignEnv = policy !== null && policy.environment !== "release";

  const todo = checks.filter(
    (id) => state(id) === "missing" && !(id === "environment" && foreignEnv),
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
                  ? "the publisher names another environment"
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
    const send: Send = (action, method, path, body) =>
      githubWrite(
        env,
        installId,
        { owner, repo },
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
          ? await fixEnvironment(send)
          : await fixRuleset(send),
      );
  } catch (e) {
    const done = [...results].sort(order);
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
