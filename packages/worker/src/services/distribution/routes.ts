/// <reference types="@cloudflare/workers-types" />

/**
 * Distribution's sub-router, over the path segments AFTER `/<product>/distribution`.
 *
 *     /distribution/install.sh                               (P2b-04, `bytes.ts`)
 *     /distribution/dl/:version/:binary-:arch[.dmg]
 *     /distribution/builds/:selector/:buildId                GET|HEAD, also on the bytes host
 *     /distribution/files/:releaseId/:name                   GET|HEAD, also on the bytes host
 *     /distribution/blobs/sha256/:hash                       GET|HEAD, also on the bytes host
 *     /distribution/rollouts/:outlet/:channel                POST, `pkeyci_` + distribution:rollout
 *     /distribution/rollouts/:outlet/:channel/{pause,resume,halt,complete}   POST, same
 *     /distribution/report                                   POST, `pkeyci_` + distribution:report
 *                                                            (P2b-03, `availability.ts`)
 *     /distribution/hooks/:connector                         POST, a store webhook, signed by
 *                                                            the store (P5-02, `connectors/`;
 *                                                            `asc` today)
 *     /distribution/{altstore,altstore-pal}/:channel/source.json   GET, storefront feeds
 *     /distribution/{obtainium,scoop,flathub}/:channel.json         (P2b-05, `feeds/`)
 *     /distribution/fdroid/:channel/repo/:path…              GET, the F-Droid repository relay
 *     /distribution/feeds/fdroid/:channel                    GET|POST, `pkeyci_` +
 *                                                            distribution:feeds
 *
 * The permanent aliases (`/<p>/release/{install.sh,dl,builds,files,blobs}/…`, `/<p>/install.sh`)
 * reach this file already rewritten into the canonical segments by the core router, so there is
 * one code path per surface. Returning `null` for an unmatched path is the registry contract:
 * only Core decides what "no route here" means.
 */

import type { ServiceContext } from "../../core/registry.js";
import { errorResponse, ErrorCode, json } from "../../core/errors.js";
import { readCiJson, requireCiScope } from "../../core/ciScope.js";
import { byteTargetOf, serveDistributionBytes } from "./bytes.js";
import {
  applyRollout,
  isRolloutVerb,
  type RolloutRefusal,
  type RolloutVerb,
} from "./rollouts.js";
import { applyReport } from "./availability.js";
import { connectorOf } from "./connectors/index.js";
import { handleFeedRoutes } from "./feeds/index.js";

/** A rollout body is tiny (`{deliverable?, releaseId?, bp?}`); a report carries at most two small
 *  JSON objects (`platformRef`, `detail`). */
const MAX_CI_BODY_BYTES = 16 * 1024;

export async function handleDistributionRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { req, env, db, product, rest, hooks, now } = ctx;

  if (rest[0] === "rollouts") {
    const verb: RolloutVerb | null =
      rest.length === 3
        ? "set"
        : rest.length === 4 && isRolloutVerb(rest[3] as string)
          ? (rest[3] as RolloutVerb)
          : null;
    if (!verb || req.method !== "POST") return null;
    return handleCiRollout(ctx, rest[1] as string, rest[2] as string, verb);
  }

  // A store webhook. `null` (Core's not-found) for an unknown connector, one without a webhook,
  // or a product the connector is not set up for — the connector decides the last.
  if (rest[0] === "hooks" && rest.length === 2) {
    const webhook = connectorOf(rest[1] as string)?.webhook;
    return webhook ? webhook(ctx) : null;
  }

  if (rest[0] === "report" && rest.length === 1) {
    if (req.method !== "POST") return null;
    return handleCiReport(ctx);
  }

  // The storefront feeds and the F-Droid relay (P2b-05, `feeds/`).
  const feed = await handleFeedRoutes(ctx);
  if (feed) return feed;

  const target = byteTargetOf(rest);
  if (!target) return null;
  return serveDistributionBytes({ req, env, db, product, hooks, now }, target);
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function rolloutRefusal(r: RolloutRefusal): Response {
  return errorResponse(r.status, r.code, r.message, {
    reason: r.reason,
    ...(r.fields ? { fields: r.fields } : {}),
  });
}

/** `POST /<p>/distribution/rollouts/<outlet>/<channel>[/<verb>]` — `distribution:rollout`. */
async function handleCiRollout(
  ctx: ServiceContext,
  rawOutlet: string,
  rawChannel: string,
  verb: RolloutVerb,
): Promise<Response> {
  const { req, env, db, product, hooks, now } = ctx;
  const principal = await requireCiScope(
    req,
    env,
    db,
    product.slug,
    "distribution:rollout",
    now,
  );
  if (principal instanceof Response) return principal;
  const body = await readCiJson(req, MAX_CI_BODY_BYTES);
  if (body instanceof Response) return body;
  const outlet = decodeSegment(rawOutlet);
  const channel = decodeSegment(rawChannel);
  if (outlet === null || channel === null)
    return errorResponse(404, ErrorCode.NotFound, "no such rollout", {
      reason: "unknown_outlet",
    });
  const result = await applyRollout(
    { db, product: product.slug, hooks, now },
    verb,
    {
      outlet,
      channel,
      deliverable: body.deliverable,
      releaseId: body.releaseId,
      bp: body.bp,
    },
    { kind: "ci", principal },
  );
  if (!result.ok) return rolloutRefusal(result);
  return json({ ok: true, rollout: result.rollout });
}

/**
 * `POST /<p>/distribution/report` — `distribution:report` (in the default CI grant). Records
 * availability or a submission state for (release, outlet), or the fingerprint CI signed with
 * (`availability.ts` `applyReport`). A refused report writes nothing.
 */
async function handleCiReport(ctx: ServiceContext): Promise<Response> {
  const { req, env, db, product, hooks, now } = ctx;
  const principal = await requireCiScope(
    req,
    env,
    db,
    product.slug,
    "distribution:report",
    now,
  );
  if (principal instanceof Response) return principal;
  const body = await readCiJson(req, MAX_CI_BODY_BYTES);
  if (body instanceof Response) return body;
  const result = await applyReport(
    { db, product: product.slug, hooks, now },
    body,
    principal,
  );
  if (!result.ok) return rolloutRefusal(result);
  return json(result);
}
