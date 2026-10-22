// yargs adapter, at `@polaris-key/node/cli/yargs`. `polarisCommands(options)` returns yargs
// command modules for the Polaris Key verbs (the end-user set at the root, or nested under
// `namespace`), and `registerPolarisCommands(yargs, options)` registers them on an `Argv`. Each
// verb runs the terminal kit's flow (the rail, the masked key prompt, `--json`), exactly as the
// commander adapter does: both call `runKitVerb`. `yargs` is an OPTIONAL peer dependency: only
// its TYPES are imported (erased at build), so this module compiles and ships without yargs
// installed, and a project on commander alone never loads these types (the barrel `./cli` does not
// export this module).
//
// Same verbs, mount rules and gate as the commander adapter; both build from `CLI_VERBS`
// (`kit.ts`) through `planMount` (`mount.ts`) and neither declares a verb. yargs prints its
// commands in registration order and has no headings for them, so the host's commands come first
// when the host registers them before the kit's.

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
import { bindGate } from "./gate.js";
import { createKitContextSync } from "./context.js";
import { describeVerb, GROUP_HEADINGS, VERB_OPTIONS } from "./help.js";
import { argName, type CliIO, type CliVerb } from "./kit.js";
import {
  clientFactoryFor,
  DEFAULT_ACTION,
  planMount,
  reportSkipped,
  verbId,
  type MountOptions,
} from "./mount.js";
import type { ServiceSlug } from "../discovery.js";

/** Shared options for the yargs adapter (see the commander adapter for the analog). */
export interface YargsAdapterOptions extends KitAdapterOptions, MountOptions {
  /** The pinned trust set the factory needs (kid -> raw Ed25519 pubkey base64url). Not needed
   *  with `config`, which carries them. */
  pinnedKeys?: Record<string, string>;
  /** The host's own top-level command words, to check for a collision. Read from the `Argv`
   *  when registering through `registerPolarisCommands` (best effort); give it to
   *  `polarisCommands`, which has no `Argv`. */
  hostCommands?: readonly string[];
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
      productSlug:
        options.productSlug ??
        options.config?.productSlug ??
        (argv.product as string),
      version: options.version ?? (argv.version as string),
      pinnedKeys:
        options.pinnedKeys ??
        options.config?.trust?.pinnedKeys ??
        ({} as never),
      // A config says where the control plane is; the flag it hides does not override it.
      baseUrl: options.config ? options.config.baseUrl : argv.baseUrl,
      configDir: argv.configDir,
      expectedServices:
        options.expectedServices ?? options.config?.expectedServices,
    });
}

const camel = (s: string): string =>
  s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()); // ui-lint: allow terminal-uppercase camel-cases an option name, not copy

/**
 * What yargs parsed that the verb does not take: an option it never declared (yargs keeps it in
 * the argv bag, as `--name`) and the operands past the verb's own words. `usageProblem` turns
 * either into the kit's usage result.
 */
function strays(verb: CliVerb, bag: Record<string, unknown>): string[] {
  const known = new Set([
    "_",
    "$0",
    "help",
    "version",
    "json",
    "color",
    "ascii",
    "product",
    "baseUrl",
    "base-url",
    "configDir",
    "config-dir",
  ]);
  for (const a of verb.args) known.add(argName(a));
  for (const o of VERB_OPTIONS[verb.path[0]!] ?? []) {
    const { name, alias } = yargsOption(o.flags);
    known.add(name).add(camel(name));
    if (alias) known.add(alias);
  }
  const words = Array.isArray(bag._) ? (bag._ as unknown[]).map(String) : [];
  const operands = words.slice(verb.path.length);
  return [
    ...operands,
    ...Object.keys(bag)
      .filter((k) => !known.has(k) && !known.has(camel(k)))
      .map((k) => `${k.length === 1 ? "-" : "--"}${k}`),
  ];
}

