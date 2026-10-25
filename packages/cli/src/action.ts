/**
 * The `polaris-key/publish` GitHub Action (P2-06, v2 in A-25.5), as code: `actions/publish/action.yml`
 * runs the esbuild bundle of this CLI (`actions/publish/dist/index.js`) with no arguments, and the
 * bundle's entry (`bin/standalone.ts`) hands control here when it sees the Action's inputs.
 *
 * The Action is thin: eight inputs. `command` (default `release publish`) and `args` become one
 * `pkey` argv, run in-process with no shell; `release-key` and `content-key` become
 * `PKEY_RELEASE_KEY` / `PKEY_CONTENT_KEY` in that process's environment, never argv; `base-url`
 * becomes `PKEY_BASE_URL`; `working-directory` is the cwd; `dry-run` appends `--dry-run`.
 * `channels: auto` then runs `pkey channel sync` once after a successful app `release publish`,
 * and `pkey channel sync --deliverable <pack> --from <out>` after a successful pack publish (the
 * Action adds `--out $RUNNER_TEMP/pkey-packs` when the args carry none). A package publish never syncs.
 *
 * Inputs arrive as `INPUT_<NAME>` environment variables (GitHub upper-cases the name and keeps
 * hyphens: `INPUT_BASE-URL`). GitHub forwards undeclared `with:` keys too, so any `INPUT_*` that is
 * not one of the eight fails the step before any network call, naming the flag that replaces it and
 * never echoing its value. A failure is an `::error::` annotation and a non-zero exit.
 *
 * Outputs (`release-id`, `outcome`) are written by `pkey release publish` itself
 * (`actionOutputs.ts`). Server text never becomes a workflow command (`untrusted.ts`).
 */

import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import type { Out } from "./ci.js";
import type { CiEnv } from "./oidc.js";
import { COMMANDS, VALUELESS_FLAGS } from "./help.js";
import { runPkey } from "./index.js";
import { CONTENT_KEY_ENV } from "./delegate.js";
import { RELEASE_KEY_ENV } from "./releaseKeys.js";
import { BASE_URL_ENV } from "./context.js";
import type { TermOut } from "./terminal.js";
import { loadStepProduct } from "./storefronts/outlets.js";
import { escapeData, untrusted, untrustedLines } from "./untrusted.js";

/** The Action's inputs, in `action.yml` order. */
export const ACTION_INPUTS = [
  "command",
  "args",
  "release-key",
  "content-key",
  "base-url",
  "working-directory",
  "dry-run",
  "channels",
] as const;

export type ActionInput = (typeof ACTION_INPUTS)[number];

/** The inputs 0.9 removed, each with the flag that replaces it (the registry's `action` maps). */
export const REMOVED_INPUTS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const c of COMMANDS)
    for (const [input, flag] of Object.entries(c.action ?? {}))
      out[input] ??= flag;
  return out;
})();

/** The step-picking inputs, which have no flag: what replaces each. */
const REMOVED_STEP: Readonly<Record<string, string>> = {
  storefront: "Use channels: auto, or command: storefront <store> <step> …",
  transport: "Use command: transport <step> …, with its flags in args.",
  assets: "Use command: assets push, with the file and --slot in args.",
};

/** One input's value, or undefined when empty (GitHub passes an unset input as ""). */
export function actionInput(env: CiEnv, name: string): string | undefined {
  const value = env[`INPUT_${name.toUpperCase()}`]?.trim();
  return value ? value : undefined;
}

/** True when the bundle was started by the Action runner rather than as a CLI (D-A6). */
export function isActionInvocation(
  argv: readonly string[],
  env: CiEnv,
): boolean {
  return (
    argv.length === 0 &&
    env.GITHUB_ACTIONS === "true" &&
    env.INPUT_COMMAND !== undefined
  );
}

