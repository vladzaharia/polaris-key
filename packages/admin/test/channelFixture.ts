/** Shared channel-page test fixtures (A-22): a channel row and the channels read around it. */

import type { ChannelRow, ChannelsView } from "../src/api.js";

export const channel = (over: Partial<ChannelRow>): ChannelRow => ({
  id: "polaris-key",
  label: "Polaris Locker",
  inScope: true,
  declared: true,
  oneClick: false,
  notUsing: false,
  delivery: { state: "live", attention: [], platforms: [] },
  commerce: null,
  identity: null,
  ...over,
});

export const channels = (c: ChannelRow): ChannelsView => ({
  product: "djdl",
  now: 1,
  platforms: [],
  kinds: [],
  channels: [c],
});
