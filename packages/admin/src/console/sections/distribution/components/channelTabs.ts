/**
 * The channel page's tab registry (A-22): one line per built tab, each tab its own file. A later
 * slice adds its line here and nothing else. The URL already knows every tab (`CHANNEL_TAB_IDS`);
 * a tab that is not listed here does not show, and its address opens Status.
 */

import type * as React from "react";
import type { ChannelRow } from "../../../../api.js";
import type { CHANNEL_TAB_IDS } from "../../../nav.js";
import { ChannelListing } from "./ChannelListing.js";
import { ChannelReleases } from "./ChannelReleases.js";
import { ChannelStatus } from "./ChannelStatus.js";

export type ChannelTabId = (typeof CHANNEL_TAB_IDS)[number];

export interface ChannelTabProps {
  slug: string;
  /** The product's display name. */
  name: string;
  channel: ChannelRow;
}

export interface ChannelTab {
  value: ChannelTabId;
  label: string;
  Panel: React.ComponentType<ChannelTabProps>;
}

export const CHANNEL_TABS: readonly ChannelTab[] = [
  { value: "status", label: "Status", Panel: ChannelStatus },
  { value: "releases", label: "Releases", Panel: ChannelReleases },
  { value: "listing", label: "Listing", Panel: ChannelListing },
];
