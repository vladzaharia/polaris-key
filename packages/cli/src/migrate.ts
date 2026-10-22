/**
 * `pkey migrate` — read a deployment's data-migration runner and dry-run its jobs (P0-49).
 *
 * The server half is `packages/worker/src/console/handlers/migrations.ts`
 * (`/manage/api/platform/migrations`). The credential is an admin API token carrying the
 * `migrations:report` scope, read from `PKEY_ADMIN_TOKEN` as `pkey bundle` does. That scope
 * reaches the job list, a run's report and the dry run, and nothing else.
 *
 * APPLY AND DOWN ARE NOT HERE, ON PURPOSE. Both change stored data and the Worker requires a
 * console step-up (a recent sign-in) for them. A token has no sign-in, so the Worker refuses it
 * on those routes, and this command does not try. An operator reads the report here, then applies
 * it from the console session, pinned to the report id this command printed.
 *
 * A dry run changes no data, but it stores a report (and an audit row naming the token), so it is
 * a POST.
 */

import {
  ADMIN_TOKEN_ENV,
  DEFAULT_BASE_URL,
  adminTokenFrom,
  type TokenSource,
  httpError,
  normalizeBaseUrl,
  readJson,
  request,
} from "./bundle.js";
import { untrusted, type UntrustedEnv } from "./untrusted.js";

export const MIGRATE_USAGE =
  "Usage: pkey migrate list | dry-run <job> | report <run> [--base-url <url>] [--json]";

export type MigrateVerb = "list" | "dry-run" | "report";

export interface MigrateOptions {
  verb: MigrateVerb;
  /** The job id (`dry-run`) or the run id (`report`). */
  target?: string;
  baseUrl?: string;
  /** `process.env.PKEY_ADMIN_TOKEN`, read by the caller. */
  /** The bearer token, or a function that resolves it once the local checks have passed. */
  token?: TokenSource;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface MigrationUnit {
  unit: string;
  status: string;
  planned: number;
  changes: number;
  error: string | null;
}

export interface MigrationRun {
  id: string;
  job: string;
  mode: string;
  status: string;
  changes: number;
  remaining: number;
  units: MigrationUnit[];
}

export type MigrateResult =
  | {
      verb: "list";
      jobs: { id: string; summary: string; runs: MigrationRun[] }[];
    }
  | { verb: "dry-run" | "report"; run: MigrationRun };

/** These routes take a `migrations:report` token only; a 403 means it is not one. */
function hint(status: number): string | undefined {
  if (status === 401)
    return `Your sign-in or the token in ${ADMIN_TOKEN_ENV} was refused (unknown, revoked or expired). Run pkey login, or mint a replacement in the console: /manage -> API tokens.`;
  if (status === 403)
    return "Not allowed. An API token needs the `migrations:report` scope, and its identity must be a platform admin.";
  if (status === 404) return "No such job or run.";
  if (status === 429)
    return "The admin API rate limit tripped. Wait a minute and retry.";
  return undefined;
}

export async function runMigrate(opts: MigrateOptions): Promise<MigrateResult> {
  const target = opts.target?.trim();
  if (opts.verb !== "list" && !target)
    throw new Error(
      `${opts.verb === "dry-run" ? "A job id" : "A run id"} is required.\n${MIGRATE_USAGE}`,
    );
  const token = await adminTokenFrom(opts.token, "migrate");
  const baseUrl = normalizeBaseUrl(
    opts.baseUrl?.trim() || DEFAULT_BASE_URL,
    ADMIN_TOKEN_ENV,
  );
  const root = `${baseUrl}/manage/api/platform/migrations`;
  const url =
    opts.verb === "list"
      ? root
      : opts.verb === "report"
        ? `${root}/runs/${encodeURIComponent(target!)}`
        : `${root}/dry-run`;
  const post = opts.verb === "dry-run";
  const res = await request(opts.fetchImpl ?? fetch, url, {
    method: post ? "POST" : "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(post ? { "content-type": "application/json" } : {}),
    },
    ...(post ? { body: JSON.stringify({ job: target }) } : {}),
    signal: opts.signal,
  });
  if (!res.ok) throw await httpError(res, `Reading ${url}`, hint);
  const payload = await readJson(res, url);
  if (opts.verb === "list") {
    if (!Array.isArray(payload.jobs))
      throw new Error(`${url} answered ${res.status} without a job list.`);
    return { verb: "list", jobs: payload.jobs as never };
  }
  const run = payload.run as MigrationRun | undefined;
  if (!run || typeof run.id !== "string")
    throw new Error(`${url} answered ${res.status} without a run.`);
  return { verb: opts.verb, run };
}

/** The result as plain text; every server string is cleaned (`untrusted.ts`). */
export function formatMigrate(r: MigrateResult, env: UntrustedEnv): string {
  const u = (v: unknown) => untrusted(v, env);
  if (r.verb === "list") {
    if (!r.jobs.length) return "No migration jobs.\n";
    return r.jobs
      .map((j) => {
        const last = j.runs[0];
        const state = last
          ? `${u(last.mode)} ${u(last.status)} (${u(last.id)})`
          : "never run";
        return `${u(j.id)}  ${u(j.summary)}\n  latest: ${state}\n`;
      })
      .join("");
  }
  const { run } = r;
  const lines = [
    `${u(run.job)}  ${u(run.mode)}  ${u(run.status)}`,
    `Run: ${u(run.id)}`,
    `${run.mode === "dry-run" ? "Diffs" : "Changed"}: ${run.changes}   Remaining: ${run.remaining}`,
  ];
  for (const x of run.units)
    lines.push(
      `  ${u(x.unit)}  ${u(x.status)}  planned ${x.planned}  changed ${x.changes}${x.error ? `  ${u(x.error)}` : ""}`,
    );
  if (r.verb === "dry-run")
    lines.push(
      "",
      run.changes === 0
        ? "Nothing to change: the data is already migrated."
        : `To apply, use the console with report ${u(run.id)} (apply needs a step-up).`,
    );
  return `${lines.join("\n")}\n`;
}
