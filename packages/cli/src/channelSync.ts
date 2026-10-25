/**
 * `pkey channel sync` (A-25.3): the steps the declared channels have, one row each.
 *
 * The plan reads `.pkey/distribution`: every outlet whose catalogue channel is on the `pr` or `ci`
 * plane, plus F-Droid (feed plane, a CI build step). A row is a step kind with its outlet, or the
 * reason it skips. Kinds so far:
 *
 *   pr           `storefront <store> pr` (prRun.ts): same allow-list, same report into the store ledger
 *   local-files  itch push, snap upload and the F-Droid repository from a build directory (--dir):
 *                the files are matched against `.pkey/release`'s artifacts map as `release publish`
 *                matches them; one itch push per matched platform, one snap upload, one F-Droid
 *                build. `snap metadata` stays a pre-build step, outside sync.
 *
 * P4-33 adds `transport` as one more kind (D-A4). A channel whose credential env is absent is
 * skipped with one line naming it (D-A3); a step that fails fails the command after the rest ran.
 * `--dry-run` runs nothing. No secret value is ever printed: only the variable's name.
 */

import path from "node:path";
import {
  channelForOutlet,
  findChannel,
  type ChannelEntry,
} from "@polaris-key/manifest";
import { cellWidth, wrapSpans, type Line } from "@polaris-key/node/terminal";
import { envelope } from "./account.js";
import type { ChannelArgs, ChannelIo } from "./channel.js";
import {
  SYNC_USAGE,
  manifestFailure,
  termOf,
  unknownOption,
} from "./channel.js";
import { UsageError } from "./errors.js";
import { canRequestGithubOidc, CI_TOKEN_ENV } from "./oidc.js";
import { buildFdroidFeed, DEFAULT_KS_PASS_ENV } from "./feeds.js";
import {
  descriptorManifestOf,
  matchArtifacts,
  scanDir,
  type MatchedBuild,
} from "./publish.js";
import { loadManifest } from "./manifest.js";
import { failLine, type Term, type TermOut } from "./terminal.js";
import { untrusted } from "./untrusted.js";
import { loadStepProduct, type StepOutlet } from "./storefronts/outlets.js";
import {
  FirstSubmissionError,
  PR_TOKEN_ENV,
  runPrStep,
} from "./storefronts/prRun.js";
import { itchPushStep } from "./storefronts/itch.js";
import { runStoreSteps, commandLine } from "./storefronts/run.js";
import { snapUploadStep } from "./storefronts/snap.js";

export type StepKind = "pr" | "local-files";

export type RowState =
  | "planned"
  | "skipped"
  | "opened"
  | "existing"
  | "unchanged"
  | "done"
  | "failed";

/** One channel's step, or the reason it has none. */
export interface SyncRow {
  outlet: string;
  channel: string;
  step: StepKind;
  /** The PR-plane store or CI-plane store the step runs. */
  store: string;
  state: RowState;
  /** The secret's environment variable when it is what the row waits on (never its value). */
  secret?: string;
  reason?: "missing-secret" | "needs-dir" | "no-file" | "first-submission";
  /** local-files: the matched build's platform and its file (absolute). */
  platform?: string;
  file?: string;
  /** `--dry-run` on a local-files row: the checked command line. */
  command?: string;
  url?: string;
  error?: string;
  notes?: string[];
}

export const FDROID_KEYSTORE_ENV = "PKEY_FDROID_KEYSTORE";
export const FDROID_ALIAS_ENV = "PKEY_FDROID_ALIAS";
/** Where the F-Droid repository is written, relative to the working directory. */
export const FDROID_OUT = "fdroid-repo";

/** The credential env each plane's channel needs; the first one unset is the one named. */
const SECRETS: Readonly<Record<string, readonly string[]>> = {
  winget: [PR_TOKEN_ENV],
  homebrew: [PR_TOKEN_ENV],
  scoop: [PR_TOKEN_ENV],
  flathub: [PR_TOKEN_ENV],
  itch: ["BUTLER_API_KEY"],
  snap: ["SNAPCRAFT_STORE_CREDENTIALS"],
  fdroid: [DEFAULT_KS_PASS_ENV, FDROID_KEYSTORE_ENV, FDROID_ALIAS_ENV],
};

