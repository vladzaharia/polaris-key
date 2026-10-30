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

/** A-22.6: a store Commerce sells through (the default row is the App Store, commerce ready). */
export const channelRow = (over: Partial<ChannelRow> = {}): ChannelRow =>
  channel({
    id: "app-store",
    label: "App Store",
    commerce: { state: "ready", reason: null, attention: [] },
    ...over,
  });

export const channelsView = (...rows: ChannelRow[]): ChannelsView => ({
  ...channels(channel({})),
  channels: rows,
});
