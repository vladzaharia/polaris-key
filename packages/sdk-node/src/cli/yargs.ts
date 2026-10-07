// yargs adapter. `polarisCommandModule(factory, options)` returns a yargs `CommandModule`
// exposing the Polaris Key verbs under a `polaris-key <command>` group, and
// `registerPolarisCommands(yargs, factory, options)` registers that module on an `Argv`. Each
// verb runs the terminal kit's flow (the rail, the masked key prompt, `--json`), exactly as the
// commander adapter does: both call `runKitVerb`. `yargs` is an OPTIONAL peer dependency — only
// its TYPES are imported (erased at build), so this module compiles + ships without yargs
// installed; the consumer supplies the `Argv`.
//
// Same per-service grouping as the commander adapter; the two must stay verb-for-verb
// identical, which is why both build from `CLI_VERBS` (`kit.ts`) and neither declares a verb.

import { readFile } from "node:fs/promises";
import type { Argv, ArgumentsCamelCase, CommandModule } from "yargs";
import {
  optionalArg,
  runKitVerb,
  usageProblem,
  type KitAdapterOptions,
} from "./adapter.js";
import type { ClientFactory } from "./commands.js";
import { ttyProgress } from "./commander.js";
import { VERB_OPTIONS } from "./help.js";
import { argName, CLI_VERBS, type CliIO, type CliVerb } from "./kit.js";
import type { ServiceSlug } from "../discovery.js";

/** Shared options for the yargs adapter (see the commander adapter for the analog). */
export interface YargsAdapterOptions extends KitAdapterOptions {
  /** The pinned trust set the factory needs (kid -> raw Ed25519 pubkey base64url). */
  pinnedKeys: Record<string, string>;
  /** Static product slug + version (falls back to parsed args when omitted). */
  productSlug?: string;
  version?: string;
  /** The D-21 capability fallback for builds that know what their product runs. */
  expectedServices?: ServiceSlug[];
  /** Sink for printed lines + exit-code mapping (defaults to stdout + `process.exitCode`). */
  print?: (line: string) => void;
  setExitCode?: (code: number) => void;
  /** Progress sink for `kit: false` (default: redraw one line on stderr when it is a TTY). */
  progress?: (line: string) => void;
  /** Stops long-running verbs under `kit: false`. */
  signal?: AbortSignal;
}

interface CommonArgs {
  product?: string;
  version?: string;
  baseUrl?: string;
  configDir?: string;
}

function makeBuildClient(factory: ClientFactory, options: YargsAdapterOptions) {
  return (argv: ArgumentsCamelCase<CommonArgs>) =>
    factory({
      productSlug: options.productSlug ?? (argv.product as string),
      version: options.version ?? (argv.version as string),
      pinnedKeys: options.pinnedKeys,
      baseUrl: argv.baseUrl,
      configDir: argv.configDir,
      expectedServices: options.expectedServices,
    });
}

/** yargs spells a variadic positional `[name..]`; the table uses commander's `[name...]`. */
const yargsArg = (spec: string): string => spec.replace("...", "..");

/** `-y, --yes` → the long name yargs declares (`yes`), with its alias. */
function yargsOption(flags: string): { name: string; alias?: string } {
  const long = /--([a-z-]+)/.exec(flags)?.[1] ?? flags;
  const short = /(?:^|\s)-([a-z])\b/.exec(flags)?.[1];
  return short ? { name: long, alias: short } : { name: long };
}

/** Build a yargs `CommandModule` (`polaris-key <command>`) covering every verb in
 *  `CLI_VERBS`; multi-word verbs (`devices list`) nest under a group command. */
