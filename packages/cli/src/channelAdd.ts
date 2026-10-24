/** `pkey channel add`: a stub; A-25.2 replaces this file. */

import type { ChannelArgs, ChannelIo } from "./channel.js";

export function channelAdd(_a: ChannelArgs, io: ChannelIo): number {
  io.stderr.write("pkey channel add: not yet.\n");
  return 2;
}
