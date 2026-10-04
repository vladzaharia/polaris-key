/**
 * A-16 — `.github/workflows/sync-worker-secrets.yml` pushes the platform store credentials from
 * GitHub environment secrets to the Worker so a private key never passes through a shell history
 * or an agent transcript. A static check of the properties that make that true: manual dispatch
 * only, the `production` environment, read-only GITHUB_TOKEN, every secret passed through env
 * (never interpolated into the script), values fed on stdin, nothing echoed but names.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(
  join(
    HERE,
    "..",
    "..",
    "..",
    ".github",
    "workflows",
    "sync-worker-secrets.yml",
  ),
  "utf8",
);
const wf = parseYaml(RAW) as {
  on: Record<string, { inputs?: Record<string, Record<string, unknown>> }>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      environment: string;
      steps: Array<{
        uses?: string;
        run?: string;
        env?: Record<string, string>;
      }>;
    }
  >;
};

const NAMES = [
  "PLATFORM_ASC_API_KEY",
  "PLATFORM_APP_STORE_SERVER_KEY",
  "PLATFORM_GOOGLE_SERVICE_ACCOUNT",
  "PLATFORM_MS_PARTNER_CENTER",
  "PLATFORM_STEAM_PUBLISHER_KEY",
  "PLATFORM_APPLE_TEAM_ID",
];

const job = Object.values(wf.jobs)[0]!;
const push = job.steps.find((s) => s.run?.includes("wrangler secret put"))!;

describe("sync-worker-secrets workflow", () => {
  it("is manual-only, in the production environment, with a read-only token", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(Object.keys(wf.jobs)).toHaveLength(1);
    expect(job.environment).toBe("production");
    expect(wf.on.workflow_dispatch!.inputs!.target).toMatchObject({
      default: "prod",
      options: ["prod", "staging"],
    });
  });

  it("passes every secret through env only, never interpolated into a script", () => {
    for (const name of [...NAMES, "CLOUDFLARE_API_TOKEN"])
      expect(push.env?.[name]).toBe(`\${{ secrets.${name} }}`);
    for (const step of job.steps)
      expect(
        step.run ?? "",
        "no ${{ }} expression inside a script",
      ).not.toMatch(/\$\{\{/);
    // The only `${{ secrets.… }}` in the file are those env entries.
    expect(RAW.match(/\$\{\{\s*secrets\./g)).toHaveLength(NAMES.length + 1);
  });

  it("feeds each value on stdin, discards wrangler's output and echoes names only", () => {
    const run = push.run!;
    for (const name of NAMES) expect(run).toContain(name);
    expect(run).toMatch(
      /printenv "\$NAME" \| npx wrangler secret put "\$NAME" --env "\$TARGET" > \/dev\/null/,
    );
    expect(run).not.toMatch(/set -[a-z]*x/);
    // Every echo prints a fixed label, the target or the NAME arrays — never `${!NAME}`.
    const echoes = run.split("\n").filter((l) => /\becho\b/.test(l));
    expect(echoes.length).toBeGreaterThan(0);
    for (const line of echoes) {
      expect(line).not.toMatch(/\$\{!NAME|printenv|\$PLATFORM_|\$CLOUDFLARE/);
    }
    // The value is never placed in argv: the only use of `${!NAME}` is the emptiness test.
    expect(run.match(/\$\{!NAME/g)).toHaveLength(1);
    expect(run).toMatch(/-z "\$\{!NAME:-\}"/);
  });

  it("pins actions as deploy.yml does", () => {
    const deploy = readFileSync(
      join(HERE, "..", "..", "..", ".github", "workflows", "deploy.yml"),
      "utf8",
    );
    for (const s of job.steps.filter((x) => x.uses))
      expect(deploy).toContain(`uses: ${s.uses}`);
  });
});
