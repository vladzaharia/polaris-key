/// <reference types="@cloudflare/workers-types" />
/**
 * How a native publish route is built (F-22): the gate every one passes before its adapter runs.
 *
 *   1. the feed: the owner's feed of the ecosystem must answer (Distribution, `packageFeeds`, the
 *      feed and the platform's kill switch all on, read through the `delivery` hook); otherwise
 *      the host's not-found, the same as a read of a feed that is off or absent;
 *   2. the credential (`core/registryPublish.ts`), before any body is read: the client's native
 *      401 challenge, a 403, or a 429;
 *   3. the `registryPublish` budget per publishing token (fail closed: each request writes to the
 *      blob store);
 *   4. the adapter, with the principal and the feed.
 *
 * Every route built here carries `FEED_PUBLISH_ROUTE`, names `service: "release"` and declares its
 * one write method; `test/registryHost.test.ts` admits exactly these beside the read and
 * credential routes.
 */

import type { PackageEcosystem } from "@polaris-key/manifest";
import { errorResponse, json } from "../../../../core/errors.js";
import { clientIp, rateLimitOk } from "../../../../core/rateLimit.js";
import {
  FEED_PUBLISH_ROUTE,
  registryHostname,
  registryNotFound,
  type RegistryRoute,
  type RegistryRouteContext,
  type RegistryRouteMatch,
  type RegistryWriteMethod,
} from "../../../../core/registryHost.js";
import type { PackageFeedSettings } from "../../../../core/hooks.js";
import {
  authorizeRegistryPublish,
  type PublishPrincipal,
} from "../../../../core/registryPublish.js";
import { answeringFeed, type NativeRefusal } from "./publish.js";

/** `registryPublish` (per publishing token): a Maven deploy is ~25 PUTs per artifact. */
const PUBLISH_LIMIT = { limit: 600, windowSec: 60 };
const RETRY_AFTER = "30";

/** What a publish adapter's handler receives once the gate passed. */
export interface PublishCall {
  readonly req: Request;
  readonly ctx: RegistryRouteContext;
  readonly principal: PublishPrincipal;
  readonly feed: PackageFeedSettings;
  readonly params: Record<string, string>;
}

export interface PublishRouteDef {
  readonly name: string;
  readonly ecosystem: PackageEcosystem;
  readonly method: RegistryWriteMethod;
  match(pathname: string): RegistryRouteMatch | null;
  handle(call: PublishCall): Promise<Response>;
}

const SWIFT_PROBLEM = {
  "content-type": "application/problem+json",
  "content-version": "1",
} as const;

/** A refusal in the ecosystem's native error shape: Swift's `problem+json`, else the flat JSON. */
export function refusalResponse(
  ecosystem: PackageEcosystem,
  r: Pick<NativeRefusal, "status" | "code" | "reason" | "message">,
): Response {
  if (ecosystem === "swift")
    return json(
      { detail: r.message, reason: r.reason },
      {
        status: r.status,
        headers: { ...SWIFT_PROBLEM, "cache-control": "no-store" },
      },
    );
  const res = errorResponse(r.status, r.code, r.message, { reason: r.reason });
  res.headers.set("cache-control", "no-store");
  return res;
}

/** The credential refusals, natively. */
function authRefusal(
  ctx: RegistryRouteContext,
  ecosystem: PackageEcosystem,
  refusal: "challenge" | "forbidden" | "rate-limited",
  reason?: string,
): Response {
  const swift = ecosystem === "swift";
  if (refusal === "rate-limited") {
    const res = swift
      ? json(
          { detail: "too many requests" },
          {
            status: 429,
            headers: { ...SWIFT_PROBLEM, "retry-after": RETRY_AFTER },
          },
        )
      : errorResponse(429, "rate_limited", "too many publish requests");
    res.headers.set("retry-after", RETRY_AFTER);
    return res;
  }
  if (refusal === "forbidden")
    return refusalResponse(ecosystem, {
      status: 403,
      code: "forbidden",
      reason: "publish-not-granted",
      message: reason ?? "this credential may not publish here",
    });
  const host = registryHostname(ctx.env) ?? "pkg.plrs.im";
  const challenge = `Basic realm="${host}"`;
  const res = swift
    ? json(
        { detail: "authentication required" },
        { status: 401, headers: SWIFT_PROBLEM },
      )
    : errorResponse(
        401,
        "unauthorized",
        "a registry token with the publish scope (or a CI token with release:publish) is required",
      );
  res.headers.set("www-authenticate", challenge);
  res.headers.set("cache-control", "no-store");
  return res;
}

/** Build one native publish route (see the file comment). */
export function publishRoute(def: PublishRouteDef): RegistryRoute {
  return {
    [FEED_PUBLISH_ROUTE]: true,
    name: def.name,
    service: "release",
    ecosystem: def.ecosystem,
    methods: [def.method],
    match: (pathname) => def.match(pathname),
    async handle(req, ctx) {
      const eco = def.ecosystem;
      const feed = await answeringFeed(ctx, eco);
      if (!feed) {
        return registryNotFound(eco);
      }
      const auth = await authorizeRegistryPublish(ctx.env, ctx.db, req, {
        owner: ctx.product.slug,
        ecosystem: eco,
        ip: clientIp(req),
        ...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
      });
      if (!auth.ok) {
        return authRefusal(ctx, eco, auth.refusal, auth.reason);
      }
      if (
        !(await rateLimitOk(
          ctx.env,
          ctx.product.slug,
          {
            bucket: "registryPublish",
            id: auth.principal.tokenId,
            ...PUBLISH_LIMIT,
          },
          ctx.now,
        ))
      ) {
        return authRefusal(ctx, eco, "rate-limited");
      }
      return def.handle({
        req,
        ctx,
        principal: auth.principal,
        feed,
        params: ctx.params,
      });
    },
  };
}
