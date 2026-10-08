/**
 * Running PR-plane steps (A-18i; notes/S-15 §4.4, §6.3). `pkey storefront <store> pr` opens one
 * pull request for the channel's newest release; `pkey storefront <store> status` is its verifier.
 * For a pull request, in order:
 *
 *   1. read the generator's inputs from Polaris Key (`GET /<p>/distribution/pr/<store>`) and
 *      generate the files (`winget.ts`, `homebrew.ts`, `scoop.ts`, `flathub.ts`);
 *   2. the PR plane's checks (`prPlane.ts`): the step's argv is the store's `pull-request` command
 *      for the outlet identity (the repository is a literal or the identity's tap, bucket or app
 *      id), and every file is a path the store's templates allow;
 *   3. the natural key (S-15 §6.3): an open or merged PR for (package, version) on GitHub is the
 *      step, already done; it is reported `done` with `existing: true` and nothing is written;
 *   4. report-back `pending`, which opens the `store_operations` row (`plane = 'pr'`);
 *   5. one commit on a `pkey/…` branch (in the token account's fork for winget, in the repository
 *      itself otherwise) and the pull request; nothing is merged, closed, deleted or force-pushed;
 *   6. report-back `done` with the files (path and SHA-256) and the pull request, or `failed`.
 *
 * `--dry-run` runs 1 and 2 and prints the plan (`--out <dir>` also writes the files there).
 * `--no-report` skips the report-back (no ledger row).
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ciClient, type CiClient, type Out, type Sleep } from "../ci.js";
import { resolveCiToken, type CiEnv } from "../oidc.js";
import { untrusted } from "../untrusted.js";
import {
  flathubAppId,
  generateFlathubSkeleton,
  generateMetainfo,
  updateFlathubManifest,
  type FlathubOptions,
} from "./flathub.js";
import { githubClient, type GitHubClient, type GitHubPull } from "./github.js";
import { generateCask, type HomebrewOptions } from "./homebrew.js";
import {
  fetchPrInputs,
  needRelease,
  type GeneratedFile,
  type PrInputs,
} from "./prInputs.js";
import {
  checkPrCommand,
  checkPrPaths,
  prNaturalKey,
  prStore,
  prVerdict,
  type PrVerdict,
} from "./prPlane.js";
import { commandLine, stepRunId, stepRunUrl } from "./run.js";
import { generateScoop, scoopApp, type ScoopOptions } from "./scoop.js";
import type { PrPlaneStore } from "./types.js";
import {
  generateWinget,
  wingetPackageDir,
  type WingetOptions,
} from "./winget.js";

/** The environment variable that holds the GitHub token (a CI environment secret). */
export const PR_TOKEN_ENV = "PKEY_PR_TOKEN";

export type PrGeneratorOptions = WingetOptions &
  HomebrewOptions &
  ScoopOptions &
  FlathubOptions;

export interface PrStepOptions {
  store: string;
  product: string;
  channel: string;
  outlet?: string;
  /** `status` only: the version whose pull request to read (default: the channel's newest). */
  version?: string;
  generator: PrGeneratorOptions;
  baseUrl?: string;
  env: CiEnv & { PKEY_PR_TOKEN?: string };
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  /** The GitHub API's fetch (tests); defaults to `fetchImpl`. */
  githubFetch?: typeof fetch;
  githubApi?: string;
  sleep?: Sleep;
  dryRun?: boolean;
  report?: boolean;
  /** `--dry-run --out <dir>`: write the generated files under this directory. */
  outDir?: string;
  cwd: string;
}

