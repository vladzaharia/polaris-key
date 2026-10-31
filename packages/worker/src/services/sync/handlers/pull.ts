/// <reference types="@cloudflare/workers-types" />

/**
 * `GET /<product>/sync` — the pull (U-05.12; WIRE-CONTRACT-V4 §13.4).
 *
 *   `?cursor=<n>&clientId=<c_…>`; `cursor` absent or `0` is a snapshot. Bearer only; the answer is
 *   the person's changes and tombstones since the cursor, in pages of 500, with the requesting
 *   device's `quota` (from `syncAccess`, never from the object) and the person's `usage`.
 *
 * The order is: token, device header, principal, query, product still live, the object. A read of
 * one's own data is always allowed: no trust operation, no pause, no quota check.
 *
 * ── PAGING AND THE ETAG ──────────────────────────────────────────────────────────────────────
 *
 * The ETag is the spec's strong `"<seq>.<lastMutationId>"` and says "nothing new since the store's
 * latest sequence", which is true only of a LAST page: a middle page's tag would also be the
 * store's latest and a client replaying it with the next cursor would be told `304` and stop
 * paging. So a page with `more: true` carries no ETag and is never answered `304`.
 *
 * ── MERGED-AWAY SUBJECTS ─────────────────────────────────────────────────────────────────────
 *
 * The subject is resolved before the object is called. If an account merge absorbs it in between,
 * the object (an emptied marker) would answer an empty snapshot for the old subject. So the
 * subject is resolved again after the answer, and when it moved the pull is repeated once against
 * the survivor. The object's own `410 absorbed` is handled the same way and never copied to the
 * response (SR-2).
 */

import { pullLimited } from "../limits.js";
import {
  SYNC_CLIENT_ID_PATTERN,
  type PullResponse,
} from "@polaris-key/protocol/sync";
import type { ServiceContext } from "../../../core/registry.js";
import { ErrorCode, json, wireError } from "../../../core/errors.js";
import { syncAccess } from "../../../core/accounts/syncAccess.js";
import { getDevice } from "../../../core/devices/store.js";
import { callCloudSync } from "../do/client.js";
import type { PullOutcome } from "../engine/pull.js";
import { OpTally } from "./meter.js";
import {
  accountRequired,
  catalogView,
  isAbsorbed,
  objectFailure,
  productGone,
  productStillLive,
  retryable,
  syncCaller,
  syncMode,
  type SyncCaller,
} from "./common.js";

const CLIENT_ID = new RegExp(SYNC_CLIENT_ID_PATTERN);

/** `0` or a positive safe integer, written as digits. */
function parseCursor(raw: string | null): number | null | "bad" {
  if (raw === null) return null;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(raw)) return "bad";
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : "bad";
}

const matchesTag = (header: string | null, etag: string): boolean =>
  header !== null &&
  header
    .split(",")
    .map((t) => t.trim())
    .includes(etag);

export async function handlePull(ctx: ServiceContext): Promise<Response> {
  const tally = new OpTally();
  return tally.stamp(await pullInner(ctx, tally), "pull");
}

async function pullInner(
  ctx: ServiceContext,
  tally: OpTally,
): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  if (req.method !== "GET") return wireError(405, "method_not_allowed");
  // §13.1: Config or Identity off is `404` whatever Cloud Sync's own flag says.
  const caller = await syncCaller(ctx);
  if (caller instanceof Response) return caller;

  const limited = await pullLimited(
    env,
    product.slug,
    caller.access.subject,
    caller.device.device_id,
    now,
  );
  if (limited) return limited;

  const url = new URL(req.url);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const clientId = url.searchParams.get("clientId");
  if (cursor === "bad" || url.searchParams.getAll("cursor").length > 1)
    return wireError(400, ErrorCode.BadRequest);
  if (
    url.searchParams.getAll("clientId").length > 1 ||
    (clientId !== null && !CLIENT_ID.test(clientId))
  )
    return wireError(400, ErrorCode.BadRequest);

  if (!(await productStillLive(db, product.slug))) return productGone();

  const mode = await syncMode(env, db, product.slug);
  let current: SyncCaller = caller;
  // The device row is read again: its binding is what a merge or a sign-out moves.
  const resolveAgain = async (c: SyncCaller) => {
    const device = await getDevice(db, product.slug, c.device.device_id);
    return device ? await syncAccess(env, db, product, device, now) : null;
  };
  let outcome: PullOutcome | null = null;
  for (let attempt = 0; attempt < 2 && outcome === null; attempt++) {
    try {
      const reply = await callCloudSync<"pull">(
        env,
        { product: product.slug, subject: current.access.subject },
        {
          op: "pull",
          ...(cursor !== null ? { cursor } : {}),
          ...(clientId !== null ? { clientId } : {}),
          deviceId: current.device.device_id,
          family: current.family,
          encryption: mode.serve,
        },
      );
      tally.add(reply.meter);
      // The subject may have been merged away while the object answered.
      const again = await resolveAgain(current);
      if (again === null) return await accountRequired(env, db, req, product);
      const moved = again.subject !== current.access.subject;
      current = { ...current, access: again };
      if (!moved) outcome = reply.outcome;
    } catch (e) {
      tally.add(undefined);
      if (!isAbsorbed(e)) return objectFailure(e);
      const again = await resolveAgain(current);
      if (again === null) return await accountRequired(env, db, req, product);
      current = { ...current, access: again };
    }
  }
  if (outcome === null) return retryable();
  if (!outcome.ok) return wireError(410, ErrorCode.CursorExpired);

  const more = outcome.more;
  // The ETag does not name the subject, so a cache shared by two people (one browser profile)
  // must key the answer on the credential and the device (SR-2 B1).
  const headers: Record<string, string> = more
    ? { vary: "Authorization, X-PKey-Device" }
    : {
        etag: outcome.etag,
        "cache-control": "private, no-cache",
        vary: "Authorization, X-PKey-Device",
      };
  if (!more && matchesTag(req.headers.get("if-none-match"), outcome.etag))
    return new Response(null, { status: 304, headers });

  const view = await catalogView(db, product);
  const body: PullResponse = {
    subject: current.access.subject,
    serverNow: now * 1000,
    cursor: outcome.cursor,
    more,
    lastMutationId: outcome.lastMutationId,
    catalogVersion: view.catalogVersion,
    aliases: view.aliases,
    quota: current.access.quota,
    usage: outcome.usage,
    ...(outcome.empty ? { empty: true as const } : {}),
    ...(mode.advertise !== undefined ? { encryption: mode.advertise } : {}),
    ...(outcome.encryptionSince !== undefined
      ? { encryptionSince: outcome.encryptionSince }
      : {}),
    changes: outcome.changes,
    tombstones: outcome.tombstones,
  };
  return json(body, { headers });
}
