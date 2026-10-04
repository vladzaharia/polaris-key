/// <reference types="@cloudflare/workers-types" />
/**
 * The one way a registry route answers a read (F-02, plans/F-01.md §6.6 and §6.7): access
 * first, then the cache, then the route's own work.
 *
 *   1. `feedPrincipal` and `authorizeFeedRead` decide, from the 30-second settings cache;
 *   2. a refusal answers `feedRefusal` (the not-found or the native 401), `no-store`;
 *   3. a `public` decision goes through the Cache API (`cachedRegistryAnswer`);
 *   4. a `private` decision computes every time and forces `private, no-store` on the answer.
 *
 * Because step 1 runs before step 3, a disabled feed or a tightened mode stops even an
 * immutable answer held in the cache, within the settings window.
 */

import type { RegistryRouteContext } from "../../../core/registryHost.js";
import { authorizeFeedRead, feedPrincipal, feedRefusal } from "./authorize.js";
import {
  PRIVATE_CACHE_CONTROL,
  cachedRegistryAnswer,
  conditional,
  registryCacheKey,
} from "./cache.js";
import type { RegistrySettingsSource } from "./settings.js";

export interface FeedReadOptions {
  /** The deliverable read, or `null` for a list document (only the feed's mode counts). */
  readonly deliverableId: string | null;
  /** The query parameters the answer depends on (part of the cache key). */
  readonly queryNames?: readonly string[];
  /** OCI only: the repository under the owner, for the challenge's scope. */
  readonly repository?: string;
  /** Tests only: a settings source other than D1. */
  readonly settings?: RegistrySettingsSource;
}

/**
 * Answer one read. `compute(cache)` builds the answer, given whether it is public, with
 * `registryCacheHeaders` for its headers.
 */
export async function serveFeedRead(
  req: Request,
  ctx: RegistryRouteContext,
  opts: FeedReadOptions,
  compute: (cache: "public" | "private") => Promise<Response>,
): Promise<Response> {
  const decision = await authorizeFeedRead(
    {
      db: ctx.db,
      services: ctx.product.services,
      ...(opts.settings ? { settings: opts.settings } : {}),
    },
    feedPrincipal(req),
    ctx.product.slug,
    ctx.ecosystem,
    opts.deliverableId,
  );
  if (!decision.ok)
    return feedRefusal(decision.challenge, {
      env: ctx.env,
      ecosystem: ctx.ecosystem,
      owner: ctx.product.slug,
      ...(opts.repository !== undefined ? { repository: opts.repository } : {}),
    });
  if (decision.cache === "public")
    return cachedRegistryAnswer(
      req,
      registryCacheKey(req, ctx.ecosystem, opts.queryNames),
      () => compute("public"),
    );
  const res = await compute("private");
  const headers = new Headers(res.headers);
  headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  headers.delete("etag");
  return conditional(
    req,
    new Response(req.method === "HEAD" ? null : res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    }),
  );
}
