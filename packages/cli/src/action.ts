/**
 * The `polaris-key/publish` GitHub Action (P2-06), as code: `actions/publish/action.yml` runs the
 * esbuild bundle of this CLI (`actions/publish/dist/index.js`) with no arguments, and the bundle's
 * entry (`bin/standalone.ts`) hands control here when it sees the Action's inputs.
 *
 * Inputs arrive as `INPUT_<NAME>` environment variables (GitHub upper-cases the name and keeps
 * hyphens: `INPUT_BASE-URL`, `INPUT_DRY-RUN`). They map one-to-one onto `pkey release publish`'s
 * flags. Outputs (`release-id`, `outcome`) go to `$GITHUB_OUTPUT`; a failure is an `::error::`
 * annotation and a non-zero exit, so a refused publish fails the job.
 */

import { appendFile } from "node:fs/promises";
import type { Out } from "./ci.js";
import type { CiEnv } from "./oidc.js";
import { publishRelease, type PublishSource } from "./publish.js";

/** The Action's inputs, in `action.yml` order. */
export const ACTION_INPUTS = [
  "product",
  "deliverable",
  "version",
  "tag",
  "channel",
  "dir",
  "source",
  "meta",
  "base-url",
  "release-key",
  "min-supported-seq",
  "dry-run",
] as const;

/** One input's value, or undefined when empty (GitHub passes an unset input as ""). */
export function actionInput(env: CiEnv, name: string): string | undefined {
  const value = env[`INPUT_${name.toUpperCase()}`]?.trim();
  return value ? value : undefined;
}

/** True when the bundle was started by the Action runner rather than as a CLI. */
export function isActionInvocation(
  argv: readonly string[],
  env: CiEnv,
): boolean {
  return (
    argv.length === 0 &&
    env.GITHUB_ACTIONS === "true" &&
    env.INPUT_PRODUCT !== undefined
  );
}

export interface ActionIo {
  env: CiEnv;
  cwd: string;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Workflow-command escaping for an annotation's message (`%`, CR and LF). */
function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export async function runAction(io: ActionIo): Promise<number> {
  const input = (name: (typeof ACTION_INPUTS)[number]) =>
    actionInput(io.env, name);
  try {
    const product = input("product");
    const dir = input("dir");
    if (!product) throw new Error("The product input is required.");
    if (!dir) throw new Error("The dir input is required.");
    const dryRun = input("dry-run");
    if (dryRun !== undefined && dryRun !== "true" && dryRun !== "false")
      throw new Error(
        `dry-run must be true or false (got ${JSON.stringify(dryRun)}).`,
      );
    const result = await publishRelease({
      cwd: io.cwd,
      product,
      dir,
      deliverable: input("deliverable"),
      version: input("version"),
      tag: input("tag"),
      channel: input("channel"),
      source: input("source") as PublishSource | undefined,
      meta: input("meta"),
      baseUrl: input("base-url"),
      // P3-03: the release key's PKCS#8 PEM, from a GitHub Environment secret. Read here, never
      // echoed; absent, PKEY_RELEASE_KEY from the job's environment is used.
      ...(input("release-key") ? { releaseKeyPem: input("release-key") } : {}),
      ...(input("min-supported-seq") !== undefined
        ? { minSupportedSeq: Number(input("min-supported-seq")) }
        : {}),
      dryRun: dryRun === "true",
      env: io.env,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: io.fetchImpl,
      sleep: io.sleep,
    });
    const outputFile = io.env.GITHUB_OUTPUT;
    if (outputFile) {
      const outcome =
        typeof result.server?.outcome === "string" ? result.server.outcome : "";
      await appendFile(
        outputFile,
        `release-id=${result.releaseId}\noutcome=${outcome}\n`,
        "utf8",
      );
    }
    return 0;
  } catch (e) {
    io.stdout.write(
      `::error title=pkey release publish::${escapeData((e as Error).message)}\n`,
    );
    io.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
}
