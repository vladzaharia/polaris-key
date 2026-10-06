// Commander adapter. `registerPolarisCommands(program, factory)` attaches the Polaris Key
// subcommands to a commander `Command`, building a client from the program's options via
// `factory` and printing each `CommandResult`. `commander` is an OPTIONAL peer dependency —
// only its TYPES are imported (erased at build), so this module compiles + ships without
// commander installed; a consumer that calls this passes in their own `Command` instance.
//
// The verbs are grouped by the service that owns them (see `commands.ts`), and the group is
// visible in the help text rather than only in the source: `register` sitting under "devices"
// is how an operator of a config-only product discovers that it is their provisioning verb.

import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { ServiceSlug } from "../discovery.js";
import type { ClientFactory } from "./commands.js";
import { CLI_VERBS, type CliIO } from "./kit.js";

/** How the adapter reads CLI-wide options (product/version/baseUrl/configDir) off the
 *  commander program to feed the `ClientFactory`. By default it reads them from the root
 *  program's parsed options; pass `resolveOptions` to source them elsewhere. */
export interface CommanderAdapterOptions {
  /** The pinned trust set the factory needs (kid -> raw Ed25519 pubkey base64url). */
  pinnedKeys: Record<string, string>;
  /** Static product slug + version (falls back to program options when omitted). */
  productSlug?: string;
  version?: string;
  /** The D-21 capability fallback for builds that know what their product runs. */
  expectedServices?: ServiceSlug[];
  /** Override how per-invocation options are resolved (e.g. from subcommand opts). */
  resolveOptions?: (cmd: Command) => { baseUrl?: string; configDir?: string };
  /** Sink for printed lines + exit-code mapping (defaults to console + `process.exitCode`).*/
  print?: (line: string) => void;
  setExitCode?: (code: number) => void;
  /** Progress sink (default: redraw one line on stderr when it is a TTY). */
  progress?: (line: string) => void;
  /** Stops long-running verbs (default: none; Ctrl-C ends the process). */
  signal?: AbortSignal;
}

function rootOpts(cmd: Command): Record<string, unknown> {
  // Walk to the topmost program so shared flags declared on the root resolve from any depth.
  let cur: Command = cmd;
  // `parent` is part of commander's public API.
  while ((cur as unknown as { parent?: Command }).parent) {
    cur = (cur as unknown as { parent: Command }).parent;
  }
  return cur.opts();
}

/** Redraw one progress line on stderr; nothing when stderr is not a terminal. */
export function ttyProgress(line: string): void {
  if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${line}`);
}

/** Attach every Polaris Key verb (`CLI_VERBS`) to `program`, dispatching to the
 *  framework-agnostic core. Multi-word verbs (`devices list`) become a group command with
 *  subcommands. `factory` builds a client from resolved flags. */
export function registerPolarisCommands(
  program: Command,
  factory: ClientFactory,
  options: CommanderAdapterOptions,
): Command {
  const print = options.print ?? ((line: string) => console.log(line));
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      if (code !== 0) process.exitCode = code;
    });
  const progress = options.progress ?? ttyProgress;

  const buildClient = async (cmd: Command) => {
    const opts = rootOpts(cmd);
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

  // A drawn progress line is ended before the next printed line.
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
      }
      parent = g;
    }
    const name = [verb.path.at(-1)!, ...verb.args].join(" ");
    parent
      .command(name)
      .description(`[${verb.group}] ${verb.describe}`)
      .action(async function action(this: Command, ...args: unknown[]) {
        // commander passes the positionals, then the options object and the command.
        const positional = args.slice(0, verb.args.length);
        const r = await verb.run(await buildClient(this), positional, io);
        say(r.message);
        setExitCode(r.ok ? 0 : 1);
      });
  }

  return program;
}