export function polarisCommandModule(
  factory: ClientFactory,
  options: YargsAdapterOptions,
): CommandModule<unknown, CommonArgs> {
  const print = options.print ?? ((line: string) => console.log(line)); // ui-lint: allow terminal-console the legacy print sink's default (kit: false)
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      if (code !== 0) process.exitCode = code;
    });
  const kit = options.kit !== false;
  const buildClient = makeBuildClient(factory, options);
  const io: CliIO = {
    print,
    progress: options.progress ?? ttyProgress,
    readFile: (path) => readFile(path, "utf8"),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const leaf = (verb: CliVerb) => ({
    // Under the kit, positionals are optional so a missing one ends in the kit's usage result.
    command: [
      verb.path.at(-1)!,
      ...verb.args.map((a) => yargsArg(kit ? optionalArg(a) : a)),
    ].join(" "),
    aliases: verb.aliases ?? [],
    describe: `[${verb.group}] ${verb.describe}`,
    builder: (y: Argv<CommonArgs>) => {
      if (!kit) return y;
      let b = y
        .option("json", {
          type: "boolean",
          describe: "JSON output for scripts",
        })
        .option("color", {
          type: "boolean",
          describe: "--no-color: plain text",
        })
        .option("ascii", { type: "boolean", describe: "ASCII symbols only" });
      for (const o of VERB_OPTIONS[verb.path[0]!] ?? []) {
        const { name, alias } = yargsOption(o.flags);
        b = b.option(name, { type: "boolean", ...(alias ? { alias } : {}) });
      }
      return b;
    },
    handler: async (argv: ArgumentsCamelCase<CommonArgs>) => {
      const bag = argv as unknown as Record<string, unknown>;
      const positional = verb.args.map((a) => bag[argName(a)]);
      if (!kit) {
        const r = await verb.run(await buildClient(argv), positional, io);
        print(r.message);
        setExitCode(r.ok ? 0 : 1);
        return;
      }
      const slug =
        options.productSlug ??
        (bag.product as string | undefined) ??
        "polaris-key";
      const code = await runKitVerb(
        verb,
        positional,
        {
          json: bag.json === true,
          color: bag.color !== false,
          ascii: bag.ascii === true,
          yes: bag.yes === true,
          deviceCode: bag.deviceCode === true,
        },
        () => buildClient(argv),
        {
          usage: usageProblem(verb, positional),
          slug,
          bin: options.bin ?? (typeof bag.$0 === "string" ? bag.$0 : slug),
          ...(options.theme ? { theme: options.theme } : {}),
          ...(options.io ? { io: options.io } : {}),
          ...(options.presentation
            ? { presentation: options.presentation }
            : {}),
          ...(options.print ? { print: options.print } : {}),
        },
      );
      setExitCode(code);
    },
  });

  return {
    command: "polaris-key <command>",
    describe: "Polaris Key commands",
    builder: (yargs: Argv<CommonArgs>) => {
      const groups = new Map<string, CliVerb[]>();
      let y = yargs;
      for (const verb of CLI_VERBS) {
        if (verb.path.length === 1) {
          y = y.command(
            leaf(verb) as unknown as CommandModule<CommonArgs, CommonArgs>,
          );
          continue;
        }
        const word = verb.path[0]!;
        if (!groups.has(word)) groups.set(word, []);
        groups.get(word)!.push(verb);
      }
      for (const [word, verbs] of groups) {
        y = y.command({
          command: `${word} <command>`,
          describe: `[${verbs[0]!.group}] ${word} commands`,
          builder: (g: Argv<CommonArgs>) => {
            let gy = g;
            for (const v of verbs)
              gy = gy.command(
                leaf(v) as unknown as CommandModule<CommonArgs, CommonArgs>,
              );
            return gy.demandCommand(1);
          },
          handler: () => {
            /* group node; subcommand handlers do the work */
          },
        });
      }
      return y.demandCommand(1);
    },
    handler: () => {
      /* group node; subcommand handlers do the work */
    },
  };
}

/** Register the Polaris Key command module on an existing yargs `Argv`. */
export function registerPolarisCommands<T>(
  yargs: Argv<T>,
  factory: ClientFactory,
  options: YargsAdapterOptions,
): Argv<T> {
  return yargs.command(
    polarisCommandModule(factory, options) as CommandModule<T, CommonArgs>,
  );
}
