// pnpm ui:lint [--board=web,ios] [--theme=dark|light] [--css=<file>]... [--html=<path|url>]...
//              [--no-strings] [--no-kits] [--record-string-debt] [--json]
import { failed, format, runLint } from "../lint.ts";

const args = process.argv.slice(2).filter((a) => a !== "--");
const list = (k: string) =>
  args
    .filter((a) => a.startsWith(`--${k}=`))
    .flatMap((a) => a.slice(k.length + 3).split(","));
const boards = list("board");
const theme = list("theme") as Array<"dark" | "light">;
const css = list("css");
const html = list("html");
const onlyFiles = (css.length || html.length) && !boards.length;

const run = await runLint({
  boards: onlyFiles ? [] : boards.length ? boards : undefined,
  themes: theme.length ? theme : undefined,
  css,
  html,
  strings: !args.includes("--no-strings"),
  kits: !args.includes("--no-kits") && !onlyFiles,
  recordStringDebt: args.includes("--record-string-debt"),
});

if (args.includes("--json")) console.log(JSON.stringify(run, null, 2));
else if (failed(run)) console.log(format(run));
const n =
  run.violations.length +
  run.strings.length +
  run.staleDebt.length +
  run.kits.length +
  run.consoleErrors.length;
console.log(n ? `ui:lint: ${n} finding(s)` : "ui:lint: clean");
process.exitCode = n ? 1 : 0;