/** itch.io's platform word for a release platform. */
const ITCH_PLATFORM: Readonly<Record<string, string>> = {
  windows: "windows",
  linux: "linux",
  macos: "mac",
  android: "android",
};

/** The catalogue channels an outlet serves; a `direct` outlet by the package manager it names. */
function channelsOf(o: StepOutlet): ChannelEntry[] {
  if (o.kind !== "direct") {
    const c = channelForOutlet(o.kind);
    return c ? [c] : [];
  }
  const has = (...f: string[]) => f.some((k) => o.identity[k] !== undefined);
  const out: ChannelEntry[] = [];
  if (has("homebrewCask", "homebrewFormula", "homebrewTap")) {
    const c = channelForOutlet("direct", "homebrew");
    if (c) out.push(c);
  }
  if (has("scoop", "scoopBucket")) {
    const c = channelForOutlet("direct", "scoop");
    if (c) out.push(c);
  }
  return out;
}

export interface PlanOptions {
  dir?: string;
  /** The builds `matchArtifacts` found under `dir`; only read when `dir` is set. */
  builds?: readonly MatchedBuild[];
  env: Readonly<Record<string, string | undefined>>;
}

const payloadOf = (b: MatchedBuild): string | undefined =>
  b.files.find((f) => f.role === b.entry.role)?.path;

/** The (platform, file) pairs a local-files channel pushes from the matched builds. */
function filesFor(
  channel: string,
  builds: readonly MatchedBuild[],
): { platform: string; file: string }[] {
  const out: { platform: string; file: string }[] = [];
  for (const b of builds) {
    const file = payloadOf(b);
    if (!file) continue;
    const { platform, format } = b.entry;
    if (channel === "itch") {
      const word = ITCH_PLATFORM[platform];
      const fits =
        format === "zip" || (platform === "android" && format === "apk");
      // One upload per platform: itch tags an upload by its channel's platform word.
      if (word && fits && !out.some((x) => x.platform === word))
        out.push({ platform: word, file });
    } else if (channel === "snap") {
      if (format === "snap" && out.length === 0)
        out.push({ platform: platform, file });
    } else if (channel === "fdroid") {
      if (format === "apk" && platform === "android" && out.length === 0)
        out.push({ platform, file });
    }
  }
  return out;
}

/** The plan: pure, no network. Rows follow the manifest's outlet order, which is alphabetical by id. */
export function planSync(
  outlets: readonly StepOutlet[],
  o: PlanOptions,
): SyncRow[] {
  const rows: SyncRow[] = [];
  for (const outlet of outlets)
    for (const c of channelsOf(outlet)) {
      const pr = c.plane === "pr";
      if (!pr && c.plane !== "ci" && c.id !== "fdroid") continue;
      const row: SyncRow = {
        outlet: outlet.id,
        channel: c.id,
        step: pr ? "pr" : "local-files",
        store: c.id,
        state: "planned",
      };
      let extras: SyncRow[] = [];
      const secret = (SECRETS[c.id] ?? []).find((e) => !o.env[e]);
      if (secret) {
        row.state = "skipped";
        row.reason = "missing-secret";
        row.secret = secret;
      } else if (!pr && !o.dir) {
        row.state = "skipped";
        row.reason = "needs-dir";
      } else if (!pr) {
        const found = filesFor(c.id, o.builds ?? []);
        if (!found.length) {
          row.state = "skipped";
          row.reason = "no-file";
        } else {
          Object.assign(row, found[0]);
          extras = found.slice(1).map((x) => ({ ...row, ...x }));
        }
      }
      rows.push(row, ...extras);
    }
  return rows;
}

function sink() {
  let text = "";
  return {
    out: { write: (s: string) => ((text += s), true) } as TermOut,
    text: () => text,
  };
}

