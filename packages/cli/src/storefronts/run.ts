/**
 * Running CI-plane store steps (A-18h; notes/S-15 §6.2, §6.3). One step is one vendor CLI command
 * that the store's allow-list admits. For each step, in order:
 *
 *   1. the allow-list check (`allowList.ts`), with the outlet identity for bound parameters, and
 *      the declared file checks (a Steam build script's `setlive` names a named branch);
 *   2. report-back `pending` (`POST /<p>/distribution/report`, `type: "store-step"`): the Worker
 *      re-checks the command, opens the step's `store_operations` row (`plane = 'ci'`) and may
 *      refuse it (msstore while a Worker-staged draft exists). A step already done in this run is
 *      answered `replayed` and skipped, so a re-run attempt does not push twice;
 *   3. the tool, spawned WITHOUT a shell, its output passed through; credentials reach it through
 *      the job's environment (`BUTLER_API_KEY`, `SNAPCRAFT_STORE_CREDENTIALS`), never argv;
 *   4. report-back `done` or `failed` with the exit code. A failed step stops the plan.
 *
 * `--no-report` skips 2 and 4 (no ledger row); a command guarded by the ledger
 * (`unlessWorkerStaged`) then refuses to run. `--dry-run` runs 1 and prints each command line.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ciClient,
  CiRequestError,
  type CiClient,
  type Out,
  type Sleep,
} from "../ci.js";
import { resolveCiToken, type CiEnv } from "../oidc.js";
import {
  checkCiCommand,
  ciParamValue,
  ciStore,
  refusalMessage,
} from "./allowList.js";
import type { StepOutlet } from "./outlets.js";
import type { CiFileCheck } from "./types.js";

export interface StoreStep {
  /** The CI-plane store (`itch`, `snap`, `steam`, `msstore`, `epic`). */
  store: string;
  /** The storefront operation (`uploadBuild`, `release`, `writeListingText`). */
  op: string;
  /** The allow-list's command id. */
  command: string;
  tool: string;
  /** The tool's arguments, the tool excluded. */
  argv: string[];
  /** The outlet whose identity binds the step's parameters. */
  outlet?: StepOutlet;
}

export type SpawnTool = (
  tool: string,
  argv: readonly string[],
  cwd: string,
) => Promise<number>;

export interface RunStepsOptions {
  cwd: string;
  product: string;
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  dryRun?: boolean;
  /** False: run without report-back (no ledger row). Default true. */
  report?: boolean;
  /** The binary to run instead of the tool's name on PATH (`--tool-path`). */
  toolPath?: string;
  /** The test seam for the vendor tool. */
  spawnTool?: SpawnTool;
}

export interface StepOutcome {
  step: StoreStep;
  outcome: "ran" | "skipped" | "dry-run";
  exitCode: number | null;
}

/** POSIX-shell quoting, for printing a command line a person can copy. */
export function commandLine(tool: string, argv: readonly string[]): string {
  const q = (s: string) =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
  return [tool, ...argv].map(q).join(" ");
}

/** The run id a step is reported under: the GitHub job attempt, else `PKEY_RUN_ID`, else fresh. */
export function stepRunId(env: CiEnv): string {
  const id = env.GITHUB_RUN_ID;
  if (id && /^[0-9]{1,20}$/.test(id))
    return `gh-${id}-${/^[0-9]{1,6}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ? env.GITHUB_RUN_ATTEMPT : "1"}`;
  const own = env.PKEY_RUN_ID;
  if (own && /^[A-Za-z0-9-]{8,128}$/.test(own)) return own;
  return randomUUID();
}

/** The run's URL on GitHub, when the job is an Actions job. */
export function stepRunUrl(env: CiEnv): string | undefined {
  const {
    GITHUB_SERVER_URL: server,
    GITHUB_REPOSITORY: repo,
    GITHUB_RUN_ID: id,
  } = env;
  if (!server || !repo || !id || !server.startsWith("https://"))
    return undefined;
  return `${server}/${repo}/actions/runs/${id}`;
}

/** Throws unless the step is a command its store's allow-list admits. */
export function checkStep(step: StoreStep): void {
  const store = ciStore(step.store);
  if (!store) throw new Error(`${step.store} is not a CI-plane store.`);
  if (store.list.tool !== step.tool)
    throw new Error(`${step.store} runs ${store.list.tool}, not ${step.tool}.`);
  const refusal = checkCiCommand(
    store.list,
    step.command,
    step.argv,
    step.outlet?.identity,
  );
  if (refusal)
    throw new Error(refusalMessage(store, step.command, step.argv, refusal));
}

