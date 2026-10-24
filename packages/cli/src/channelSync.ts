/** `pkey channel sync`: a stub; A-25.3 replaces this file. */

import type { ChannelArgs, ChannelIo } from "./channel.js";

export function channelSync(_a: ChannelArgs, io: ChannelIo): number {
  io.stderr.write("pkey channel sync is not yet available.\n");
  return 2;
}
