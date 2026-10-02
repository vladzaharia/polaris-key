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

import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import type { Out } from "./ci.js";
import type { CiEnv } from "./oidc.js";
import { publishRelease, type PublishSource } from "./publish.js";
import { publishPack } from "./packPublish.js";
import { MIN_ZSTD_VERSION, versionAtLeast } from "./packArtifacts.js";

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
  "content-key",
  "delegation",
  "min-supported-seq",
  "content-stamp",
  "embedded",
  "pins",
  "out",
  "bases",
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
  /** The zstd install seam (tests): runs a command, throws on failure. */
  exec?: (cmd: string, args: string[]) => string;
  /** The platform seam (tests); `process.platform` otherwise. */
  platform?: NodeJS.Platform;
}

/** The `pins` input: `<packId>@<version>` entries separated by whitespace or commas. */
export function pinsInput(value: string | undefined): string[] {
  return value ? value.split(/[\s,]+/).filter(Boolean) : [];
}

/**
 * A pack publish needs the zstd CLI at ≥ 1.5.5 (`MIN_ZSTD_VERSION`). GitHub's hosted runners carry
 * it. When it is missing or older on a Linux runner, refresh apt's lists and install it (fixed
 * arguments, no shell); if zstd is still missing or older afterwards (an old distribution's
 * package), fail with the minimum version. Elsewhere, fail with the same message.
 */
export function ensureZstd(
  io: Pick<ActionIo, "exec" | "stdout" | "platform">,
): void {
  const exec =
    io.exec ??
    ((cmd: string, args: string[]) =>
      execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }));
  const version = (): string | null => {
    try {
      return /v(\d+\.\d+\.\d+)/.exec(exec("zstd", ["-V"]))?.[1] ?? null;
    } catch {
      return null;
    }
  };
  const ok = (v: string | null) =>
    v !== null && versionAtLeast(v, MIN_ZSTD_VERSION);
  const found = version();
  if (ok(found)) return;
  const need = `A pack publish needs zstd ≥ ${MIN_ZSTD_VERSION}`;
  if ((io.platform ?? process.platform) !== "linux")
    throw new Error(
      `${need}; ${found ? `this runner has ${found}` : "it is not on PATH"}. Install it before this step (brew install zstd).`,
    );
  io.stdout.write(
    `zstd ${found ? `${found} is older than ${MIN_ZSTD_VERSION}` : "is not on PATH"}; installing it with apt-get\n`,
  );
  try {
    exec("sudo", ["-n", "apt-get", "update", "-q"]);
    exec("sudo", ["-n", "apt-get", "install", "-y", "-q", "zstd"]);
  } catch (e) {
    throw new Error(
      `${need}, and installing it with apt-get failed (${(e as Error).message.split("\n")[0]}). Install it before this step.`,
    );
  }
  const after = version();
  if (!ok(after))
    throw new Error(
      `${need}; apt-get installed ${after ?? "no zstd"}. Use a newer runner image (ubuntu-24.04 or later) or install zstd ≥ ${MIN_ZSTD_VERSION} before this step.`,
    );
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
    const deliverable = input("deliverable");
    const releaseKeyPem = input("release-key");
    // P4-19: a content key and its delegation, exclusive of the release key.
    const contentKeyPem = input("content-key");
    const delegation = input("delegation");
    if (contentKeyPem && releaseKeyPem)
      throw new Error(
        "release-key and content-key are exclusive: a pack release is signed by one or the other.",
      );
    if (
      (contentKeyPem || delegation) &&
      (!deliverable || deliverable === "app")
    )
      throw new Error(
        "content-key and delegation apply only to a pack deliverable: a content key never signs an app record.",
      );
    const minSupportedSeq =
      input("min-supported-seq") !== undefined
        ? Number(input("min-supported-seq"))
        : undefined;
    const given = (names: readonly (typeof ACTION_INPUTS)[number][]) =>
      names.filter((n) => input(n) !== undefined);
    if (deliverable && deliverable !== "app") {
      // P4-03: a pack release. Inputs that only stamp an app release are refused, not ignored.
      const wrong = given(["content-stamp", "embedded", "pins"]);
      if (wrong.length)
        throw new Error(
          `${wrong.join(", ")} ${wrong.length === 1 ? "does" : "do"} not apply to a pack deliverable (${deliverable}): they stamp an app release's packs.`,
        );
      ensureZstd(io);
      const result = await publishPack({
        cwd: io.cwd,
        product,
        dir,
        deliverable,
        version: input("version"),
        tag: input("tag"),
        channel: input("channel"),
        out: input("out"),
        bases: input("bases"),
        baseUrl: input("base-url"),
        ...(releaseKeyPem ? { releaseKeyPem } : {}),
        ...(contentKeyPem ? { contentKeyPem } : {}),
        ...(delegation ? { delegation } : {}),
        ...(minSupportedSeq !== undefined ? { minSupportedSeq } : {}),
        dryRun: dryRun === "true",
        env: io.env,
        stdout: io.stdout,
        stderr: io.stderr,
        fetchImpl: io.fetchImpl,
        sleep: io.sleep,
      });
      await writeOutputs(io, result.releaseId, result.server);
      return 0;
    }
    const wrong = given(["out", "bases"]);
    if (wrong.length)
      throw new Error(
        `${wrong.join(", ")} ${wrong.length === 1 ? "does" : "do"} not apply to the app: they keep and read a pack's earlier releases.`,
      );
    const result = await publishRelease({
      cwd: io.cwd,
      product,
      dir,
      deliverable,
      version: input("version"),
      tag: input("tag"),
      channel: input("channel"),
      source: input("source") as PublishSource | undefined,
      meta: input("meta"),
      baseUrl: input("base-url"),
      // P3-03: the release key's PKCS#8 PEM, from a GitHub Environment secret. Read here, never
      // echoed; absent, PKEY_RELEASE_KEY from the job's environment is used.
      ...(releaseKeyPem ? { releaseKeyPem } : {}),
      ...(minSupportedSeq !== undefined ? { minSupportedSeq } : {}),
      // P4-03: the packs an app release pins and its builds embed.
      contentStamp: input("content-stamp"),
      embedded: input("embedded"),
      pins: pinsInput(input("pins")),
      dryRun: dryRun === "true",
      env: io.env,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: io.fetchImpl,
      sleep: io.sleep,
    });
    await writeOutputs(io, result.releaseId, result.server);
    return 0;
  } catch (e) {
    io.stdout.write(
      `::error title=pkey release publish::${escapeData((e as Error).message)}\n`,
    );
    io.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
}

async function writeOutputs(
  io: ActionIo,
  releaseId: string,
  server: Record<string, unknown> | undefined,
): Promise<void> {
  const outputFile = io.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const outcome = typeof server?.outcome === "string" ? server.outcome : "";
  await appendFile(
    outputFile,
    `release-id=${releaseId}\noutcome=${outcome}\n`,
    "utf8",
  );
}
