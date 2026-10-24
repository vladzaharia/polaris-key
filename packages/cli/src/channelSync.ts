/**
 * `pkey channel sync` (A-25.3): the steps the declared channels have, one row each.
 *
 * The plan reads `.pkey/distribution`: every outlet whose catalogue channel is on the `pr` or `ci`
 * plane, plus F-Droid (feed plane, a CI build step). A row is a step kind with its outlet, or the
 * reason it skips. Kinds so far:
 *
 *   pr           `storefront <store> pr` (prRun.ts): same allow-list, same report into the store ledger
 *   local-files  itch push, snap upload, fdroid from a build directory: A-25.4 (rows say "needs --dir")
 *
 * P4-33 adds `transport` as one more kind (D-A4). A channel whose credential env is absent is
 * skipped with one line naming it (D-A3); a step that fails fails the command after the rest ran.
 * `--dry-run` runs nothing. No secret value is ever printed: only the variable's name.
 */

import { channelForOutlet, type ChannelEntry } from "@polaris-key/manifest";
import { cellWidth, wrapSpans, type Line } from "@polaris-key/node/terminal";
import type { ChannelArgs, ChannelIo } from "./channel.js";
import { UsageError } from "./errors.js";
import { DEFAULT_KS_PASS_ENV } from "./feeds.js";
import { termFor, type Term, type TermOut } from "./terminal.js";
import { untrusted, untrustedJson } from "./untrusted.js";
import { loadStepProduct, type StepOutlet } from "./storefronts/outlets.js";
import { PR_TOKEN_ENV, runPrStep } from "./storefronts/prRun.js";

export type StepKind = "pr" | "local-files";

export type RowState =
  | "planned"
  | "skipped"
  | "opened"
  | "existing"
  | "unchanged"
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
  reason?: "missing-secret" | "needs-dir" | "not-yet";
  url?: string;
  error?: string;
  notes?: string[];
}

/** The credential env each plane's channel needs. */
const SECRETS: Readonly<Record<string, string>> = {
  winget: PR_TOKEN_ENV,
  homebrew: PR_TOKEN_ENV,
  scoop: PR_TOKEN_ENV,
  flathub: PR_TOKEN_ENV,
  itch: "BUTLER_API_KEY",
  snap: "SNAPCRAFT_STORE_CREDENTIALS",
  fdroid: DEFAULT_KS_PASS_ENV,
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
  env: Readonly<Record<string, string | undefined>>;
}

/** The plan: pure, no network. Rows follow `.pkey/distribution`'s order. */
export function planSync(outlets: readonly StepOutlet[], o: PlanOptions): SyncRow[] {
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
      const secret = SECRETS[c.id];
      if (secret && !o.env[secret]) {
        row.state = "skipped";
        row.reason = "missing-secret";
        row.secret = secret;
      } else if (!pr) {
        row.state = "skipped";
        row.reason = o.dir ? "not-yet" : "needs-dir";
      }
      rows.push(row);
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

/** Run the planned PR steps one after another; a failure does not stop the rest. */
async function runRows(
  rows: SyncRow[],
  a: ChannelArgs,
  io: ChannelIo,
  product: string,
): Promise<void> {
  for (const row of rows) {
    if (row.state !== "planned" || row.step !== "pr") continue;
    const stderr = sink();
    try {
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
    } catch (err) {
      row.state = "failed";
      row.error = (err instanceof Error ? err.message : String(err))
        .split("\n")[0]!;
    }
    const notes = stderr.text().split("\n").filter(Boolean);
    if (notes.length) row.notes = notes;
  }
}

function describe(r: SyncRow, dryRun: boolean): string {
  switch (r.state) {
    case "planned":
      return dryRun ? "would open a pull request" : "pending";
    case "skipped":
      return r.reason === "missing-secret"
        ? `skipped: ${r.secret} is not set`
        : r.reason === "not-yet"
          ? "skipped: --dir steps are not available yet"
          : "skipped: needs --dir";
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

function writeText(
  rows: readonly SyncRow[],
  product: string,
  channel: string,
  dryRun: boolean,
  io: ChannelIo,
  term: Term,
): void {
  const { painter, symbols, caps } = term;
  const u = (v: string) => untrusted(v, io.env);
  const out = io.stdout;
  out.write(
    `${painter.style(`Channels for ${u(product)}`, ["strong"])} ${painter.style(`${symbols.separator} ${u(channel)}${dryRun ? ` ${symbols.separator} dry run` : ""}`, ["muted"])}\n`,
  );
  if (!rows.length) {
    out.write(
      "Nothing to sync: no pr or ci outlet in .pkey/distribution.\n",
    );
    return;
  }
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
      { text: `${u(r.outlet)}`, style: ["strong"] },
      { text: ": ", style: ["muted"] },
      { text: u(describe(r, dryRun)) },
    ];
    const lines = caps.tty ? wrapSpans(spans, width, symbols.ellipsis) : [spans];
    lines.forEach((l, i) =>
      out.write(`${i === 0 ? markOf(r) : " ".repeat(cellWidth(symbols.ok))}  ${painter.line(l)}\n`),
    );
    for (const n of r.notes ?? [])
      out.write(`${" ".repeat(cellWidth(symbols.ok))}  ${painter.style(u(n), ["muted"])}\n`);
  }
  const count = (s: RowState[]) => rows.filter((r) => s.includes(r.state)).length;
  const parts = dryRun
    ? [`${count(["planned"])} planned`]
    : [`${count(["opened", "existing", "unchanged"])} done`];
  if (count(["skipped"])) parts.push(`${count(["skipped"])} skipped`);
  if (count(["failed"])) parts.push(`${count(["failed"])} failed`);
  out.write(`${parts.join(", ")}\n`);
}

/** `pkey channel sync`. */
export async function channelSync(
  a: ChannelArgs,
  io: ChannelIo,
): Promise<number> {
  if (a.positional.length > 1)
    throw new UsageError(
      "Usage: pkey channel sync [--channel c] [--version v] [--dir d] [--dry-run] [--json]",
    );
  const dryRun = bool(a, "dry-run");
  const json = bool(a, "json");
  const product = await loadStepProduct(io.cwd, str(a, "product"));
  const rows = planSync(product.outlets, { dir: str(a, "dir"), env: io.env });
  if (!dryRun) await runRows(rows, a, io, product.slug);
  const channel = str(a, "channel") ?? "stable";
  const failed = rows.some((r) => r.state === "failed");
  if (json) {
    io.stdout.write(
      `${untrustedJson(
        {
          ok: !failed,
          dryRun,
          product: product.slug,
          channel,
          steps: rows.map((r) => ({ ...r, notes: undefined })),
        },
        2,
      )}\n`,
    );
  } else {
    const stdout = io.stdout as TermOut;
    writeText(rows, product.slug, channel, dryRun, io, (io.term ?? ((o: TermOut) => termFor(o, io.env)))(stdout));
  }
  return failed ? 1 : 0;
}
