// Commander adapter. `registerPolarisCommands(program, factory, options)` attaches the Polaris Key
// verbs to a commander `Command`, building a client from the program's options via `factory` and
// running each verb's terminal flow (docs/design/UI-KITS.md §1.4, §5.1 Node row): the rail, the
// masked key prompt, spinners and progress, `--json` on every verb, grouped help. `commander` is
// an OPTIONAL peer dependency: only its TYPES are imported (erased at build), so this module
// compiles and ships without commander installed; the consumer passes in their own `Command`.
//
// The verbs are grouped by the service that owns them (see `kit.ts`), and the groups are the
// help page's headings: `register` sitting under "Devices" is how an operator of a config-only
// product discovers that it is their provisioning verb.

import { readFile } from "node:fs/promises";
import type { Command, Help, HelpConfiguration } from "commander";
import type { ServiceSlug } from "../discovery.js";
import {
  optionalArg,
  runKitVerb,
  usageProblem,
  type KitAdapterOptions,
} from "./adapter.js";
import type { ClientFactory } from "./commands.js";
import { createKitContextSync } from "./context.js";
import { bindGate } from "./gate.js";
import {
  describeVerb,
  GROUP_HEADINGS,
  renderHelp,
  renderMountSection,
  renderVerbHelp,
  VERB_OPTIONS,
} from "./help.js";
import type { CliIO, CliVerb } from "./kit.js";
import { cellWidth, wrapSpans } from "./term/width.js";
import {
  clientFactoryFor,
  DEFAULT_ACTION,
  END_USER,
  planMount,
  reportSkipped,
  verbId,
  type MountOptions,
} from "./mount.js";

/** How the adapter reads CLI-wide options (product/version/baseUrl/configDir) off the
 *  commander program to feed the `ClientFactory`. By default it reads them from the root
 *  program's parsed options; pass `resolveOptions` to source them elsewhere. */
export interface CommanderAdapterOptions
  extends KitAdapterOptions, MountOptions {
  /** The pinned trust set the factory needs (kid -> raw Ed25519 pubkey base64url). Not needed
   *  with `config`, which carries them. */
  pinnedKeys?: Record<string, string>;
  /** Static product slug + version (falls back to program options when omitted). */
  productSlug?: string;
  version?: string;
  /** The D-21 capability fallback for builds that know what their product runs. */
  expectedServices?: ServiceSlug[];
  /** Override how per-invocation options are resolved (e.g. from subcommand opts). */
  resolveOptions?: (cmd: Command) => { baseUrl?: string; configDir?: string };
  /** Sink for printed lines + exit-code mapping (defaults to stdout + `process.exitCode`). */
  print?: (line: string) => void;
  setExitCode?: (code: number) => void;
  /** Progress sink for `kit: false` (default: redraw one line on stderr when it is a TTY). */
  progress?: (line: string) => void;
  /** Stops long-running verbs under `kit: false` (default: none; Ctrl-C ends the process). */
  signal?: AbortSignal;
  /**
   * `"kit"` (default) gives the program the grouped help page while every subcommand is a
   * Polaris Key verb; `"host"` leaves the program's own help alone. Each verb's own `--help`
   * is always the kit's.
   */
  help?: "kit" | "host";
}

function rootOf(cmd: Command): Command {
  // Walk to the topmost program so shared flags declared on the root resolve from any depth.
  let cur: Command = cmd;
  // `parent` is part of commander's public API.
  while ((cur as unknown as { parent?: Command }).parent) {
    cur = (cur as unknown as { parent: Command }).parent;
  }
  return cur;
}

