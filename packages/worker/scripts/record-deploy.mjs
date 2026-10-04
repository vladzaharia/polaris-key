#!/usr/bin/env node
// A-11 (notes/S-13 §4): record one production deploy in `platform_deploys`.
//
// Run by the LAST step of `.github/workflows/deploy.yml` ("Record deploy"), after the request
// Worker is live. That step is `continue-on-error`: a failure here prints a `::warning::` and
// leaves an already-successful deploy green. The row is a convenience for the console's
// Deployment page, never a gate.
//
// Inputs (environment, all set by the workflow):
//   ENV            prod | staging | dev               DATABASE   the D1 database name
//   TAG            the release tag (vMAJOR.MINOR.PATCH[-pre])
//   GIT_SHA        the 40-hex commit                   RUN_URL    the Actions run URL
//   RUN_ID, RUN_ATTEMPT                                SMOKE      the smoke step's outcome
//   MAIN_OUTPUT, DELTAS_OUTPUT   wrangler's ND-JSON output files (WRANGLER_OUTPUT_FILE_PATH) for
//                  the two deploys; each `{"type":"deploy","version_id":...}` entry gives that
//                  script's Cloudflare version id. A missing or unreadable file is a NULL id.
//
// `wrangler d1 execute --command` takes no bind parameters, so every value is checked against a
// strict pattern BEFORE it is quoted into the statement (and quoted with '' escaping anyway). A
// value that fails its check aborts the record; nothing partial is written.
//
// Usage:  node scripts/record-deploy.mjs          (inside packages/worker)

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const PATTERNS = {
  id: /^\d{1,20}-\d{1,5}$/,
  environment: /^(prod|staging|dev)$/,
  tag: /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
  gitSha: /^[0-9a-f]{40}$/,
  runUrl:
    /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\/\d+$/,
  versionId: /^[0-9A-Za-z-]{1,64}$/,
  smoke: /^[a-z_]{1,20}$/,
  migration: /^\d{4}[0-9A-Za-z_]*\.sql$/,
  script: /^[a-z0-9-]{1,63}$/,
};

/** The newest `migrations/*.sql` by filename (the build's LATEST_MIGRATION). */
export function latestMigration(dir = join(HERE, "..", "migrations")) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files[files.length - 1] ?? null;
}

/** The `version_id` of the last `type: "deploy"` entry in wrangler's ND-JSON output, or null. */
export function versionIdFrom(ndjson) {
  let id = null;
  for (const line of String(ndjson ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (
        entry &&
        entry.type === "deploy" &&
        typeof entry.version_id === "string"
      )
        id = entry.version_id;
    } catch {
      // not a JSON line: ignore it
    }
  }
  return id;
}

function check(name, value, pattern, { nullable = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (nullable) return null;
    throw new Error(`record-deploy: ${name} is required`);
  }
  const s = String(value);
  if (!pattern.test(s))
    throw new Error(`record-deploy: ${name} ${JSON.stringify(s)} is malformed`);
  return s;
}

const q = (v) => (v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

/**
 * The one INSERT statement for a deploy row. Throws, building nothing, if any field is malformed.
 * `fields`: { id, at, environment, tag, gitSha, runUrl, scripts[], latestMigration,
 * cfVersionId, deltasVersionId, smoke }.
 */
export function deployRowSql(fields) {
  const id = check("id", fields.id, PATTERNS.id);
  if (!Number.isSafeInteger(fields.at) || fields.at <= 0)
    throw new Error("record-deploy: at must be a positive integer");
  const environment = check(
    "environment",
    fields.environment,
    PATTERNS.environment,
  );
  const tag = check("tag", fields.tag, PATTERNS.tag);
  const gitSha = check("gitSha", fields.gitSha, PATTERNS.gitSha);
  const runUrl = check("runUrl", fields.runUrl, PATTERNS.runUrl, {
    nullable: true,
  });
  if (!Array.isArray(fields.scripts) || fields.scripts.length === 0)
    throw new Error("record-deploy: scripts must be a non-empty array");
  const scripts = fields.scripts.map((s) =>
    check("script", s, PATTERNS.script),
  );
  const latest = check(
    "latestMigration",
    fields.latestMigration,
    PATTERNS.migration,
    {
      nullable: true,
    },
  );
  const cf = check("cfVersionId", fields.cfVersionId, PATTERNS.versionId, {
    nullable: true,
  });
  const deltas = check(
    "deltasVersionId",
    fields.deltasVersionId,
    PATTERNS.versionId,
    {
      nullable: true,
    },
  );
  const smoke = check("smoke", fields.smoke, PATTERNS.smoke, {
    nullable: true,
  });
  return (
    "INSERT INTO platform_deploys " +
    "(id, at, environment, tag, git_sha, run_url, scripts, latest_migration, cf_version_id, deltas_version_id, smoke) " +
    `VALUES (${[
      q(id),
      String(fields.at),
      q(environment),
      q(tag),
      q(gitSha),
      q(runUrl),
      q(JSON.stringify(scripts)),
      q(latest),
      q(cf),
      q(deltas),
      q(smoke),
    ].join(", ")})`
  );
}

function readOutput(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return versionIdFrom(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Build the row from the workflow's environment. */
export function rowFromEnv(env, now = Math.floor(Date.now() / 1000)) {
  const environment = env.ENV;
  return {
    id: `${env.RUN_ID}-${env.RUN_ATTEMPT || "1"}`,
    at: now,
    environment,
    tag: env.TAG,
    gitSha: env.GIT_SHA,
    runUrl: env.RUN_URL || null,
    scripts: [
      `polaris-key-deltas-${environment}`,
      `polaris-key-${environment}`,
    ],
    latestMigration: latestMigration(),
    cfVersionId: readOutput(env.MAIN_OUTPUT),
    deltasVersionId: readOutput(env.DELTAS_OUTPUT),
    smoke: env.SMOKE || null,
  };
}

function main() {
  try {
    const database = check(
      "DATABASE",
      process.env.DATABASE,
      /^[a-z0-9_-]{1,64}$/,
    );
    const row = rowFromEnv(process.env);
    const sql = deployRowSql(row);
    const require = createRequire(import.meta.url);
    const bin = join(
      dirname(require.resolve("wrangler/package.json")),
      "bin",
      "wrangler.js",
    );
    const run = spawnSync(
      process.execPath,
      [
        bin,
        "d1",
        "execute",
        database,
        "--env",
        row.environment,
        "--remote",
        "--command",
        sql,
      ],
      {
        cwd: join(HERE, ".."),
        encoding: "utf8",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    if (run.status !== 0)
      throw new Error(
        `wrangler d1 execute failed (exit ${run.status}): ${run.stderr || run.stdout}`,
      );
    console.log(
      `record-deploy: recorded ${row.tag} (${row.gitSha.slice(0, 12)}) in ${database} as ${row.id}` +
        ` (worker version ${row.cfVersionId ?? "unknown"}, consumer ${row.deltasVersionId ?? "unknown"}).`,
    );
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e).replace(
      /\r?\n/g,
      " ",
    );
    // A workflow annotation, so the miss is visible on the run summary. The step is
    // continue-on-error, so the deploy itself stays green.
    console.log(`::warning title=Deploy not recorded::${message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