/**
 * Splits a Valve KeyValues (VDF) text into its tokens the way Steam reads it: quoted strings (with
 * or without backslash escapes, since parsers differ), unquoted runs, and the braces; `//` comments
 * are dropped.
 */
function vdfTokens(vdf: string, escapes: boolean): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < vdf.length) {
    const c = vdf[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && vdf[i + 1] === "/") {
      while (i < vdf.length && vdf[i] !== "\n") i++;
    } else if (c === "{" || c === "}") {
      tokens.push(c);
      i++;
    } else if (c === '"') {
      let value = "";
      i++;
      while (i < vdf.length && vdf[i] !== '"') {
        if (escapes && vdf[i] === "\\" && i + 1 < vdf.length) i++;
        value += vdf[i];
        i++;
      }
      i++;
      tokens.push(value);
    } else {
      let value = "";
      while (i < vdf.length && !/[\s{}"]/.test(vdf[i]!)) value += vdf[i++];
      tokens.push(value);
    }
  }
  return tokens;
}

/**
 * The `steam-vdf-setlive-named` check: every `setlive` in a SteamPipe app build script names a
 * branch, and never `default` or `public` (owner decision 5: a person promotes the default branch
 * in Steamworks). An empty value sets nothing live. Keys and values may be quoted or not, as
 * KeyValues allows; a script that pulls in another file (`#include`, `#base`) is refused, because
 * the included file is never checked.
 */
export function vdfSetliveProblem(vdf: string): string | null {
  // Read the script both ways a KeyValues parser may treat backslashes, and refuse if either
  // reading sets a protected branch live.
  for (const escapes of [true, false]) {
    const problem = setliveTokensProblem(vdfTokens(vdf, escapes));
    if (problem) return problem;
  }
  // Belt and braces for parser differences the tokenizer does not model (a comment inside an
  // unquoted token, say): `setlive` followed by a protected branch name with only quotes,
  // whitespace or backslashes between them is refused outright.
  const raw = /setlive[\s"\\]*(default|public)(?=["\s{}\\]|$)/i.exec(vdf);
  if (raw)
    return `sets the build live on the ${raw[1]!.toLowerCase()} branch, which only a person does in Steamworks`;
  return null;
}

function setliveTokensProblem(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.trim().toLowerCase();
    if (token === "#include" || token === "#base")
      return `pulls in another file with ${token}, which this check cannot follow; inline it`;
    if (token !== "setlive") continue;
    const value = tokens[i + 1];
    if (value === undefined || value === "{" || value === "}")
      return "has a setlive key without a branch name";
    const branch = value.trim().toLowerCase();
    if (branch === "default" || branch === "public")
      return `sets the build live on the ${branch} branch, which only a person does in Steamworks`;
    i++;
  }
  return null;
}

async function runFileChecks(step: StoreStep, cwd: string): Promise<void> {
  const store = ciStore(step.store)!;
  const rule = store.list.commands[step.command]!;
  for (const fc of rule.fileChecks ?? []) {
    const file = ciParamValue(store.list, step.command, step.argv, fc.param);
    if (file === undefined) continue;
    const check: CiFileCheck = fc.check;
    if (check === "steam-vdf-setlive-named") {
      const problem = vdfSetliveProblem(
        await readFile(path.resolve(cwd, file), "utf8"),
      );
      if (problem)
        throw new Error(
          `Refused by the CI allow-list: ${file} ${problem}. Set setlive to a named branch, or leave it empty.`,
        );
    }
  }
}

/**
 * The vendor tool's environment: the job's, minus the Polaris Key CI token and the GitHub OIDC
 * request variables, which no vendor tool needs.
 */
export function toolEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env))
    if (!k.startsWith("PKEY_") && !k.startsWith("ACTIONS_ID_TOKEN_"))
      out[k] = v;
  return out;
}

const defaultSpawn: SpawnTool = (tool, argv, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(tool, [...argv], {
      cwd,
      env: toolEnv(process.env),
      stdio: "inherit",
      shell: false,
    });
    child.on("error", (e) =>
      reject(
        new Error(`Could not start ${tool}: ${e.message}. Is it on PATH?`),
      ),
    );
    child.on("close", (code) => resolve(code ?? -1));
  });

