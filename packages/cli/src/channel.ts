/**
 * `pkey channel …` (A-25.2, A-25.3): one command, one dispatcher.
 *
 *   channel add <id>    append the channel's outlet to .pkey/distribution (`channelAdd.ts`)
 *   channel sync        run the steps the declared channels have: PR steps, and --dir uploads (`channelSync.ts`)
 */

import type { Out, Sleep } from "./ci.js";
import type { SpawnTool } from "./storefronts/run.js";
import type { CiEnv } from "./oidc.js";
import type { Term, TermOut } from "./terminal.js";
import { UsageError } from "./errors.js";
import { channelAdd } from "./channelAdd.js";
import { channelSync } from "./channelSync.js";

export const CHANNEL_USAGE =
  "Usage: pkey channel add <id> [--field name=value ...] [--outlet-id id] [--json]\n" +
  "       pkey channel sync [--channel c] [--version v] [--dir d] [--dry-run] [--json]";

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
