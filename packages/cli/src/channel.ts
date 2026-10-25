/**
 * `pkey channel …` (A-25.2, A-25.3): one command, one dispatcher.
 *
 *   channel add <id>    append the channel's outlet to .pkey/distribution (`channelAdd.ts`)
 *   channel sync        run the steps the declared channels have: PR steps, and --dir uploads (`channelSync.ts`)
 */

import path from "node:path";
import type { ValidationMessage } from "@polaris-key/manifest";
import { envelope } from "./account.js";
import type { Out, Sleep } from "./ci.js";
import type { SpawnTool } from "./storefronts/run.js";
import type { CiEnv } from "./oidc.js";
import { failLine, termFor, type Term, type TermOut } from "./terminal.js";
import { UsageError } from "./errors.js";
import type { LoadedManifest } from "./manifest.js";
import { nearest } from "./suggest.js";
import { channelAdd } from "./channelAdd.js";
import { channelSync } from "./channelSync.js";

export const ADD_USAGE =
  "Usage: pkey channel add <id> [--field name=value ...] [--outlet-id id] [--json]";
export const SYNC_USAGE =
  "Usage: pkey channel sync [--channel c] [--version v] [--dir d] [--deliverable packId [--from dir]] [--product slug] [--base-url url] [--dry-run] [--json]";
export const CHANNEL_USAGE = `${ADD_USAGE}\n       ${SYNC_USAGE.replace("Usage: ", "")}`;

export interface ChannelArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  /** Every string value of a repeatable flag (`--field a=1 --field b=2`), in order. */
  multi: Record<string, string[]>;
}

export interface ChannelIo {
  cwd: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  /** The test seam for the vendor tool (butler, snapcraft). */
  spawnTool?: SpawnTool;
  /** Test seams for the transports: the host platform and `xcrun` (Background Assets package). */
  platform?: NodeJS.Platform;
  exec?: (cmd: string, args: string[], cwd: string) => void;
  /** The terminal behind a stream (colour, symbols, width), honouring --no-color and --ascii. */
  term?: (out: TermOut) => Term;
}

/** `pkey channel …`. */
export async function cmdChannel(
  a: ChannelArgs,
  io: ChannelIo,
): Promise<number> {
  const [sub] = a.positional;
  if (sub === "add") return channelAdd(a, io);
  if (sub === "sync") return channelSync(a, io);
  throw new UsageError(CHANNEL_USAGE);
}

/** The terminal behind a stream, honouring the test seam. */
export function termOf(io: ChannelIo, out: Out): Term {
  return (io.term ?? ((o: TermOut) => termFor(o, io.env)))(out as TermOut);
}

/**
 * Refuse an option the subcommand does not take, as every other command does: exit 2 with
 * `✗  Unknown option --dryrun. Did you mean --dry-run?`. `null` when all is well.
 */
export function unknownOption(
  a: ChannelArgs,
  io: ChannelIo,
  known: readonly string[],
): number | null {
  const unknown = Object.keys(a.flags).find((k) => !known.includes(k));
  if (unknown === undefined) return null;
  const near = nearest(unknown, known);
  io.stderr.write(
    failLine(
      `Unknown option --${unknown}.${near ? ` Did you mean --${near}?` : " Run pkey help channel to see the options."}`,
      termOf(io, io.stderr),
    ),
  );
  return 2;
}

/** What `pkey validate --json` calls a manifest it could not read. */
export function manifestError(e: unknown): {
  error: "no-manifest" | "unreadable-manifest" | "invalid-manifest";
  message: string;
} {
  const message = (e as Error).message;
  return {
    error: /^\.pkey\/ (?:is invalid|does not parse)/.test(message)
      ? "invalid-manifest"
      : /not valid (?:JSON|YAML)/.test(message)
        ? "unreadable-manifest"
        : "no-manifest",
    message,
  };
}

/** In `--json` mode a manifest that cannot be read is validate's shape, exit 1; else it throws on. */
export function manifestFailure(
  command: string,
  e: unknown,
  io: ChannelIo,
  json: boolean,
): number {
  if (!json || e instanceof UsageError) throw e;
  io.stdout.write(envelope(command, 1, manifestError(e)));
  return 1;
}

/** The file a validation message points into, relative to `cwd`, or null. */
export function messageFile(
  m: LoadedManifest,
  msg: ValidationMessage,
  cwd: string,
): string | null {
  const file = {
    product: m.productPath,
    schema: m.schemaPath,
    release: m.releasePath,
    distribution: m.distributionPath,
  }[msg.file];
  return file ? path.relative(cwd, file) : null;
}

/** A validation message in `pkey validate --json`'s shape. */
export function messageEntry(
  m: LoadedManifest,
  msg: ValidationMessage,
  cwd: string,
): { code: string; message: string; at: string; file: string | null } {
  return {
    code: msg.code,
    message: msg.message,
    at: `${msg.file}${msg.path}`,
    file: messageFile(m, msg, cwd),
  };
}

/** A validation error in `pkey validate`'s line. */
export function errorLine(
  m: LoadedManifest,
  msg: ValidationMessage,
  cwd: string,
  term: Term,
): string {
  const file = messageFile(m, msg, cwd);
  return `${term.painter.style(term.symbols.fail, ["danger"])}  error ${msg.file}${msg.path}${file ? ` (${file})` : ""}: ${msg.message}`;
}
