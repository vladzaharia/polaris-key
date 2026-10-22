// Grouped help and shell completion (docs/design/UI-KITS.md §1.4, §5.1 Node row; the terminal
// board's help shot). The verbs are grouped by the service that owns them, each group under a
// catalog heading; the options every verb takes close the page. Completion scripts for bash, zsh
// and fish are generated from the same verb table, so they cannot drift from the commands.

import type { KitContext } from "./context.js";
import type { CliGroup, CliVerb } from "./kit.js";
import { cellWidth, wrapSpans, type Line } from "./term/width.js";

/** The catalog heading of each verb group, in help order. */
export const GROUP_HEADINGS: ReadonlyArray<[CliGroup, string]> = [
  ["license", "cli.group.license"],
  ["identity", "cli.group.account"],
  ["devices", "cli.group.devices"],
  ["config", "cli.group.settings"],
  ["update", "cli.group.updates"],
  ["packs", "cli.group.content"],
  ["core", "cli.group.support"],
];

/** The options every verb takes, with the catalog key of each description. */
export const GLOBAL_OPTIONS: ReadonlyArray<{ flags: string; key: string }> = [
  { flags: "--json", key: "cli.option.json" },
  { flags: "--no-color", key: "cli.option.noColor" },
  { flags: "--ascii", key: "cli.option.ascii" },
  { flags: "-h, --help", key: "cli.option.help" },
];

/** The flags a verb adds, with their catalog keys. */
export const VERB_OPTIONS: Readonly<
  Record<string, ReadonlyArray<{ flags: string; key?: string }>>
> = {
  activate: [
    { flags: "--key-file <path>", key: "cli.option.keyFile" },
    { flags: "--key-stdin", key: "cli.option.keyStdin" },
  ],
  login: [{ flags: "--device-code", key: "cli.option.deviceCode" }],
  logout: [{ flags: "-y, --yes", key: "cli.option.yes" }],
  deactivate: [{ flags: "-y, --yes", key: "cli.option.yes" }],
  secret: [
    { flags: "--reveal", key: "cli.option.reveal" },
    {
      flags: "--allow-workflow-commands",
      key: "cli.option.allowWorkflowCommands",
    },
  ],
  mint: [
    { flags: "--reveal", key: "cli.option.reveal" },
    {
      flags: "--allow-workflow-commands",
      key: "cli.option.allowWorkflowCommands",
    },
  ],
};

/** A verb as typed: its words and arguments (`devices rename <deviceId> [label...]`). */
export function verbUsage(v: CliVerb): string {
  return [...v.path, ...v.args].join(" ");
}

/** Below this many columns a help row stacks: the term, then its description under it. */
const STACK_COLUMNS = 50;

/**
 * Two-column rows: the term in `strong` (or plain), the description wrapped under its column, never
 * past the terminal's width. Below 50 columns, or when the description column would be narrower
 * than 16 cells, each term stacks above its description (indented two cells under the term).
 */
function twoColumns(
  ctx: KitContext,
  rows: ReadonlyArray<{ term: string; text: string }>,
  indent = 2,
  /** One column for the whole page, so every group lines up. */
  column?: number,
  /** Inside a host's page the terms follow the host's styling (plain, or its own): this formats one. */
  hostTerm?: (term: string) => string,
): string[] {
  const termWidth =
    column ?? Math.min(24, Math.max(0, ...rows.map((r) => cellWidth(r.term))));
  const columns = ctx.caps.columns;
  const stacked =
    columns < STACK_COLUMNS || columns - (indent + termWidth + 2) < 16;
  const descCol = stacked ? indent + 2 : indent + termWidth + 2;
  const width = Math.max(1, columns - descCol);
  const out: string[] = [];
  for (const r of rows) {
    const term = hostTerm
      ? hostTerm(r.term)
      : ctx.painter.style(r.term, ["strong"]);
    const fits = !stacked && cellWidth(r.term) <= termWidth;
    // A flag with no description (the catalog has none yet): the term alone, no trailing blanks.
    if (r.text === "" && (fits || stacked)) {
      out.push(`${" ".repeat(indent)}${term}`);
      continue;
    }
    // A term wider than the line wraps at its spaces, continued two cells further in; a stacked
    // command that wrapped indents its description by four, so the two read apart without bold.
    const termLines = fits
      ? []
      : wrapSpans(
          [{ text: r.term, ...(hostTerm ? {} : { style: ["strong"] }) }],
          Math.max(1, columns - indent - 2),
        );
    const col = stacked && termLines.length > 1 ? indent + 4 : descCol;
    const lines = wrapSpans([{ text: r.text }], Math.max(1, columns - col));
    termLines.forEach((l, i) =>
      out.push(
        `${" ".repeat(i === 0 ? indent : indent + 2)}${
          hostTerm
            ? hostTerm(l.map((x) => x.text).join(""))
            : ctx.painter.line(l)
        }`,
      ),
    );
    lines.forEach((l, i) =>
      out.push(
        i === 0 && fits
          ? `${" ".repeat(indent)}${term}${" ".repeat(termWidth - cellWidth(r.term) + 2)}${ctx.painter.line(l)}`
          : `${" ".repeat(col)}${ctx.painter.line(l)}`,
      ),
    );
  }
  return out;
}

