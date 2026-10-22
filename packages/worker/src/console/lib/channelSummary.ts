/**
 * The channel read model's shapes and the compact rows the one-product summary carries. Shared by
 * the channels handler (`handlers/channels.ts`, which builds the view) and `lib/shape.ts` (which
 * renders the summary), so neither imports the other.
 */

import type {
  DeliveryAttention,
  DeliveryState,
} from "../../services/distribution/public.js";

export interface ChannelCommerceFacet {
  state: "not_set_up" | "ready";
  reason: "no_settings" | "no_credential" | "commerce_off" | null;
}

export interface ChannelView {
  id: string;
  label: string;
  inScope: boolean;
  declared: boolean;
  oneClick: boolean;
  notUsing: boolean;
  delivery: {
    state: DeliveryState;
    attention: DeliveryAttention[];
    platforms: { platform: string; arches: string[] }[];
  };
  commerce: ChannelCommerceFacet | null;
}

export interface ChannelsView {
  platforms: {
    platform: string;
    arches: string[];
    formats: string[];
    sources: string[];
  }[];
  kinds: string[];
  channels: ChannelView[];
}

/**
 * The compact rows the one-product summary (`productView`) carries. `GET /products/:slug` is an
 * `anyArea` row, so these reach holders of any area (D7): the nav's facts only (id, label, the
 * delivery state, the operator's not-using choice). The credential-derived `oneClick` and the
 * commerce facet stay on the `ship`-gated `…/distribution/channels` read.
 */
export function compactChannels(view: ChannelsView) {
  return view.channels.map((c) => ({
    id: c.id,
    label: c.label,
    delivery: c.delivery.state,
    notUsing: c.notUsing,
  }));
}
