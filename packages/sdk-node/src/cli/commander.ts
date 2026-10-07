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
import type { Command, Help } from "commander";
import type { ServiceSlug } from "../discovery.js";
import {
  optionalArg,
  runKitVerb,
  usageProblem,
  type KitAdapterOptions,
} from "./adapter.js";
import type { ClientFactory } from "./commands.js";
import { createKitContextSync } from "./context.js";
import { renderHelp, renderVerbHelp, VERB_OPTIONS } from "./help.js";
import { CLI_VERBS, type CliIO, type CliVerb } from "./kit.js";

/** How the adapter reads CLI-wide options (product/version/baseUrl/configDir) off the
 *  commander program to feed the `ClientFactory`. By default it reads them from the root
 *  program's parsed options; pass `resolveOptions` to source them elsewhere. */
export interface CommanderAdapterOptions extends KitAdapterOptions {
  /** The pinned trust set the factory needs (kid -> raw Ed25519 pubkey base64url). */
  pinnedKeys: Record<string, string>;
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

/** Commander's own formatter, for commands the kit does not own. */
function defaultHelp(cmd: Command, helper: Help): string {
  const proto = Object.getPrototypeOf(helper) as Help;
  return proto.formatHelp.call(helper, cmd, helper);
}

/** Attach every Polaris Key verb (`CLI_VERBS`) to `program`, dispatching to the terminal
 *  kit's flows. Multi-word verbs (`devices list`) become a group command with subcommands.
 *  `factory` builds a client from resolved flags. */
export function registerPolarisCommands(
  program: Command,
  factory: ClientFactory,
  options: CommanderAdapterOptions,
): Command {
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      if (code !== 0) process.exitCode = code;
    });
  const kit = options.kit !== false;
  const slugOf = (cmd: Command): string =>
    options.productSlug ??
    (rootOf(cmd).opts().product as string | undefined) ??
    rootOf(cmd).name();
  const binOf = (cmd: Command): string =>
    options.bin ?? (rootOf(cmd).name() || slugOf(cmd));

  const buildClient = async (cmd: Command) => {
    const opts = rootOf(cmd).opts();
    const extra = options.resolveOptions?.(cmd) ?? {};
    return factory({
      productSlug: options.productSlug ?? (opts.product as string),
      version: options.version ?? (opts.version as string),
      pinnedKeys: options.pinnedKeys,
      baseUrl: extra.baseUrl ?? (opts.baseUrl as string | undefined),
      configDir: extra.configDir ?? (opts.configDir as string | undefined),
      expectedServices: options.expectedServices,
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

  const helpContext = (cmd: Command) =>
    createKitContextSync({
      slug: slugOf(cmd),
      bin: binOf(cmd),
      ...(options.theme ? { theme: options.theme } : {}),
      ...(options.io ? { io: options.io } : {}),
      queryScheme: false,
    });
  const owned = new Map<Command, CliVerb>();
  const groupsOwned = new Set<Command>();
  const formatHelp = (cmd: Command, helper: Help): string => {
    const verb = owned.get(cmd);
    if (verb) return renderVerbHelp(helpContext(cmd), verb);
    if (groupsOwned.has(cmd)) {
      const word = cmd.name();
      return renderHelp(
        helpContext(cmd),
        CLI_VERBS.filter((v) => v.path[0] === word),
      );
    }
    const allKit = program.commands.every(
      (c) => owned.has(c) || groupsOwned.has(c),
    );
    if (cmd === program && allKit)
      return renderHelp(helpContext(cmd), CLI_VERBS);
    return defaultHelp(cmd, helper);
  };
  if (kit && options.help !== "host") program.configureHelp({ formatHelp });

  const groups = new Map<string, Command>();
  for (const verb of CLI_VERBS) {
    let parent = program;
    for (const word of verb.path.slice(0, -1)) {
      let g = groups.get(word);
      if (!g) {
        g = program
          .command(word)
          .description(`[${verb.group}] ${word} commands`);
        groups.set(word, g);
        groupsOwned.add(g);
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
    const cmd = parent
      .command(name)
      .description(`[${verb.group}] ${verb.describe}`);
    for (const a of verb.aliases ?? []) cmd.alias(a);
    owned.set(cmd, verb);
    if (kit) {
      cmd.configureHelp({ formatHelp });
      cmd
        .option("--json", "JSON output for scripts")
        .option("--no-color", "plain text")
        .option("--ascii", "ASCII symbols only");
      for (const o of VERB_OPTIONS[verb.path[0]!] ?? []) cmd.option(o.flags);
      cmd.allowUnknownOption();
      cmd.allowExcessArguments?.(true);
    }
    cmd.action(async function action(this: Command, ...args: unknown[]) {
      // commander passes the positionals, then the options object and the command.
      const positional = args.slice(0, verb.args.length);
      if (!kit) {
        const r = await verb.run(await buildClient(this), positional, io);
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
        },
        () => buildClient(this),
        {
          usage: usageProblem(verb, positional, this.args),
          slug: slugOf(this),
          bin: binOf(this),
          ...(options.theme ? { theme: options.theme } : {}),
          ...(options.io ? { io: options.io } : {}),
          ...(options.presentation
            ? { presentation: options.presentation }
            : {}),
          ...(options.print ? { print: options.print } : {}),
        },
      );
      setExitCode(code);
    });
  }

  return program;
}
