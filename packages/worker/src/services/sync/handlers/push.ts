/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /<product>/sync/ops` — the push (U-05.13; WIRE-CONTRACT-V4 §13.3).
 *
 * Body `{clientId, cursor, atomic?, mutations[]}` (at most 100 mutations and 256 KiB). The `200`
 * is the per-mutation `results` beside the pull members of §13.4 since the request's `cursor`.
 *
 * ── THE ORDER (each step refuses before the next costs anything) ─────────────────────────────
 *
 *   1. Config and Identity on (`404` otherwise), the bearer, the device header, the principal
 *      (`401`, `400`, `403 account_required`). Nothing below runs for a caller with no principal.
 *   2. `cloudSync.writesPaused`: `503 writes_paused`, `Retry-After: 300`. Pulls are still served.
 *      Then the push limits (`limits.ts`): 60 a minute per device, 2,000 a second per product over
 *      eight limiter objects, `429 rate_limited` with `Retry-After`. Both fail open (L10).
 *   3. Device trust, `trustRefusal(…, "cloudSyncWrite", …, "wire")`: log-only audits and goes on,
 *      enforced is `403 attestation_required`. Every other sync answer is a nested
 *      `wireError` (`{"error":{"code":…}}`), so the trust refusal takes the `wire` shape too.
 *   4. The body, under 256 KiB (`413 body_too_large`) and well formed (`400 bad_request`).
 *   5. Classification (`classify.ts`), against the active catalog and its migrations.
 *   6. The product ceiling: `sync_product_usage.bytes` (the 15-minute aggregate) against
 *      `cloudSync.ceiling.bytes`. Past it, growth is refused by the object (`quota_exceeded`,
 *      `scope: product`); clears and deletes still pass. The same row's `users` at 100,000 refuses
 *      growth to an object that never held data (it is a new person); existing people still write. The aggregate lags up to a quarter hour,
 *      so a product can overshoot by what its people write meanwhile; this is a cost control.
 *   7. The product is still live and its objects are not being purged (`404`), read right before
 *      the object is called (SR-2): a push must never create an object a deletion has erased.
 *   8. The object's push, with the device's quota and tier from `syncAccess` (never from the
 *      request), then the object's pull since `cursor` for the answer's pull members.
 *
 * ── THE OBJECT'S REFUSALS ARE NEVER COPIED ───────────────────────────────────────────────────
 *
 * `410 absorbed` (the subject was merged away while the request ran) re-resolves the principal and
 * retries once; a second one is a retryable `503 unavailable`. A batch the object finds malformed
 * is `400`, another device's `clientId` is `409 client_mismatch`; every other object failure is
 * mapped by `objectFailure` (`common.ts`). If the subject moved to a merge survivor after the push
 * landed, the whole exchange is repeated against it (mutation ids make it idempotent); if the device
 * now belongs to someone else, it is `account_required`, exactly as the pull does. An expired
 * `cursor` after a landed push is `410 cursor_expired`: the journal is kept
 * (rule 1) and the client's retry finds every mutation already processed.
 */

import {
  SYNC_MAX_PUSH_BYTES,
  type PushRequest,
  type PushResponse,
} from "@polaris-key/protocol/sync";
import { Catalog } from "@polaris-key/catalog";
import type { ServiceContext } from "../../../core/registry.js";
import { ErrorCode, json, wireError } from "../../../core/errors.js";
import { BodyTooLargeError, readBodyText } from "../../../core/cappedBody.js";
import { resolveSubject } from "../../../core/accounts/accountSubjects.js";
import { syncAccess } from "../../../core/accounts/syncAccess.js";
import { getActiveSchema } from "../../../core/products/store.js";
import { trustRefusal } from "../../../core/trust/deviceTrust.js";
import { getDevice } from "../../../core/devices/store.js";
import { callCloudSync } from "../do/client.js";
import type { WireMigrations } from "../do/protocol.js";
import type { PullOutcome } from "../engine/pull.js";
import type { PushSuccess } from "../engine/types.js";
import { validatePush } from "../engine/validate.js";
import { pushLimited } from "../limits.js";
import { classifyMutations } from "./classify.js";
import { OpTally } from "./meter.js";
import {
  accountRequired,
  catalogView,
  isAbsorbed,
  liveRefusal,
  objectFailure,
  overCeiling,
  pausedRefusal,
  retryable,
  syncCaller,
  syncMode,
  type SyncCaller,
} from "./common.js";

/** Why the body is not a push: too large, or not one. */
async function readPush(
  req: Request,
): Promise<PushRequest | { response: Response }> {
  let text: string;
  try {
    text = await readBodyText(req, SYNC_MAX_PUSH_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError)
      return { response: wireError(413, "body_too_large") };
    throw e;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { response: wireError(400, ErrorCode.BadRequest) };
  }
  // The shape includes the 100-mutation cap: more is `400`.
  const shape = validatePush(body);
  if (!shape.ok) return { response: wireError(400, ErrorCode.BadRequest) };
  // Only the wire members go on: nothing a client adds beside them reaches the object.
  const { clientId, cursor, atomic, mutations } = shape.request;
  return {
    clientId,
    cursor,
    ...(atomic !== undefined ? { atomic } : {}),
    mutations,
  };
}

const wireMigrations = (view: {
  migrations: {
    renamedTo: ReadonlyMap<string, string>;
    dropped: ReadonlySet<string>;
  };
}): WireMigrations => ({
  renamedTo: [...view.migrations.renamedTo],
  dropped: [...view.migrations.dropped],
});

export async function handlePush(ctx: ServiceContext): Promise<Response> {
  const tally = new OpTally();
  return tally.stamp(await pushInner(ctx, tally), "push");
}

async function pushInner(
  ctx: ServiceContext,
  tally: OpTally,
): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  if (req.method !== "POST") return wireError(405, "method_not_allowed");

  // 1. Config and Identity on, then the token and the principal.
  const caller = await syncCaller(ctx);
  if (caller instanceof Response) return caller;

  // 2. The kill switch.
  const paused = await pausedRefusal(env, db);
  if (paused) return paused;

  // 2b. The push limits: a limited push costs nothing below.
  const limited = await pushLimited(
    env,
    product.slug,
    caller.access.subject,
    caller.device.device_id,
    now,
  );
  if (limited) return limited;

  // 3. Device trust.
  const refused = await trustRefusal(
    env,
    db,
    product,
    caller.device,
    "cloudSyncWrite",
    now,
    "wire",
  );
  if (refused) return refused;

  // 4. The body.
  const request = await readPush(req);
  if ("response" in request) return request.response;

  tally.mutations = request.mutations.length;

  // 5. Classification.
  const schemaRow = await getActiveSchema(db, product.slug);
  let catalog: Catalog | null = null;
  if (schemaRow) {
    try {
      catalog = new Catalog(JSON.parse(schemaRow.catalog_json));
    } catch {
      // A catalog that cannot be read cannot classify: a declared key must not be stored as open.
      return retryable();
    }
  }
  const view = await catalogView(db, product, schemaRow);
  // The mode the request is served in: E2E only with the launch gate on and an `e2e` catalog.
  const mode = await syncMode(env, db, product.slug, schemaRow);
  const classified = classifyMutations(
    request.mutations,
    catalog,
    view.migrations,
    mode.serve,
    caller.access.entitlements,
  );

  // 6. The product ceiling.
  const ceilings = await overCeiling(ctx);

  // 7. The product is live and not being erased.
  const gone = await liveRefusal(env, db, product.slug);
  if (gone) return gone;

  // 8. The object.
  let current: SyncCaller = caller;
  const resolveAgain = async (c: SyncCaller) => {
    const device = await getDevice(db, product.slug, c.device.device_id);
    return device ? await syncAccess(env, db, product, device, now) : null;
  };
  /** The subject we pushed to resolves, through the merge aliases, to the one the device has now. */
  const followsMerge = async (from: string, to: string): Promise<boolean> =>
    (await resolveSubject(db, product.slug, from)) === to;
  let pushed: PushSuccess | null = null;
  let pulled: Extract<PullOutcome, { ok: true }> | null = null;
  for (let attempt = 0; attempt < 2 && pushed === null; attempt++) {
    try {
      const access = current.access;
      const pin = { product: product.slug, subject: access.subject };
      const reply = await callCloudSync<"push">(env, pin, {
        op: "push",
        deviceId: current.device.device_id,
        family: current.family,
        ...(current.platform !== null ? { platform: current.platform } : {}),
        ...(access.tierId !== null ? { tierId: access.tierId } : {}),
        limits: {
          quotaBytes: access.quota.bytes,
          ...(ceilings.bytes ? { productOverCeiling: true } : {}),
          ...(ceilings.users ? { usersAtCeiling: true } : {}),
        },
        migrations: wireMigrations(view),
        request,
        classified,
        serverNow: now * 1000,
      });
      tally.add(reply.meter);
      const outcome = reply.outcome;
      if (!outcome.ok)
        return outcome.error === "client_mismatch"
          ? wireError(409, ErrorCode.ClientMismatch)
          : wireError(400, ErrorCode.BadRequest);
      const pullReply = await callCloudSync<"pull">(env, pin, {
        op: "pull",
        cursor: request.cursor,
        clientId: request.clientId,
        deviceId: current.device.device_id,
        family: current.family,
        encryption: mode.serve,
      });
      tally.add(pullReply.meter);
      const pull = pullReply.outcome;
      if (!pull.ok) return wireError(410, ErrorCode.CursorExpired);
      // The subject may have been merged away while the object answered.
      const again = await resolveAgain(current);
      if (again === null) return await accountRequired(env, db, req, product);
      const moved = again.subject !== current.access.subject;
      // A device that now belongs to someone else (sign-out, then another person signs in) is
      // not replayed into that person's object: only a merge alias is followed (SR-2).
      if (moved && !(await followsMerge(current.access.subject, again.subject)))
        return await accountRequired(env, db, req, product);
      current = { ...current, access: again };
      if (!moved) {
        pushed = outcome;
        pulled = pull;
      }
    } catch (e) {
      tally.add(undefined);
      if (!isAbsorbed(e)) return objectFailure(e);
      const again = await resolveAgain(current);
      if (again === null) return await accountRequired(env, db, req, product);
      if (
        again.subject !== current.access.subject &&
        !(await followsMerge(current.access.subject, again.subject))
      )
        return await accountRequired(env, db, req, product);
      current = { ...current, access: again };
    }
  }
  if (pushed === null || pulled === null) return retryable();

  const body: PushResponse = {
    subject: current.access.subject,
    serverNow: now * 1000,
    cursor: pulled.cursor,
    more: pulled.more,
    lastMutationId: pushed.lastMutationId,
    catalogVersion: view.catalogVersion,
    aliases: view.aliases,
    quota: current.access.quota,
    usage: pulled.usage,
    ...(pulled.empty ? { empty: true as const } : {}),
    ...(mode.advertise !== undefined ? { encryption: mode.advertise } : {}),
    ...(pulled.encryptionSince !== undefined
      ? { encryptionSince: pulled.encryptionSince }
      : {}),
    changes: pulled.changes,
    tombstones: pulled.tombstones,
    results: pushed.results,
  };
  return json(body);
}
