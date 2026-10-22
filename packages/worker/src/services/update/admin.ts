/// <reference types="@cloudflare/workers-types" />

/**
 * Update's admin surface: the read-only "what does this device get?" simulator,
 * `GET /manage/api/products/<slug>/update/simulate` (P4-15, `simulate.ts`).
 *
 * Its settings are no route here. `metadataAccess`, the compatibility window and the operator-only
 * artifact policy (the minimum OS and the signature requirement) are the registry settings
 * `update.metadataAccess`, `release.compatWindow` and `update.operatorPolicy`, edited through the
 * generic settings API (`console/handlers/productSettings.ts`, ST-05b). What the retired
 * `…/update/settings` route checked beyond routing is those keys' adapters
 * (`services/release/settingsAdapters.ts`).
 *
 * The artifacts mode is Distribution's delivery access (`distribution.access`, P2b-04).
 */

import { ErrorCode } from "../../core/errors.js";
import type { ServiceContext } from "../../core/registry.js";
import type { AdminSession } from "../../core/console/session.js";
import { adminJson, err } from "../../core/console/respond.js";
import {
  parseSimulateQuery,
  simulate,
  SimulateInputError,
  SimulateNotFound,
} from "./simulate.js";

export async function handleUpdateAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { rest } = ctx;
  if (rest.length === 1 && rest[0] === "simulate") return handleSimulate(ctx);
  return null;
}

/**
 * `GET …/update/simulate?appRelease=&platform=&outlet=&variant=&channel=&device=&methods=&packSetId=`
 * (P4-15, `simulate.ts`): what a fresh device running that app release gets. Read-only.
 */
async function handleSimulate(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response> {
  if (ctx.req.method !== "GET")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  try {
    const q = parseSimulateQuery(new URL(ctx.req.url).searchParams);
    // Only the slug crosses: the simulator never sees the product's signing key (it signs with an
    // ephemeral key of its own) and gets no `env`, so no binding that could unseal one; only the
    // delta menu's switch string (P4-29) crosses.
    return adminJson(
      await simulate(
        {
          db: ctx.db,
          hooks: ctx.hooks,
          now: ctx.now,
          product: { slug: ctx.product.slug },
          ...(ctx.env.LAZY_DELTAS !== undefined
            ? { lazyDeltas: ctx.env.LAZY_DELTAS }
            : {}),
        },
        q,
      ),
    );
  } catch (e) {
    if (e instanceof SimulateInputError)
      return err(400, ErrorCode.BadRequest, e.message, { field: e.field });
    if (e instanceof SimulateNotFound)
      return err(404, ErrorCode.NotFound, e.message);
    throw e;
  }
}
