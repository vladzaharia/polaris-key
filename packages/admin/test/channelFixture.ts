/** The channel read model's rows for the channel page's suites (A-22.6): one row, one view. */

import type { ChannelRow, ChannelsView } from "../src/api.js";

export const channelRow = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  id: "app-store",
  label: "App Store",
  inScope: true,
  declared: true,
  oneClick: false,
  notUsing: false,
  delivery: { state: "live", attention: [], platforms: [] },
  commerce: { state: "ready", reason: null, attention: [] },
  identity: null,
  ...over,
});

export const channelsView = (...channels: ChannelRow[]): ChannelsView => ({
  product: "djdl",
  now: 1,
  platforms: [],
  kinds: [],
  channels,
});
