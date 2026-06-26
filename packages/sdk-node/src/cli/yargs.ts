// yargs adapter. `polarisCommandModule(factory, options)` returns a yargs `CommandModule`
// exposing the four Polaris Key subcommands under a `polaris <command>` group, and
// `registerPolarisCommands(yargs, factory, options)` registers that module on an `Argv`.
// `yargs` is an OPTIONAL peer dependency — only its TYPES are imported (erased at build), so
// this module compiles + ships without yargs installed; the consumer supplies the `Argv`.

import type { Argv, ArgumentsCamelCase, CommandModule } from "yargs";
import {
  activate,
  deactivate,
  getConfig,
  status,
  type ClientFactory,
} from "./commands.js";

/** Shared options for the yargs adapter (see the commander adapter for the analog). */
export interface YargsAdapterOptions {
  /** The pinned trust set the factory needs (kid -> raw Ed25519 pubkey base64url). */
  pinnedKeys: Record<string, string>;
  /** Static product slug + version (falls back to parsed args when omitted). */
  productSlug?: string;
  version?: string;
  /** Sink for printed lines + exit-code mapping (defaults to console + `process.exitCode`).*/
  print?: (line: string) => void;
  setExitCode?: (code: number) => void;
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
    });
}

/** Build a yargs `CommandModule` (`polaris <command>`) covering the four subcommands. */
export function polarisCommandModule(
  factory: ClientFactory,
  options: YargsAdapterOptions,
): CommandModule<unknown, CommonArgs> {
  const print = options.print ?? ((line: string) => console.log(line));
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      if (code !== 0) process.exitCode = code;
    });
  const buildClient = makeBuildClient(factory, options);
  const emit = (r: { ok: boolean; message: string }) => {
    print(r.message);
    setExitCode(r.ok ? 0 : 1);
  };

  return {
    command: "polaris <command>",
    describe: "Polaris Key licensing commands",
    builder: (yargs: Argv<CommonArgs>) =>
      yargs
        .command<CommonArgs & { key: string }>({
          command: "activate <key>",
          describe: "Activate this device with a license key",
          handler: async (argv) =>
            emit(await activate(await buildClient(argv), argv.key)),
        })
        .command<CommonArgs>({
          command: "deactivate",
          describe: "Deauthorize this device and wipe local credentials",
          handler: async (argv) =>
            emit(await deactivate(await buildClient(argv))),
        })
        .command<CommonArgs>({
          command: "status",
          describe: "Show the current license gate status",
          handler: async (argv) => emit(status(await buildClient(argv))),
        })
        .command<CommonArgs & { key: string }>({
          command: "config <key>",
          describe: "Resolve the effective value of a config key",
          handler: async (argv) =>
            emit(getConfig(await buildClient(argv), argv.key)),
        })
        .demandCommand(1),
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