/**
 * `Usage  tidewater <command> [options]`, wrapped between tokens with a hanging indent under the
 * command (`Verwendung` in German is longer, so the hang follows the label).
 */
function hung(ctx: KitContext, label: string, text: string): string[] {
  const hang = cellWidth(label) + 2;
  return wrapSpans(
    text
      .split(" ")
      .flatMap((w, i) => [
        ...(i ? [{ text: " " }] : []),
        { text: w, unit: true },
      ]),
    Math.max(1, ctx.caps.columns - hang),
  ).map((l, i) =>
    i === 0
      ? `${ctx.painter.style(label, ["muted"])}  ${ctx.painter.line(l)}`
      : `${" ".repeat(hang)}${ctx.painter.line(l)}`,
  );
}

/** The verb's description in the catalog's words. */
export function describeVerb(ctx: KitContext, v: CliVerb): string {
  return ctx.copy.t(v.describeKey, { product: ctx.product.name });
}

/** How a host page styles what the kit's section adds to it (commander's `Help` styles). */
export interface HostStyle {
  /** The host's own column: its `padWidth`, so descriptions line up with the host's. */
  column?: number;
  /** Styles a heading (`styleTitle`). */
  title?: (text: string) => string;
  /** Styles a command term (`styleSubcommandTerm`). */
  term?: (text: string) => string;
  /** One section per kit group, for a mount that goes past the end-user set. */
  grouped?: boolean;
}

/**
 * The Polaris Key sections of a host program's help: a heading (`cli.help.group`) and its commands
 * in two columns, to follow the host's own sections, in the host's styling and on the host's
 * description column. Under a `namespace` the section is one entry that says what the namespace
 * holds. A mount that goes past the end-user set gets one section per kit group (License,
 * Account, Devices, …). Returns the lines, no trailing newline.
 */
export function renderMountSection(
  ctx: KitContext,
  verbs: readonly CliVerb[],
  namespace?: string,
  host: HostStyle = {},
): string[] {
  if (!verbs.length) return [];
  const t = ctx.copy.t.bind(ctx.copy);
  const title = host.title ?? ((x: string) => x);
  const term = host.term ?? ((x: string) => x);
  const own = (
    heading: string,
    rows: Array<{ term: string; text: string }>,
  ): string[] => {
    const column =
      host.column ??
      Math.min(
        ctx.caps.columns < 70 ? 16 : 24,
        Math.max(
          ...rows.map((r) => cellWidth(r.term)).filter((w) => w <= 24),
          0,
        ),
      );
    return [
      ctx.painter.line([{ text: title(`${heading}:`) }]),
      ...twoColumns(ctx, rows, 2, column, term),
    ];
  };
  if (namespace !== undefined)
    return own(t("cli.help.group"), [
      { term: namespace, text: t("cli.help.namespace") },
    ]);
  const toRow = (v: CliVerb) => ({
    term: verbUsage(v),
    text: describeVerb(ctx, v),
  });
  if (!host.grouped) return own(t("cli.help.group"), verbs.map(toRow));
  return GROUP_HEADINGS.flatMap(([group, key], i, all) => {
    const inGroup = verbs.filter((v) => v.group === group);
    if (!inGroup.length) return [];
    // One blank line between sections, none before the first.
    const before = all
      .slice(0, i)
      .some(([g]) => verbs.some((v) => v.group === g));
    return [...(before ? [""] : []), ...own(t(key), inGroup.map(toRow))];
  });
}

