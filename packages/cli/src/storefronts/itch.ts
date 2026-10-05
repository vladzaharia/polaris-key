/**
 * itch.io's CI-plane command plan (A-18h; notes/S-15 §4.4): `butler push <dir>
 * <user/game>:<channel> --userversion <version>`. The target comes from the outlet identity
 * (`.pkey/distribution` `itch.target`), never from a flag; the channel name starts with the
 * platform, which is how itch.io tags the upload (`windows`, `linux`, `mac`, `android`), and a
 * release channel other than `stable` suffixes it (`windows-beta`), so each release channel keeps
 * its own file on the page. butler reads its unscoped key from `BUTLER_API_KEY`, a CI environment
 * secret; it is never on the command line and never in Polaris Key.
 */

import { ciStore } from "./allowList.js";
import type { StepOutlet } from "./outlets.js";
import type { StoreStep } from "./run.js";

/** The platform words itch.io recognises at the start of a channel name. */
export const ITCH_PLATFORMS = ["windows", "linux", "mac", "android"] as const;
export type ItchPlatform = (typeof ITCH_PLATFORMS)[number];

const CHANNEL_SUFFIX = /^[a-z0-9]{1,32}$/;

/** The butler channel for a platform and release channel. */
export function itchChannel(platform: string, channel?: string): string {
  if (!(ITCH_PLATFORMS as readonly string[]).includes(platform))
    throw new Error(
      `--platform must be one of ${ITCH_PLATFORMS.join(", ")} (got ${JSON.stringify(platform)}): itch.io tags an upload by its channel's platform word.`,
    );
  if (channel === undefined || channel === "stable") return platform;
  const suffix = channel.toLowerCase();
  if (!CHANNEL_SUFFIX.test(suffix))
    throw new Error(
      `--channel ${JSON.stringify(channel)} cannot suffix a butler channel (1-32 lower-case letters and digits).`,
    );
  return `${platform}-${suffix}`;
}

export interface ItchPushOptions {
  outlet: StepOutlet;
  dir: string;
  platform: string;
  channel?: string;
  version: string;
}

/** The one step of an itch.io build: a butler push to the outlet's game. */
export function itchPushStep(o: ItchPushOptions): StoreStep {
  const store = ciStore("itch")!;
  const target = o.outlet.identity.target;
  if (typeof target !== "string")
    throw new Error(
      `outlet ${o.outlet.id} has no target: set .pkey/distribution outlets.${o.outlet.id}.target to the butler user/game.`,
    );
  return {
    store: "itch",
    op: "uploadBuild",
    command: "push",
    tool: store.list.tool,
    argv: [
      "push",
      o.dir,
      `${target}:${itchChannel(o.platform, o.channel)}`,
      "--userversion",
      o.version,
    ],
    outlet: o.outlet,
  };
}
