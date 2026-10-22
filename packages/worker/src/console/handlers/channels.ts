/**
 * `GET /manage/api/products/<slug>/distribution/channels` (A-20.4): one product's channel read
 * model. Which channels the product can use (those whose platforms and deliverable kinds it
 * shares), and for each the delivery facet (Distribution's `channelFacts`) beside the commerce
 * facet (Commerce's `storefrontStates`). Put together here because a service may not read another
 * (rule 6): this is the one layer that sees both through their `public.ts`.
 *
 * Area `ship`. Credential facts leave only as booleans and reason codes (`oneClick`, an
 * `attention` code): no key id, issuer, credential id or app name is in the body. The labels are
 * the catalogue's.
 *
 * The commerce facet is minimal: `null` for a channel with no commerce facet, `not_set_up` /
 * `ready` for a store Commerce sells through, `not_set_up` with reason `commerce_off` while
 * Commerce is off for the product. `live` and `attention` are CM-21's.
 */

import { CHANNELS } from "@polaris-key/manifest";
import { adminJson, err, notFound } from "../../core/console/respond.js";
import { loadProductPublic } from "../../core/products.js";
import { serviceContext } from "../../core/registry.js";
import { SERVICES } from "../../mount.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import {
  channelFacts,
  productPlatforms,
  type DeliveryAttention,
  type DeliveryState,
} from "../../services/distribution/public.js";
import { storefrontStates } from "../../services/commerce/public.js";
import type { AdminCtx } from "../routes.js";

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

const LABELS = new Map<string, string>(CHANNELS.map((c) => [c.id, c.label]));

export async function channelsRead(
  env: Env,
  db: Db,
  slug: string,
  now: number,
): Promise<ChannelsView | null> {
  const product = await loadProductPublic(db, slug);
  if (!product) return null;
  const hooks = serviceContext("host", SERVICES, product.services, {
    env,
    db,
    product,
    now,
  }).hooks;
  const [facts, facets] = await Promise.all([
    productPlatforms({ db, product: slug, hooks, now }),
    channelFacts(env, db, slug, hooks, now),
  ]);
  const commerceOn = product.services.commerce?.enabled === true;
  const stores = new Map(
    (await storefrontStates(env, db, slug)).map((s) => [s.channel, s]),
  );
  return {
    platforms: facts.platforms.map((p) => ({
      platform: p.platform,
      arches: p.arches,
      formats: p.formats,
      sources: p.sources,
    })),
    kinds: facts.kinds,
    channels: facets.map((f): ChannelView => {
      const store = stores.get(f.channel);
      return {
        id: f.channel,
        label: LABELS.get(f.channel) ?? f.channel,
        inScope: f.inScope,
        declared: f.declared,
        oneClick: f.oneClick,
        notUsing: f.notUsing,
        delivery: {
          state: f.state,
          attention: f.attention,
          platforms: f.platforms,
        },
        commerce: !store
          ? null
          : !commerceOn
            ? { state: "not_set_up", reason: "commerce_off" }
            : { state: store.state, reason: store.reason },
      };
    }),
  };
}

/** The compact rows the one-product summary carries (`productView`). */
export function compactChannels(view: ChannelsView) {
  return view.channels.map((c) => ({
    id: c.id,
    label: c.label,
    delivery: c.delivery.state,
    commerce: c.commerce ? c.commerce.state : null,
    oneClick: c.oneClick,
    notUsing: c.notUsing,
  }));
}

export async function handleChannels(c: AdminCtx): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD")
    return err(405, "method_not_allowed", "the channels read is read-only");
  const view = await channelsRead(c.env, c.db, c.product!.slug, c.now);
  if (!view) return notFound();
  return adminJson({ product: c.product!.slug, now: c.now, ...view });
}