/**
 * Split `args` into words: whitespace and newlines separate, single and double quotes group
 * (and are dropped), nothing else is special. No backslash escapes, no variables, no globbing,
 * no shell. An unterminated quote throws.
 */
export function splitArgs(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote) throw new Error(`args has an unterminated ${quote} quote.`);
  if (started) words.push(word);
  return words;
}

export interface ActionIo {
  env: CiEnv;
  cwd: string;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The line each removed `INPUT_*` earns, from the registry: names only, never a value. */
function refusals(env: CiEnv): string[] {
  const kept = new Set<string>(ACTION_INPUTS);
  const lines: string[] = [];
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith("INPUT_")) continue;
    const name = key.slice("INPUT_".length).toLowerCase();
    if (kept.has(name)) continue;
    const shown = untrusted(name, env);
    const flag = REMOVED_INPUTS[name];
    if (REMOVED_STEP[name])
      lines.push(`Input ${shown} was removed in 0.9. ${REMOVED_STEP[name]}`);
    else if (flag)
      lines.push(
        VALUELESS_FLAGS.has(flag.slice(2))
          ? `Input ${shown} was removed in 0.9. Put ${flag} in args.`
          : `Input ${shown} was removed in 0.9. Put ${flag} <value> in args.`,
      );
    else lines.push(`Input ${shown} is not an input of this Action.`);
  }
  return lines;
}

/** The value of `--name v` or `--name=v` in an argv, if any. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

/** True for `release publish` of the app (no `--deliverable`, or `--deliverable app`). */
function isAppPublish(argv: readonly string[]): boolean {
  if (argv[0] !== "release" || argv[1] !== "publish") return false;
  const deliverable = flagValue(argv, "deliverable");
  return deliverable === undefined || deliverable === "app";
}

/** The sync a successful app publish earns (`channels: auto`); its flags come from the publish's. */
function syncArgv(argv: readonly string[], dryRun: boolean): string[] {
  const out = ["channel", "sync"];
  const version =
    flagValue(argv, "version") ?? flagValue(argv, "tag")?.replace(/^v/, "");
  const forward: [string, string | undefined][] = [
    ["product", flagValue(argv, "product")],
    ["base-url", flagValue(argv, "base-url")],
    ["channel", flagValue(argv, "channel")],
    ["version", version],
    ["dir", flagValue(argv, "dir")],
  ];
  for (const [k, v] of forward) if (v !== undefined) out.push(`--${k}`, v);
  if (dryRun) out.push("--dry-run");
  return out;
}

/** The pack a successful `release publish --deliverable <pack>` published, or undefined. */
async function publishedPack(
  argv: readonly string[],
  cwd: string,
): Promise<string | undefined> {
  if (argv[0] !== "release" || argv[1] !== "publish") return undefined;
  const pack = flagValue(argv, "deliverable");
  if (pack === undefined || pack === "app") return undefined;
  try {
    const product = await loadStepProduct(cwd, flagValue(argv, "product"));
    return product.packs.includes(pack) ? pack : undefined;
  } catch {
    return undefined;
  }
}

/** The sync a successful pack publish earns: that pack's transport rows, from the publish's `--out`. */
function packSyncArgv(
  argv: readonly string[],
  pack: string,
  out: string,
  dryRun: boolean,
): string[] {
  const forward: [string, string | undefined][] = [
    ["product", flagValue(argv, "product")],
    ["base-url", flagValue(argv, "base-url")],
  ];
  const sync = ["channel", "sync", "--deliverable", pack, "--from", out];
  for (const [k, v] of forward) if (v !== undefined) sync.push(`--${k}`, v);
  if (dryRun) sync.push("--dry-run");
  return sync;
}