/** The whole help page, grouped (the terminal board's help shot). */
export function renderHelp(ctx: KitContext, verbs: readonly CliVerb[]): string {
  const t = ctx.copy.t.bind(ctx.copy);
  const line = (spans: Line) => ctx.painter.line(spans);
  const out: string[] = [
    ...wrapSpans(
      [
        { text: ctx.bin, style: ["strong"] },
        {
          text: ` ${ctx.symbols.separator} ${t("cli.help.lede", { product: ctx.product.name })}`,
          style: ["muted"],
        },
      ],
      ctx.caps.columns,
    ).map(line),
    "",
    ...hung(ctx, t("cli.help.usage"), `${ctx.bin} <command> [options]`),
  ];
  // One column for every group: the widest usage that fits in 24 cells (longer ones wrap).
  const column = Math.min(
    ctx.caps.columns < 70 ? 16 : 24,
    Math.max(
      ...GLOBAL_OPTIONS.map((o) => cellWidth(o.flags)),
      ...verbs.map((v) => cellWidth(verbUsage(v))).filter((w) => w <= 24),
    ),
  );
  for (const [group, key] of GROUP_HEADINGS) {
    const inGroup = verbs.filter((v) => v.group === group);
    if (!inGroup.length) continue;
    out.push("", line([{ text: t(key), style: ["strong"] }]));
    out.push(
      ...twoColumns(
        ctx,
        inGroup.map((v) => ({
          term: verbUsage(v),
          text: describeVerb(ctx, v),
        })),
        2,
        column,
      ),
    );
  }
  out.push("", line([{ text: t("cli.help.options"), style: ["strong"] }]));
  out.push(
    ...twoColumns(
      ctx,
      GLOBAL_OPTIONS.map((o) => ({ term: o.flags, text: t(o.key) })),
      2,
      column,
    ),
  );
  out.push(
    "",
    ...wrapSpans(
      [
        {
          text: t("cli.help.more", { command: `${ctx.bin} <command> --help` }),
          style: ["muted"],
        },
      ],
      ctx.caps.columns,
    ).map(line),
  );
  return `${out.join("\n")}\n`;
}

/** One verb's help: what it does, its usage and its options. */
export function renderVerbHelp(ctx: KitContext, v: CliVerb): string {
  const t = ctx.copy.t.bind(ctx.copy);
  const line = (spans: Line) => ctx.painter.line(spans);
  const name = v.path.join(" ");
  const opts: ReadonlyArray<{ flags: string; key?: string }> = [
    ...(VERB_OPTIONS[v.path[0]!] ?? []),
    ...GLOBAL_OPTIONS,
  ];
  const out: string[] = [
    line([{ text: `${ctx.bin} ${name}`, style: ["strong"] }]),
    ...wrapSpans(
      [{ text: describeVerb(ctx, v), style: ["muted"] }],
      ctx.caps.columns,
    ).map(line),
    "",
    ...hung(ctx, t("cli.help.usage"), `${ctx.bin} ${verbUsage(v)} [options]`),
    "",
    line([{ text: t("cli.help.options"), style: ["strong"] }]),
    ...twoColumns(
      ctx,
      opts.map((o) => ({
        term: o.flags,
        text: o.key ? t(o.key) : "",
      })),
    ),
  ];
  return `${out.join("\n")}\n`;
}

export type CompletionShell = "bash" | "zsh" | "fish";

export const COMPLETION_SHELLS: readonly CompletionShell[] = [
  "bash",
  "zsh",
  "fish",
];

/** The top-level words and each group word's subcommands. */
function wordTree(verbs: readonly CliVerb[]): {
  top: Array<{ word: string; verb?: CliVerb }>;
  sub: Map<string, CliVerb[]>;
} {
  const top: Array<{ word: string; verb?: CliVerb }> = [];
  const sub = new Map<string, CliVerb[]>();
  for (const v of verbs) {
    if (v.path.length === 1) {
      top.push({ word: v.path[0]!, verb: v });
      for (const a of v.aliases ?? []) top.push({ word: a, verb: v });
      continue;
    }
    const w = v.path[0]!;
    if (!sub.has(w)) {
      sub.set(w, []);
      top.push({ word: w });
    }
    sub.get(w)!.push(v);
  }
  return { top, sub };
}