const str = (a: ChannelArgs, k: string): string | undefined => {
  const v = a.flags[k];
  return typeof v === "string" && v.trim() ? v : undefined;
};
const bool = (a: ChannelArgs, k: string): boolean =>
  a.flags[k] === true || a.flags[k] === "true";

/** The version itch records: `--version`, else the tag a CI run is building. */
function versionOf(a: ChannelArgs, env: ChannelIo["env"]): string | undefined {
  const v = str(a, "version");
  if (v) return v;
  const tag = env.GITHUB_REF_TYPE === "tag" ? env.GITHUB_REF_NAME : undefined;
  return tag?.replace(/^v(?=\d)/, "") || undefined;
}

/** The file as a store tool is told of it: relative to the working directory when inside it. */
function shown(cwd: string, file: string): string {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

/** One local-files row: itch push, snap upload, or the F-Droid repository. */
async function runLocal(
  row: SyncRow,
  outlet: StepOutlet,
  a: ChannelArgs,
  io: ChannelIo,
  product: string,
  dryRun: boolean,
  log: TermOut,
  err: TermOut,
): Promise<void> {
  const channel = str(a, "channel") ?? "stable";
  const file = shown(io.cwd, row.file!);
  if (row.store === "fdroid") {
    const keystore = io.env[FDROID_KEYSTORE_ENV]!;
    const alias = io.env[FDROID_ALIAS_ENV]!;
    if (dryRun) {
      row.command = `pkey storefront fdroid --product ${product} --channel ${channel} --out ${FDROID_OUT} --keystore ${keystore} --alias ${alias}`;
      return;
    }
    await buildFdroidFeed({
      cwd: io.cwd,
      product,
      channel,
      out: FDROID_OUT,
      keystore,
      alias,
      baseUrl: str(a, "base-url"),
      env: io.env,
      stdout: log,
      stderr: err,
      fetchImpl: io.fetchImpl,
      sleep: io.sleep,
    });
    row.state = "done";
    return;
  }
  let step;
  if (row.store === "itch") {
    const version = versionOf(a, io.env);
    if (!version)
      throw new UsageError(
        "--version is required for itch push (the --userversion butler records).",
      );
    step = itchPushStep({
      outlet,
      dir: file,
      platform: row.platform!,
      channel,
      version,
    });
  } else step = snapUploadStep({ outlet, snap: file, channels: [channel] });
  const lines = sink();
  await runStoreSteps([step], {
    cwd: io.cwd,
    product,
    baseUrl: str(a, "base-url"),
    env: io.env,
    stdout: dryRun ? lines.out : log,
    stderr: err,
    fetchImpl: io.fetchImpl,
    sleep: io.sleep,
    dryRun,
    report: !bool(a, "no-report"),
    ...(io.spawnTool ? { spawnTool: io.spawnTool } : {}),
  });
  if (dryRun) row.command = commandLine(step.tool, step.argv);
  else row.state = "done";
}

/** Run the planned steps one after another; a failure does not stop the rest. */
async function runRows(
  rows: SyncRow[],
  a: ChannelArgs,
  io: ChannelIo,
  product: string,
  outlets: readonly StepOutlet[],
  dryRun: boolean,
): Promise<void> {
  for (const row of rows) {
    if (row.state !== "planned") continue;
    if (dryRun && row.step === "pr") continue;
    const stdout = sink();
    const stderr = sink();
    try {
      if (row.step === "local-files") {
        const outlet = outlets.find((o) => o.id === row.outlet)!;
        await runLocal(
          row,
          outlet,
          a,
          io,
          product,
          dryRun,
          stdout.out,
          stderr.out,
        );
      } else {
        const r = await runPrStep({
          store: row.store,
          product,
          channel: str(a, "channel") ?? "stable",
          outlet: row.outlet,
          generator: {},
          baseUrl: str(a, "base-url"),
          env: io.env,
          stdout: sink().out,
          stderr: stderr.out,
          fetchImpl: io.fetchImpl,
          sleep: io.sleep,
          report: !bool(a, "no-report"),
          cwd: io.cwd,
        });
        row.state =
          r.outcome === "opened" ||
          r.outcome === "existing" ||
          r.outcome === "unchanged"
            ? r.outcome
            : "unchanged";
        if (r.pr?.url) row.url = r.pr.url;
      }
    } catch (err) {
      if (err instanceof FirstSubmissionError) {
        // Not a failure: Flathub's first submission is a person's, with its own files.
        row.state = "skipped";
        row.reason = "first-submission";
        continue;
      }
      row.state = "failed";
      row.error = (err instanceof Error ? err.message : String(err)).split(
        "\n",
      )[0]!;
    }
    const notes = [
      ...stdout.text().split("\n"),
      ...stderr.text().split("\n"),
    ].filter(Boolean);
    if (notes.length && !dryRun) row.notes = notes;
  }
}

function describe(r: SyncRow, dryRun: boolean): string {
  switch (r.state) {
    case "planned":
      return !dryRun
        ? "pending"
        : r.command
          ? `would run ${r.command}`
          : r.step === "pr"
            ? "would open a pull request"
            : "would run";
    case "skipped":
      return r.reason === "missing-secret"
        ? `skipped: ${r.secret} is not set`
        : r.reason === "no-file"
          ? "skipped: no fitting file under --dir"
          : r.reason === "first-submission"
            ? "skipped: the first submission is by hand (pkey storefront flathub init)"
            : "skipped: needs --dir";
    case "done":
      return r.platform && r.store === "itch"
        ? `pushed ${r.platform}`
        : r.store === "snap"
          ? "uploaded"
          : "built and registered";
    case "opened":
      return `opened ${r.url ?? "a pull request"}`;
    case "existing":
      return `pull request exists: ${r.url ?? ""}`.trim();
    case "unchanged":
      return "already up to date";
    case "failed":
      return `failed: ${r.error ?? "see above"}`;
  }
}

/** A row's name: its channel, and its outlet id too when that differs (`scoop (homebrew)`). */
const labelOf = (r: SyncRow): string =>
  r.outlet === r.channel ? r.channel : `${r.channel} (${r.outlet})`;

function writeText(
  rows: readonly SyncRow[],
  product: string,
  track: string,
  dryRun: boolean,
  io: ChannelIo,
  term: Term,
): void {
  const { painter, symbols, caps } = term;
  const u = (v: string) => untrusted(v, io.env);
  const out = io.stdout;
  if (!rows.length) {
    out.write(
      "Nothing to sync. Sync covers winget, Homebrew, Scoop, Flathub, itch.io, Snap and F-Droid; add one with pkey channel add <id>.\n",
    );
    return;
  }
  const count = (s: RowState[]) =>
    rows.filter((r) => s.includes(r.state)).length;
  const failed = count(["failed"]);
  const parts = [
    failed && `${failed} failed`,
    dryRun
      ? count(["planned"]) && `${count(["planned"])} planned`
      : count(["opened", "existing", "unchanged", "done"]) &&
        `${count(["opened", "existing", "unchanged", "done"])} done`,
    count(["skipped"]) && `${count(["skipped"])} skipped`,
  ].filter(Boolean);
  const glyph = failed
    ? painter.style(symbols.fail, ["danger"])
    : dryRun
      ? painter.style(symbols.stepActive, ["muted"])
      : parts.length === 1 && count(["skipped"])
        ? painter.style(symbols.warn, ["warning"])
        : painter.style(symbols.ok, ["success"]);
  out.write(
    `${glyph}  ${painter.line([
      { text: u(product), style: ["strong"] },
      {
        text: ` ${symbols.separator} track ${u(track)}${dryRun ? ` ${symbols.separator} dry run` : ""}`,
        style: ["muted"],
      },
      { text: `: ${parts.join(", ")}` },
    ])}\n`,
  );
  const width = Math.max(10, caps.columns - 3);
  const markOf = (r: SyncRow): string =>
    r.state === "failed"
      ? painter.style(symbols.fail, ["danger"])
      : r.state === "skipped"
        ? painter.style(symbols.warn, ["warning"])
        : r.state === "planned"
          ? painter.style(symbols.stepActive, ["muted"])
          : painter.style(symbols.ok, ["success"]);
  for (const r of rows) {
    const spans: Line = [
      { text: u(labelOf(r)), style: ["strong"] },
      { text: ": ", style: ["muted"] },
      { text: u(describe(r, dryRun)) },
    ];
    const lines = caps.tty
      ? wrapSpans(spans, width, symbols.ellipsis)
      : [spans];
    lines.forEach((l, i) =>
      out.write(
        `${i === 0 ? markOf(r) : " ".repeat(cellWidth(symbols.ok))}  ${painter.line(l)}\n`,
      ),
    );
    for (const n of r.notes ?? [])
      out.write(
        `${" ".repeat(cellWidth(symbols.ok))}  ${painter.style(u(n), ["muted"])}\n`,
      );
  }
}

/** The builds under `dir` that `.pkey/release`'s artifacts map names (as `release publish` matches). */
async function matchBuilds(cwd: string, dir: string): Promise<MatchedBuild[]> {
  const loaded = await loadManifest(cwd);
  const entries = descriptorManifestOf(loaded).release?.app?.artifacts ?? [];
  if (!entries.length)
    throw new Error(
      ".pkey/release declares no deliverables.app with an artifacts map; --dir files are matched by it.",
    );
  const m = matchArtifacts(await scanDir(path.resolve(cwd, dir)), entries);
  // "Nothing matched" is a skip per channel; an ambiguous match is an error, as in release publish.
  const real = m.errors.filter((e) => !e.startsWith("No file under --dir"));
  if (real.length) throw new Error(real.join("\n"));
  return m.builds;
}

export const NO_CI_CREDENTIAL =
  "No CI credential: in GitHub Actions add permissions: id-token: write; elsewhere set PKEY_CI_TOKEN.";

const KNOWN_FLAGS = [
  "channel",
  "version",
  "dir",
  "dry-run",
  "json",
  "product",
  "base-url",
  "no-report",
];

/** `pkey channel sync`. */
export async function channelSync(
  a: ChannelArgs,
  io: ChannelIo,
): Promise<number> {
  const bad = unknownOption(a, io, KNOWN_FLAGS);
  if (bad !== null) return bad;
  if (a.positional.length > 1) throw new UsageError(SYNC_USAGE);
  const track = str(a, "channel") ?? "stable";
  if (findChannel(track))
    throw new UsageError(
      `--channel is the release track (stable, beta, dev, …); ${track} is a distribution channel.`,
    );
  const dryRun = bool(a, "dry-run");
  const json = bool(a, "json");
  let product;
  try {
    product = await loadStepProduct(io.cwd, str(a, "product"));
  } catch (e) {
    return manifestFailure("channel sync", e, io, json);
  }
  const dir = str(a, "dir");
  const builds = dir ? await matchBuilds(io.cwd, dir) : [];
  const rows = planSync(product.outlets, { dir, builds, env: io.env });
  // One check before any step: every step reports into the ledger with the CI credential.
  if (
    rows.some((r) => r.state === "planned") &&
    !io.env[CI_TOKEN_ENV]?.trim() &&
    !canRequestGithubOidc(io.env)
  ) {
    if (json)
      io.stdout.write(
        envelope("channel sync", 1, {
          error: "no-ci-credential",
          message: NO_CI_CREDENTIAL,
        }),
      );
    else
      io.stderr.write(failLine(NO_CI_CREDENTIAL, termOf(io, io.stderr), "tty"));
    return 1;
  }
  await runRows(rows, a, io, product.slug, product.outlets, dryRun);
  const failed = rows.some((r) => r.state === "failed");
  if (json) {
    io.stdout.write(
      envelope("channel sync", failed ? 1 : 0, {
        dryRun,
        product: product.slug,
        track,
        steps: rows.map(({ store: _store, notes: _notes, ...r }) => r),
      }),
    );
  } else {
    writeText(rows, product.slug, track, dryRun, io, termOf(io, io.stdout));
  }
  return failed ? 1 : 0;
}
