// Commander adapter. `registerPolarisCommands(program, factory)` attaches the four Polaris
// Key subcommands (`activate <key>`, `deactivate`, `status`, `config <key>`) to a commander
// `Command`, building a client from the program's options via `factory` and printing each
// `CommandResult`. `commander` is an OPTIONAL peer dependency — only its TYPES are imported
// (erased at build), so this module compiles + ships without commander installed; a consumer
// that calls this passes in their own `Command` instance.

import type { Command } from "commander";
import {
  activate,
  deactivate,
  getConfig,
  status,
  type ClientFactory,
} from "./commands.js";

/** How the adapter reads CLI-wide options (product/version/baseUrl/configDir) off the
 *  commander program to feed the `ClientFactory`. By default it reads them from the root
 *  program's parsed options; pass `resolveOptions` to source them elsewhere. */
export interface CommanderAdapterOptions {
  /** The pinned trust set the factory needs (kid -> raw Ed25519 pubkey base64url). */
  pinnedKeys: Record<string, string>;
  /** Static product slug + version (falls back to program options when omitted). */
  productSlug?: string;
  version?: string;
  /** Override how per-invocation options are resolved (e.g. from subcommand opts). */
  resolveOptions?: (cmd: Command) => { baseUrl?: string; configDir?: string };
  /** Sink for printed lines + exit-code mapping (defaults to console + `process.exitCode`).*/
  print?: (line: string) => void;
  setExitCode?: (code: number) => void;
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

/** Attach `activate`/`deactivate`/`status`/`config` to `program`, dispatching to the
 *  framework-agnostic core. `factory` builds a client from resolved flags. */
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

  const buildClient = async (cmd: Command) => {
    const opts = rootOpts(cmd);
    const extra = options.resolveOptions?.(cmd) ?? {};
    return factory({
      productSlug: options.productSlug ?? (opts.product as string),
      version: options.version ?? (opts.version as string),
      pinnedKeys: options.pinnedKeys,
      baseUrl: extra.baseUrl ?? (opts.baseUrl as string | undefined),
      configDir: extra.configDir ?? (opts.configDir as string | undefined),
    });
  };

  const emit = (r: { ok: boolean; message: string }) => {
    print(r.message);
    setExitCode(r.ok ? 0 : 1);
  };

  program
    .command("activate <key>")
    .description("Activate this device with a license key")
    .action(async function activateAction(this: Command, key: string) {
      emit(await activate(await buildClient(this), key));
    });

  program
    .command("deactivate")
    .description("Deauthorize this device and wipe local credentials")
    .action(async function deactivateAction(this: Command) {
      emit(await deactivate(await buildClient(this)));
    });

  program
    .command("status")
    .description("Show the current license gate status")
    .action(async function statusAction(this: Command) {
      emit(status(await buildClient(this)));
    });

  program
    .command("config <key>")
    .description("Resolve the effective value of a config key")
    .action(async function configAction(this: Command, key: string) {
      emit(getConfig(await buildClient(this), key));
    });

  return program;
}