export async function runAction(io: ActionIo): Promise<number> {
  // The message may carry the server's words: cleaned per line first, so no control character
  // reaches the annotation and no line of it reads as a command, then escaped into one line.
  const annotate = (title: string, message: string) =>
    io.stdout.write(
      `::error title=${escapeData(untrusted(title, io.env))}::${escapeData(untrustedLines(message, io.env))}\n`,
    );
  const fail = (message: string): number => {
    annotate("pkey", message);
    io.stderr.write(`${untrustedLines(message, io.env)}\n`);
    return 1;
  };
  const input = (name: ActionInput) => actionInput(io.env, name);
  const removed = refusals(io.env);
  if (removed.length) return fail(removed.join("\n"));

  let argv: string[];
  let dryRun = false;
  let channelsAuto = false;
  let cwd = io.cwd;
  try {
    const dry = input("dry-run");
    if (dry !== undefined && dry !== "true" && dry !== "false")
      throw new Error("dry-run must be true or false.");
    dryRun = dry === "true";
    const channels = input("channels") ?? "auto";
    if (channels !== "auto" && channels !== "none")
      throw new Error("channels must be auto or none.");
    channelsAuto = channels === "auto";
    argv = [
      ...splitArgs(input("command") ?? "release publish"),
      ...splitArgs(io.env["INPUT_ARGS"] ?? ""),
    ];
    if (!argv.length) throw new Error("command is empty.");
    const wd = input("working-directory");
    if (wd !== undefined) {
      cwd = path.resolve(io.cwd, wd);
      const isDir = await stat(cwd).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (!isDir) throw new Error("working-directory is not a directory.");
    }
  } catch (e) {
    return fail((e as Error).message);
  }
  if (dryRun && !argv.includes("--dry-run")) argv.push("--dry-run");
  // A pack publish syncs from the directory it wrote; without `--out` the Action picks one.
  const pack = channelsAuto ? await publishedPack(argv, cwd) : undefined;
  let packOut: string | undefined;
  if (pack !== undefined) {
    packOut = flagValue(argv, "out");
    if (packOut === undefined) {
      packOut = path.join(
        io.env["RUNNER_TEMP"]?.trim() || os.tmpdir(),
        "pkey-packs",
      );
      argv.push("--out", packOut);
    }
  }

  // Secrets and the origin travel in the in-process environment, never on argv.
  const env: CiEnv = { ...io.env };
  const releaseKey = input("release-key");
  const contentKey = input("content-key");
  const baseUrl = input("base-url");
  if (releaseKey) env[RELEASE_KEY_ENV] = releaseKey;
  if (contentKey) env[CONTENT_KEY_ENV] = contentKey;
  if (baseUrl) env[BASE_URL_ENV] = baseUrl;

  // stderr is forwarded and kept: a failed step's annotation is its last words.
  let errText = "";
  const stderr = {
    write(chunk: string | Uint8Array, ...rest: unknown[]) {
      errText += typeof chunk === "string" ? chunk : Buffer.from(chunk);
      return (io.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest);
    },
    get isTTY() {
      return (io.stderr as { isTTY?: boolean }).isTTY;
    },
    get columns() {
      return (io.stderr as { columns?: number }).columns;
    },
  } as unknown as TermOut;
  const cli = {
    cwd,
    env,
    stdout: io.stdout as TermOut,
    stderr,
    fetchImpl: io.fetchImpl,
    sleep: io.sleep,
  };
  let title = `pkey ${argv
    .filter((w) => !w.startsWith("-"))
    .slice(0, 2)
    .join(" ")}`;
  let code = await runPkey(argv, cli);
  if (code === 0 && channelsAuto && isAppPublish(argv)) {
    errText = "";
    title = "pkey channel sync";
    code = await runPkey(syncArgv(argv, dryRun), cli);
  } else if (code === 0 && pack !== undefined && packOut !== undefined) {
    errText = "";
    title = "pkey channel sync";
    code = await runPkey(packSyncArgv(argv, pack, packOut, dryRun), cli);
  }
  if (code === 0) return 0;
  annotate(
    title,
    errText.trim().slice(-2000) || `pkey exited with code ${code}.`,
  );
  return 1;
}