/** Redraw one progress line on stderr; nothing when stderr is not a terminal. */
export function ttyProgress(line: string): void {
  if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${line}`); // ui-lint: allow terminal-raw-escape the pre-kit progress line (kit: false)
}

/** Below this many columns the host's help rows stack, as the kit's do (help.ts). */
const HELP_STACK_COLUMNS = 50;

/** Commander's own formatter, for commands the kit does not own. */
function defaultHelp(cmd: Command, helper: Help): string {
  const proto = Object.getPrototypeOf(helper) as Help;
  return proto.formatHelp.call(helper, cmd, helper);
}

/**
 * The host's help text kept inside the terminal: a line wider than `columns` breaks at its spaces
 * and continues two cells further in (commander wraps descriptions at its help width, but not the
 * usage line). Lines that fit are untouched.
 */
function fitLines(text: string, columns: number): string {
  return text
    .split("\n")
    .flatMap((line) => {
      if (cellWidth(line) <= columns) return [line];
      const indent = /^ */.exec(line)![0]!.length;
      const out: string[] = [];
      let cur = "";
      for (const word of line.trim().split(" ")) {
        const pad = out.length ? " ".repeat(indent + 2) : " ".repeat(indent);
        const next = cur ? `${cur} ${word}` : `${pad}${word}`;
        if (cur && cellWidth(next) > columns) {
          out.push(cur);
          cur = `${" ".repeat(indent + 2)}${word}`;
        } else cur = next;
      }
      if (cur) out.push(cur);
      return out;
    })
    .join("\n");
}

/** Hide the options a `config` replaces, where the host declared them. */
function hideOptions(program: Command, flags: readonly string[]): void {
  for (const o of program.options as unknown as Array<{
    long?: string;
    hidden: boolean;
  }>)
    if (o.long && flags.includes(o.long)) o.hidden = true;
}

/**
 * Add the Polaris Key verbs to `program`, dispatching to the terminal kit's flows. By default
 * that is the end-user set at the top level, grouped under one heading in `--help` after the
 * host's own commands; `namespace`, `verbs` and `onCollision` shape the mount. Multi-word verbs
 * (`devices list`) become a group command with subcommands. A host command with the same name as
 * a verb fails the registration with `polaris-verb-collision`, or is skipped with a warning.
 *
 * Give `config` (your generated `polarisConfig`) and a `version`, or a `factory` that builds a
 * client from the resolved flags.
 */
export function registerPolarisCommands(
  program: Command,
  options: CommanderAdapterOptions,
): Command;
export function registerPolarisCommands(
  program: Command,
  factory: ClientFactory,
  options: CommanderAdapterOptions,
): Command;
export function registerPolarisCommands(
  program: Command,
  a: ClientFactory | CommanderAdapterOptions,
  b?: CommanderAdapterOptions,
): Command {
  const options = typeof a === "function" ? b! : a;
  const factory = typeof a === "function" ? a : clientFactoryFor(options);
  const config = options.config;
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      if (code !== 0) process.exitCode = code;
    });
  const kit = options.kit !== false;
  const namespace = options.namespace;
  const baseBin = (cmd: Command): string =>
    options.bin ?? (rootOf(cmd).name() || slugOf(cmd));
  const slugOf = (cmd: Command): string =>
    options.productSlug ??
    config?.productSlug ??
    (rootOf(cmd).opts().product as string | undefined) ??
    rootOf(cmd).name();
  // What people type before a verb: under a namespace, the namespace too ("tidewater license").
  const binOf = (cmd: Command): string =>
    namespace ? `${baseBin(cmd)} ${namespace}` : baseBin(cmd);

  const plan = planMount(
    program.commands.flatMap((c) => [c.name(), ...c.aliases()]),
    options,
    baseBin(program),
  );
  reportSkipped(plan, options, baseBin(program));
  hideOptions(program, plan.hidden);
  const verbs = plan.verbs;

  const buildClient = async (cmd: Command) => {
    const opts = rootOf(cmd).opts();
    const extra = options.resolveOptions?.(cmd) ?? {};
    return factory({
      productSlug:
        options.productSlug ?? config?.productSlug ?? (opts.product as string),
      version: options.version ?? (opts.version as string),
      pinnedKeys:
        options.pinnedKeys ?? config?.trust?.pinnedKeys ?? ({} as never),
      // A config says where the control plane is; the flag it hides does not override it.
      baseUrl: config
        ? config.baseUrl
        : (extra.baseUrl ?? (opts.baseUrl as string | undefined)),
      configDir: extra.configDir ?? (opts.configDir as string | undefined),
      expectedServices: options.expectedServices ?? config?.expectedServices,
    });
  };

  // The pre-kit path (`kit: false`): plain messages, a progress line on stderr.
  const print = options.print ?? ((line: string) => console.log(line)); // ui-lint: allow terminal-console the legacy print sink's default (kit: false)
  const progress = options.progress ?? ttyProgress;
  let drawn = false;
  const say = (line: string) => {
    if (drawn && !options.progress && process.stderr.isTTY)
      process.stderr.write("\n");
    drawn = false;
    print(line);
  };
  const io: CliIO = {
    print: say,
    progress: (line) => {
      drawn = true;
      progress(line);
    },
    readFile: (path) => readFile(path, "utf8"),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const helpContext = (cmd: Command, root = false) =>
    createKitContextSync({
      slug: slugOf(cmd),
      bin: root ? baseBin(cmd) : binOf(cmd),
      ...(options.theme ? { theme: options.theme } : {}),
      ...(options.io ? { io: options.io } : {}),
      queryScheme: false,
    });
  const owned = new Map<Command, CliVerb>();
  /** A group command (the namespace, `devices`) and the verbs under it. */
  const groupsOwned = new Map<Command, CliVerb[]>();
  /** The commands the program lists as the kit's, not the host's. */
  const topOwned = new Set<Command>();
  const prior: HelpConfiguration = program.configureHelp();
  const formatHelp = (cmd: Command, helper: Help): string => {
    const verb = owned.get(cmd);
    if (verb) return renderVerbHelp(helpContext(cmd), verb);
    const group = groupsOwned.get(cmd);
    if (group) return renderHelp(helpContext(cmd), group);
    const base = prior.formatHelp
      ? prior.formatHelp.call(helper, cmd, helper)
      : defaultHelp(cmd, helper);
    if (cmd !== program) return base;
    const ctx = helpContext(cmd, true);
    const host = fitLines(base.replace(/\n+$/, ""), ctx.caps.columns);
    const section = renderMountSection(ctx, verbs, namespace, {
      column: helper.padWidth(cmd, helper),
      title: (x) => helper.styleTitle(x),
      term: (x) => helper.styleSubcommandTerm(x),
      grouped: verbs.some((v) => !END_USER.includes(verbId(v))),
    });
    return section.length ? `${host}\n\n${section.join("\n")}\n` : host;
  };
  if (kit && options.help !== "host")
    program.configureHelp({
      ...prior,
      // The host's commands are the program's own; the kit's go under their heading below them.
      visibleCommands(this: Help, cmd: Command) {
        const all = prior.visibleCommands
          ? prior.visibleCommands.call(this, cmd)
          : (Object.getPrototypeOf(this) as Help).visibleCommands.call(
              this,
              cmd,
            );
        return cmd === program ? all.filter((c) => !topOwned.has(c)) : all;
      },
      // Below the stack width the host's rows stack as the kit's do: the term, then its
      // description under it, instead of a word-wrapped second column.
      formatItem(
        this: Help,
        term: string,
        termWidth: number,
        description: string,
        helper: Help,
      ) {
        const base = prior.formatItem
          ? prior.formatItem.call(this, term, termWidth, description, helper)
          : (Object.getPrototypeOf(this) as Help).formatItem.call(
              this,
              term,
              termWidth,
              description,
              helper,
            );
        const columns = helper.helpWidth ?? 80;
        if (
          !description ||
          helper.preformatted(description) ||
          (columns >= HELP_STACK_COLUMNS && columns - (termWidth + 4) >= 16)
        )
          return base;
        const lines = wrapSpans(
          [{ text: description }],
          Math.max(1, columns - 4),
        );
        return [
          `  ${term}`,
          ...lines.map((l) => `    ${l.map((x) => x.text).join("")}`),
        ].join("\n");
      },
      formatHelp,
    });

  // The verbs' parent: the program, or the namespace's command.
  let root = program;
  if (namespace) {
    root = program
      .command(namespace)
      .description(
        kit
          ? helpContext(program, true).copy.t("cli.help.namespace")
          : "License commands",
      );
    groupsOwned.set(root, verbs);
    topOwned.add(root);
    if (kit) root.configureHelp({ formatHelp });
  }
  const groups = new Map<string, Command>();
  for (const verb of verbs) {
    let parent = root;
    for (const word of verb.path.slice(0, -1)) {
      let g = groups.get(word);
      if (!g) {
        const gctx = helpContext(program, true);
        const heading = GROUP_HEADINGS.find(([g]) => g === verb.group)![1];
        g = root
          .command(word)
          .description(
            kit ? gctx.copy.t(heading) : `[${verb.group}] ${word} commands`,
          );
        groups.set(word, g);
        groupsOwned.set(
          g,
          verbs.filter((v) => v.path.length > 1 && v.path[0] === word),
        );
        if (root === program) topOwned.add(g);
        if (kit) g.configureHelp({ formatHelp });
      }
      parent = g;
    }
    // Under the kit, positionals are optional and unknown options pass through, so an argument
    // error reaches runKitVerb and ends in a usage line (or a `--json` result line).
    const name = [
      verb.path.at(-1)!,
      ...(kit ? verb.args.map(optionalArg) : verb.args),
    ].join(" ");
    // A bare group runs its default action (`devices` lists, `update` checks), as the Python kit does.
    const isDefault =
      kit &&
      verb.path.length > 1 &&
      DEFAULT_ACTION[verb.path[0]!] === verb.path[1];
    const cmd = parent
      .command(name, isDefault ? { isDefault: true } : undefined)
      .description(
        kit
          ? describeVerb(helpContext(program, true), verb)
          : `[${verb.group}] ${verb.describe}`,
      );
    for (const a of verb.aliases ?? []) cmd.alias(a);
    owned.set(cmd, verb);
    if (root === program && verb.path.length === 1) topOwned.add(cmd);
    if (kit) {
      cmd.configureHelp({ formatHelp });
      cmd
        .option("--json", "JSON output for scripts")
        .option("--no-color", "plain text")
        .option("--ascii", "ASCII symbols only");
      for (const o of VERB_OPTIONS[verb.path[0]!] ?? []) cmd.option(o.flags);
      cmd.allowUnknownOption();
      cmd.allowExcessArguments?.(true);
    } else if (verb.path[0] === "secret" || verb.path[0] === "mint") {
      // Even the pre-kit output prints a value only when asked for.
      cmd.option("--reveal");
    }
    cmd.action(async function action(this: Command, ...args: unknown[]) {
      // commander passes the positionals, then the options object and the command.
      const positional = args.slice(0, verb.args.length);
      if (!kit) {
        const r = await verb.run(await buildClient(this), positional, {
          ...io,
          reveal: this.opts().reveal === true,
        });
        say(r.message);
        setExitCode(r.ok ? 0 : 1);
        return;
      }
      const flags = this.opts() as Record<string, unknown>;
      const code = await runKitVerb(
        verb,
        positional,
        {
          json: flags.json === true,
          color: flags.color !== false,
          ascii: flags.ascii === true,
          yes: flags.yes === true,
          deviceCode: flags.deviceCode === true,
          allowWorkflowCommands: flags.allowWorkflowCommands === true,
          reveal: flags.reveal === true,
          ...(typeof flags.keyFile === "string"
            ? { keyFile: flags.keyFile }
            : {}),
          keyStdin: flags.keyStdin === true,
        },
        () => buildClient(this),
        {
          usage: usageProblem(verb, positional, this.args),
          slug: slugOf(this),
          bin: binOf(this),
          ...(options.theme ? { theme: options.theme } : {}),
          ...(options.io ? { io: options.io } : {}),
          ...(options.frame === false ? { frame: false } : {}),
          mounted: verbs.map(verbId),
          ...(options.presentation
            ? { presentation: options.presentation }
            : {}),
          ...(options.print ? { print: options.print } : {}),
        },
      );
      setExitCode(code);
    });
  }

  bindGate(program, {
    client: (c) => buildClient(c as Command),
    slug: slugOf(program),
    bin: binOf(program),
    mounted: verbs.map(verbId),
    ...(options.io ? { io: options.io } : {}),
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.presentation ? { presentation: options.presentation } : {}),
    ...(options.frame === false ? { frame: false } : {}),
    setExitCode,
    owns: (c) => owned.has(c as Command) || groupsOwned.has(c as Command),
  });

  return program;
}