const ident = (bin: string) => bin.replace(/[^A-Za-z0-9_]/g, "_");
const sq = (s: string) => s.replace(/'/g, "'\\''");

/** A completion script for `shell`, generated from the verb table. */
export function completionScript(
  ctx: KitContext,
  shell: CompletionShell,
  verbs: readonly CliVerb[],
): string {
  const { top, sub } = wordTree(verbs);
  const bin = ctx.bin;
  const fn = `_${ident(bin)}_complete`;
  const flags = [
    ...GLOBAL_OPTIONS.flatMap((o) => o.flags.split(", ")),
    ...Object.values(VERB_OPTIONS).flatMap((os) =>
      os.flatMap((o) => o.flags.split(", ")),
    ),
  ]
    .map((f) => f.replace(/\s*<.*>$/, ""))
    .filter((f, i, all) => all.indexOf(f) === i);
  const desc = (v?: CliVerb) => (v ? describeVerb(ctx, v) : "");
  if (shell === "bash") {
    const cases = [...sub]
      .map(
        ([w, vs]) =>
          `    ${w}) [ "$COMP_CWORD" -eq 2 ] && words="${vs.map((v) => v.path[1]).join(" ")}" ;;`,
      )
      .join("\n");
    return [
      `# ${bin} completion for bash. Add to ~/.bashrc:  eval "$(${bin} completion bash)"`,
      `${fn}() {`,
      '  local cur="${COMP_WORDS[COMP_CWORD]}" words=""',
      '  case "${COMP_WORDS[1]}" in',
      cases,
      "  esac",
      `  [ "$COMP_CWORD" -eq 1 ] && words="${top.map((x) => x.word).join(" ")}"`,
      `  case "$cur" in -*) words="${flags.join(" ")}" ;; esac`,
      '  COMPREPLY=( $(compgen -W "$words" -- "$cur") )',
      "}",
      `complete -F ${fn} ${bin}`,
      "",
    ].join("\n");
  }
  if (shell === "zsh") {
    const subCases = [...sub]
      .map(
        ([w, vs]) =>
          `      ${w}) cmds=(${vs.map((v) => `'${sq(`${v.path[1]}:${desc(v)}`)}'`).join(" ")}); _describe 'command' cmds ;;`,
      )
      .join("\n");
    return [
      `#compdef ${bin}`,
      `# ${bin} completion for zsh. Add to ~/.zshrc:  eval "$(${bin} completion zsh)"`,
      `${fn}() {`,
      "  local -a cmds",
      "  if [[ $words[CURRENT] == -* ]]; then",
      `    cmds=(${flags.map((f) => `'${sq(f)}'`).join(" ")}); _describe 'option' cmds; return`,
      "  fi",
      "  if (( CURRENT == 2 )); then",
      `    cmds=(${top.map((x) => `'${sq(`${x.word}:${desc(x.verb)}`)}'`).join(" ")})`,
      "    _describe 'command' cmds",
      "  elif (( CURRENT == 3 )); then",
      "    case $words[2] in",
      subCases,
      "    esac",
      "  fi",
      "}",
      `compdef ${fn} ${bin}`,
      "",
    ].join("\n");
  }
  const lines = [
    `# ${bin} completion for fish. Save as ~/.config/fish/completions/${bin}.fish`,
    `complete -c ${bin} -f`,
    ...top.map(
      (x) =>
        `complete -c ${bin} -n '__fish_use_subcommand' -a '${sq(x.word)}'${x.verb ? ` -d '${sq(desc(x.verb))}'` : ""}`,
    ),
    ...[...sub].flatMap(([w, vs]) =>
      vs.map(
        (v) =>
          `complete -c ${bin} -n '__fish_seen_subcommand_from ${w}' -a '${sq(v.path[1]!)}' -d '${sq(desc(v))}'`,
      ),
    ),
    ...flags.map((f) =>
      f.startsWith("--")
        ? `complete -c ${bin} -l '${f.slice(2)}'`
        : `complete -c ${bin} -s '${f.slice(1)}'`,
    ),
    "",
  ];
  return lines.join("\n");
}
