/// <reference types="@cloudflare/workers-types" />
/**
 * The one way a registry route answers a read (F-02, plans/F-01.md §6.6 and §6.7): access
 * first, then the cache, then the route's own work.
 *
 *   1. `feedPrincipal` and `authorizeFeedRead` decide, from the 30-second settings cache;
 *   2. a refusal answers `feedRefusal` (the not-found or the native 401), `no-store`;
 *   3. a `public` decision goes through the Cache API (`cachedRegistryAnswer`), unless the route
 *      opts out with `cacheApi: false` (F-08's OCI blobs: ranged, up to 5 GiB);
 *   4. a `private` decision computes every time and forces `private, no-store` on the answer.
 *
 * Because step 1 runs before step 3, a disabled feed or a tightened mode stops even an
 * immutable answer held in the cache, within the settings window.
 */

import {
  FEED_READ_ROUTE,
  type RegistryEcosystem,
  type RegistryRoute,
  type RegistryRouteContext,
  type RegistryRouteMatch,
} from "../../../core/registryHost.js";
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
  /**
   * F-08: `false` keeps a PUBLIC answer out of the Cache API: large content-addressed bytes (OCI
   * blobs, up to 5 GiB) that must honour `Range` and may exceed the Cache API's object limit. The
   * access check still runs first; the answer carries its own immutable headers and handles its
   * own conditionals (`core/blobs.ts` `blobResponse`).
   */
  readonly cacheApi?: false;
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
  if (decision.cache === "public" && opts.cacheApi === false)
    return compute("public");
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

/**
 * What a feed route declares; `feedRoute` supplies the ladder around it. `S` is what the route
 * looks up before the ladder (`resolve`), handed to every other member.
 *
 *   1. `resolve` (optional) reads what the request names (a package name to its deliverable, a
 *      digest to the version holding it). It only reads: it never answers.
 *   2. `serveFeedRead` with `deliverableId(params, state)` and the route's options: the access
 *      ladder, then the Cache API, then `serve`.
 *   3. `finish` (optional) sees every answer, a refusal or a cache hit included: headers the
 *      protocol puts on each (OCI's API version, Swift's Content-Version), or a check of a cached
 *      answer against this request (OCI's and Swift's `Accept`). It runs after the ladder, so it
 *      can never stand in for it.
 */
export interface FeedRouteDef<S = undefined> {
  readonly name: string;
  readonly ecosystem: RegistryEcosystem;
  readonly inertDocument?: true;
  match(pathname: string): RegistryRouteMatch | null;
  /** Before the ladder: what the request names, read from D1 (never an answer). */
  resolve?(req: Request, ctx: RegistryRouteContext): Promise<S>;
  /** The deliverable this request reads, or `null` for a list document or an unknown name. */
  deliverableId(params: Record<string, string>, state: S): string | null;
  readonly queryNames?: readonly string[];
  /** OCI only: the repository under the owner, for the challenge's scope. */
  repository?(params: Record<string, string>, state: S): string | undefined;
  /** F-08's OCI blobs only: keep a public answer out of the Cache API (`FeedReadOptions`). */
  readonly cacheApi?: false;
  /** The request the Cache API keys on, when the route normalises it (Godot's search queries). */
  cacheRequest?(req: Request): Request;
  /** Tests only: a settings source other than D1. */
  readonly settings?: RegistrySettingsSource;
  /** The answer, computed only once the ladder has admitted the read. */
  serve(
    req: Request,
    ctx: RegistryRouteContext,
    cache: "public" | "private",
    state: S,
  ): Promise<Response>;
  /** After the ladder, on every answer (see above). */
  finish?(
    res: Response,
    req: Request,
    ctx: RegistryRouteContext,
    state: S,
  ): Response | Promise<Response>;
}

/**
 * The only way to build a registry route: its `handle` is `serveFeedRead` around `def.serve`, and
 * the result carries `FEED_READ_ROUTE`, which the structural test demands of every
 * `REGISTRY_ROUTES` entry. Every ecosystem's routes (F-04 to F-09) are built here.
 */
export function feedRoute<S = undefined>(def: FeedRouteDef<S>): RegistryRoute {
  return {
    [FEED_READ_ROUTE]: true,
    name: def.name,
    service: "distribution",
    ecosystem: def.ecosystem,
    ...(def.inertDocument ? { inertDocument: true as const } : {}),
    match: (p) => def.match(p),
    handle: async (req, ctx) => {
      const state = (
        def.resolve ? await def.resolve(req, ctx) : undefined
      ) as S;
      const repo = def.repository?.(ctx.params, state);
      const res = await serveFeedRead(
        def.cacheRequest ? def.cacheRequest(req) : req,
        ctx,
        {
          deliverableId: def.deliverableId(ctx.params, state),
          ...(def.queryNames ? { queryNames: def.queryNames } : {}),
          ...(repo !== undefined ? { repository: repo } : {}),
          ...(def.cacheApi === false ? { cacheApi: false as const } : {}),
          ...(def.settings ? { settings: def.settings } : {}),
        },
        (cache) => def.serve(req, ctx, cache, state),
      );
      return def.finish ? def.finish(res, req, ctx, state) : res;
    },
  };
}