/** What a pull request for one store's release is. */
export interface PrPlan {
  store: PrPlaneStore;
  repo: string;
  /** The `pull-request` argv (the pseudo-tool `github` excluded). */
  argv: string[];
  version: string;
  branch: string;
  title: string;
  /** winget: the title phrase any PR for this version carries (`<id> version <v>`). */
  titlePhrase: string | null;
  files: GeneratedFile[];
  warnings: string[];
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function identityString(i: PrInputs, field: string): string {
  const v = i.outlet.identity[field];
  if (typeof v !== "string" || !v)
    throw new Error(
      `The ${i.outlet.id} outlet declares no ${field} in .pkey/distribution.`,
    );
  return v;
}

/** The argv of `command` (`pull-request` or `status`) for the inputs' outlet and `version`. */
export function prArgv(
  store: PrPlaneStore,
  i: PrInputs,
  command: "pull-request" | "status",
  version: string,
  o: PrGeneratorOptions = {},
): string[] {
  switch (store.store) {
    case "winget":
      return [
        command,
        "--repo",
        "microsoft/winget-pkgs",
        "--package",
        identityString(i, "packageIdentifier"),
        "--version",
        version,
      ];
    case "homebrew":
      return [
        command,
        "--repo",
        identityString(i, "homebrewTap"),
        "--cask",
        identityString(i, "homebrewCask"),
        "--version",
        version,
      ];
    case "scoop":
      return [
        command,
        "--repo",
        identityString(i, "scoopBucket"),
        "--app",
        scoopApp(i, o),
        "--version",
        version,
      ];
    case "flathub":
      return [
        command,
        "--repo",
        `flathub/${flathubAppId(i)}`,
        "--version",
        version,
      ];
    default:
      throw new Error(`${store.store} is not a PR-plane store.`);
  }
}

/**
 * The plan for the inputs' release. Flathub reads the app repository's current manifest through
 * `gh` (it updates that manifest rather than replacing it); the other stores need no GitHub read.
 */
export async function planPr(
  store: PrPlaneStore,
  i: PrInputs,
  o: PrGeneratorOptions,
  gh: GitHubClient | null,
): Promise<PrPlan> {
  const version = needRelease(i).version;
  const argv = prArgv(store, i, "pull-request", version, o);
  const repo = argv[2]!;
  let files: GeneratedFile[];
  let warnings: string[] = [];
  let title: string;
  let branch: string;
  let titlePhrase: string | null = null;
  switch (store.store) {
    case "winget": {
      const id = argv[4]!;
      files = generateWinget(i, o);
      titlePhrase = `${id} version ${version}`;
      title = `New version: ${titlePhrase}`;
      branch = `pkey/${id}-${version}`;
      break;
    }
    case "homebrew": {
      const cask = argv[4]!;
      files = [generateCask(i, o)];
      title = `${cask} ${version}`;
      branch = `pkey/${cask}-${version}`;
      break;
    }
    case "scoop": {
      const app = argv[4]!;
      files = [generateScoop(i, o)];
      title = `${app}: Update to version ${version}`;
      branch = `pkey/${app}-${version}`;
      break;
    }
    default: {
      const appId = flathubAppId(i);
      const meta = generateMetainfo(i, o);
      warnings = meta.warnings;
      files = [meta.file];
      if (gh) {
        const base = await gh.defaultBranch(repo);
        let found = false;
        for (const name of [`${appId}.yml`, `${appId}.yaml`, `${appId}.json`]) {
          const text = await gh.fileText(repo, name, base);
          if (text === null) continue;
          files.unshift({
            path: name,
            content: updateFlathubManifest(text, name, i),
          });
          found = true;
          break;
        }
        if (!found)
          throw new Error(
            `${repo} has no ${appId}.yml, .yaml or .json manifest: the first submission is a person's (pkey storefront flathub init writes its files).`,
          );
      } else
        warnings.push(
          "the manifest update is planned against the app repository, which a dry run without PKEY_PR_TOKEN does not read; only the MetaInfo is shown",
        );
      title = `Update to ${version}`;
      branch = `pkey/${version}`;
    }
  }
  return {
    store,
    repo,
    argv,
    version,
    branch,
    title,
    titlePhrase,
    files,
    warnings,
  };
}

/** The open or merged pull request that already is this (package, version), or null. */
export async function existingPull(
  gh: GitHubClient,
  plan: PrPlan,
  headOwner: string,
): Promise<GitHubPull | null> {
  const candidates = [
    ...(await gh.pullsFromHead(plan.repo, `${headOwner}:${plan.branch}`)),
    ...(plan.titlePhrase
      ? await gh.pullsByTitle(plan.repo, plan.titlePhrase)
      : []),
  ];
  return (
    candidates.find((p) => p.state === "open") ??
    candidates.find((p) => p.merged) ??
    null
  );
}

function reportPull(p: GitHubPull) {
  return {
    number: p.number,
    url: p.url,
    state: p.state,
    merged: p.merged,
    labels: p.labels,
  };
}

interface Reporter {
  post(
    body: Record<string, unknown>,
    what: string,
  ): Promise<{ step: { replayed: boolean; verdict?: PrVerdict } }>;
}

async function reporter(o: PrStepOptions): Promise<Reporter | null> {
  if (o.report === false) return null;
  const token = await resolveCiToken({
    baseUrl: o.baseUrl,
    product: o.product,
    env: o.env,
    out: o.stdout,
    log: o.stderr,
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
  const client = ciClient({
    baseUrl: o.baseUrl,
    product: o.product,
    token,
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
    log: o.stderr,
    env: o.env,
  });
  return {
    post: (body, what) =>
      client.postJson("distribution/report", { what, body }),
  };
}

async function inputsClient(o: PrStepOptions): Promise<CiClient> {
  const token = await resolveCiToken({
    baseUrl: o.baseUrl,
    product: o.product,
    env: o.env,
    out: o.stdout,
    log: o.stderr,
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
  return ciClient({
    baseUrl: o.baseUrl,
    product: o.product,
    token,
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
    log: o.stderr,
    env: o.env,
  });
}

function needStore(id: string): PrPlaneStore {
  const s = prStore(id);
  if (!s) throw new Error(`${id} is not a PR-plane store.`);
  return s;
}

function gitHub(o: PrStepOptions, required: boolean): GitHubClient | null {
  const token = o.env.PKEY_PR_TOKEN;
  if (!token && required)
    throw new Error(
      `${PR_TOKEN_ENV} is not set: the GitHub token that opens the pull request is a CI environment secret (decision 7).`,
    );
  return githubClient({
    ...(token ? { token } : {}),
    fetchImpl: o.githubFetch ?? o.fetchImpl,
    sleep: o.sleep,
    ...(o.githubApi ? { apiBase: o.githubApi } : {}),
  });
}

export interface PrStepOutcome {
  outcome: "opened" | "existing" | "unchanged" | "dry-run" | "skipped";
  plan: PrPlan;
  pr: GitHubPull | null;
  verdict: PrVerdict | null;
}

/** `pkey storefront <store> pr`. */
export async function runPrStep(o: PrStepOptions): Promise<PrStepOutcome> {
  const store = needStore(o.store);
  const inputs = await fetchPrInputs(
    await inputsClient(o),
    store.store,
    o.channel,
    o.outlet,
  );
  const gh = gitHub(o, !o.dryRun);
  const canRead = Boolean(o.env.PKEY_PR_TOKEN) || !o.dryRun;
  const plan = await planPr(store, inputs, o.generator, canRead ? gh : null);
  checkPrCommand(store, "pull-request", plan.argv, inputs.outlet.identity);
  checkPrPaths(
    store,
    plan.argv,
    plan.files.map((f) => f.path),
  );
  // The plan is built from the server's inputs and GitHub's answers: what it shows is cleaned.
  const u = (v: unknown) => untrusted(v, o.env);
  for (const w of plan.warnings) o.stderr.write(`warning: ${u(w)}\n`);
  const line = u(commandLine(store.list.tool, plan.argv));

  if (o.dryRun) {
    o.stdout.write(
      `Would open: ${line}\n  ${u(plan.title)} (${u(plan.repo)}, branch ${u(plan.branch)})\n`,
    );
    for (const f of plan.files)
      o.stdout.write(
        `  ${u(f.path)} (${Buffer.byteLength(f.content)} bytes)\n`,
      );
    if (o.outDir) {
      for (const f of plan.files) {
        const target = path.resolve(o.cwd, o.outDir, f.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, f.content, "utf8");
      }
      o.stdout.write(`Wrote ${plan.files.length} file(s) under ${o.outDir}.\n`);
    }
    return { outcome: "dry-run", plan, pr: null, verdict: null };
  }

  const github = gh!;
  const headOwner = store.fork
    ? await github.login()
    : plan.repo.split("/")[0]!;
  const rep = await reporter(o);
  const runId = stepRunId(o.env);
  const runUrl = stepRunUrl(o.env);
  const body = (state: string, extra: Record<string, unknown> = {}) => ({
    type: "store-step",
    store: store.store,
    op: "release",
    command: "pull-request",
    argv: plan.argv,
    outlet: inputs.outlet.id,
    runId,
    state,
    ...(runUrl ? { runUrl } : {}),
    ...extra,
  });
  const key = prNaturalKey(store, "pull-request", plan.argv);

  const existing = await existingPull(github, plan, headOwner);
  if (existing) {
    o.stdout.write(
      `A pull request for ${u(key)} is already ${existing.merged ? "merged" : "open"}: ${u(existing.url)}\n`,
    );
    if (rep) {
      const opened = await rep.post(
        body("pending"),
        `Opening the ${store.store} step pull-request`,
      );
      if (!opened.step.replayed)
        await rep.post(
          body("done", {
            exitCode: 0,
            existing: true,
            pr: reportPull(existing),
          }),
          `Reporting the ${store.store} step pull-request`,
        );
    }
    return {
      outcome: "existing",
      plan,
      pr: existing,
      verdict: prVerdict(store, existing),
    };
  }

  const baseBranch = await github.defaultBranch(plan.repo);
  if (!store.fork) {
    let same = true;
    for (const f of plan.files)
      if (
        (await github.fileText(plan.repo, f.path, baseBranch)) !== f.content
      ) {
        same = false;
        break;
      }
    if (same) {
      o.stdout.write(
        `${u(plan.repo)} already carries ${u(plan.version)} on ${u(baseBranch)}: nothing to open.\n`,
      );
      return { outcome: "unchanged", plan, pr: null, verdict: null };
    }
  } else if (store.store === "winget") {
    const id = plan.argv[4]!;
    if (!(await github.exists(plan.repo, wingetPackageDir(id), baseBranch)))
      plan.title = `New package: ${plan.titlePhrase}`;
  }

  if (rep) {
    const opened = await rep.post(
      body("pending"),
      `Opening the ${store.store} step pull-request`,
    );
    if (opened.step.replayed) {
      o.stdout.write(`Already done in this run, skipped: ${line}\n`);
      return { outcome: "skipped", plan, pr: null, verdict: null };
    }
  }
  o.stdout.write(`Opening: ${line}\n`);
  let pr: GitHubPull;
  try {
    const headRepo = store.fork ? await github.fork(plan.repo) : plan.repo;
    const baseSha = await github.refSha(plan.repo, baseBranch);
    if (!baseSha) throw new Error(`${plan.repo} has no ${baseBranch} branch.`);
    if (store.fork) await github.syncFork(headRepo, baseBranch);
    const message = `${plan.title}\n\nCreated with Polaris Key (pkey storefront ${store.store} pr).`;
    const branchSha = await github.refSha(headRepo, plan.branch);
    if (branchSha) {
      // A branch left by an earlier attempt with no pull request: one more commit on top of it.
      const sha = await github.commit(headRepo, branchSha, plan.files, message);
      await github.advanceBranch(headRepo, plan.branch, sha);
    } else {
      const sha = await github.commit(headRepo, baseSha, plan.files, message);
      await github.createBranch(headRepo, plan.branch, sha);
    }
    pr = await github.openPull(plan.repo, {
      title: plan.title,
      head: store.fork
        ? `${headRepo.split("/")[0]}:${plan.branch}`
        : plan.branch,
      base: baseBranch,
      body: [
        `${plan.title}, from the ${inputs.channel} channel's release ${plan.version}.`,
        "",
        `Created with Polaris Key (\`pkey storefront ${store.store} pr\`).`,
        ...(store.store === "winget"
          ? ["", "Every version is validated and then reviewed by a moderator."]
          : []),
      ].join("\n"),
    });
  } catch (e) {
    if (rep)
      await rep.post(
        body("failed", { exitCode: 1 }),
        `Reporting the ${store.store} step pull-request`,
      );
    throw e;
  }
  if (rep)
    await rep.post(
      body("done", {
        exitCode: 0,
        files: plan.files.map((f) => ({
          path: f.path,
          sha256: sha256(f.content),
        })),
        pr: reportPull(pr),
      }),
      `Reporting the ${store.store} step pull-request`,
    );
  o.stdout.write(`Opened ${u(pr.url)}\n`);
  return { outcome: "opened", plan, pr, verdict: prVerdict(store, pr) };
}

/** `pkey storefront <store> status`: the verifier, through the public GitHub API. */
export async function runPrStatus(
  o: PrStepOptions,
): Promise<PrStepOutcome & { verdict: PrVerdict }> {
  const store = needStore(o.store);
  const inputs = await fetchPrInputs(
    await inputsClient(o),
    store.store,
    o.channel,
    o.outlet,
  );
  const version = o.version ?? needRelease(inputs).version;
  const argv = prArgv(store, inputs, "status", version, o.generator);
  checkPrCommand(store, "status", argv, inputs.outlet.identity);
  const gh = gitHub(o, false)!;
  const repo = argv[2]!;
  const key = prNaturalKey(store, "status", argv);
  const pkg = argv[4] ?? "";
  const branch =
    store.store === "flathub" ? `pkey/${version}` : `pkey/${pkg}-${version}`;
  const headOwner = store.fork
    ? o.env.PKEY_PR_TOKEN
      ? await gh.login()
      : null
    : repo.split("/")[0]!;
  const candidates = [
    ...(headOwner
      ? await gh.pullsFromHead(repo, `${headOwner}:${branch}`)
      : []),
    ...(store.store === "winget"
      ? await gh.pullsByTitle(repo, `${pkg} version ${version}`)
      : []),
  ];
  const pr =
    candidates.find((p) => p.state === "open") ??
    candidates.find((p) => p.merged) ??
    candidates[0] ??
    null;
  if (!pr) throw new Error(`No pull request for ${key} on ${repo}.`);
  const verdict = prVerdict(store, pr);
  // GitHub's answer: the URL starts the line, so it is cleaned like the verdict and each label.
  const u = (v: unknown) => untrusted(v, o.env);
  o.stdout.write(
    `${u(pr.url)}: ${u(verdict)}${pr.labels.length ? ` (${pr.labels.map(u).join(", ")})` : ""}\n`,
  );
  const rep = await reporter(o);
  if (rep)
    await rep.post(
      {
        type: "store-step",
        store: store.store,
        op: "status",
        command: "status",
        argv,
        outlet: inputs.outlet.id,
        runId: stepRunId(o.env),
        state: "done",
        exitCode: 0,
        pr: reportPull(pr),
        ...(stepRunUrl(o.env) ? { runUrl: stepRunUrl(o.env) } : {}),
      },
      `Reporting the ${store.store} verifier`,
    );
  const plan: PrPlan = {
    store,
    repo,
    argv,
    version,
    branch,
    title: pr.title,
    titlePhrase: null,
    files: [],
    warnings: [],
  };
  return { outcome: "existing", plan, pr, verdict };
}

/** `pkey storefront flathub init`: the first submission's files, for a person to open the PR. */
export async function writeFlathubInit(
  o: PrStepOptions & { outDir: string },
): Promise<GeneratedFile[]> {
  const inputs = await fetchPrInputs(
    await inputsClient(o),
    "flathub",
    o.channel,
    o.outlet,
  );
  const { files, warnings } = generateFlathubSkeleton(inputs, o.generator);
  const u = (v: unknown) => untrusted(v, o.env);
  for (const w of warnings) o.stderr.write(`warning: ${u(w)}\n`);
  for (const f of files) {
    const target = path.resolve(o.cwd, o.outDir, f.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.content, "utf8");
    o.stdout.write(`Wrote ${u(path.join(o.outDir, f.path))}\n`);
  }
  o.stdout.write(
    "Open the first submission by hand: a PR to flathub/flathub against the new-pr branch (https://docs.flathub.org/docs/for-app-authors/submission). Later versions: pkey storefront flathub pr, or Flathub's external-data checker.\n",
  );
  return files;
}
