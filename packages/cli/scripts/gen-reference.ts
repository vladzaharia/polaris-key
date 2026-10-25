/**
 * The `pkey` CLI reference page and its drift gate (P0-45).
 *
 *   pnpm gen cli-reference            # rewrite the page
 *   pnpm gen cli-reference --check    # exit 1 when it is stale, write nothing
 *
 * The page is rendered from the command table the CLI itself runs (`src/help.ts`: `COMMANDS`,
 * `GROUPS`, `COMMON_OPTIONS`), so a command, a flag or a group added to the table is on the page
 * after one regeneration, and `pkey help`, shell completion and this page cannot disagree.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMANDS,
  COMMON_OPTIONS,
  EXIT_CODES,
  GROUPS,
  STEP,
  type PkeyCommand,
} from "../src/help.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PAGE_PATH = "packages/docs/src/content/docs/reference/cli.mdx";

/** Prose for MDX: braces, angle brackets and backslashes are text, not markup. */
function prose(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/[{}]/g, (c) => `\\${c}`)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A table cell: no pipe, no newline, MDX-safe. */
const cell = (s: string): string => prose(s).replace(/\|/g, "\\|");

const code = (s: string): string => `\`${s.replace(/`/g, "")}\``;

function commandSection(c: PkeyCommand): string[] {
  const out: string[] = [
    `### ${code(`pkey ${c.name}`)}`,
    "",
    `${prose(c.summary)}.`,
    "",
    "```text",
    ...c.usage,
    "```",
  ];
  for (const p of [...(c.about ?? []), ...(c.reference ?? [])])
    out.push("", prose(p.text));
  if (c.env?.length) {
    out.push("", "| Variable | Meaning |", "| --- | --- |");
    for (const e of c.env) out.push(`| ${code(e.name)} | ${cell(e.text)} |`);
  }
  out.push(
    "",
    c.json
      ? "`--json`: one JSON line on stdout."
      : "No `--json`: the answer is text.",
  );
  return out;
}

function actionTable(): string[] {
  const rows = COMMANDS.flatMap((c) =>
    Object.entries(c.action ?? {}).map(([input, flag]) => ({
      input,
      command: c.name,
      flag,
    })),
  );
  return [
    "## GitHub Action inputs removed in 0.9",
    "",
    "The `polaris-key/publish` Action now takes `command` and `args`. These inputs no longer exist and fail the step; put the flag shown in `args` (an input marked step picks a subcommand: set it as `command`).",
    "",
    "| Input | Command | Flag |",
    "| --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${code(r.input)} | ${code(`pkey ${r.command}`)} | ${r.flag === STEP ? "step" : code(r.flag)} |`,
    ),
  ];
}

export function renderPage(): string {
  const body: string[] = [
    "---",
    'title: "pkey CLI"',
    'description: "Every pkey command and flag, generated from the CLI."',
    "---",
    "",
    "{/* GENERATED PAGE — do not edit. Regenerate with `pnpm gen cli-reference`.",
    "    Source of truth: the command table in packages/cli/src/help.ts, rendered by",
    "    packages/cli/scripts/gen-reference.ts. */}",
    "",
    "Every `pkey` command and flag. Run `pkey help` for the same table in your terminal, and `pkey help <command>` for one command.",
    "",
    "## Options",
    "",
    "| Option | Meaning |",
    "| --- | --- |",
    ...COMMON_OPTIONS.map(([t, d]) => `| ${code(t)} | ${cell(d)} |`),
  ];
  body.push(
    "",
    "## Exit codes",
    "",
    "| Code | Meaning |",
    "| --- | --- |",
    ...EXIT_CODES.map(([c, d]) => `| ${code(c)} | ${cell(d)} |`),
    "",
    "Errors go to stderr and `--json` results to stdout, so a pipe or a CI log keeps them apart. No command asks a question: with no terminal, or with `CI=true`, `pkey` never waits for input. A stack trace is never printed; set `PKEY_DEBUG=1` to add one to an unexpected error.",
  );
  for (const [group, heading] of GROUPS) {
    const cmds = COMMANDS.filter((c) => c.group === group);
    if (!cmds.length) continue;
    body.push("", `## ${heading}`);
    for (const c of cmds) body.push("", ...commandSection(c));
  }
  body.push("", ...actionTable(), "");
  return body.join("\n");
}

/** Prettier ignores reference/ (.prettierignore), so the page is emitted exactly as rendered. */
export function renderAll(): Record<string, string> {
  return { [PAGE_PATH]: renderPage() };
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [path, content] of Object.entries(renderAll())) {
    const target = join(ROOT, path);
    let current: string | undefined;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) {
      console.log(`up to date: ${path}`);
      continue;
    }
    if (check) {
      console.error(`stale: ${path} — run \`pnpm gen cli-reference\``);
      stale += 1;
      continue;
    }
    writeFileSync(target, content);
    console.log(`wrote ${path}`);
  }
  if (stale) process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