/** yargs spells a variadic positional `[name..]`; the table uses commander's `[name...]`. */
const yargsArg = (spec: string): string => spec.replace("...", "..");

/** `-y, --yes` → the long name yargs declares (`yes`), with its alias. */
function yargsOption(flags: string): { name: string; alias?: string } {
  const long = /--([a-z-]+)/.exec(flags)?.[1] ?? flags;
  const short = /(?:^|\s)-([a-z])\b/.exec(flags)?.[1];
  return short ? { name: long, alias: short } : { name: long };
}

/**
 * The yargs command modules for the Polaris Key verbs: pass the result to `.command()`. One module
 * per top-level word at the root, or one `<namespace> <command>` module. Give `config` (your
 * generated `polarisConfig`) and a `version`, or a `factory` that builds a client from the flags.
 */
export function polarisCommands(
  options: YargsAdapterOptions,
): CommandModule<unknown, CommonArgs>[];
export function polarisCommands(
  factory: ClientFactory,
  options: YargsAdapterOptions,
): CommandModule<unknown, CommonArgs>[];
export function polarisCommands(
  a: ClientFactory | YargsAdapterOptions,
  b?: YargsAdapterOptions,
): CommandModule<unknown, CommonArgs>[] {
  const options = typeof a === "function" ? b! : a;
  const factory = typeof a === "function" ? a : clientFactoryFor(options);
  const namespace = options.namespace;
  const plan = planMount(options.hostCommands ?? [], options, options.bin);
  reportSkipped(plan, options, options.bin ?? "mytool");
  const verbs = plan.verbs;
  // Help text in the catalog's words (the kit's own help pages are the commander adapter's).
  const helpCtx = createKitContextSync({
    slug: options.productSlug ?? options.config?.productSlug ?? "polaris-key",
    bin: options.bin ?? "mytool",
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.io ? { io: options.io } : {}),
    queryScheme: false,
  });
  // What people type before a verb: under a namespace, the namespace too.
  const binOf = (bin: string): string =>
    namespace ? `${options.bin ?? bin} ${namespace}` : (options.bin ?? bin);
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
    // A bare group runs its default action (`devices` lists, `update` checks), as the Python kit does.
    command:
      kit &&
      verb.path.length > 1 &&
      DEFAULT_ACTION[verb.path[0]!] === verb.path[1]
        ? [
            [
              verb.path.at(-1)!,
              ...verb.args.map((a) => yargsArg(optionalArg(a))),
            ].join(" "),
            "$0",
          ]
        : [
            verb.path.at(-1)!,
            ...verb.args.map((a) => yargsArg(kit ? optionalArg(a) : a)),
          ].join(" "),
    aliases: verb.aliases ?? [],
    describe: kit
      ? describeVerb(helpCtx, verb)
      : `[${verb.group}] ${verb.describe}`,
    builder: (y: Argv<CommonArgs>) => {
      if (!kit)
        return verb.path[0] === "secret" || verb.path[0] === "mint"
          ? y.option("reveal", { type: "boolean" })
          : y;
      // Unknown options reach the kit, which ends in its usage line (and `--json` result), even
      // when the host's parser is strict.
      let b = y
        .strict(false)
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
        const r = await verb.run(await buildClient(argv), positional, {
          ...io,
          reveal: bag.reveal === true,
        });
        print(r.message);
        setExitCode(r.ok ? 0 : 1);
        return;
      }
      const slug =
        options.productSlug ??
        options.config?.productSlug ??
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
          allowWorkflowCommands: bag.allowWorkflowCommands === true,
          reveal: bag.reveal === true,
        },
        () => buildClient(argv),
        {
          usage: usageProblem(verb, positional, strays(verb, bag)),
          slug,
          bin: binOf(typeof bag.$0 === "string" ? bag.$0 : slug),
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
    },
  });

  /** The modules for `vs`: a leaf for a one-word verb, a group for each multi-word first word. */
  const modulesFor = (
    vs: readonly CliVerb[],
  ): CommandModule<CommonArgs, CommonArgs>[] => {
    const out: CommandModule<CommonArgs, CommonArgs>[] = [];
    const groups = new Map<string, CliVerb[]>();
    for (const verb of vs) {
      if (verb.path.length === 1) {
        out.push(
          leaf(verb) as unknown as CommandModule<CommonArgs, CommonArgs>,
        );
        continue;
      }
      const word = verb.path[0]!;
      if (!groups.has(word)) groups.set(word, []);
      groups.get(word)!.push(verb);
    }
    for (const [word, inGroup] of groups)
      out.push({
        command: `${word} <command>`,
        describe: kit
          ? helpCtx.copy.t(
              GROUP_HEADINGS.find(([g]) => g === inGroup[0]!.group)![1],
            )
          : `[${inGroup[0]!.group}] ${word} commands`,
        builder: (g: Argv<CommonArgs>) => {
          let gy = g;
          for (const v of inGroup)
            gy = gy.command(
              leaf(v) as unknown as CommandModule<CommonArgs, CommonArgs>,
            );
          return gy.demandCommand(
            inGroup.some((v) => DEFAULT_ACTION[word] === v.path[1]) ? 0 : 1,
          );
        },
        handler: () => {
          /* group node; subcommand handlers do the work */
        },
      });
    return out;
  };

  bindGate(null, {
    client: (argv) => buildClient(argv as ArgumentsCamelCase<CommonArgs>),
    slug: options.productSlug ?? options.config?.productSlug ?? "polaris-key",
    bin: binOf(
      options.productSlug ?? options.config?.productSlug ?? "polaris-key",
    ),
    mounted: verbs.map(verbId),
    ...(options.io ? { io: options.io } : {}),
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.presentation ? { presentation: options.presentation } : {}),
    ...(options.frame === false ? { frame: false } : {}),
    setExitCode,
  });

  if (!namespace)
    return modulesFor(verbs) as CommandModule<unknown, CommonArgs>[];
  return [
    {
      command: `${namespace} <command>`,
      describe: kit ? helpCtx.copy.t("cli.help.namespace") : "License commands",
      builder: (y: Argv<CommonArgs>) => {
        let b = y;
        for (const m of modulesFor(verbs)) b = b.command(m);
        return b.demandCommand(1);
      },
      handler: () => {
        /* group node; subcommand handlers do the work */
      },
    } as CommandModule<unknown, CommonArgs>,
  ];
}

