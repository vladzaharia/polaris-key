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
import { isPackageDeliverable, publishPackage } from "./package/publish.js";
import { MIN_ZSTD_VERSION, versionAtLeast } from "./packArtifacts.js";
import type { TransportCommon } from "./transport.js";
import { baPackage, baUpload } from "./transportAppleBa.js";
import { padModules, type PadDelivery } from "./transportPlayPad.js";
import { steamVdf } from "./transportSteam.js";

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
  "script-extensions",
  "script-types",
  "dry-run",
  "transport",
  "content-api",
  "variant",
  "transport-out",
  "gradle-project",
  "pad-delivery",
  "steam-depot",
  "steam-branch",
  "steam-setlive",
  "asc-expect-resource",
  "transport-report",
] as const;

/** P5-08: the `transport` input's steps, onto `pkey transport …`. */
export const ACTION_TRANSPORT_STEPS = [
  "apple-ba-package",
  "apple-ba-upload",
  "play-pad-modules",
  "steam-depot-vdf",
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

/** A list input (`script-extensions`, `script-types`): entries separated by whitespace or commas. */
export function listInput(value: string | undefined): string[] {
  return value ? value.split(/[\s,]+/).filter(Boolean) : [];
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
    const transport = input("transport");
    const given0 = (names: readonly (typeof ACTION_INPUTS)[number][]) =>
      names.filter((n) => input(n) !== undefined);
    if (transport !== undefined) {
      await runTransportStep(io, input, given0, product, dir, transport);
      return 0;
    }
    const transportOnly = given0([
      "content-api",
      "variant",
      "transport-out",
      "gradle-project",
      "pad-delivery",
      "steam-depot",
      "steam-branch",
      "steam-setlive",
      "asc-expect-resource",
    ]);
    if (input("transport-report") === "false")
      transportOnly.push("transport-report");
    if (transportOnly.length)
      throw new Error(
        `${transportOnly.join(", ")} ${transportOnly.length === 1 ? "applies" : "apply"} only with the transport input.`,
      );
    const minSupportedSeq =
      input("min-supported-seq") !== undefined
        ? Number(input("min-supported-seq"))
        : undefined;
    const given = (names: readonly (typeof ACTION_INPUTS)[number][]) =>
      names.filter((n) => input(n) !== undefined);
    // F-03: a package release: extracted from dir, never signed, no app or pack inputs.
    if (
      deliverable &&
      deliverable !== "app" &&
      (await isPackageDeliverable(io.cwd, deliverable))
    ) {
      const wrong = given([
        "tag",
        "source",
        "meta",
        "content-stamp",
        "embedded",
        "pins",
        "out",
        "bases",
        "script-extensions",
        "script-types",
        "min-supported-seq",
      ]);
      if (wrong.length || releaseKeyPem || contentKeyPem || delegation)
        throw new Error(
          `${[...wrong, ...(releaseKeyPem ? ["release-key"] : []), ...(contentKeyPem ? ["content-key"] : []), ...(delegation ? ["delegation"] : [])].join(", ")} do not apply to a package deliverable (${deliverable}): a package's files are extracted from dir, and it is never signed.`,
        );
      const result = await publishPackage({
        cwd: io.cwd,
        product,
        dir,
        deliverable,
        version: input("version"),
        channel: input("channel"),
        baseUrl: input("base-url"),
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
    if (deliverable && deliverable !== "app") {
      // P4-03: a pack release. Inputs that only stamp an app release are refused, not ignored.
      const wrong = given(["content-stamp", "embedded", "pins"]);
      const scriptExtensions = listInput(input("script-extensions"));
      const scriptTypes = listInput(input("script-types"));
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
        // P4-28: another script language for the PCK lint.
        ...(scriptExtensions.length ? { scriptExtensions } : {}),
        ...(scriptTypes.length ? { scriptTypes } : {}),
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
    const wrong = given(["out", "bases", "script-extensions", "script-types"]);
    if (wrong.length)
      throw new Error(
        `${wrong.join(", ")} ${wrong.length === 1 ? "does" : "do"} not apply to the app: they keep and read a pack's earlier releases or configure a pack's lint.`,
      );
    const result = await publishRelease({
      cwd: io.cwd,
      product,
      dir,
      deliverable,
      version: input("version"),
      tag: input("tag"),
      channel: input("channel"),
      // `r2` unless set. action.yml gives `source` no `default:`: GitHub passes every defaulted
      // input, so a default there would reach the package and transport paths, which refuse it.
      source: (input("source") ?? "r2") as PublishSource,
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

/**
 * P5-08: one `pkey transport …` step for a pack release the Action published earlier: `dir` is
 * that publish's `out` (for `apple-ba-upload`, the package step's `transport-out`).
 * Publish-only inputs are refused, not ignored.
 */
async function runTransportStep(
  io: ActionIo,
  input: (name: (typeof ACTION_INPUTS)[number]) => string | undefined,
  given: (names: readonly (typeof ACTION_INPUTS)[number][]) => string[],
  product: string,
  dir: string,
  step: string,
): Promise<void> {
  if (!(ACTION_TRANSPORT_STEPS as readonly string[]).includes(step))
    throw new Error(
      `transport must be one of ${ACTION_TRANSPORT_STEPS.join(", ")} (got ${JSON.stringify(step)}).`,
    );
  const deliverable = input("deliverable");
  const version = input("version");
  if (!deliverable || deliverable === "app")
    throw new Error(
      "transport needs a pack deliverable: set deliverable to the pack id.",
    );
  if (!version)
    throw new Error("transport needs version: the pack release to package.");
  const wrong = given([
    "tag",
    "source",
    "meta",
    "release-key",
    "content-key",
    "delegation",
    "min-supported-seq",
    "content-stamp",
    "embedded",
    "pins",
    "out",
    "bases",
    "script-extensions",
    "script-types",
  ]);
  if (wrong.length)
    throw new Error(
      `${wrong.join(", ")} ${wrong.length === 1 ? "does" : "do"} not apply to a transport step (${step}): it packages a release published earlier.`,
    );
  const dryRun = input("dry-run");
  if (dryRun !== undefined && dryRun !== "false")
    throw new Error("dry-run does not apply to a transport step.");
  const report = input("transport-report");
  if (report !== undefined && report !== "true" && report !== "false")
    throw new Error(
      `transport-report must be true or false (got ${JSON.stringify(report)}).`,
    );
  const setlive = input("steam-setlive");
  if (setlive !== undefined && setlive !== "true" && setlive !== "false")
    throw new Error(
      `steam-setlive must be true or false (got ${JSON.stringify(setlive)}).`,
    );
  const common: TransportCommon = {
    cwd: io.cwd,
    deliverable,
    version,
    product,
    baseUrl: input("base-url"),
    env: io.env,
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: io.fetchImpl,
    sleep: io.sleep,
    report: report !== "false",
  };
  const platform = io.platform ?? process.platform;
  switch (step) {
    case "apple-ba-package":
      await baPackage({
        ...common,
        from: dir,
        out: input("transport-out"),
        contentApi: input("content-api"),
        variant: input("variant"),
        platform,
      });
      return;
    case "apple-ba-upload":
      if (input("transport-out") !== undefined)
        throw new Error(
          "apple-ba-upload reads the package step's output from dir; transport-out does not apply.",
        );
      await baUpload({
        ...common,
        dir,
        contentApi: input("content-api"),
        expectResource: input("asc-expect-resource"),
      });
      return;
    case "play-pad-modules": {
      const project = input("gradle-project");
      if (!project)
        throw new Error(
          "play-pad-modules needs gradle-project: the Godot Android Gradle build (android/build).",
        );
      await padModules({
        ...common,
        from: dir,
        project,
        delivery: input("pad-delivery") as PadDelivery | undefined,
        variant: input("variant"),
      });
      return;
    }
    default: {
      const depot = input("steam-depot");
      if (!depot)
        throw new Error(
          "steam-depot-vdf needs steam-depot: the pack's depot id.",
        );
      await steamVdf({
        ...common,
        from: dir,
        depot,
        branch: input("steam-branch"),
        channel: input("channel"),
        setlive: setlive === "true",
        out: input("transport-out"),
        variant: input("variant"),
      });
    }
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
