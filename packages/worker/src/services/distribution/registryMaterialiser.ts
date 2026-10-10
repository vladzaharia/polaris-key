/**
 * Distribution's `registryMaterialiser` (`core/registry.ts`): the consumer of the package-feed
 * render queue, the piece F-02 and F-03 each left to the other (plans/F-01.md §6.5).
 *
 * Core reads `registry_render_queue` (`core/registry/registryQueue.ts` `drainRenderQueue`) after every
 * request that enqueued and on every cron tick, and hands one owner's rows here. This file turns
 * them into F-02's framework calls: `drainRegistry` over the feed adapters' renderers
 * (`registry/index.ts` `RENDERERS`), Release's state through the `releaseCatalog` hook, and each
 * feed's settings for the renderers whose stamp covers them (Godot's). `selfCheck` re-renders the
 * packages whose stored stamp no longer matches D1, for owners whose package feeds are on.
 *
 * NOTHING TO RENDER IS NOT A FAILURE. With no blob bucket, no registry host (`PKG_ORIGIN`) or
 * Release off, a row renders nothing and is consumed: the stamp-checked read path renders on
 * demand once the missing piece exists, and the next settings or `packageFeeds` write enqueues a
 * full render.
 */

import type {
  RegistryMaterialiser,
  ScheduledServiceContext,
} from "../../core/registry.js";
import type { QueuedRender } from "../../core/registry/registryQueue.js";
import { registryOrigin } from "../../core/registry/registryHostname.js";
import { catalogPackageSource } from "./registry/catalogSource.js";
import { RENDERERS } from "./registry/index.js";
import {
  drainRegistry,
  selfCheck,
  type MaterialiseDeps,
  type RegistryQueue,
} from "./registry/materialise.js";
import {
  cachedRegistrySettings,
  d1RegistrySettings,
} from "./registry/settings.js";
import { packageFeedsOf } from "./registryFeeds.js";

/** Everything a render of `ctx.product`'s packages needs, or `null` when nothing can render. */
export function materialiseDepsFor(
  ctx: ScheduledServiceContext,
): MaterialiseDeps | null {
  const bucket = ctx.env.BLOBS;
  const origin = registryOrigin(ctx.env);
  const catalog = ctx.hooks.releaseCatalog();
  if (!bucket || origin === null || !catalog) return null;
  const settings = d1RegistrySettings(ctx.db);
  return {
    bucket,
    renderers: RENDERERS,
    source: catalogPackageSource(catalog, ctx.product.slug),
    origin,
    // The same read the Godot routes make, so a drained render and a read-path render stamp alike.
    feed: async (owner, ecosystem) => {
      const { feed } = await cachedRegistrySettings(settings, owner, ecosystem);
      return feed ? { namespace: feed.namespace, ext: feed.ext } : null;
    },
  };
}

export const registryMaterialiser: RegistryMaterialiser = {
  async drain(ctx, rows, consume) {
    const deps = materialiseDepsFor(ctx);
    if (!deps) {
      for (const row of rows) await consume(row);
      return { rendered: 0, failed: 0 };
    }
    const byKey = new Map<string, QueuedRender>(
      rows.map((r) => [`${r.product}\u0000${r.deliverableId}`, r]),
    );
    const queue: RegistryQueue = {
      pending: async () =>
        rows.map((r) => ({
          product: r.product,
          deliverableId: r.deliverableId,
          enqueuedAt: r.enqueuedAt,
          generation: r.generation,
        })),
      consumed: async (product, deliverableId) => {
        const row = byKey.get(`${product}\u0000${deliverableId}`);
        if (row) await consume(row);
      },
    };
    return drainRegistry(queue, deps, {
      limit: rows.length,
      now: () => ctx.now,
    });
  },

  async selfCheck(ctx, limit) {
    if (limit <= 0) return 0;
    if (!(await packageFeedsOf(ctx.db, ctx.product.slug)).enabled) return 0;
    const deps = materialiseDepsFor(ctx);
    if (!deps?.source.deliverables) return 0;
    const ids = await deps.source.deliverables(ctx.product.slug);
    const done = await selfCheck(
      deps,
      ids.map((deliverableId) => ({
        product: ctx.product.slug,
        deliverableId,
      })),
      limit,
    );
    return done.length;
  },
};