interface ReportedStep {
  step: { opId: string; state: string; replayed: boolean };
}

/**
 * `--tool-path` names where the declared tool lives, never another binary: its file name, less a
 * `.exe`, `.sh`, `.cmd` or `.bat` extension, must be the tool's (`steamcmd.sh` for steamcmd).
 */
export function checkToolPath(toolPath: string, tool: string): void {
  const base = path
    .basename(toolPath.replace(/\\/g, "/"))
    .replace(/\.(exe|sh|cmd|bat)$/i, "");
  if (base.toLowerCase() !== tool.toLowerCase())
    throw new Error(
      `--tool-path must point at ${tool} itself, not ${path.basename(toolPath)}.`,
    );
}

/** Run the steps in order; throws on the first refusal or failure. */
export async function runStoreSteps(
  steps: readonly StoreStep[],
  o: RunStepsOptions,
): Promise<StepOutcome[]> {
  for (const step of steps) checkStep(step);
  if (o.toolPath !== undefined)
    for (const step of steps) checkToolPath(o.toolPath, step.tool);
  for (const step of steps) await runFileChecks(step, o.cwd);
  const report = o.report !== false;
  if (!report)
    for (const step of steps)
      if (ciStore(step.store)!.list.commands[step.command]!.unlessWorkerStaged)
        throw new Error(
          `${step.tool} ${step.command} needs report-back: the Worker checks the ledger for a draft the console staged before it may run. Drop --no-report.`,
        );
  if (o.dryRun) {
    for (const step of steps)
      o.stdout.write(
        `Would run: ${commandLine(o.toolPath ?? step.tool, step.argv)}\n`,
      );
    return steps.map((step) => ({ step, outcome: "dry-run", exitCode: null }));
  }
  let client: CiClient | null = null;
  if (report) {
    const token = await resolveCiToken({
      baseUrl: o.baseUrl,
      product: o.product,
      env: o.env,
      out: o.stdout,
      log: o.stderr,
      fetchImpl: o.fetchImpl,
      sleep: o.sleep,
    });
    client = ciClient({
      baseUrl: o.baseUrl,
      product: o.product,
      token,
      fetchImpl: o.fetchImpl,
      sleep: o.sleep,
      log: o.stderr,
    });
  }
  const runId = stepRunId(o.env);
  const runUrl = stepRunUrl(o.env);
  const spawnTool = o.spawnTool ?? defaultSpawn;
  const outcomes: StepOutcome[] = [];
  for (const step of steps) {
    const body = (state: string, exitCode?: number) => ({
      type: "store-step",
      store: step.store,
      op: step.op,
      command: step.command,
      argv: step.argv,
      ...(step.outlet ? { outlet: step.outlet.id } : {}),
      runId,
      state,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(runUrl ? { runUrl } : {}),
    });
    const line = commandLine(o.toolPath ?? step.tool, step.argv);
    if (client) {
      let opened: ReportedStep;
      try {
        opened = await client.postJson<ReportedStep>("distribution/report", {
          what: `Opening the ${step.store} step ${step.command}`,
          body: body("pending"),
        });
      } catch (e) {
        if (e instanceof CiRequestError && e.reason === "worker_draft_staged")
          throw new Error(`${e.message}\nNothing ran: ${line}`);
        throw e;
      }
      if (opened.step.replayed) {
        o.stdout.write(`Already done in this run, skipped: ${line}\n`);
        outcomes.push({ step, outcome: "skipped", exitCode: 0 });
        continue;
      }
    }
    o.stdout.write(`Running: ${line}\n`);
    let exitCode: number;
    try {
      exitCode = await spawnTool(o.toolPath ?? step.tool, step.argv, o.cwd);
    } catch (e) {
      // The spawn error is the one that matters: a failing report-back must not replace it.
      if (client)
        await client
          .postJson("distribution/report", {
            what: `Reporting the ${step.store} step ${step.command}`,
            body: body("failed", -1),
          })
          .catch(() => undefined);
      throw e;
    }
    if (client)
      await client.postJson("distribution/report", {
        what: `Reporting the ${step.store} step ${step.command}`,
        body: exitCode === 0 ? body("done", 0) : body("failed", exitCode),
      });
    outcomes.push({ step, outcome: "ran", exitCode });
    if (exitCode !== 0)
      throw new Error(`${step.tool} exited ${exitCode}: ${line}`);
  }
  return outcomes;
}