/** The top-level command words a yargs instance already has, as far as yargs lets us see. */
function hostWordsOf(y: unknown): string[] {
  try {
    const m = (
      y as {
        getInternalMethods?: () => {
          getCommandInstance?: () => { getCommands?: () => string[] };
        };
      }
    ).getInternalMethods?.();
    return m?.getCommandInstance?.().getCommands?.() ?? [];
  } catch {
    return [];
  }
}

/** Register the Polaris Key commands on an existing yargs `Argv`. */
export function registerPolarisCommands<T>(
  yargs: Argv<T>,
  options: YargsAdapterOptions,
): Argv<T>;
export function registerPolarisCommands<T>(
  yargs: Argv<T>,
  factory: ClientFactory,
  options: YargsAdapterOptions,
): Argv<T>;
export function registerPolarisCommands<T>(
  yargs: Argv<T>,
  a: ClientFactory | YargsAdapterOptions,
  b?: YargsAdapterOptions,
): Argv<T> {
  const options = typeof a === "function" ? b! : a;
  const withHost: YargsAdapterOptions = {
    ...options,
    hostCommands: [...(options.hostCommands ?? []), ...hostWordsOf(yargs)],
  };
  const modules =
    typeof a === "function"
      ? polarisCommands(a, withHost)
      : polarisCommands(withHost);
  return yargs.command(modules as unknown as CommandModule<T, CommonArgs>[]);
}
