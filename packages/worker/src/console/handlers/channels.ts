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
 * Commerce is off for the product. `live` is CM-21's.
 *
 * Identity (A-28.7): each store channel carries `identity: {fields, source}`, the app its
 * purchases belong to, and a mismatch shows on both facets: `channel.identity_mismatch` as a
 * delivery `attention` `identity_mismatch` (area `ship`, codes only), `storefront.identity_mismatch`
 * as a commerce `attention`. The values are the assigned app's pins, so `identity` and the
 * commerce attention are read only for a session that also sees the `commerce` area.
 */

import { channelLabel } from "@polaris-key/manifest";
import { adminJson, err, notFound } from "../../core/console/respond.js";
import { loadProductPublic } from "../../core/products.js";
import { serviceContext } from "../../core/registry.js";
import { SERVICES } from "../../mount.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import {
  channelFacts,
  outletIdentityMismatches,
  liveBuilds,
  productPlatforms,
} from "../../services/distribution/public.js";
import { storefrontStates } from "../../services/commerce/public.js";
import { can, productScope } from "../authz.js";
import type { AdminCtx } from "../routes.js";
import type {
  ChannelDeliveryAttention,
  ChannelsView,
  ChannelView,
} from "../lib/channelSummary.js";

/** The outlet kinds that carry a store identity, and the channel each one belongs to. */
const OUTLET_CHANNEL: Readonly<Record<string, string>> = {
  "app-store": "app-store",
  play: "google-play",
  "google-play": "google-play",
  "ms-store": "microsoft-store",
  steam: "steam",
};

export interface ChannelsReadOptions {
  /**
   * Read the identity facts (the channels route; the one-product summary leaves them out).
   * `commerce`: the session also sees the commerce area, so the pins may leave.
   */
  identity?: { commerce: boolean };
}

export async function channelsRead(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  opts: ChannelsReadOptions = {},
): Promise<ChannelsView | null> {
  const product = await loadProductPublic(db, slug);
  if (!product) return null;
  const hooks = serviceContext("host", SERVICES, product.services, {
    env,
    db,
    product,
    now,
  }).hooks;
  // Each fact is read once and handed to the delivery facet (the summary rides every product view).
  const builds = await liveBuilds(hooks);
  const facts = await productPlatforms({
    db,
    product: slug,
    hooks,
    now,
    builds,
  });
  const facets = await channelFacts(env, db, slug, hooks, now, {
    facts,
    builds,
  });
  const commerceOn = product.services.commerce?.enabled === true;
  const stores = new Map(
    (await storefrontStates(env, db, slug)).map((s) => [s.channel, s]),
  );
  const distributionOn = product.services.distribution?.enabled === true;
  const outletMismatches =
    opts.identity && distributionOn
      ? await outletIdentityMismatches(db, slug)
      : [];
  const showCommerce = opts.identity?.commerce === true;
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
      const attention: ChannelDeliveryAttention[] = [...f.attention];
      for (const m of outletMismatches)
        if (OUTLET_CHANNEL[m.kind] === f.channel)
          attention.push({ code: "identity_mismatch", field: m.field });
      const mismatched =
        showCommerce && commerceOn && store?.identity.mismatch === true;
      return {
        id: f.channel,
        label: channelLabel(f.channel),
        inScope: f.inScope,
        declared: f.declared,
        oneClick: f.oneClick,
        notUsing: f.notUsing,
        delivery: {
          state: attention.length > 0 ? "attention" : f.state,
          attention,
          platforms: f.platforms,
        },
        commerce: !store
          ? null
          : !commerceOn
            ? { state: "not_set_up", reason: "commerce_off", attention: [] }
            : {
                state: mismatched ? "attention" : store.state,
                reason: store.reason,
                attention: mismatched ? [{ code: "identity_mismatch" }] : [],
              },
        identity:
          showCommerce && store
            ? {
                fields:
                  store.identity.value === null
                    ? {}
                    : { [store.identity.field]: store.identity.value },
                source: store.identity.source,
              }
            : null,
      };
    }),
  };
}

export async function handleChannels(c: AdminCtx): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD")
    return err(405, "method_not_allowed", "the channels read is read-only");
  const view = await channelsRead(c.env, c.db, c.product!.slug, c.now, {
    identity: {
      commerce: can(
        c.session.principal,
        productScope(c.product!),
        "commerce",
        "view",
      ),
    },
  });
  if (!view) return notFound();
  return adminJson({ product: c.product!.slug, now: c.now, ...view });
}
