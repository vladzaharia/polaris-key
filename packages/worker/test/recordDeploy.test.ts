// A-11: the deploy record (`scripts/record-deploy.mjs`) and its place in
// `.github/workflows/deploy.yml`. The workflow holds production credentials, so the properties
// that keep the new step harmless are pinned here: it is LAST, it runs only once the request
// Worker deploy succeeded, and it can never fail the job.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  deployRowSql,
  latestMigration,
  rowFromEnv,
  versionIdFrom,
  type DeployRowFields,
} from "../scripts/record-deploy.mjs";
import { LATEST_MIGRATION } from "../src/core/deployIdentity.js";
import { listPlatformDeploys } from "../src/repo.js";
import { makeTestDb } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";

const ROW: DeployRowFields = {
  id: "123456789-1",
  at: 1_700_000_000,
  environment: "prod",
  tag: "v0.9.0",
  gitSha: SHA,
  runUrl: "https://github.com/vladzaharia/polaris-key/actions/runs/123456789",
  scripts: ["polaris-key-deltas-prod", "polaris-key-prod"],
  latestMigration: LATEST_MIGRATION,
  cfVersionId: "a1b2c3d4-0000-4000-8000-000000000000",
  deltasVersionId: null,
  smoke: "success",
};

describe("record-deploy: the INSERT", () => {
  it("is valid SQL against the migrated schema and round-trips every field", async () => {
    const db = makeTestDb();
    await db.run(deployRowSql(ROW));
    const [row] = await listPlatformDeploys(db);
    expect(row).toEqual({
      id: ROW.id,
      at: ROW.at,
      environment: "prod",
      tag: "v0.9.0",
      git_sha: SHA,
      run_url: ROW.runUrl,
      scripts: JSON.stringify(ROW.scripts),
      latest_migration: LATEST_MIGRATION,
      cf_version_id: ROW.cfVersionId,
      deltas_version_id: null,
      smoke: "success",
    });
  });

  const bad: Array<[string, Partial<DeployRowFields>]> = [
    ["a quote in the tag", { tag: "v1.0.0-'); DROP TABLE x; --" }],
    ["a non-semver tag", { tag: "latest" }],
    ["a short sha", { gitSha: "abc123" }],
    ["an unknown environment", { environment: "preview" }],
    ["a foreign run URL", { runUrl: "https://evil.example/x" }],
    ["a quote in a version id", { cfVersionId: "x' OR 1=1" }],
    ["a malformed id", { id: "abc" }],
    ["a non-integer time", { at: 1.5 }],
    ["no scripts", { scripts: [] }],
    ["a bad script name", { scripts: ["Polaris Key"] }],
    ["a bad migration name", { latestMigration: "../etc/passwd" }],
  ];
  for (const [name, patch] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => deployRowSql({ ...ROW, ...patch })).toThrow(/record-deploy/);
    });
  }
});

describe("record-deploy: inputs", () => {
  it("reads the deploy version id from wrangler's ND-JSON output", () => {
    const out = [
      JSON.stringify({ type: "wrangler-session", version: 1 }),
      "not json",
      JSON.stringify({ type: "deploy", version: 1, version_id: "v-123" }),
      "",
    ].join("\n");
    expect(versionIdFrom(out)).toBe("v-123");
    expect(versionIdFrom("")).toBeNull();
    expect(versionIdFrom(null)).toBeNull();
  });

  it("its latest migration is LATEST_MIGRATION", () => {
    expect(latestMigration()).toBe(LATEST_MIGRATION);
  });

  it("builds the row from the workflow environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-deploy-"));
    try {
      const main = join(dir, "main.ndjson");
      writeFileSync(
        main,
        JSON.stringify({ type: "deploy", version_id: "main-v" }) + "\n",
      );
      const row = rowFromEnv(
        {
          ENV: "prod",
          TAG: "v0.9.0",
          GIT_SHA: SHA,
          RUN_URL: ROW.runUrl!,
          RUN_ID: "123456789",
          RUN_ATTEMPT: "2",
          SMOKE: "failure",
          MAIN_OUTPUT: main,
          DELTAS_OUTPUT: join(dir, "missing.ndjson"),
        },
        42,
      );
      expect(row).toEqual({
        ...ROW,
        id: "123456789-2",
        at: 42,
        cfVersionId: "main-v",
        deltasVersionId: null,
        smoke: "failure",
      });
      expect(() => deployRowSql(row)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}

describe("deploy.yml", () => {
  const workflow = parse(
    readFileSync(
      join(HERE, "..", "..", "..", ".github", "workflows", "deploy.yml"),
      "utf8",
    ),
  ) as { jobs: Record<string, { steps: Step[] }> };
  const steps = workflow.jobs["deploy-worker"]!.steps;
  const index = (name: string) => steps.findIndex((s) => s.name === name);

  it("records the deploy LAST, only after the request Worker deployed, and never fails the job", () => {
    const record = steps[steps.length - 1]!;
    expect(record.name).toBe("Record deploy");
    expect(record["continue-on-error"]).toBe(true);
    expect(record.if).toContain("steps.deploy-main.outcome == 'success'");
    expect(record.if).toContain("!cancelled()");
    expect(record.run).toContain("node scripts/record-deploy.mjs");
    expect(index("Record deploy")).toBeGreaterThan(index("Smoke check"));
    expect(index("Smoke check")).toBeGreaterThan(
      index("Deploy worker + admin assets"),
    );
    expect(record.env?.SMOKE).toBe("${{ steps.smoke.outcome }}");
  });

  it("keeps the existing order: migrations, consumer, assets, worker, smoke", () => {
    const order = [
      "Queues preflight",
      "Apply D1 migrations",
      "Deploy lazy-delta consumer",
      "Assemble static assets (admin SPA + docs site)",
      "Deploy worker + admin assets",
      "Smoke check",
      "Record deploy",
    ].map(index);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("stamps both deploys with the tag and commit", () => {
    const deploys = [
      steps[index("Deploy lazy-delta consumer")]!,
      steps[index("Deploy worker + admin assets")]!,
    ];
    expect(steps[index("Deploy worker + admin assets")]!.id).toBe(
      "deploy-main",
    );
    expect(steps[index("Smoke check")]!.id).toBe("smoke");
    for (const step of deploys) {
      expect(step.run).toContain('--var "PKEY_RELEASE_TAG:$TAG"');
      expect(step.run).toContain('--var "PKEY_GIT_SHA:$GITHUB_SHA"');
      expect(step.run).toContain('--tag "${TAG:0:25}"');
      expect(step.run).toContain("--message");
      expect(step.env?.TAG).toBe("${{ steps.target.outputs.tag }}");
      expect(step.env?.WRANGLER_OUTPUT_FILE_PATH).toMatch(/runner\.temp/);
    }
  });
});

describe("wrangler configs", () => {
  for (const file of ["wrangler.toml", "wrangler.deltas.toml"]) {
    it(`${file} binds CF_VERSION_METADATA in every environment (not inherited)`, () => {
      const toml = readFileSync(join(HERE, "..", file), "utf8");
      for (const env of ["prod", "staging", "dev"]) {
        expect(toml).toMatch(
          new RegExp(
            `\\[env\\.${env}\\.version_metadata\\]\\s*\\nbinding = "CF_VERSION_METADATA"`,
          ),
        );
      }
    });
  }
});
